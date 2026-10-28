// Claude Code CLI — the official `claude` binary on the 9Router host serves
// Messages requests (executors/claude-code-cli.js). The CLI owns its login;
// a connection here stores no token, it only enables the host CLI as an
// account. Models come from the CLI itself (executors/claude-code-cli/discovery.js);
// the list below is the fallback of aliases `claude --model` accepts.
export default {
  id: "claude-code-cli",
  priority: 10,
  alias: "ccli",
  uiAlias: "ccli",
  display: {
    name: "Claude Code CLI",
    icon: "terminal",
    color: "#D97757",
    textIcon: "CC",
    website: "https://code.claude.com",
    notice: {
      signupUrl: "https://code.claude.com/docs/en/setup",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  authType: "oauth",
  transport: {
    baseUrl: "claude-code-cli://stdio",
    format: "claude",
  },
  models: [
    { id: "default", name: "Default (CLI)" },
    { id: "opus", name: "Opus (CLI alias)" },
    { id: "sonnet", name: "Sonnet (CLI alias)" },
    { id: "haiku", name: "Haiku (CLI alias)" },
    { id: "fable", name: "Fable (CLI alias)" },
  ],
};
