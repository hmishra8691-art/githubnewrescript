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
 *     "Feasibility" reads as "we can ask them", and until a call has actually succeeded nobody knows that;
 *   - every price carries where it came from, and "Live quotation" is a provenance this build cannot produce,
 *     so the rate-card form does not offer it;
 *   - API mode is offered only for a vendor this build has an adapter for, and shown DISABLED WITH THE REASON
 *     for the rest. Hiding it would be tidier and would leave a reader thinking the platform simply has not got
 *     round to Dynata, rather than that nothing here can call Dynata;
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
  integration: { id: string; mode: Mode; health: string; markupBps: number; currency: string; notes: string | null; enabled: boolean; hasCredentials?: boolean } | null;
  mode: Mode; summary: string; capabilities: Record<string, CapState>;
  hasLiveAdapter?: boolean; hasCredentials?: boolean;
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
  /*
   * Recruitment first. The marketplace is the administrator's view of the supply chain, and for everybody else
   * it does not exist — the tab is absent rather than disabled, because a disabled tab labelled "Vendor
   * marketplace" discloses that there are vendors and that somebody else manages them.
   */
  const [view, setView] = React.useState<"marketplace" | "recruitment">("recruitment");
  const [canSeeVendors, setCanSeeVendors] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await fetch("/api/recruitment/vendors", { cache: "no-store" });
      /* a 403 is the answer, not an error: this account is not a platform administrator */
      if (alive) setCanSeeVendors(r.ok);
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="sec">
      {canSeeVendors && (
        <div className="row">
          <button className={`btn small${view === "recruitment" ? " primary" : ""}`} onClick={() => setView("recruitment")}>Smart recruitment</button>
          <button className={`btn small${view === "marketplace" ? " primary" : ""}`} onClick={() => setView("marketplace")}>Recruitment partners</button>
          <span className="muted" style={{ fontSize: 12.5 }}>Partners are visible to platform administrators only</span>
        </div>
      )}
      {canSeeVendors && view === "marketplace" ? <Marketplace /> : <Recruitment surveyId={s.surveyDbId} />}
    </div>
  );
}

/* ------------------------------------------------------------ the marketplace */

