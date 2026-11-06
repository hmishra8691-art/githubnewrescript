"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * COMMERCIAL MARGINS — the administrator's screen over /api/recruitment/margins (0087, §10).
 *
 * Platform audit 2026-11-05: the API was complete — GET, POST, DELETE, a worked example in every response —
 * and no screen called it, so a margin rule could be set only with a hand-written HTTP request and every
 * quote used the 30% platform default. This is the screen.
 *
 * Everything here is acquisition cost and the margin taken on it; the route refuses anyone who is not a
 * platform administrator (`canSeeVendors`) and so does this panel, by showing what the route says.
 *
 * The margin is of the SELLING PRICE: price = cost / (1 − margin). The worked example the route returns is
 * shown rather than restated, because a markup and a margin differ by exactly the error that looks plausible
 * on a screen.
 */

interface Rule {
  id: string; scope: string; margin_bps: number; market: string | null; recruitment_type: string | null;
  recruitment_project_id: string | null; note: string | null; effective_from: string; effective_to: string | null; created_at: string;
}
interface Application {
  id: string; recruitment_project_id: string | null; market: string | null; purpose: string; completes: number;
  cost_amount: number; margin_bps: number; margin_scope: string; price_amount: number; profit_amount: number;
  currency: string; because: string | null; within_target_band: boolean; computed_at: string;
}
interface Payload {
  rules: Rule[]; applications: Application[];
  targetBand: { minBps: number; maxBps: number } | [number, number] | Record<string, number>;
  worked: { cost: number; examples: { marginBps: number; price: number; equivalentMarkupBps: number }[] };
}

const SCOPES: { value: string; label: string; needs?: "market" | "recruitment_type" | "project" }[] = [
  { value: "default", label: "Platform default" },
  { value: "market", label: "One market", needs: "market" },
  { value: "recruitment_type", label: "One recruitment type", needs: "recruitment_type" },
  { value: "project", label: "One project", needs: "project" },
  { value: "override", label: "Override for one project (needs a note)", needs: "project" },
];

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const money = (n: number, ccy: string) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(n); } catch { return `${ccy} ${n.toFixed(2)}`; } };
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";

