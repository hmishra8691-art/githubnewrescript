/**
 * Money arithmetic. Amounts are decimal currency units (dollars) held to six
 * places — a single AI request can cost $0.000375, and a ledger that rounds
 * that to a cent loses the audit. Display rounds to cents; storage never does.
 */

export const SCALE = 1_000_000;

/** Round to six decimal places, killing float noise (0.1 + 0.2 → 0.3). */
export function money6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * SCALE) / SCALE;
}

/** Sum a list of amounts exactly (integer micro-units). */
export function sumMoney(ns: Iterable<number>): number {
  let micro = 0;
  for (const n of ns) micro += Math.round((Number.isFinite(n) ? n : 0) * SCALE);
  return micro / SCALE;
}

/** Cents for display: "$57.27". Negative amounts keep their sign. */
export function formatMoney(n: number, currency = "USD", opts: { cents?: boolean } = {}): string {
  const v = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  // small per-operation charges would all read "$0.00" at two places; show what is there
  const digits = opts.cents === false || abs === 0 || abs >= 0.01 ? 2 : abs >= 0.001 ? 4 : 6;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  } catch {
    return `${v < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
  }
}

export function pctOf(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 10000) / 100;
}
