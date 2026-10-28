// Maps stateless Messages requests onto long-lived ClaudeCliSession processes.
//
// The client's request is the authority. A process is reused only when the
// request is exactly the conversation that process already holds plus one
// new step: a fresh user message, or the tool_results for the tool_uses the
// process is waiting on. Anything else (edited history, compaction, a fork,
// changed model/system/tools, another tenant) gets a fresh process.

import { createHash } from "node:crypto";
import { CLAUDE_BLOCK, ROLE } from "../../translator/schema/index.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// Deterministic JSON (sorted keys) so equal content hashes equally.
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Message content without transport-only fields: cache_control breakpoints
// move between requests, and a string content equals one text block.
function normalizeContent(content) {
  const blocks = typeof content === "string" ? [{ type: CLAUDE_BLOCK.TEXT, text: content }] : (content || []);
  return blocks.map((b) => {
    if (!b || typeof b !== "object") return b;
    const { cache_control: _cc, ...rest } = b;
    if (Array.isArray(rest.content)) rest.content = normalizeContent(rest.content);
    return rest;
  });
}

export function messageHash(message) {
  return sha(stableStringify({ role: message?.role, content: normalizeContent(message?.content) }));
}

// Assistant messages are compared on what the model decided (text and tool
// calls), not on thinking blocks or empty text blocks: clients may drop those.
function assistantKey(message) {
  const blocks = normalizeContent(message?.content).filter((b) =>
    (b?.type === CLAUDE_BLOCK.TEXT && b.text) || b?.type === CLAUDE_BLOCK.TOOL_USE);
  return sha(stableStringify(blocks.map((b) => (b.type === CLAUDE_BLOCK.TEXT
    ? { type: b.type, text: b.text }
    : { type: b.type, id: b.id, name: b.name, input: b.input }))));
}

// Rebuild an assistant message from the root stream events of one turn, in
// the shape the client will echo back on its next request.
export function assistantFromEvents(events) {
  const blocks = [];
  const json = new Map();
  for (const ev of events) {
    if (ev.type === "content_block_start") {
      blocks[ev.index] = { ...ev.content_block };
      if (ev.content_block?.type === CLAUDE_BLOCK.TOOL_USE) json.set(ev.index, "");
    } else if (ev.type === "content_block_delta") {
      const b = blocks[ev.index];
      if (!b) continue;
      if (ev.delta?.type === "text_delta") b.text = (b.text || "") + ev.delta.text;
      else if (ev.delta?.type === "input_json_delta") json.set(ev.index, json.get(ev.index) + ev.delta.partial_json);
      else if (ev.delta?.type === "thinking_delta") b.thinking = (b.thinking || "") + ev.delta.thinking;
      else if (ev.delta?.type === "signature_delta") b.signature = ev.delta.signature;
    }
  }
  for (const [i, raw] of json) {
    try { blocks[i].input = raw ? JSON.parse(raw) : {}; } catch { blocks[i].input = {}; }
  }
  return { role: ROLE.ASSISTANT, content: blocks.filter(Boolean) };
}

// The session's configuration: any change means a different process.
// Tools are compared on what the CLI is given (name, description, schema),
// so moving cache_control breakpoints does not restart the process.
export function configSignature({ model, system, tools, effort }) {
  const sys = typeof system === "string" ? system : stableStringify(normalizeContent(system));
  const toolDefs = (tools || []).map((t) => ({ name: t?.name, description: t?.description, input_schema: t?.input_schema }));
  return sha(stableStringify({ model, system: sys, tools: toolDefs, effort: effort || null }));
}

// Tenant scope: the caller's 9Router API key (hashed, never stored raw) and the
// connection. A client-reported session id narrows the key further but is
// never the isolation boundary on its own.
export function scopeKey({ apiKey, connectionId, clientSessionId }) {
  return sha(stableStringify({ k: apiKey ? sha(apiKey) : null, c: connectionId || null, s: clientSessionId || null }));
}

/**
 * What a request asks of an existing conversation.
 * @param {object} state  { messages: [...], awaitingToolUseIds: [...] } or null
 * @param {Array} messages  the request's messages
 * @returns {{kind:"user", content}|{kind:"tool_results", blocks}|{kind:"cold", reason}}
 */
export function classifyRequest(state, messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== ROLE.USER) return { kind: "cold", reason: "last message is not user" };
  if (!state) return { kind: "cold", reason: "no live session" };

  const prefix = messages.slice(0, -1);
  if (prefix.length !== state.messages.length) {
    return { kind: "cold", reason: `history length ${prefix.length} != live ${state.messages.length}` };
  }
  for (let i = 0; i < prefix.length; i++) {
    const a = prefix[i];
    const b = state.messages[i];
    const same = a.role === b.role && (a.role === ROLE.ASSISTANT
      ? assistantKey(a) === assistantKey(b)
      : messageHash(a) === messageHash(b));
    if (!same) return { kind: "cold", reason: `history differs at message ${i}` };
  }

  const content = normalizeContent(last.content);
  const toolResults = content.filter((b) => b?.type === CLAUDE_BLOCK.TOOL_RESULT);
  if (state.awaitingToolUseIds.length) {
    const others = content.filter((b) => b?.type !== CLAUDE_BLOCK.TOOL_RESULT);
    const ids = new Set(toolResults.map((b) => b.tool_use_id));
    const exact = ids.size === state.awaitingToolUseIds.length
      && state.awaitingToolUseIds.every((id) => ids.has(id));
    if (!exact) return { kind: "cold", reason: "tool_result ids do not match the pending tool_use ids" };
    // Text next to tool_results cannot be carried by an MCP result.
    if (others.length) return { kind: "cold", reason: "tool_result message carries extra content" };
    return { kind: "tool_results", blocks: toolResults };
  }
  if (toolResults.length) return { kind: "cold", reason: "tool_result without a pending tool_use" };
  return { kind: "user", content };
}
