"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { useSession } from "@/lib/useSession";
import { fmtMoney, fmtWhen, LEVEL_CLASS, LEVEL_WORD, PRESET_AMOUNTS, STATE_WORD, UsageTable, type UsageRow } from "@/components/billing/shared";

/**
 * BILLING ADMINISTRATION (billing brief §2, §8, §13, §17, §18, §22).
 *
 * Five screens behind one door, for a platform administrator:
 *
 *   Transfer credits    move unused (unreserved) balance between projects and people, with a
 *                       confirmation step; every transfer is one row + two ledger lines; history
 *                       with filters; reversal as a new transfer
 *   Wallets & credits   every project wallet — balance, state, level — assign / add /
 *                       remove credits (presets or any amount, with reason and note),
 *                       suspend / reactivate, the project's full usage with Reverse
 *   Credit requests     pending → approve (requested or a custom amount) / reject, with a note
 *   Configuration       the pricing model and every threshold, with a worked example
 *   Cost registry       provider rates: cost per unit, markup, fixed customer rate, dates
 *   Billable events     what is billable, in which unit, in which category
 *
 * Every action here is a ledger line or a configuration write on the server;
 * the screen never computes a balance.
 */

type Tab = "wallets" | "transfers" | "requests" | "config" | "rates" | "events";

interface WalletRow { id: string; surveyId: string | null; customerId: string; sharedWalletId: string | null; currency: string; project: { code: string; title: string; status: string; owner: string | null; customer: string | null } | null; balance: number; reserved: number; totalAdded: number; totalUsed: number; state: string; level: string; overdraftEnabled: boolean | null; overdraftLimit: number | null; usage: { today: number; thisWeek: number; thisMonth: number }; costs: { providerCost: number; infraCost: number; paymentFee: number; taxReserve: number; grossProfit: number; netProfit: number; marginPct: number }; events: number }
interface RequestRow { id: string; surveyId: string | null; requestedAmount: number; reason: string; message: string | null; status: string; createdAt: string; requester: string; project: { code: string; title: string } | null; decidedAmount: number | null; adminNote: string | null }
interface ConfigField { key: string; label: string; kind: "pct" | "money" | "number" | "bool" | "enum"; group: string; help: string; options?: string[] }
interface Rate { id: string; provider: string; service: string; model: string | null; side: "input" | "output" | null; unit: string; providerCost: number; unitSize: number; markupPct: number; customerRate: number | null; currency: string; effectiveFrom: string | null; effectiveUntil: string | null; active: boolean; estimated: boolean; note: string }
interface EventDef { type: string; label: string; category: string; unit: string; billable: boolean; rate: { provider: string; service: string; model?: string | null } | null; description: string; active: boolean }

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: T & { error?: string; code?: string; issues?: string[] } }> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) as T & { error?: string; code?: string; issues?: string[] } };
}

export default function BillingAdminPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const user = state.kind === "signed_in" ? state.user : null;
  const [tab, setTab] = React.useState<Tab>("wallets");
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [pending, setPending] = React.useState(0);
  const say = (text: string, ok = true) => setNote({ text, ok });
  return (
    <div className="bl-page" data-testid="billing-admin">
      <AccountHeader active="admin-billing" user={user} onSignOut={signOut} />
      <div className="alert info" style={{ marginBottom: 8 }}>Simulation mode: credits are assigned by an administrator; no payment is processed. Every assignment, adjustment and approval is a ledger entry.</div>
      <div className="bl-tabs" role="tablist">
        {(["wallets", "transfers", "requests", "config", "rates", "events"] as Tab[]).map((t) => (
          <button key={t} role="tab" className={tab === t ? "on" : ""} onClick={() => { setTab(t); setNote(null); }} data-testid={`admin-tab-${t}`}>
            {{ wallets: "Wallets & credits", transfers: "Transfer credits", requests: `Credit requests${pending ? ` (${pending})` : ""}`, config: "Configuration", rates: "Cost registry", events: "Billable events" }[t]}
          </button>
        ))}
      </div>
      {note && <div className={`alert ${note.ok ? "success" : "error"}`} style={{ marginBottom: 10 }} data-testid="admin-note">{note.text}</div>}
      {tab === "wallets" && <WalletsTab say={say} onPending={setPending} />}
      {tab === "transfers" && <TransfersTab say={say} />}
      {tab === "requests" && <RequestsTab say={say} onPending={setPending} />}
      {tab === "config" && <ConfigTab say={say} />}
      {tab === "rates" && <RatesTab say={say} />}
      {tab === "events" && <EventsTab say={say} />}
    </div>
  );
}

/* ------------------------------------------------------------------ wallets */
/** One project's spending policy, as Billing Administration lists it. */
interface SpendingRow {
  surveyId: string;
  project: { code: string; title: string; status: string; owner: string | null; customer: string | null } | null;
  mode: "shared" | "budget" | "priority";
  limit: number | null;
  spent: number;
  reserved: number;
  state: "active" | "frozen";
  frozenAt: string | null;
}

