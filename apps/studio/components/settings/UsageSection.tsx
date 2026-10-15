"use client";
import React from "react";
import { api } from "@/lib/useSession";
import { formatCount } from "@/lib/byok/settingsModel";
import type { AiUsage, OwnRow } from "@/lib/byok/usage";

/**
 * USAGE & COST — what ran on MY provider, and what ran on the platform's AI
 * and was charged to my wallet. Two tables, never summed together. For my own
 * provider the Studio shows volumes only: it neither charged for that work nor
 * knows what my provider charges, and it will not make up a figure.
 */

const SERVICE_WORD: Record<string, string> = { chat: "AI model", stt: "Speech-to-text", translate: "Translation", tts: "Text-to-speech", other: "Other" };

/** AI charges are fractions of a cent: show enough digits that a small amount is not rounded to nothing, and never more than the wallet records */
const money = (n: number) => {
  if (n === 0) return "$0.00";
  if (n > 0 && n < 0.0001) return "<$0.0001";
  if (n >= 1) return `$${n.toFixed(2)}`;
  const t = n.toFixed(4).replace(/0+$/, "");
  return `$${t.length - t.indexOf(".") - 1 < 2 ? n.toFixed(2) : t}`;
};

const volume = (r: OwnRow): string => {
  if (r.service === "chat") return `${formatCount(r.inputTokens)} in / ${formatCount(r.outputTokens)} out tokens`;
  if (r.characters) return `${formatCount(r.characters)} characters`;
  if (r.minutes) return `${(Math.round(r.minutes * 10) / 10).toLocaleString("en-US")} min`;
  return "—";
};

export function UsageSection({ refreshKey, providerLabel }: { refreshKey: number; providerLabel: (id: string) => string }) {
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState<(AiUsage & { ok: true }) | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<AiUsage & { ok: true }>(`/api/account/ai/usage?days=${days}`);
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [days]);
  React.useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <div className="card fe-card" data-testid="ai-usage">
      <div className="row" style={{ alignItems: "center", gap: 10 }}>
        <div className="card-title" style={{ margin: 0 }}>Usage &amp; cost</div>
        <span className="grow" />
        <label className="muted" style={{ fontSize: 13 }}>Last{" "}
          <select className="input" style={{ width: "auto", display: "inline-block" }} value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="ai-usage-days">
            <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
          </select>
        </label>
        <button type="button" className="btn small" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div className="auth-note err" data-testid="ai-usage-error">{error}</div>}
      {!data && !error && <p className="muted">Reading your usage…</p>}
      {data && (
        <>
          <h3 className="fe-h3">On my own provider <span className="muted" style={{ fontWeight: 400 }}>· not billed here</span></h3>
          <p className="muted fe-note" data-testid="ai-usage-cost-note">{data.costNote}</p>
          {data.own.length === 0 ? <p className="muted" data-testid="ai-usage-own-empty">No work on your own provider in the last {data.days} days.</p> : (
            <div className="table-wrap">
              <table className="grid" data-testid="ai-usage-own">
                <thead><tr><th>Feature</th><th>Provider</th><th>Model</th><th>Calls</th><th>Sent</th><th>Served by a fallback</th></tr></thead>
                <tbody>
                  {data.own.map((r) => (
                    <tr key={`${r.service}|${r.provider}|${r.model}`} data-testid="ai-usage-own-row">
                      <td>{SERVICE_WORD[r.service]}</td><td>{providerLabel(r.provider)}</td><td className="mono">{r.model && r.model !== "v2" && r.model !== "3.0" ? r.model : "—"}</td>
                      <td>{r.calls.toLocaleString("en-US")}</td><td>{volume(r)}</td><td>{r.viaFallback ? r.viaFallback.toLocaleString("en-US") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="fe-h3">On the platform's AI <span className="muted" style={{ fontWeight: 400 }}>· charged to my wallet</span></h3>
          {data.platform.length === 0 ? <p className="muted" data-testid="ai-usage-platform-empty">No platform AI used in the last {data.days} days.</p> : (
            <div className="table-wrap">
              <table className="grid" data-testid="ai-usage-platform">
                <thead><tr><th>Feature</th><th>Calls</th><th>Charged</th></tr></thead>
                <tbody>
                  {data.platform.map((r) => <tr key={r.label} data-testid="ai-usage-platform-row"><td>{r.label}</td><td>{r.calls.toLocaleString("en-US")}</td><td>{money(r.charge)}</td></tr>)}
                  <tr><td><strong>Total</strong></td><td>{data.platformTotals.calls.toLocaleString("en-US")}</td><td data-testid="ai-usage-platform-total"><strong>{money(data.platformTotals.charge)}</strong></td></tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="muted fe-note">The two tables are never added together. Platform charges are the same amounts your <a href="/billing">My usage</a> page shows.</p>
        </>
      )}
    </div>
  );
}
