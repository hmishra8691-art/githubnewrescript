"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { useSession } from "@/lib/useSession";
import { fmtMoney, fmtWhen, STATE_WORD, UsageTable, type UsageRow } from "@/components/billing/shared";

/**
 * MY USAGE (billing brief §19) — the person's view across their projects:
 * total credits, total used, remaining, use by project and by category,
 * their recent usage rows and their credit requests. Read-only: credits
 * are assigned on the administrator's screen; requests are made from a
 * project's Usage tab.
 *
 * Every amount is what was CHARGED to a wallet (change 2). The page never
 * receives a provider cost, an infrastructure cost, a fee, a reserve or a
 * margin — those are the administrator's numbers, on the administrator's
 * screen.
 */
interface Payload {
  projects: { id: string; code: string; title: string; status: string; role: string; wallet: { balance: number; totalAdded: number; totalUsed: number; state: string; currency: string } | null; used: number; events: number }[];
  totals: { credits: number; used: number; remaining: number };
  categories: { category: string; label: string; charge: number; events: number }[];
  personalWallet: { balance: number; totalAdded: number; state: string; currency: string } | null;
  recent: UsageRow[];
  requests: { id: string; surveyId: string | null; requestedAmount: number; reason: string; status: string; createdAt: string; decidedAmount: number | null; adminNote: string | null }[];
}

