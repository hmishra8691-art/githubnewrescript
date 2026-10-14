import { test } from "node:test";
import assert from "node:assert/strict";
import { holds, rankFindings, type Finding } from "./findings.js";
import { significanceAcross } from "./reportBuilder.js";
import type { AnalysisDefinition, AnalysisResult } from "./types.js";

const F = (id: string, significant: boolean, adjusted?: boolean, p = 0.03): Finding => ({
  id, kind: "difference", strength: "moderate", significant, headline: id, variables: [], hypotheses: [], analysis: { name: id, kind: "test", hash: id },
  evidence: { p, n: 100, ...(adjusted == null ? {} : { adjusted: { method: "holm" as const, p: 0.2, significant: adjusted, family: "plan" } }) } as Finding["evidence"],
});

test("I-3: a finding 'holds' only if it is significant and, when the run corrected for the number of tests, still significant after it", () => {
  assert.equal(holds(F("a", true)), true, "no correction recorded");
  assert.equal(holds(F("b", true, true)), true);
  assert.equal(holds(F("c", true, false)), false, "survives only unadjusted");
  assert.equal(holds(F("d", false, true)), false);
});

test("I-3: the ranking puts findings that hold above ones that only survive unadjusted, however small their raw p", () => {
  const lucky = F("lucky", true, false, 0.001), solid = F("solid", true, true, 0.04);
  assert.deepEqual(rankFindings([lucky, solid]).map((f) => f.id), ["solid", "lucky"]);
});

const item = (id: string, p: number | null, alpha?: number) => ({
  id, definition: { name: id, kind: "test", dataset: { environment: "LIVE", dataset: "all" }, variables: [], ...(alpha ? { options: { alpha } } : {}) } as unknown as AnalysisDefinition,
  result: { tests: p == null ? [] : [{ test: "chi_square", statistic: 1, p }] } as unknown as AnalysisResult,
});

test("I-3: the report builder calls an analysis significant only after Holm across the whole report, at each analysis's own alpha", () => {
  /* twenty tests at p = .03: each is 'significant' alone, none after correction; one at p = .0004 holds */
  const many = Array.from({ length: 20 }, (_, i) => item(`n${i}`, 0.03));
  const real = item("real", 0.0004);
  const m = significanceAcross([...many, real]);
  assert.equal(m.get("real"), true);
  assert.ok(many.every((x) => m.get(x.id) === false), "luck is not a finding");
  assert.equal(significanceAcross([item("alone", 0.03)]).get("alone"), true, "a lone test keeps its raw p");
  assert.equal(significanceAcross([item("strict", 0.03, 0.01)]).get("strict"), false, "its own alpha, not .05");
  assert.equal(significanceAcross([item("loose", 0.07, 0.1)]).get("loose"), true);
  assert.equal(significanceAcross([item("none", null)]).get("none"), false);
});

import { dedupeFindings } from "./findings.js";
const P = (id: string, vars: string[], test: string, p: number, n = 100, sig = true): Finding => ({ ...F(id, sig, undefined, p), variables: vars, evidence: { test, p, n } as Finding["evidence"], hypotheses: [id === "t" ? "H1" : "H2"] });

test("I-5: the same relation tested twice is reported once, as its strongest reading, with the other test named", () => {
  const out = dedupeFindings([P("t", ["SAT", "GENDER"], "t_welch", 0.03), P("c", ["GENDER", "SAT"], "chi_square", 0.01), P("other", ["SAT", "REGION"], "anova_one_way", 0.2, 100, false)]);
  assert.equal(out.length, 2);
  const rel = out.find((f) => f.id === "c")!;
  assert.match(rel.detail!, /also tested by Welch's t-test/);
  assert.deepEqual([...rel.hypotheses].sort(), ["H1", "H2"], "it answers every hypothesis either reading did");
  assert.ok(out.some((f) => f.id === "other"));
});

test("I-5: findings that are not a pair relation, and one-off relations, pass through untouched", () => {
  const one = P("x", ["A", "B"], "chi_square", 0.01);
  const nps: Finding = { ...F("nps", false), kind: "nps", variables: ["A", "B"] };
  const out = dedupeFindings([one, nps, { ...nps, id: "nps2" }]);
  assert.deepEqual(out.map((f) => f.id), ["x", "nps", "nps2"]);
  assert.equal(out[0], one);
});
