import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStructure, logicChips, objectTags, positionCrumb, scopeStructure } from "./structure.ts";
import { buildDependencyIndex } from "@rescript/engine";

function survey(): any {
  const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: `<p>${id} text</p>`, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }], required: false, ...extra });
  return {
    meta: { title: "t" },
    questions: [
      q("q1"),
      q("q2", { displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, validation: [{ id: "v1", kind: "max_length", value: 20 }] }),
      q("q3", { skipLogic: [{ id: "s1", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 2 }, target: { kind: "terminate", status: "screened" } }] }),
      q("h1", { type: "hidden" }),
      q("c1", { type: "conjoint_task" }),
      q("q6"),
      q("q7"),
    ],
    flow: [
      { type: "page", id: "pA", title: "Intro", questionIds: ["q1", "q2", "q3"] },
      { type: "branch", id: "br", branches: [{ id: "arm1", label: "Yes path", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, children: [{ type: "page", id: "pY", questionIds: ["h1"] }] }], otherwise: [] },
      { type: "block", id: "bB", title: "Tasks", visibleIf: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "answered" }, children: [
        { type: "page", id: "pB1", questionIds: ["c1", "q6"] },
        { type: "page", id: "pB2", questionIds: [] },
      ] },
      { type: "end", id: "end", status: "complete" },
    ],
    displayRules: [{ id: "dr1", label: "hide six", target: { kind: "question", ref: "q6" }, action: "hide", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 2 } }],
    calculations: [{ id: "calc1", targetVariable: "Q6", expression: "Q1 + 1", trigger: "on_page_submit", dataType: "numeric" }],
    quotas: [{ id: "qt1", name: "Yes sayers", mode: "count", limitType: "count", cells: [{ id: "cell1", label: "yes", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, limit: 10 }], onFull: { kind: "terminate" } }],
  };
}

test("buildStructure: blocks in order, pages with their breaks, questions with boundaries, elements with arms", () => {
  const d = survey();
  const s = buildStructure(d);
  assert.deepEqual(s.entries.map((e) => e.kind), ["block", "element", "block", "element"]);
  const a = s.entries[0]; assert.equal(a.kind, "block");
  if (a.kind !== "block") return;
  assert.equal(a.label, "Block 1"); assert.equal(a.title, "Intro");
  assert.deepEqual(a.pages[0].questions.map((q) => q.boundary), ["none", "none", "block"]);
  const b = s.entries[2]; if (b.kind !== "block") return assert.fail("block B");
  assert.equal(b.label, "Block 3", "the branch itself is not a block, but the page inside its arm is Block 2 — numbered in flow order, as the map numbers them");
  assert.match(b.condition ?? "", /Q1/);
  assert.equal(b.pages.length, 2);
  assert.deepEqual(b.pages[0].questions.map((q) => q.boundary), ["none", "page"], "the last question before a page break says so");
  assert.equal(s.blockCount, 3); assert.equal(s.pageCount, 4); assert.equal(s.breakCount, 1);
  const br = s.entries[1]; if (br.kind !== "element") return assert.fail("branch");
  assert.equal(br.type, "branch");
  assert.equal(br.children[0].label, "Yes path");
  assert.match(br.children[0].condition ?? "", /Q1/);
  assert.equal(br.children[0].entries[0].kind, "block");
  assert.deepEqual(s.unplaced.map((q) => q.code), ["Q7"]);
});

test("tags name the special objects: hidden variable, conjoint task, a screening skip", () => {
  const d = survey();
  const by = (id: string) => d.questions.find((q: any) => q.id === id);
  assert.deepEqual(objectTags(by("h1")), ["hidden"]);
  assert.deepEqual(objectTags(by("c1")), ["conjoint"]);
  assert.deepEqual(objectTags(by("q3")), ["screening"]);
  assert.deepEqual(objectTags(by("q1")), []);
  assert.deepEqual(objectTags({ ...by("q1"), type: "maxdiff_task" }), ["maxdiff"]);
});

test("logicChips: one chip per kind of logic, each pointing at its panel section or its object", () => {
  const d = survey();
  const index = buildDependencyIndex(d);
  const by = (id: string) => d.questions.find((q: any) => q.id === id);
  const q2 = logicChips(d, by("q2"), index);
  assert.deepEqual(q2.map((c) => [c.kind, c.section]), [["display", "display-logic"], ["validation", "validation-rules"]]);
  assert.match(q2[0].detail, /Shown when Q1/);
  assert.match(q2[1].detail, /maximum length 20/);
  const q3 = logicChips(d, by("q3"), index);
  assert.equal(q3[0].kind, "skip"); assert.equal(q3[0].label, "SKIP"); assert.match(q3[0].detail, /out \(screened\)/);
  const q6 = logicChips(d, by("q6"), index);
  assert.deepEqual(q6.map((c) => [c.kind, c.key]), [["rule", "displayRule:dr1"], ["calculation", "calculation:calc1"]]);
  assert.equal(q6[0].label, "HIDE");
  const q1 = logicChips(d, by("q1"), index);
  assert.deepEqual(q1.map((c) => c.kind), ["quota"], "a question a quota cell counts shows QUOTA");
  assert.equal(q1[0].key, "quota:qt1");
  assert.deepEqual(logicChips(d, by("q1")), [], "without the index the quota chip is not known");
});

test("positionCrumb and scopeStructure find a question's place and narrow to a container", () => {
  const s = buildStructure(survey());
  const c = positionCrumb(s, "q6");
  assert.ok(c); assert.equal(c!.block.label, "Block 3"); assert.equal(c!.page.n, 1); assert.equal(c!.index, 1);
  const inArm = positionCrumb(s, "h1");
  assert.equal(inArm?.block.title, undefined); assert.equal(inArm?.page.id, "pY");
  assert.equal(positionCrumb(s, "q7"), null);
  assert.deepEqual(scopeStructure(s, "flowNode:bB").map((e) => e.id), ["bB"]);
  assert.deepEqual(scopeStructure(s, "flowNode:pB2").map((e) => e.id), ["bB"], "a page scopes to its block");
  assert.equal(scopeStructure(s, null).length, 4);
  assert.equal(scopeStructure(s, "flowNode:nope").length, 4, "an unknown key is the whole survey");
});
