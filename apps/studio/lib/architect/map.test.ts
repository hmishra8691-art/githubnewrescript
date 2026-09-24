import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { buildDependencyIndex, objectStatus } from "@rescript/engine";
import { buildSurveyMap, flattenMap, ancestorKeys, containerKeys, findMapNode } from "./map.ts";

/**
 * THE SURVEY MAP mirrors the flow's structure and never loses a question.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Mapped" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
      { id: "q2", code: "Q2", variableName: "REGION", type: "single_select", text: "Region?", options: [{ code: "N", label: "North" }, { code: "S", label: "South" }] },
      { id: "q3", code: "Q3", variableName: "WHY", type: "text", text: "Why north?", displayLogic: cond.rule("q2", "eq", "N") },
      { id: "q4", code: "Q4", variableName: "WHYS", type: "text", text: "Why south?" },
      { id: "q5", code: "Q5", variableName: "LOOPQ", type: "text", text: "Per region" },
      { id: "q9", code: "Q9", variableName: "LOST", type: "text", text: "Nowhere" },
    ],
    displayRules: [{ id: "dr1", label: "Adults", target: { kind: "question", ref: "q2" }, action: "show", when: cond.rule("q1", "gte", 18) }],
    calculations: [{ id: "c1", targetVariable: "AGE2", expression: "AGE * 2" }],
    quotas: [{ id: "qt1", name: "North cap", cells: [{ id: "cell", label: "N", when: cond.rule("q2", "eq", "N"), limit: 50 }] }],
    flow: [
      { type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] },
      { type: "branch", id: "br", title: "By region", branches: [
        { id: "arm_n", label: "North", when: cond.rule("q2", "eq", "N"), children: [{ type: "page", id: "p2", questionIds: ["q3"] }] },
      ], otherwise: [{ type: "page", id: "p3", questionIds: ["q4"] }] },
      { type: "block", id: "blk", title: "Two pages", visibleIf: cond.rule("q1", "gte", 18), children: [
        { type: "page", id: "p4", questionIds: [] },
        { type: "loop", id: "lp", loopVar: "region", source: { kind: "question", questionId: "q2" }, children: [{ type: "page", id: "p5", questionIds: ["q5"] }] },
      ] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("the map mirrors the flow: block, branch with arms and otherwise, conditional block, loop, end", () => {
  const root = buildSurveyMap(survey());
  const kinds = root.children.map((n) => n.kind);
  assert.deepEqual(kinds, ["block", "branch", "block", "end", "group", "rules", "calculations", "quotas"]);
  const branch = root.children[1];
  assert.deepEqual(branch.children.map((n) => `${n.kind}:${n.label}`), ["arm:North", "otherwise:Otherwise"]);
  assert.match(branch.children[0].detail!, /^IF Q2 is/);
  const blk = root.children[2];
  assert.equal(blk.conditional, true);
  assert.match(blk.detail!, /^shown when/);
  assert.deepEqual(blk.children.map((n) => n.kind), ["page", "loop"]);
  assert.equal(blk.children[1].code, "region");
  assert.match(blk.children[1].detail!, /over Q2/);
});

test("a lone-page block shows its questions directly; block numbering counts blocks in order", () => {
  const root = buildSurveyMap(survey());
  assert.equal(root.children[0].label, "Block 1 · Screener");
  assert.deepEqual(root.children[0].children.map((n) => n.code), ["Q1", "Q2"]);
  // pages inside the branch's arms are blocks too — the same numbering `listBlocks` gives the Questions panel
  assert.equal(root.children[2].label, "Block 4 · Two pages");
});

test("every question appears exactly once, and an unplaced one lands under 'Not on any page'", () => {
  const root = buildSurveyMap(survey());
  const codes: string[] = [];
  const visit = (n: typeof root) => { if (n.kind === "question") codes.push(n.code!); n.children.forEach(visit); };
  visit(root);
  assert.deepEqual([...codes].sort(), ["Q1", "Q2", "Q3", "Q4", "Q5", "Q9"]);
  assert.equal(new Set(codes).size, codes.length, "no question twice");
  const lost = root.children.find((n) => n.id === "unplaced")!;
  assert.deepEqual(lost.children.map((n) => n.code), ["Q9"]);
});

test("rules, calculations and quotas are sections with selectable children keyed by engine ObjectKey", () => {
  const root = buildSurveyMap(survey());
  const rules = root.children.find((n) => n.kind === "rules")!;
  assert.equal(rules.selectable, false);
  assert.equal(rules.children[0].key, "displayRule:dr1");
  assert.match(rules.children[0].detail!, /^SHOW Q2 when/);
  const calcs = root.children.find((n) => n.kind === "calculations")!;
  assert.equal(calcs.children[0].key, "calculation:c1");
  assert.equal(calcs.children[0].detail, "AGE * 2");
  const quotas = root.children.find((n) => n.kind === "quotas")!;
  assert.equal(quotas.children[0].key, "quota:qt1");
});

test("status rolls up: a broken question colours its block, and the counts come from the engine", () => {
  const def = survey();
  def.questions[2] = { ...def.questions[2], displayLogic: cond.rule("q_missing", "eq", 1) } as never;
  const root = buildSurveyMap(def, { status: objectStatus(def), index: buildDependencyIndex(def) });
  const branch = root.children[1];
  assert.notEqual(branch.status, "ok", "the branch holds the broken Q3");
  assert.notEqual(branch.children[0].status, "ok", "and so does its North arm");
  const q3 = findMapNode(root, "question:q3")!;
  assert.notEqual(q3.status, "ok");
  assert.ok(q3.issueCount >= 1);
  const q2 = findMapNode(root, "question:q2")!;
  assert.ok(q2.usedBy >= 3, `Q2 is read by the branch, the loop, a rule and a quota: ${q2.usedBy}`);
  const clean = buildSurveyMap(survey(), { status: objectStatus(survey()) });
  assert.equal(clean.children[1].status, "ok");
});

test("flattenMap honours collapse and reports depth and expansion", () => {
  const root = buildSurveyMap(survey());
  const all = flattenMap(root, new Set());
  assert.equal(all[0].depth, 0);
  assert.equal(all[0].label, "Block 1 · Screener");
  assert.equal(all[1].depth, 1);
  assert.equal(all[1].code, "Q1");
  const collapsed = flattenMap(root, new Set(["flowNode:p1", "flowNode:br"]));
  assert.ok(!collapsed.some((r) => r.code === "Q1"), "a collapsed block hides its questions");
  assert.ok(!collapsed.some((r) => r.kind === "arm"), "a collapsed branch hides its arms");
  assert.equal(collapsed.find((r) => r.key === "flowNode:p1")!.expanded, false);
  assert.ok(collapsed.length < all.length);
});

test("a question placed on two pages appears at both positions, with distinct row ids", () => {
  const def = survey();
  (def.flow[2] as { children: { type: string; questionIds?: string[] }[] }).children[0].questionIds = ["q1"]; // Q1 also on p4
  const rows = flattenMap(buildSurveyMap(def), new Set());
  const q1 = rows.filter((r) => r.key === "question:q1");
  assert.equal(q1.length, 2, "one object, two positions");
  assert.notEqual(q1[0].rowId, q1[1].rowId);
  assert.equal(new Set(rows.map((r) => r.rowId)).size, rows.length, "every row id unique");
});

test("ancestorKeys gives the path to expand for a deep selection; containerKeys lists what can collapse", () => {
  const root = buildSurveyMap(survey());
  assert.deepEqual(ancestorKeys(root, "question:q5"), ["flowNode:blk", "flowNode:lp", "flowNode:p5"]);
  assert.deepEqual(ancestorKeys(root, "question:q3"), ["flowNode:br", "arm:arm_n", "flowNode:p2"]);
  assert.deepEqual(ancestorKeys(root, "question:q1"), ["flowNode:p1"]);
  const containers = containerKeys(root);
  assert.ok(containers.includes("flowNode:br") && containers.includes("section:rules"));
  assert.ok(!containers.includes("question:q1"));
});
