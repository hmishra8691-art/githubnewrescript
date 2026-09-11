import { test } from "node:test";
import assert from "node:assert/strict";
import { billingConfig, DEFAULT_BILLING_CONFIG } from "./config.js";
import { priceOperation, effectivePaymentFeeRate, depositProjection } from "./pricing.js";
import { DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS, findRate, providerCostFor, registerBillableEvent } from "./registry.js";
import { Meter, estimateTokens } from "./meter.js";
import { MemoryMeterStore } from "./store-memory.js";
import { summarizeWallet, usageByCategory, usageTimeline, forecastUsage, balanceLevel, READ_ONLY_MESSAGE, transferableBalance, walletKind } from "./wallet.js";
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
