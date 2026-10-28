// Locks how the claude-code-cli executor decides between reusing a live CLI
// process and a cold restart, and how processes are isolated per tenant.
import { describe, it, expect, vi } from "vitest";
import {
  classifyRequest,
  configSignature,
  scopeKey,
  assistantFromEvents,
} from "../../open-sse/executors/claude-code-cli/conversation.js";
import { buildTranscript } from "../../open-sse/executors/claude-code-cli/transcript.js";
import { buildCliEnv, toMcpToolResult } from "../../open-sse/executors/claude-code-cli/session.js";
import { ClaudeCliPool } from "../../open-sse/executors/claude-code-cli/pool.js";

const user = (content) => ({ role: "user", content });
const toolUse = (id, text = "Reading.") => ({
  role: "assistant",
  content: [{ type: "text", text }, { type: "tool_use", id, name: "Read", input: { file_path: "/a" } }],
});
const result = (id, content = "x") => ({ type: "tool_result", tool_use_id: id, content });

describe("classifyRequest", () => {
  const live = { messages: [user("read /a"), toolUse("t1")], awaitingToolUseIds: ["t1"] };

  it("no live session → cold", () => {
    expect(classifyRequest(null, [user("hi")]).kind).toBe("cold");
  });

  it("tool_results for exactly the pending ids → warm tool_results", () => {
    const step = classifyRequest(live, [...live.messages, user([result("t1")])]);
    expect(step.kind).toBe("tool_results");
    expect(step.blocks.map((b) => b.tool_use_id)).toEqual(["t1"]);
  });

  it("cache_control moves and string/block content do not break the match", () => {
    const echoed = [
      user([{ type: "text", text: "read /a", cache_control: { type: "ephemeral" } }]),
      toolUse("t1"),
      user([{ ...result("t1"), cache_control: { type: "ephemeral" } }]),
    ];
    expect(classifyRequest(live, echoed).kind).toBe("tool_results");
  });

  it("empty text and thinking blocks in the echoed assistant are ignored", () => {
    const state = { messages: [user("q"), { role: "assistant", content: [{ type: "text", text: "" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] }], awaitingToolUseIds: ["t1"] };
    const echoed = { role: "assistant", content: [{ type: "thinking", thinking: "...", signature: "s" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] };
    expect(classifyRequest(state, [user("q"), echoed, user([result("t1")])]).kind).toBe("tool_results");
  });

  it("missing or extra tool_result ids → cold", () => {
    const two = { ...live, awaitingToolUseIds: ["t1", "t2"] };
    expect(classifyRequest(two, [...live.messages, user([result("t1")])]).kind).toBe("cold");
    expect(classifyRequest(live, [...live.messages, user([result("t1"), result("t9")])]).kind).toBe("cold");
  });

  it("text next to tool_results → cold (an MCP result cannot carry it)", () => {
    const step = classifyRequest(live, [...live.messages, user([result("t1"), { type: "text", text: "also" }])]);
    expect(step.kind).toBe("cold");
  });

  it("edited history, rollback and compaction → cold", () => {
    const edited = [user("read /b"), toolUse("t1"), user([result("t1")])];
    expect(classifyRequest(live, edited).kind).toBe("cold");
    expect(classifyRequest(live, [user("new start")]).kind).toBe("cold");
    expect(classifyRequest(live, [user("summary of earlier work"), toolUse("t1"), user([result("t1")])]).kind).toBe("cold");
  });

  it("a plain user message is warm only when no tools are pending", () => {
    const idle = { messages: [user("a"), { role: "assistant", content: [{ type: "text", text: "b" }] }], awaitingToolUseIds: [] };
    expect(classifyRequest(idle, [...idle.messages, user("c")]).kind).toBe("user");
    expect(classifyRequest(live, [...live.messages, user("c")]).kind).toBe("cold");
    expect(classifyRequest(idle, [...idle.messages, user([result("t1")])]).kind).toBe("cold");
  });
});

describe("isolation keys", () => {
  it("different API keys never share a scope; the raw key is not in it", () => {
    const a = scopeKey({ apiKey: "sk-A", connectionId: "c" });
    expect(a).not.toBe(scopeKey({ apiKey: "sk-B", connectionId: "c" }));
    expect(a).not.toContain("sk-A");
    expect(a).toBe(scopeKey({ apiKey: "sk-A", connectionId: "c" }));
  });

  it("model, system, tools or effort changes change the signature", () => {
    const base = { model: "m", system: "s", tools: [{ name: "Read" }], effort: "high" };
    const sig = configSignature(base);
    for (const change of [{ model: "m2" }, { system: "s2" }, { tools: [] }, { effort: "low" }]) {
      expect(configSignature({ ...base, ...change })).not.toBe(sig);
    }
  });
});

describe("assistantFromEvents", () => {
  it("rebuilds text and tool_use input from stream deltas", () => {
    const msg = assistantFromEvents([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"file_path\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"/a\"}" } },
    ]);
    expect(msg.content).toEqual([
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
    ]);
  });
});

