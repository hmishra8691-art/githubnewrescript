"use client";
import React from "react";
import { useStudio } from "./store";
import { fmtMoney, fmtWhen, LevelBanner, LEVEL_CLASS, LEVEL_WORD, Progress, PRESET_AMOUNTS, Stat, STATE_WORD, UsageBars, UsageTable, type UsageRow } from "@/components/billing/shared";
import { ProjectBudgetDialog } from "@/components/dashboard/ProjectBudgetDialog";

/**
 * USAGE / METER — the project's wallet and everything it has paid for
 * (billing brief §10–§14, §18).
 *
 * The screen is a reader: every number comes from `/api/surveys/[id]/billing`
 * and is computed once, server-side, from the immutable usage ledger. The
 * only thing a researcher can DO here is ask for more credits; assigning
 * them is the administrator's act, on their own screen.
 *
 * Terminology: "wallet balance", "usage credits", "project balance" — never
 * tokens, except where a row is literally counting model tokens.
 */

export interface MeterView {
  ok: boolean; sandbox: boolean;
  /** "user": charges, balance and usage only; "admin": every cost component as well (change 2) */
  audience: "user" | "admin";
  wallet: { id: string; currency: string; state: "active" | "read_only" | "suspended"; sharedWalletId: string | null; overdraftEnabled: boolean };
  summary: {
    currency: string; initialBalance: number; totalAdded: number; used: number; remaining: number; reserved: number; available: number; level: string; state: string; usedPct: number;
    /** administrator only */
    costs?: { providerCost: number; infraCost: number; paymentFee: number; taxReserve: number; grossProfit: number; netProfit: number; marginPct: number };
    usage: { today: number; thisWeek: number; thisMonth: number; allTime: number }; events: number;
  };
  level: string; message: string;
  thresholds: { low: number; critical: number; readOnly: number; minimumRemaining: number };
  policy: { testUsage: string; testDiscountPct: number; allowExportsWhenReadOnly: boolean; lockRespondentsWhenReadOnly: boolean };
  categories: { category: string; label: string; charge: number; actualCost?: number; events: number; quantity: number }[];
  byEnvironment: { TEST: { charge: number; events: number; actualCost?: number }; LIVE: { charge: number; events: number; actualCost?: number } };
  timeline: { day: string; charge: number; actualCost?: number; events: number }[];
  recent: UsageRow[];
  forecast: { windowDays: number; averageDailyUsage: number; estimatedRemainingDays: number | null; trendPct: number | null; currentWindowUsage: number; previousWindowUsage: number };
  ledger: { id: string; kind: string; amount: number; balanceAfter: number; reason: string; note: string | null; createdAt: string; transferId?: string | null }[];
  requests: { id: string; requestedAmount: number; reason: string; status: string; createdAt: string; decidedAmount: number | null; adminNote: string | null }[];
  canRequest?: boolean;
  /** whether this viewer may change the project's spending limit (the owner) */
  canBudget?: boolean;
  /**
   * What THIS project has spent and may spend. Separate from `wallet` on
   * purpose: the wallet belongs to the owner and funds every project they
   * own, while these are this study's own figures.
   */
  project?: {
    currency: string; used: number; limit: number | null; mode: "shared" | "budget" | "priority";
    allowance: number; walletRemaining: number; reserved: number; usedPct: number;
    level: string; state: "active" | "frozen" | "read_only" | "suspended";
  } | null;
}

/*
 * One fetch per Studio load, shared by the header badge, the read-only bar
 * and the panel: the three readers of the same endpoint share a short-lived
 * cache and a change counter, so "refresh" on the panel updates the badge too.
 */
