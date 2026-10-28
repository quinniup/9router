// One long-lived official `claude` process driven over stream-json stdio.
//
// The client's tools are exposed through an in-process ("sdk") MCP server, so
// the CLI on the Server never runs a tool itself: each tools/call is held open
// until the client posts the matching tool_result on its next HTTP request.
// One HTTP request maps to one root assistant message; between them the
// process stays alive and keeps its own context.
//
// Message shapes follow the Agent SDK's control protocol (SDK 0.2.76) and
// probes against CLI 2.1.312. See docs/CLAUDE_CODE_CLI_HANDOFF.zh-CN.md §5.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_CLI_MCP_SERVER,
  CLAUDE_CODE_CLI_TOOL_USE_ID_META,
  CLAUDE_CODE_CLI_MAX_RESULT_META,
  CLAUDE_CODE_CLI_MAX_RESULT_CHARS,
  CLAUDE_CODE_CLI_START_TIMEOUT_MS,
  CLAUDE_CODE_CLI_KILL_GRACE_MS,
  CLAUDE_CODE_CLI_MAX_LINE_BYTES,
  CLAUDE_CODE_CLI_STDERR_TAIL_BYTES,
  CLAUDE_CODE_CLI_STRIP_ENV_PREFIXES,
  CLAUDE_CODE_CLI_STRIP_ENV_KEYS,
  CLAUDE_CODE_CLI_KEEP_ENV_KEYS,
  CLAUDE_CODE_CLI_ISOLATION_ENV,
  CLAUDE_CODE_CLI_WORKSPACE_DIRNAME,
  claudeCodeCliHostNote,
} from "../../config/claudeCodeCli.js";
import { CLAUDE_STOP } from "../../translator/schema/index.js";
import { getWritableDataDir } from "../../utils/writableDataDir.js";

const JSONRPC = "2.0";
const RPC_METHOD_NOT_FOUND = -32601;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const NOT_LOGGED_IN_RE = /not logged in/i;

// Session states. A turn is one root assistant message.
export const SESSION_STATE = {
  STARTING: "starting",
  IDLE: "idle", // previous run finished (result seen), ready for a user message
  STREAMING: "streaming", // a turn is being produced
  AWAITING_TOOLS: "awaiting_tools", // turn ended with tool_use; tools/call held open
  CLOSED: "closed",
};

export class ClaudeCliSessionError extends Error {
  constructor(message, { status = 502, code = "claude_cli_error" } = {}) {
    super(message);
    this.name = "ClaudeCliSessionError";
    this.status = status;
    this.code = code;
  }
}

// Build the Server CLI environment from the parent env: drop the parent's
// Anthropic routing/credentials and nested-session markers, then apply the
// isolation switches. `extra` (e.g. CLAUDE_CONFIG_DIR) wins over both.
export function buildCliEnv(parentEnv = process.env, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    const stripped = CLAUDE_CODE_CLI_STRIP_ENV_KEYS.includes(k)
      || CLAUDE_CODE_CLI_STRIP_ENV_PREFIXES.some((p) => k.startsWith(p));
    if (stripped && !CLAUDE_CODE_CLI_KEEP_ENV_KEYS.includes(k)) continue;
    env[k] = v;
  }
  return { ...env, ...CLAUDE_CODE_CLI_ISOLATION_ENV, ...extra };
}

// Arguments for the stream-json host mode. Built-in tools are disabled; only
// the client's tools (via the sdk MCP server) exist on the Server.
export function buildCliArgs({ model, systemPromptFile, settings, effort, resumeFile }) {
  const args = [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({
      mcpServers: { [CLAUDE_CODE_CLI_MCP_SERVER]: { type: "sdk", name: CLAUDE_CODE_CLI_MCP_SERVER } },
    }),
    "--permission-prompt-tool", "stdio",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--system-prompt-file", systemPromptFile,
  ];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  // An explicit settings file replaces the host user's settings. Otherwise
  // the user's settings still load (they may hold the login), minus hooks.
  if (settings) args.push("--setting-sources", "", "--settings", settings);
  else args.push("--settings", JSON.stringify({ disableAllHooks: true }));
  if (resumeFile) args.push("--resume", resumeFile);
  return args;
}

