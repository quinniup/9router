/**
 * ClaudeCodeCliExecutor — serves Anthropic Messages requests through the
 * official `claude` CLI running on the 9Router host.
 *
 * The CLI only generates. The client's tools are bridged to it over an
 * in-process MCP server and every tool call goes back to the client as a
 * normal tool_use, so nothing runs on the host. One HTTP request is one
 * assistant message; the CLI process stays alive between requests and is
 * reused when the next request continues the same conversation exactly
 * (claude-code-cli/conversation.js). Otherwise the client's history is
 * written as a CLI transcript and a new process resumes from it.
 *
 * Auth: the CLI's own login on the host (`claude /login` or
 * CLAUDE_CODE_OAUTH_TOKEN). 9Router never reads or stores that credential.
 * Host configuration: claude-code-cli/host.js.
 */

import { BaseExecutor } from "./base.js";
import { SSE_HEADERS } from "../utils/sseConstants.js";
import { buildErrorBody } from "../utils/error.js";
import { FORMATS } from "../translator/formats.js";
import { ROLE } from "../translator/schema/index.js";
import { CLAUDE_CODE_CLI_MIN_VERSION, CLAUDE_CODE_CLI_SESSION_HEADER } from "../config/claudeCodeCli.js";
import { ClaudeCliPool } from "./claude-code-cli/pool.js";
import { cliVersion, compareVersions, hostSessionOptions } from "./claude-code-cli/host.js";
import { writeTranscript } from "./claude-code-cli/transcript.js";
import {
  assistantFromEvents,
  configSignature,
  scopeKey,
} from "./claude-code-cli/conversation.js";

