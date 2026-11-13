import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { loopPlainSummary, loopChecks, loopExtras, suggestLoopSource, suggestLoopSourceInFlow, loopSourceWords } from "./index.js";
import type { LoopFlowNode } from "./loopModel.js";

const BRANDS = [{ code: 1, label: "Nike" }, { code: 2, label: "Adidas" }, { code: 3, label: "Puma" }];
const make = (loop: Record<string, unknown>, extraQs: unknown[] = [], flowAfter: unknown[] = []) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Brands", options: BRANDS },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Rate", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) })) },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Why" },
    ...extraQs,
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "loop", id: "L", loopVar: "brand", source: { kind: "question", questionId: "q2", filter: "selected" }, children: [{ type: "page", id: "p2", questionIds: ["q3", "q4"] }], ...loop },
    ...flowAfter,
    { type: "end", id: "e", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const loopOf = (d: SurveyDefinition) => d.flow.find((n) => n.type === "loop") as LoopFlowNode;
const say = (loop: Record<string, unknown> = {}) => { const d = make(loop); return loopPlainSummary(d, loopOf(d)); };
const checks = (loop: Record<string, unknown> = {}, extraQs: unknown[] = [], after: unknown[] = []) => { const d = make(loop, extraQs, after); return loopChecks(d, loopOf(d)); };

test("the common loop reads as one sentence a researcher would say", () => {
  assert.deepEqual(say(), ["Repeats 2 questions (Q3, Q4) once for each answer the respondent chose at Q2."]);
  assert.deepEqual(say({ count: { mode: "max", value: 2 }, order: { kind: "random" } }), ["Repeats 2 questions (Q3, Q4) once for each answer the respondent chose at Q2 — at most 2 of them, in random order."]);
  assert.match(say({ source: { kind: "static", items: [{ code: "1", label: "Tea" }, { code: "2", label: "Coffee" }] } })[0], /once for each of 2 items in its own list \(Tea, Coffee\)\.$/);
  assert.equal(say({ source: { kind: "count", count: 3 } })[0], "Repeats 2 questions (Q3, Q4) 3 times.");
  assert.match(say({ source: { kind: "question", questionId: "q2", filter: "notSelected" } })[0], /each answer the respondent did not choose at Q2/);
  assert.match(say({ maxIterations: 4, randomizeIterations: true })[0], /at most 4 of them, in random order/, "the older fields read the same");
});

test("every extra setting adds its own plain sentence", () => {
  const rule = { type: "rule", source: { kind: "question", ref: "q3" }, operator: "selected", value: 5 };
  const lines = say({ breakIf: rule, skipIf: rule, eligibleIf: rule, resolveSource: "once", aggregates: [{ name: "AVG", questionRef: "Q3", op: "avg" }] });
  assert.equal(lines.length, 6);
  assert.match(lines[1], /^Only for items where /);
  assert.match(lines[2], /^Leaves an item out when /);
  assert.match(lines[3], /^Stops repeating once /);
  assert.match(lines[4], /fixed when the respondent first reaches/);
  assert.match(lines[5], /works out 1 total across the rounds \(AVG\)/);
  for (const l of lines) assert.doesNotMatch(l, /CONTINUE|BREAK|UNTIL|iteration|resolve|eligib/i, l);
});

test("a healthy loop raises nothing; each mistake is named with what to do", () => {
  assert.deepEqual(checks(), []);
  const msg = (c: ReturnType<typeof checks>) => c.map((x) => `${x.level}:${x.message}`).join("\n");
  assert.match(msg(checks({ children: [] })), /warning:Nothing is inside this loop yet/);
  assert.match(msg(checks({ source: { kind: "question", questionId: "gone", filter: "selected" } })), /problem:The question this loop reads no longer exists/);
  assert.match(msg(checks({ source: { kind: "question", questionId: "q4", filter: "selected" }, children: [{ type: "page", id: "p2", questionIds: ["q3"] }] }, [], [{ type: "page", id: "p3", questionIds: ["q4"] }])), /Q4 has no answers to repeat for/);
  assert.match(msg(checks({ source: { kind: "question", questionId: "q3", filter: "selected" } })), /Q3 is inside this loop/);
  assert.match(msg(checks({ source: { kind: "question", questionId: "q9", filter: "selected" } }, [{ id: "q9", code: "Q9", variableName: "Q9", type: "multi_select", text: "Later", options: BRANDS }], [{ type: "page", id: "p9", questionIds: ["q9"] }])), /Q9 is asked after this loop/);
  assert.match(msg(checks({ source: { kind: "question", questionId: "q1", filter: "selected" } })), /tip:Q1 takes one answer, so this loop runs once/);
  assert.match(msg(checks({ source: { kind: "static", items: [] } })), /The list is empty/);
  assert.match(msg(checks({ source: { kind: "static", items: [{ code: "1", label: "A" }, { code: "1", label: "B" }, { code: "", label: "" }] } })), /no code[\s\S]*share a code[\s\S]*has no name/);
  assert.match(msg(checks({ source: { kind: "listFill", listFillId: "nope" } })), /has not been set up/);
  assert.match(msg(checks({ order: { kind: "priority" } })), /item detail that is not chosen/);
  assert.match(msg(checks({ count: { mode: "min", value: 9 } })), /needs at least 9 items but its list only has 3, so it can never run/);
  assert.match(msg(checks({ aggregates: [{ name: "A", questionRef: "", op: "avg" }, { name: "B", questionRef: "Q1", op: "avg" }] })), /“A” has no question chosen[\s\S]*“B” reads Q1, which is not inside this loop/);
  assert.match(msg(checks({ loopVar: "2 brands" })), /needs a short name/);
  assert.match(msg(checks({ references: { columns: [{ name: "Nick", required: true }], values: { "1": { Nick: "N" } } } })), /“Nick” is required but empty for 2 items \(Adidas, Puma\)/);
});

test("which extras are in use, and the loop to start from", () => {
  const d = make({ skipIf: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 }, resolveSource: "once", references: { columns: [{ name: "Nick" }], values: {} } });
  assert.deepEqual(loopExtras(loopOf(d)), { rules: 1, details: 1, totals: 0, fixedList: true, total: 3 });
  assert.equal(loopExtras(loopOf(make({}))).total, 0);
  assert.deepEqual(suggestLoopSource(make({})), { kind: "question", questionId: "q2", filter: "selected" }, "the nearest earlier multiple-choice question");
  assert.deepEqual(suggestLoopSource(make({}), "q2"), { kind: "static", items: [{ code: "1", label: "" }, { code: "2", label: "" }] }, "none before this point: a list to type");
  assert.equal(loopSourceWords(make({}), loopOf(make({}))), "each answer the respondent chose at Q2");
});

test("a loop just placed starts from the nearest earlier multi-select, and only an earlier one", () => {
  const q = (id: string, type: string) => ({ id, code: id, type, text: id, options: [{ code: "1", label: "A" }, { code: "2", label: "B" }], rows: [], columns: [] });
  const def = { meta: { id: "s", code: "S", title: "t", version: "1.0" }, questions: [q("Q1", "multi_select"), q("Q2", "single_select"), q("Q3", "multi_select")], flow: [] } as any;
  const flow = [
    { type: "page", id: "p1", questionIds: ["Q1", "Q2"] },
    { type: "loop", id: "L", source: { kind: "static", items: [] }, loopVar: "item", children: [] },
    { type: "page", id: "p2", questionIds: ["Q3"] },
  ];
  assert.deepEqual(suggestLoopSourceInFlow(def, flow, "L"), { kind: "question", questionId: "Q1", filter: "selected" });
  assert.equal(suggestLoopSourceInFlow(def, [flow[1], flow[0], flow[2]], "L"), null, "nothing is asked before it");
  assert.equal(suggestLoopSourceInFlow(def, flow, "missing"), null);
});
