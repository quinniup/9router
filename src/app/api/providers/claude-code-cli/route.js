import { NextResponse } from "next/server";
import { getProviderConnections, createProviderConnection, updateProviderConnection } from "@/models";
import { discoverClaudeCodeCli } from "open-sse/executors/claude-code-cli/discovery.js";

const PROVIDER = "claude-code-cli";

// GET /api/providers/claude-code-cli — what the host's Claude Code CLI reports:
// install, version, login and models. Never returns a credential; the CLI
// keeps its own login. ?refresh=1 skips the one-minute cache.
export async function GET(request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  return NextResponse.json(await discoverClaudeCodeCli({ force }));
}

// POST /api/providers/claude-code-cli — enable the host CLI as this provider's
// account. Refused unless the CLI is installed, supported and logged in. One
// host CLI is one account, so an existing connection is updated, not duplicated.
export async function POST() {
  try {
    const status = await discoverClaudeCodeCli({ force: true });
    if (!status.loggedIn) {
      return NextResponse.json({ error: status.error || "Claude Code CLI is not ready", status }, { status: 409 });
    }
    const data = {
      provider: PROVIDER,
      authType: "oauth",
      name: "Host Claude Code CLI",
      displayName: status.email || `Host CLI (${status.authSource})`,
      email: status.email || null,
      providerSpecificData: {
        authMethod: "host-cli",
        cliVersion: status.version,
        authSource: status.authSource,
        subscriptionType: status.subscriptionType,
      },
      testStatus: "active",
    };
    const [existing] = await getProviderConnections({ provider: PROVIDER });
    const connection = existing
      ? await updateProviderConnection(existing.id, { ...data, isActive: true, lastError: null, lastErrorAt: null })
      : await createProviderConnection(data);
    return NextResponse.json({
      success: true,
      connection: { id: connection.id, provider: connection.provider, displayName: connection.displayName, email: connection.email },
    });
  } catch (error) {
    console.log("Claude Code CLI connect error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
