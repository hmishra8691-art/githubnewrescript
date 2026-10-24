import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { start, advance, goBack, setAnswer } from "./flow.js";
import { scopeDefinitionToNode } from "./blockPreview.js";

/**
 * A44 (19/10/2026): "Preview block" runs a definition scoped to the block —
 * only its questions, Back never crosses into another block, and the run ends
 * right after it.
 */
const q = (id: string, type = "open_text") => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: `${id}?` });
const survey = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Scoped", version: "1" },
  questions: [
    q("a1"), q("a2"),
    { ...q("b1", "single_select"), options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }] },
    { ...q("b2"), displayLogic: { type: "rule", source: { kind: "question", ref: "b1" }, operator: "eq", value: "1" } },
    q("b3"),
    q("c1"), q("c2"),
    q("l1"),
  ],
  embeddedData: [],
  flow: [
    { type: "embedded_data", id: "ed0", fields: [{ name: "REGION", source: "static", value: "north", dataType: "string" }] },
    { type: "page", id: "blockA", title: "Block A", questionIds: ["a1", "a2"] },
    { type: "block", id: "blockB", title: "Block B", children: [
      { type: "embedded_data", id: "edB", fields: [{ name: "INB", source: "static", value: "1", dataType: "string" }] },
      { type: "page", id: "b_p1", questionIds: ["b1", "b2"] },
      { type: "page", id: "b_p2", questionIds: ["b3"] },
    ] },
    { type: "page", id: "blockC", title: "Block C", questionIds: ["c1", "c2"],
      visibleIf: { type: "rule", source: { kind: "question", ref: "b1" }, operator: "eq", value: "1" } },
    { type: "loop", id: "loop1", loopVar: "item", source: { kind: "static", items: [{ code: "x", label: "X" }, { code: "y", label: "Y" }] }, children: [
      { type: "page", id: "blockL", title: "Looped", questionIds: ["l1"] },
    ] },
    { type: "end", id: "e", status: "complete", message: "All done" },
  ],
});
const at = (r: ReturnType<typeof advance>) => {
  const s = r.steps[r.stepIndex];
  return s?.kind === "page" ? s.pageId : s?.kind;
};
const pageIds = (def: SurveyDefinition) => {
  const ids: string[] = [];
  const walk = (ns: any[]) => { for (const n of ns) { if (n.type === "page") ids.push(n.id); for (const l of [n.children, n.otherwise, ...(n.branches ?? []).map((b: any) => b.children)]) if (l) walk(l); } };
  walk(def.flow as any[]);
  return ids;
};

test("the scoped flow holds the chosen block, the embedded data before it, and one End — nothing else", () => {
  const def = survey();
  const scope = scopeDefinitionToNode(def, "blockB");
  assert.equal(scope.found, true);
  assert.equal(scope.title, "Block B");
  assert.deepEqual(pageIds(scope.def), ["b_p1", "b_p2"], "only the block's own pages");
  const types = (scope.def.flow as any[]).map((n) => n.type);
  assert.deepEqual(types, ["embedded_data", "block", "end"]);
  assert.equal((scope.def.flow as any[])[0].id, "ed0", "root-level embedded data before the block comes along");
  assert.equal((scope.def.flow as any[])[2].status, "complete");
  // the saved definition is untouched
  assert.equal(pageIds(def).length, 5);
  assert.equal(scope.def.questions, def.questions, "questions are shared, not copied");
});

test("Next never enters the next block and Back never enters the previous one; the run ends after the block", () => {
  const def = scopeDefinitionToNode(survey(), "blockB").def;
  const st = createResponseState(def);
  assert.equal(at(start(def, st)), "b_p1", "starts on the block's first page, past the embedded data");
  assert.equal(st.embedded.REGION, "north", "the embedded value is set");
  assert.equal(st.embedded.INB, "1", "embedded data inside the block ran too");
  assert.equal(at(goBack(def, st)), "b_p1", "Back on the first page stays — Block A is not there to go to");
  setAnswer(def, st, "b1", "1", null);
  assert.equal(at(advance(def, st)), "b_p2", "the block's own page break is respected");
  assert.equal(at(goBack(def, st)), "b_p1");
  assert.equal(at(advance(def, st)), "b_p2");
  const r = advance(def, st);
  assert.equal(r.done, true, "after the last page the block preview is complete");
  assert.equal(r.endStatus, "complete");
  assert.equal(r.steps.some((s) => s.kind === "page" && /^blockC|^blockA/.test(s.pageId)), false, "no other block's page was ever compiled");
});

test("display logic WITHIN the block still works", () => {
  const def = scopeDefinitionToNode(survey(), "blockB").def;
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "b1", "2", null);
  const step = advance(def, st).steps[st.stepIndex];
  assert.equal(step?.kind === "page" ? step.pageId : "", "b_p2");
  // b2 is hidden by its display logic when b1 = 2: the page still has b1 only visible, which the Runner resolves per question
  assert.deepEqual(def.questions.find((x) => x.id === "b2")?.displayLogic?.type, "rule");
});

test("the block's own display logic is lifted off and reported as the gate; survey-level logic elsewhere is dropped with the other blocks", () => {
  const scope = scopeDefinitionToNode(survey(), "blockC");
  assert.ok(scope.gate, "the gate is returned");
  assert.equal((scope.def.flow as any[]).find((n) => n.id === "blockC").visibleIf, undefined, "…and removed from the scoped copy");
  const st = createResponseState(scope.def);
  assert.equal(at(start(scope.def, st)), "blockC", "the block shows for testing even though b1 is unanswered");
});

test("a block inside a loop keeps its loop, pruned to the block", () => {
  const scope = scopeDefinitionToNode(survey(), "blockL");
  const flow = scope.def.flow as any[];
  assert.deepEqual(flow.map((n) => n.type), ["embedded_data", "loop", "end"]);
  assert.deepEqual(flow[1].children.map((n: any) => n.id), ["blockL"]);
  const st = createResponseState(scope.def);
  const nav = start(scope.def, st);
  assert.equal(at(nav), "blockL@x", "iteration 1");
  assert.equal(at(advance(scope.def, st)), "blockL@y", "iteration 2");
  assert.equal(advance(scope.def, st).done, true);
});

test("previewing a whole group (section) scopes to the group", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "g", code: "G", title: "Grouped", version: "1" },
    questions: [q("a"), q("b"), q("c")],
    flow: [
      { type: "page", id: "pa", questionIds: ["a"] },
      { type: "section", id: "grp", title: "Group", children: [{ type: "page", id: "pb", questionIds: ["b"] }, { type: "page", id: "pc", questionIds: ["c"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const scope = scopeDefinitionToNode(def, "grp");
  assert.deepEqual(pageIds(scope.def), ["pb", "pc"]);
  assert.equal(scope.title, "Group");
});

test("an unknown id leaves the definition alone", () => {
  const def = survey();
  const scope = scopeDefinitionToNode(def, "nope");
  assert.equal(scope.found, false);
  assert.equal(scope.def, def);
  assert.equal(scopeDefinitionToNode(def, undefined).found, false);
});
