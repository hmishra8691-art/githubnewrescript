"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * VENDOR SETTLEMENT — the administrator's screen over /api/recruitment/settlements (0086).
 *
 * Platform audit 2026-11-05: reconciliation, per-line resolution and the audit entries all worked, and nothing
 * in the interface reached them. This is the screen: pick an order, paste the vendor's invoice as lines
 * (participant id, outcome, amount), reconcile, and decide each difference by hand. Nothing here settles
 * itself — `settled_at` is written only when the last difference has a decision.
 *
 * Platform administrators only, like the route: an invoice and an acquisition cost are the two figures a
 * researcher must never see.
 */

interface OrderRow {
  id: string; status: string; project: string | null; surveyId: string | null; vendor: string; vendorOrderRef: string | null;
  ordered: number; delivered: number; accepted: number; rejected: number; cpi: number; currency: string; spend: number; placedAt: string | null;
  reconciliation: { computedAt: string; settledAt: string | null; clean: boolean } | null;
}
interface Recon {
  id: string; order_id: string; currency: string; claimed_count: number; claimed_amount: number; agreed_count: number; agreed_amount: number;
  payable_count: number; payable_amount: number; held_count: number; held_amount: number; clean: boolean; statement: string | null;
  computed_at: string; settled_at: string | null;
}
interface Diff {
  id: string; participant_ref: string; cause: string; vendor_amount: number | null; platform_amount: number | null; delta: number;
  detail: string | null; resolution: string | null; resolved_at: string | null;
}

const CAUSE: Record<string, string> = {
  not_seen: "Billed, never arrived",
  unclaimed: "Completed, not billed",
  rejected_on_quality: "Rejected on quality",
  held_for_review: "Held for review",
  amount_mismatch: "Amounts differ",
  outcome_mismatch: "Outcomes differ",
};
const RESOLUTIONS: { value: string; label: string }[] = [
  { value: "pay", label: "Pay" }, { value: "decline", label: "Decline" }, { value: "credit", label: "Credit" }, { value: "waived", label: "Waive" },
];

const money = (n: number, ccy: string) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(n); } catch { return `${ccy} ${n.toFixed(2)}`; } };
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * The invoice as lines of text — "participant, outcome, amount" — because that is what an operator has in
 * front of them: a CSV export or a column copied out of a spreadsheet. A line with only a participant id is a
 * billable complete at the agreed CPI; the route fills in the rest.
 */
function parseInvoice(text: string): { claims: { participantId: string; outcome?: string; amount?: number; billable?: boolean }[]; problems: string[] } {
  const claims: { participantId: string; outcome?: string; amount?: number; billable?: boolean }[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    if (i === 0 && /participant/i.test(line) && !/^[A-Za-z0-9_-]+\s*[,;\t]\s*(complete|screenout|quota_full|terminate|over_quota)?/i.test(line) && /outcome|amount/i.test(line)) return; // a header row
    const parts = line.split(/[,;\t]/).map((p) => p.trim());
    const participantId = parts[0];
    if (!participantId) { problems.push(`Line ${i + 1} has no participant id.`); return; }
    const c: { participantId: string; outcome?: string; amount?: number; billable?: boolean } = { participantId };
    if (parts[1]) c.outcome = parts[1].toLowerCase();
    if (parts[2] !== undefined && parts[2] !== "") {
      const n = Number(parts[2]);
      if (!Number.isFinite(n)) problems.push(`Line ${i + 1}: "${parts[2]}" is not an amount.`); else c.amount = n;
    }
    if (parts[3] !== undefined && /^(no|false|0|unbillable)$/i.test(parts[3])) c.billable = false;
    claims.push(c);
  });
  return { claims, problems };
}