describe("transcript", () => {
  it("links entries by parentUuid and marks tool_use stops", () => {
    const lines = buildTranscript([user("q"), toolUse("t1"), user([result("t1")])], { sessionId: "s", cwd: "/w", version: "2.1.312", model: "m" })
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant", "user"]);
    expect(lines[0].parentUuid).toBeNull();
    expect(lines[1].parentUuid).toBe(lines[0].uuid);
    expect(lines[2].parentUuid).toBe(lines[1].uuid);
    expect(lines[1].message.stop_reason).toBe("tool_use");
    expect(lines.every((l) => l.sessionId === "s" && l.isSidechain === false)).toBe(true);
  });
});

describe("buildCliEnv", () => {
  it("drops the parent's Anthropic routing and nested-session markers", () => {
    const env = buildCliEnv({
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:20128",
      ANTHROPIC_API_KEY: "sk-parent",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "kept",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("kept");
    expect(env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX).toBe("1");
  });
});

describe("toMcpToolResult", () => {
  it("keeps text, base64 images and is_error; carries unknown blocks as JSON text", () => {
    const r = toMcpToolResult({
      tool_use_id: "t",
      is_error: true,
      content: [
        { type: "text", text: "a" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "document", source: { type: "url", url: "u" } },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({ type: "text", text: "a" });
    expect(r.content[1]).toEqual({ type: "image", data: "AAA", mimeType: "image/png" });
    expect(r.content[2].type).toBe("text");
    expect(JSON.parse(r.content[2].text).type).toBe("document");
  });
});

describe("ClaudeCliPool", () => {
  const fakeSession = () => ({ id: Math.random().toString(36), state: "idle", start: vi.fn(async () => ({})), close: vi.fn() });

  it("never hands a busy or other-scope conversation to a request", async () => {
    const pool = new ClaudeCliPool({ createSession: fakeSession });
    const entry = await pool.open("scopeA", "sig", {});
    entry.state = { messages: [user("a"), { role: "assistant", content: [{ type: "text", text: "b" }] }], awaitingToolUseIds: [] };
    const next = [...entry.state.messages, user("c")];

    expect(pool.checkout("scopeA", "sig", next).entry).toBeNull(); // still busy
    pool.release(entry);
    expect(pool.checkout("scopeB", "sig", next).entry).toBeNull();
    expect(pool.checkout("scopeA", "other-sig", next).entry).toBeNull();
    expect(pool.checkout("scopeA", "sig", next).entry).toBe(entry);
    pool.closeAll();
  });

  it("evicts the least recently used idle process when full, refuses when all are busy", async () => {
    const pool = new ClaudeCliPool({ createSession: fakeSession, maxProcesses: 2 });
    const a = await pool.open("s", "x", {});
    const b = await pool.open("s", "x", {});
    await expect(pool.open("s", "x", {})).rejects.toMatchObject({ status: 503 });
    pool.release(a);
    await pool.open("s", "x", {});
    expect(a.session.close).toHaveBeenCalled();
    expect(pool.entries.has(b.key)).toBe(true);
    pool.closeAll();
  });

  it("sweeps idle processes past their TTL", async () => {
    const pool = new ClaudeCliPool({ createSession: fakeSession, idleTtlMs: 1000 });
    const a = await pool.open("s", "x", {});
    pool.release(a);
    pool.sweep(a.lastUsed + 2000);
    expect(pool.entries.size).toBe(0);
    expect(a.session.close).toHaveBeenCalled();
    pool.closeAll();
  });
});

describe("discovery summaries", async () => {
  const { summarizeAccount, summarizeModels } = await import("../../open-sse/executors/claude-code-cli/discovery.js");

  it("treats tokenSource none as logged out, a subscription or key source as logged in", () => {
    expect(summarizeAccount({ tokenSource: "none", apiProvider: "firstParty" }).loggedIn).toBe(false);
    expect(summarizeAccount({ subscriptionType: "max", email: "a@b.c", apiProvider: "firstParty" })).toMatchObject({ loggedIn: true, authSource: "claude.ai", email: "a@b.c" });
    expect(summarizeAccount({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })).toMatchObject({ loggedIn: true, authSource: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(summarizeAccount({ apiProvider: "bedrock" })).toMatchObject({ loggedIn: true, authSource: "bedrock" });
  });

  it("maps initialize models to catalog rows keyed by the --model value", () => {
    const rows = summarizeModels([{ value: "sonnet", displayName: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low"] }, { displayName: "no value" }]);
    expect(rows).toEqual([expect.objectContaining({ id: "sonnet", name: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low"] })]);
  });
});
