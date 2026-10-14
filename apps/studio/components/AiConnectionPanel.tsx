"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * THE AI CONNECTION CHECK (administrators).
 *
 * "The AI service could not process this request" is a card for researchers:
 * it deliberately says nothing about the provider. The REASON — an account out
 * of credit, a refused key, an unknown model, a request the provider will not
 * take — has to be somewhere an administrator can read it without opening a
 * log or pasting a key into a chat. This asks the provider three small
 * questions (a plain request, a request with a JSON schema, the output
 * ceiling the copilot asks for) and shows what it answered, redacted.
 */
interface Step { ok: boolean; kind?: string; status?: number; said?: string; ms: number }
interface Probe { configured: boolean; provider: string | null; host?: string; model?: string; verdict: string; plain?: Step; schema?: Step; ceiling?: Step & { asked: number } }
interface Lane { lane: string; state: string; lastError?: { kind: string; status?: number; at: string; detail?: string } }
interface Health { configured: boolean; provider: string | null; fallbackConfigured: boolean; lanes: Lane[] }

export function AiConnectionPanel() {
  const [probe, setProbe] = React.useState<Probe | null>(null);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<Health>("/api/ai/health");
    if (r.ok) setHealth(r.data); else setError(r.error);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const run = async () => {
    setBusy(true); setError(null); setProbe(null);
    const r = await api<Probe>("/api/ai/health", { method: "POST" });
    setBusy(false);
    if (r.ok) setProbe(r.data); else setError(r.error);
    void load();
  };

  const row = (label: string, s?: Step & { asked?: number }) => s && (
    <tr data-testid={`ai-probe-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      <td>{label}{s.asked ? ` (${s.asked} tokens)` : ""}</td>
      <td>{s.ok ? <span className="chip ok">accepted</span> : <span className="chip warn">{`refused${s.status ? ` (${s.status})` : ""}${s.kind ? ` — ${s.kind.replace(/_/g, " ")}` : ""}`}</span>}</td>
      <td className="iqi-dim">{s.said ?? ""}</td>
    </tr>
  );

  return (
    <div data-testid="ai-connection">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong className="grow">AI connection</strong>
        <button className="btn small primary" data-testid="ai-probe-run" disabled={busy} onClick={() => void run()}>{busy ? "Checking…" : "Check the AI connection"}</button>
      </div>
      <p className="iqi-dim" style={{ margin: "0 0 10px" }}>
        Sends the provider a few tokens' worth of requests — the way the copilot asks — and shows what it answered. Use it when a researcher sees “The AI service could not process this request”.
      </p>
      {error && <div className="auth-note err">{error}</div>}
      {probe && (
        <div data-testid="ai-probe-result">
          <div className={`auth-note ${probe.plain?.ok && probe.schema?.ok && probe.ceiling?.ok ? "ok" : "err"}`} data-testid="ai-probe-verdict">
            <strong>{probe.verdict}</strong>
            <div className="iqi-dim">{[probe.host, probe.model].filter(Boolean).join(" · ")}</div>
          </div>
          <table className="acct-table" style={{ width: "100%" }}>
            <thead><tr><th>Request</th><th>Result</th><th>What the provider said</th></tr></thead>
            <tbody>{row("A plain request", probe.plain)}{row("A request with a JSON schema", probe.schema)}{row("The output ceiling", probe.ceiling)}</tbody>
          </table>
        </div>
      )}
      {health && (
        <div style={{ marginTop: 14 }} data-testid="ai-lanes">
          <strong>What this server has seen</strong>
          {!health.configured && <p className="iqi-dim">No AI provider is configured (AI_API_URL).</p>}
          {health.lanes.length === 0 && health.configured && <p className="iqi-dim">No request has been made on this instance yet.</p>}
          <ul>
            {health.lanes.map((l) => (
              <li key={l.lane}>{l.lane}: {l.state}{l.lastError ? ` — last error ${l.lastError.kind.replace(/_/g, " ")}${l.lastError.status ? ` (${l.lastError.status})` : ""}${l.lastError.detail ? `: ${l.lastError.detail}` : ""}` : ""}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
