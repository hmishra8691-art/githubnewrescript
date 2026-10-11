"use client";
import React from "react";
import { Icon } from "../ui/Icon";
import { LEVEL_CLASS, LEVEL_WORD, fmtMoney } from "./shared";

/**
 * THE COMPACT WALLET (dashboard brief §3): the balance as `$125.50` in the
 * top-right of every signed-in page, coloured by level, with the wallet's
 * actions behind it — add funds, usage and billing, the transaction history.
 * It reads `/api/billing/wallet` (the person's wallet and nothing else), so it
 * is the same figure the usage pages show and never a project's spend. The
 * precise balance (six decimals) is kept in the title; the display is two.
 * Re-reads itself when a `rescript:wallet-changed` event is dispatched (after
 * a credit request, a transfer) so the figure follows what just happened.
 */
export interface WalletBrief { currency: string; balance: number; available: number; reserved: number; level: string; state: string; totalAdded: number; totalUsed: number }

const short = (n: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function WalletMenu({ onAddFunds, inStudio = false }: { onAddFunds?: () => void; inStudio?: boolean }) {
  const [wallet, setWallet] = React.useState<WalletBrief | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "off">("loading");
  const [open, setOpen] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      const r = await fetch("/api/billing/wallet", { cache: "no-store" });
      const j = await r.json().catch(() => null) as { ok?: boolean; wallet?: WalletBrief } | null;
      if (!r.ok || !j?.ok || !j.wallet) { setState("off"); return; }
      setWallet(j.wallet); setState("ready");
    } catch { setState("off"); }
  }, []);
  React.useEffect(() => { void load(); const again = () => void load(); window.addEventListener("rescript:wallet-changed", again); return () => window.removeEventListener("rescript:wallet-changed", again); }, [load]);
  if (state !== "ready" || !wallet) return null;
  const level = wallet.state === "suspended" ? "locked" : wallet.level;
  const word = wallet.state === "suspended" ? "Suspended" : wallet.state === "read_only" ? "Empty" : LEVEL_WORD[level as keyof typeof LEVEL_WORD] ?? level;
  return (
    <div className="menu-anchor wallet-menu" data-testid="wallet-menu" data-level={level} data-state={wallet.state}>
      <button type="button" className={`wallet-pill ${level}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        title={`My wallet: ${fmtMoney(wallet.balance, wallet.currency)} available${wallet.reserved > 0 ? ` · ${fmtMoney(wallet.reserved, wallet.currency)} held by work in progress` : ""} — ${word}`} data-testid="wallet-pill">
        <Icon name="chart" size={13} /> <span data-testid="wallet-pill-balance">{short(wallet.balance, wallet.currency)}</span>
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu wallet-menu-panel" role="menu" data-testid="wallet-menu-panel">
            <div className="wallet-menu-head">
              <div className="muted" style={{ fontSize: 12 }}>My wallet</div>
              <div className="wallet-menu-balance" data-testid="wallet-menu-balance">{fmtMoney(wallet.balance, wallet.currency)}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                <span className={`badge ${LEVEL_CLASS[level as keyof typeof LEVEL_CLASS] ?? ""}`} data-testid="wallet-menu-level">{word}</span>
                {" "}{fmtMoney(wallet.totalUsed, wallet.currency)} used of {fmtMoney(wallet.totalAdded, wallet.currency)} added
                {wallet.reserved > 0 ? ` · ${fmtMoney(wallet.reserved, wallet.currency)} held` : ""}
              </div>
            </div>
            <div className="menu-sep" />
            {onAddFunds
              ? <button type="button" className="menu-item" role="menuitem" data-testid="wallet-add-funds" onClick={() => { setOpen(false); onAddFunds(); }}><Icon name="plus" size={15} /> Add funds</button>
              : <a className="menu-item" role="menuitem" href="/billing#add-funds" data-testid="wallet-add-funds"><Icon name="plus" size={15} /> Add funds</a>}
            <a className="menu-item" role="menuitem" href="/billing" data-testid="wallet-usage"><Icon name="chart" size={15} /> Usage &amp; billing</a>
            <a className="menu-item" role="menuitem" href="/billing#transactions" data-testid="wallet-transactions"><Icon name="table" size={15} /> Transaction history</a>
            {inStudio && <div className="menu-sep" />}
            {inStudio && <span className="menu-note muted" style={{ fontSize: 12, padding: "4px 12px", display: "block" }}>A project's own spend is shown beside Mode and in Usage &amp; Wallet.</span>}
          </div>
        </>
      )}
    </div>
  );
}