const viewCache = new Map<string, { at: number; p: Promise<{ status: number; json: MeterView & { error?: string; code?: string } }> }>();
const listeners = new Set<() => void>();
function fetchView(surveyId: string, force = false) {
  const hit = viewCache.get(surveyId);
  if (!force && hit && Date.now() - hit.at < 5000) return hit.p;
  const p = fetch(`/api/surveys/${surveyId}/billing`, { cache: "no-store" }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) as MeterView & { error?: string; code?: string } }));
  viewCache.set(surveyId, { at: Date.now(), p });
  return p;
}
export function useMeterView(surveyId: string) {
  const [view, setView] = React.useState<MeterView | null>(null);
  const [error, setError] = React.useState<{ text: string; code?: string } | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  React.useEffect(() => {
    let alive = true;
    fetchView(surveyId).then(({ status, json }) => {
      if (!alive) return;
      if (status >= 400) { setError({ text: json.error ?? `Usage could not be read (${status})`, code: json.code }); setView(null); return; }
      setError(null); setView(json);
    }).catch(() => { if (alive) setError({ text: "Could not reach the Studio." }); });
    return () => { alive = false; };
  }, [surveyId, tick]);
  return { view, error, reload: () => { void fetchView(surveyId, true); listeners.forEach((l) => l()); } };
}

const LEDGER_WORDS: Record<string, string> = { debit: "Usage", credit: "Credits added", adjustment: "Adjustment", reversal: "Usage reversed", expiry: "Credits expired", transfer_out: "Credit Transfer Out", transfer_in: "Credit Transfer In", transfer_reversal: "Credit Transfer Reversal" };

