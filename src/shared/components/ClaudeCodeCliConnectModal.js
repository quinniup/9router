"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";

/**
 * Claude Code CLI connect modal.
 *
 * Nothing is entered here: the official `claude` binary on this server owns
 * its login. The modal shows what that CLI reports (version, login, models)
 * and enables it as the provider's account once it is logged in.
 */
async function fetchCliStatus() {
  const res = await fetch("/api/providers/claude-code-cli?refresh=1", { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export default function ClaudeCodeCliConnectModal({ isOpen, onSuccess, onClose }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const applyCheck = useCallback((promise) => promise.then(
    (data) => { setStatus(data); setError(null); },
    (e) => { setStatus(null); setError(e.message || "Failed to check the Claude Code CLI"); },
  ), []);

  // Check once per open; state is only set when the request settles.
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    applyCheck(fetchCliStatus().then((data) => {
      if (cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });
      return data;
    })).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, applyCheck]);

  const check = () => {
    setChecking(true);
    applyCheck(fetchCliStatus()).finally(() => setChecking(false));
  };

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/providers/claude-code-cli", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onSuccess?.();
    } catch (e) {
      setError(e.message || "Failed to connect");
    } finally {
      setConnecting(false);
    }
  };

  const rows = status ? [
    ["CLI", status.installed ? `${status.version} · ${status.bin}` : "Not found"],
    ["Login", status.loggedIn
      ? [status.email, status.subscriptionType, status.authSource].filter(Boolean).join(" · ")
      : "Not logged in"],
    ["Models", status.models?.length ? status.models.map((m) => m.id).join(", ") : "—"],
  ] : [];

  return (
    <Modal isOpen={isOpen} title={translate("Connect Claude Code CLI")} onClose={onClose} size="lg">
      <div className="flex flex-col gap-3.5">
        <p className="text-xs text-text-muted leading-relaxed">
          Requests run on the official Claude Code CLI installed on this server, under its own login.
          9Router stores no token. Tools always run on the calling client, never on this server.
        </p>

        {!status && !error && (
          <p className="text-sm text-text-muted py-4 text-center">Checking the Claude Code CLI on this server...</p>
        )}

        {status && (
          <div className="rounded-lg border border-black/10 dark:border-white/10 divide-y divide-black/5 dark:divide-white/5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex gap-3 px-3 py-2 text-xs">
                <span className="w-14 shrink-0 font-semibold text-text-muted">{label}</span>
                <span className="min-w-0 break-words">{value}</span>
              </div>
            ))}
          </div>
        )}

        {status?.loggedIn && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 p-2.5 rounded-lg">
            <p className="text-xs text-yellow-700 dark:text-yellow-400 leading-relaxed">
              Anyone who can call this 9Router&apos;s /v1 endpoint can use this server&apos;s Claude account.
              Turn on &quot;Require API key&quot; if the endpoint is reachable by others.
            </p>
          </div>
        )}

        {(error || (status && !status.loggedIn && status.error)) && (
          <div className="bg-red-50 dark:bg-red-900/20 p-2.5 rounded-lg border border-red-200 dark:border-red-800">
            <p className="text-xs text-red-600 dark:text-red-400 break-words">{error || status.error}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={check} variant="outline" loading={checking} disabled={connecting} fullWidth>
            Re-check
          </Button>
          <Button onClick={connect} loading={connecting} disabled={!status?.loggedIn || checking} fullWidth>
            Connect
          </Button>
        </div>
      </div>
    </Modal>
  );
}

ClaudeCodeCliConnectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
