import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDY_METHODOLOGIES, METHOD_FAMILIES, methodFamily } from "./studyMethodology.js";
import { methodGuide, METHOD_GUIDE_IDS, describeBuild } from "./methodGuides.js";

test("every methodology has a complete nine-part research guide (2026-11-10)", () => {
  for (const m of STUDY_METHODOLOGIES) {
    const g = methodGuide(m);
    assert.ok(g, `${m.id}: no guide`);
    for (const k of ["what", "when", "solves", "example"] as const) assert.ok(g![k].length >= 40, `${m.id}.${k} is too thin: ${g![k]}`);
    for (const k of ["data", "structure", "considerations", "analysis", "outputs"] as const) assert.ok(g![k].length >= 1 && g![k].every((x) => x.trim().length > 5), `${m.id}.${k} is empty`);
    assert.ok(g!.data.length >= 2 && g!.outputs.length >= 2 && g!.considerations.length >= 2, `${m.id}: lists too short`);
  }
  /* no guide without a method: a name on a list is not a methodology */
  const ids = new Set(STUDY_METHODOLOGIES.map((m) => m.id));
  for (const id of METHOD_GUIDE_IDS) assert.ok(ids.has(id), `guide for an unknown methodology: ${id}`);
});

test("the structure in a guide is read from what the method builds", () => {
  const cbc = STUDY_METHODOLOGIES.find((m) => m.id === "dce")!;
  assert.match(methodGuide(cbc)!.structure.join(" "), /choice exercise.*4 attributes.*None of these/);
  const ab = STUDY_METHODOLOGIES.find((m) => m.id === "ab_test")!;
  assert.match(methodGuide(ab)!.structure[0], /one per concept or condition.*randomly given one/);
  const j = STUDY_METHODOLOGIES.find((m) => m.id === "customer_journey")!;
  assert.match(methodGuide(j)!.structure[0], /^Your journey: 6 questions/);
  assert.deepEqual(describeBuild([]), []);
});

test("the library is read in five families, and every methodology is in exactly one", () => {
  const count = new Map<string, number>();
  for (const m of STUDY_METHODOLOGIES) { const f = methodFamily(m); assert.ok(METHOD_FAMILIES.some((x) => x.key === f), `${m.id}: unknown family ${f}`); count.set(f, (count.get(f) ?? 0) + 1); }
  for (const f of METHOD_FAMILIES) assert.ok((count.get(f.key) ?? 0) >= 10, `${f.label}: only ${count.get(f.key)} methods`);
  assert.equal(new Set(STUDY_METHODOLOGIES.map((m) => m.id)).size, STUDY_METHODOLOGIES.length, "ids are unique");
  for (const m of STUDY_METHODOLOGIES) for (const a of m.alternatives) assert.ok(STUDY_METHODOLOGIES.some((x) => x.id === a), `${m.id}: alternative ${a} does not exist`);
  assert.equal(methodFamily(STUDY_METHODOLOGIES.find((m) => m.id === "maxdiff")!), "quantitative");
  assert.equal(methodFamily(STUDY_METHODOLOGIES.find((m) => m.id === "conjoint_pricing")!), "quantitative");
});

test("clinical and epidemiological designs say what the platform does not do; qualitative methods point to where the work happens", () => {
  for (const m of STUDY_METHODOLOGIES.filter((x) => x.category === "clinical")) {
    assert.ok(m.caution && /not a regulated clinical-trial/.test(m.caution), `${m.id}: no planning caution`);
    assert.equal(methodGuide(m)!.caution, m.caution);
  }
  for (const m of STUDY_METHODOLOGIES) assert.ok(!/\b(?:compliant|validated for|certified|approved by)\b/i.test(`${m.fit} ${m.strengths.join(" ")}`), `${m.id}: claims compliance or validation`);
  for (const id of ["in_depth_interviews", "focus_groups", "ethnography", "grounded_theory", "narrative_analysis", "thematic_analysis"]) assert.equal(STUDY_METHODOLOGIES.find((m) => m.id === id)!.workflow?.kind, "qualitative", id);
});
