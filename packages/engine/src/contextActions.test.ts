import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { contextActions } from "./contextActions.js";
import { interpretRequest } from "./nlIntent.js";

/*
 * WHAT CAN BE DONE TO WHAT IS SELECTED: only operations valid for the object,
 * and every ready one a sentence the interpreter carries out.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Which brands have you bought?", options: [...opts("Brand A", "Brand B"), { code: 99, label: "None of these" }] },
      { id: "q3", code: "Q3", variableName: "FAV", type: "single_select", text: "Which is your favourite?", options: opts("Brand A", "Brand B"), required: true },
      { id: "q4", code: "Q4", variableName: "WHY", type: "open_text", text: "Why?" },
      { id: "q5", code: "Q5", variableName: "EMAIL", type: "open_text", text: "Your email?" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3", "q4", "q5"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });
}
const labels = (xs: { group: string; label: string }[], g?: string) => xs.filter((x) => !g || x.group === g).map((x) => x.label);

test("a multi-select offers its options, selection counts and a None that is not yet exclusive; a numeric question offers a range, not options", () => {
  const def = survey();
  const multi = contextActions(def, { questionId: "q2" });
  assert.ok(labels(multi, "Options").includes("Add “Other (please specify)”"));
  assert.ok(!labels(multi, "Options").includes("Add “None of these”"), "it already has one");
  assert.ok(labels(multi, "Options").includes("Make “None of these” exclusive"));
  assert.ok(labels(multi, "Options").includes("Randomize, keeping “None of these” last"));
  assert.deepEqual(labels(multi, "Validation"), ["Make required", "Minimum selections", "Maximum selections", "Exact selections"]);
  const num = contextActions(def, { questionId: "q1" });
  assert.deepEqual(labels(num, "Options"), [], "a number has no options");
  assert.ok(labels(num, "Validation").includes("Allowed range") && labels(num, "Validation").includes("Whole numbers only"));
  assert.ok(!labels(num, "Validation").includes("Minimum selections"));
});

test("only what the engine would carry out is offered ready: a required question offers “Make optional”; a mask only from an earlier question with the same choices", () => {
  const def = survey();
  const fav = contextActions(def, { questionId: "q3" });
  assert.ok(labels(fav, "Validation").includes("Make optional") && !labels(fav, "Validation").includes("Make required"));
  assert.ok(labels(fav, "Options").includes("Show only what was chosen at Q2"), "Q2 is earlier and offers the same brands");
  assert.ok(!labels(contextActions(def, { questionId: "q2" }), "Options").some((l) => /Show only what was chosen/.test(l)), "nothing earlier offers Q2's choices");
  for (const a of [...fav, ...contextActions(def, { questionId: "q2" }), ...contextActions(def, { questionId: "q1" })].filter((x) => x.ready)) {
    const it = interpretRequest(def, a.sentence);
    assert.ok(it.kind === "actions" || it.kind === "answer", `${a.label}: “${a.sentence}” → ${it.kind} ${"reason" in it ? it.reason : ""}`);
  }
  // the last question has nothing after it to skip to or break before
  const last = contextActions(def, { questionId: "q5" });
  assert.ok(!labels(last, "Logic").includes("Add skip logic") && !labels(last, "Structure").includes("Page break after"));
  assert.ok(labels(last, "Validation").includes("Must be an email address"));
  assert.ok(last.find((x) => x.label === "Delete")!.destructive);
});

test("an option and a block have their own operations; display logic offers AND / OR / remove once there is some", () => {
  const def = survey();
  const opt = contextActions(def, { questionId: "q2", option: 99 });
  assert.ok(labels(opt).includes("Make exclusive") && labels(opt).includes("Remove option") && labels(opt).includes("What breaks if it is removed"));
  assert.deepEqual(contextActions(def, { questionId: "q2", option: 42 }), [], "no such option");
  const block = contextActions(def, { blockId: "b1" });
  assert.ok(labels(block).includes("Delete block and its questions"));
  def.questions[2].displayLogic = { type: "rule", source: { kind: "question", ref: "q1" }, operator: "gt", value: 18 } as never;
  const logic = labels(contextActions(def, { questionId: "q3" }), "Logic");
  assert.ok(logic.includes("Add an AND condition") && logic.includes("Add an OR condition") && logic.includes("Remove display logic"));
  assert.ok(!logic.includes("Add display logic"));
});

test("fast enough to run on every selection of a 60-question survey", () => {
  const base = survey();
  const many = structuredClone(base);
  for (let i = 6; i <= 60; i++) many.questions.push({ ...structuredClone(base.questions[1]), id: `q${i}`, code: `Q${i}`, variableName: `V${i}` } as never);
  (many.flow[0] as { children: { questionIds: string[] }[] }).children[1].questionIds.push(...many.questions.slice(5).map((q) => q.id));
  const def = SurveyDefinition.parse(many);
  const t0 = Date.now();
  contextActions(def, { questionId: "q30" });
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `${ms} ms`);
});

test("the edges: no “None” or selection counts for a single choice; a mask only once, and only from an EARLIER question", () => {
  const def = survey();
  const fav = contextActions(def, { questionId: "q3" });
  assert.ok(!labels(fav, "Options").includes("Add “None of these”"), "a single choice does not get a None option offered");
  assert.ok(!labels(fav, "Validation").some((l) => /selections/.test(l)), "selection counts are for a multi-select");
  /* a question that already has a mask offers to remove it, not to add another */
  def.questions[2].mask = { expr: { kind: "ref", questionId: "q2", selection: "selected" }, action: "display", keepAlwaysShow: true } as never;
  const masked = labels(contextActions(def, { questionId: "q3" }), "Options");
  assert.ok(masked.includes("Remove the mask") && !masked.some((l) => /Show only what was chosen/.test(l)), masked.join(" | "));
  /* a LATER multi-select with the same choices is not a source */
  const later = survey();
  later.questions.push({ id: "q6", code: "Q6", variableName: "AGAIN", type: "multi_select", text: "Which again?", options: [{ code: 1, label: "Brand A" }, { code: 2, label: "Brand B" }], flags: [] } as never);
  (later.flow[0] as { children: { questionIds: string[] }[] }).children[1].questionIds.push("q6");
  const first = labels(contextActions(SurveyDefinition.parse(later), { questionId: "q2" }), "Options");
  assert.ok(!first.some((l) => /Show only what was chosen at Q6/.test(l)), first.join(" | "));
});
