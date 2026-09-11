"use client";
import React from "react";
import { fmtMoney } from "@/components/billing/shared";

/**
 * REFILL A PROJECT'S WALLET, FROM THE PROJECTS PAGE.
 *
 * THE RULE THIS DIALOG EXISTS TO KEEP: a refill never creates credits. It
 * MOVES them from a wallet that already holds them, through the transfer the
 * platform already has — one atomic SQL function, two ledger lines under one
 * transfer id, and never more than the source's available balance. There is
 * no code path here that adds to a balance; both buttons call an endpoint
 * that writes a ledger entry, and the balance is what the ledger says.
 *
 * Two ways to put credits in, and they are different acts:
 *
 *   · MY CREDITS → this project. Anyone with credits of their own, moving
 *     what is already theirs. This is a transfer: their balance goes down by
 *     exactly what the project's goes up by.
 *
 *   · ASSIGN CREDITS. A platform administrator issuing new credits, which is
 *     how credits enter the system at all while the platform is in
 *     simulation mode. It is labelled as what it is, and offered to nobody
 *     else — the difference between moving money and making it is the whole
 *     of this permission model, so the dialog says which one is about to
 *     happen rather than presenting one "Add credits" button that sometimes
 *     means the other.
 *
 * A project that has stopped comes back on its own: the credit lands, the
 * SQL recomputes the wallet's state from its new balance, and READ_ONLY
 * clears in the same transaction. Nobody has to go and flip a status.
 */

const QUICK = [25, 50, 100, 250];

interface MyWallet { balance: number; reserved: number; available: number; currency: string }

export function RefillWalletDialog({ project, currency, isPlatformAdmin, onClose, onDone }: {
  project: { id: string; title: string; code: string };
  /** what the project's wallet holds now, for the "current balance" line */
  currency: string;
  isPlatformAdmin: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const [mode, setMode] = React.useState<"transfer" | "assign">("transfer");
  const [wallet, setWallet] = React.useState<MyWallet | null>(null);
  const [walletLoaded, setWalletLoaded] = React.useState(false);
  const [amount, setAmount] = React.useState<string>("50");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch("/api/billing/transfer");
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        setWallet(d?.wallet ?? null);
        /* an administrator with nothing of their own to move starts on the
           mode that will actually work, rather than on a refusal */
        if (isPlatformAdmin && !(d?.wallet?.available > 0)) setMode("assign");
      } catch { /* the dialog still works; the available line just says — */ }
      finally { if (live) setWalletLoaded(true); }
    })();
    return () => { live = false; };
  }, [isPlatformAdmin]);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;
  const over = mode === "transfer" && valid && wallet != null && value > wallet.available;

  const submit = async () => {
    if (!valid || over || busy) return;
    setBusy(true); setError(null);
    try {
      const r = mode === "assign"
        ? await fetch("/api/admin/billing/credit", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ surveyId: project.id, amount: value, reason: "Project wallet refill", note: note || null }),
          })
        : await fetch("/api/billing/transfer", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ toProjectId: project.id, amount: value, message: note || null }),
          });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) { setError(d?.error ?? `Refill failed (${r.status}).`); return; }
      setDone(`${fmtMoney(value, currency)} added to ${project.title}.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="refill-dialog" style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>Refill project wallet</h3>
        <p className="muted" style={{ marginTop: -6 }}>
          {project.title} <span className="mono">{project.code}</span>
        </p>

        {done ? (
          <>
            <div className="alert success" data-testid="refill-done">{done}</div>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            {isPlatformAdmin && (
              <div className="row" style={{ gap: 6, marginBottom: 10 }} data-testid="refill-mode">
                <button className={`btn small ${mode === "transfer" ? "primary" : ""}`} onClick={() => setMode("transfer")}>
                  From my credits
                </button>
                <button className={`btn small ${mode === "assign" ? "primary" : ""}`} onClick={() => setMode("assign")}
                  title="Issue new credits as an administrator — recorded in the ledger as an assignment, not a transfer">
                  Assign credits
                </button>
              </div>
            )}

            <div className="rf-avail" data-testid="refill-available">
              <span className="rf-n">
                {mode === "assign" ? "—" : !walletLoaded ? "…" : fmtMoney(wallet?.available ?? 0, wallet?.currency ?? currency)}
              </span>
              <span className="muted">
                {mode === "assign"
                  ? "Assigned credits are issued by you as an administrator"
                  : "of your own credits available to move"}
              </span>
            </div>

            <label className="flabel" htmlFor="rf-amount">Amount to add</label>
            <input id="rf-amount" className="input" data-testid="refill-amount" inputMode="decimal"
              value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            <div className="rf-quick">
              {QUICK.map((q) => (
                <button key={q} className="btn small" data-testid={`refill-quick-${q}`} onClick={() => setAmount(String(q))}>
                  {fmtMoney(q, currency)}
                </button>
              ))}
            </div>

            <label className="flabel" htmlFor="rf-note">Reason / note <span className="muted">(optional)</span></label>
            <input id="rf-note" className="input" data-testid="refill-note" value={note}
              onChange={(e) => setNote(e.target.value)} placeholder="What these credits are for" />

            {over && (
              <div className="alert warning" style={{ marginTop: 10 }} data-testid="refill-over">
                That is more than your available credits ({fmtMoney(wallet?.available ?? 0, wallet?.currency ?? currency)}).
                Credits held by work in progress cannot be moved.
              </div>
            )}
            {error && <div className="alert error" style={{ marginTop: 10 }} data-testid="refill-error">{error}</div>}

            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
              {mode === "assign"
                ? "This issues new credits to the project and is recorded in the billing ledger against your name."
                : "This moves credits from your wallet to this project. Your balance goes down by the same amount."}
            </p>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" data-testid="refill-confirm" disabled={!valid || over || busy} onClick={submit}>
                {busy ? "Adding…" : `Add ${valid ? fmtMoney(value, currency) : "credits"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
