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
          <div className="card bl-card" style={{ marginTop: 12 }}>
            <div className="card-title">Recent usage</div>
            <UsageTable rows={data.recent} currency={cur} showProject testid="my-usage-rows" />
          </div>
        </>
      )}
    </div>
  );
}