const CLI_URL = "claude-code-cli://stdio";
const CLI_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Messages parameters the CLI decides for itself (it sets its own max_tokens,
// thinking, sampling and cache breakpoints). Reported, never silently claimed.
const CLI_OWNED_PARAMS = ["max_tokens", "thinking", "temperature", "top_p", "top_k", "stop_sequences", "tool_choice", "metadata"];
const BILLING_HEADER_RE = /^x-anthropic-billing-header:/i;

// Client system prompt as text, minus Claude Code's per-request billing line
// (the host CLI adds its own).
function systemText(system) {
  const blocks = typeof system === "string" ? [{ text: system }] : Array.isArray(system) ? system : [];
  return blocks.map((b) => b?.text || "").filter((t) => t && !BILLING_HEADER_RE.test(t)).join("\n\n");
}

const errorResponse = (status, message) => new Response(JSON.stringify(buildErrorBody(status, message)), {
  status,
  headers: { "Content-Type": "application/json" },
});

const sseFrame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

// Final Messages JSON for stream:false, rebuilt from the turn's events.
function messageJson(events, outcome, model) {
  const start = events.find((e) => e.type === "message_start")?.message || {};
  const assistant = assistantFromEvents(events);
  return {
    id: start.id,
    type: "message",
    role: ROLE.ASSISTANT,
    model: start.model || model,
    content: assistant.content,
    stop_reason: outcome.stopReason ?? null,
    stop_sequence: null,
    usage: { ...(start.usage || {}), ...(outcome.usage || {}) },
  };
}

export class ClaudeCodeCliExecutor extends BaseExecutor {
  constructor() {
    super("claude-code-cli", { id: "claude-code-cli", baseUrl: CLI_URL, noAuth: true });
    this.pool = null;
  }

  buildUrl() { return CLI_URL; }
  buildHeaders() { return {}; }

  getPool() {
    this.pool ??= new ClaudeCliPool();
    return this.pool;
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const host = hostSessionOptions();
    const meta = { url: CLI_URL, headers: {}, responseFormat: FORMATS.CLAUDE };
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const requestedEffort = body?.output_config?.effort;
    const effort = CLI_EFFORT_LEVELS.has(requestedEffort) ? requestedEffort : undefined;
    const ignored = CLI_OWNED_PARAMS.filter((k) => body?.[k] !== undefined);
    if (requestedEffort && !effort) ignored.push("output_config.effort");
    const system = systemText(body?.system);
    meta.transformedBody = { model, messages: messages.length, tools: tools.map((t) => t?.name).filter(Boolean), stream, ignored };

    const version = cliVersion(host.bin);
    if (!version) return { ...meta, response: errorResponse(503, `Claude Code CLI not found or not runnable: ${host.bin}`) };
    if (compareVersions(version, CLAUDE_CODE_CLI_MIN_VERSION) < 0) {
      return { ...meta, response: errorResponse(503, `Claude Code CLI ${version} is older than the supported ${CLAUDE_CODE_CLI_MIN_VERSION}`) };
    }
    if (messages.at(-1)?.role !== ROLE.USER) {
      return { ...meta, response: errorResponse(400, "Claude Code CLI provider needs the last message to be a user message (assistant prefill is not supported)") };
    }
    const bridgeable = tools.filter((t) => t?.input_schema);
    if (bridgeable.length !== tools.length) {
      return { ...meta, response: errorResponse(400, "Claude Code CLI provider cannot run server tools; only client tools with input_schema are supported") };
    }

    const scope = scopeKey({
      apiKey: credentials?.rawHeaders?.["x-api-key"] || credentials?.rawHeaders?.authorization || null,
      connectionId: credentials?.connectionId,
      // Only Claude Code's own session header: 9Router's derived session ids
      // can change between turns of one conversation.
      clientSessionId: credentials?.rawHeaders?.[CLAUDE_CODE_CLI_SESSION_HEADER] || null,
    });
    const signature = configSignature({ model, system, tools, effort });
    const pool = this.getPool();
    let { entry, step } = pool.checkout(scope, signature, messages);
    meta.transformedBody.path = entry ? step.kind : `cold (${step.reason})`;
    log?.info?.("CCLI", `${model} | ${meta.transformedBody.path}${ignored.length ? ` | ignored: ${ignored.join(",")}` : ""}`);

    // The executor resolves only once the turn's first event (or its error)
    // is known, so 401/429 reach 9Router's account handling as statuses.
    const events = [];
    let push = null; // set once the response stream exists
    let firstEvent;
    const firstEventSeen = new Promise((resolve) => { firstEvent = resolve; });
    const onEvent = (ev) => {
      events.push(ev);
      push?.(ev);
      firstEvent();
    };

    // "default" is the CLI's own default model: no --model flag.
    const sessionOpts = { ...host, model: model === "default" ? undefined : model, system, tools, effort, log };

    let turn;
    try {
      if (!entry) {
        entry = await pool.open(scope, signature, {
          ...sessionOpts,
          history: (workDir, workspace) => writeTranscript(workDir, messages, { cwd: workspace, version, model }),
        }, onEvent);
        turn = entry.session.awaitTurn();
      } else if (step.kind === "tool_results") {
        turn = entry.session.sendToolResults(step.blocks, onEvent);
      } else {
        turn = entry.session.sendUser(step.content, onEvent);
      }
    } catch (err) {
      if (entry) pool.drop(entry);
      return { ...meta, response: errorResponse(err.status || 502, err.message) };
    }

    // Abort of this HTTP request stops the generation, not the process.
    const onAbort = () => { entry.session.interrupt().catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const settled = turn.then(
      (outcome) => {
        entry.state = {
          messages: [...messages, assistantFromEvents(events)],
          awaitingToolUseIds: outcome.stopReason === "tool_use" ? outcome.toolUseIds : [],
        };
        return { outcome };
      },
      (error) => ({ error }),
    ).finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
    settled.then(({ error }) => {
      // A failed or interrupted turn leaves CLI context the client never saw.
      if (error) pool.drop(entry);
      else pool.release(entry);
    });

    const early = await Promise.race([firstEventSeen.then(() => null), settled]);
    if (early?.error) {
      return { ...meta, response: errorResponse(early.error.status || 502, early.error.message) };
    }

    if (!stream) {
      const done = await settled;
      if (done.error) return { ...meta, response: errorResponse(done.error.status || 502, done.error.message) };
      return {
        ...meta,
        response: new Response(JSON.stringify(messageJson(events, done.outcome, model)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }

    const enc = new TextEncoder();
    const sse = new ReadableStream({
      start(controller) {
        for (const ev of events) controller.enqueue(enc.encode(sseFrame(ev)));
        push = (ev) => {
          try { controller.enqueue(enc.encode(sseFrame(ev))); } catch { /* client gone */ }
        };
        settled.then(({ error }) => {
          push = null;
          try {
            if (error) {
              controller.enqueue(enc.encode(sseFrame({ type: "error", error: { type: "api_error", message: error.message } })));
            }
            controller.close();
          } catch { /* already closed */ }
        });
      },
      cancel() { push = null; },
    });
    return { ...meta, response: new Response(sse, { status: 200, headers: SSE_HEADERS }) };
  }
}

export default ClaudeCodeCliExecutor;
