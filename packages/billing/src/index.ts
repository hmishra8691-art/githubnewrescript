/**
 * @rescript/billing — project-level metered usage, wallets and cost
 * allocation. Pure arithmetic and a store contract; the applications plug in
 * a database store (Supabase) or the in-memory one (sandbox, tests).
 *
 *   config.ts     BillingConfig — every tunable number, with defaults
 *   pricing.ts    actual cost → customer charge, every component kept apart
 *   registry.ts   billable events and provider rates (the cost registry)
 *   wallet.ts     wallet / ledger / usage records and the dashboard arithmetic
 *   meter.ts      the metering engine: estimate → reserve → run → settle
 *   store-*.ts    persistence
 *
 * Nothing here processes a payment. A deposit is a ledger credit written by
 * an administrator; when real payments arrive they will write the same line.
 */
export * from "./config.js";
export * from "./money.js";
export * from "./pricing.js";
export * from "./registry.js";
export * from "./wallet.js";
export * from "./meter.js";
export * from "./store-memory.js";
export * from "./store-supabase.js";
