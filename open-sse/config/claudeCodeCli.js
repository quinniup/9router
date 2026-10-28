// Claude Code CLI provider: facts about the official `claude` binary that the
// executor drives over stream-json stdio. Observed on CLI 2.1.312 and Agent
// SDK 0.2.76 (2026-10-28). The control protocol, the transcript and these env
// names are CLI internals, not a stable public API; re-verify on upgrades.

// Oldest CLI the stream-json control protocol was verified against.
export const CLAUDE_CODE_CLI_MIN_VERSION = "2.1.312";

// In-process ("sdk") MCP server that carries the client's tools.
export const CLAUDE_CODE_CLI_MCP_SERVER = "client";
// tools/call params._meta key holding the Messages tool_use id.
export const CLAUDE_CODE_CLI_TOOL_USE_ID_META = "claudecode/toolUseId";
// Per-tool _meta key that raises the CLI's MCP result size cap (default
// 50,000 chars, larger results are spilled to a file on the Server).
export const CLAUDE_CODE_CLI_MAX_RESULT_META = "anthropic/maxResultSizeChars";
export const CLAUDE_CODE_CLI_MAX_RESULT_CHARS = 500000;

// Claude Code's per-session request header (lowercase, as 9Router stores raw headers).
export const CLAUDE_CODE_CLI_SESSION_HEADER = "x-claude-code-session-id";

export const CLAUDE_CODE_CLI_START_TIMEOUT_MS = 30000;
export const CLAUDE_CODE_CLI_KILL_GRACE_MS = 2000;
// One stdout line is one JSON envelope; anything larger is treated as a fault.
export const CLAUDE_CODE_CLI_MAX_LINE_BYTES = 64 * 1024 * 1024;
export const CLAUDE_CODE_CLI_STDERR_TAIL_BYTES = 8192;

// Inherited env that must not reach the Server CLI: the parent's own
// Anthropic routing/credentials (may point back at 9Router) and nested
// Claude Code session markers. CLAUDE_CODE_OAUTH_TOKEN is the documented
// headless login, so an operator-provided one is kept.
export const CLAUDE_CODE_CLI_STRIP_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
export const CLAUDE_CODE_CLI_STRIP_ENV_KEYS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "AI_AGENT"];
export const CLAUDE_CODE_CLI_KEEP_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN"];

// Applied after stripping. Keeps the Server CLI from adding its own context
// (CLAUDE.md, memory, git status, attachments) on top of the client's.
export const CLAUDE_CODE_CLI_ISOLATION_ENV = {
  CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1", // model sees client tool names without mcp__client__
  ENABLE_TOOL_SEARCH: "false", // all client tools are sent up front, as the client sent them
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTO_COMPACT: "1", // the client owns compaction
};

// The CLI always tells the model its own cwd, platform and shell (a user-turn
// environment reminder that no flag removes without also dropping OAuth).
// Every process runs in this one stable, empty directory, and the system
// prompt names it as host-only so the model keeps using the client's paths.
// Measured on CLI 2.1.312: without the note the model read files under the
// Server cwd in 3/3 runs; with it, the client cwd in 4/4.
export const CLAUDE_CODE_CLI_WORKSPACE_DIRNAME = "9router-claude-code-cli";
export function claudeCodeCliHostNote(workspace) {
  return "\n\n# Host environment\nThis conversation is relayed through a model host. "
    + `Any environment block that names ${workspace} describes that host only: no tool can reach it, `
    + "and its paths, platform, shell and OS do not apply. Every tool runs on the user's machine; "
    + "use only the environment the user's own messages describe.";
}