export function SettlementPanel() {
  const [orders, setOrders] = React.useState<OrderRow[] | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [recon, setRecon] = React.useState<Recon | null>(null);
  const [diffs, setDiffs] = React.useState<Diff[]>([]);
  const [invoice, setInvoice] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const loadOrders = React.useCallback(async () => {
    const r = await api<{ orders: OrderRow[] }>("/api/recruitment/settlements");
    if (!r.ok) {
      if (r.status === 403) { setDenied(true); return; }
      if (r.status !== 401) setError(r.error);
      return;
    }
    setError(null);
    setOrders(r.data.orders ?? []);
  }, []);
  const loadRecon = React.useCallback(async (orderId: string) => {
    const r = await api<{ reconciliation: Recon | null; differences: Diff[] }>(`/api/recruitment/settlements?order=${encodeURIComponent(orderId)}`);
    if (!r.ok) { setError(r.error); return; }
    setRecon(r.data.reconciliation);
    setDiffs(r.data.differences ?? []);
  }, []);
  React.useEffect(() => { void loadOrders(); }, [loadOrders]);
  React.useEffect(() => { if (selected) void loadRecon(selected); else { setRecon(null); setDiffs([]); } }, [selected, loadRecon]);

  const reconcile = async () => {
    if (!selected) return;
    const parsed = parseInvoice(invoice);
    if (parsed.problems.length) { setError(parsed.problems.slice(0, 5).join(" ")); return; }
    if (!parsed.claims.length) { setError("Paste the vendor's invoice lines first — one participation per line."); return; }
    setBusy(true); setNote(null);
    try {
      const r = await api<{ ok: true; platformRecords: number; summary: { cause: string; count: number; delta: number }[]; settlement: { clean: boolean; payableAmount: number; currency: string } }>("/api/recruitment/settlements", { method: "POST", json: { orderId: selected, claims: parsed.claims } });
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      const s = r.data.settlement;
      setNote(s.clean
        ? `The three accounts agree. ${money(s.payableAmount, s.currency)} is payable.`
        : `Reconciled against ${r.data.platformRecords} platform record${r.data.platformRecords === 1 ? "" : "s"}: ${r.data.summary.map((x) => `${x.count} ${CAUSE[x.cause]?.toLowerCase() ?? x.cause}`).join(", ")}. ${money(s.payableAmount, s.currency)} payable today; each difference below waits for a decision.`);
      await loadRecon(selected);
      await loadOrders();
    } finally { setBusy(false); }
  };
  const decide = async (differenceId: string, resolution: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api<{ ok: true; settled?: boolean }>("/api/recruitment/settlements", { method: "PATCH", json: { differenceId, resolution } });
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      await loadRecon(selected);
      await loadOrders();
    } finally { setBusy(false); }
  };

  if (denied) {
    return <div className="auth-note err" data-testid="settlements-denied">Settlement is a supplier's invoice against acquisition cost — visible to platform administrators only.</div>;
  }

  const order = orders?.find((o) => o.id === selected) ?? null;
  const open = diffs.filter((d) => !d.resolution);

  return (
    <div data-testid="settlements-panel">
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 760 }}>
        Three accounts of the same work — what the vendor claims, what both sides agree on, what is payable today —
        and the lines where they disagree. Pick an order, paste the invoice, reconcile. The platform computes and
        records; every difference is decided by a person, and an order is settled when its last line is.
      </p>

      {error && <div className="auth-note err">{error}</div>}
      {note && !error && <div className="auth-note ok">{note}</div>}

      <div className="row" style={{ margin: "6px 0 8px" }}>
        <strong className="grow">Orders</strong>
        <button className="btn small" onClick={() => void loadOrders()} disabled={busy}>Refresh</button>
      </div>
      <div className="table-wrap">
        <table className="grid" data-testid="settlement-orders">
          <thead><tr><th>Project</th><th>Vendor</th><th>Status</th><th>Ordered</th><th>Accepted</th><th>Rejected</th><th>CPI</th><th>Placed</th><th>Settlement</th><th /></tr></thead>
          <tbody>
            {!orders && <tr><td colSpan={10} className="muted">Loading…</td></tr>}
            {orders && orders.length === 0 && <tr><td colSpan={10} className="muted">No orders have been placed with any vendor yet.</td></tr>}
            {(orders ?? []).map((o) => (
              <tr key={o.id} data-testid="settlement-order" className={o.id === selected ? "on" : undefined}>
                <td style={{ whiteSpace: "normal" }}>{o.surveyId ? <a href={`/studio/${o.surveyId}`}>{o.project ?? o.surveyId.slice(0, 8)}</a> : o.project ?? "—"}</td>
                <td>{o.vendor}{o.vendorOrderRef && <span className="mono muted"> · {o.vendorOrderRef}</span>}</td>
                <td><span className="chip">{o.status}</span></td>
                <td className="mono">{o.ordered}</td>
                <td className="mono">{o.accepted}</td>
                <td className="mono">{o.rejected}</td>
                <td className="mono">{money(o.cpi, o.currency)}</td>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{when(o.placedAt)}</td>
                <td>{o.reconciliation ? (o.reconciliation.settledAt ? <span className="chip on">settled</span> : o.reconciliation.clean ? <span className="chip on">clean</span> : <span className="chip warn">differences open</span>) : <span className="muted">not reconciled</span>}</td>
                <td><button className="btn small" onClick={() => setSelected(o.id === selected ? null : o.id)}>{o.id === selected ? "Close" : "Open"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {order && (
        <div className="card" style={{ padding: 14, marginTop: 14 }} data-testid="settlement-detail">
          <div className="card-title" style={{ marginBottom: 6 }}>{order.vendor} · {order.project ?? order.id.slice(0, 8)}</div>

          {recon ? (
            <div className="row" style={{ gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
              <div><div className="muted" style={{ fontSize: 12 }}>Claimed</div><div className="mono"><b>{recon.claimed_count}</b> · {money(Number(recon.claimed_amount), recon.currency)}</div></div>
              <div><div className="muted" style={{ fontSize: 12 }}>Agreed</div><div className="mono"><b>{recon.agreed_count}</b> · {money(Number(recon.agreed_amount), recon.currency)}</div></div>
              <div><div className="muted" style={{ fontSize: 12 }}>Payable today</div><div className="mono"><b>{recon.payable_count}</b> · {money(Number(recon.payable_amount), recon.currency)}</div></div>
              <div><div className="muted" style={{ fontSize: 12 }}>Held for review</div><div className="mono"><b>{recon.held_count}</b> · {money(Number(recon.held_amount), recon.currency)}</div></div>
              <div><div className="muted" style={{ fontSize: 12 }}>Reconciled</div><div>{when(recon.computed_at)}{recon.settled_at && <span className="chip on" style={{ marginLeft: 6 }}>settled {when(recon.settled_at)}</span>}</div></div>
              {recon.statement && <div className="muted" style={{ flexBasis: "100%", fontSize: 13 }}>{recon.statement}</div>}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>Nothing reconciled for this order yet.</p>
          )}

          <details open={!recon}>
            <summary style={{ cursor: "pointer" }}>{recon ? "Reconcile again with a new invoice" : "Reconcile the vendor's invoice"}</summary>
            <p className="muted" style={{ fontSize: 13, margin: "6px 0" }}>
              One participation per line: <span className="mono">participant id, outcome, amount</span>. Outcome and amount are optional —
              a bare id is a billable complete at the agreed CPI ({money(order.cpi, order.currency)}). Outcomes: complete, screenout, quota_full, terminate, over_quota.
            </p>
            <textarea className="input mono" rows={6} style={{ width: "100%", fontSize: 13 }} value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder={"PID-1001, complete, 3.50\nPID-1002, complete\nPID-1003, screenout, 0"} data-testid="settlement-invoice" />
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted grow" style={{ fontSize: 13 }}>{parseInvoice(invoice).claims.length} line{parseInvoice(invoice).claims.length === 1 ? "" : "s"}</span>
              <button className="btn primary" onClick={() => void reconcile()} disabled={busy} data-testid="settlement-reconcile">Reconcile</button>
            </div>
          </details>

          {recon && (
            <>
              <div className="row" style={{ margin: "14px 0 6px" }}>
                <strong className="grow">Differences</strong>
                <span className="muted" style={{ fontSize: 13 }}>{open.length ? `${open.length} waiting for a decision` : diffs.length ? "every line decided" : "none"}</span>
              </div>
              <div className="table-wrap">
                <table className="grid" data-testid="settlement-differences">
                  <thead><tr><th>Participant</th><th>Cause</th><th>Vendor</th><th>Platform</th><th>Delta</th><th>Detail</th><th>Decision</th></tr></thead>
                  <tbody>
                    {diffs.length === 0 && <tr><td colSpan={7} className="muted">The accounts agree line for line.</td></tr>}
                    {diffs.map((d) => (
                      <tr key={d.id} data-testid="settlement-difference" data-cause={d.cause} data-resolution={d.resolution ?? ""}>
                        <td className="mono">{d.participant_ref}</td>
                        <td>{CAUSE[d.cause] ?? d.cause}</td>
                        <td className="mono">{d.vendor_amount === null ? "—" : money(Number(d.vendor_amount), recon.currency)}</td>
                        <td className="mono">{d.platform_amount === null ? "—" : money(Number(d.platform_amount), recon.currency)}</td>
                        <td className="mono" style={{ color: Number(d.delta) > 0 ? "var(--c-error, #b42318)" : undefined }}>{money(Number(d.delta), recon.currency)}</td>
                        <td className="muted" style={{ whiteSpace: "normal", fontSize: 13 }}>{d.detail ?? ""}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {d.resolution
                            ? <span className="chip on">{RESOLUTIONS.find((r) => r.value === d.resolution)?.label ?? d.resolution} · {when(d.resolved_at)}</span>
                            : RESOLUTIONS.map((r) => <button key={r.value} className="btn small" style={{ marginRight: 4 }} disabled={busy} onClick={() => void decide(d.id, r.value)}>{r.label}</button>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
