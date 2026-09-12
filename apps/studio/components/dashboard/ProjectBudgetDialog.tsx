"use client";
import React from "react";
import { fmtMoney } from "@/components/billing/shared";

/**
 * HOW MUCH OF MY WALLET THIS PROJECT MAY SPEND.
 *
 * The thing this dialog has to teach, because it is the whole point of the
 * model and it is genuinely surprising the first time: **setting a limit
 * moves no money.** There is one wallet. A limit is permission against it,
 * not a pot carved out of it — so a project set to $1 does not take $1 from
 * anywhere, and raising that project to $100 does not take $99 either. The
 * balance is identical before and after, and the dialog says so where the
 * person is about to press the button rather than in a help page.
 *
 * Three modes, and the middle one is the only one with a number:
 *
 *   Shared     — spends freely from the wallet, like every other shared
 *                project; stops only when the wallet does.
 *   Limit      — may consume at most this much, ever; at the limit the
 *                PROJECT freezes and the rest of the wallet carries on.
 *   Priority   — shared, and marked as the study the wallet is mainly for.
 *                It grants no extra privilege, deliberately: with the other
 *                projects capped it already has what they cannot take, and a
 *                second mechanism would be a second answer to the same
 *                question.
 *
 * A frozen project is released the moment its limit rises above what it has
 * already spent — in the same request, because a person who has just granted
 * more room should not then have to find a switch that says "and start it
 * again".
 */

const QUICK = [1, 25, 50, 100, 250];

export interface BudgetState {
  mode: "shared" | "budget" | "priority";
  limit: number | null;
  used: number;
  currency: string;
  walletRemaining: number;
  state: "active" | "frozen" | "read_only" | "suspended";
}

export function ProjectBudgetDialog({ project, meter, onClose, onSaved }: {
  project: { id: string; title: string; code: string };
  meter: BudgetState;
  onClose(): void;
  onSaved(): void;
}) {
  const [mode, setMode] = React.useState<BudgetState["mode"]>(meter.mode);
  const [limit, setLimit] = React.useState<string>(meter.limit == null ? "" : String(meter.limit));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const value = Number(limit);
  const limitValid = mode !== "budget" || (Number.isFinite(value) && value >= 0);
  /* a limit below what has already been spent is legal — it freezes the
     project at once — but the person should not discover that afterwards */
  const belowSpend = mode === "budget" && limitValid && value < meter.used;

  const save = async () => {
    if (!limitValid || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/surveys/${project.id}/billing`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_spending", mode, limit: mode === "budget" ? value : null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) { setError(d?.error ?? `Could not save (${r.status}).`); return; }
      setDone(mode === "budget"
        ? `${project.title} may spend up to ${fmtMoney(value, meter.currency)} of your wallet.`
        : mode === "priority"
          ? `${project.title} is your priority project and spends freely from your wallet.`
          : `${project.title} spends freely from your wallet.`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="budget-dialog" style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>Spending limit</h3>
        <p className="muted" style={{ marginTop: -6 }}>
          {project.title} <span className="mono">{project.code}</span>
        </p>

        {done ? (
          <>
            <div className="alert success" data-testid="budget-done">{done}</div>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="rf-avail" data-testid="budget-context">
              <span className="rf-n">{fmtMoney(meter.used, meter.currency)}</span>
              <span className="muted">
                spent by this project · your wallet holds {fmtMoney(meter.walletRemaining, meter.currency)}
              </span>
            </div>

            <div className="bd-modes" data-testid="budget-modes">
              {([
                ["shared", "Shared wallet", "Spends freely from your wallet, stopping only when the wallet does."],
                ["budget", "Spending limit", "May spend up to an amount you set. At the limit this project stops; the rest of your wallet is untouched."],
                ["priority", "Priority project", "Spends freely, and is marked as the study this wallet is mainly for."],
              ] as const).map(([key, label, help]) => (
                <label key={key} className={`bd-mode ${mode === key ? "on" : ""}`} data-testid={`budget-mode-${key}`}>
                  <input type="radio" name="spending-mode" checked={mode === key} onChange={() => setMode(key)} />
                  <span>
                    <strong>{label}</strong>
                    <span className="muted"> — {help}</span>
                  </span>
                </label>
              ))}
            </div>

            {mode === "budget" && (
              <>
                <label className="flabel" htmlFor="bd-limit">This project may spend up to</label>
                <input id="bd-limit" className="input" data-testid="budget-limit" inputMode="decimal"
                  value={limit} onChange={(e) => setLimit(e.target.value)} autoFocus placeholder="0.00" />
                <div className="rf-quick">
                  {QUICK.map((q) => (
                    <button key={q} className="btn small" data-testid={`budget-quick-${q}`} onClick={() => setLimit(String(q))}>
                      {fmtMoney(q, meter.currency)}
                    </button>
                  ))}
                </div>
                {belowSpend && (
                  <div className="alert warning" data-testid="budget-below-spend">
                    This project has already spent {fmtMoney(meter.used, meter.currency)}, so a limit of
                    {" "}{fmtMoney(value, meter.currency)} stops it immediately. Nothing already spent is refunded.
                  </div>
                )}
              </>
            )}

            {error && <div className="alert error" style={{ marginTop: 10 }} data-testid="budget-error">{error}</div>}

            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }} data-testid="budget-explainer">
              A limit moves no money. You have one wallet; this only decides how much of it this project is allowed to
              consume{meter.state === "frozen" ? ", and raising it above what has been spent starts the project again" : ""}.
            </p>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" data-testid="budget-save" disabled={!limitValid || busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
