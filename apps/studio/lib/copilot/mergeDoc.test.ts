import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "@rescript/engine";
import { describeDocMerge, mergeDocActions } from "./mergeDoc.ts";

/* Phase 3: a document card becomes the actions that record what the design lacks — nothing it already has. */
const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, research: { objective: "", hypotheses: ["Price perception drives switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q1"] }], analysis: [], assumptions: [], sources: ["old.pdf"] }, questions: [{ id: "q1", code: "Q1", variableName: "PRICE", type: "single_select", text: "Value?", options: [{ code: 1, label: "Low" }] }], flow: [{ type: "page", id: "p", title: "p", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }] });
const summary = { type: "paper", objectives: [{ text: "Explain brand switching among young adults", passages: [] }], hypotheses: [{ text: "Price perception drives switching.", passages: [] }, { text: "Service quality reduces switching", passages: [] }], constructs: [{ name: "price perception", passages: [] }, { name: "Service quality", definition: "perceived responsiveness", passages: [] }], scales: [], findings: [], demographics: [], gaps: [], questionAreas: [] };

test("the merge adds the objective (none recorded), the new hypothesis and the new construct, and the source; duplicates are left alone", () => {
  const m = mergeDocActions(def, { name: "switching.pdf", summary });
  assert.equal(m.empty, false);
  assert.deepEqual(m.adds, { objective: true, hypotheses: 1, constructs: 1, source: true });
  assert.equal(describeDocMerge(m), "the objective, 1 hypothesis and 1 construct");
  assert.equal(m.actions.length, 2);
  const out = applySurveyActions(def, m.actions);
  assert.ok(out.valid && out.results.every((x) => x.ok), JSON.stringify(out.results));
  const r = out.def.research!;
  assert.equal(r.objective, "Explain brand switching among young adults");
  assert.deepEqual(r.hypotheses, ["Price perception drives switching", "Service quality reduces switching"]);
  assert.deepEqual(r.constructs.map((c) => `${c.name}:${c.role}:${c.questionIds.length}`), ["Price perception:independent:1", "Service quality:descriptive:0"], "the existing construct keeps its question");
  assert.equal(r.constructs[1].definition, "perceived responsiveness");
  assert.deepEqual(r.sources, ["old.pdf", "switching.pdf"]);
  // a second time: nothing new
  const again = mergeDocActions(out.def, { name: "switching.pdf", summary });
  assert.equal(again.empty, true);
  assert.deepEqual(again.actions, []);
  assert.equal(describeDocMerge(again), "nothing new — the design has all of it");
  assert.equal(mergeDocActions(def, { name: "x", summary: null }).empty, true);
});
