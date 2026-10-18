import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, type Interpretation } from "./nlIntent.js";
import { buildAnalysisFramework } from "./analysisFramework.js";

/*
 * THE WORD RESEARCH PLAN BY SENTENCE (2026-10-17). These sentences used to go
 * to the model, which can describe a document but cannot make one: the copilot
 * answered as if a file existed and there was nothing to download.
 */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" }, research: { objective: "Why people switch", hypotheses: ["Price drives switching"] },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Gender", options: [{ code: 1, label: "M" }, { code: 2, label: "F" }] }],
  flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
});
const outputOf = (t: string, d = def) => { const r = interpretRequest(d, t); assert.equal(r.kind, "output", `${t} → ${JSON.stringify(r).slice(0, 200)}`); return r as Extract<Interpretation, { kind: "output" }>; };

test("'prepare a Word research plan' and its rewordings produce the research plan document, from the design", () => {
  for (const t of ["prepare a Word research plan", "Prepare the research plan.", "create a research plan document", "download the research plan as a Word document", "write the research plan in Word", "give me the research plan as a docx", "export the research plan to Word", "generate a Word document with hypotheses, research plan and analytical recommendations", "create a Word document with the hypotheses"]) {
    const o = outputOf(t);
    assert.equal(o.output.type, "research_plan_docx", t);
    assert.equal(o.output.words, "the research plan (Word)");
    assert.equal(o.understood, "Produce the research plan (Word) from the research design.", t);
  }
  assert.equal(outputOf("prepare a Word research plan for Acme Ltd").output.client, "Acme Ltd");
});

test("'update the Word document' regenerates the research plan from the design as it is now", () => {
  for (const t of ["update the Word document", "update the research plan document", "regenerate the research plan", "refresh the word doc"]) {
    const o = outputOf(t);
    assert.equal(o.output.type, "research_plan_docx", t);
    assert.match(o.understood, /^Regenerate the research plan \(Word\) from the research design as it is now\.$/);
  }
});

test("the other documents keep their sentences; 'prepare the analysis plan' still plans the analysis", () => {
  assert.equal(outputOf("create the statistical analysis plan").output.type, "sap_docx");
  assert.equal(outputOf("create the research proposal").output.type, "proposal_docx");
  assert.equal(outputOf("write the findings report as a Word document").output.type, "findings_docx");
  assert.notEqual(interpretRequest(def, "prepare the analysis plan").kind, "output");
});

test("an empty study is refused with what to do first, not handed to the model", () => {
  const empty = SurveyDefinition.parse({ meta: { id: "e", code: "E", title: "E" }, questions: [], flow: [] });
  const r = interpretRequest(empty, "prepare a Word research plan");
  assert.equal(r.kind, "refused");
  assert.match(JSON.stringify(r), /nothing to write a research plan from yet/);
});

test("a retagged plan item's reason stops naming hypotheses it no longer serves (P-8 follow-up)", () => {
  const scale = () => ["1", "2", "3", "4", "5"].map((l, i) => ({ code: i + 1, label: l }));
  const d = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    research: { objective: "o", hypotheses: ["Brand trust increases purchase intention", "Advertising exposure raises awareness"], constructs: [
      { name: "Brand trust", role: "independent", questionIds: ["t1"] }, { name: "Purchase intention", role: "dependent", questionIds: ["pi"] },
      { name: "Advertising exposure", role: "independent", questionIds: ["ad"] }, { name: "Awareness", role: "dependent", questionIds: ["aw"] }] },
    questions: [
      { id: "aw", code: "Q1", variableName: "AW", type: "multi_select", text: "Aware", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
      { id: "ad", code: "Q2", variableName: "AD", type: "single_select", text: "Seen ads", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "t1", code: "Q3", variableName: "T1", type: "single_select", text: "Trust", options: scale() },
      { id: "pi", code: "Q5", variableName: "PI", type: "single_select", text: "Intent", options: scale(), analysis: { hypotheses: ["H1", "H2"] } },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["aw", "ad", "t1", "pi"] }],
  });
  const plan = buildAnalysisFramework(d, { now: "" });
  for (const x of plan.crosstabs) {
    const named = /\((H\d+(?:, H\d+)*)\)/.exec(x.reason ?? "")?.[1]?.split(", ") ?? [];
    assert.deepEqual(named, named.length ? x.hypotheses : [], `${x.reason} serves ${JSON.stringify(x.hypotheses)}`);
  }
});
