import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineEntry, compareToBaseline, percentile, reportMarkdown, summarize, type CaseResult, type EvalReport } from "./report.ts";

/* the roll-up, the baseline policy (exit code) and the Markdown */
const turn = (o: Partial<CaseResult["turns"][number]> = {}) => ({
  index: 0, message: "m", status: 200, latencyMs: 1000, checks: [], failed: [], reply: "ok",
  facts: { kind: "edit", ops: ["update_question"], applied: 1, refused: 0, mode: "edit", scope: null, stage: "none", planItems: 0, repairRan: false, repaired: false, oneShotParse: true, clarify: false, modelCalled: true },
  calls: [{ operation: "copilot_edit", model: "m", provider: "p", inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 6000, cacheWriteTokens: 0, requests: 1, providerCostUsd: 0.02, chargeUsd: 0.05, latencyMs: 900 }], ...o,
});
const kase = (id: string, passed: boolean, o: Partial<CaseResult> = {}): CaseResult => ({
  id, category: "single_edit", title: id, source: "golden", passed, turns: [turn()], budget: { maxCostUsd: 1, maxLatencyMs: 60_000, maxInputTokens: 50_000 }, budgetChecks: [],
  costUsd: 0.02, chargeUsd: 0.05, inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 6000, cacheWriteTokens: 0, latencyMs: 1000, ...o,
});
const report = (cases: CaseResult[], mode: "fake" | "live" = "live"): EvalReport => ({ meta: { startedAt: "2026-10-18T10:00:00Z", finishedAt: "2026-10-18T10:05:00Z", mode, provider: "api.example", model: "m", key: `${mode}:m`, cases: cases.length }, summary: summarize(cases), cases });

test("summary: pass rate per category, tokens with cache read / write, cost, p50 / p95, repair and clarify rates", () => {
  const cs = [kase("a", true), kase("b", false, { category: "ux_script", turns: [turn({ latencyMs: 9000, facts: { ...turn().facts, repairRan: true, clarify: true } })] }), kase("c", true, { turns: [turn({ facts: { ...turn().facts, modelCalled: false }, calls: [] })] })];
  const s = summarize(cs);
  assert.equal(s.passRate, 0.667);
  assert.deepEqual(s.byCategory.single_edit, { cases: 2, passed: 2, passRate: 1 });
  assert.deepEqual(s.byCategory.ux_script, { cases: 1, passed: 0, passRate: 0 });
  assert.equal(s.modelTurns, 2, "a turn the Studio answered without a model is not a model turn");
  assert.equal(s.repairRate, 0.5); assert.equal(s.clarifyRate, 0.5);
  assert.deepEqual(s.tokens, { input: 20_000, output: 1000, cacheRead: 12_000, cacheWrite: 0 });
  assert.equal(s.cacheHitRate, 0.6);
  assert.equal(s.latencyMs.p95, 9000);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5); assert.equal(percentile([], 95), 0);
});

test("baseline: a case that stops passing is a regression; a pass-rate drop past the tolerance is one; cost growth past 25 % is one", () => {
  const base = { "live:m": baselineEntry(report([kase("a", true), kase("b", true)])) };
  assert.deepEqual(compareToBaseline(report([kase("a", true), kase("b", true)]), base).regressions, []);
  const worse = compareToBaseline(report([kase("a", true), kase("b", false)]), base);
  assert.ok(worse.regressions.some((r) => /b passed in the baseline/.test(r)));
  assert.ok(worse.regressions.some((r) => /pass rate/.test(r)));
  const pricey = compareToBaseline(report([kase("a", true, { costUsd: 0.05 }), kase("b", true, { costUsd: 0.05 })]), base);
  assert.ok(pricey.regressions.some((r) => /cost/.test(r)));
  const better = compareToBaseline(report([kase("a", true), kase("b", true), kase("new", false)]), { "live:m": baselineEntry(report([kase("a", false), kase("b", true)])) });
  assert.ok(better.improvements.some((r) => /a now passes/.test(r)));
  assert.ok(better.notes.some((n) => /new case new/.test(n)));
  assert.deepEqual(compareToBaseline(report([kase("a", true)]), {}).regressions, [], "no baseline: nothing to regress against");
});

test("Markdown: the fake-provider caveat, the categories, the failures with the model's reply", () => {
  const md = reportMarkdown(report([kase("a", true), kase("b", false, { turns: [turn({ checks: [{ name: "op_present:update_question", ok: false, detail: "no update_question" }], failed: ["op_present:update_question"], reply: "I could not | do that" })] })], "fake"));
  assert.match(md, /Fake provider/);
  assert.match(md, /\| single_edit \| 2 \| 1 \| 50\.0 % \|/);
  assert.match(md, /### b/);
  assert.match(md, /op_present:update_question/);
  assert.match(md, /I could not \\\| do that/);
});
