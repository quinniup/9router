// Cold start: write the client's history as a CLI transcript so a new process
// continues the same conversation via `--resume <file>`.
//
// This is the CLI's internal session format (observed on 2.1.311–2.1.312), not
// a supported import API. Only the fields the probes needed are written. The
// file must end with the turn the model should answer: the final user
// message or the final tool_result message.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROLE } from "../../translator/schema/index.js";

export function buildTranscript(messages, { sessionId, cwd, version, model }) {
  const now = new Date().toISOString();
  let parentUuid = null;
  const lines = [];
  for (const m of messages) {
    const uuid = randomUUID();
    const message = m.role === ROLE.ASSISTANT
      ? {
        id: `msg_${uuid.replace(/-/g, "").slice(0, 24)}`,
        type: "message",
        role: ROLE.ASSISTANT,
        model: model || "unknown",
        content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
        stop_reason: Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
      : { role: ROLE.USER, content: m.content };
    lines.push(JSON.stringify({
      parentUuid,
      isSidechain: false,
      type: m.role === ROLE.ASSISTANT ? "assistant" : "user",
      uuid,
      timestamp: now,
      message,
      userType: "external",
      cwd,
      sessionId,
      version,
    }));
    parentUuid = uuid;
  }
  return lines.join("\n") + "\n";
}

// Writes <dir>/<sessionId>.jsonl (0600) and returns its absolute path.
export function writeTranscript(dir, messages, opts) {
  const sessionId = randomUUID();
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, buildTranscript(messages, { ...opts, sessionId }), { mode: 0o600 });
  return file;
}
