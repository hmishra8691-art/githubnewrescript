import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureState, fixtureSegments } from "./fixture.js";
import { deckQuotesFor } from "./deckQuotes.js";
import { deckFromRun } from "../deck.js";
import { buildDeckPptx, checkPptx } from "../export/index.js";
import { SurveyDefinition } from "@rescript/schema";

test("reviewed quotes per theme, one voice per source first, AI suggestions and rejected ones left out, names redacted", () => {
  const st = fixtureState();
  const sets = deckQuotesFor(st, fixtureSegments(), { sources: { src1: { title: "Interview 1" }, src2: { title: "Interview 2" }, src3: { title: "Interview 3" } }, redact: { names: ["Asha", "Vikram", "Neha"] } });
  assert.deepEqual(sets.map((s) => s.theme), ["Cost and value", "Service problems"]);
  const cost = sets[0];
  assert.equal(cost.quotes.length, 3);
  assert.deepEqual(cost.quotes.map((q) => q.source), ["Interview 1", "Interview 2", "Interview 3"], "three voices");
  const service = sets[1];
  assert.equal(service.quotes.length, 2, "x6 is only an AI suggestion and is not quoted");
  assert.ok(service.quotes.some((q) => q.negativeCase), "the contrasting view is kept and labelled");
  for (const s of sets) for (const q of s.quotes) { assert.ok(!/Asha|Vikram|Neha/.test(q.quote)); assert.ok(!q.speaker || !/Asha|Vikram|Neha/.test(q.speaker), `speaker redacted: ${q.speaker}`); }
  assert.ok(cost.quotes.every((q) => q.time), "each quote carries its timestamp");
});

test("the deck carries a section and one slide per theme, and the pptx renders it", async () => {
  const def = SurveyDefinition.parse({ meta: { id: "d", code: "D", title: "Deck", version: "1" }, questions: [], flow: [] });
  const run = { computedAt: "2026-11-05T00:00:00Z", trigger: "manual", environment: "LIVE", n: 120, findings: [], verdicts: [], warnings: [], items: [] } as never;
  const quotes = deckQuotesFor(fixtureState(), fixtureSegments());
  const deck = deckFromRun(def, run, { quotes });
  const slides = deck.slides.filter((s) => s.type === "quotes");
  assert.equal(slides.length, 2);
  assert.ok(deck.slides.some((s) => s.type === "section" && s.title === "In their own words"));
  const buf = await buildDeckPptx({ deck, results: {} });
  assert.ok(checkPptx(buf).ok);
  // without quotes nothing is added
  assert.equal(deckFromRun(def, run, {}).slides.filter((s) => s.type === "quotes").length, 0);
});
