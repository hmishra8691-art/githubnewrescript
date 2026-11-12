import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { COPILOT_FLOW_LOGIC_GUIDE, flowLogicIntent } from "./flowLogicGuide.ts";
import { copilotUserPrompt } from "./prompt.ts";
import { copilotCall } from "../aiPromptCache.ts";

/* 2026-11-07: the workflow-logic guide — branches, existing blocks into paths, ternary text / options */
const lines = (g: string) => g.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l.split("   //")[0]));

const def = () => SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Study" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Which product?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "How was it?", options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Pick", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `O${c}` })) },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Why?" },
    { id: "q5", code: "Q5", variableName: "Q5", type: "open_text", text: "Else?" },
  ],
  flow: [
    { type: "page", id: "p1", title: "Intro", questionIds: ["q1"] },
    { type: "page", id: "p2", title: "Product A block", questionIds: ["q2"] },
    { type: "page", id: "p3", title: "Product B block", questionIds: ["q3"] },
    { type: "page", id: "p4", title: "General block", questionIds: ["q4"] },
    { type: "page", id: "p5", title: "Follow-up", questionIds: ["q5"] },
    { type: "end", id: "e", status: "complete" },
  ],
});

test("sent for branch / dynamic-text requests, not otherwise; lifted into the cached prefix", () => {
  for (const m of ["Create a branch based on Q1's response", "split by Q1 and put the Product A block under A", "make Q2's text depend on the answer to Q1", "show different options in Q3 based on their answer to Q1", "use a ternary for the question text", "rename Branch 2 to Owners"]) {
    assert.ok(flowLogicIntent(m), m);
    const [system] = copilotCall(copilotUserPrompt({ outline: "(survey)", surveyLanguage: "English", mode: "edit", message: m }));
    assert.ok(system.some((b) => b.includes(COPILOT_FLOW_LOGIC_GUIDE)), `cached: ${m}`);
  }
  for (const m of ["Add a question about price", "make Q3 required", "translate the survey into Hindi"]) assert.ok(!flowLogicIntent(m), m);
});

test("every example in the guide is accepted by the gate and applied by the engine", () => {
  let d = def();
  const ex = lines(COPILOT_FLOW_LOGIC_GUIDE);
  assert.ok(ex.length >= 5);
  const c = coerceSurveyActions(ex);
  assert.deepEqual(c.rejected, []);
  for (const a of c.actions) {
    /* each example on the survey as the previous ones left it (rename / add refer to the split's branch) */
    const fixed = a.op === "rename_branch" ? { ...a, branch: "By Q1", paths: { "Q1 = B": "Owners" } } : a.op === "add_block_to_branch" ? { ...a, branch: "By Q1", path: "Q1 = C" } : a;
    const r = applySurveyActions(d, [fixed as never]);
    assert.deepEqual(r.errors, [], `${a.op}: ${r.errors.join("; ")}`);
    d = r.def;
  }
});

/* 2026-11-12: page structure, block placement, auto-select vs auto-advance, consent — written from this guide */
test("page structure and block placement: the intent, the inline examples through the gate, and the engine's repair of a batch", () => {
  for (const m of ["move the Demographics block before Screening", "add a new block after the Intro block", "put the consent question on its own page", "auto-select the same brand on the next page", "show one task per page", "don't auto-advance on Q2"]) assert.ok(flowLogicIntent(m), m);
  for (const m of ["Add a question about price", "make Q3 required", "rename the survey"]) assert.ok(!flowLogicIntent(m), m);
  assert.ok(COPILOT_FLOW_LOGIC_GUIDE.includes('"op":"move_block"') && COPILOT_FLOW_LOGIC_GUIDE.includes('"taskPaging"') && COPILOT_FLOW_LOGIC_GUIDE.includes('"singleOption"') && COPILOT_FLOW_LOGIC_GUIDE.includes('"consent":true'), "the guide names the new vocabulary");
  const c = coerceSurveyActions([
    { op: "create_block", title: "Warm-up", before: "Intro" },
    { op: "move_block", target: "Follow-up", after: "Intro" },
    { op: "update_question", target: "Q2", settings: { singleOption: "select" } },
    { op: "update_question", target: "Q1", settings: { consent: true } },
  ]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(def(), c.actions);
  assert.deepEqual(r.errors, []);
  const titles = (r.def.flow as { title?: string; type: string }[]).filter((n) => n.type === "page" || n.type === "block").map((n) => n.title);
  assert.deepEqual(titles, ["Warm-up", "Intro", "Follow-up", "Product A block", "Product B block", "General block"]);
  /* a batch that puts a consent question beside another question is repaired, and the reply is told */
  const built = applySurveyActions(def(), coerceSurveyActions([
    { op: "create_block", title: "Start", ref: "s", after: "start" },
    { op: "create_question", block: "s", type: "single_select", code: "CONSENT", text: "Do you agree to take part in this study?", options: ["Yes", "No"] },
    { op: "create_question", block: "s", type: "numeric", code: "AGE", text: "How old are you?" },
  ]).actions);
  assert.deepEqual(built.errors, []);
  assert.ok(built.warnings.some((w) => /^Page structure \(corrected\)/.test(w)), built.warnings.join(" | "));
});