export function MarginRulesPanel() {
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [scope, setScope] = React.useState("default");
  const [marginPct, setMarginPct] = React.useState("30");
  const [market, setMarket] = React.useState("");
  const [recruitmentType, setRecruitmentType] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [why, setWhy] = React.useState("");
  const [armed, setArmed] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<Payload>("/api/recruitment/margins");
    if (!r.ok) {
      if (r.status === 403) { setDenied(true); return; }
      if (r.status !== 401) setError(r.error);
      return;
    }
    setError(null);
    setData(r.data);
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(id);
  }, [armed]);

  const needs = SCOPES.find((s) => s.value === scope)?.needs;
  const save = async () => {
    const bps = Math.round(Number(marginPct) * 100);
    if (!Number.isFinite(bps)) { setError("The margin must be a number of percent."); return; }
    setBusy(true); setNote(null);
    try {
      const r = await api<{ ok: true; worked: { cost: number; price: number; equivalentMarkupBps: number } }>("/api/recruitment/margins", {
        method: "POST",
        json: { scope, marginBps: bps, market: needs === "market" ? market : undefined, recruitmentType: needs === "recruitment_type" ? recruitmentType : undefined, recruitmentProjectId: needs === "project" ? projectId : undefined, note: why || undefined },
      });
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setNote(`Saved. A ${money(r.data.worked.cost, "USD")} cost now sells for ${money(r.data.worked.price, "USD")} — the same as a ${pct(r.data.worked.equivalentMarkupBps)} markup.`);
      setWhy("");
      await load();
    } finally { setBusy(false); }
  };
  const end = async (id: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await api<{ ok: true }>(`/api/recruitment/margins?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) { setError(r.error); return; }
      setError(null); setArmed(null);
      setNote("That rule has been ended. Prices already recorded against it are unchanged.");
      await load();
    } finally { setBusy(false); }
  };

  if (denied) {
    return <div className="auth-note err" data-testid="margins-denied">Margins are acquisition cost and the platform's take on it — visible to platform administrators only.</div>;
  }

  const live = (data?.rules ?? []).filter((r) => !r.effective_to);
  const ended = (data?.rules ?? []).filter((r) => r.effective_to);

  return (
    <div data-testid="margins-panel">
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 760 }}>
        What recruitment is sold for. The margin is of the <b>selling price</b> — price = cost ÷ (1 − margin), capped at 95% —
        and the most specific live rule wins: an override, then the project, then the recruitment type, then the market,
        then the platform default. Nothing a researcher sees carries these figures.
        {data?.worked && (
          <>
            {" "}For example, a cost of {money(data.worked.cost, "USD")}:{" "}
            {data.worked.examples.map((e, i) => (
              <span key={e.marginBps}>{i ? "; " : ""}at {pct(e.marginBps)} it sells for {money(e.price, "USD")} (a {pct(e.equivalentMarkupBps)} markup)</span>
            ))}.
          </>
        )}
      </p>

      {error && <div className="auth-note err">{error}</div>}
      {note && !error && <div className="auth-note ok">{note}</div>}

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Set a rule</div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="auth-field" style={{ minWidth: 220, margin: 0 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Applies to</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)} data-testid="margin-scope">
              {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="auth-field" style={{ width: 120, margin: 0 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Margin %</span>
            <input className="input" type="number" min={0} max={95} step={0.5} value={marginPct} onChange={(e) => setMarginPct(e.target.value)} data-testid="margin-pct" />
          </label>
          {needs === "market" && (
            <label className="auth-field" style={{ width: 100, margin: 0 }}><span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Market</span><input className="input" value={market} onChange={(e) => setMarket(e.target.value.toUpperCase())} placeholder="GB" maxLength={2} /></label>
          )}
          {needs === "recruitment_type" && (
            <label className="auth-field" style={{ width: 180, margin: 0 }}><span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Recruitment type</span><input className="input" value={recruitmentType} onChange={(e) => setRecruitmentType(e.target.value)} placeholder="b2b" /></label>
          )}
          {needs === "project" && (
            <label className="auth-field" style={{ minWidth: 300, margin: 0 }}><span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Recruitment project id</span><input className="input mono" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="the recruitment project's uuid" /></label>
          )}
          <label className="auth-field grow" style={{ minWidth: 220, margin: 0 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Note{scope === "override" ? " (required for an override)" : ""}</span>
            <input className="input" value={why} onChange={(e) => setWhy(e.target.value)} placeholder={scope === "override" ? "why this project is an exception" : "optional"} />
          </label>
          <button className="btn primary" onClick={() => void save()} disabled={busy} data-testid="margin-save">Save rule</button>
        </div>
      </div>

      <div className="row" style={{ margin: "6px 0 8px" }}>
        <strong className="grow">Live rules</strong>
        <button className="btn small" onClick={() => void load()} disabled={busy}>Refresh</button>
      </div>
      <div className="table-wrap">
        <table className="grid" data-testid="margin-rules">
          <thead><tr><th>Applies to</th><th>Margin</th><th>Target</th><th>Note</th><th>Since</th><th /></tr></thead>
          <tbody>
            {!data && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
            {data && live.length === 0 && <tr><td colSpan={6} className="muted">No rules. Every quote uses the platform default of 30%.</td></tr>}
            {live.map((r) => (
              <tr key={r.id} data-testid="margin-rule" data-scope={r.scope}>
                <td>{SCOPES.find((s) => s.value === r.scope)?.label ?? r.scope}</td>
                <td className="mono">{pct(r.margin_bps)}</td>
                <td className="mono">{r.market ?? r.recruitment_type ?? (r.recruitment_project_id ? r.recruitment_project_id.slice(0, 8) : "—")}</td>
                <td style={{ whiteSpace: "normal" }}>{r.note ?? <span className="muted">—</span>}</td>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{when(r.effective_from)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {armed === r.id
                    ? <button className="btn small danger" onClick={() => void end(r.id)} disabled={busy}>Confirm end</button>
                    : <button className="btn small" onClick={() => setArmed(r.id)} disabled={busy}>End rule</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ended.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted">{ended.length} ended rule{ended.length === 1 ? "" : "s"} — kept because prices were recorded against them</summary>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Applies to</th><th>Margin</th><th>Target</th><th>From</th><th>To</th></tr></thead>
              <tbody>{ended.map((r) => (
                <tr key={r.id}><td>{r.scope}</td><td className="mono">{pct(r.margin_bps)}</td><td className="mono">{r.market ?? r.recruitment_type ?? (r.recruitment_project_id ? r.recruitment_project_id.slice(0, 8) : "—")}</td><td className="muted">{when(r.effective_from)}</td><td className="muted">{when(r.effective_to)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}

      <div className="row" style={{ margin: "18px 0 8px" }}>
        <strong className="grow">Recent prices computed</strong>
        <span className="muted" style={{ fontSize: 13 }}>the rate that <i>was</i> applied, as recorded — never recomputed</span>
      </div>
      <div className="table-wrap">
        <table className="grid" data-testid="margin-applications">
          <thead><tr><th>When</th><th>Purpose</th><th>Market</th><th>Completes</th><th>Cost</th><th>Margin</th><th>Price</th><th>Profit</th><th>In band</th></tr></thead>
          <tbody>
            {data && data.applications.length === 0 && <tr><td colSpan={9} className="muted">Nothing has been priced yet.</td></tr>}
            {(data?.applications ?? []).map((a) => (
              <tr key={a.id}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{when(a.computed_at)}</td>
                <td>{a.purpose}</td>
                <td className="mono">{a.market ?? "—"}</td>
                <td className="mono">{a.completes}</td>
                <td className="mono">{money(Number(a.cost_amount), a.currency)}</td>
                <td className="mono">{pct(a.margin_bps)} <span className="muted">({a.margin_scope})</span></td>
                <td className="mono">{money(Number(a.price_amount), a.currency)}</td>
                <td className="mono">{money(Number(a.profit_amount), a.currency)}</td>
                <td>{a.within_target_band ? <span className="chip on">yes</span> : <span className="chip warn">no</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
