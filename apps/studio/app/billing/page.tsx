"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { useSession } from "@/lib/useSession";
import { AddFundsDialog } from "@/components/dashboard/AddFundsDialog";
import { fmtMoney, fmtWhen, LEVEL_CLASS, LEVEL_WORD, STATE_WORD, Stat, UsageTable, type UsageRow } from "@/components/billing/shared";

/**
 * MY WALLET — the person's whole financial position in one place: one
 * balance, what has been deposited, used, transferred in and out, what is
 * held by work in progress, and which of their projects is spending it.
 *
 * There is one wallet and many projects, so the page is shaped that way: the
 * wallet at the top because there is one of it, and the projects below as a
 * list of consumers, each with what it has spent and what it is allowed to.
 * Credits are added by request while the platform is in simulation mode;
 * requests are made from
 * project's Usage tab.
 *
 * Every amount is what was CHARGED to a wallet (change 2). The page never
 * receives a provider cost, an infrastructure cost, a fee, a reserve or a
 * margin — those are the administrator's numbers, on the administrator's
 * screen.
 */
interface ProjectMeterView {
  currency: string; used: number; limit: number | null; mode: "shared" | "budget" | "priority";
  allowance: number; walletRemaining: number; reserved: number; usedPct: number;
  level: "normal" | "low" | "critical" | "locked";
  state: "active" | "frozen" | "read_only" | "suspended";
}
interface Payload {
  projects: { id: string; code: string; title: string; status: string; role: string; meter: ProjectMeterView | null; used: number; events: number }[];
  totals: { credits: number; used: number; remaining: number };
  categories: { category: string; label: string; charge: number; events: number }[];
  /** the person's one wallet — every project below spends from it */
  wallet: {
    walletId: string | null; currency: string; balance: number; reserved: number; available: number;
    totalAdded: number; totalUsed: number; transferredOut: number; transferredIn: number;
    level: "normal" | "low" | "critical" | "locked"; state: "active" | "read_only" | "suspended";
  } | null;
  recent: UsageRow[];
  requests: { id: string; surveyId: string | null; requestedAmount: number; reason: string; status: string; createdAt: string; decidedAmount: number | null; adminNote: string | null }[];
}