export default function BillingPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<{ text: string; code?: string } | null>(null);
  React.useEffect(() => {
    fetch("/api/billing/me", { cache: "no-store" }).then(async (r) => {
      const j = await r.json().catch(() => ({})) as Payload & { error?: string; code?: string };
      if (!r.ok) { setError({ text: j.error ?? `Usage could not be read (${r.status})`, code: j.code }); return; }
      setData(j);
    }).catch(() => setError({ text: "Could not reach the Studio." }));
  }, []);
  const user = state.kind === "signed_in" ? state.user : null;
  const cur = data?.projects.find((p) => p.wallet)?.wallet?.currency ?? "USD";
  return (
    <div className="bl-page">
      <AccountHeader active="billing" user={user} onSignOut={signOut} />
      {error && <div className={`alert ${error.code === "billing_unavailable" ? "info" : "warning"}`} data-testid="my-usage-error">{error.text}</div>}
      {!data && !error && <p className="muted">Reading your usage…</p>}
      {data && (
        <>
          <div className="bl-grid2" data-testid="my-usage-totals">
            <div className="card bl-card"><div className="card-title">Total credits</div><div className="bl-remaining">{fmtMoney(data.totals.credits, cur)}</div><div className="muted" style={{ fontSize: 12.5 }}>assigned across {data.projects.filter((p) => p.wallet).length} project wallet{data.projects.filter((p) => p.wallet).length === 1 ? "" : "s"}</div></div>
            <div className="card bl-card"><div className="card-title">Total used</div><div className="bl-remaining">{fmtMoney(data.totals.used, cur)}</div><div className="muted" style={{ fontSize: 12.5 }}>{data.recent.length ? `latest ${fmtWhen(data.recent[0].at)}` : "no usage yet"}</div></div>
            <div className="card bl-card"><div className="card-title">Remaining</div><div className="bl-remaining">{fmtMoney(data.totals.remaining, cur)}</div><div className="muted" style={{ fontSize: 12.5 }}>across every wallet you can see{data.personalWallet ? ` · ${fmtMoney(data.personalWallet.balance, data.personalWallet.currency)} in your own wallet` : ""}</div></div>
          </div>
          <div className="bl-grid2" style={{ marginTop: 12 }}>
            <div className="card bl-card">
              <div className="card-title">Usage by project</div>
              {data.projects.length ? (
                <table className="grid bl-table" data-testid="my-usage-projects">
                  <thead><tr><th>Project</th><th>Used</th><th>Remaining</th><th>State</th></tr></thead>
                  <tbody>
                    {data.projects.map((p) => (
                      <tr key={p.id} data-project={p.id}>
                        <td><a href={`/studio/${p.id}`}>{p.title}</a> <span className="muted">· {p.code}</span></td>
                        <td>{fmtMoney(p.wallet?.totalUsed ?? p.used, cur)}</td>
                        <td>{p.wallet ? fmtMoney(p.wallet.balance, p.wallet.currency) : <span className="muted">no wallet yet</span>}</td>
                        <td>{p.wallet ? <span className={`badge ${p.wallet.state === "active" ? "success" : "error"}`}>{STATE_WORD[p.wallet.state] ?? p.wallet.state}</span> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted" style={{ fontSize: 13 }}>You have no projects yet.</p>}
            </div>
            <div className="card bl-card">
              <div className="card-title">Usage by category</div>
              {data.categories.length ? (
                <table className="bl-kv" data-testid="my-usage-categories"><tbody>{data.categories.map((c) => <tr key={c.category}><td>{c.label}<span className="muted"> · {c.events}</span></td><td>{fmtMoney(c.charge, cur)}</td></tr>)}</tbody></table>
              ) : <p className="muted" style={{ fontSize: 13 }}>Nothing metered yet.</p>}
              {data.requests.length > 0 && (
                <>
                  <div className="card-title" style={{ marginTop: 14 }}>Your credit requests</div>
                  <table className="grid bl-table"><thead><tr><th>When</th><th>Amount</th><th>Status</th></tr></thead>
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
 * Source: their own balance, or a project they own. Destination: another
 * person by User ID, or one of their own projects. What may move is the
 * AVAILABLE balance — what is there minus what an operation in flight is
 * holding — and the server is what enforces that; this screen shows the same
 * number so the refusal is never a surprise.
 *
 * The confirmation step is not decoration. It is the last moment before
 * money moves between two people, so it names the recipient (resolved from
 * the User ID, so a typo is caught before the transfer rather than after)
 * and the amount, in a sentence.
 */
function TransferCredits({ currency, myUserCode }: { currency: string; myUserCode: string }) {
  const [data, setData] = React.useState<TransferPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [srcId, setSrcId] = React.useState("");          // "" = my own credits
  const [toKind, setToKind] = React.useState<"user" | "project">("user");
  const [toUser, setToUser] = React.useState("");
  const [toProject, setToProject] = React.useState("");
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

  const source = srcId ? data.projects.find((p) => p.id === srcId) ?? null : null;
  const available = srcId ? source?.available ?? 0 : data.wallet?.available ?? 0;
  const cur = srcId ? source?.currency ?? currency : data.wallet?.currency ?? currency;
  const amt = Number(amount);
  const destinationNamed = toKind === "user" ? toUser.trim().length > 0 : toProject.length > 0;
  const overspend = amount !== "" && Number.isFinite(amt) && amt > available;
  const valid = Number.isFinite(amt) && amt > 0 && !overspend && destinationNamed;

  const ask = async () => {
    setNote(null);
    if (toKind === "project") { setConfirm({ name: data.projects.find((p) => p.id === toProject)?.title ?? "that project", code: "" }); return; }
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
    const body: Record<string, unknown> = { amount: amt, message: message || undefined };
    if (srcId) body.source = { type: "project", id: srcId };
    if (toKind === "user") body.toUserCode = toUser.trim(); else body.toProjectId = toProject;
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
        Send your unused credits to a colleague by their User ID, or move them into one of your projects. Only credits that are
        not already used or reserved for work in progress can be transferred.
      </p>
      {note && <div className={`alert ${note.ok ? "success" : "error"}`} style={{ marginTop: 8 }} data-testid="transfer-note">{note.text}</div>}
      <div className="bl-grid2" style={{ marginTop: 8 }}>
        <div className="bl-form">
          <label className="flabel">Transfer from</label>
          <select className="select" value={srcId} onChange={(e) => { setSrcId(e.target.value); setAmount(""); }} data-testid="tc-source">
            <option value="">My credits{data.wallet ? ` — ${fmtMoney(data.wallet.available, data.wallet.currency)} available` : " — none yet"}</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title} · {p.code} — {fmtMoney(p.available, p.currency)} available</option>
            ))}
          </select>
          <div className="bl-stat" data-testid="tc-available">
            <div className="bl-stat-label">Available to transfer</div>
            <div className="bl-stat-value">{fmtMoney(available, cur)}</div>
            {srcId
              ? source && source.balance !== source.available && <div className="bl-stat-sub muted">{fmtMoney(source.balance, cur)} balance, {fmtMoney(source.balance - source.available, cur)} reserved for work in progress</div>
              : data.wallet && data.wallet.balance !== data.wallet.available && <div className="bl-stat-sub muted">{fmtMoney(data.wallet.balance, cur)} balance, {fmtMoney(data.wallet.balance - data.wallet.available, cur)} reserved for work in progress</div>}
          </div>

          <label className="flabel">Transfer to</label>
          <div className="row" style={{ gap: 14, fontSize: 13.5 }}>
            <label className="row" style={{ gap: 5 }}><input type="radio" name="tc-to" checked={toKind === "user"} onChange={() => setToKind("user")} data-testid="tc-to-user" /> Another user</label>
            <label className="row" style={{ gap: 5 }}><input type="radio" name="tc-to" checked={toKind === "project"} onChange={() => setToKind("project")} data-testid="tc-to-project" /> One of my projects</label>
          </div>
          {toKind === "user" ? (
            <>
              <label className="flabel">Recipient User ID</label>
              <input className="input" value={toUser} onChange={(e) => setToUser(e.target.value)} placeholder="USR-10482" data-testid="tc-recipient" />
              {myUserCode && <div className="muted" style={{ fontSize: 12 }}>Yours is {myUserCode} — you cannot transfer to yourself.</div>}
            </>
          ) : (
            <>
              <label className="flabel">Destination project</label>
              <select className="select" value={toProject} onChange={(e) => setToProject(e.target.value)} data-testid="tc-recipient-project">
                <option value="">— select a project —</option>
                {data.projects.filter((p) => p.id !== srcId).map((p) => <option key={p.id} value={p.id}>{p.title} · {p.code}</option>)}
              </select>
            </>
          )}

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
