"use client";
import React from "react";
import { useStudio } from "./store";

/**
 * THE RECRUITMENT EXCHANGE (2026-11-03) — Fieldwork → Vendor Marketplace and Smart Recruitment.
 *
 * Two views over one organisation's sample relationships. The design rule that governs every line of this file is
 * the brief's §5 and §34: *nothing here may imply a capability that does not exist.* In practice that means:
 *
 *   - a capability is rendered as a WORD — "verified", "configured", "—" — never as a tick. A tick beside
 *     "Feasibility" reads as "we can ask them", and in Phase 1 nobody can ask anybody anything;
 *   - every price carries where it came from, and "Live quotation" is a provenance this build cannot produce,
 *     so the rate-card form does not offer it;
 *   - API mode is shown, disabled, with the reason. Hiding it would be tidier and would leave a reader thinking
 *     the platform simply has not got round to Dynata, rather than that no adapter exists yet;
 *   - the comparison ranks by cost per VALID ACCEPTED complete and shows the quoted CPI beside it, so the row
 *     that wins can be seen not to be the cheapest one;
 *   - a vendor that cannot be ranked stays in the table with its reason. Dropping it would read as "unavailable"
 *     when the truth is "nobody has entered a rate card".
 */

type Mode = "api" | "manual" | "redirect_only" | "awaiting" | "inactive";
type CapState = "unsupported" | "declared" | "verified";
type Source = "live" | "vendor_reported" | "historical" | "administrator";

interface VendorView {
  id: string; slug: string; name: string; legalName: string | null; website: string | null;
  description: string | null; panelPreset: string | null; own: boolean;
  integration: { id: string; mode: Mode; health: string; markupBps: number; currency: string; notes: string | null; enabled: boolean } | null;
  mode: Mode; summary: string; capabilities: Record<string, CapState>;
  pricedMarkets: string[]; rateCardRows: number;
  history: { completes: number; rejectionRate: number | null; duplicateRate: number | null } | null;
}

interface ComparisonRow {
  integrationId: string; vendorName: string; mode: Mode;
  cpi: number | null; currency: string; costPerValidComplete: number;
  projectedCost: number | null; expectedValidCompletes: number | null;
  expectedRejectionRate: number | null; expectedDuplicateRate: number | null;
  qualityConfidence: "none" | "low" | "medium" | "high";
  source: Source; rankable: boolean; caveat?: string; unavailableReason?: string;
}

const MODE_LABEL: Record<Mode, string> = {
  api: "API", manual: "Manual", redirect_only: "Recruitment links only", awaiting: "Awaiting integration", inactive: "Inactive",
};
const SOURCE_LABEL: Record<Source, string> = {
  live: "Live quotation", vendor_reported: "Vendor's rate card", historical: "Our own history", administrator: "Administrator's figure",
};
const CAP_LABEL: Record<CapState, string> = { unsupported: "—", declared: "configured", verified: "verified" };

