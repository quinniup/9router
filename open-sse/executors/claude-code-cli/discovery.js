// What the host CLI reports about itself: version, login and models.
//
// Read from the stream-json `initialize` response of a short-lived process,
// so it reflects this CLI version, this login and this host's settings. A
// listed model is one the CLI offers, not one this account was shown to be
// able to call; the connection's model test is the live check.

import { CLAUDE_CODE_CLI_MIN_VERSION } from "../../config/claudeCodeCli.js";
import { ClaudeCliSession } from "./session.js";
import { cliVersion, compareVersions, hostSessionOptions } from "./host.js";

const CACHE_TTL_MS = 60 * 1000;
let cached = null; // { at, result }
let inflight = null;

// initialize.account → login state. A logged-out CLI reports
// tokenSource "none"; a claude.ai login reports subscriptionType; key and
// token logins report their source. Non-firstParty backends (Bedrock,
// Vertex, ...) authenticate outside the CLI, so only the backend is known.
export function summarizeAccount(account = {}) {
  const external = account.apiProvider && account.apiProvider !== "firstParty";
  const tokenSource = account.tokenSource && account.tokenSource !== "none" ? account.tokenSource : null;
  const authSource = account.subscriptionType ? "claude.ai" : tokenSource || account.apiKeySource || null;
  return {
    loggedIn: external || !!authSource,
    authSource: external ? account.apiProvider : authSource,
    subscriptionType: account.subscriptionType || null,
    email: account.email || null,
    organization: account.organization || null,
    apiProvider: account.apiProvider || null,
  };
}

// initialize.models → catalog rows. `value` is what --model accepts.
export function summarizeModels(models = []) {
  return models.filter((m) => m?.value).map((m) => ({
    id: m.value,
    name: m.displayName || m.value,
    description: m.description || "",
    resolvedModel: m.resolvedModel || null,
    supportedEffortLevels: m.supportedEffortLevels || [],
    supportsAdaptiveThinking: !!m.supportsAdaptiveThinking,
    supportsFastMode: !!m.supportsFastMode,
  }));
}

async function probe() {
  const host = hostSessionOptions();
  const version = cliVersion(host.bin);
  const base = { bin: host.bin, version, checkedAt: new Date().toISOString() };
  if (!version) return { ...base, installed: false, supported: false, loggedIn: false, models: [], error: `Claude Code CLI not found or not runnable: ${host.bin}` };
  if (compareVersions(version, CLAUDE_CODE_CLI_MIN_VERSION) < 0) {
    return { ...base, installed: true, supported: false, loggedIn: false, models: [], error: `Claude Code CLI ${version} is older than the supported ${CLAUDE_CODE_CLI_MIN_VERSION}` };
  }
  const session = new ClaudeCliSession({ ...host, system: "" });
  try {
    const init = await session.start();
    const account = summarizeAccount(init?.account);
    return {
      ...base,
      installed: true,
      supported: true,
      ...account,
      models: summarizeModels(init?.models),
      error: account.loggedIn ? null : "Claude Code CLI is not logged in on this host. Run `claude` and /login, or set CLAUDE_CODE_OAUTH_TOKEN.",
    };
  } catch (err) {
    return { ...base, installed: true, supported: true, loggedIn: false, models: [], error: err.message };
  } finally {
    session.close();
  }
}

// Cached for a minute; concurrent callers share one probe.
export async function discoverClaudeCodeCli({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  inflight ??= probe().then((result) => {
    cached = { at: Date.now(), result };
    return result;
  }).finally(() => { inflight = null; });
  return inflight;
}
