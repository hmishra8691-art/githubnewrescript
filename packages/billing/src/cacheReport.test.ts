import { test } from "node:test";
import assert from "node:assert/strict";
import { billingConfig } from "./config.js";
import { cacheReport, cacheReportMarkdown, cacheRowFromDb, defaultMinCacheable, eventTokens, type CacheReportRow } from "./cacheReport.js";
import { DEFAULT_BILLABLE_EVENTS, DEFAULT_RATES } from "./registry.js";
import { priceSpec } from "./meter.js";

/**
 * PROMPT CACHING MEASURED FROM BILLING (2026-10-18). The fixture below is the
 * shape of the nine production copilot calls of 2026-10-17 that carry the
 * token split (claude-sonnet-4-6; ids and people removed): what the meter
 * recorded must be what the report calls "actual", and the no-cache price must
 * be the same calls at the input / output rates the meter used.
 */
const cfg = billingConfig({});
const SONNET = "claude-sonnet-4-6";
/** an event exactly as the meter would record it, priced by the real priceSpec */
function ev(at: string, operation: string, input: number, output: number, read = 0, write = 0, model = SONNET): CacheReportRow {
  const p = priceSpec({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model, inputUnits: input, outputUnits: output, cacheReadUnits: read, cacheWriteUnits: write }, "LIVE", cfg, DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS);
  return {
    createdAt: at, eventType: "AI_REQUEST", category: "ai", environment: "LIVE", provider: "openai-compatible", service: "chat", model,
    inputUnits: input, outputUnits: output, providerCost: p.breakdown.providerCost, infraCost: p.breakdown.infraCost, customerCharge: p.breakdown.customerCharge,
    metadata: {
      operation, rateInId: p.rateIn?.id ?? null, rateOutId: p.rateOut?.id ?? null,
      tokens: { input, output, cacheWrite: p.tokens!.cacheWrite, cachedInput: p.tokens!.cacheRead, uncachedInput: p.tokens!.uncachedInput },
      ...(p.rateCacheRead ? { rateCacheReadId: p.rateCacheRead.id } : {}), ...(p.rateCacheWrite ? { rateCacheWriteId: p.rateCacheWrite.id } : {}),
    },
  };
}
const PROD_2026_10_17: CacheReportRow[] = [
  ev("2026-10-17T09:57:17Z", "copilot_ux", 12378, 3760, 0, 8633),
  ev("2026-10-17T09:57:27Z", "copilot_ux_repair", 15355, 554, 8633, 0),
  ev("2026-10-17T10:02:33Z", "copilot_ux", 9002, 7005, 8633, 0),
  ev("2026-10-17T10:02:43Z", "copilot_ux_repair", 12649, 447, 8633, 0),
  ev("2026-10-17T10:08:52Z", "copilot_question", 7614, 3467, 0, 4171),
  ev("2026-10-17T10:10:17Z", "copilot_question", 8422, 408, 4171, 0),
  ev("2026-10-17T10:11:09Z", "copilot_question", 8744, 344, 4171, 0),
  ev("2026-10-17T10:12:52Z", "copilot_question", 8428, 583, 4171, 0),
  ev("2026-10-17T10:16:10Z", "copilot_question", 8410, 9041, 4171, 0),
];
/* the production rows' recorded provider costs, as read from usage_events — the fixture must reproduce them exactly */
const RECORDED = [0.100009, 0.031066, 0.108772, 0.021343, 0.077975, 0.020124, 0.02013, 0.022767, 0.149583];

test("the fixture is priced exactly as production recorded it", () => {
  assert.deepEqual(PROD_2026_10_17.map((r) => r.providerCost), RECORDED);
});

test("the production sample: tokens, hit rate, actual vs no-cache cost and the saving", () => {
  const r = cacheReport(PROD_2026_10_17, { config: cfg });
  const t = r.totals;
  assert.equal(t.calls, 9); assert.equal(t.splitCalls, 9); assert.equal(t.legacyCalls, 0);
  assert.equal(t.inputTokens, 91002); assert.equal(t.cacheReadTokens, 42583); assert.equal(t.cacheWriteTokens, 12804); assert.equal(t.outputTokens, 25609);
  assert.equal(t.uncachedTokens, 91002 - 42583 - 12804);
  assert.equal(t.readCalls, 7); assert.equal(t.writeCalls, 2);
  assert.equal(t.hitRate, 0.778); assert.equal(t.tokenHitRate, 0.468);
  assert.equal(t.actualCostUsd, 0.551769, "the sum of what the meter recorded");
  /* no caching: 91,002 input × $3/M + 25,609 output × $15/M */
  assert.equal(t.noCacheCostUsd, Math.round((91002 * 3 / 1e6 + 25609 * 15 / 1e6) * 1e6) / 1e6);
  assert.equal(t.savingUsd, Math.round((t.noCacheCostUsd - t.actualCostUsd) * 1e6) / 1e6);
  assert.equal(t.noCacheCostUsd, 0.657141); assert.equal(t.savingUsd, 0.105372); assert.equal(t.savingPct, 16);
  assert.ok(t.chargeNoCacheUsd! > t.chargeUsd, "customers paid less than they would have with no caching");
  /* groups: one day, three operations, one model */
  assert.deepEqual(r.groups.map((g) => g.operation), ["copilot_question", "copilot_ux", "copilot_ux_repair"]);
  const q = r.groups.find((g) => g.operation === "copilot_question")!;
  assert.equal(q.calls, 5); assert.equal(q.readCalls, 4); assert.equal(q.writeCalls, 1); assert.equal(q.cacheReadTokens, 16684);
  /* every write was read back: no churn; the sample is small and says so */
  assert.deepEqual(r.warnings.map((w) => w.kind), ["small_sample"]);
  assert.match(cacheReportMarkdown(r), /\| 2026-10-17 \| copilot_question \| claude-sonnet-4-6 \| 5 \| 5 \|/);
});

