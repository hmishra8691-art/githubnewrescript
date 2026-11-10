import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { compileFlow, createResponseState, createScriptCtx, evaluateCondition, loopContexts, resolvePiping, safeExpression } from "./index.js";
import type { LoopFlowNode } from "./loops.js";
import { withResolvedReferences } from "./loopReferences.js";

/**
 * DYNAMIC LOOP REFERENCES — every source resolves to the respondent's real value, for the current iteration,
 * wherever the reference is read (piping, conditions, calculations, scripts), and a static column is unchanged.
 */

function survey(columns: unknown[], values: Record<string, Record<string, unknown>> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Dynamic refs", version: "1.0" },
    questions: [
      { id: "q2", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Brands?",
        options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 97, label: "Other (please specify)", flags: ["other_specify"] }] },
      { id: "q3", code: "Q3", variableName: "SCORE", type: "numeric", text: "Score?" },
      { id: "q6", code: "Q6", variableName: "SAT", type: "single_select", text: "Satisfied with {{loop.Shown}}?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q9", code: "Q9", variableName: "AFTER", type: "text", text: "after" },
    ],
    embeddedData: [{ name: "REGION", defaultValue: "West" }],
    flow: [
      { type: "page", id: "p1", questionIds: ["q2", "q3"] },
      { type: "loop", id: "L", loopVar: "brand", source: { kind: "question", questionId: "q2", filter: "selected" },
        references: { columns, values },
        children: [{ type: "page", id: "p6", questionIds: ["q6"] }] },
      { type: "page", id: "p9", questionIds: ["q9"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

const COLUMNS = [
  { name: "Static_Code", dataType: "text" },
  { name: "Nick", source: { kind: "text", text: "{{loop.label}} ({{Q3}} pts)\nline two" } },
  { name: "Double", dataType: "number", source: { kind: "calculation", expr: "Q3 * 2" } },
  { name: "Typed", source: { kind: "item", part: "other" } },
  { name: "Shown", source: { kind: "item", part: "displayed" } },
  { name: "Score", dataType: "number", source: { kind: "answer", question: "Q3", part: "value" } },
  { name: "AllBrands", source: { kind: "answer", question: "Q2", part: "displayed", join: " | " } },
  { name: "BrandLabels", source: { kind: "answer", question: "Q2", part: "label" } },
  { name: "OtherText", source: { kind: "answer", question: "Q2", part: "other" } },
  { name: "Region", source: { kind: "variable", name: "REGION" } },
  { name: "Sat", source: { kind: "answer", question: "Q6", part: "value" } },
];

function setup() {
  const def = survey(COLUMNS, { "1": { Static_Code: "AP" }, "2": { Static_Code: "SA" }, "97": { Static_Code: "OT", Nick: "ignored — Nick is dynamic" } });
  const state = createResponseState(def, { seed: 3 });
  state.answers.q2 = [1, 97];
  state.answers["q2__other__97"] = "Nokia";
  state.answers.q3 = 21;
  const loops = compileFlow(def, state).filter((s) => s.kind === "page" && (s as any).loop).map((s) => (s as any).loop);
  return { def, state, loops };
}

test("static columns are unchanged; a dynamic column ignores cells typed before it became dynamic", () => {
  const { def, state, loops } = setup();
  assert.equal(loops.length, 2);
  assert.equal(resolvePiping("{{loop.Static_Code}}", { def, state, loop: loops[0] }), "AP");
  assert.equal(resolvePiping("{{loop.Static_Code}}", { def, state, loop: loops[1] }), "OT");
  assert.equal(resolvePiping("{{loop.Nick}}", { def, state, loop: loops[1] }).startsWith("Other (please specify) (21 pts)"), true);
});

test("text with piping: static words, a newline delimiter and any token, per item", () => {
  const { def, state, loops } = setup();
  assert.equal(resolvePiping("[{{loop.Nick}}]", { def, state, loop: loops[0] }), "[Apple (21 pts)\nline two]");
});

test("calculation: evaluated inside the iteration, typed by the column", () => {
  const { def, state, loops } = setup();
  assert.equal(resolvePiping("{{loop.Double}}", { def, state, loop: loops[0] }), "42");
  assert.equal(safeExpression("loop.Double + 1", def, state, loops[0]), 43);
  assert.equal(evaluateCondition({ type: "rule", source: { kind: "loop", ref: "Double" }, operator: "gte", value: 40 } as any, { def, state, loop: loops[0] }), true);
});

test("Other – please specify: the item's typed text, and the displayed value falls back to the label", () => {
  const { def, state, loops } = setup();
  assert.equal(resolvePiping("{{loop.Typed}}", { def, state, loop: loops[1] }), "Nokia");
  assert.equal(resolvePiping("{{loop.Typed}}", { def, state, loop: loops[0] }), "", "Apple has no Other box");
  assert.equal(resolvePiping("{{loop.Shown}}", { def, state, loop: loops[1] }), "Nokia");
  assert.equal(resolvePiping("{{loop.Shown}}", { def, state, loop: loops[0] }), "Apple");
  /* the question inside the loop pipes it */
  assert.equal(resolvePiping(def.questions.find((q) => q.id === "q6")!.text, { def, state, loop: loops[1] }), "Satisfied with Nokia?");
});

test("answers: value, labels, Other text and the answer as displayed", () => {
  const { def, state, loops } = setup();
  const ctx = { def, state, loop: loops[0] };
  assert.equal(resolvePiping("{{loop.Score}}", ctx), "21");
  assert.equal(resolvePiping("{{loop.AllBrands}}", ctx), "Apple | Nokia", "the Other choice is shown as what was typed");
  assert.equal(resolvePiping("{{loop.BrandLabels}}", ctx), "Apple, Other (please specify)");
  assert.equal(resolvePiping("{{loop.OtherText}}", ctx), "Nokia");
});

test("variables: embedded (and calculated / answer) by name", () => {
  const { def, state, loops } = setup();
  state.embedded.REGION = "North";
  assert.equal(resolvePiping("{{loop.Region}}", { def, state, loop: loops[0] }), "North");
});

test("resolved live: an answer given after the loop compiled is read where the reference is piped", () => {
  const { def, state, loops } = setup();
  assert.equal(resolvePiping("{{loop.Sat}}", { def, state, loop: loops[0] }), "");
  state.answers["q6@1"] = 2;
  assert.equal(resolvePiping("{{loop.Sat}}", { def, state, loop: loops[0] }), "2", "the iteration's own answer");
  assert.equal(resolvePiping("{{loop.Sat}}", { def, state, loop: loops[1] }), "", "not another iteration's");
  state.answers.q3 = 5;
  assert.equal(resolvePiping("{{loop.Double}}", { def, state, loop: loops[0] }), "10");
});

test("scripts and the sandbox snapshot see the resolved values; contexts still clone", () => {
  const { def, state, loops } = setup();
  const ctx = createScriptCtx(def, state, loops[1], { logs: [], errors: [] });
  assert.equal(ctx.getCurrentLoopReference("Typed"), "Nokia");
  assert.equal(ctx.getCurrentLoopItem()!.references.Double, 42);
  const snap = withResolvedReferences({ def, state }, loops[1])!;
  assert.equal(snap.references!.Shown, "Nokia");
  assert.doesNotThrow(() => structuredClone(loops[1]));
});

test("ordering and the compiled snapshot use the dynamic values", () => {
  const def = survey([{ name: "Rank", dataType: "number", source: { kind: "calculation", expr: "100 - loop.code" } }]);
  const node = def.flow.find((n) => n.type === "loop") as LoopFlowNode;
  (node as any).order = { kind: "priority", column: "Rank", direction: "asc" };
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 2, 97];
  const ctxs = loopContexts(def, state, node);
  assert.deepEqual(ctxs.map((c) => c.code), ["97", "2", "1"], "100 - code ascending");
  assert.deepEqual(ctxs.map((c) => c.references!.Rank), [3, 98, 99]);
});

test("as many references as needed: 40 columns resolve independently", () => {
  const cols = Array.from({ length: 40 }, (_, i) => ({ name: `R${i + 1}`, source: { kind: "text", text: `${i + 1}:{{loop.code}}` } }));
  const def = survey(cols);
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [2];
  const loop = (compileFlow(def, state).find((s) => (s as any).loop) as any).loop;
  assert.equal(resolvePiping("{{loop.R1}}|{{loop.R40}}", { def, state, loop }), "1:2|40:2");
});

test("a reference that reads itself is cut, not a hang", () => {
  const def = survey([{ name: "Self", source: { kind: "text", text: "x{{loop.Self}}" } }]);
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1];
  const loop = (compileFlow(def, state).find((s) => (s as any).loop) as any).loop;
  const v = resolvePiping("{{loop.Self}}", { def, state, loop });
  assert.match(v, /^x+$/);
  assert.ok(v.length <= 8);
});

test("the lint checks dynamic sources and does not ask for typed values of a dynamic required column", async () => {
  const { lintLoops } = await import("./index.js");
  const def = survey([
    { name: "Bad_Q", source: { kind: "answer", question: "Q404" } },
    { name: "Bad_Calc", source: { kind: "calculation", expr: "Q3 * (" } },
    { name: "Req_Dyn", required: true, source: { kind: "item", part: "label" } },
  ]);
  const msgs = lintLoops(def).map((x: any) => x.message).join("\n");
  assert.match(msgs, /Bad_Q.*Q404/);
  assert.match(msgs, /Bad_Calc.*does not parse/);
  assert.doesNotMatch(msgs, /required column "Req_Dyn"/);
});

/* ============================================================ existing blocks and questions into a loop */

function flowSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "f", code: "F", title: "Insert", version: "1.0" },
    questions: [
      { id: "q2", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Brands?", options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }] },
      { id: "q5", code: "Q5", variableName: "LIKE", type: "single_select", text: "Do you like {{loop.label}}?", required: true,
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q7", code: "Q7", variableName: "WHY", type: "text", text: "Why?" },
      { id: "q8", code: "Q8", variableName: "AGE", type: "numeric", text: "Age?" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", questionIds: ["q2"] }] },
      { type: "block", id: "b2", title: "Brand block", children: [{ type: "page", id: "p5", questionIds: ["q5", "q7"] }] },
      { type: "page", id: "p8", questionIds: ["q8"] },
      { type: "loop", id: "L", loopVar: "brand", source: { kind: "question", questionId: "q2", filter: "selected" }, children: [] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("choices: blocks and questions, each selectable or not with the reason", async () => {
  const { loopInsertChoices } = await import("./loopInsert.js");
  const c = loopInsertChoices(flowSurvey(), "L");
  const b = Object.fromEntries(c.blocks.map((x) => [x.title, x]));
  assert.equal(b["Screener"].selectable, false);
  assert.match(b["Screener"].reason!, /Q2, the question this loop iterates over/);
  assert.equal(b["Brand block"].selectable, true);
  const q = Object.fromEntries(c.questions.map((x) => [x.code, x]));
  assert.equal(q.Q2.selectable, false);
  assert.equal(q.Q7.selectable, true);
});

test("a block moves in whole, with its questions' settings; the questions are asked per iteration", async () => {
  const { moveIntoLoop } = await import("./loopInsert.js");
  const def = flowSurvey();
  const before = JSON.stringify(def.questions);
  const r = moveIntoLoop(def, "b2", "L");
  assert.equal(r.moved, true, r.reason);
  const next = SurveyDefinition.parse({ ...def, flow: r.flow });
  assert.equal(JSON.stringify(next.questions), before, "no question was touched");
  const loop = next.flow.find((n) => n.type === "loop") as any;
  assert.deepEqual(loop.children.map((k: any) => k.id), ["b2"]);
  assert.equal(next.flow.some((n) => n.id === "b2"), false, "moved, not copied");
  const state = createResponseState(next, { seed: 1 });
  state.answers.q2 = [1, 2];
  const pages = compileFlow(next, state).filter((s) => s.kind === "page") as any[];
  assert.deepEqual(pages.map((p) => p.pageId), ["p1", "p8", "p5@1", "p5@2"]);
  assert.equal(resolvePiping(next.questions.find((q) => q.id === "q5")!.text, { def: next, state, loop: pages[3].loop }), "Do you like Samsung?");
});

test("a single question moves onto a page of its own in the loop; an emptied page is removed", async () => {
  const { moveIntoLoop } = await import("./loopInsert.js");
  const def = flowSurvey();
  const r = moveIntoLoop(def, "Q8", "L");
  assert.equal(r.moved, true, r.reason);
  const next = SurveyDefinition.parse({ ...def, flow: r.flow });
  assert.equal(next.flow.some((n) => n.id === "p8"), false, "p8 held only Q8");
  const loop = next.flow.find((n) => n.type === "loop") as any;
  assert.equal(loop.children.length, 1);
  assert.deepEqual(loop.children[0].questionIds, ["q8"]);
  /* a question taken from a shared page leaves the others where they were */
  const r2 = moveIntoLoop(next, "Q7", "L");
  const next2 = SurveyDefinition.parse({ ...next, flow: r2.flow });
  const b2 = next2.flow.find((n) => n.id === "b2") as any;
  assert.deepEqual(b2.children[0].questionIds, ["q5"]);
  assert.equal((next2.flow.find((n) => n.type === "loop") as any).children.length, 2);
  /* refused with the reason */
  const r3 = moveIntoLoop(next2, "Q2", "L");
  assert.equal(r3.moved, false);
  assert.match(r3.reason!, /iterates over its answers/);
});

test("renaming a variable follows into dynamic references: text tokens, calculations and variable sources", async () => {
  const { applyRename } = await import("./index.js");
  const def = survey([
    { name: "T", source: { kind: "text", text: "{{SCORE}} pts" } },
    { name: "C", source: { kind: "calculation", expr: "SCORE * 2" } },
    { name: "V", source: { kind: "variable", name: "SCORE" } },
    { name: "A", source: { kind: "answer", question: "q3", part: "value" } },
  ]);
  const next = applyRename(def, "SCORE", "POINTS") as typeof def;
  const cols = (next.flow.find((n) => n.type === "loop") as any).references.columns;
  assert.equal(cols[0].source.text, "{{POINTS}} pts");
  assert.equal(cols[1].source.expr, "POINTS * 2");
  assert.equal(cols[2].source.name, "POINTS");
  assert.equal(cols[3].source.question, "q3", "an answer source names the question by id — nothing to rewrite");
});
