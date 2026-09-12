import { test } from "node:test";
import assert from "node:assert/strict";
import { billingConfig, DEFAULT_BILLING_CONFIG } from "./config.js";
import { priceOperation, effectivePaymentFeeRate, depositProjection } from "./pricing.js";
import { DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS, findRate, providerCostFor, registerBillableEvent } from "./registry.js";
import { Meter, estimateTokens } from "./meter.js";
import { MemoryMeterStore } from "./store-memory.js";
import {
  summarizeWallet, usageByCategory, usageTimeline, forecastUsage, balanceLevel, READ_ONLY_MESSAGE, transferableBalance, walletKind,
  projectMeter, walletOverview, defaultSpending, projectHeadroom, type ProjectSpending, type Wallet,
} from "./wallet.js";
import { money6, formatMoney } from "./money.js";

const cfg = billingConfig({});

test("the pricing engine keeps every component apart and never deducts raw cost", () => {
  // $10 actual cost, 50% target margin, 6.5% + $0.30/100 processor, no reserve
  const b = priceOperation({ providerCost: 10 }, cfg);
  const fee = effectivePaymentFeeRate(cfg); // 0.068
  assert.equal(money6(fee), 0.068);
  assert.equal(b.customerCharge, money6(10 / (1 - 0.5 - 0.068)));  // 23.148148
  assert.ok(b.customerCharge > 15, "not simply cost + 50%");
  assert.equal(b.actualCost, 10);
  assert.equal(b.grossProfit, money6(b.customerCharge - 10));
  assert.equal(b.paymentFee, money6(b.customerCharge * fee));
  assert.equal(b.taxReserve, 0);
  assert.equal(b.netProfit, money6(b.grossProfit - b.paymentFee));
  assert.equal(b.marginPct, 50, "the platform keeps exactly the configured share of the charge");
  assert.equal(b.grossMarginPct, Math.round((b.grossProfit / b.customerCharge) * 10000) / 100);
});

test("configuration, not code, decides the model: markup model, reserve, infra markup, minimum charge", () => {
  const c2 = billingConfig({ pricingModel: "markup", targetMarginPct: 50, paymentProcessorFeePct: 0, paymentProcessorFixedFee: 0, taxReservePct: 10, infrastructureMarkupPct: 100 });
  const b = priceOperation({ providerCost: 10, infraCost: 1 }, c2);
  // base = 10 + 1 + 1 (infra marked up 100%) = 12; ×1.5 = 18; grossed up for 10% reserve → 20
  assert.equal(b.infraMarkup, 1);
  assert.equal(b.customerCharge, 20);
  assert.equal(b.taxReserve, 2);
  assert.equal(b.netProfit, money6(20 - 11 - 2));
  const tiny = priceOperation({ providerCost: 0.000001 }, billingConfig({ minimumChargePerOperation: 0.01 }));
  assert.equal(tiny.customerCharge, 0.01); assert.equal(tiny.minimumApplied, true);
  const free = priceOperation({ providerCost: 0 }, cfg);
  assert.equal(free.customerCharge, 0, "zero cost (cached result) is never charged the minimum");
});

test("TEST usage follows the policy: free, discounted or metered; the cost is still recorded", () => {
  const free = priceOperation({ providerCost: 1 }, billingConfig({ testUsagePolicy: "free" }), { environment: "TEST" });
  assert.equal(free.customerCharge, 0); assert.equal(free.providerCost, 1); assert.equal(free.testAdjustment, "free");
  const disc = priceOperation({ providerCost: 1 }, billingConfig({ testUsagePolicy: "discounted", testUsageDiscountPct: 50 }), { environment: "TEST" });
  const live = priceOperation({ providerCost: 1 }, cfg, { environment: "LIVE" });
  assert.ok(Math.abs(disc.customerCharge - live.customerCharge / 2) < 1e-5);
  const metered = priceOperation({ providerCost: 1 }, billingConfig({ testUsagePolicy: "metered" }), { environment: "TEST" });
  assert.equal(metered.customerCharge, live.customerCharge);
});

