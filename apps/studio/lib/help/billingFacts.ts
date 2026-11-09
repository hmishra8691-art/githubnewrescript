import type { BillableEventDef, BillingConfig } from "@rescript/billing";

/**
 * WHAT HELP MAY SAY ABOUT BILLING (2026-11-09) — the customer-facing rules of THIS installation's live configuration,
 * in sentences. Deliberately excluded: margins, provider costs, payment-processor fees, tax reserves, infrastructure
 * estimates and every rate — the charge for an operation is shown on Usage & Wallet when it happens, and Help never
 * quotes or estimates one.
 */
export function billingFacts(cfg: BillingConfig, events: BillableEventDef[], wallet?: { balance: number; reserved: number; state: string; level?: string } | null): string {
  const cur = cfg.currency;
  const m = (n: number) => `${n.toFixed(2)} ${cur}`;
  const test = cfg.testUsagePolicy === "free"
    ? "Test responses and test-link activity are not charged (test usage is free on this installation)."
    : cfg.testUsagePolicy === "discounted"
      ? `Test usage is charged at a ${cfg.testUsageDiscountPct}% discount from the live charge.`
      : "Test usage is metered like live usage on this installation.";
  const billable = events.filter((e) => e.active && e.billable);
  const free = events.filter((e) => e.active && !e.billable);
  const lines = [
    `Wallets: each project spends from its wallet (Management → Usage & Wallet); your account's overview is My usage. Amounts are in ${cur}.`,
    test,
    "A live response is a response collected through the live link (environment LIVE). Charges are recorded per operation as they happen; each one appears in Recent usage with the operation, the amount and the balance after.",
    "AI work (Intelligent Mode, AI writing, Help answers written by the model) is charged per AI request on the project it was done for. Work done with your own connected AI provider is recorded but not charged by the platform.",
    `Billable activity on this installation: ${billable.map((e) => `${e.label} (per ${e.unit})`).join("; ") || "none configured"}.`,
    free.length ? `Recorded but not charged: ${free.map((e) => e.label).join("; ")}.` : "",
    `Balance thresholds: below ${m(cfg.lowBalanceThreshold)} the wallet is shown as low, below ${m(cfg.criticalBalanceThreshold)} as critical; at or below ${m(cfg.readOnlyThreshold)} the project becomes read-only${cfg.lockRespondentsWhenReadOnly ? " and stops taking new live interviews" : ""}${cfg.allowExportsWhenReadOnly ? "; exports still work while read-only" : ""}.`,
    cfg.minimumRemainingBalance > 0 ? `An operation may not take the balance below ${m(cfg.minimumRemainingBalance)}.` : "",
    cfg.overdraftEnabled ? `Overdraft is on: the balance may go negative down to −${m(cfg.overdraftLimit)}.` : "Overdraft is off: an operation that the balance cannot cover is refused rather than run.",
    "Before an AI or other metered operation runs, its likely cost is reserved and then settled at the actual amount; a reservation that is not used is released.",
    "A project can also have a spending limit (Usage & Wallet → Spending limit); at the limit it stops spending even if the wallet has funds. You can ask an administrator for more credits from Usage & Wallet (Request additional credits).",
    wallet ? `This project's wallet right now: ${m(wallet.balance)} balance, ${m(wallet.reserved)} reserved${wallet.level && wallet.level !== "normal" ? ` (${wallet.level})` : ""}, state ${wallet.state}.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
