import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief } from "./analyticsBrief.ts";

const id = "11111111-1111-4111-8111-111111111111";

test("a brief is bounded and unknown fields are dropped", () => {
  const b = parseBrief({ objective: "x".repeat(5000), audience: "board", tone: "angry", keyQuestions: ["a", "", "  b  ", ...Array(20).fill("q")], analysisIds: [id, "not-a-uuid", 7], maxItems: 9999, includeTests: false, includeCrosstabs: true, title: "T", client: "C", evil: "<script>" });
  assert.equal(b.objective.length, 1000);
  assert.equal(b.audience, "client", "unknown audience falls back");
  assert.equal(b.tone, "plain", "unknown tone falls back");
  assert.equal(b.keyQuestions.length, 10);
  assert.deepEqual(b.keyQuestions.slice(0, 2), ["a", "b"]);
  assert.deepEqual(b.analysisIds, [id]);
  assert.equal(b.maxItems, 40);
  assert.equal(b.includeTests, false);
  assert.equal("includeCrosstabs" in b, false, "true is the default and is not stored");
  assert.ok(!("evil" in b));
});

test("key questions may arrive as one multi-line string, and garbage becomes an empty brief", () => {
  assert.deepEqual(parseBrief({ keyQuestions: "first\n\nsecond" }).keyQuestions, ["first", "second"]);
  const empty = parseBrief(null);
  assert.equal(empty.objective, ""); assert.deepEqual(empty.keyQuestions, []);
  assert.equal(parseBrief({ maxItems: -3 }).maxItems, 1);
  assert.equal(parseBrief({ maxItems: "5" }).maxItems, undefined);
});

test("a brief carries the sections and theme a sentence asked for (2026-10-17); unknown sections and request-supplied hypotheses are dropped", () => {
  const b = parseBrief({ objective: "o", sections: ["hypotheses", "brand_comparison", "made_up", "hypotheses", 3], theme: "Midnight", hypotheses: [{ label: "H9", text: "injected" }] });
  assert.deepEqual(b.sections, ["hypotheses", "brand_comparison"]);
  assert.equal(b.theme, "Midnight");
  assert.equal((b as { hypotheses?: unknown }).hypotheses, undefined, "the route sets the hypotheses from the survey");
  assert.equal(parseBrief({ objective: "o" }).sections, undefined);
});
