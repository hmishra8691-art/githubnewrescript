import { test } from "node:test";
import assert from "node:assert/strict";
import { QualStudy } from "@rescript/schema";
import { languagePackStatus } from "@rescript/engine";
import { parsePacks, realtimeReadiness, summaryOf, withPacks } from "./view.ts";
import { translatePacks } from "./translatePacks.ts";

/*
 * THE STUDIO SIDE OF VOICE AND LANGUAGES (G1 2026-10-22): the study languages' wording is translated through
 * the metered door (a fake fetch here), the researcher's edits survive a re-translation, a body's packs are
 * validated and bounded before they reach a snapshot, realtime readiness says why it is off, and the live
 * view's row carries the voice summary.
 */

const guide = () => QualStudy.parse({
  kind: "interview", title: "Switching", objectives: ["Understand what triggers switching"], consent: { statement: "Taking part is voluntary." },
  sections: [{ id: "s1", title: "Intro", kind: "opening", script: "Thanks for joining." }, { id: "s2", title: "T", questions: [{ id: "s2q1", text: "Tell me about switching." }] }],
  aiModeration: { modes: ["text"], languages: ["en", "es", "sw"] },
});

test("translatePacks: through /api/ai/translate in batches; built-in languages need only the guide; edits are kept", async () => {
  const calls: { target: string; n: number }[] = [];
  const fetchImpl = async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as { items: { key: string; text: string }[]; targetLanguage: string; surveyId: string };
    calls.push({ target: b.targetLanguage, n: b.items.length });
    return new Response(JSON.stringify({ translations: Object.fromEntries(b.items.map((i) => [i.key, `[${b.targetLanguage}] ${i.text}`])), provider: "fake" }), { status: 200 });
  };
  const g = guide();
  const r = await translatePacks(g, ["es", "sw"], { guideLanguage: "en", surveyId: "sandbox", fetchImpl });
  assert.deepEqual(r.errors, []);
  assert.equal(r.packs.es.texts["q:s2q1"], "[es] Tell me about switching.");
  assert.deepEqual(r.packs.es.words, {}, "Spanish wording is built in");
  assert.equal(r.packs.sw.ui.start, "[sw] Start the interview");
  assert.ok(calls.filter((c) => c.target === "sw").length >= 2, "batched");
  const g2 = QualStudy.parse({ ...g, aiModeration: { ...g.aiModeration, translations: { ...r.packs, sw: { ...r.packs.sw, source: "edited", ui: { ...r.packs.sw.ui, start: "Anza mahojiano" } } } } });
  assert.deepEqual(languagePackStatus(g2, "sw").missing, []);
  calls.length = 0;
  const again = await translatePacks(g2, ["sw"], { guideLanguage: "en", surveyId: "sandbox", fetchImpl });
  assert.equal(calls.length, 0, "nothing left to translate");
  assert.equal(again.packs.sw.ui.start, "Anza mahojiano"); assert.equal(again.packs.sw.source, "edited");
});

test("packs from a request body are validated and bounded; merged into a snapshot; realtime readiness; the voice summary", () => {
  const packs = parsePacks({ "es-MX": { language: "es", texts: { "q:s2q1": "Hola" } }, bad: { texts: "no" }, sw: { language: "sw", texts: { ["x".repeat(500)]: "y".repeat(5000) } } });
  assert.deepEqual(Object.keys(packs), ["es", "sw"]);
  assert.equal(Object.keys(packs.sw.texts)[0].length, 120); assert.equal(Object.values(packs.sw.texts)[0].length, 2000);
  const snap = withPacks({ aiModeration: { modes: ["text"], translations: { de: { language: "de", texts: {} } } } }, packs) as { aiModeration: { translations: Record<string, unknown> } };
  assert.deepEqual(Object.keys(snap.aiModeration.translations).sort(), ["de", "es", "sw"]);
  assert.deepEqual(realtimeReadiness({}), { available: false, reason: "not configured: AI_REALTIME_API_URL, AI_REALTIME_API_KEY, AI_REALTIME_MODEL" });
  assert.deepEqual(realtimeReadiness({ AI_REALTIME_API_URL: "https://x", AI_REALTIME_API_KEY: "k", AI_REALTIME_MODEL: "m" }), { available: true });
  assert.match(realtimeReadiness({ AI_REALTIME_API_URL: "https://x", AI_REALTIME_API_KEY: "k", AI_REALTIME_MODEL: "m", AI_REALTIME_PROTOCOL: "acme" }).reason ?? "", /cannot be gated/);
  const row = summaryOf({ id: "i", status: "completed", mode: "voice", language: "en", excluded: false, is_test: false, flags: [], state: { voice: { style: "conversation", interruptions: 2, latenciesMs: [800, 1200, 1000] } }, turns_count: 4, cost_usd: 0, started_at: "2026-10-22T10:00:00Z", last_activity_at: "2026-10-22T10:05:00Z", completed_at: null, qual_transcript_id: null });
  assert.deepEqual(row.voice, { style: "conversation", interruptions: 2, medianLatencyMs: 1000, maxLatencyMs: 1200, turnsMeasured: 3 });
});