test("the cost registry: exact model, provider fallback, effective dates, per-million units", () => {
  const google = findRate(DEFAULT_RATES, { provider: "google", service: "translate", model: "v2" });
  assert.equal(google?.id, "google.translate.v2");
  assert.equal(providerCostFor(google, 25_000), money6(25_000 / 1e6 * 20)); // $0.50 for 25k characters
  const unknownModel = findRate(DEFAULT_RATES, { provider: "openai-compatible", service: "chat", model: "some-new-model", side: "input" });
  assert.equal(unknownModel?.id, "ai.chat.*.in", "an unknown model is priced by the fallback row, never free");
  const claude = findRate(DEFAULT_RATES, { provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", side: "output" });
  assert.equal(providerCostFor(claude, 1000), 0.015);
  const dated = [
    { ...google!, id: "old", providerCost: 10, effectiveUntil: "2026-01-01" },
    { ...google!, id: "new", providerCost: 20, effectiveFrom: "2026-01-01" },
  ];
  assert.equal(findRate(dated, { provider: "google", service: "translate", model: "v2", at: "2025-06-01" })?.id, "old");
  assert.equal(findRate(dated, { provider: "google", service: "translate", model: "v2", at: "2026-06-01" })?.id, "new");
  assert.equal(findRate(DEFAULT_RATES, { provider: "nobody", service: "x" }), null);
});

test("the event registry is extensible and every default event has a category and a unit", () => {
  for (const e of DEFAULT_BILLABLE_EVENTS) { assert.ok(e.category); assert.ok(e.unit); }
  const ext = registerBillableEvent(DEFAULT_BILLABLE_EVENTS, { type: "IMAGE_GENERATION", label: "Image generated", category: "ai", unit: "item", billable: true, rate: { provider: "openai-compatible", service: "image", model: null }, description: "", active: true });
  assert.equal(ext.length, DEFAULT_BILLABLE_EVENTS.length + 1);
  assert.throws(() => registerBillableEvent([], { type: "bad-name", label: "x", category: "ai", unit: "item", billable: true, description: "", active: true } as never));
});

async function fixture(balance = 100, cfgPatch: Record<string, unknown> = {}) {
  const store = new MemoryMeterStore();
  store.config = cfgPatch;
  const meter = new Meter(store, { cacheMs: 0 });
  const ctx = { customerId: "cust-1", surveyId: "proj-A", userId: "user-1", environment: "LIVE" as const };
  const wallet = (await meter.walletFor(ctx))!;
  if (balance) await meter.credit(wallet.id, balance, { reason: "trial_credits", by: "admin" });
  return { store, meter, ctx, walletId: wallet.id };
}

test("reserve → settle debits the ACTUAL charge and releases the rest; every step is a ledger line", async () => {
  const { store, meter, ctx, walletId } = await fixture(100);
  // an AI call: estimate with the prompt and max_tokens, settle with what the model really used
  const hold = await meter.reserve(ctx, { eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", inputUnits: 4000, outputUnits: 1200 });
  assert.ok(hold.ok);
  const w1 = (await store.getWallet(walletId))!;
  assert.ok(w1.reserved > 0 && w1.reserved === hold.reservation!.reservedAmount);
  assert.equal(w1.balance, 100, "a reservation holds; it does not debit");
  const ev = await meter.settle(hold, { inputUnits: 3900, outputUnits: 240 });
  const w2 = (await store.getWallet(walletId))!;
  assert.equal(w2.reserved, 0);
  assert.equal(ev.providerCost, money6(3900 / 1e6 * 3 + 240 / 1e6 * 15));
  assert.ok(ev.customerCharge < hold.reservation!.reservedAmount, "settled below the reservation");
  assert.equal(w2.balance, money6(100 - ev.customerCharge));
  assert.equal(w2.totalUsed, ev.customerCharge);
  const ledger = await store.listLedger(walletId);
  assert.deepEqual(ledger.map((l) => l.kind), ["debit", "credit"]);
  assert.equal(ledger[0].usageEventId, ev.id);
  assert.equal(ev.category, "ai"); assert.equal(ev.environment, "LIVE"); assert.equal(ev.inputUnits, 3900);
});

test("no negative balance: the last dollar cannot be spent twice; overdraft is a switch", async () => {
  const { meter, ctx } = await fixture(0.5, { minimumChargePerOperation: 0 });
  const spec = { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 12_000 }; // ≈ $0.24 cost → ≈ $0.56 charge
  const a = await meter.reserve(ctx, spec);
  assert.equal(a.ok, false);
  if (!a.ok) { assert.equal(a.reason, "insufficient_balance"); assert.match(a.message, /Insufficient balance/); }
  const small = await meter.reserve(ctx, { ...spec, quantity: 5000 });   // ≈ $0.23
  assert.ok(small.ok);
  const second = await meter.reserve(ctx, { ...spec, quantity: 5000 }); // 0.5 − 0.23 reserved − 0.23 ≥ 0 → ok
  assert.ok(second.ok);
  const third = await meter.reserve(ctx, { ...spec, quantity: 5000 });  // would go below zero
  assert.equal(third.ok, false, "concurrent reservations cannot overdraw");
  await meter.release(small as never); await meter.release(second as never);

  const od = await fixture(0.1, { overdraftEnabled: true, overdraftLimit: 5, minimumChargePerOperation: 0 });
  const r = await od.meter.reserve(od.ctx, spec);
  assert.ok(r.ok, "overdraft on: the operation is allowed down to −limit");
  const ev = await od.meter.settle(r);
  assert.ok((await od.store.getWallet(od.walletId))!.balance < 0);
  assert.ok(ev.customerCharge > 0);
});

test("a wallet at its limit becomes READ_ONLY automatically and refuses billable work with the specified message; credits reopen it", async () => {
  const { store, meter, ctx, walletId } = await fixture(0.3, { minimumChargePerOperation: 0 });
  const r = await meter.record(ctx, { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 6000 }); // ≈ $0.28
  assert.ok(r.ok);
  const w = (await store.getWallet(walletId))!;
  assert.equal(w.state, "active", "still above zero");
  const r2 = await meter.record(ctx, { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 300 }); // takes it to ~0
  assert.ok(r2.ok);
  const w2 = (await store.getWallet(walletId))!;
  assert.ok(w2.balance <= 0.02);
  const r3 = await meter.record(ctx, { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 3000 });
  assert.equal(r3.ok, false);
  // exactly zero → read_only
  const w3 = (await store.getWallet(walletId))!;
  if (w3.balance <= 0) {
    assert.equal(w3.state, "read_only");
    assert.equal((await meter.check(ctx)).allowed, false);
    assert.equal((await meter.check(ctx)).message, READ_ONLY_MESSAGE);
  }
  await meter.credit(walletId, 50, { reason: "credits_added", by: "admin" });
  const w4 = (await store.getWallet(walletId))!;
  assert.equal(w4.state, "active"); assert.equal(w4.totalAdded, money6(0.3 + 50));
  assert.equal((await meter.check(ctx)).allowed, true);
});

test("project isolation: project A's usage never touches project B's wallet; a shared wallet is explicit", async () => {
  const { store, meter, ctx } = await fixture(100);
  const ctxB = { ...ctx, surveyId: "proj-B" };
  const wB = (await meter.walletFor(ctxB))!;
  await meter.credit(wB.id, 10, { reason: "trial", by: "admin" });
  await meter.record(ctx, { eventType: "SURVEY_RESPONSE", quantity: 10 });
  assert.equal((await store.getWallet(wB.id))!.balance, 10);
  assert.ok((await meter.walletFor(ctx))!.balance < 100);
  // explicit sharing: B draws from A
  await store.setWallet(wB.id, { sharedWalletId: (await meter.walletFor(ctx))!.id });
  const before = (await meter.walletFor(ctx))!.balance;
  await meter.record(ctxB, { eventType: "SURVEY_RESPONSE", quantity: 1 });
  assert.ok((await meter.walletFor(ctx))!.balance < before, "B's response was paid by the shared wallet");
  assert.equal((await store.getWallet(wB.id))!.balance, 10);
});

test("TEST usage is separately identifiable and free by default; non-billable events are recorded at $0 with their cost", async () => {
  const { meter, ctx, store, walletId } = await fixture(100);
  const t = await meter.record({ ...ctx, environment: "TEST" }, { eventType: "SURVEY_RESPONSE", quantity: 1 });
  assert.ok(t.ok); assert.equal(t.event.customerCharge, 0); assert.equal(t.event.environment, "TEST"); assert.equal(t.event.infraCost, 0.002);
  const render = await meter.record(ctx, { eventType: "SURVEY_RENDER", quantity: 1 });
  assert.ok(render.ok); assert.equal(render.event.customerCharge, 0); assert.equal(render.event.metadata.billable, false);
  assert.equal((await store.getWallet(walletId))!.balance, 100);
  assert.equal((await store.listUsage({ surveyId: "proj-A", environment: "TEST" })).length, 1);
});

test("usage is never overwritten: a correction is a reversal event that credits the wallet back", async () => {
  const { meter, ctx, store, walletId } = await fixture(100);
  const r = await meter.record(ctx, { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 100_000 });
  assert.ok(r.ok);
  const afterDebit = (await store.getWallet(walletId))!.balance;
  const rev = await meter.reverse(r.event.id, "admin", "double-billed batch");
  assert.ok(rev);
  assert.equal(rev!.reversal.adjustsEventId, r.event.id);
  assert.equal(rev!.reversal.customerCharge, -r.event.customerCharge);
  assert.equal((await store.getWallet(walletId))!.balance, money6(afterDebit + r.event.customerCharge));
  assert.equal((await store.getUsage(r.event.id))!.customerCharge, r.event.customerCharge, "the original stands");
  assert.equal(await meter.reverse(rev!.reversal.id, "admin", "again"), null, "a reversal cannot be reversed");
});

test("wallet summary, categories, timeline, forecast and levels", async () => {
  const { meter, ctx, store, walletId } = await fixture(100);
  await meter.record(ctx, { eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: "gpt-4o-mini", inputUnits: 10_000, outputUnits: 2_000 });
  await meter.record(ctx, { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 18_200 });
  await meter.record(ctx, { eventType: "SURVEY_RESPONSE", quantity: 250 });
  const wallet = (await store.getWallet(walletId))!;
  const events = await store.listUsage({ walletId });
  const ledger = await store.listLedger(walletId);
  const s = summarizeWallet(wallet, ledger, events, cfg);
  assert.equal(s.initialBalance, 100); assert.equal(s.totalAdded, 100);
  assert.equal(s.used, money6(events.reduce((a, e) => a + e.customerCharge, 0)));
  assert.equal(s.remaining, money6(100 - s.used));
  assert.equal(money6(s.costs.providerCost + s.costs.infraCost + s.costs.paymentFee + s.costs.taxReserve + s.costs.netProfit), s.used, "the breakdown adds up to what was used");
  assert.equal(s.usage.today, s.used);
  const cats = usageByCategory(events);
  assert.deepEqual(new Set(cats.map((c) => c.category)), new Set(["ai", "translation", "responses"]));
  const tl = usageTimeline(events, 7);
  assert.equal(tl.length, 7); assert.equal(tl[6].charge, s.used);
  const f = forecastUsage(wallet.balance, events, cfg);
  assert.equal(f.averageDailyUsage, money6(s.used / 7));
  assert.equal(f.estimatedRemainingDays, Math.floor(wallet.balance / f.averageDailyUsage));
  assert.equal(f.trendPct, null, "no previous window yet");
  assert.equal(balanceLevel(57.27, cfg), "normal"); assert.equal(balanceLevel(20, cfg), "low"); assert.equal(balanceLevel(5, cfg), "critical"); assert.equal(balanceLevel(0, cfg), "locked");
});

test("a deposit projection and money formatting", () => {
  const p = depositProjection(100, DEFAULT_BILLING_CONFIG);
  assert.equal(p.paymentFee, 6.8); assert.equal(p.platformMargin, 50); assert.equal(p.availableForCosts, 43.2);
  assert.equal(formatMoney(57.27), "$57.27"); assert.equal(formatMoney(0.00084), "$0.000840"); assert.equal(formatMoney(-1.5), "-$1.50");
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("credit requests: submitted by the researcher, decided by the administrator, approval credits the wallet through the ledger", async () => {
  const { meter, ctx, store, walletId } = await fixture(1);
  const req = await store.createCreditRequest({ customerId: ctx.customerId, surveyId: ctx.surveyId, walletId, userId: ctx.userId!, requestedAmount: 100, reason: "Fieldwork extension", message: "500 more interviews" });
  assert.equal(req.status, "pending");
  assert.equal((await store.listCreditRequests({ status: "pending" })).length, 1);
  const decided = await store.decideCreditRequest(req.id, { status: "approved", by: "admin", amount: 80, note: "80 for now" });
  assert.equal(decided.decidedAmount, 80);
  await meter.credit(walletId, 80, { reason: "credit_request_approved", by: "admin", note: req.id });
  assert.equal((await store.getWallet(walletId))!.balance, 81);
  await assert.rejects(() => store.decideCreditRequest(req.id, { status: "rejected", by: "admin", amount: null, note: null }), /already decided/);
});

test("credit transfer: only the available (unreserved) balance moves, atomically, as two ledger lines sharing one transfer id", async () => {
  const { store, meter, ctx, walletId: a } = await fixture(100);
  const b = (await meter.walletFor({ ...ctx, surveyId: "proj-B" }))!.id;
  await meter.record(ctx, { eventType: "SURVEY_RESPONSE", quantity: 1, providerCost: 0, infraCost: 0 }); // tiny debit
  const hold = await meter.reserve(ctx, { eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 400_000 }); // ≈ $18.5 held
  assert.ok(hold.ok);
  const wa = { ...(await store.getWallet(a))! };
  const avail = transferableBalance(wa);
  assert.ok(avail < wa.balance && avail > 0, "reserved money is not available");
  const tooMuch = await meter.transfer({ sourceWalletId: a, destinationWalletId: b, amount: avail + 1, by: "admin" });
  assert.equal(tooMuch.ok, false); if (!tooMuch.ok) { assert.equal(tooMuch.reason, "insufficient_available"); assert.match(tooMuch.message, /available to transfer/); }
  assert.equal((await meter.transfer({ sourceWalletId: a, destinationWalletId: a, amount: 1, by: "admin" })).ok, false, "same wallet refused");
  assert.equal((await meter.transfer({ sourceWalletId: a, destinationWalletId: b, amount: 0, by: "admin" })).ok, false, "zero refused");
  const r = await meter.transfer({ sourceWalletId: a, destinationWalletId: b, amount: 25, reason: "Unused project credits", note: "moving to B", by: "admin" });
  assert.ok(r.ok);
  assert.equal(r.source.balance, money6(wa.balance - 25)); assert.equal(r.destination.balance, 25);
  assert.equal(r.destination.totalAdded, 25, "credits arrived count as added on the destination");
  assert.equal(r.source.totalAdded, wa.totalAdded, "the source's history of what was added is untouched");
  assert.match(r.transfer.code, /^TRX-\d+$/); assert.equal(r.transfer.status, "completed"); assert.equal(r.transfer.sourceKind, "project"); assert.equal(r.transfer.sourceRef, "proj-A"); assert.equal(r.transfer.destinationRef, "proj-B");
  const la = (await store.listLedger(a)).find((l) => l.transferId === r.transfer.id)!; const lb = (await store.listLedger(b)).find((l) => l.transferId === r.transfer.id)!;
  assert.equal(la.kind, "transfer_out"); assert.equal(la.amount, -25); assert.equal(lb.kind, "transfer_in"); assert.equal(lb.amount, 25);
  assert.equal(la.transferId, lb.transferId, "both lines trace to the same transfer");
  await meter.release(hold);
  // history filters
  assert.equal((await store.listTransfers({ ref: "proj-B" })).length, 1);
  assert.equal((await store.listTransfers({ adminId: "nobody" })).length, 0);
  assert.equal((await store.listTransfers({ minAmount: 30 })).length, 0);
});

test("a personal (user) wallet is a source and a destination; a reversal is a new transfer that references the original and never edits it", async () => {
  const { store, meter, ctx, walletId: a } = await fixture(50);
  const u = (await store.walletForUser(ctx.customerId, "user-B", { create: true }))!;
  assert.equal(walletKind(u), "user"); assert.equal((await store.walletForUser(ctx.customerId, "user-B", { create: true }))!.id, u.id);
  assert.equal((await meter.walletFor({ customerId: ctx.customerId, surveyId: null }))!.id !== u.id, true, "the workspace wallet is not the personal wallet");
  const t = await meter.transfer({ sourceWalletId: a, destinationWalletId: u.id, amount: 20, by: "admin" });
  assert.ok(t.ok); assert.equal(t.destination.balance, 20); assert.equal(t.transfer.destinationKind, "user"); assert.equal((await store.getWallet(a))!.balance, 30);
  const back = await meter.transfer({ sourceWalletId: u.id, destinationWalletId: a, amount: 5, by: "admin" });
  assert.ok(back.ok); assert.equal(back.source.balance, 15);
  // reversal of the 20
  const rev = await meter.reverseTransfer(t.transfer.id, "admin", "sent to the wrong person");
  assert.equal(rev.ok, false, "the user has spent (moved) 5 of the 20 — it cannot all come back");
  await meter.credit(u.id, 5, { reason: "top up", by: "admin" });
  const rev2 = await meter.reverseTransfer(t.transfer.id, "admin", "sent to the wrong person");
  assert.ok(rev2.ok);
  assert.equal(rev2.transfer.reversalOf, t.transfer.id); assert.equal(rev2.source.balance, 0); assert.equal(rev2.destination.balance, 55);
  const original = (await store.getTransfer(t.transfer.id))!;
  assert.equal(original.status, "reversed"); assert.equal(original.reversedBy, rev2.transfer.id); assert.equal(original.amount, 20, "the original row keeps its amount");
  assert.ok((await store.listLedger(a)).some((l) => l.kind === "transfer_reversal" && l.transferId === rev2.transfer.id));
  const again = await meter.reverseTransfer(t.transfer.id, "admin", "again");
  assert.equal(again.ok, false); if (!again.ok) assert.equal(again.reason, "already_reversed");
  assert.equal((await meter.reverseTransfer(rev2.transfer.id, "admin", "undo the undo")).ok, false, "a reversal cannot itself be reversed");
});


test("the brief's transfer cases: A user's own credits move to another user, and only what is genuinely available", async () => {
  const store = new MemoryMeterStore();
  const meter = new Meter(store, { cacheMs: 0 });
  const A = (await store.walletForUser("cust-1", "user-A", { create: true }))!;
  const B = (await store.walletForUser("cust-1", "user-B", { create: true }))!;
  await meter.credit(A.id, 100, { reason: "assigned", by: "admin" });
  await meter.credit(B.id, 20, { reason: "assigned", by: "admin" });

  /* TEST A — A = $100, B = $20; A transfers $25 → A = $75, B = $45 */
  const t = await meter.transfer({ sourceWalletId: A.id, destinationWalletId: B.id, amount: 25, by: "user-A" });
  assert.ok(t.ok);
  assert.equal(t.source.balance, 75);
  assert.equal(t.destination.balance, 45);

  /* TEST D — both ledger entries exist and share one transfer id */
  const outLine = (await store.listLedger(A.id)).find((l) => l.transferId === t.transfer.id)!;
  const inLine = (await store.listLedger(B.id)).find((l) => l.transferId === t.transfer.id)!;
  assert.equal(outLine.kind, "transfer_out"); assert.equal(outLine.amount, -25);
  assert.equal(inLine.kind, "transfer_in"); assert.equal(inLine.amount, 25);
  assert.equal(outLine.transferId, inLine.transferId);
  assert.match(t.transfer.code, /^TRX-/);

  /* TEST B — A = $20, attempts $25 → rejected, no balance change */
  const small = (await store.walletForUser("cust-1", "user-C", { create: true }))!;
  await meter.credit(small.id, 20, { reason: "assigned", by: "admin" });
  const before = (await store.getWallet(small.id))!.balance;
  const refused = await meter.transfer({ sourceWalletId: small.id, destinationWalletId: B.id, amount: 25, by: "user-C" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "insufficient_available");
  assert.equal((await store.getWallet(small.id))!.balance, before, "nothing moved");
  assert.equal((await store.listLedger(small.id)).filter((l) => l.kind === "transfer_out").length, 0, "and nothing was written");

  /* TEST C — $100 with $40 reserved, attempts $70 → rejected */
  const held = (await store.walletForUser("cust-1", "user-D", { create: true }))!;
  await meter.credit(held.id, 100, { reason: "assigned", by: "admin" });
  await store.reserve({ walletId: held.id, customerId: "cust-1", surveyId: null, userId: "user-D", eventType: "AI_REQUEST", environment: "LIVE", estimatedCost: 20, amount: 40, floor: 0, ttlMinutes: 30 });
  assert.equal(transferableBalance((await store.getWallet(held.id))!), 60, "available is balance − reserved");
  const overReserved = await meter.transfer({ sourceWalletId: held.id, destinationWalletId: B.id, amount: 70, by: "user-D" });
  assert.equal(overReserved.ok, false);
  if (!overReserved.ok) { assert.equal(overReserved.reason, "insufficient_available"); assert.equal(overReserved.available, 60); }
  assert.equal((await store.getWallet(held.id))!.balance, 100, "the reserved money is untouchable, not merely uncounted");
  /* …and exactly the available amount does go */
  const exact = await meter.transfer({ sourceWalletId: held.id, destinationWalletId: B.id, amount: 60, by: "user-D" });
  assert.ok(exact.ok);
  assert.equal(exact.source.balance, 40, "the reservation is still held against what is left");

  /* a transfer to oneself is the same wallet, and is refused */
  const self = await meter.transfer({ sourceWalletId: A.id, destinationWalletId: A.id, amount: 1, by: "user-A" });
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.reason, "same_wallet");

  /* history reads from either side */
  assert.equal((await store.listTransfers({ walletId: A.id })).length, 1);
  assert.equal((await store.listTransfers({ walletId: B.id })).length, 2, "B received the two that succeeded — a refused transfer leaves no trace to read");
});

/* ================================================= one wallet, many projects
 *
 * The central-wallet model, tested on the arithmetic and on the engine rather
 * than through a browser: a person has one balance, every project they own
 * spends from it, and what a project may take is a POLICY on the project. The
 * SQL enforces the same rules and is proven separately
 * (scripts/billing-central-wallet-sql-test.sql); these are the same
 * statements made where the unit tests can reach them.
 */

/** A wallet row, for the arithmetic tests that do not need a store. */
function wallet(p: { totalAdded: number; balance: number; totalUsed: number; reserved?: number }): Wallet {
  const now = new Date().toISOString();
  return {
    id: "w1", customerId: "cust", surveyId: null, userId: "user_1", sharedWalletId: null,
    currency: "USD", balance: p.balance, reserved: p.reserved ?? 0,
    totalAdded: p.totalAdded, totalUsed: p.totalUsed, state: "active",
    overdraftEnabled: null, overdraftLimit: null, createdAt: now, updatedAt: now,
  };
}
const policy = (p: Partial<ProjectSpending> & { surveyId: string }): ProjectSpending =>
  ({ ...defaultSpending(p.surveyId, "cust"), ...p });

test("a project that shares the wallet is measured against the wallet, not against a pot of its own", () => {
  const w = wallet({ totalAdded: 500, balance: 265, totalUsed: 235 });
  const m = projectMeter(w, { charge: 120, events: 12 }, cfg, policy({ surveyId: "p_a", spent: 120 }));
  assert.equal(m.used, 120, "what THIS project spent");
  assert.equal(m.limit, null, "it has no limit of its own");
  assert.equal(m.mode, "shared");
  assert.equal(m.allowance, 265, "it may spend what the wallet has left");
  assert.equal(m.walletRemaining, 265);
  assert.equal(m.state, "active");
  assert.equal(m.usedPct, Math.round((120 / 385) * 10000) / 100, "measured against what it has spent plus what it could still spend");
  assert.equal(m.events, 12);
});

test("a budgeted project is measured against ITS OWN limit, whatever the wallet holds", () => {
  const w = wallet({ totalAdded: 500, balance: 499, totalUsed: 1 });
  const m = projectMeter(w, { charge: 0.6, events: 3 }, cfg, policy({ surveyId: "p_b", mode: "budget", budgetLimit: 1, spent: 0.6 }));
  assert.equal(m.limit, 1);
  assert.equal(m.used, 0.6);
  assert.equal(m.allowance, 0.4, "40c of its dollar remains — not the wallet's $499");
  assert.equal(m.usedPct, 60);
  assert.equal(m.walletRemaining, 499, "and the wallet's own figure is reported apart, never mistaken for the project's");
  assert.equal(m.level, "critical", "judged on what it may still spend: 40c is nearly out, however full the wallet is");
});

test("a project at its limit reads frozen; the wallet behind it is still healthy", () => {
  const w = wallet({ totalAdded: 500, balance: 499, totalUsed: 1 });
  const m = projectMeter(w, { charge: 1, events: 5 }, cfg, policy({ surveyId: "p_b", mode: "budget", budgetLimit: 1, spent: 1, state: "frozen", frozenAt: new Date().toISOString() }));
  assert.equal(m.state, "frozen", "the PROJECT stopped");
  assert.equal(m.allowance, 0);
  assert.equal(m.usedPct, 100);
  assert.equal(m.walletRemaining, 499, "the other projects are unaffected");
});

test("an empty wallet stops every project, whatever its policy says", () => {
  const w = wallet({ totalAdded: 500, balance: 0, totalUsed: 500 });
  const shared = projectMeter(w, { charge: 300, events: 9 }, cfg, policy({ surveyId: "p_a", spent: 300 }));
  const budgeted = projectMeter(w, { charge: 1, events: 1 }, cfg, policy({ surveyId: "p_b", mode: "budget", budgetLimit: 50, spent: 1 }));
  assert.equal(shared.state, "read_only");
  assert.equal(budgeted.state, "read_only", "a project with 49 of its 50 dollars unspent still cannot spend an empty wallet");
  assert.equal(budgeted.allowance, 0, "and its allowance says so");
});

test("a project nobody has metered yet reads zero, not NaN", () => {
  const m = projectMeter(wallet({ totalAdded: 0, balance: 0, totalUsed: 0 }), undefined, cfg, null);
  assert.equal(m.used, 0);
  assert.equal(m.usedPct, 0);
  assert.equal(m.mode, "shared");
  assert.equal(m.state, "read_only", "an empty wallet cannot fund billable work, and says so");
});

test("the card carries nothing internal, whatever the wallet knows", () => {
  const m = projectMeter(wallet({ totalAdded: 100, balance: 60, totalUsed: 40 }), { charge: 40, events: 2 }, cfg, null);
  for (const k of ["costs", "providerCost", "actualCost", "grossProfit", "marginPct"]) {
    assert.ok(!(k in m), `a researcher's meter has no ${k}`);
  }
});

test("the wallet overview is the person's whole position, from the ledger", async () => {
  const store = new MemoryMeterStore();
  const meter = new Meter(store, { cacheMs: 0 });
  const mine = (await store.walletForUser("cust", "user_1", { create: true }))!;
  const theirs = (await store.walletForUser("cust", "user_2", { create: true }))!;
  await meter.credit(mine.id, 500, { reason: "deposit", by: "admin" });
  await meter.transfer({ sourceWalletId: mine.id, destinationWalletId: theirs.id, amount: 50, by: "user_1" });
  await meter.transfer({ sourceWalletId: theirs.id, destinationWalletId: mine.id, amount: 20, by: "user_2" });

  const w = (await store.getWallet(mine.id))!;
  const o = walletOverview(w, await store.listLedger(mine.id), cfg);
  assert.equal(o.totalAdded, 520, "deposits and credits received");
  assert.equal(o.transferredOut, 50);
  assert.equal(o.transferredIn, 20);
  assert.equal(o.balance, 470);
  assert.equal(o.available, 470);
  assert.equal(o.state, "active");
  assert.equal(walletOverview(null, [], cfg).walletId, null, "a person with no wallet yet has a readable position too");
});

/* ------------------------------------------------ the rules, through the engine */

/**
 * Ana owns three projects and has one wallet.
 *
 * `spend(project, $)` charges an exact amount by asking the meter what one
 * unit costs and buying that many — the alternative, writing a ledger row by
 * hand, would prove the arithmetic of the test rather than the engine's.
 */
async function ana(balance = 500) {
  const store = new MemoryMeterStore();
  store.config = { minimumChargePerOperation: 0 };
  const meter = new Meter(store, { cacheMs: 0 });
  for (const p of ["p_a", "p_b", "p_c"]) store.setOwner(p, "ana");
  const w = (await meter.walletFor({ customerId: "cust", surveyId: "p_a" }))!;
  if (balance) await meter.credit(w.id, balance, { reason: "deposit", by: "admin" });
  const ctx = (surveyId: string) => ({ customerId: "cust", surveyId, userId: "ana", environment: "LIVE" as const });
  const unit = (await meter.price({ eventType: "SURVEY_RESPONSE", quantity: 1 }, "LIVE")).breakdown.customerCharge;
  const spend = (surveyId: string, amount: number) =>
    meter.record(ctx(surveyId), { eventType: "SURVEY_RESPONSE", quantity: amount / unit });
  return { store, meter, w, ctx, spend, unit };
}

test("three projects, one wallet: every charge comes out of the same balance", async () => {
  const { meter, w, spend, store } = await ana(500);
  assert.equal((await meter.walletFor({ customerId: "cust", surveyId: "p_b" }))!.id, w.id, "the second project resolves to the same wallet");
  assert.equal((await meter.walletFor({ customerId: "cust", surveyId: "p_c" }))!.id, w.id, "and the third");

  await spend("p_a", 120);
  await spend("p_b", 75);
  await spend("p_c", 40);
  const after = (await store.getWallet(w.id))!;
  assert.equal(Math.round(after.balance), 265, `500 − 235 = 265, not three separate balances (${after.balance})`);
  assert.equal(Math.round((await store.getSpending("p_a", "cust"))!.spent), 120, "and each project knows its own share");
  assert.equal(Math.round((await store.getSpending("p_b", "cust"))!.spent), 75);
  assert.equal(Math.round((await store.getSpending("p_c", "cust"))!.spent), 40);
});

test("the brief's arrangement: one priority project spends on while the others are capped at a dollar", async () => {
  const { meter, w, spend, ctx, store } = await ana(500);
  await meter.setSpending("p_a", "cust", { mode: "priority", budgetLimit: null });
  await meter.setSpending("p_b", "cust", { mode: "budget", budgetLimit: 1 });
  await meter.setSpending("p_c", "cust", { mode: "budget", budgetLimit: 1 });

  await spend("p_b", 1);
  const refused = await meter.record(ctx("p_b"), { eventType: "SURVEY_RESPONSE", quantity: 100 });
  assert.equal(refused.ok, false);
  assert.equal((refused as { reason: string }).reason, "project_limit", "the PROJECT refused, not the wallet");
  assert.match((refused as { message: string }).message, /spending limit/i);
  assert.match((refused as { message: string }).message, /rest of your wallet is unaffected/i, "and it says the rest of the money is still there");

  const ok = await meter.record(ctx("p_a"), { eventType: "SURVEY_RESPONSE", quantity: 1000 });
  assert.equal(ok.ok, true, "the priority project is untouched by B's limit");

  const wallet_ = (await store.getWallet(w.id))!;
  assert.ok(wallet_.balance > 400, `and the wallet still holds the rest (${wallet_.balance})`);
  assert.equal((await store.getSpending("p_b", "cust"))!.state, "frozen");
  assert.equal((await store.getSpending("p_c", "cust"))!.state, "active", "a project that has spent nothing is not frozen by its sibling");
});

test("raising a limit moves no money and starts the project again", async () => {
  const { meter, w, spend, ctx, store } = await ana(500);
  await meter.setSpending("p_b", "cust", { mode: "budget", budgetLimit: 1 });
  await spend("p_b", 1);
  assert.equal((await store.getSpending("p_b", "cust"))!.state, "frozen");
  const before = (await store.getWallet(w.id))!.balance;

  const raised = await meter.setSpending("p_b", "cust", { mode: "budget", budgetLimit: 100 });
  assert.equal(raised.state, "active", "the project runs again");
  assert.equal(Math.round(raised.spent), 1, "what it spent is unchanged");
  assert.equal((await store.getWallet(w.id))!.balance, before, "and NOTHING moved: a budget is permission, not a transfer");
  assert.equal((await meter.record(ctx("p_b"), { eventType: "SURVEY_RESPONSE", quantity: 10 })).ok, true);
});

test("an exhausted wallet freezes everything, and a deposit brings it all back", async () => {
  const { meter, w, spend, ctx, store } = await ana(20);
  await spend("p_a", 20);
  assert.equal((await store.getWallet(w.id))!.state, "read_only");

  const refused = await meter.record(ctx("p_c"), { eventType: "SURVEY_RESPONSE", quantity: 10 });
  assert.equal(refused.ok, false);
  assert.equal((refused as { reason: string }).reason, "read_only", "every project stops — this one has spent nothing at all");

  await meter.credit(w.id, 100, { reason: "deposit", by: "admin" });
  assert.equal((await store.getWallet(w.id))!.state, "active", "the deposit reactivates the wallet with nobody flipping a switch");
  assert.equal((await meter.record(ctx("p_c"), { eventType: "SURVEY_RESPONSE", quantity: 10 })).ok, true);
});

test("a hold counts against the project's budget while it is held, and is given back if it is released", async () => {
  const { meter, ctx, store, unit } = await ana(500);
  await meter.setSpending("p_b", "cust", { mode: "budget", budgetLimit: 1 });
  const hold = await meter.reserve(ctx("p_b"), { eventType: "SURVEY_RESPONSE", quantity: 1 / unit });
  assert.ok(hold.ok);
  assert.equal(Math.round((await store.getSpending("p_b", "cust"))!.reserved * 100) / 100, 1);

  const second = await meter.reserve(ctx("p_b"), { eventType: "SURVEY_RESPONSE", quantity: 1 / unit });
  assert.equal(second.ok, false, "two operations cannot both be told there is room for the last dollar");
  assert.equal((second as { reason: string }).reason, "project_limit");

  await meter.release(hold as never);
  assert.equal((await store.getSpending("p_b", "cust"))!.reserved, 0, "a released hold gives the headroom back");
  assert.equal((await meter.reserve(ctx("p_b"), { eventType: "SURVEY_RESPONSE", quantity: 0.5 / unit })).ok, true);
});

test("check() tells a frozen project apart from an empty wallet", async () => {
  const { meter, spend } = await ana(500);
  await meter.setSpending("p_b", "cust", { mode: "budget", budgetLimit: 1 });
  await spend("p_b", 1);

  const frozen = await meter.check({ customerId: "cust", surveyId: "p_b" });
  assert.equal(frozen.allowed, false);
  assert.equal(frozen.reason, "project_limit");
  assert.match(frozen.message, /own spending limit/i);
  assert.ok(frozen.wallet && frozen.wallet.balance > 100, "while the wallet it draws on is fine");

  const fine = await meter.check({ customerId: "cust", surveyId: "p_a" });
  assert.equal(fine.allowed, true, "and its sibling is unaffected");
});

test("the ledger says which project spent, even though one wallet paid", async () => {
  const { meter, w, spend, store } = await ana(500);
  await spend("p_a", 20);
  await spend("p_b", 10);
  const ledger = await store.listLedger(w.id, 50);
  const debits = ledger.filter((l) => l.kind === "debit");
  assert.equal(new Set(debits.map((l) => l.surveyId)).size, 2, "two projects, two attributions on one wallet");
  assert.ok(debits.some((l) => l.surveyId === "p_a") && debits.some((l) => l.surveyId === "p_b"));
});
