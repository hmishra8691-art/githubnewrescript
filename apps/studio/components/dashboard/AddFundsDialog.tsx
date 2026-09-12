"use client";
import React from "react";
import { fmtMoney } from "@/components/billing/shared";

/**
 * ADD FUNDS TO MY WALLET.
 *
 * The platform is in simulation mode: no payment processing exists yet, and
 * credits enter the system when an administrator assigns them. The honest
 * version of this screen is therefore a REQUEST, and it says so — an amount
 * chosen here reaches an administrator, who approves it, and the credits land
 * in the wallet through the same audited path as every other credit.
 *
 * It is deliberately the shape a payment provider drops into later: a person
 * chooses an amount, and something else decides whether the money arrives.
 * When Stripe or Razorpay is connected, that step is replaced and nothing
 * about the wallet, the ledger or the projects spending from it changes.
 */

const AMOUNTS = [10, 25, 50, 100, 500];

export function AddFundsDialog({ currency, balance, onClose, onRequested }: {
  currency: string;
  balance: number;
  onClose(): void;
  onRequested(): void;
}) {
  const [amount, setAmount] = React.useState("50");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/billing/me", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add_funds", amount: value, note: note || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) { setError(d?.error ?? `Could not send the request (${r.status}).`); return; }
      setDone(`Request for ${fmtMoney(value, currency)} sent to your administrator.`);
      onRequested();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="add-funds-dialog" style={{ maxWidth: 460 }}>
        <h3 style={{ marginTop: 0 }}>Add funds</h3>

        {done ? (
          <>
            <div className="alert success" data-testid="add-funds-done">{done}</div>
            <p className="muted" style={{ fontSize: 12.5 }}>
              The credits appear in your wallet as soon as it is approved, and every project you own can use them.
            </p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="rf-avail" data-testid="add-funds-balance">
              <span className="rf-n">{fmtMoney(balance, currency)}</span>
              <span className="muted">in your wallet now</span>
            </div>

            <label className="flabel" htmlFor="af-amount">Amount</label>
            <input id="af-amount" className="input" data-testid="add-funds-amount" inputMode="decimal" autoFocus
              value={amount} onChange={(e) => setAmount(e.target.value)} />
            <div className="rf-quick">
              {AMOUNTS.map((a) => (
                <button key={a} className="btn small" data-testid={`add-funds-${a}`} onClick={() => setAmount(String(a))}>
                  {fmtMoney(a, currency)}
                </button>
              ))}
            </div>

            <label className="flabel" htmlFor="af-note">Note for your administrator <span className="muted">(optional)</span></label>
            <input id="af-note" className="input" data-testid="add-funds-note" value={note}
              onChange={(e) => setNote(e.target.value)} placeholder="What the credits are for" />

            {error && <div className="alert error" style={{ marginTop: 10 }} data-testid="add-funds-error">{error}</div>}

            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
              Card payment is not connected yet, so this sends a request to your administrator, who assigns the credits.
            </p>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" data-testid="add-funds-submit" disabled={!valid || busy} onClick={submit}>
                {busy ? "Sending…" : `Request ${valid ? fmtMoney(value, currency) : "credits"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