export default function BillingPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const [data, setData] = React.useState<Payload | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<{ text: string; code?: string } | null>(null);
  const reload = React.useCallback(async () => {
    try {
      const r = await fetch("/api/billing/me", { cache: "no-store" });
      const j = await r.json().catch(() => ({})) as Payload & { error?: string; code?: string };
      if (!r.ok) { setError({ text: j.error ?? `Usage could not be read (${r.status})`, code: j.code }); return; }
      setData(j);
    } catch { setError({ text: "Could not reach the Studio." }); }
  }, []);
  React.useEffect(() => { void reload(); }, [reload]);
  const user = state.kind === "signed_in" ? state.user : null;
  const cur = data?.wallet?.currency ?? "USD";
  const w = data?.wallet ?? null;
  return (
    <div className="bl-page">
      <AccountHeader active="billing" user={user} onSignOut={signOut} />
      {error && <div className={`alert ${error.code === "billing_unavailable" ? "info" : "warning"}`} data-testid="my-usage-error">{error.text}</div>}
      {!data && !error && <p className="muted">Reading your usage…</p>}
      {data && (
        <>
          {/*
            * ONE WALLET. Everything above the project table is the person's
            * whole position — what has come in, what has gone out, what is
            * held and what is actually spendable — because with one balance
            * funding every study, "how am I doing" is a question about the
            * wallet and not about any project.
            */}
          <div className="card bl-card" data-testid="my-wallet" data-level={w?.level} data-state={w?.state}>
            <div className="row" style={{ alignItems: "center", gap: 10 }}>
              <div className="card-title" style={{ margin: 0 }}>My wallet</div>
              <span className={`badge ${w?.state === "suspended" ? "error" : LEVEL_CLASS[w?.level ?? "locked"]}`} data-testid="my-wallet-level">
                {w?.state === "suspended" ? "Suspended" : w?.state === "read_only" ? "Empty" : LEVEL_WORD[w?.level ?? "locked"]}
              </span>
              <span className="grow" />
              <button className="btn small primary" data-testid="my-add-funds" onClick={() => setAdding(true)}>Add funds</button>
            </div>
            <div className="bl-remaining" data-testid="my-wallet-balance">
              {fmtMoney(w?.balance ?? 0, cur)} <span className="muted">available balance</span>
            </div>
            <div className="bl-stats">
              <Stat label="Total deposited" value={fmtMoney(w?.totalAdded ?? 0, cur)} testid="my-wallet-added" />
              <Stat label="Total used" value={fmtMoney(w?.totalUsed ?? 0, cur)} testid="my-wallet-used"
                sub={data.recent.length ? `latest ${fmtWhen(data.recent[0].at)}` : "no usage yet"} />
              <Stat label="Transferred out" value={fmtMoney(w?.transferredOut ?? 0, cur)} testid="my-wallet-out" />
              <Stat label="Received" value={fmtMoney(w?.transferredIn ?? 0, cur)} testid="my-wallet-in" />
              <Stat label="Reserved" value={fmtMoney(w?.reserved ?? 0, cur)} testid="my-wallet-reserved" sub="held by work in progress" />
              <Stat label="Available to spend" value={fmtMoney(w?.available ?? 0, cur)} testid="my-wallet-available" />
            </div>
            {w?.state === "read_only" && (
              <div className="alert error" style={{ marginTop: 10 }} data-testid="my-wallet-empty">
                Your wallet is empty, so every project has stopped running billable work. Adding funds starts them again.
              </div>
            )}
          </div>

          <div className="bl-grid2" style={{ marginTop: 12 }}>
            <div className="card bl-card">
              <div className="card-title">Projects spending it</div>
              {data.projects.length ? (
                <table className="grid bl-table" data-testid="my-usage-projects">
                  <thead><tr><th>Project</th><th>Spent</th><th>Limit</th><th>Usage</th><th>State</th></tr></thead>
                  <tbody>
                    {data.projects.map((p) => (
                      <tr key={p.id} data-project={p.id} data-state={p.meter?.state ?? "none"}>
                        <td><a href={`/studio/${p.id}`}>{p.title}</a> <span className="muted">· {p.code}</span></td>
                        <td data-testid="mp-spent">{fmtMoney(p.meter?.used ?? p.used, cur)}</td>
                        <td data-testid="mp-limit">
                          {p.meter?.limit == null
                            ? <span className="muted">{p.meter?.mode === "priority" ? "priority" : "no limit"}</span>
                            : fmtMoney(p.meter.limit, cur)}
                        </td>
                        <td data-testid="mp-pct">{p.meter ? `${p.meter.usedPct}%` : "—"}</td>
                        <td>
                          {p.meter
                            ? <span className={`badge ${p.meter.state === "active" ? "success" : p.meter.state === "frozen" ? "warning" : "error"}`}>
                                {p.meter.state === "frozen" ? "At its limit" : p.meter.state === "read_only" ? "Wallet empty" : STATE_WORD[p.meter.state] ?? p.meter.state}
                              </span>
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted" style={{ fontSize: 13 }}>You have no projects yet.</p>}
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                A limit is how much of this wallet a project may consume. Setting one moves no money — change it on the
                project&apos;s card or in its Usage &amp; Wallet tab.
              </p>
            </div>
            <div className="card bl-card">
              <div className="card-title">Usage by category</div>
              {data.categories.length ? (
                <table className="bl-kv" data-testid="my-usage-categories"><tbody>{data.categories.map((c) => <tr key={c.category}><td>{c.label}<span className="muted"> · {c.events}</span></td><td>{fmtMoney(c.charge, cur)}</td></tr>)}</tbody></table>
              ) : <p className="muted" style={{ fontSize: 13 }}>Nothing metered yet.</p>}
              {data.requests.length > 0 && (
                <>
                  <div className="card-title" style={{ marginTop: 14 }}>Your credit requests</div>
                  <table className="grid bl-table" data-testid="my-requests"><thead><tr><th>When</th><th>Amount</th><th>Status</th></tr></thead>
                    <tbody>{data.requests.map((r) => <tr key={r.id}><td className="muted">{fmtWhen(r.createdAt)}</td><td>{fmtMoney(r.requestedAmount, cur)}</td><td><span className={`badge ${r.status === "approved" ? "success" : r.status === "rejected" ? "error" : "warning"}`}>{r.status}</span>{r.adminNote && <span className="muted"> · {r.adminNote}</span>}</td></tr>)}</tbody>
                  </table>
                </>
              )}
            </div>
          </div>
          <TransferCredits currency={cur} myUserCode={user?.userCode ?? ""} />

          <div className="card bl-card" style={{ marginTop: 12 }}>
            <div className="card-title">Recent usage</div>
            <UsageTable rows={data.recent} currency={cur} showProject testid="my-usage-rows" />
          </div>
          {adding && (
            <AddFundsDialog currency={cur} balance={w?.balance ?? 0}
              onClose={() => setAdding(false)} onRequested={() => { void reload(); }} />
          )}
        </>
      )}
    </div>
  );
}


/* ------------------------------------------------------- transfer credits */

interface TransferPayload {
  wallet: { id: string; balance: number; reserved: number; available: number; currency: string; totalAdded: number } | null;
  projects: { id: string; code: string; title: string; walletId: string | null; balance: number; available: number; currency: string }[];
  transfers: { id: string; code: string; at: string; amount: number; currency: string; status: string; direction: "sent" | "received"; counterparty: string; from: string; to: string; message: string | null; reversalOf: string | null }[];
}

/**
 * TRANSFER CREDITS — the person's own, without asking an administrator.
 *
 * From their wallet to another person's, by User ID. That is the only
 * transfer there is now: a project holds no money, it spends from its
 * owner's wallet under a limit, so there is nothing inside a project to move
 * and changing a limit transfers nothing. What may move is the AVAILABLE
 * balance — what is there minus what an operation in flight is holding — and
 * the server enforces that; this screen shows the same number so a refusal is
 * never a surprise.
 *
 * The confirmation step is not decoration. It is the last moment before
 * money moves between two people, so it names the recipient (resolved from
 * the User ID, so a typo is caught before the transfer rather than after)
 * and the amount, in a sentence.
 */
function TransferCredits({ currency, myUserCode }: { currency: string; myUserCode: string }) {
  const [data, setData] = React.useState<TransferPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [toUser, setToUser] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [confirm, setConfirm] = React.useState<{ name: string; code: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);

  const load = React.useCallback(async () => {
    const r = await fetch("/api/billing/transfer", { cache: "no-store" });
    const j = await r.json().catch(() => ({})) as TransferPayload & { error?: string };
    if (!r.ok) { setError(j.error ?? `Transfers could not be read (${r.status})`); return; }
    setError(null); setData(j);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  if (error) return <div className="card bl-card" style={{ marginTop: 12 }} data-testid="transfer-credits"><div className="card-title">Transfer credits</div><div className="alert info" style={{ marginTop: 8 }}>{error}</div></div>;
  if (!data) return null;

  const available = data.wallet?.available ?? 0;
  const cur = data.wallet?.currency ?? currency;
  const amt = Number(amount);
  const overspend = amount !== "" && Number.isFinite(amt) && amt > available;
  const valid = Number.isFinite(amt) && amt > 0 && !overspend && toUser.trim().length > 0;

  const ask = async () => {
    setNote(null);
    /* resolve the User ID first, so a typo is caught before anything moves */
    setBusy(true);
    const r = await fetch("/api/billing/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resolve", userCode: toUser.trim() }) });
    const j = await r.json().catch(() => ({})) as { user?: { userCode: string; name: string }; error?: string };
    setBusy(false);
    if (!r.ok || !j.user) { setNote({ text: j.error ?? "That User ID could not be found.", ok: false }); return; }
    setConfirm({ name: j.user.name, code: j.user.userCode });
  };

  const send = async () => {
    setBusy(true);
    const body: Record<string, unknown> = { amount: amt, message: message || undefined, toUserCode: toUser.trim() };
    const r = await fetch("/api/billing/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})) as { transfer?: { code: string }; source?: { balance: number }; error?: string };
    setBusy(false); setConfirm(null);
    if (!r.ok) { setNote({ text: j.error ?? `The transfer could not be completed (${r.status})`, ok: false }); return; }
    setNote({ text: `${j.transfer?.code}: ${fmtMoney(amt, cur)} transferred. Your remaining balance is ${fmtMoney(j.source?.balance ?? 0, cur)}.`, ok: true });
    setAmount(""); setMessage("");
    await load();
  };

  return (
    <div className="card bl-card" style={{ marginTop: 12 }} data-testid="transfer-credits">
      <div className="card-title">Transfer credits</div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Send your unused credits to a colleague by their User ID. Only credits that are not already used or reserved for work
        in progress can be transferred. To control what a PROJECT may spend, set its limit rather than moving money — projects
        draw on this wallet.
      </p>
      {note && <div className={`alert ${note.ok ? "success" : "error"}`} style={{ marginTop: 8 }} data-testid="transfer-note">{note.text}</div>}
      <div className="bl-grid2" style={{ marginTop: 8 }}>
        <div className="bl-form">
          <div className="bl-stat" data-testid="tc-available">
            <div className="bl-stat-label">Available to transfer</div>
            <div className="bl-stat-value">{fmtMoney(available, cur)}</div>
            {data.wallet && data.wallet.balance !== data.wallet.available && (
              <div className="bl-stat-sub muted">{fmtMoney(data.wallet.balance, cur)} balance, {fmtMoney(data.wallet.balance - data.wallet.available, cur)} reserved for work in progress</div>
            )}
          </div>

          <label className="flabel">Recipient User ID</label>
          <input className="input" value={toUser} onChange={(e) => setToUser(e.target.value)} placeholder="USR-10482" data-testid="tc-recipient" />
          {myUserCode && <div className="muted" style={{ fontSize: 12 }}>Yours is {myUserCode} — you cannot transfer to yourself.</div>}

          <label className="flabel">Amount ({cur})</label>
          <input className="input" type="number" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" data-testid="tc-amount" />
          {overspend && <div className="alert error" data-testid="tc-too-much">You can transfer at most {fmtMoney(available, cur)} — the rest is already used or reserved.</div>}

          <label className="flabel">Message / reason (optional)</label>
          <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} data-testid="tc-message" />

          {!confirm && <div className="row" style={{ marginTop: 8 }}><button className="btn primary" disabled={!valid || busy} onClick={ask} data-testid="tc-submit">{busy ? "Checking…" : "Transfer credits"}</button></div>}
          {confirm && (
            <div className="alert warning" style={{ display: "block" }} data-testid="tc-confirm">
              <div>
                You are about to transfer <strong>{fmtMoney(amt, cur)}</strong> to {confirm.code ? <>User <strong>{confirm.code}</strong> ({confirm.name})</> : <strong>{confirm.name}</strong>}.
                {" "}This amount will be deducted from your available credits and added to the recipient&apos;s credits.
              </div>
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn primary" disabled={busy} onClick={send} data-testid="tc-confirm-yes">{busy ? "Transferring…" : "Confirm transfer"}</button>
                <button className="btn" onClick={() => setConfirm(null)} data-testid="tc-confirm-no">Cancel</button>
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="card-title">Credit transfer history</div>
          {!data.transfers.length ? <p className="muted" style={{ fontSize: 13 }} data-testid="tc-history-empty">You have not sent or received any credits yet.</p> : (
            <table className="grid bl-table" data-testid="tc-history">
              <thead><tr><th>Date</th><th>Transfer ID</th><th>Type</th><th>Recipient / sender</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {data.transfers.map((t) => (
                  <tr key={t.id} data-testid="tc-row" data-direction={t.direction} data-code={t.code}>
                    <td className="muted">{fmtWhen(t.at)}</td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.code}</td>
                    <td><span className={`badge ${t.direction === "sent" ? "neutral" : "success"}`}>{t.direction === "sent" ? "Sent" : "Received"}</span></td>
                    <td>{t.counterparty}{t.message && <div className="muted" style={{ fontSize: 11.5 }}>{t.message}</div>}</td>
                    <td>{t.direction === "sent" ? "−" : "+"}{fmtMoney(t.amount, t.currency)}</td>
                    <td>{t.status === "reversed" ? <span className="badge neutral">Reversed</span> : <span className="badge success">Completed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