test("a write never read back within the TTL is prefix churn, with the write premium it wasted", () => {
  const rows = [
    ev("2026-10-18T09:00:00Z", "copilot_edit", 12000, 500, 0, 9000),
    ev("2026-10-18T09:20:00Z", "copilot_edit", 12100, 500, 0, 9000),   /* 20 minutes later: written again */
    ev("2026-10-18T09:21:00Z", "copilot_edit", 12100, 500, 9000, 0),   /* the second write is read */
  ];
  const r = cacheReport(rows, { now: "2026-10-18T10:00:00Z" });
  const churn = r.warnings.filter((w) => w.kind === "prefix_churn");
  assert.equal(churn.length, 1);
  assert.equal(churn[0].calls, 1); assert.equal(churn[0].tokens, 9000);
  assert.equal(churn[0].wastedUsd, Math.round(9000 * (3.75 - 3) / 1e6 * 1e6) / 1e6, "the premium over the input rate");
  /* a write younger than the TTL may still be read: not churn yet */
  const fresh = cacheReport([ev("2026-10-18T09:58:00Z", "copilot_edit", 12000, 500, 0, 9000)], { now: "2026-10-18T10:00:00Z" });
  assert.equal(fresh.warnings.filter((w) => w.kind === "prefix_churn").length, 0);
  /* a read by another model does not read this cache */
  const other = cacheReport([ev("2026-10-18T09:00:00Z", "a", 12000, 1, 0, 9000), ev("2026-10-18T09:01:00Z", "a", 12000, 1, 9000, 0, "claude-haiku-4-5")], { now: "2026-10-18T10:00:00Z" });
  assert.equal(other.warnings.filter((w) => w.kind === "prefix_churn").length, 1);
});

test("below the minimum, never cached, legacy events and the read-at-input-rate case are each named", () => {
  const legacy: CacheReportRow = { ...ev("2026-10-16T10:00:00Z", "copilot_question", 9000, 4000), metadata: { operation: "copilot_question" } };
  const rows = [
    legacy,
    ev("2026-10-18T09:00:00Z", "analytics_ask", 600, 100),            /* under 1,024: cannot be cached */
    ev("2026-10-18T09:01:00Z", "copilot_narrative", 5000, 900),        /* large, never cached */
    ev("2026-10-18T09:02:00Z", "copilot_narrative", 6000, 900),
    ev("2026-10-18T09:03:00Z", "x", 3000, 10, 2000, 0, "mystery-model"),
  ];
  /* a model whose input rate is the `*` row reads at the `*` cache rate — drop it to see the input-rate fallback */
  const rates = DEFAULT_RATES.filter((x) => x.id !== "ai.chat.*.cache_read");
  rows[4] = { ...rows[4], metadata: { ...rows[4].metadata, rateCacheReadId: undefined } };
  const r = cacheReport(rows, { rates });
  const kinds = r.warnings.map((w) => `${w.kind}:${w.operation ?? ""}`);
  assert.ok(kinds.includes("below_minimum:analytics_ask"), kinds.join());
  assert.ok(kinds.includes("never_cached:copilot_narrative"), kinds.join());
  assert.ok(kinds.includes("read_at_input_rate:x"), kinds.join());
  assert.ok(kinds.includes("legacy:"), kinds.join());
  /* a legacy event is counted at its recorded cost, with no saving invented */
  assert.equal(r.totals.legacyCalls, 1);
  const day16 = r.byDay.find((d) => d.day === "2026-10-16")!;
  assert.equal(day16.savingUsd, 0); assert.equal(day16.actualCostUsd, legacy.providerCost);
});

test("an own-provider (BYOK) event recorded at zero is repriced from its split; the database row shape is read", () => {
  const byok = { ...ev("2026-10-18T09:00:00Z", "copilot_edit", 10000, 1000, 8000, 0), eventType: "AI_REQUEST_BYOK", providerCost: 0, customerCharge: 0 };
  const r = cacheReport([byok]);
  assert.ok(r.totals.actualCostUsd > 0 && r.totals.actualCostUsd < r.totals.noCacheCostUsd);
  const db = cacheRowFromDb({ id: "e1", created_at: "2026-10-17 10:10:17+00", event_type: "AI_REQUEST", service: "chat", provider: "openai-compatible", model: SONNET, input_units: "8422.00", output_units: "408.00", provider_cost: "0.020124", customer_charge: "0.047046", metadata: { operation: "copilot_question", tokens: { input: 8422, output: 408, cacheWrite: 0, cachedInput: 4171, uncachedInput: 4251 } } });
  assert.deepEqual(eventTokens(db), { split: true, input: 8422, uncached: 4251, read: 4171, write: 0, output: 408 });
  assert.equal(cacheReport([db]).totals.actualCostUsd, 0.020124);
  /* the meter's own name for the read (`cacheRead`) is read too */
  assert.equal(eventTokens({ inputUnits: 10, outputUnits: 1, metadata: { tokens: { input: 10, output: 1, cacheRead: 6, cacheWrite: 0 } } }).read, 6);
  assert.equal(defaultMinCacheable("claude-haiku-4-5"), 4096); assert.equal(defaultMinCacheable(SONNET), 1024);
});
