import test from "node:test";
import assert from "node:assert/strict";
import type { UsageEvent } from "@rescript/billing";
import { OWN_COST_NOTE, summariseAiUsage } from "./usage.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
let n = 0;
const ev = (o: Partial<UsageEvent> & { metadata?: Record<string, unknown> }): UsageEvent => ({
  id: `e${++n}`, customerId: "c", subjectKind: "survey", surveyId: null, userId: "u", walletId: "w", eventType: "AI_REQUEST_BYOK", category: "ai", environment: "LIVE", provider: "openai", service: "chat", model: "gpt-4.1",
  quantity: 1, unit: "request", inputUnits: 100, outputUnits: 50, providerCost: 0, infraCost: 0, paymentFee: 0, taxReserve: 0, customerCharge: 0, grossProfit: 0, netProfit: 0, marginPct: 0,
  reservationId: null, adjustsEventId: null, metadata: {}, createdAt: "2026-10-14T10:00:00Z", ...o,
} as UsageEvent);

test("own-provider rows are grouped by feature, provider and model, with volumes and no money", () => {
  const u = summariseAiUsage([
    ev({ inputUnits: 100, outputUnits: 40, metadata: { providerId: "openai" } }),
    ev({ inputUnits: 300, outputUnits: 60, metadata: { providerId: "openai", usedFallback: true } }),
    ev({ service: "translate", provider: "deepl", model: "v2", unit: "character", quantity: 1200, inputUnits: null, outputUnits: null, metadata: { providerId: "deepl" } }),
    ev({ service: "stt", provider: "openai-stt", model: "whisper-1", unit: "minute", quantity: 2.5, inputUnits: null, outputUnits: null, metadata: { providerId: "openai-stt" } }),
  ], { now: NOW });
  assert.equal(u.own.length, 3);
  const chat = u.own.find((r) => r.service === "chat")!;
  assert.deepEqual([chat.calls, chat.viaFallback, chat.inputTokens, chat.outputTokens], [2, 1, 400, 100]);
  assert.equal(u.own.find((r) => r.service === "translate")!.characters, 1200);
  assert.equal(u.own.find((r) => r.service === "stt")!.minutes, 2.5);
  assert.deepEqual(u.ownTotals, { calls: 4, viaFallback: 1 });
  assert.equal(u.costNote, OWN_COST_NOTE);
  assert.equal(JSON.stringify(u.own).match(/charge|cost|price/i), null, "no money on an own-provider row");
});

test("platform rows carry the customer charge only, by category; own-provider work is never in them and the two are never summed", () => {
  const u = summariseAiUsage([
    ev({ eventType: "AI_REQUEST", provider: "anthropic", customerCharge: 0.012, providerCost: 0.004, metadata: {} }),
    ev({ eventType: "AI_REQUEST", provider: "anthropic", customerCharge: 0.003, metadata: {} }),
    ev({ eventType: "TRANSLATION_CHARACTER", category: "translation", service: "translate", provider: "google", unit: "character", quantity: 500, customerCharge: 0.01 }),
    ev({ eventType: "AI_INPUT_TOKEN", customerCharge: 0 }),
    ev({ eventType: "STORAGE_GB", category: "storage", customerCharge: 5 }),
    ev({ metadata: { providerId: "openai" } }),
  ], { now: NOW });
  assert.deepEqual(u.platform.map((r) => [r.label, r.calls, r.charge]), [["Translation", 1, 0.01], ["AI model", 2, 0.015]].sort((a, b) => (b[2] as number) - (a[2] as number)));
  assert.equal(u.platformTotals.charge, 0.025); assert.equal(u.platformTotals.calls, 3);
  assert.equal(u.ownTotals.calls, 1);
  assert.equal(JSON.stringify(u.platform).includes("providerCost"), false);
});

test("reversals and events outside the window are not counted", () => {
  const u = summariseAiUsage([
    ev({ createdAt: "2026-08-01T00:00:00Z" }), ev({ adjustsEventId: "e1" }), ev({ eventType: "AI_REQUEST", adjustsEventId: "e2", customerCharge: -1 }), ev({ createdAt: "2026-10-15T09:00:00Z" }),
  ], { now: NOW, days: 30 });
  assert.equal(u.ownTotals.calls, 1); assert.equal(u.platform.length, 0);
  assert.equal(summariseAiUsage([ev({ createdAt: "2026-10-10T00:00:00Z" })], { now: NOW, days: 3 }).ownTotals.calls, 0);
});

test("a call with no provider id on its row still groups under the provider the row names", () => {
  const u = summariseAiUsage([ev({ provider: "groq", metadata: {} })], { now: NOW });
  assert.equal(u.own[0].provider, "groq");
});
