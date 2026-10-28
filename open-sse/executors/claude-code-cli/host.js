// Where the host's `claude` binary is and how every process on this host is
// configured. Shared by the executor, discovery and the dashboard so they all
// talk to the same binary with the same login.
//
// Env: CLI_CLAUDE_BIN (binary), CLI_CLAUDE_SETTINGS (settings file/JSON; also
// turns off the host user's other setting sources), CLI_CLAUDE_CONFIG_DIR
// (CLAUDE_CONFIG_DIR for a dedicated login).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveClaudeBin() {
  const envBin = process.env.CLI_CLAUDE_BIN?.trim();
  if (envBin) return envBin;
  const home = os.homedir();
  // A detached server (tray/launchd) may not have the login shell's PATH.
  const candidates = process.platform === "win32"
    ? [path.join(home, ".local", "bin", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === "win32" ? "claude.exe" : "claude";
}

export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// `claude --version` → "2.1.312 (Claude Code)". Cached per binary path for a
// minute so an upgrade is picked up without a restart.
const VERSION_TTL_MS = 60 * 1000;
const versionCache = new Map();
export function cliVersion(bin) {
  const hit = versionCache.get(bin);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.version;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 });
  const version = r.status === 0 ? (r.stdout.match(/\d+\.\d+\.\d+/) || [null])[0] : null;
  versionCache.set(bin, { version, at: Date.now() });
  return version;
}

// Options every ClaudeCliSession on this host starts with.
export function hostSessionOptions() {
  return {
    bin: resolveClaudeBin(),
    settings: process.env.CLI_CLAUDE_SETTINGS?.trim() || undefined,
    env: process.env.CLI_CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLI_CLAUDE_CONFIG_DIR } : {},
  };
}
