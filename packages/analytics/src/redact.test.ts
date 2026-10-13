import test from "node:test";
import assert from "node:assert/strict";
import { redactRunForModel, redactItemsForModel, redactPrompt, MODEL_MIN_CELL } from "./redact.js";
import { claimsFromRun, claimsFromItems, claimsHash, promptVersion, NARRATIVE_INSTRUCTIONS, INTERPRETATION_INSTRUCTIONS } from "./index.js";
import { gateNarrative } from "./narrative.js";
import type { Finding } from "./findings.js";
import type { BuilderItem } from "./reportBuilder.js";
import type { AnalysisResult } from "./types.js";

const finding = (id: string, headline: string, groups: { label: string; mean: number; n: number }[]): Finding => ({
  id, kind: "difference", strength: "moderate", significant: true, headline, evidence: { n: groups.reduce((a, g) => a + g.n, 0), p: 0.01, groups },
  variables: ["SAT"], hypotheses: [], analysis: { name: id, kind: "test", hash: id },
});
const big = finding("f1", "Satisfaction is higher among women (3.86) than men (3.07).", [{ label: "Women", mean: 3.86, n: 210 }, { label: "Men", mean: 3.07, n: 202 }]);
const one = finding("f2", "Satisfaction is lower for Region West (1.7, n = 1) than East (3.6).", [{ label: "West", mean: 1.7, n: 1 }, { label: "East", mean: 3.6, n: 300 }]);
const run = { n: 412, findings: [big, one], verdicts: [], warnings: [] };

test("a finding that rests on a group of one never reaches the model — and cannot be cited", () => {
  const r = redactRunForModel(run);
  assert.deepEqual(r.run.findings.map((f) => f.id), ["f1"]);
  assert.deepEqual(r.withheld.map((w) => w.reason), ["small_group"]);
  assert.equal(MODEL_MIN_CELL, 5);
  const claims = claimsFromRun(r.run);
  assert.ok(!claims.some((c) => /West/.test(c.text)), "the small group is not even a claim");
  /* the model names its number anyway: refused, like any number it was not shown */
  const g = gateNarrative(r.run, { summary: [{ claims: ["C1"], text: "Region West scores 1.7." }] }, { claims });
  assert.match(g.rejected[0].reason, /number 1\.7/);
  /* the full run still has it: redaction changes what is SENT, not what is computed */
  assert.equal(run.findings.length, 2);
});

test("a group exactly at the minimum is kept; one below is not", () => {
  const edge = (n: number) => finding("e", "Edge", [{ label: "A", mean: 3, n }, { label: "B", mean: 2, n: 100 }]);
  assert.equal(redactRunForModel({ ...run, findings: [edge(5)] }).run.findings.length, 1);
  assert.equal(redactRunForModel({ ...run, findings: [edge(4)] }).run.findings.length, 0);
});

const result = (kind: AnalysisResult["kind"], n: number, insights: string[]): AnalysisResult => ({
  kind, name: "x", base: { total: n, filtered: n, n, weightedN: n, label: "all" }, tables: [{ id: "t", title: "t", columns: [], rows: [{ word: "refund", count: 3 }] }], chart: { words: [{ text: "refund", value: 3, sentiment: -1 }] },
  tests: [], insights, warnings: ["Respondent 4412 wrote about jane@example.com"], recommendedCharts: [], computedAt: "", definitionHash: "h", variablesUsed: [],
} as unknown as AnalysisResult);
const item = (id: string, kind: AnalysisResult["kind"], n: number, insights: string[]): BuilderItem => ({ id, name: `Item ${id}`, definition: { kind, name: id } as never, result: result(kind, n, insights) });

test("open text goes as a count; the most-mentioned words and the verbatim warnings stay home", () => {
  const r = redactItemsForModel([item("a", "text", 120, ["Most mentioned: “refund”, “queue”, “jane”."]), item("b", "descriptive", 120, ["Mean 3.4."])]);
  assert.equal(r.items.length, 2);
  const t = r.items[0].result;
  assert.deepEqual(t.insights, ["Open-text responses were read (120 answered); the words people used are not sent to the model."]);
  assert.deepEqual(t.warnings, []); assert.deepEqual(t.tables, []); assert.equal(t.chart.words, undefined);
  assert.ok(!JSON.stringify(r.items[0]).includes("refund") && !JSON.stringify(r.items[0]).includes("jane"));
  assert.deepEqual(r.withheld.map((w) => w.reason), ["open_text"]);
  assert.equal(r.items[1].result.insights[0], "Mean 3.4.", "other analyses are untouched");
});

test("an analysis with a base below the minimum is withheld; a sentence that states a small group's base is dropped", () => {
  const r = redactItemsForModel([item("a", "descriptive", 3, ["Mean 3."]), item("b", "crosstab", 200, ["West answered differently (n = 2).", "East is higher (n = 150)."])]);
  assert.deepEqual(r.items.map((i) => i.id), ["b"]);
  assert.deepEqual(r.items[0].result.insights, ["East is higher (n = 150)."]);
  assert.deepEqual(r.withheld.map((w) => w.reason), ["small_base", "small_n_sentence"]);
  /* ids the model sees are positions in the REDACTED list, and the gate reads that same list */
  assert.equal(claimsFromItems(r.items).length, 2);
});

test("the prompt is scrubbed of emails, phone numbers and links — and of nothing else", () => {
  const p = redactPrompt("Mail jane@example.com or +44 20 7946 0958 or (555) 123-4567; see https://x.example/a?b=1. Women score 3.86 against 3.07 (n = 412, p = 0.021).");
  assert.equal(p.text, "Mail [email] or [phone] or [phone]; see [link]. Women score 3.86 against 3.07 (n = 412, p = 0.021).");
  assert.equal(p.masked, 4);
  assert.equal(redactPrompt("3.86 3.07 3.5 3.4 and 1200 2400").masked, 0, "a list of figures is not a phone number");
});

test("the same claims and the same prompt are the same key; a change in either is a different one", () => {
  const a = claimsFromRun(run), b = claimsFromRun({ ...run });
  assert.equal(claimsHash(a), claimsHash(b));
  assert.notEqual(claimsHash(a), claimsHash(claimsFromRun({ ...run, findings: [big] })));
  assert.equal(promptVersion(NARRATIVE_INSTRUCTIONS), promptVersion(NARRATIVE_INSTRUCTIONS));
  assert.notEqual(promptVersion(NARRATIVE_INSTRUCTIONS), promptVersion(INTERPRETATION_INSTRUCTIONS));
  assert.notEqual(promptVersion(NARRATIVE_INSTRUCTIONS), promptVersion(NARRATIVE_INSTRUCTIONS + " "));
  assert.match(promptVersion("x"), /^p_[0-9a-f]{10}$/);
});
