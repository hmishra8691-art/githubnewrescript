import { test } from "node:test";
import assert from "node:assert/strict";
import { billingConfig } from "./config.js";
import { priceOperation } from "./pricing.js";
import { DEFAULT_BILLABLE_EVENTS, DEFAULT_RATES, Rate, cacheRateFor, findRate } from "./registry.js";
import { Meter, priceSpec } from "./meter.js";
import { MemoryMeterStore } from "./store-memory.js";
import { money6 } from "./money.js";

/**
 * BILL WHAT IT COSTS (AI cost audit, 2026-10-17).
 *
 * Input the provider read from its prompt cache is priced at the model's
 * cached rate, input it wrote at the write rate, the rest at the input rate —
 * from rows in the rate table, under the unchanged margin model. And the
 * charges are fair: one charge per logical call, nothing for a failed one,
 * and a minimum floor that lifts only what is below it, visibly.
 */
const cfg = billingConfig({});
const M = 1_000_000;
const AI = { eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6" } as const;
const price = (spec: Parameters<typeof priceSpec>[0], rates = DEFAULT_RATES, c = cfg) => priceSpec(spec, "LIVE", c, rates, DEFAULT_BILLABLE_EVENTS);
/** the target-margin gross-up the default configuration applies: 1 / (1 − 0.5 − 0.068) */
const GROSS = 1 / (1 - 0.5 - 0.068);

async function fixture(balance = 100, cfgPatch: Record<string, unknown> = {}) {
  const store = new MemoryMeterStore();
  store.config = cfgPatch;
  const meter = new Meter(store, { cacheMs: 0 });
  const ctx = { customerId: "cust-1", surveyId: "proj-A", userId: "user-1", environment: "LIVE" as const };
  const wallet = (await meter.walletFor(ctx))!;
  if (balance) await meter.credit(wallet.id, balance, { reason: "trial_credits", by: "admin" });
  return { store, meter, ctx, walletId: wallet.id };
}

test("the rate table carries cache rows per model, and a cache row applies only to its own model", () => {
  const sonnetIn = findRate(DEFAULT_RATES, { provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", side: "input" })!;
  assert.equal(cacheRateFor(DEFAULT_RATES, sonnetIn, "cache_read")!.providerCost, 0.3, "10 % of $3");
  assert.equal(cacheRateFor(DEFAULT_RATES, sonnetIn, "cache_write")!.providerCost, 3.75, "125 % of $3");
  const miniIn = findRate(DEFAULT_RATES, { provider: "openai-compatible", service: "chat", model: "gpt-4o-mini", side: "input" })!;
  assert.equal(cacheRateFor(DEFAULT_RATES, miniIn, "cache_read")!.providerCost, 0.075, "OpenAI: 50 %");
  assert.equal(cacheRateFor(DEFAULT_RATES, miniIn, "cache_write"), null, "no write row: never the * row's $3.75 for a $0.15 model");
  const unknownIn = findRate(DEFAULT_RATES, { provider: "openai-compatible", service: "chat", model: "some-new-model", side: "input" })!;
  assert.equal(unknownIn.model, "*");
  assert.equal(cacheRateFor(DEFAULT_RATES, unknownIn, "cache_read")!.id, "ai.chat.*.cache_read", "a model priced by the * input row takes the * cache row");
  assert.equal(findRate(DEFAULT_RATES, { provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", side: "input" })!.id, "ai.chat.claude-sonnet-4-6.in", "input lookup unchanged");
  assert.doesNotThrow(() => Rate.parse({ id: "x", provider: "p", service: "chat", model: "m", side: "cache_read", unit: "token", providerCost: 1 }), "a stored cache row parses");
  for (const r of DEFAULT_RATES.filter((r) => r.side === "cache_read")) {
    const inRow = DEFAULT_RATES.find((x) => x.provider === r.provider && x.service === r.service && x.model === r.model && x.side === "input")!;
    assert.ok(inRow && r.providerCost < inRow.providerCost, `${r.id}: a cached read is cheaper than input`);
  }
});

test("cached input is priced at the cached rate; the margin model is unchanged", () => {
  /* the production copilot_ux call, 12,362 in / 2,215 out — first uncached, then with 8,000 read from the cache and 362 written */
  const plain = price({ ...AI, inputUnits: 12362, outputUnits: 2215 });
  const cached = price({ ...AI, inputUnits: 12362, outputUnits: 2215, cacheReadUnits: 8000, cacheWriteUnits: 362 });
  assert.equal(plain.breakdown.providerCost, money6(12362 * 3 / M + 2215 * 15 / M));
  assert.equal(cached.breakdown.providerCost, money6(4000 * 3 / M + 8000 * 0.3 / M + 362 * 3.75 / M + 2215 * 15 / M));
  assert.deepEqual(cached.tokens, { input: 12362, uncachedInput: 4000, cacheRead: 8000, cacheWrite: 362, output: 2215 });
  assert.equal(cached.rateCacheRead!.id, "ai.chat.claude-sonnet-4-6.cache_read");
  assert.equal(cached.rateCacheWrite!.id, "ai.chat.claude-sonnet-4-6.cache_write");
  for (const p of [plain, cached]) {
    assert.equal(p.breakdown.customerCharge, money6((p.breakdown.providerCost + cfg.estimatedInfrastructureCostPerAiRequest) * GROSS), "same margin model");
    assert.equal(p.breakdown.marginPct, 50);
  }
  assert.ok(cached.breakdown.customerCharge < plain.breakdown.customerCharge * 0.8, `${cached.breakdown.customerCharge} vs ${plain.breakdown.customerCharge}`);
  /* a call with no cache fields is priced exactly as before */
  assert.equal(price({ ...AI, inputUnits: 12362, outputUnits: 2215, cacheReadUnits: 0, cacheWriteUnits: 0 }).breakdown.customerCharge, plain.breakdown.customerCharge);
});

test("a model with no cache rows is priced at its input rate (as before); reports beyond the input are clamped", () => {
  const noCacheRows = DEFAULT_RATES.filter((r) => r.side !== "cache_read" && r.side !== "cache_write");
  const a = price({ ...AI, inputUnits: 10000, outputUnits: 100, cacheReadUnits: 8000, cacheWriteUnits: 1000 }, noCacheRows);
  const b = price({ ...AI, inputUnits: 10000, outputUnits: 100 }, noCacheRows);
  assert.equal(a.breakdown.providerCost, b.breakdown.providerCost);
  assert.equal(a.rateCacheRead, null);
  const over = price({ ...AI, inputUnits: 100, outputUnits: 0, cacheReadUnits: 500, cacheWriteUnits: 500 });
  assert.deepEqual(over.tokens, { input: 100, uncachedInput: 0, cacheRead: 100, cacheWrite: 0, output: 0 }, "never more than was sent");
});

test("settle with cached tokens: one event, priced from them, carrying the token breakdown and the rates used", async () => {
  const { store, meter, ctx, walletId } = await fixture(100);
  const hold = await meter.reserve(ctx, { ...AI, inputUnits: 3091 + 120, outputUnits: 3500, metadata: { operation: "copilot_ux" } });
  assert.ok(hold.ok);
  const ev = await meter.settle(hold, { inputUnits: 12362, outputUnits: 2215, cacheReadUnits: 8000, cacheWriteUnits: 362, metadata: { estimated: false } });
  assert.equal(store.usage.length, 1);
  assert.deepEqual(ev.metadata.tokens, { input: 12362, cachedInput: 8000, cacheWrite: 362, uncachedInput: 4000, output: 2215 });
  assert.equal(ev.metadata.rateCacheReadId, "ai.chat.claude-sonnet-4-6.cache_read");
  assert.equal(ev.metadata.operation, "copilot_ux");
  assert.equal(ev.metadata.estimated, false);
  assert.equal(ev.inputUnits, 12362, "the row's input stays the whole input");
  assert.equal(ev.providerCost, money6(4000 * 3 / M + 8000 * 0.3 / M + 362 * 3.75 / M + 2215 * 15 / M));
  const w = (await store.getWallet(walletId))!;
  assert.equal(w.reserved, 0);
  assert.equal(w.balance, money6(100 - ev.customerCharge));
});

test("one logical call is charged once: a reservation settles once, and a replayed idempotency key moves no money", async () => {
  const { store, meter, ctx, walletId } = await fixture(100);
  const hold = await meter.reserve(ctx, { ...AI, inputUnits: 1000, outputUnits: 500 });
  assert.ok(hold.ok);
  const ev = await meter.settle(hold, { inputUnits: 900, outputUnits: 300 });
  await assert.rejects(meter.settle(hold, { inputUnits: 900, outputUnits: 300 }), /already settled/, "a second settle of the same hold is refused");
  assert.equal((await store.getWallet(walletId))!.balance, money6(100 - ev.customerCharge));
  /* two holds, same key (a retried request): the second settles as a replay — hold released, no second debit */
  const a = await meter.reserve(ctx, { ...AI, inputUnits: 1000, outputUnits: 500, idempotencyKey: "copilot:turn:abc" });
  const b = await meter.reserve(ctx, { ...AI, inputUnits: 1000, outputUnits: 500, idempotencyKey: "copilot:turn:abc" });
  assert.ok(a.ok && b.ok);
  const e1 = await meter.settle(a, { inputUnits: 900, outputUnits: 300 });
  const e2 = await meter.settle(b, { inputUnits: 900, outputUnits: 300 });
  assert.equal(e1.id, e2.id);
  const w = (await store.getWallet(walletId))!;
  assert.equal(w.balance, money6(100 - ev.customerCharge - e1.customerCharge));
  assert.equal(w.reserved, 0);
  assert.equal(store.usage.length, 2);
});

test("a failed call is released, not charged: Meter.run throws → the hold comes back and no event is written", async () => {
  const { store, meter, ctx, walletId } = await fixture(100);
  await assert.rejects(meter.run(ctx, { ...AI, inputUnits: 9000, outputUnits: 3500 }, async () => { throw new Error("provider 529"); }), /529/);
  const w = (await store.getWallet(walletId))!;
  assert.equal(w.balance, 100); assert.equal(w.reserved, 0);
  assert.equal(store.usage.length, 0);
  assert.equal([...store.reservations.values()][0].status, "released");
});

test("the minimum floor lifts only what is below it, and says by how much; 0 disables it; it never touches a real copilot call", () => {
  /* a classification on a small model: 300 in / 10 out */
  const tiny = price({ ...AI, model: "gpt-4o-mini", inputUnits: 300, outputUnits: 10 });
  const modelled = money6((300 * 0.15 / M + 10 * 0.6 / M + cfg.estimatedInfrastructureCostPerAiRequest) * GROSS);
  assert.ok(modelled < cfg.minimumChargePerOperation);
  assert.equal(tiny.breakdown.minimumApplied, true);
  assert.equal(tiny.breakdown.customerCharge, cfg.minimumChargePerOperation);
  assert.equal(tiny.breakdown.minimumLift, money6(cfg.minimumChargePerOperation - modelled));
  const off = price({ ...AI, model: "gpt-4o-mini", inputUnits: 300, outputUnits: 10 }, DEFAULT_RATES, billingConfig({ minimumChargePerOperation: 0 }));
  assert.equal(off.breakdown.minimumApplied, false); assert.equal(off.breakdown.customerCharge, modelled); assert.equal(off.breakdown.minimumLift, 0);
  const copilot = price({ ...AI, inputUnits: 9770, outputUnits: 4822 });
  assert.equal(copilot.breakdown.minimumApplied, false);
  assert.equal(copilot.breakdown.minimumLift, 0);
  /* two calls of different size are charged differently: there is no fixed fee */
  const small = price({ ...AI, inputUnits: 9770, outputUnits: 200 });
  assert.ok(small.breakdown.customerCharge < copilot.breakdown.customerCharge / 2);
  assert.equal(priceOperation({ providerCost: 0 }, cfg).customerCharge, 0, "no cost, no floor");
});

test("the floor's lift is recorded on the event", async () => {
  const { meter, ctx } = await fixture(10);
  const r = await meter.record(ctx, { ...AI, model: "gpt-4o-mini", inputUnits: 300, outputUnits: 10 });
  assert.ok(r.ok);
  assert.equal(r.event.metadata.minimumApplied, true);
  assert.ok((r.event.metadata.minimumLift as number) > 0);
});
