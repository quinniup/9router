// Live ClaudeCliSession processes, keyed by tenant scope + configuration.
//
// A conversation is reusable only by the same scope (9Router API key +
// connection + client session id) with the same model/system/tools/effort.
// One conversation serves one request at a time.

import { ClaudeCliSession, SESSION_STATE } from "./session.js";
import { classifyRequest } from "./conversation.js";

export const POOL_DEFAULTS = {
  maxProcesses: 8,
  idleTtlMs: 10 * 60 * 1000, // idle between user turns
  awaitToolsTtlMs: 30 * 60 * 1000, // waiting for the client to run tools
};

export class ClaudeCliPool {
  constructor({ createSession = (opts) => new ClaudeCliSession(opts), ...limits } = {}) {
    this.createSession = createSession;
    this.limits = { ...POOL_DEFAULTS, ...limits };
    this.entries = new Map(); // key → entry
    this.sweeper = setInterval(() => this.sweep(), 30 * 1000);
    this.sweeper.unref?.();
  }

  // Find the live conversation for this request, or decide on a cold start.
  // Returns { entry, step } where step comes from classifyRequest.
  checkout(scope, signature, messages) {
    const entry = [...this.entries.values()].find((e) => e.scope === scope && e.signature === signature
      && !e.busy && e.session.state !== SESSION_STATE.CLOSED
      && classifyRequest(e.state, messages).kind !== "cold");
    if (entry) {
      entry.busy = true;
      return { entry, step: classifyRequest(entry.state, messages) };
    }
    return { entry: null, step: classifyRequest(null, messages) };
  }

  // Start a fresh process for this scope. Evicts the least recently used idle
  // entry when full; refuses (503) if every slot is busy. onEvent receives the
  // events of the turn a resumed (cold) session starts by itself.
  async open(scope, signature, sessionOpts, onEvent) {
    if (this.entries.size >= this.limits.maxProcesses) {
      const idle = [...this.entries.values()].filter((e) => !e.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      if (!idle.length) {
        const err = new Error(`Claude Code CLI pool is full (${this.limits.maxProcesses} active processes)`);
        err.status = 503;
        throw err;
      }
      this.drop(idle[0]);
    }
    const session = this.createSession(sessionOpts);
    const entry = { key: session.id, scope, signature, session, busy: true, lastUsed: Date.now(), state: { messages: [], awaitingToolUseIds: [] } };
    this.entries.set(entry.key, entry);
    try {
      await session.start(onEvent);
    } catch (err) {
      this.drop(entry);
      throw err;
    }
    return entry;
  }

  release(entry) {
    entry.busy = false;
    entry.lastUsed = Date.now();
    if (entry.session.state === SESSION_STATE.CLOSED) this.drop(entry);
  }

  drop(entry) {
    this.entries.delete(entry.key);
    entry.session.close();
  }

  sweep(now = Date.now()) {
    for (const entry of this.entries.values()) {
      if (entry.busy) continue;
      const ttl = entry.session.state === SESSION_STATE.AWAITING_TOOLS ? this.limits.awaitToolsTtlMs : this.limits.idleTtlMs;
      if (entry.session.state === SESSION_STATE.CLOSED || now - entry.lastUsed > ttl) this.drop(entry);
    }
  }

  closeAll() {
    clearInterval(this.sweeper);
    for (const entry of [...this.entries.values()]) this.drop(entry);
  }
}