export function UsagePanel() {
  const s = useStudio();
  const { view, error, reload } = useMeterView(s.surveyDbId);
  const [requesting, setRequesting] = React.useState(false);
  const [amount, setAmount] = React.useState<number>(100);
  const [reason, setReason] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [budget, setBudget] = React.useState(false);
  const canBudget = !!view?.canBudget;

  const submitRequest = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/billing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request_credits", amount, reason, message }) });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) { setNote({ text: j.error ?? `The request could not be sent (${r.status})`, ok: false }); return; }
      setNote({ text: `Request for ${fmtMoney(amount, view?.wallet.currency)} sent to your administrator.`, ok: true });
      setRequesting(false); setReason(""); setMessage(""); reload();
    } catch { setNote({ text: "Could not reach the Studio.", ok: false }); }
    finally { setBusy(false); }
  };

  const head = (
    <div className="row" style={{ marginBottom: 10 }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Usage &amp; Wallet</h2>
      <span className="grow" />
      <button className="btn small" onClick={reload} data-testid="usage-reload">↻ refresh</button>
    </div>
  );

  if (error) {
    return (
      <div className="bl-panel">
        {head}
        <div className={`alert ${error.code === "billing_unavailable" ? "info" : "warning"}`} data-testid="usage-error">{error.text}</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>Every billable operation on this project — AI, translation, completed interviews, uploads — is metered against the project&apos;s wallet and shown here.</p>
      </div>
    );
  }
  if (!view) return <div className="bl-panel">{head}<p className="muted" style={{ fontSize: 13 }}>Reading usage…</p></div>;

  const cur = view.wallet.currency;
  const sm = view.summary;
  const total = Math.max(sm.totalAdded, sm.used + Math.max(0, sm.remaining));
  const canRequest = view.sandbox || view.canRequest !== false;

  return (
    <div className="bl-panel" data-testid="usage-panel" data-level={view.level} data-state={view.wallet.state}>
      {head}
      <LevelBanner level={view.level} message={view.message} state={view.wallet.state} />
      {view.project?.state === "frozen" && (
        <div className="alert warning" data-testid="project-frozen-banner">
          This project has reached its own spending limit of {fmtMoney(view.project.limit ?? 0, cur)}. The wallet still holds
          {" "}{fmtMoney(view.project.walletRemaining, cur)} for other projects — raise the limit to continue.
        </div>
      )}
      {budget && view.project && (
        <ProjectBudgetDialog
          project={{ id: s.surveyDbId, title: s.def.meta.title, code: s.def.meta.code }}
          meter={{ mode: view.project.mode, limit: view.project.limit, used: view.project.used, currency: cur, walletRemaining: view.project.walletRemaining, state: view.project.state }}
          onClose={() => setBudget(false)}
          onSaved={() => reload()}
        />
      )}

      {/* ---------------------------------------------------------------- wallet */}
      <div className="bl-grid2" style={{ marginTop: 10 }}>
        <div className="card bl-card" data-testid="wallet-card">
          {/*
            * THE WALLET THIS PROJECT DRAWS ON — the owner's, shared with
            * every project they own. It is titled as what it is, because
            * "Project wallet" on a balance that five studies are spending
            * would be the old model's words on the new model's number.
            */}
          <div className="card-title">Wallet <span className={`badge ${LEVEL_CLASS[view.level]}`} data-testid="wallet-level">{view.wallet.state === "suspended" ? "Suspended" : LEVEL_WORD[view.level]}</span></div>
          <div className="bl-remaining" data-testid="wallet-remaining">{fmtMoney(sm.remaining, cur)} <span className="muted">remaining</span></div>
          <Progress used={sm.used} total={total} level={view.level} />
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }} data-testid="wallet-progress-text">{fmtMoney(sm.used, cur)} / {fmtMoney(total, cur)} used{sm.reserved > 0 && <> · {fmtMoney(sm.reserved, cur)} reserved for operations in progress</>}</div>
          <table className="bl-kv" style={{ marginTop: 12 }}>
            <tbody>
              <tr><td>Initial balance</td><td data-testid="wallet-initial">{fmtMoney(sm.initialBalance, cur)}</td></tr>
              <tr><td>Total added</td><td data-testid="wallet-added">{fmtMoney(sm.totalAdded, cur)}</td></tr>
              <tr><td>Used</td><td data-testid="wallet-used">{fmtMoney(sm.used, cur)}</td></tr>
              <tr><td><strong>Remaining</strong></td><td><strong>{fmtMoney(sm.remaining, cur)}</strong></td></tr>
            </tbody>
          </table>
          <div className="bl-stats" style={{ marginTop: 10 }}>
            <Stat label="Usage" value={`${sm.usedPct}%`} testid="wallet-used-pct" />
            <Stat label="Status" value={view.wallet.state === "read_only" ? "READ-ONLY" : view.wallet.state.toUpperCase()} testid="wallet-status" />
          </div>
          {view.audience === "admin" && sm.costs && (
            <details style={{ marginTop: 10 }} data-testid="wallet-costs-admin">
              <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>Cost breakdown (administrators only)</summary>
              <table className="bl-kv" style={{ marginTop: 6 }} data-testid="wallet-costs">
                <tbody>
                  <tr><td>Actual provider cost</td><td>{fmtMoney(sm.costs.providerCost, cur)}</td></tr>
                  <tr><td>Infrastructure cost</td><td>{fmtMoney(sm.costs.infraCost, cur)}</td></tr>
                  <tr><td>Payment / fees</td><td>{fmtMoney(sm.costs.paymentFee, cur)}</td></tr>
                  <tr><td>Tax / reserve</td><td>{fmtMoney(sm.costs.taxReserve, cur)}</td></tr>
                  <tr><td>Platform gross profit</td><td>{fmtMoney(sm.costs.grossProfit, cur)}</td></tr>
                  <tr><td>Net profit</td><td>{fmtMoney(sm.costs.netProfit, cur)} ({sm.costs.marginPct}%)</td></tr>
                </tbody>
              </table>
            </details>
          )}
        </div>

        {/* ------------------------------------------------ this project's own rule */}
        <div className="card bl-card" data-testid="project-spending" data-mode={view.project?.mode ?? "shared"} data-state={view.project?.state ?? "active"}>
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <div className="card-title" style={{ margin: 0 }}>This project</div>
            {view.project?.state === "frozen" && <span className="badge warning" data-testid="project-frozen">At its limit</span>}
            {view.project?.mode === "priority" && <span className="chip">Priority</span>}
            <span className="grow" />
            {canBudget && (
              <button className="btn small" data-testid="project-set-limit" onClick={() => setBudget(true)}>
                {view.project?.state === "frozen" ? "Raise limit" : "Set limit"}
              </button>
            )}
          </div>
          <div className="bl-remaining" data-testid="project-spent">{fmtMoney(view.project?.used ?? 0, cur)} <span className="muted">spent by this project</span></div>
          <table className="bl-kv">
            <tbody>
              <tr>
                <td>Spending limit</td>
                <td data-testid="project-limit">{view.project?.limit == null ? "No limit of its own" : fmtMoney(view.project.limit, cur)}</td>
              </tr>
              <tr>
                <td>{view.project?.limit == null ? "Wallet available" : "Left of the limit"}</td>
                <td data-testid="project-allowance">{fmtMoney(view.project?.allowance ?? 0, cur)}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {view.project?.limit == null
              ? "This project spends from the wallet above with no limit of its own. Setting a limit moves no money — it caps how much of the wallet this project may use."
              : "A limit caps how much of the wallet this project may use. It moves no money, and raising it above what has been spent starts a stopped project again."}
          </p>
        </div>

        <div className="card bl-card">
          <div className="card-title">Usage</div>
          <div className="bl-stats">
            <Stat label="Today" value={fmtMoney(sm.usage.today, cur)} testid="usage-today" />
            <Stat label="This week" value={fmtMoney(sm.usage.thisWeek, cur)} testid="usage-week" />
            <Stat label="This month" value={fmtMoney(sm.usage.thisMonth, cur)} testid="usage-month" />
            <Stat label="Projected remaining" value={view.forecast.estimatedRemainingDays == null ? "—" : `~${view.forecast.estimatedRemainingDays} days`} sub={view.forecast.averageDailyUsage > 0 ? `${fmtMoney(view.forecast.averageDailyUsage, cur)} / day over ${view.forecast.windowDays} days` : "no recent usage to project from"} testid="usage-forecast" />
          </div>
          {view.forecast.trendPct != null && (
            <p className={`muted`} style={{ fontSize: 12.5, marginTop: 8 }} data-testid="usage-trend">
              Usage {view.forecast.trendPct >= 0 ? "increased" : "decreased"} {Math.abs(view.forecast.trendPct)}% compared with the previous {view.forecast.windowDays} days.
            </p>
          )}
          <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
            <span className="chip" data-testid="usage-live">LIVE {fmtMoney(view.byEnvironment.LIVE.charge, cur)} · {view.byEnvironment.LIVE.events} events</span>
            <span className="chip" data-testid="usage-test">TEST {fmtMoney(view.byEnvironment.TEST.charge, cur)} · {view.byEnvironment.TEST.events} events · {view.policy.testUsage === "free" ? "free" : view.policy.testUsage === "discounted" ? `${view.policy.testDiscountPct}% off` : "metered"}</span>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Warnings at {fmtMoney(view.thresholds.low, cur)} (low) and {fmtMoney(view.thresholds.critical, cur)} (critical); read-only at {fmtMoney(view.thresholds.readOnly, cur)}.{view.policy.lockRespondentsWhenReadOnly ? " New live interviews stop when the project is read-only." : ""}</p>
        </div>
      </div>

      {/* ---------------------------------------------------------------- categories + timeline */}
      <div className="bl-grid2" style={{ marginTop: 12 }}>
        <div className="card bl-card">
          <div className="card-title">Usage by category</div>
          {view.categories.length ? (
            <table className="bl-kv" data-testid="usage-categories">
              <tbody>
                {view.categories.map((c) => (
                  <tr key={c.category} data-category={c.category}>
                    <td>{c.label}<span className="muted"> · {c.events}</span></td>
                    <td>{fmtMoney(c.charge, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted" style={{ fontSize: 13 }}>Nothing metered yet.</p>}
        </div>
        <div className="card bl-card">
          <div className="card-title">Usage over time <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>last 30 days</span></div>
          <UsageBars points={view.timeline} currency={cur} />
        </div>
      </div>

      {/* ---------------------------------------------------------------- credits */}
      <div className="card bl-card" style={{ marginTop: 12 }} data-testid="credits-card">
        <div className="row">
          <div className="card-title">Credits</div>
          <span className="grow" />
          {canRequest && !requesting && <button className="btn small primary" onClick={() => setRequesting(true)} data-testid="request-credits">Request additional credits</button>}
        </div>
        {note && <div className={`alert ${note.ok ? "success" : "error"}`} style={{ marginTop: 8 }} data-testid="request-note">{note.text}</div>}
        {requesting && (
          <div className="bl-form" style={{ marginTop: 10 }} data-testid="request-form">
            <label className="flabel">Requested amount ({cur})</label>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {PRESET_AMOUNTS.map((a) => <button key={a} className={`btn small ${amount === a ? "primary" : ""}`} onClick={() => setAmount(a)} data-testid={`request-preset-${a}`}>{fmtMoney(a, cur)}</button>)}
              <input className="input small" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 0))} style={{ width: 120 }} data-testid="request-amount" />
            </div>
            <label className="flabel">Reason</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Fieldwork extended by two weeks" data-testid="request-reason" />
            <label className="flabel">Message to your administrator (optional)</label>
            <textarea className="ta" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} data-testid="request-message" />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={busy || !reason.trim() || amount <= 0} onClick={submitRequest} data-testid="request-submit">{busy ? "Sending…" : "Send request"}</button>
              <button className="btn" onClick={() => setRequesting(false)}>Cancel</button>
            </div>
          </div>
        )}
        {view.requests.length > 0 && (
          <table className="grid bl-table" style={{ marginTop: 10 }} data-testid="request-list">
            <thead><tr><th>Requested</th><th>Amount</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>
              {view.requests.map((r) => (
                <tr key={r.id} data-testid="request-row" data-status={r.status}>
                  <td className="muted">{fmtWhen(r.createdAt)}</td>
                  <td>{fmtMoney(r.requestedAmount, cur)}{r.decidedAmount != null && r.decidedAmount !== r.requestedAmount ? <span className="muted"> → {fmtMoney(r.decidedAmount, cur)}</span> : null}</td>
                  <td>{r.reason}</td>
                  <td><span className={`badge ${r.status === "approved" ? "success" : r.status === "rejected" ? "error" : "warning"}`}>{r.status}</span>{r.adminNote && <span className="muted"> · {r.adminNote}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view.ledger.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>Wallet history ({view.ledger.length})</summary>
            <table className="grid bl-table" style={{ marginTop: 6 }} data-testid="ledger">
              <thead><tr><th>When</th><th>Entry</th><th>Amount</th><th>Balance after</th></tr></thead>
              <tbody>
                {view.ledger.map((l) => (
                  <tr key={l.id} data-kind={l.kind}>
                    <td className="muted">{fmtWhen(l.createdAt)}</td>
                    <td>{LEDGER_WORDS[l.kind] ?? l.kind}{l.note ? <span className="muted"> · {l.note}</span> : l.kind !== "debit" && l.reason ? <span className="muted"> · {l.reason.replace(/_/g, " ")}</span> : null}</td>
                    <td className={l.amount < 0 ? "" : "bl-pos"}>{l.amount < 0 ? "−" : "+"}{fmtMoney(Math.abs(l.amount), cur)}</td>
                    <td>{fmtMoney(l.balanceAfter, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      {/* ---------------------------------------------------------------- recent usage */}
      <div className="card bl-card" style={{ marginTop: 12 }}>
        <div className="card-title">Recent usage <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{sm.events} events · state {STATE_WORD[view.wallet.state]}</span></div>
        <UsageTable rows={view.recent} currency={cur} showCost={view.audience === "admin"} />
      </div>
    </div>
  );
}
