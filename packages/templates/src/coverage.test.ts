import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "@rescript/engine";
import { coverageGoals, coverSurvey } from "./coverage.js";

const scale = [1, 2, 3, 4, 5].map((c) => ({ code: String(c), label: `Point ${c}` }));
const base = (extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "cov", code: "COV", title: "Coverage", version: "1.0" },
  questions: [
    { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }], required: true },
    { id: "brand", code: "Q1", variableName: "Q1", type: "single_select", text: "Which brand?", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }], required: true },
    { id: "sat", code: "Q2", variableName: "Q2", type: "single_select", text: "How satisfied?", options: scale, required: true },
    { id: "why", code: "Q3", variableName: "Q3", type: "single_select", text: "Why so low?", options: scale, required: true },
    { id: "gender", code: "D1", variableName: "D1", type: "single_select", text: "Gender", options: [{ code: "m", label: "Man" }, { code: "w", label: "Woman" }], required: true },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["own"] }, { type: "page", id: "p2", questionIds: ["brand", "sat"] }, { type: "page", id: "p3", questionIds: ["why"] }, { type: "page", id: "p4", questionIds: ["gender"] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});
const edit = (def: SurveyDefinition, actions: Record<string, unknown>[]) => { const r = applySurveyActions(def, actions as unknown as SurveyAction[]); assert.deepEqual(r.errors, []); return r.def; };

test("goals: pages, both sides of a conditional question, skips, endings, quota cells", () => {
  const def = edit(base(), [{ op: "set_display_logic", target: "Q3", expression: "Q2 = 1" }, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" }]);
  const ids = coverageGoals(def).map((g) => g.id);
  for (const id of ["page:p1", "page:p4", "shown:why", "hidden:why", "ending:complete", "ending:screened"]) assert.ok(ids.includes(id), id);
  assert.ok(ids.some((id) => id.startsWith("skip:own/")));
  assert.ok(!ids.includes("shown:brand"), "an unconditional question has no shown/hidden goals");
});

test("every goal of a sound survey is met, by a script far smaller than the respondents simulated", () => {
  const def = edit(base(), [{ op: "set_display_logic", target: "Q3", expression: "Q2 = 1" }, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" }]);
  const r = coverSurvey(def, { seed: 3 });
  assert.equal(r.share, 100, JSON.stringify(r.unmet.map((u) => u.goal.id)));
  assert.equal(r.unmet.length, 0);
  assert.ok(r.script.length >= 2 && r.script.length <= 4, `${r.script.length} respondents`);
  assert.ok(r.script.length < r.simulated / 10);
  /* the script really covers everything: the union of what each is there for is every goal */
  assert.deepEqual(new Set(r.script.flatMap((s) => s.covers)), new Set(r.goals.map((g) => g.id)));
  assert.ok(r.script.some((s) => s.endStatus === "screened") && r.script.some((s) => s.endStatus === "complete"));
  assert.equal(r.simulatedRespondents, true);
});

test("a display condition that is never used is found, with where the respondents went", () => {
  const def = edit(base(), [{ op: "set_display_logic", target: "Q1", expression: "S1 = Yes" }, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" }]);
  const r = coverSurvey(def, { seed: 3 });
  const u = r.unmet.find((x) => x.goal.id === "hidden:brand");
  assert.ok(u, JSON.stringify(r.unmet));
  assert.match(u!.why, /ended screened after page p1/);
  assert.match(u!.why, /display logic is never used/);
});

test("quota feasibility: an unreachable cell, targets that do not add up, hard maximums that cannot fill", () => {
  const def = base({ quotas: [
    { id: "qg", name: "Gender", targetTotal: 100, cells: [
      { id: "m", label: "Men", when: { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "m" }, limit: 40, target: 50 },
      { id: "w", label: "Women", when: { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "w" }, limit: 40, target: 30 },
      { id: "x", label: "Other", when: { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "x" }, limit: 10, target: 10 },
    ] },
  ] });
  const r = coverSurvey(def, { seed: 3 });
  const row = (id: string) => r.quotas.find((q) => q.cell === id)!;
  assert.ok(row("m").entered > 0 && row("w").entered > 0);
  assert.match(row("x").problem ?? "", /No simulated complete entered/);
  assert.match(row("m").problem ?? "", /target \(50\) is above its maximum \(40\)/);
  assert.ok(r.quotaProblems.some((p) => /add up to 90, not the quota's total of 100/.test(p)));
  assert.ok(r.quotaProblems.some((p) => /hard maximums add up to 90, fewer than the 100/.test(p)));
  assert.ok(r.unmet.some((u) => u.goal.id === "quota:qg/x"));
});