function Marketplace() {
  const [data, setData] = React.useState<{ vendors: VendorView[]; liveAdaptersAvailable: boolean; liveAdapterVendors?: string[] } | null>(null);
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
      {!data.liveAdaptersAvailable ? (
        <p className="chip warn">
          No live vendor adapter exists yet. Every relationship below is manual: an operator enters feasibility,
          prices and orders, and reconciles against the vendor&rsquo;s own invoice. Live API integrations arrive
          once the vendor contracts are in place.
        </p>
      ) : (
        <p className="chip">
          {(data.liveAdapterVendors ?? []).join(", ")} can be set to API mode, which needs an API token and
          calls the vendor directly. Every other relationship here is manual: an operator enters feasibility,
          prices and orders, and reconciles against the vendor&rsquo;s own invoice. No integration is shown as
          verified until a call to that vendor has actually succeeded.
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
  /* never pre-filled from the server: a sealed token is not readable, and an empty box keeps the one already stored */
  const [token, setToken] = React.useState("");

  return (
    <div className="sec">
      <div className="row">
        <label className="f">
          <span className="muted">Relationship</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {(["manual", "redirect_only", "awaiting", "inactive"] as Mode[]).map((m) => (
              <option key={m} value={m}>{MODE_LABEL[m]}</option>
            ))}
            {/*
              * Offered only where this build has an adapter for THIS vendor. Shown-but-disabled elsewhere, with
              * the reason: hiding it would read as "the platform has not got round to Dynata" rather than
              * "nothing here can call Dynata".
              */}
            <option value="api" disabled={!vendor.hasLiveAdapter}>
              {vendor.hasLiveAdapter ? "API — calls the vendor directly" : "API — no adapter for this vendor yet"}
            </option>
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
          ...(mode === "api" && token.trim() ? { token: token.trim() } : {}),
        })}>Save</button>
      </div>

      {mode === "api" && (
        <div className="row">
          <label className="f grow">
            <span className="muted">
              API token{vendor.integration?.hasCredentials ? " — one is already stored; leave blank to keep it" : ""}
            </span>
            <input
              className="input mono" type="password" autoComplete="off" value={token}
              placeholder={vendor.integration?.hasCredentials ? "•••• stored" : "paste the vendor's API token"}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <p className="muted" style={{ fontSize: 12.5, maxWidth: 460 }}>
            Sealed with your organisation&rsquo;s key and never shown again — only a masked hint. Saving in API
            mode does not mark anything verified: that happens when a call to the vendor actually succeeds.
          </p>
        </div>
      )}

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

interface MarketRow { id?: string; market: string; required_completes: number; expected_ir: number | null; loi_minutes: number | null }

interface BudgetView {
  budget: number; committed: number; spent: number; headroom: number; unspent: number;
  committedBps: number; spentBps: number; actualCostPerValidComplete: number | null;
  accepted: number; remaining: number; projectedFinalCost: number | null; projectedOverrun: number | null;
  overThreshold: boolean; overCommitted: boolean; summary: string;
}

interface PlanRow {
  integrationId: string; market: string; vendorName: string; completes: number; cpi: number; currency: string;
  cost: number; expectedValidCompletes: number; costPerValidComplete: number;
  expectedDeliveryDays: number | null; source: Source; rationale: Record<string, unknown>;
}

interface PlanMarket {
  market: string; required: number; allocated: number; shortfall: number; cost: number; blendedCpi: number;
  expectedValidCompletes: number; expectedDeliveryDays: number | null;
  excluded: { integrationId: string; vendorName: string; reason: string }[];
}

interface Plan {
  strategy: string; weights: { cost: number; quality: number; speed: number };
  rows: PlanRow[]; markets: PlanMarket[]; costPressure: number;
  totalCompletes: number; totalCost: number; blendedCpi: number; expectedValidCompletes: number;
  expectedDeliveryDays: number | null; feasible: boolean; shortfall: number; notes: string[];
}

/** What every caller receives — no supply chain in it (lib/recruitment/abstraction.ts builds this). */
interface ResearcherPlanView {
  currency: string;
  requiredCompletes: number;
  markets: Array<{ market: string; required: number; planned: number; delivered: number; accepted: number; expectedDeliveryDays: number | null }>;
  price: number;
  pricePerComplete: number | null;
  feasible: boolean;
  shortfall: number;
  expectedDeliveryDays: number | null;
  capacity: "broad" | "adequate" | "limited" | "unknown";
  quality: { score: number | null; confidence: "none" | "low" | "medium" | "high" };
  notes: string[];
}

interface RecruitmentData {
  project: Record<string, unknown> | null;
  markets: MarketRow[];
  budget?: BudgetView;
  audience?: Record<string, unknown> | null;
  plan?: ResearcherPlanView;
  /*
   * OPTIONAL, and that is the point. These arrive only for platform administrators; for everybody else they
   * are absent, not empty. Typing them as required is what let the panel read `data.comparison.source` on a
   * payload that no longer carried it.
   */
  canSeeVendors?: boolean;
  comparison?: { rows: ComparisonRow[]; source: Source };
  allocations?: Record<string, unknown>[];
  orders?: Record<string, unknown>[];
  totals: {
    required: number; accepted: number; delivered: number; rejected: number; duplicates: number;
    remaining: number; budget: number;
    /* acquisition figures — present only for platform administrators */
    spend?: number; budgetRemaining?: number; blendedCpi?: number; committed?: number;
  };
}

interface PlanVerdictView {
  verdict: "achievable" | "over_budget" | "too_fast" | "short_of_capacity" | "cannot_price";
  summary: string;
  blockers: string[];
  markets: Array<{ market: string; required: number; planned: number; shortfall: number; expectedDeliveryDays: number | null; priced: boolean }>;
  expectedDeliveryDays: number | null;
  totalShortfall: number;
  price: number | null;
  pricePerComplete: number | null;
  fullPrice: number | null;
  currency: string;
}

/**
 * The feasibility answer, before anything is saved.
 *
 * The verdict leads, because it is the one thing the researcher came for. The blockers follow, each naming the
 * lever that would move it — more budget, more time, or a market nobody has priced — rather than a general
 * complaint that the plan does not work.
 */
function VerdictCard({ v }: { v: PlanVerdictView }) {
  const tone =
    v.verdict === "achievable" ? { label: "Achievable", colour: "#067647" }
    : v.verdict === "cannot_price" ? { label: "Not yet priced", colour: "#854a0e" }
    : v.verdict === "short_of_capacity" ? { label: "Not enough sample", colour: "#b42318" }
    : v.verdict === "too_fast" ? { label: "Timeline too short", colour: "#b54708" }
    : { label: "Over budget", colour: "#b54708" };

  return (
    <div className="card" data-testid="recruitment-verdict">
      <div className="row">
        <strong className="grow" style={{ color: tone.colour }}>{tone.label}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>Nothing has been saved</span>
      </div>
      <p style={{ lineHeight: 1.55, marginTop: 4 }}>{v.summary}</p>

      {v.price !== null && (
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <div><div className="muted" style={{ fontSize: 12 }}>Price</div><strong>{money(v.price, v.currency)}</strong></div>
          <div><div className="muted" style={{ fontSize: 12 }}>Per complete</div><strong>{money(v.pricePerComplete, v.currency)}</strong></div>
          {v.expectedDeliveryDays !== null && (
            <div><div className="muted" style={{ fontSize: 12 }}>Expected</div><strong>{v.expectedDeliveryDays.toFixed(0)} days</strong></div>
          )}
          {/* what the FULL sample would cost, when the plan had to be trimmed to fit */}
          {v.fullPrice !== null && v.verdict === "over_budget" && (
            <div><div className="muted" style={{ fontSize: 12 }}>Full sample</div><strong>{money(v.fullPrice, v.currency)}</strong></div>
          )}
        </div>
      )}

      {v.blockers.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
          {v.blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}

      {v.markets.length > 0 && (
        <table className="grid" style={{ marginTop: 10 }}>
          <thead><tr><th>Market</th><th>Needed</th><th>Can supply</th><th>Short</th><th>Days</th></tr></thead>
          <tbody>
            {v.markets.map((m) => (
              <tr key={m.market}>
                <td className="mono">{m.market}</td>
                <td className="mono">{int(m.required)}</td>
                <td className="mono">{m.priced ? int(m.planned) : <span className="muted">not priced</span>}</td>
                <td className="mono">{m.shortfall > 0 ? int(m.shortfall) : "—"}</td>
                <td className="mono">{m.expectedDeliveryDays === null ? "—" : m.expectedDeliveryDays.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Recruitment({ surveyId }: { surveyId: string }) {
  const [data, setData] = React.useState<RecruitmentData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /*
   * THE SIX. Completes, budget, LOI, incidence, markets and timeline — and nothing else above the fold.
   * `strategy` is gone from here: the engine balances cost, quality and speed, and asking a researcher to
   * choose between them is asking them to reason about a supply chain they cannot see.
   */
  const [form, setForm] = React.useState({
    completes: "", budget: "", loi: "15", ir: "35", timelineDays: "14",
    markets: [{ market: "US", completes: "" }] as Array<{ market: string; completes: string }>,
  });
  const [verdict, setVerdict] = React.useState<PlanVerdictView | null>(null);
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [strategy, setStrategy] = React.useState("balanced");

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
        <strong>What do you need?</strong>
        <div className="row">
          <label className="f"><span className="muted">Completes needed</span>
            <input className="input mono" value={form.completes} onChange={(e) => setForm({ ...form, completes: e.target.value })} placeholder="2000" /></label>
          <label className="f"><span className="muted">Budget</span>
            <input className="input mono" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="10000" /></label>
          <label className="f"><span className="muted">Survey length (min)</span>
            <input className="input mono" value={form.loi} onChange={(e) => setForm({ ...form, loi: e.target.value })} /></label>
          <label className="f"><span className="muted">Expected incidence (%)</span>
            <input className="input mono" value={form.ir} onChange={(e) => setForm({ ...form, ir: e.target.value })} /></label>
          <label className="f"><span className="muted">Timeline (days)</span>
            <input className="input mono" value={form.timelineDays} onChange={(e) => setForm({ ...form, timelineDays: e.target.value })} /></label>
        </div>

        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12.5, width: "100%" }}>Markets, and how many completes from each</span>
          {form.markets.map((m, i) => (
            <React.Fragment key={i}>
              <label className="f" style={{ maxWidth: 90 }}>
                <input className="input mono" value={m.market} maxLength={2} placeholder="US"
                  onChange={(e) => setForm({ ...form, markets: form.markets.map((x, j) => j === i ? { ...x, market: e.target.value.toUpperCase() } : x) })} /></label>
              <label className="f" style={{ maxWidth: 130 }}>
                <input className="input mono" value={m.completes} placeholder="completes"
                  onChange={(e) => setForm({ ...form, markets: form.markets.map((x, j) => j === i ? { ...x, completes: e.target.value } : x) })} /></label>
              {form.markets.length > 1 && (
                <button className="btn small" onClick={() => setForm({ ...form, markets: form.markets.filter((_, j) => j !== i) })}>Remove</button>
              )}
            </React.Fragment>
          ))}
          <button className="btn small" onClick={() => setForm({ ...form, markets: [...form.markets, { market: "", completes: "" }] })}>Add market</button>
        </div>

        <div className="row">
          <button
            className="btn primary small"
            disabled={busy || !form.completes || !form.budget || !form.markets.some((m) => m.market && m.completes)}
            onClick={async () => {
              const r = await post({
                action: "plan",
                requiredCompletes: Number(form.completes), budget: Number(form.budget),
                loiMinutes: Number(form.loi), expectedIr: Number(form.ir),
                timelineDays: Number(form.timelineDays),
                markets: form.markets.filter((m) => m.market && m.completes)
                  .map((m) => ({ market: m.market, completes: Number(m.completes) })),
              });
              if (r?.plan) setVerdict(r.plan as PlanVerdictView);
            }}
          >Check feasibility</button>
          <button className="btn small" disabled={busy || !form.completes || !form.budget} onClick={() => void post({
            action: "project", requiredCompletes: Number(form.completes), budget: Number(form.budget),
            loiMinutes: Number(form.loi), expectedIr: Number(form.ir),
            audience: { demographics: { countries: form.markets.map((m) => m.market).filter(Boolean) } },
          })}>{data.project ? "Update" : "Create"} project</button>
        </div>
        {data.project && <p className="muted">Status: <span className="mono">{status}</span></p>}
      </div>

      {verdict && <VerdictCard v={verdict} />}

      {data.project && <AudienceCard />}

      {data.project && (
        <MarketsCard
          markets={data.markets ?? []}
          required={t.required}
          currency={ccy}
          busy={busy}
          onSave={async (rows) => { const r = await post({ action: "markets", markets: rows }); if (r) setPlan(null); }}
        />
      )}

      {data.project && data.budget && <BudgetCard b={data.budget} ccy={ccy} />}

      {data.project && (
        <OptimiseCard
          plan={plan} strategy={strategy} setStrategy={setStrategy} busy={busy} ccy={ccy}
          onOptimise={async () => {
            setBusy(true);
            const r = await fetch(`/api/surveys/${surveyId}/recruitment`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "optimise", strategy }),
            });
            const j = await r.json();
            setBusy(false);
            if (!r.ok) { setError(j.error ?? "Could not optimise"); return; }
            setError(null); setPlan(j.plan as Plan);
          }}
          onAllocate={async (p) => {
            const rows = p.rows.map((r) => ({
              market: r.market, integration_id: r.integrationId, allocated_completes: r.completes, cpi: r.cpi,
              currency: r.currency, expected_valid_completes: r.expectedValidCompletes,
              cost_per_valid_complete: r.costPerValidComplete, expected_delivery_days: r.expectedDeliveryDays,
              rationale: r.rationale,
            }));
            const done = await post({ action: "allocate", rows });
            if (done) setPlan(null);
          }}
        />
      )}

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
            {/* acquisition figures: administrators only, and absent rather than zero for everybody else */}
            {data.canSeeVendors && t.spend !== undefined && (
              <>
                <span className="muted">Spent <strong>{money(t.spend, ccy)}</strong> of {money(t.budget, ccy)}</span>
                <span className="muted">Committed <strong>{money(t.committed ?? null, ccy)}</strong></span>
                <span className="muted">Blended CPI <strong>{(t.blendedCpi ?? 0) > 0 ? money(t.blendedCpi ?? null, ccy) : "—"}</strong></span>
              </>
            )}
          </div>
          {t.accepted === 0 && t.delivered === 0 && (
            <p className="muted">Nothing has been delivered yet. These are counts, not forecasts: they move when a vendor&rsquo;s progress is entered.</p>
          )}
        </div>
      )}

      {data.plan && (
        <div className="card">
          <div className="row">
            <strong className="grow">Recruitment plan</strong>
            <span className="muted">Rescript Recruitment Network</span>
          </div>
          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <div><div className="muted" style={{ fontSize: 12 }}>Completes required</div><strong>{int(data.plan.requiredCompletes)}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Price</div><strong>{money(data.plan.price, data.plan.currency)}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Per complete</div><strong>{money(data.plan.pricePerComplete, data.plan.currency)}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Capacity</div><strong>{data.plan.capacity}</strong></div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Quality</div>
              <strong>{data.plan.quality.score === null ? "not yet measured" : data.plan.quality.score.toFixed(0)}</strong>
            </div>
          </div>
          {!data.plan.feasible && (
            <p className="chip warn">
              This plan cannot be filled as specified{data.plan.shortfall > 0 ? ` — ${int(data.plan.shortfall)} completes short` : ""}.
            </p>
          )}
          {data.plan.markets.length > 0 && (
            <table className="grid">
              <thead><tr><th>Market</th><th>Required</th><th>Planned</th><th>Delivered</th><th>Accepted</th><th>Expected days</th></tr></thead>
              <tbody>
                {data.plan.markets.map((m) => (
                  <tr key={m.market}>
                    <td className="mono">{m.market}</td>
                    <td className="mono">{int(m.required)}</td>
                    <td className="mono">{int(m.planned)}</td>
                    <td className="mono">{int(m.delivered)}</td>
                    <td className="mono">{int(m.accepted)}</td>
                    <td className="mono">{m.expectedDeliveryDays === null ? "—" : m.expectedDeliveryDays.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.plan.notes.map((n) => <p key={n} className="muted">{n}</p>)}
        </div>
      )}

      {/*
        * SUPPLY-CHAIN BLOCKS. `comparison` and `orders` are sent only to platform administrators, so these are
        * rendered only when they arrived. Reading them unconditionally is what crashed this panel for everybody
        * else: the payload changed shape and the component did not.
        */}
      {data.canSeeVendors && data.comparison && (
      <div className="card">
        <div className="row">
          <strong className="grow">Recruitment partner comparison</strong>
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
              <tr><td colSpan={8} className="muted">No partners are configured yet. Add one under Recruitment partners.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {data.canSeeVendors && (data.orders?.length ?? 0) > 0 && (
        <div className="card">
          <strong>Orders</strong>
          <table className="grid">
            <thead><tr><th>Vendor</th><th>Ordered</th><th>Delivered</th><th>Accepted</th><th>Spend</th><th>Status</th></tr></thead>
            <tbody>
              {(data.orders ?? []).map((o) => (
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

/* ------------------------------------------------------------ Phase 2: audience, markets, budget, the optimiser */

/**
 * The audience, as a structured editor over `definition.audience`.
 *
 * It writes through the Studio's own definition store, so the change is versioned, undoable and visible in the
 * change list exactly like an edit Intelligent Mode made through `define_audience` — there is one audience and
 * one way it is stored, whichever hand typed it.
 */
/**
 * CUSTOM ELIGIBILITY. A screener is a question asked inside the survey, not a filter sent to a supplier — which
 * is the distinction that decides whether a criterion costs incidence or costs nothing.
 *
 * Every one carries its own expected incidence, because that is what turns "we need 1,000 people who bought a
 * car last year" into a number of invitations. Left blank it is unknown, and the planner says so rather than
 * assuming everybody qualifies.
 */
function ScreenersEditor() {
  const s = useStudio();
  const a = (s.def as { audience?: Record<string, unknown> } | undefined)?.audience;
  const rows = (Array.isArray(a?.screeners) ? a!.screeners : []) as Array<Record<string, unknown>>;

  const write = (next: Array<Record<string, unknown>>) => s.update((def: Record<string, unknown>) => {
    const cur = (def.audience ?? { version: 1, demographics: {}, advanced: {}, screeners: [], quotas: [] }) as Record<string, unknown>;
    def.audience = { ...cur, screeners: next };
  });

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row">
        <strong className="grow" style={{ fontSize: 13 }}>Custom eligibility</strong>
        <button className="btn small" onClick={() => write([...rows, { id: `s${Date.now()}`, text: "", qualifyingAnswers: [] }])}>Add criterion</button>
      </div>
      {!rows.length && <p className="muted" style={{ fontSize: 12.5 }}>Anything the demographic fields cannot express — asked as a question in the survey.</p>}
      {rows.map((r, i) => (
        <div className="row" key={String(r.id)}>
          <label className="f grow"><span className="muted">Question</span>
            <input className="input" defaultValue={String(r.text ?? "")} placeholder="Did you buy a car in the last 12 months?"
              onBlur={(e) => write(rows.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} /></label>
          <label className="f"><span className="muted">Qualifying answers</span>
            <input className="input" defaultValue={Array.isArray(r.qualifyingAnswers) ? (r.qualifyingAnswers as string[]).join(", ") : ""} placeholder="Yes"
              onBlur={(e) => write(rows.map((x, j) => j === i ? { ...x, qualifyingAnswers: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } : x))} /></label>
          <label className="f" style={{ maxWidth: 120 }}><span className="muted">Incidence %</span>
            <input className="input mono" defaultValue={r.expectedIncidence === undefined ? "" : String(r.expectedIncidence)} placeholder="unknown"
              onBlur={(e) => write(rows.map((x, j) => j === i ? { ...x, expectedIncidence: e.target.value ? Number(e.target.value) : undefined } : x))} /></label>
          <button className="btn small" onClick={() => write(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
    </div>
  );
}

/**
 * QUOTAS, validated as DIMENSIONS.
 *
 * "Male 50 / Female 50" and "18–34 40 / 35–54 35 / 55+ 25" are five cells summing to 250%, and they are
 * correct: they describe the same respondents along two independent dimensions. The validator groups by the
 * criterion each cell constrains, so each dimension is checked against 100 on its own — and a flat sum, which
 * would reject this, is never taken.
 */
function QuotasEditor() {
  const s = useStudio();
  const a = (s.def as { audience?: Record<string, unknown> } | undefined)?.audience;
  const rows = (Array.isArray(a?.quotas) ? a!.quotas : []) as Array<Record<string, unknown>>;
  const [criterion, setCriterion] = React.useState("gender");

  const write = (next: Array<Record<string, unknown>>) => s.update((def: Record<string, unknown>) => {
    const cur = (def.audience ?? { version: 1, demographics: {}, advanced: {}, screeners: [], quotas: [] }) as Record<string, unknown>;
    def.audience = { ...cur, quotas: next };
  });

  /* grouped the same way the engine groups them, so what is shown matches what is validated */
  const byDimension = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const keys = Object.keys((r.criteria ?? {}) as object).sort().join("+") || "*";
    byDimension.set(keys, [...(byDimension.get(keys) ?? []), r]);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row">
        <strong className="grow" style={{ fontSize: 13 }}>Quotas</strong>
        <input className="input mono" style={{ maxWidth: 140 }} value={criterion}
          onChange={(e) => setCriterion(e.target.value)} placeholder="gender" />
        <button className="btn small" disabled={!criterion.trim()} onClick={() => write([...rows, {
          id: `q${Date.now()}`, label: "", target: 0, mode: "percent", criteria: { [criterion.trim()]: "" },
        }])}>Add cell</button>
      </div>
      {!rows.length && <p className="muted" style={{ fontSize: 12.5 }}>No quotas — the sample fills in whatever composition arrives.</p>}

      {[...byDimension.entries()].map(([dim, cells]) => {
        const pct = cells.filter((c) => (c.mode ?? "percent") === "percent").reduce((t, c) => t + (Number(c.target) || 0), 0);
        const over = pct > 100.5;
        return (
          <div key={dim} style={{ marginTop: 6 }}>
            <div className="row">
              <span className="muted mono" style={{ fontSize: 12.5 }}>{dim}</span>
              <span className="muted" style={{ fontSize: 12.5, color: over ? "#b42318" : undefined }}>
                {pct.toFixed(0)}%{over ? " — cannot be filled" : pct < 99.5 ? ` · ${(100 - pct).toFixed(0)}% unconstrained` : ""}
              </span>
            </div>
            {cells.map((r) => {
              const i = rows.indexOf(r);
              const key = Object.keys((r.criteria ?? {}) as object)[0] ?? criterion;
              return (
                <div className="row" key={String(r.id)}>
                  <label className="f"><span className="muted">Label</span>
                    <input className="input" defaultValue={String(r.label ?? "")} placeholder="Male"
                      onBlur={(e) => write(rows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></label>
                  <label className="f"><span className="muted">{key}</span>
                    <input className="input" defaultValue={String(((r.criteria ?? {}) as Record<string, unknown>)[key] ?? "")} placeholder="male"
                      onBlur={(e) => write(rows.map((x, j) => j === i ? { ...x, criteria: { ...(x.criteria as object), [key]: e.target.value } } : x))} /></label>
                  <label className="f" style={{ maxWidth: 110 }}><span className="muted">Target</span>
                    <input className="input mono" defaultValue={String(r.target ?? "")}
                      onBlur={(e) => write(rows.map((x, j) => j === i ? { ...x, target: Number(e.target.value) || 0 } : x))} /></label>
                  <label className="f" style={{ maxWidth: 110 }}><span className="muted">Mode</span>
                    <select className="input" defaultValue={String(r.mode ?? "percent")}
                      onChange={(e) => write(rows.map((x, j) => j === i ? { ...x, mode: e.target.value } : x))}>
                      <option value="percent">percent</option>
                      <option value="count">completes</option>
                    </select></label>
                  <button className="btn small" onClick={() => write(rows.filter((_, j) => j !== i))}>Remove</button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AudienceCard() {
  const s = useStudio();
  const a = (s.def as { audience?: Record<string, unknown> } | undefined)?.audience;
  const d = (a?.demographics ?? {}) as Record<string, unknown>;
  const adv = (a?.advanced ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
  const [open, setOpen] = React.useState(!a);
  const [advanced, setAdvanced] = React.useState(false);

  /** What is set behind the collapsed section, so closing it does not hide that something is in there. */
  const advancedSummary = [
    ...Object.entries(adv).filter(([, v]) => Array.isArray(v) && v.length).map(([k]) => k),
    ...(Array.isArray(a?.screeners) && (a!.screeners as unknown[]).length ? ["screeners"] : []),
    ...(Array.isArray(a?.quotas) && (a!.quotas as unknown[]).length ? ["quotas"] : []),
  ].join(", ");

  const setDemo = (patch: Record<string, unknown>) => s.update((def: Record<string, unknown>) => {
    const cur = (def.audience ?? { version: 1, demographics: {}, advanced: {}, screeners: [], quotas: [] }) as Record<string, unknown>;
    def.audience = { ...cur, demographics: { ...(cur.demographics as object), ...patch } };
  });

  const setAdv = (patch: Record<string, unknown>) => s.update((def: Record<string, unknown>) => {
    const cur = (def.audience ?? { version: 1, demographics: {}, advanced: {}, screeners: [], quotas: [] }) as Record<string, unknown>;
    def.audience = { ...cur, advanced: { ...(cur.advanced as object), ...patch } };
  });

  const countries = (d.countries as string[] | undefined) ?? [];
  return (
    <div className="card">
      <div className="row">
        <strong className="grow">Audience</strong>
        <button className="btn small" onClick={() => setOpen(!open)}>{open ? "Done" : "Edit"}</button>
      </div>
      {!a && !open && <p className="muted">No audience yet. Ask the copilot — &ldquo;US adults 25 to 45 who bought a car last year&rdquo; — or edit it here.</p>}
      {a && (
        <p className="muted">
          <span className="mono">{countries.join(", ") || "no market"}</span>
          {(d.ageMin !== undefined || d.ageMax !== undefined) && <> · aged {String(d.ageMin ?? "any")}–{String(d.ageMax ?? "any")}</>}
          {Array.isArray(d.genders) && d.genders.length > 0 && <> · {(d.genders as string[]).join(", ")}</>}
          {Array.isArray(a.screeners) && (a.screeners as unknown[]).length > 0 && <> · {(a.screeners as unknown[]).length} screener(s)</>}
        </p>
      )}
      {open && (
        <>
          <div className="row">
            <label className="f"><span className="muted">Countries (ISO codes — GB, not UK)</span>
              <input className="input mono" defaultValue={list(d.countries)} placeholder="US, GB, DE"
                onBlur={(e) => setDemo({ countries: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} /></label>
            <label className="f"><span className="muted">Age from</span>
              <input className="input mono" defaultValue={String(d.ageMin ?? "")} onBlur={(e) => setDemo({ ageMin: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="f"><span className="muted">to</span>
              <input className="input mono" defaultValue={String(d.ageMax ?? "")} onBlur={(e) => setDemo({ ageMax: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="f"><span className="muted">Gender</span>
              <input className="input" defaultValue={list(d.genders)} placeholder="male, female"
                onBlur={(e) => setDemo({ genders: e.target.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) })} /></label>
          </div>

          {/*
            * ADVANCED, COLLAPSED. Everything below is optional and most projects never open it. Showing it by
            * default is how a six-field form becomes a thirty-field one, which is the problem this redesign
            * exists to undo.
            */}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small" onClick={() => setAdvanced(!advanced)}>
              {advanced ? "▾" : "▸"} Advanced targeting &amp; quotas
            </button>
            {!advanced && <span className="muted" style={{ fontSize: 12.5 }}>{advancedSummary || "optional"}</span>}
          </div>

          {advanced && (
            <>
              <div className="row">
                <label className="f"><span className="muted">Income bands</span>
                  <input className="input" defaultValue={list(d.incomeBands)} placeholder="$50–75k, $75k+"
                    onBlur={(e) => setDemo({ incomeBands: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Education</span>
                  <input className="input" defaultValue={list(d.education)} placeholder="degree, postgraduate"
                    onBlur={(e) => setDemo({ education: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Employment</span>
                  <input className="input" defaultValue={list(d.employment)} placeholder="full-time, self-employed"
                    onBlur={(e) => setDemo({ employment: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Marital status</span>
                  <input className="input" defaultValue={list(d.maritalStatus)} placeholder="married, single"
                    onBlur={(e) => setDemo({ maritalStatus: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
              </div>
              <div className="row">
                <label className="f"><span className="muted">Regions / states</span>
                  <input className="input" defaultValue={list(d.regions)} placeholder="California, Maharashtra"
                    onBlur={(e) => setDemo({ regions: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Cities</span>
                  <input className="input" defaultValue={list(d.cities)} placeholder="London, Mumbai"
                    onBlur={(e) => setDemo({ cities: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Occupation</span>
                  <input className="input" defaultValue={list(d.occupation)} placeholder="nurse, teacher"
                    onBlur={(e) => setDemo({ occupation: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
              </div>

              <p className="muted" style={{ fontSize: 12.5, marginBottom: 2 }}>Professional &amp; behavioural</p>
              <div className="row">
                <label className="f"><span className="muted">Industry</span>
                  <input className="input" defaultValue={list(adv.industries)} placeholder="healthcare, finance"
                    onBlur={(e) => setAdv({ industries: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Job title</span>
                  <input className="input" defaultValue={list(adv.jobTitles)} placeholder="CTO, procurement manager"
                    onBlur={(e) => setAdv({ jobTitles: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Seniority</span>
                  <input className="input" defaultValue={list(adv.seniority)} placeholder="director, C-level"
                    onBlur={(e) => setAdv({ seniority: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Company size</span>
                  <input className="input" defaultValue={list(adv.companySize)} placeholder="50–249, 1000+"
                    onBlur={(e) => setAdv({ companySize: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
              </div>
              <div className="row">
                <label className="f"><span className="muted">Product ownership</span>
                  <input className="input" defaultValue={list(adv.productOwnership)} placeholder="electric car, dishwasher"
                    onBlur={(e) => setAdv({ productOwnership: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Brand usage</span>
                  <input className="input" defaultValue={list(adv.brandUsage)} placeholder="brands they use"
                    onBlur={(e) => setAdv({ brandUsage: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="f"><span className="muted">Purchase behaviour</span>
                  <input className="input" defaultValue={list(adv.purchaseBehaviour)} placeholder="bought in last 6 months"
                    onBlur={(e) => setAdv({ purchaseBehaviour: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
              </div>

              <ScreenersEditor />
              <QuotasEditor />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** A completes target per country. The optimiser prices each one against that market's own rate cards. */
function MarketsCard({ markets, required, currency, onSave, busy }: {
  markets: MarketRow[]; required: number; currency: string; busy: boolean;
  onSave: (rows: { market: string; requiredCompletes: number }[]) => void;
}) {
  const [rows, setRows] = React.useState(() => markets.map((m) => ({ market: m.market, n: String(m.required_completes) })));
  React.useEffect(() => { setRows(markets.map((m) => ({ market: m.market, n: String(m.required_completes) }))); }, [markets]);
  const sum = rows.reduce((t, r) => t + (Number(r.n) || 0), 0);

  return (
    <div className="card">
      <div className="row">
        <strong className="grow">Markets</strong>
        <span className="muted">{sum.toLocaleString()} of {required.toLocaleString()} completes assigned</span>
      </div>
      {markets.length === 0 && (
        <p className="muted">
          No markets set, so the whole study is priced against one rate card. For a multi-country study, give each
          country its own target — German incidence and German CPI are not American ones.
        </p>
      )}
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <input className="input mono" value={r.market} maxLength={2} placeholder="US"
            onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, market: e.target.value.toUpperCase() } : x))} />
          <input className="input mono grow" value={r.n} placeholder="3000"
            onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, n: e.target.value } : x))} />
          <button className="btn small danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="row">
        <button className="btn small" onClick={() => setRows([...rows, { market: "", n: "" }])}>Add a market</button>
        <button className="btn primary small" disabled={busy || sum !== required}
          title={sum !== required ? `The markets must add up to ${required.toLocaleString()}` : undefined}
          onClick={() => onSave(rows.filter((r) => r.market && r.n).map((r) => ({ market: r.market, requiredCompletes: Number(r.n) })))}>
          Save markets
        </button>
        {sum !== required && rows.length > 0 && (
          <span className="chip warn">The markets must add up to the project&rsquo;s {required.toLocaleString()} completes ({currency}).</span>
        )}
      </div>
    </div>
  );
}

/** Headroom, not unspent budget — and what the project looks like it will actually cost. */
function BudgetCard({ b, ccy }: { b: BudgetView; ccy: string }) {
  return (
    <div className="card">
      <div className="row">
        <strong className="grow">Budget</strong>
        <span className="muted mono">{Math.round(b.committedBps / 100)}% committed</span>
      </div>
      <p className={b.overCommitted || (b.projectedOverrun ?? 0) > 0 ? "chip warn" : "muted"}>{b.summary}</p>
      <div className="row">
        <span className="muted">Spent <strong>{money(b.spent, ccy)}</strong></span>
        <span className="muted">Committed <strong>{money(b.committed, ccy)}</strong></span>
        <span className="muted" title="Budget minus committed — what can still be promised to a vendor">
          Headroom <strong>{money(b.headroom, ccy)}</strong>
        </span>
        {b.actualCostPerValidComplete !== null && (
          <span className="muted" title="What an accepted complete has actually cost, whatever the CPI said">
            Actual per valid complete <strong>{money(b.actualCostPerValidComplete, ccy)}</strong>
          </span>
        )}
      </div>
    </div>
  );
}

/** The optimiser: propose, read the arithmetic, then allocate. Proposing writes nothing. */
function OptimiseCard({ plan, strategy, setStrategy, onOptimise, onAllocate, busy, ccy }: {
  plan: Plan | null; strategy: string; setStrategy: (s: string) => void;
  onOptimise: () => void; onAllocate: (p: Plan) => void; busy: boolean; ccy: string;
}) {
  return (
    <div className="card">
      <div className="row">
        <strong className="grow">Allocation</strong>
        <label className="f"><span className="muted">Strategy</span>
          <select className="input" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="balanced">Balanced</option>
            <option value="lowest_cost">Lowest cost</option>
            <option value="highest_quality">Highest quality</option>
            <option value="fastest_delivery">Fastest delivery</option>
          </select></label>
        <button className="btn small" disabled={busy} onClick={onOptimise}>Optimise</button>
        {plan && <button className="btn primary small" disabled={busy || plan.rows.length === 0} onClick={() => onAllocate(plan)}>Allocate this</button>}
      </div>

      {!plan && <p className="muted">Optimise proposes a split across your vendors. It writes nothing and orders nothing.</p>}

      {plan && (
        <>
          {!plan.feasible && <p className="chip warn">This plan does not meet the project as specified — {plan.shortfall.toLocaleString()} completes short.</p>}
          {plan.notes.map((n, i) => <p className="muted" key={i}>{n}</p>)}
          {plan.costPressure > 0 && (
            <p className="muted">
              The budget bound, so cheaper vendors were preferred over better-scoring ones. Raising the budget
              would change this plan.
            </p>
          )}
          <div className="row">
            <span className="muted">{int(plan.totalCompletes)} completes</span>
            <span className="muted">{money(plan.totalCost, ccy)}</span>
            <span className="muted">blended {money(plan.blendedCpi, ccy)}</span>
            <span className="muted">{int(plan.expectedValidCompletes)} expected to count</span>
            {plan.expectedDeliveryDays !== null && <span className="muted">~{plan.expectedDeliveryDays} days</span>}
          </div>

          <table className="grid">
            <thead><tr><th>Market</th><th>Vendor</th><th>Completes</th><th>CPI</th><th>Per valid</th><th>Cost</th><th>Why</th></tr></thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={`${r.market}:${r.integrationId}`}>
                  <td className="mono">{r.market}</td>
                  <td>{r.vendorName}</td>
                  <td className="mono">{int(r.completes)}</td>
                  <td className="mono">{money(r.cpi, r.currency)}</td>
                  <td className="mono"><strong>{money(r.costPerValidComplete, r.currency)}</strong></td>
                  <td className="mono">{money(r.cost, r.currency)}</td>
                  <td className="muted">
                    {String(r.rationale.capacityUsed ?? "")}
                    {r.rationale.assumed ? <div>{String(r.rationale.assumed)}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {plan.markets.map((m) => m.excluded.length > 0 && (
            <p className="muted" key={m.market}>
              <span className="mono">{m.market}</span> left out: {m.excluded.map((e) => `${e.vendorName} (${e.reason})`).join("; ")}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