// Anthropic tool definitions → MCP tools/list entries. Server tools (web
// search etc.) have no input_schema and cannot be bridged.
export function toMcpTools(tools) {
  const out = [];
  for (const t of tools || []) {
    if (!t?.name || !t.input_schema) continue;
    out.push({
      name: t.name,
      description: t.description || "",
      inputSchema: t.input_schema,
      _meta: { [CLAUDE_CODE_CLI_MAX_RESULT_META]: CLAUDE_CODE_CLI_MAX_RESULT_CHARS },
    });
  }
  return out;
}

// Anthropic tool_result block → MCP CallToolResult. Text and base64 images
// map 1:1; anything else is carried as JSON text rather than dropped.
export function toMcpToolResult(block) {
  const items = typeof block?.content === "string"
    ? [{ type: "text", text: block.content }]
    : Array.isArray(block?.content) ? block.content : [];
  const content = [];
  for (const it of items) {
    if (it?.type === "text") content.push({ type: "text", text: String(it.text ?? "") });
    else if (it?.type === "image" && it.source?.type === "base64") {
      content.push({ type: "image", data: it.source.data, mimeType: it.source.media_type });
    } else content.push({ type: "text", text: JSON.stringify(it) });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { content, ...(block?.is_error ? { isError: true } : {}) };
}

export class ClaudeCliSession {
  /**
   * @param {object} opts
   * @param {string} opts.bin          absolute path or PATH name of `claude`
   * @param {string} [opts.model]
   * @param {string} [opts.system]     system prompt text (the client's)
   * @param {Array}  [opts.tools]      Anthropic tool definitions
   * @param {string} [opts.settings]   settings file/JSON; also disables other setting sources
   * @param {string} [opts.effort]
   * @param {Function} [opts.history] (workDir, workspace) → absolute .jsonl transcript to resume
   *                                   (cold start); the process then answers its last turn by itself
   * @param {object} [opts.env]        extra env for the CLI (e.g. CLAUDE_CONFIG_DIR)
   * @param {string} [opts.workspace] stable empty cwd for the CLI (default: <9Router data dir>/9router-claude-code-cli)
   * @param {object} [opts.log]
   */
  constructor(opts) {
    this.opts = opts;
    this.id = randomUUID();
    this.state = SESSION_STATE.STARTING;
    this.mcpTools = toMcpTools(opts.tools);
    this.mcpToolNames = new Set(this.mcpTools.map((t) => t.name));
    this.pendingTools = new Map(); // tool_use_id → { requestId, rpcId } of a held tools/call
    this.stashedResults = new Map(); // tool_use_id → client tool_result not yet requested by the CLI
    this.expectedToolUseIds = []; // tool_use ids of the last message that ended with tool_use
    this.pendingControl = new Map(); // our request_id → { resolve, reject }
    this.turn = null; // { onEvent, resolve, reject, toolUseIds }
    this.initInfo = null;
    this.stderrTail = "";
    this.exitInfo = null;
    this.log = opts.log;
  }

  // Spawn and run the initialize handshake. Resolves with the CLI's init
  // response (models, account, version, capabilities). With opts.history the
  // pending turn is already running when this resolves: attach via awaitTurn().
  async start(onEvent) {
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ccli-"));
    // Private to the 9Router user (a shared /tmp path could be pre-created by someone else).
    const workspace = this.opts.workspace || path.join(getWritableDataDir(), CLAUDE_CODE_CLI_WORKSPACE_DIRNAME);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const systemPromptFile = path.join(this.workDir, "system.txt");
    fs.writeFileSync(systemPromptFile, (this.opts.system || "") + claudeCodeCliHostNote(workspace), { mode: 0o600 });

    const resumeFile = this.opts.history ? this.opts.history(this.workDir, workspace) : null;
    const args = buildCliArgs({ ...this.opts, systemPromptFile, resumeFile });
    // A resumed transcript that ends on a user turn is answered at startup
    // (the CLI otherwise drops it as an interrupted turn).
    const env = resumeFile ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1", ...this.opts.env } : this.opts.env;
    if (resumeFile) this.#beginTurn(onEvent);
    this.child = spawn(this.opts.bin, args, {
      cwd: workspace,
      env: buildCliEnv(process.env, env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", () => {}); // surfaced through "exit"
    this.child.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-CLAUDE_CODE_CLI_STDERR_TAIL_BYTES);
    });
    this.#readLines(this.child.stdout, (msg) => this.#onMessage(msg));

    const exited = new Promise((_, reject) => {
      this.child.once("error", (err) => {
        reject(new ClaudeCliSessionError(
          err.code === "ENOENT" ? `Claude Code CLI not found: ${this.opts.bin}` : `Claude Code CLI spawn failed: ${err.message}`,
          { status: 503, code: "claude_cli_unavailable" },
        ));
      });
      this.child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        reject(this.#exitError());
        this.#fail(this.#exitError());
        this.close(); // removes the temp dir; the process is already gone
      });
    });
    exited.catch(() => {});

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ClaudeCliSessionError("Claude Code CLI initialize timed out", { status: 504 })),
        CLAUDE_CODE_CLI_START_TIMEOUT_MS);
    });
    try {
      this.initInfo = await Promise.race([
        this.#request({ subtype: "initialize", hooks: null, sdkMcpServers: [CLAUDE_CODE_CLI_MCP_SERVER] }),
        exited,
        timeout,
      ]);
    } catch (err) {
      this.turn?.promise.catch(() => {});
      this.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!resumeFile) this.state = SESSION_STATE.IDLE;
    return this.initInfo;
  }

  // The turn a resumed session started by itself.
  awaitTurn() {
    if (!this.turn) return Promise.reject(new ClaudeCliSessionError(`session is ${this.state}, no turn to await`, { status: 409 }));
    return this.turn.promise;
  }

  // Send a new user message and stream the next root assistant message.
  sendUser(content, onEvent) {
    if (this.state !== SESSION_STATE.IDLE) {
      return Promise.reject(new ClaudeCliSessionError(`session is ${this.state}, cannot accept a user message`, { status: 409 }));
    }
    const turn = this.#beginTurn(onEvent);
    this.#write({
      type: "user",
      session_id: "",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    return turn;
  }

  // Answer every held tools/call with the client's tool_result blocks and
  // stream the next root assistant message. All pending ids must be covered:
  // the CLI only continues once it has every result of the message.
  sendToolResults(blocks, onEvent) {
    if (this.state !== SESSION_STATE.AWAITING_TOOLS) {
      return Promise.reject(new ClaudeCliSessionError(`session is ${this.state}, no tool results pending`, { status: 409 }));
    }
    const byId = new Map(blocks.map((b) => [b.tool_use_id, b]));
    const missing = this.expectedToolUseIds.filter((id) => !byId.has(id));
    const unknown = [...byId.keys()].filter((id) => !this.expectedToolUseIds.includes(id));
    if (missing.length || unknown.length) {
      return Promise.reject(new ClaudeCliSessionError(
        `tool_result ids do not match pending tool_use ids (missing: ${missing.join(",") || "-"}, unknown: ${unknown.join(",") || "-"})`,
        { status: 409, code: "claude_cli_tool_mismatch" },
      ));
    }
    const turn = this.#beginTurn(onEvent);
    this.expectedToolUseIds = [];
    // The CLI may not have issued every tools/call yet (it can run them one
    // after another); results for later calls wait in stashedResults.
    this.stashedResults = byId;
    for (const id of [...this.pendingTools.keys()]) this.#answerTool(id);
    return turn;
  }

  // Stop the current generation without killing the process. The pending
  // turn rejects with status 499; the session returns to idle.
  interrupt() {
    this.interrupting = true;
    return this.#request({ subtype: "interrupt" });
  }

  close() {
    if (this.state === SESSION_STATE.CLOSED && !this.child) return;
    this.state = SESSION_STATE.CLOSED;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.stdin.end(); } catch { /* already closed */ }
      child.kill("SIGTERM");
      const hard = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, CLAUDE_CODE_CLI_KILL_GRACE_MS);
      hard.unref?.();
    }
    if (this.workDir) {
      fs.rm(this.workDir, { recursive: true, force: true }, () => {});
      this.workDir = null;
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  #beginTurn(onEvent) {
    this.state = SESSION_STATE.STREAMING;
    const turn = { onEvent, toolUseIds: [], stopReason: null, usage: null };
    turn.promise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    this.turn = turn;
    return turn.promise;
  }

  #finishTurn(outcome) {
    const turn = this.turn;
    this.turn = null;
    turn?.resolve(outcome);
  }

  #fail(err) {
    this.state = SESSION_STATE.CLOSED;
    for (const p of this.pendingControl.values()) p.reject(err);
    this.pendingControl.clear();
    this.pendingTools.clear();
    this.stashedResults.clear();
    const turn = this.turn;
    this.turn = null;
    turn?.reject(err);
  }

  #exitError() {
    const { code, signal } = this.exitInfo || {};
    const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
    return new ClaudeCliSessionError(
      `Claude Code CLI exited (code=${code ?? "-"}, signal=${signal ?? "-"})${tail ? `: ${tail}` : ""}`,
    );
  }

  #write(obj) {
    if (!this.child?.stdin.writable) throw new ClaudeCliSessionError("Claude Code CLI stdin is closed");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  #request(request) {
    const requestId = `req_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.pendingControl.set(requestId, { resolve, reject });
      try {
        this.#write({ type: "control_request", request_id: requestId, request });
      } catch (err) {
        this.pendingControl.delete(requestId);
        reject(err);
      }
    });
  }

  #respond(requestId, response) {
    this.#write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  #respondError(requestId, error) {
    this.#write({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
  }

  #readLines(stream, onLine) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > CLAUDE_CODE_CLI_MAX_LINE_BYTES) {
        this.#fail(new ClaudeCliSessionError("Claude Code CLI emitted an oversized line"));
        this.close();
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // non-JSON diagnostics
        try {
          onLine(msg);
        } catch (err) {
          this.log?.warn?.("CCLI", `message handler failed: ${err.message}`);
        }
      }
    });
  }

  #onMessage(msg) {
    switch (msg.type) {
      case "control_response": return this.#onControlResponse(msg.response);
      case "control_request": return this.#onControlRequest(msg);
      case "control_cancel_request": return this.#onControlCancel(msg);
      case "stream_event": return this.#onStreamEvent(msg);
      case "result": return this.#onResult(msg);
      case "assistant":
        // Synthetic API-error messages arrive as assistant envelopes before
        // any stream_event; the result envelope that follows carries the
        // status. Normal content is taken from stream_event only.
        return;
      default:
        return; // system / user / keep_alive / rate_limit_event: not part of the wire output
    }
  }

  #onControlResponse(response) {
    const pending = this.pendingControl.get(response?.request_id);
    if (!pending) return;
    this.pendingControl.delete(response.request_id);
    if (response.subtype === "success") pending.resolve(response.response);
    else pending.reject(new ClaudeCliSessionError(`control request failed: ${response.error}`));
  }

  #onControlRequest({ request_id: requestId, request }) {
    if (request?.subtype === "can_use_tool") {
      // Only tools this client declared on this bridge may run.
      const ok = request.mcp_server?.name === CLAUDE_CODE_CLI_MCP_SERVER
        && request.mcp_server?.source === "sdk"
        && this.mcpToolNames.has(request.tool_name);
      return this.#respond(requestId, ok
        ? { behavior: "allow", updatedInput: request.input, toolUseID: request.tool_use_id }
        : { behavior: "deny", message: `tool ${request.tool_name} is not provided by the client`, toolUseID: request.tool_use_id });
    }
    if (request?.subtype === "mcp_message") return this.#onMcpMessage(requestId, request);
    return this.#respondError(requestId, `unsupported control request: ${request?.subtype}`);
  }

  #onMcpMessage(requestId, { server_name: server, message }) {
    if (server !== CLAUDE_CODE_CLI_MCP_SERVER) return this.#respondError(requestId, `unknown MCP server: ${server}`);
    const isRequest = message && "method" in message && message.id !== undefined && message.id !== null;
    if (!isRequest) {
      // Notifications get an empty ack, matching the Agent SDK.
      return this.#respond(requestId, { mcp_response: { jsonrpc: JSONRPC, result: {}, id: 0 } });
    }
    const reply = (body) => this.#respond(requestId, { mcp_response: { jsonrpc: JSONRPC, id: message.id, ...body } });
    switch (message.method) {
      case "initialize":
        return reply({ result: {
          protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: CLAUDE_CODE_CLI_MCP_SERVER, version: "1.0.0" },
        } });
      case "tools/list":
        return reply({ result: { tools: this.mcpTools } });
      case "tools/call": {
        const toolUseId = message.params?._meta?.[CLAUDE_CODE_CLI_TOOL_USE_ID_META];
        if (!toolUseId || !this.mcpToolNames.has(message.params?.name)) {
          return reply({ error: { code: RPC_METHOD_NOT_FOUND, message: `cannot bridge tool call ${message.params?.name}` } });
        }
        // Held until the client sends the matching tool_result.
        this.pendingTools.set(toolUseId, { requestId, rpcId: message.id, name: message.params.name });
        if (this.stashedResults.has(toolUseId)) this.#answerTool(toolUseId);
        return undefined;
      }
      default:
        return reply({ error: { code: RPC_METHOD_NOT_FOUND, message: `method not found: ${message.method}` } });
    }
  }

  #answerTool(toolUseId) {
    const pending = this.pendingTools.get(toolUseId);
    const block = this.stashedResults.get(toolUseId);
    if (!pending || !block) return;
    this.pendingTools.delete(toolUseId);
    this.stashedResults.delete(toolUseId);
    this.#respond(pending.requestId, {
      mcp_response: { jsonrpc: JSONRPC, id: pending.rpcId, result: toMcpToolResult(block) },
    });
  }

  #onControlCancel({ request_id: requestId }) {
    for (const [id, p] of this.pendingTools) {
      if (p.requestId === requestId) this.pendingTools.delete(id);
    }
  }

  #onStreamEvent(msg) {
    if (msg.parent_tool_use_id) return; // subagent traffic is not part of the root message
    const event = msg.event;
    const turn = this.turn;
    if (!turn || !event) return;
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      turn.toolUseIds.push(event.content_block.id);
    }
    if (event.type === "message_delta") {
      turn.stopReason = event.delta?.stop_reason ?? turn.stopReason;
      turn.usage = event.usage ?? turn.usage;
    }
    turn.onEvent?.(event);
    if (event.type !== "message_stop") return;
    if (turn.stopReason === CLAUDE_STOP.TOOL_USE) {
      // The tools/call requests may land just after message_stop; the turn is
      // complete for the HTTP side either way.
      this.state = SESSION_STATE.AWAITING_TOOLS;
      this.expectedToolUseIds = [...turn.toolUseIds];
      this.#finishTurn({ stopReason: turn.stopReason, toolUseIds: turn.toolUseIds, usage: turn.usage });
    } else {
      // Keep STREAMING until the result envelope arrives so the next user
      // message cannot be mistaken for this run's tail.
      turn.messageDone = true;
    }
  }

  #onResult(msg) {
    this.lastResult = msg;
    const turn = this.turn;
    const interrupted = this.interrupting;
    this.interrupting = false;
    if (msg.is_error) {
      // subtype can be "success" even here; is_error + api_error_status decide.
      const err = interrupted
        ? new ClaudeCliSessionError("Claude Code CLI turn interrupted", { status: 499, code: "claude_cli_interrupted" })
        : new ClaudeCliSessionError(String(msg.result || msg.errors?.join("; ") || "Claude Code CLI error"), {
          // A logged-out CLI fails before any API call, so it has no status;
          // "Not logged in · Please run /login" on 2.1.312.
          status: Number(msg.api_error_status) || (NOT_LOGGED_IN_RE.test(String(msg.result)) ? 401 : 502),
          code: msg.terminal_reason || msg.subtype,
        });
      this.state = SESSION_STATE.IDLE;
      if (turn) {
        this.turn = null;
        turn.reject(err);
      }
      return;
    }
    this.state = SESSION_STATE.IDLE;
    if (turn) this.#finishTurn({ stopReason: turn.stopReason, toolUseIds: turn.toolUseIds, usage: turn.usage, result: msg });
  }
}