function WalletsTab({ say, onPending }: { say: (t: string, ok?: boolean) => void; onPending: (n: number) => void }) {
  const [wallets, setWallets] = React.useState<WalletRow[] | null>(null);
  const [spending, setSpending] = React.useState<SpendingRow[]>([]);
  const [limitFor, setLimitFor] = React.useState<SpendingRow | null>(null);
  const [limitValue, setLimitValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<WalletRow | null>(null);
  const [amount, setAmount] = React.useState(100);
  const [reason, setReason] = React.useState("Trial credits");
  const [cnote, setCnote] = React.useState("");
  const [expires, setExpires] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [detail, setDetail] = React.useState<{ recent: UsageRow[]; ledger: { id: string; kind: string; amount: number; balanceAfter: number; reason: string; note: string | null; createdAt: string }[] } | null>(null);
  const [ensureId, setEnsureId] = React.useState("");

  const load = React.useCallback(async () => {
    const r = await call<{ wallets: WalletRow[]; spending?: SpendingRow[]; pendingRequests: number }>("/api/admin/billing/wallets");
    if (!r.ok) { setError(r.json.error ?? `Could not read wallets (${r.status})`); return; }
    setError(null); setWallets(r.json.wallets); setSpending(r.json.spending ?? []); onPending(r.json.pendingRequests);
  }, [onPending]);

  const saveLimit = async (row: SpendingRow, mode: SpendingRow["mode"], limit: number | null) => {
    setBusy(true);
    const r = await call<{ spending: SpendingRow }>("/api/admin/billing/wallets", {
      method: "POST", body: JSON.stringify({ action: "set_spending", surveyId: row.surveyId, mode, limit }),
    });
    setBusy(false);
    if (!r.ok) { say(r.json.error ?? `The limit could not be saved (${r.status})`, false); return; }
    say(mode === "budget"
      ? `${row.project?.title ?? "That project"} may now spend up to ${fmtMoney(limit ?? 0, "USD")} of its owner's wallet.`
      : `${row.project?.title ?? "That project"} now spends ${mode === "priority" ? "as the priority project" : "freely"} from its owner's wallet.`);
    setLimitFor(null);
    await load();
  };
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (!open?.surveyId) { setDetail(null); return; }
    call<{ view: { recent: UsageRow[]; ledger: typeof detail extends null ? never : NonNullable<typeof detail>["ledger"] } | null }>(`/api/admin/billing/wallets?survey=${encodeURIComponent(open.surveyId)}`).then((r) => setDetail(r.ok && r.json.view ? { recent: r.json.view.recent, ledger: r.json.view.ledger } : null));
  }, [open?.surveyId, open?.balance]);

  const credit = async (signed: number) => {
    if (!open) return;
    setBusy(true);
    const r = await call<{ wallet: WalletRow }>("/api/admin/billing/credit", { method: "POST", body: JSON.stringify({ walletId: open.id, amount: signed, reason, note: cnote || undefined, expiresAt: expires || undefined }) });
    setBusy(false);
    if (!r.ok) { say(r.json.error ?? `Credits could not be assigned (${r.status})`, false); return; }
    say(`${signed > 0 ? "Added" : "Removed"} ${fmtMoney(Math.abs(signed), open.currency)} — balance is now ${fmtMoney(r.json.wallet.balance, open.currency)}.`);
    await load();
    setOpen((o) => (o ? { ...o, balance: r.json.wallet.balance, totalAdded: r.json.wallet.totalAdded ?? o.totalAdded, state: r.json.wallet.state } : o));
  };
  const setState = async (w: WalletRow, st: "active" | "suspended") => {
    const r = await call("/api/admin/billing/wallets", { method: "PATCH", body: JSON.stringify({ walletId: w.id, state: st }) });
    if (!r.ok) { say(r.json.error ?? "Could not change the wallet", false); return; }
    say(st === "suspended" ? "Wallet suspended — nothing billable runs on this project." : "Wallet reactivated."); await load();
  };
  const setOverdraft = async (w: WalletRow, enabled: boolean | null, limit: number | null) => {
    const r = await call("/api/admin/billing/wallets", { method: "PATCH", body: JSON.stringify({ walletId: w.id, overdraftEnabled: enabled, overdraftLimit: limit }) });
    if (!r.ok) { say(r.json.error ?? "Could not change the wallet", false); return; }
    say("Overdraft setting saved."); await load();
  };
  const reverse = async (row: UsageRow) => {
    const why = window.prompt("Why is this usage being reversed? (recorded on the ledger)");
    if (!why) return;
    const r = await call("/api/admin/billing/reverse", { method: "POST", body: JSON.stringify({ eventId: row.id, note: why }) });
    if (!r.ok) { say(r.json.error ?? "Could not reverse", false); return; }
    say(`Reversed ${fmtMoney(row.customerCharge, open?.currency)} back to the wallet.`); await load(); setOpen((o) => (o ? { ...o, balance: o.balance + row.customerCharge } : o));
  };
  const ensure = async () => {
    if (!ensureId.trim()) return;
    const r = await call<{ wallet: { id: string } }>("/api/admin/billing/wallets", { method: "POST", body: JSON.stringify({ action: "ensure", surveyId: ensureId.trim() }) });
    if (!r.ok) { say(r.json.error ?? "Could not create the wallet", false); return; }
    say("Wallet ready — assign credits to it below."); setEnsureId(""); await load();
  };

  if (error) return <div className="alert warning" data-testid="admin-wallets-error">{error}</div>;
  if (!wallets) return <p className="muted">Reading wallets…</p>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 10, gap: 8 }}>
        <input className="input small" placeholder="Project id — create a wallet before its first use" value={ensureId} onChange={(e) => setEnsureId(e.target.value)} style={{ width: 360 }} data-testid="admin-ensure-id" />
        <button className="btn small" onClick={ensure} data-testid="admin-ensure">Create wallet</button>
        <span className="grow" />
        <button className="btn small" onClick={load}>↻ refresh</button>
      </div>
      {!wallets.length && <p className="muted" data-testid="admin-wallets-empty">No wallets yet — a project&apos;s wallet is created the first time it is metered, or above.</p>}
      {wallets.length > 0 && (
        <table className="grid bl-table" data-testid="admin-wallets">
          <thead><tr><th>Project</th><th>Owner</th><th>Balance</th><th>Added</th><th>Used</th><th>This month</th><th>Margin</th><th>Level</th><th /></tr></thead>
          <tbody>
            {wallets.map((w) => (
              <tr key={w.id} data-testid="admin-wallet-row" data-survey={w.surveyId ?? ""} data-state={w.state}>
                <td>{w.project ? <>{w.project.title} <span className="muted">· {w.project.code}</span></> : <span className="muted">{w.surveyId}</span>}</td>
                <td className="muted">{w.project?.owner ?? "—"}</td>
                <td data-testid="admin-wallet-balance"><strong>{fmtMoney(w.balance, w.currency)}</strong>{w.reserved > 0 && <span className="muted"> ({fmtMoney(w.reserved, w.currency)} held)</span>}</td>
                <td>{fmtMoney(w.totalAdded, w.currency)}</td>
                <td>{fmtMoney(w.totalUsed, w.currency)}</td>
                <td>{fmtMoney(w.usage.thisMonth, w.currency)}</td>
                <td title={`gross ${fmtMoney(w.costs.grossProfit, w.currency)} · net ${fmtMoney(w.costs.netProfit, w.currency)}`}>{w.costs.marginPct}%</td>
                <td><span className={`badge ${w.state === "suspended" ? "error" : LEVEL_CLASS[w.level]}`}>{w.state === "suspended" ? "Suspended" : w.state === "read_only" ? "Read-only" : LEVEL_WORD[w.level]}</span></td>
                <td><button className="btn small primary" onClick={() => setOpen(w)} data-testid="admin-wallet-open">Credits…</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        * PROJECT SPENDING — what each study is costing, and what it is
        * allowed to cost. A project holds no balance now, so a table of
        * wallets alone cannot answer either question; the limit below moves
        * no money, it decides how much of the owner's wallet that project may
        * consume.
        */}
      {spending.length > 0 && (
        <div className="card bl-card" style={{ marginTop: 14 }} data-testid="admin-spending-card">
          <div className="card-title">Project spending</div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
            Each project spends from its owner&apos;s wallet. A limit caps how much of that wallet the project may use — it
            transfers nothing, and raising it releases a project that stopped at its own limit.
          </p>
          <table className="grid bl-table" data-testid="admin-spending">
            <thead><tr><th>Project</th><th>Owner</th><th>Spent</th><th>Limit</th><th>State</th><th /></tr></thead>
            <tbody>
              {spending.map((p) => (
                <tr key={p.surveyId} data-testid="admin-spending-row" data-survey={p.surveyId} data-state={p.state} data-mode={p.mode}>
                  <td>{p.project?.title ?? p.surveyId}{p.project?.code && <span className="muted"> · {p.project.code}</span>}</td>
                  <td className="muted">{p.project?.owner ?? "—"}</td>
                  <td data-testid="admin-spending-spent">{fmtMoney(p.spent, "USD")}</td>
                  <td data-testid="admin-spending-limit">
                    {p.limit == null ? <span className="muted">{p.mode === "priority" ? "priority · no limit" : "no limit"}</span> : fmtMoney(p.limit, "USD")}
                  </td>
                  <td>
                    <span className={`badge ${p.state === "frozen" ? "warning" : "success"}`}>{p.state === "frozen" ? "At its limit" : "Active"}</span>
                  </td>
                  <td>
                    <button className="btn small" data-testid="admin-spending-edit"
                      onClick={() => { setLimitFor(p); setLimitValue(p.limit == null ? "" : String(p.limit)); }}>
                      Limit…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {limitFor && (
            <div className="bl-form" style={{ marginTop: 12 }} data-testid="admin-limit-editor">
              <div className="card-title" style={{ fontSize: 14 }}>{limitFor.project?.title ?? limitFor.surveyId}</div>
              <label className="flabel">Spending limit ({fmtMoney(limitFor.spent, "USD")} already spent)</label>
              <input className="input" data-testid="admin-limit-amount" value={limitValue}
                onChange={(e) => setLimitValue(e.target.value)} placeholder="e.g. 100" />
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <button className="btn primary" disabled={busy || !Number.isFinite(Number(limitValue))} data-testid="admin-limit-save"
                  onClick={() => saveLimit(limitFor, "budget", Number(limitValue))}>Set limit</button>
                <button className="btn" disabled={busy} data-testid="admin-limit-none"
                  onClick={() => saveLimit(limitFor, "shared", null)}>No limit</button>
                <button className="btn" disabled={busy} data-testid="admin-limit-priority"
                  onClick={() => saveLimit(limitFor, "priority", null)}>Priority project</button>
                <button className="btn" onClick={() => setLimitFor(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="card bl-card" style={{ marginTop: 14 }} data-testid="admin-credit-panel">
          <div className="row">
            <div className="card-title">{open.project?.title ?? open.surveyId} <span className="muted" style={{ fontWeight: 400 }}>· balance {fmtMoney(open.balance, open.currency)} · {STATE_WORD[open.state]}</span></div>
            <span className="grow" />
            {open.state === "suspended" ? <button className="btn small" onClick={() => setState(open, "active")}>Reactivate</button> : <button className="btn small danger" onClick={() => setState(open, "suspended")} data-testid="admin-suspend">Suspend wallet</button>}
            <button className="btn small" onClick={() => setOpen(null)}>Close</button>
          </div>
          <div className="bl-grid2" style={{ marginTop: 10 }}>
            <div>
              <label className="flabel">Amount ({open.currency})</label>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {PRESET_AMOUNTS.map((a) => <button key={a} className={`btn small ${amount === a ? "primary" : ""}`} onClick={() => setAmount(a)} data-testid={`admin-preset-${a}`}>+{fmtMoney(a, open.currency)}</button>)}
                <input className="input small" type="number" min={0.01} step={1} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} style={{ width: 120 }} data-testid="admin-amount" />
              </div>
              <label className="flabel">Reason</label>
              <select className="select" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="admin-reason">
                {["Trial credits", "Purchase (manual)", "Credit request approved", "Goodwill", "Correction", "Project budget", "Other"].map((r) => <option key={r}>{r}</option>)}
              </select>
              <label className="flabel">Note (optional)</label>
              <input className="input" value={cnote} onChange={(e) => setCnote(e.target.value)} placeholder="Visible on the ledger" data-testid="admin-cnote" />
              <label className="flabel">Expiry (optional)</label>
              <input className="input small" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} style={{ width: 180 }} />
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <button className="btn primary" disabled={busy || amount <= 0} onClick={() => credit(amount)} data-testid="admin-add">Add {fmtMoney(amount, open.currency)}</button>
                <button className="btn danger" disabled={busy || amount <= 0} onClick={() => credit(-amount)} data-testid="admin-remove">Remove {fmtMoney(amount, open.currency)}</button>
              </div>
              <div style={{ marginTop: 14 }}>
                <label className="flabel">Overdraft for this wallet</label>
                <div className="row" style={{ gap: 8 }}>
                  <select className="select small" value={open.overdraftEnabled == null ? "default" : open.overdraftEnabled ? "on" : "off"} onChange={(e) => setOverdraft(open, e.target.value === "default" ? null : e.target.value === "on", open.overdraftLimit)} data-testid="admin-overdraft">
                    <option value="default">Platform default</option><option value="on">Allowed</option><option value="off">Not allowed</option>
                  </select>
                  <input className="input small" type="number" min={0} placeholder="limit" value={open.overdraftLimit ?? ""} onChange={(e) => setOpen({ ...open, overdraftLimit: e.target.value === "" ? null : Number(e.target.value) })} onBlur={() => setOverdraft(open, open.overdraftEnabled, open.overdraftLimit)} style={{ width: 110 }} />
                </div>
              </div>
            </div>
            <div>
              <table className="bl-kv">
                <tbody>
                  <tr><td>Total added</td><td>{fmtMoney(open.totalAdded, open.currency)}</td></tr>
                  <tr><td>Total used</td><td>{fmtMoney(open.totalUsed, open.currency)}</td></tr>
                  <tr><td>Actual provider cost</td><td>{fmtMoney(open.costs.providerCost, open.currency)}</td></tr>
                  <tr><td>Infrastructure cost</td><td>{fmtMoney(open.costs.infraCost, open.currency)}</td></tr>
                  <tr><td>Payment fees</td><td>{fmtMoney(open.costs.paymentFee, open.currency)}</td></tr>
                  <tr><td>Tax / reserve</td><td>{fmtMoney(open.costs.taxReserve, open.currency)}</td></tr>
                  <tr><td>Gross profit</td><td>{fmtMoney(open.costs.grossProfit, open.currency)}</td></tr>
                  <tr><td><strong>Net profit</strong></td><td><strong>{fmtMoney(open.costs.netProfit, open.currency)}</strong> ({open.costs.marginPct}%)</td></tr>
                </tbody>
              </table>
              {detail && detail.ledger.length > 0 && (
                <details style={{ marginTop: 10 }} open>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>Ledger ({detail.ledger.length})</summary>
                  <table className="grid bl-table" style={{ marginTop: 6 }} data-testid="admin-ledger">
                    <thead><tr><th>When</th><th>Kind</th><th>Amount</th><th>After</th><th>Reason</th></tr></thead>
                    <tbody>{detail.ledger.map((l) => <tr key={l.id} data-kind={l.kind}><td className="muted">{fmtWhen(l.createdAt)}</td><td>{l.kind}</td><td className={l.amount >= 0 ? "bl-pos" : ""}>{l.amount >= 0 ? "+" : "−"}{fmtMoney(Math.abs(l.amount), open.currency)}</td><td>{fmtMoney(l.balanceAfter, open.currency)}</td><td className="muted">{l.note ?? l.reason.replace(/_/g, " ")}</td></tr>)}</tbody>
                  </table>
                </details>
              )}
            </div>
          </div>
          {detail && (
            <div style={{ marginTop: 12 }}>
              <div className="card-title">Usage on this project</div>
              <UsageTable rows={detail.recent} currency={open.currency} showCost onReverse={reverse} testid="admin-usage-rows" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ requests */
function RequestsTab({ say, onPending }: { say: (t: string, ok?: boolean) => void; onPending: (n: number) => void }) {
  const [rows, setRows] = React.useState<RequestRow[] | null>(null);
  const [filter, setFilter] = React.useState<"pending" | "all">("pending");
  const [custom, setCustom] = React.useState<Record<string, { amount: string; note: string }>>({});
  const load = React.useCallback(async () => {
    const r = await call<{ requests: RequestRow[] }>(`/api/admin/billing/requests${filter === "pending" ? "?status=pending" : ""}`);
    if (r.ok) { setRows(r.json.requests); onPending(r.json.requests.filter((x) => x.status === "pending").length); }
    else say(r.json.error ?? "Could not read requests", false);
  }, [filter, onPending, say]);
  React.useEffect(() => { void load(); }, [load]);
  const decide = async (r: RequestRow, decision: "approve" | "reject") => {
    const c = custom[r.id] ?? { amount: "", note: "" };
    const amount = c.amount.trim() ? Number(c.amount) : undefined;
    const res = await call<{ wallet: { balance: number } | null }>("/api/admin/billing/requests", { method: "POST", body: JSON.stringify({ id: r.id, decision, amount, note: c.note || undefined }) });
    if (!res.ok) { say(res.json.error ?? "Could not decide", false); return; }
    say(decision === "approve" ? `Approved — ${fmtMoney(amount ?? r.requestedAmount)} added${res.json.wallet ? `; balance ${fmtMoney(res.json.wallet.balance)}` : ""}.` : "Request rejected.");
    await load();
  };
  if (!rows) return <p className="muted">Reading requests…</p>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <select className="select small" value={filter} onChange={(e) => setFilter(e.target.value as "pending" | "all")} data-testid="admin-requests-filter"><option value="pending">Pending</option><option value="all">All</option></select>
        <span className="grow" /><button className="btn small" onClick={load}>↻ refresh</button>
      </div>
      {!rows.length && <p className="muted" data-testid="admin-requests-empty">No {filter === "pending" ? "pending " : ""}requests.</p>}
      {rows.map((r) => (
        <div className="card bl-card" key={r.id} style={{ marginBottom: 10 }} data-testid="admin-request" data-status={r.status}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div>
              <div className="card-title">{fmtMoney(r.requestedAmount)} <span className="muted" style={{ fontWeight: 400 }}>for {r.project ? `${r.project.title} · ${r.project.code}` : r.surveyId}</span></div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{r.requester} · {fmtWhen(r.createdAt)}</div>
              <div style={{ marginTop: 6, fontSize: 13.5 }}><strong>{r.reason}</strong>{r.message && <div className="muted" style={{ marginTop: 2 }}>{r.message}</div>}</div>
              {r.status !== "pending" && <div style={{ marginTop: 6 }}><span className={`badge ${r.status === "approved" ? "success" : "error"}`}>{r.status}</span>{r.decidedAmount != null && <span className="muted"> · {fmtMoney(r.decidedAmount)}</span>}{r.adminNote && <span className="muted"> · {r.adminNote}</span>}</div>}
            </div>
            <span className="grow" />
            {r.status === "pending" && (
              <div className="bl-form" style={{ minWidth: 300 }}>
                <input className="input small" placeholder={`Custom amount (default ${fmtMoney(r.requestedAmount)})`} type="number" min={0.01} value={custom[r.id]?.amount ?? ""} onChange={(e) => setCustom({ ...custom, [r.id]: { amount: e.target.value, note: custom[r.id]?.note ?? "" } })} data-testid="admin-request-amount" />
                <input className="input small" placeholder="Note to the requester (optional)" value={custom[r.id]?.note ?? ""} onChange={(e) => setCustom({ ...custom, [r.id]: { amount: custom[r.id]?.amount ?? "", note: e.target.value } })} data-testid="admin-request-note" />
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small primary" onClick={() => decide(r, "approve")} data-testid="admin-request-approve">Approve</button>
                  <button className="btn small danger" onClick={() => decide(r, "reject")} data-testid="admin-request-reject">Reject</button>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ config */
function ConfigTab({ say }: { say: (t: string, ok?: boolean) => void }) {
  const [cfg, setCfg] = React.useState<Record<string, unknown> | null>(null);
  const [fields, setFields] = React.useState<ConfigField[]>([]);
  const [example, setExample] = React.useState<{ deposit100: { paymentFee: number; taxReserve: number; platformMargin: number; availableForCosts: number }; cost10: { customerCharge: number; paymentFee: number; grossProfit: number; netProfit: number; marginPct: number } } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    const r = await call<{ config: Record<string, unknown>; fields: ConfigField[]; example: NonNullable<typeof example> }>("/api/admin/billing/config");
    if (!r.ok) { say(r.json.error ?? "Could not read the configuration", false); return; }
    setCfg(r.json.config); setFields(r.json.fields); setExample(r.json.example);
  }, [say]);
  React.useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    const r = await call<{ config: Record<string, unknown>; example: NonNullable<typeof example> }>("/api/admin/billing/config", { method: "PUT", body: JSON.stringify({ config: cfg }) });
    setBusy(false);
    if (!r.ok) { say([r.json.error, ...(r.json.issues ?? [])].filter(Boolean).join(" · "), false); return; }
    setCfg(r.json.config); setExample(r.json.example); say("Configuration saved. New operations are priced with it immediately.");
  };
  if (!cfg) return <p className="muted">Reading configuration…</p>;
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <div className="bl-grid2">
      <div className="card bl-card" data-testid="admin-config">
        {groups.map((g) => (
          <div className="bl-config-group" key={g}>
            <h4>{g}</h4>
            {fields.filter((f) => f.group === g).map((f) => (
              <div className="bl-config-row" key={f.key}>
                <div><div style={{ fontSize: 13.5 }}>{f.label}</div><div className="bl-help">{f.help}</div></div>
                {f.kind === "bool" ? (
                  <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={!!cfg[f.key]} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.checked })} data-testid={`cfg-${f.key}`} /> {cfg[f.key] ? "On" : "Off"}</label>
                ) : f.kind === "enum" ? (
                  <select className="select small" value={String(cfg[f.key])} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} data-testid={`cfg-${f.key}`}>{(f.options ?? []).map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}</select>
                ) : (
                  <div className="row" style={{ gap: 4 }}>
                    <input className="input small" type="number" step={f.kind === "pct" ? 0.1 : f.kind === "money" ? 0.01 : 1} value={Number(cfg[f.key] ?? 0)} onChange={(e) => setCfg({ ...cfg, [f.key]: Number(e.target.value) })} data-testid={`cfg-${f.key}`} style={{ width: 120 }} />
                    <span className="muted" style={{ fontSize: 12 }}>{f.kind === "pct" ? "%" : f.kind === "money" ? String(cfg.currency ?? "USD") : ""}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={save} data-testid="cfg-save">{busy ? "Saving…" : "Save configuration"}</button>
          <button className="btn" onClick={load}>Discard changes</button>
        </div>
      </div>
      <div className="card bl-card" data-testid="admin-config-example">
        <div className="card-title">Worked example, with the saved configuration</div>
        {example && (
          <>
            <p className="muted" style={{ fontSize: 13 }}>A researcher is assigned <strong>{fmtMoney(100)}</strong>:</p>
            <table className="bl-kv"><tbody>
              <tr><td>Payment processing</td><td>{fmtMoney(example.deposit100.paymentFee)}</td></tr>
              <tr><td>Tax / reserve</td><td>{fmtMoney(example.deposit100.taxReserve)}</td></tr>
              <tr><td>Platform margin</td><td>{fmtMoney(example.deposit100.platformMargin)}</td></tr>
              <tr><td><strong>Available to cover actual costs</strong></td><td><strong>{fmtMoney(example.deposit100.availableForCosts)}</strong></td></tr>
            </tbody></table>
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>An operation whose actual provider cost is <strong>{fmtMoney(10)}</strong>:</p>
            <table className="bl-kv"><tbody>
              <tr><td>Customer charge</td><td data-testid="example-charge">{fmtMoney(example.cost10.customerCharge)}</td></tr>
              <tr><td>Actual cost</td><td>{fmtMoney(10)}</td></tr>
              <tr><td>Payment fee</td><td>{fmtMoney(example.cost10.paymentFee)}</td></tr>
              <tr><td>Gross profit</td><td>{fmtMoney(example.cost10.grossProfit)}</td></tr>
              <tr><td><strong>Net profit</strong></td><td><strong>{fmtMoney(example.cost10.netProfit)}</strong> ({example.cost10.marginPct}%)</td></tr>
            </tbody></table>
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>The charge is never &ldquo;cost plus margin&rdquo;: it is set so that the margin is the configured share of the charge after every cost is taken out of it.</p>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ rates */
const EMPTY_RATE: Rate = { id: "", provider: "", service: "", model: null, side: null, unit: "request", providerCost: 0, unitSize: 1, markupPct: 0, customerRate: null, currency: "USD", effectiveFrom: null, effectiveUntil: null, active: true, estimated: false, note: "" };
function RatesTab({ say }: { say: (t: string, ok?: boolean) => void }) {
  const [rates, setRates] = React.useState<Rate[] | null>(null);
  const [edit, setEdit] = React.useState<Rate | null>(null);
  const [units, setUnits] = React.useState<string[]>(["request", "token", "character", "word", "response", "session", "page", "question", "MB", "GB", "GB-month", "minute", "second", "file", "message", "item", "unit"]);
  const load = React.useCallback(async () => {
    const r = await call<{ rates: Rate[] }>("/api/admin/billing/rates");
    if (!r.ok) { say(r.json.error ?? "Could not read rates", false); return; }
    setRates(r.json.rates); setUnits((u) => u);
  }, [say]);
  React.useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!edit) return;
    const rate = { ...edit, id: edit.id || `${edit.provider}.${edit.service}.${edit.model ?? "*"}${edit.side ? `.${edit.side === "input" ? "in" : "out"}` : ""}`, model: edit.model || null };
    const r = await call("/api/admin/billing/rates", { method: "PUT", body: JSON.stringify({ rate }) });
    if (!r.ok) { say([r.json.error, ...(r.json.issues ?? [])].filter(Boolean).join(" · "), false); return; }
    say(`Rate ${rate.id} saved.`); setEdit(null); await load();
  };
  const remove = async (id: string) => {
    if (!window.confirm(`Remove rate ${id}? Usage that needs it will fall back to the provider's * row, or be priced at zero cost.`)) return;
    const r = await call(`/api/admin/billing/rates?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) { say(r.json.error ?? "Could not remove", false); return; }
    say("Rate removed."); await load();
  };
  if (!rates) return <p className="muted">Reading the cost registry…</p>;
  const f = (k: keyof Rate, v: unknown) => setEdit((e) => (e ? { ...e, [k]: v } : e));
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>Provider list prices per unit size (e.g. $20 per 1,000,000 characters). A <code>*</code> model is the fallback for any model without a row. Customer rate, when set, is a fixed price that bypasses the pricing model.</p>
        <span className="grow" />
        <button className="btn small primary" onClick={() => setEdit({ ...EMPTY_RATE })} data-testid="rate-new">New rate</button>
      </div>
      <table className="grid bl-table" data-testid="admin-rates">
        <thead><tr><th>Id</th><th>Provider / service / model</th><th>Unit</th><th>Provider cost</th><th>Markup</th><th>Customer rate</th><th>Effective</th><th>Active</th><th /></tr></thead>
        <tbody>
          {rates.map((r) => (
            <tr key={r.id} data-testid="rate-row" data-id={r.id}>
              <td className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{r.id}</td>
              <td>{r.provider} / {r.service} / {r.model ?? "—"}{r.side ? <span className="muted"> ({r.side})</span> : null}{r.estimated && <span className="badge neutral" style={{ marginLeft: 6 }}>estimate</span>}</td>
              <td>{r.unitSize === 1 ? r.unit : `${r.unitSize.toLocaleString()} ${r.unit}s`}</td>
              <td>{fmtMoney(r.providerCost, r.currency)}</td>
              <td>{r.markupPct}%</td>
              <td>{r.customerRate == null ? <span className="muted">model</span> : fmtMoney(r.customerRate, r.currency)}</td>
              <td className="muted">{r.effectiveFrom ?? "—"} → {r.effectiveUntil ?? "—"}</td>
              <td>{r.active ? <span className="badge success">on</span> : <span className="badge neutral">off</span>}</td>
              <td className="row" style={{ gap: 4 }}><button className="btn small" onClick={() => setEdit({ ...r })} data-testid="rate-edit">Edit</button><button className="btn small danger" onClick={() => remove(r.id)}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <div className="card bl-card" style={{ marginTop: 12 }} data-testid="rate-editor">
          <div className="card-title">{edit.id ? `Edit ${edit.id}` : "New rate"}</div>
          <div className="bl-grid2" style={{ marginTop: 8 }}>
            <div className="bl-form">
              <label className="flabel">Provider</label><input className="input small" value={edit.provider} onChange={(e) => f("provider", e.target.value)} placeholder="google · openai-compatible · deepl · supabase" data-testid="rate-provider" />
              <label className="flabel">Service</label><input className="input small" value={edit.service} onChange={(e) => f("service", e.target.value)} placeholder="translate · chat · tts · storage" data-testid="rate-service" />
              <label className="flabel">Model (blank or * = any)</label><input className="input small" value={edit.model ?? ""} onChange={(e) => f("model", e.target.value || null)} data-testid="rate-model" />
              <label className="flabel">Side (two-sided token pricing)</label>
              <select className="select small" value={edit.side ?? ""} onChange={(e) => f("side", e.target.value || null)}><option value="">single-sided</option><option value="input">input</option><option value="output">output</option></select>
            </div>
            <div className="bl-form">
              <label className="flabel">Unit</label>
              <select className="select small" value={edit.unit} onChange={(e) => f("unit", e.target.value)} data-testid="rate-unit">{units.map((u) => <option key={u}>{u}</option>)}</select>
              <label className="flabel">Provider cost per unit size</label>
              <div className="row" style={{ gap: 6 }}><input className="input small" type="number" step="0.000001" min={0} value={edit.providerCost} onChange={(e) => f("providerCost", Number(e.target.value))} data-testid="rate-cost" /><span className="muted">per</span><input className="input small" type="number" min={1} value={edit.unitSize} onChange={(e) => f("unitSize", Number(e.target.value) || 1)} data-testid="rate-unitsize" style={{ width: 130 }} /></div>
              <label className="flabel">Markup on this rate (%)</label><input className="input small" type="number" min={0} value={edit.markupPct} onChange={(e) => f("markupPct", Number(e.target.value))} />
              <label className="flabel">Fixed customer rate per unit size (blank = use the pricing model)</label><input className="input small" type="number" step="0.000001" min={0} value={edit.customerRate ?? ""} onChange={(e) => f("customerRate", e.target.value === "" ? null : Number(e.target.value))} data-testid="rate-customer" />
              <div className="row" style={{ gap: 6 }}>
                <div><label className="flabel">Effective from</label><input className="input small" type="date" value={edit.effectiveFrom ?? ""} onChange={(e) => f("effectiveFrom", e.target.value || null)} /></div>
                <div><label className="flabel">Effective until</label><input className="input small" type="date" value={edit.effectiveUntil ?? ""} onChange={(e) => f("effectiveUntil", e.target.value || null)} /></div>
              </div>
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={edit.active} onChange={(e) => f("active", e.target.checked)} /> Active</label>
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={edit.estimated} onChange={(e) => f("estimated", e.target.checked)} /> Estimate (not a vendor invoice line)</label>
              <label className="flabel">Note</label><input className="input small" value={edit.note} onChange={(e) => f("note", e.target.value)} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={save} disabled={!edit.provider || !edit.service} data-testid="rate-save">Save rate</button>
            <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ events */
function EventsTab({ say }: { say: (t: string, ok?: boolean) => void }) {
  const [events, setEvents] = React.useState<EventDef[] | null>(null);
  const load = React.useCallback(async () => {
    const r = await call<{ events: EventDef[] }>("/api/admin/billing/events");
    if (!r.ok) { say(r.json.error ?? "Could not read events", false); return; }
    setEvents(r.json.events);
  }, [say]);
  React.useEffect(() => { void load(); }, [load]);
  const save = async (e: EventDef) => {
    const r = await call("/api/admin/billing/events", { method: "PUT", body: JSON.stringify({ event: e }) });
    if (!r.ok) { say([r.json.error, ...(r.json.issues ?? [])].filter(Boolean).join(" · "), false); return; }
    say(`${e.type} saved.`); await load();
  };
  if (!events) return <p className="muted">Reading events…</p>;
  const cats = ["ai", "translation", "responses", "storage", "bandwidth", "infrastructure", "voice", "export", "processing", "other"];
  const units = ["request", "token", "character", "word", "response", "session", "page", "question", "MB", "GB", "GB-month", "minute", "second", "file", "message", "item", "unit"];
  return (
    <div>
      <p className="muted" style={{ fontSize: 13 }}>Every event the platform can meter. Switch an event off (non-billable) to keep recording it at no charge; change the unit or category to change how it appears on dashboards. New features register their own events and appear here.</p>
      <table className="grid bl-table" data-testid="admin-events">
        <thead><tr><th>Event</th><th>Category</th><th>Unit</th><th>Billable</th><th>Active</th><th /></tr></thead>
        <tbody>
          {events.map((e) => <EventRow key={e.type} e={e} cats={cats} units={units} onSave={save} />)}
        </tbody>
      </table>
    </div>
  );
}
function EventRow({ e, cats, units, onSave }: { e: EventDef; cats: string[]; units: string[]; onSave: (e: EventDef) => void }) {
  const [d, setD] = React.useState(e);
  React.useEffect(() => setD(e), [e]);
  const dirty = JSON.stringify(d) !== JSON.stringify(e);
  return (
    <tr data-testid="event-row" data-type={e.type} data-billable={String(d.billable)}>
      <td><strong>{e.label}</strong><div className="muted" style={{ fontSize: 11.5, fontFamily: "var(--mono)" }}>{e.type}</div><div className="muted" style={{ fontSize: 12 }}>{e.description}</div></td>
      <td><select className="select small" value={d.category} onChange={(ev) => setD({ ...d, category: ev.target.value })}>{cats.map((c) => <option key={c}>{c}</option>)}</select></td>
      <td><select className="select small" value={d.unit} onChange={(ev) => setD({ ...d, unit: ev.target.value })}>{units.map((u) => <option key={u}>{u}</option>)}</select></td>
      <td><label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={d.billable} onChange={(ev) => setD({ ...d, billable: ev.target.checked })} data-testid="event-billable" /> {d.billable ? "Billable" : "Non-billable"}</label></td>
      <td><label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={d.active} onChange={(ev) => setD({ ...d, active: ev.target.checked })} /> {d.active ? "on" : "off"}</label></td>
      <td><button className="btn small primary" disabled={!dirty} onClick={() => onSave(d)} data-testid="event-save">Save</button></td>
    </tr>
  );
}


/* ------------------------------------------------------------------ transfers */
interface LookupUser { id: string; code: string; name: string; email: string; wallet: { walletId: string; balance: number; available: number; currency: string; state: string } | null }
interface LookupProject { id: string; code: string; title: string; status: string; ownerId: string | null; wallet: LookupUser["wallet"] }
interface TransferRow { id: string; code: string; sourceKind: string; destinationKind: string; sourceRef: string | null; destinationRef: string | null; sourceLabel: string; destinationLabel: string; adminLabel: string; amount: number; currency: string; reason: string | null; note: string | null; status: "completed" | "reversed"; reversalOf: string | null; reversedBy: string | null; createdAt: string }

function TransfersTab({ say }: { say: (t: string, ok?: boolean) => void }) {
  const [users, setUsers] = React.useState<LookupUser[]>([]);
  const [projects, setProjects] = React.useState<LookupProject[]>([]);
  const [srcType, setSrcType] = React.useState<"user" | "project">("project");
  const [srcId, setSrcId] = React.useState("");
  const [dstType, setDstType] = React.useState<"user" | "project">("project");
  const [dstId, setDstId] = React.useState("");
  const [dstUserProject, setDstUserProject] = React.useState("");   // when the destination is a person who owns projects: land it in one of them, or in their own wallet
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<TransferRow[] | null>(null);
  const [filters, setFilters] = React.useState({ project: "", user: "", admin: "", status: "", from: "", to: "", min: "", max: "" });

  const loadLookup = React.useCallback(async () => {
    const r = await call<{ users: LookupUser[]; projects: LookupProject[] }>("/api/admin/billing/lookup");
    if (!r.ok) { say(r.json.error ?? "Could not read users and projects", false); return; }
    setUsers(r.json.users); setProjects(r.json.projects);
  }, [say]);
  const loadHistory = React.useCallback(async () => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== "")));
    const r = await call<{ transfers: TransferRow[] }>(`/api/admin/billing/transfer?${qs}`);
    if (!r.ok) { say(r.json.error ?? "Could not read the transfer history", false); return; }
    setHistory(r.json.transfers);
  }, [filters, say]);
  React.useEffect(() => { void loadLookup(); }, [loadLookup]);
  React.useEffect(() => { void loadHistory(); }, [loadHistory]);

  const sourceLabel = (t: "user" | "project", id: string) => t === "project" ? (projects.find((p) => p.id === id) ? `${projects.find((p) => p.id === id)!.title} (project)` : id) : (users.find((u) => u.id === id) ? `${users.find((u) => u.id === id)!.name} (user)` : id);
  const srcWallet = srcType === "project" ? projects.find((p) => p.id === srcId)?.wallet ?? null : users.find((u) => u.id === srcId)?.wallet ?? null;
  const available = srcWallet?.available ?? 0;
  const cur = srcWallet?.currency ?? "USD";
  const amt = Number(amount);
  const destProjectsOfUser = dstType === "user" && dstId ? projects.filter((p) => p.ownerId === dstId) : [];
  const finalDestination: { type: "user" | "project"; id: string } | null = !dstId ? null : dstType === "user" && dstUserProject ? { type: "project", id: dstUserProject } : { type: dstType, id: dstId };
  const sameWallet = finalDestination && srcType === finalDestination.type && srcId === finalDestination.id;
  const valid = srcId && finalDestination && Number.isFinite(amt) && amt > 0 && amt <= available && !sameWallet;

  const submit = async () => {
    if (!valid || !finalDestination) return;
    setBusy(true);
    const r = await call<{ transfer: TransferRow; source: { balance: number }; destination: { balance: number } }>("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: srcType, id: srcId }, destination: finalDestination, amount: amt, reason: reason || undefined, note: note || undefined }) });
    setBusy(false); setConfirming(false);
    if (!r.ok) { say(r.json.error ?? `The transfer could not be completed (${r.status})`, false); return; }
    say(`${r.json.transfer.code}: ${fmtMoney(amt, cur)} transferred from ${sourceLabel(srcType, srcId)} to ${sourceLabel(finalDestination.type, finalDestination.id)}. Source balance ${fmtMoney(r.json.source.balance, cur)}, destination ${fmtMoney(r.json.destination.balance, cur)}.`);
    setAmount(""); setReason(""); setNote("");
    await loadLookup(); await loadHistory();
  };
  const reverse = async (t: TransferRow) => {
    const why = window.prompt(`Reverse ${t.code} (${fmtMoney(t.amount, t.currency)} back from ${t.destinationLabel} to ${t.sourceLabel})? Enter the reason — it is recorded on the ledger.`);
    if (!why) return;
    const r = await call<{ transfer: TransferRow }>("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ action: "reverse", transferId: t.id, note: why }) });
    if (!r.ok) { say(r.json.error ?? "Could not reverse", false); return; }
    say(`${t.code} reversed by ${r.json.transfer.code}.`); await loadLookup(); await loadHistory();
  };

  const pick = (type: "user" | "project", value: string, onChange: (v: string) => void, testid: string) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
      <option value="">— select a {type} —</option>
      {type === "project"
        ? projects.map((p) => <option key={p.id} value={p.id}>{p.title} · {p.code}{p.wallet ? ` — ${fmtMoney(p.wallet.available, p.wallet.currency)} available` : " — no wallet yet"}</option>)
        : users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.code}{u.wallet ? ` — ${fmtMoney(u.wallet.available, u.wallet.currency)} available` : " — no wallet yet"}</option>)}
    </select>
  );

  return (
    <div>
      <div className="bl-grid2">
        <div className="card bl-card" data-testid="transfer-form">
          <div className="card-title">Transfer credits</div>
          <p className="muted" style={{ fontSize: 12.5 }}>Moves unused balance from one wallet to another. Only what is not reserved for operations in progress can move; both wallets change in one transaction and both ledgers record the same transfer id.</p>
          <div className="bl-form" style={{ marginTop: 8 }}>
            <label className="flabel">Source type</label>
            <div className="row" style={{ gap: 14, fontSize: 13.5 }}>
              <label className="row" style={{ gap: 5 }}><input type="radio" name="src-type" checked={srcType === "user"} onChange={() => { setSrcType("user"); setSrcId(""); }} data-testid="transfer-src-user" /> User</label>
              <label className="row" style={{ gap: 5 }}><input type="radio" name="src-type" checked={srcType === "project"} onChange={() => { setSrcType("project"); setSrcId(""); }} data-testid="transfer-src-project" /> Project</label>
            </div>
            <label className="flabel">Source</label>
            {pick(srcType, srcId, setSrcId, "transfer-source")}
            <div className="bl-stat" data-testid="transfer-available">
              <div className="bl-stat-label">Available balance</div>
              <div className="bl-stat-value">{srcId ? fmtMoney(available, cur) : "—"}</div>
              {srcWallet && srcWallet.balance !== srcWallet.available && <div className="bl-stat-sub muted">{fmtMoney(srcWallet.balance, cur)} balance, {fmtMoney(srcWallet.balance - srcWallet.available, cur)} reserved for operations in progress</div>}
              {srcId && !srcWallet && <div className="bl-stat-sub muted">This {srcType} has no wallet yet — nothing to transfer.</div>}
            </div>
            <label className="flabel">Transfer amount ({cur})</label>
            <input className="input" type="number" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" data-testid="transfer-amount" />
            {amount !== "" && amt > available && <div className="alert error" data-testid="transfer-too-much">The amount exceeds the available balance of {fmtMoney(available, cur)}.</div>}
            <label className="flabel">Destination type</label>
            <div className="row" style={{ gap: 14, fontSize: 13.5 }}>
              <label className="row" style={{ gap: 5 }}><input type="radio" name="dst-type" checked={dstType === "user"} onChange={() => { setDstType("user"); setDstId(""); setDstUserProject(""); }} data-testid="transfer-dst-user" /> User</label>
              <label className="row" style={{ gap: 5 }}><input type="radio" name="dst-type" checked={dstType === "project"} onChange={() => { setDstType("project"); setDstId(""); setDstUserProject(""); }} data-testid="transfer-dst-project" /> Project</label>
            </div>
            <label className="flabel">Destination</label>
            {pick(dstType, dstId, (v) => { setDstId(v); setDstUserProject(""); }, "transfer-destination")}
            {destProjectsOfUser.length > 0 && (
              <>
                <label className="flabel">Land the credits in</label>
                <select className="select" value={dstUserProject} onChange={(e) => setDstUserProject(e.target.value)} data-testid="transfer-dst-user-project">
                  <option value="">{users.find((u) => u.id === dstId)?.name ?? "The person"}&apos;s own wallet</option>
                  {destProjectsOfUser.map((p) => <option key={p.id} value={p.id}>Project: {p.title} · {p.code}</option>)}
                </select>
              </>
            )}
            {sameWallet && <div className="alert error">Source and destination are the same wallet.</div>}
            <label className="flabel">Reason (optional)</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Unused project credits" data-testid="transfer-reason" />
            <label className="flabel">Notes (optional)</label>
            <textarea className="ta" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="transfer-note" />
            {!confirming && <div className="row" style={{ marginTop: 8 }}><button className="btn primary" disabled={!valid} onClick={() => setConfirming(true)} data-testid="transfer-submit">Transfer credits</button></div>}
            {confirming && finalDestination && (
              <div className="alert warning" style={{ display: "block" }} data-testid="transfer-confirm">
                <div>You are about to transfer <strong>{fmtMoney(amt, cur)}</strong> from <strong>{sourceLabel(srcType, srcId)}</strong> to <strong>{sourceLabel(finalDestination.type, finalDestination.id)}</strong>. This action will be recorded in the billing ledger.</div>
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <button className="btn primary" disabled={busy} onClick={submit} data-testid="transfer-confirm-yes">{busy ? "Transferring…" : "Confirm transfer"}</button>
                  <button className="btn" onClick={() => setConfirming(false)} data-testid="transfer-confirm-no">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="card bl-card">
          <div className="card-title">Rules</div>
          <ul className="muted" style={{ fontSize: 13, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Only available balance moves: wallet balance minus what open reservations hold. Overdraft room is never transferable.</li>
            <li>Source and destination are updated in the same database transaction — never one without the other.</li>
            <li>The source ledger shows <em>Credit Transfer Out</em>, the destination <em>Credit Transfer In</em>; both carry the same transfer id.</li>
            <li>A transfer is never deleted or edited. To undo one, reverse it: a new <em>Credit Transfer Reversal</em> moves the credits back and references the original.</li>
            <li>A person&apos;s own wallet is a pool: credits can be moved into it and out of it, and a project can be pointed at it from Wallets &amp; credits.</li>
          </ul>
        </div>
      </div>

      <div className="card bl-card" style={{ marginTop: 12 }} data-testid="transfer-history">
        <div className="row"><div className="card-title">Credit transfer history</div><span className="grow" /><button className="btn small" onClick={loadHistory}>↻ refresh</button></div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <select className="select small" value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })} data-testid="transfer-filter-project"><option value="">Any project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
          <select className="select small" value={filters.user} onChange={(e) => setFilters({ ...filters, user: e.target.value })} data-testid="transfer-filter-user"><option value="">Any user</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <select className="select small" value={filters.admin} onChange={(e) => setFilters({ ...filters, admin: e.target.value })}><option value="">Any admin</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <select className="select small" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} data-testid="transfer-filter-status"><option value="">Any status</option><option value="completed">Completed</option><option value="reversed">Reversed</option></select>
          <input className="input small" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} title="From date" />
          <input className="input small" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} title="To date" />
          <input className="input small" type="number" placeholder="Min amount" value={filters.min} onChange={(e) => setFilters({ ...filters, min: e.target.value })} style={{ width: 110 }} data-testid="transfer-filter-min" />
          <input className="input small" type="number" placeholder="Max amount" value={filters.max} onChange={(e) => setFilters({ ...filters, max: e.target.value })} style={{ width: 110 }} />
        </div>
        {!history ? <p className="muted">Reading history…</p> : !history.length ? <p className="muted" style={{ marginTop: 8 }} data-testid="transfer-history-empty">No transfers match.</p> : (
          <table className="grid bl-table" style={{ marginTop: 8 }} data-testid="transfer-rows">
            <thead><tr><th>Date</th><th>Transfer ID</th><th>Source</th><th>Destination</th><th>Amount</th><th>Admin</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id} data-testid="transfer-row" data-code={t.code} data-status={t.status} data-reversal={String(!!t.reversalOf)}>
                  <td className="muted">{fmtWhen(t.createdAt)}</td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.code}{t.reversalOf && <div className="muted" style={{ fontSize: 11 }}>reverses {history.find((x) => x.id === t.reversalOf)?.code ?? "…"}</div>}</td>
                  <td>{t.sourceLabel}<div className="muted" style={{ fontSize: 11 }}>{t.sourceKind}</div></td>
                  <td>{t.destinationLabel}<div className="muted" style={{ fontSize: 11 }}>{t.destinationKind}</div></td>
                  <td><strong>{fmtMoney(t.amount, t.currency)}</strong></td>
                  <td className="muted">{t.adminLabel}</td>
                  <td>{t.reason ?? <span className="muted">—</span>}{t.note && <div className="muted" style={{ fontSize: 11.5 }}>{t.note}</div>}</td>
                  <td><span className={`badge ${t.status === "completed" ? "success" : "neutral"}`}>{t.reversalOf ? "Reversal" : t.status === "completed" ? "Completed" : "Reversed"}</span></td>
                  <td>{t.status === "completed" && !t.reversalOf && <button className="btn small" onClick={() => reverse(t)} data-testid="transfer-reverse">Reverse</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