const money = (n: number | null | undefined, ccy = "USD") =>
  n === null || n === undefined || !Number.isFinite(n) ? "—"
  : new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(n);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1)}%`);
const int = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString());

export function RecruitmentPanel() {
  const s = useStudio();
  const [view, setView] = React.useState<"marketplace" | "recruitment">("marketplace");
  return (
    <div className="sec">
      <div className="row">
        <button className={`btn small${view === "marketplace" ? " primary" : ""}`} onClick={() => setView("marketplace")}>Vendor marketplace</button>
        <button className={`btn small${view === "recruitment" ? " primary" : ""}`} onClick={() => setView("recruitment")}>Smart recruitment</button>
      </div>
      {view === "marketplace" ? <Marketplace /> : <Recruitment surveyId={s.surveyDbId} />}
    </div>
  );
}

/* ------------------------------------------------------------ the marketplace */

function Marketplace() {
  const [data, setData] = React.useState<{ vendors: VendorView[]; liveAdaptersAvailable: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await fetch("/api/recruitment/vendors", { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setError(j.error ?? "Could not load the vendor directory"); return; }
    setError(null); setData(j);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    const r = await fetch("/api/recruitment/vendors", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setError(j.error ?? "Could not save"); return false; }
    setError(null); await load(); return true;
  }

  if (error && !data) return <p className="muted">{error}</p>;
  if (!data) return <p className="muted">Loading the vendor directory…</p>;

  return (
    <div className="sec">
      {!data.liveAdaptersAvailable && (
        <p className="chip warn">
          No live vendor adapter exists yet. Every relationship below is manual: an operator enters feasibility,
          prices and orders, and reconciles against the vendor&rsquo;s own invoice. Live API integrations arrive
          once the vendor contracts are in place.
        </p>
      )}
      {error && <p className="chip warn">{error}</p>}

      {data.vendors.map((v) => (
        <div className="card" key={v.id}>
          <div className="row">
            <strong className="grow">{v.name}</strong>
            <span className="muted mono">{MODE_LABEL[v.mode]}</span>
            <button className="btn small" onClick={() => setOpen(open === v.id ? null : v.id)}>
              {open === v.id ? "Close" : "Configure"}
            </button>
          </div>
          <p className="muted">{v.summary}</p>
          {v.description && <p className="muted">{v.description}</p>}

          <div className="row">
            {Object.entries(v.capabilities).map(([cap, state]) => (
              <span key={cap} className="mono muted" title={
                state === "verified" ? "exercised against the vendor successfully"
                : state === "declared" ? "configured here, never yet exercised against the vendor"
                : "not available in this mode"
              }>
                {cap}: {CAP_LABEL[state as CapState]}
              </span>
            ))}
          </div>

          <div className="row">
            <span className="muted">
              Rate card: {v.rateCardRows === 0 ? "none entered" : `${v.rateCardRows} row${v.rateCardRows === 1 ? "" : "s"}`}
              {v.pricedMarkets.length > 0 && <> · priced in <span className="mono">{v.pricedMarkets.join(", ")}</span></>}
            </span>
            {v.history && v.history.completes > 0 && (
              <span className="muted">
                {int(v.history.completes)} accepted here · rejection {pct(v.history.rejectionRate)}
              </span>
            )}
          </div>

          {open === v.id && (
            <VendorForm vendor={v} busy={busy} onSave={save} />
          )}
        </div>
      ))}
    </div>
  );
}

function VendorForm({ vendor, busy, onSave }: {
  vendor: VendorView; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean>;
}) {
  const [mode, setMode] = React.useState<Mode>(vendor.mode);
  const [markup, setMarkup] = React.useState(String(vendor.integration?.markupBps ?? 0));
  const [currency, setCurrency] = React.useState(vendor.integration?.currency ?? "USD");
  const [rate, setRate] = React.useState({ market: "US", irMin: "0", irMax: "100", loiMin: "0", loiMax: "120", cpi: "", source: "vendor_reported" as Source });

  return (
    <div className="sec">
      <div className="row">
        <label className="f">
          <span className="muted">Relationship</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {(["manual", "redirect_only", "awaiting", "inactive"] as Mode[]).map((m) => (
              <option key={m} value={m}>{MODE_LABEL[m]}</option>
            ))}
            <option value="api" disabled>API — no adapter exists yet</option>
          </select>
        </label>
        <label className="f">
          <span className="muted">Our markup (basis points)</span>
          <input className="input mono" value={markup} onChange={(e) => setMarkup(e.target.value)} inputMode="numeric" />
        </label>
        <label className="f">
          <span className="muted">Currency</span>
          <input className="input mono" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        </label>
        <button className="btn primary small" disabled={busy} onClick={() => void onSave({
          action: "integration", vendorId: vendor.id, mode, markupBps: Number(markup) || 0, currency,
        })}>Save</button>
      </div>

      {vendor.integration && (
        <>
          <p className="muted">
            A rate-card row prices one market at one incidence and length band. Bands are half-open, so 10–20 and
            20–30 meet exactly once at 20.
          </p>
          <div className="row">
            <label className="f"><span className="muted">Market</span>
              <input className="input mono" value={rate.market} maxLength={2} onChange={(e) => setRate({ ...rate, market: e.target.value.toUpperCase() })} /></label>
            <label className="f"><span className="muted">IR from</span>
              <input className="input mono" value={rate.irMin} onChange={(e) => setRate({ ...rate, irMin: e.target.value })} /></label>
            <label className="f"><span className="muted">to</span>
              <input className="input mono" value={rate.irMax} onChange={(e) => setRate({ ...rate, irMax: e.target.value })} /></label>
            <label className="f"><span className="muted">LOI from</span>
              <input className="input mono" value={rate.loiMin} onChange={(e) => setRate({ ...rate, loiMin: e.target.value })} /></label>
            <label className="f"><span className="muted">to</span>
              <input className="input mono" value={rate.loiMax} onChange={(e) => setRate({ ...rate, loiMax: e.target.value })} /></label>
            <label className="f"><span className="muted">CPI</span>
              <input className="input mono" value={rate.cpi} onChange={(e) => setRate({ ...rate, cpi: e.target.value })} placeholder="8.00" /></label>
            <label className="f"><span className="muted">Where this came from</span>
              <select className="input" value={rate.source} onChange={(e) => setRate({ ...rate, source: e.target.value as Source })}>
                <option value="vendor_reported">{SOURCE_LABEL.vendor_reported}</option>
                <option value="historical">{SOURCE_LABEL.historical}</option>
                <option value="administrator">{SOURCE_LABEL.administrator}</option>
              </select></label>
            <button className="btn small" disabled={busy || !rate.cpi} onClick={async () => {
              const ok = await onSave({
                action: "pricing", integrationId: vendor.integration!.id, market: rate.market,
                irMin: Number(rate.irMin), irMax: Number(rate.irMax), loiMin: Number(rate.loiMin), loiMax: Number(rate.loiMax),
                cpi: Number(rate.cpi), currency: vendor.integration!.currency, source: rate.source,
              });
              if (ok) setRate({ ...rate, cpi: "" });
            }}>Add price</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the recruitment dashboard */

interface RecruitmentData {
  project: Record<string, unknown> | null;
  comparison: { rows: ComparisonRow[]; source: Source };
  allocations: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  totals: {
    required: number; accepted: number; delivered: number; rejected: number; duplicates: number;
    remaining: number; spend: number; budget: number; budgetRemaining: number; blendedCpi: number; committed: number;
  };
}

function Recruitment({ surveyId }: { surveyId: string }) {
  const [data, setData] = React.useState<RecruitmentData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ completes: "", budget: "", loi: "15", ir: "30", country: "US", strategy: "balanced" });

  const load = React.useCallback(async () => {
    const r = await fetch(`/api/surveys/${surveyId}/recruitment`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setError(j.error ?? "Could not load recruitment"); return; }
    setError(null); setData(j);
    if (j.project) {
      setForm((f) => ({
        ...f,
        completes: String(j.project.required_completes ?? ""),
        budget: String(j.project.budget_amount ?? ""),
        loi: String(j.project.loi_minutes ?? 15),
        ir: String(j.project.expected_ir ?? 30),
        strategy: String(j.project.strategy ?? "balanced"),
      }));
    }
  }, [surveyId]);
  React.useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    const r = await fetch(`/api/surveys/${surveyId}/recruitment`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setError(j.error ?? "Could not save"); return null; }
    setError(null); await load(); return j;
  }

  if (!data) return <p className="muted">{error ?? "Loading…"}</p>;
  const t = data.totals;
  const ccy = String((data.project?.budget_currency as string) ?? "USD");
  const status = String((data.project?.status as string) ?? "none");

  return (
    <div className="sec">
      {error && <p className="chip warn">{error}</p>}

      <div className="card">
        <div className="row">
          <label className="f"><span className="muted">Completes needed</span>
            <input className="input mono" value={form.completes} onChange={(e) => setForm({ ...form, completes: e.target.value })} placeholder="5000" /></label>
          <label className="f"><span className="muted">Budget</span>
            <input className="input mono" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="40000" /></label>
          <label className="f"><span className="muted">LOI (min)</span>
            <input className="input mono" value={form.loi} onChange={(e) => setForm({ ...form, loi: e.target.value })} /></label>
          <label className="f"><span className="muted">Expected IR (%)</span>
            <input className="input mono" value={form.ir} onChange={(e) => setForm({ ...form, ir: e.target.value })} /></label>
          <label className="f"><span className="muted">Market</span>
            <input className="input mono" value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} /></label>
          <button className="btn primary small" disabled={busy || !form.completes || !form.budget} onClick={() => void post({
            action: "project", requiredCompletes: Number(form.completes), budget: Number(form.budget),
            loiMinutes: Number(form.loi), expectedIr: Number(form.ir), strategy: form.strategy,
            audience: { demographics: { countries: [form.country] } },
          })}>{data.project ? "Update" : "Create"} recruitment project</button>
          {data.project && <button className="btn small" disabled={busy} onClick={() => void post({ action: "compare" })}>Compare vendors</button>}
        </div>
        {data.project && <p className="muted">Status: <span className="mono">{status}</span></p>}
      </div>

      {data.project && (
        <div className="card">
          <div className="row">
            <span className="muted">Required <strong>{int(t.required)}</strong></span>
            <span className="muted">Accepted <strong>{int(t.accepted)}</strong></span>
            <span className="muted">Remaining <strong>{int(t.remaining)}</strong></span>
            <span className="muted">Rejected <strong>{int(t.rejected)}</strong></span>
            <span className="muted">Duplicate attempts <strong>{int(t.duplicates)}</strong></span>
          </div>
          <div className="row">
            <span className="muted">Spent <strong>{money(t.spend, ccy)}</strong> of {money(t.budget, ccy)}</span>
            <span className="muted">Committed <strong>{money(t.committed, ccy)}</strong></span>
            <span className="muted">Blended CPI <strong>{t.blendedCpi > 0 ? money(t.blendedCpi, ccy) : "—"}</strong></span>
          </div>
          {t.accepted === 0 && t.delivered === 0 && (
            <p className="muted">Nothing has been delivered yet. These are counts, not forecasts: they move when a vendor&rsquo;s progress is entered.</p>
          )}
        </div>
      )}

      <div className="card">
        <div className="row">
          <strong className="grow">Vendor comparison</strong>
          <span className="muted">Ranked by cost per valid accepted complete · {SOURCE_LABEL[data.comparison.source]}</span>
        </div>
        <p className="muted">
          The quoted CPI is not the cost. A vendor whose completes are rejected or duplicated costs more per
          complete that counts, and this table ranks on that figure.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>Vendor</th><th>CPI</th><th>Rejected</th><th>Duplicate</th>
              <th>Cost / valid complete</th><th>Valid of {int(t.required)}</th><th>Projected</th><th>Source</th>
            </tr>
          </thead>
          <tbody>
            {data.comparison.rows.map((r) => (
              <tr key={r.integrationId}>
                <td>
                  {r.vendorName}
                  {r.caveat && <div className="muted">{r.caveat}</div>}
                </td>
                <td className="mono">{money(r.cpi, r.currency)}</td>
                <td className="mono">{pct(r.expectedRejectionRate)}</td>
                <td className="mono">{pct(r.expectedDuplicateRate)}</td>
                <td className="mono"><strong>{r.rankable ? money(r.costPerValidComplete, r.currency) : "—"}</strong></td>
                <td className="mono">{int(r.expectedValidCompletes)}</td>
                <td className="mono">{money(r.projectedCost, r.currency)}</td>
                <td className="muted">{SOURCE_LABEL[r.source]}{r.qualityConfidence !== "high" && r.rankable ? ` · ${r.qualityConfidence} confidence` : ""}</td>
              </tr>
            ))}
            {data.comparison.rows.length === 0 && (
              <tr><td colSpan={8} className="muted">No vendors are configured yet. Add one in the marketplace.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data.orders.length > 0 && (
        <div className="card">
          <strong>Orders</strong>
          <table className="grid">
            <thead><tr><th>Vendor</th><th>Ordered</th><th>Delivered</th><th>Accepted</th><th>Spend</th><th>Status</th></tr></thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={String(o.id)}>
                  <td>{String(o.vendorName ?? "—")}</td>
                  <td className="mono">{int(Number(o.ordered_completes))}</td>
                  <td className="mono">{int(Number(o.delivered_completes))}</td>
                  <td className="mono">{int(Number(o.accepted_completes))}</td>
                  <td className="mono">{money(Number(o.spend_amount), String(o.currency ?? ccy))}</td>
                  <td className="muted mono">{String(o.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Phase 1 contacts no vendor. Place the order in the vendor&rsquo;s own portal, then enter what they
            deliver here — the same figures a live webhook will write once adapters exist.
          </p>
        </div>
      )}
    </div>
  );
}
