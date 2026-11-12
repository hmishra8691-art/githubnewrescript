/** 2026-11-13 — automatic sequential question codes per block (autoCode.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applyAutoCodes, applyBlockAutoCodes, blockAutoCodePlan, nextAutoCode } from "./autoCode.js";
import { createResponseState } from "./state.js";
import { start, advance, setAnswer } from "./flow.js";

const YN = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }];
const q = (id: string, code: string, extra: Record<string, unknown> = {}) => ({ id, code, variableName: code, type: "single_select", text: code, options: YN, required: true, ...extra });
const sel = (ref: string, value: number) => ({ type: "rule", source: { kind: "question", ref }, operator: "selected", value });
const make = (questions: unknown[], blocks: { id: string; ids: string[]; auto?: boolean }[], more: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Auto codes", version: "1.0" }, questions,
  flow: blocks.map((b) => ({ id: b.id, type: "page", title: b.id, questionIds: b.ids, ...(b.auto === false ? {} : { autoCode: true }) })), ...more,
});
const codes = (def: SurveyDefinition, ids: string[]) => ids.map((id) => def.questions.find((x) => x.id === id)!.code);

test("deleting, inserting and moving keep each block in sequence; blocks number separately", () => {
  /* Q2 was deleted, a new question sits between S1 and S2, S3 was moved to the top */
  const def = make([
    q("a", "Q1"), q("c", "Q3"), q("d", "Q4"), q("e", "Q5"),
    q("s3", "S3"), q("s1", "S1"), q("new", "S4"), q("s2", "S2"), q("odd", "S1x"),
  ], [{ id: "bQ", ids: ["a", "c", "d", "e"] }, { id: "bS", ids: ["s3", "s1", "new", "s2", "odd"] }]);
  const r = applyAutoCodes(def);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(codes(r.def, ["a", "c", "d", "e"]), ["Q1", "Q2", "Q3", "Q4"], "no gap after a deletion");
  assert.deepEqual(codes(r.def, ["s3", "s1", "new", "s2", "odd"]), ["S1", "S2", "S3", "S4", "S1x"], "the codes follow the order; a code written another way (S1x) is left alone and takes no number");
  assert.deepEqual(applyAutoCodes(r.def).changes, [], "a block already in sequence is not touched");
});

test("a swap never collides, and every reference follows the question — logic, skip, piping, calculation; the survey still runs", () => {
  /* x (S2) was dragged above y (S1) */
  const real = make([
    q("x", "S2"), q("y", "S1"),
    q("z", "S3", { text: "You said {{S1}} and {{S2}}", displayLogic: sel("y", 1), skipLogic: [{ id: "sk", when: sel("x", 2), target: { kind: "terminate", status: "screened" } }] }),
  ], [{ id: "b", ids: ["x", "y", "z"] }], {
    calculations: [{ id: "c1", targetVariable: "SCORE", label: "Score", expression: "S1 + S2 * 2", trigger: "on_page_submit", dataType: "numeric" }],
  });
  assert.equal(blockAutoCodePlan(real, "b")!.prefix, "S");
  const r = applyBlockAutoCodes(real, "b");
  assert.deepEqual(r.problems, []);
  const [x, y, z] = ["x", "y", "z"].map((id) => r.def.questions.find((k) => k.id === id)!);
  assert.deepEqual([x.code, y.code, z.code], ["S1", "S2", "S3"]);
  assert.deepEqual([x.variableName, y.variableName, z.variableName], ["S1", "S2", "S3"], "a variable that was the code follows it");
  assert.equal(z.text, "You said {{S2}} and {{S1}}", "piping names the same questions as before (y, then x)");
  assert.equal(r.def.calculations[0].expression, "S2 + S1 * 2", "the calculation reads the same questions as before");
  assert.equal((z.displayLogic as { source: { ref: string } }).source.ref, "y", "rules read questions by id — untouched");
  assert.doesNotThrow(() => SurveyDefinition.parse(r.def));
  const st = createResponseState(r.def, { seed: 1 });
  start(r.def, st, {});
  setAnswer(r.def, st, "x", 1 as never); setAnswer(r.def, st, "y", 1 as never); setAnswer(r.def, st, "z", 1 as never);
  assert.equal(advance(r.def, st, {}).done, true);
});

test("retyping the first code with a new prefix renames the run; other codes in the block are the programmer's", () => {
  const def = make([q("a", "Q1"), q("b", "S2"), q("c", "S3"), q("h", "H1", { settings: { hidden: true } }), q("d", "S4"), q("age", "AGE")], [{ id: "b", ids: ["a", "b", "c", "h", "d", "age"] }]);
  const without = applyBlockAutoCodes(def, "b");
  assert.deepEqual(codes(without.def, ["a", "b", "c", "h", "d", "age"]), ["Q1", "S2", "S3", "H1", "S4", "AGE"], "nothing is inferred: only the first question uses Q");
  const r = applyBlockAutoCodes(def, "b", { adoptPrefix: "S" });
  assert.deepEqual(codes(r.def, ["a", "b", "c", "h", "d", "age"]), ["Q1", "Q2", "Q3", "H1", "Q4", "AGE"]);
});

test("one run per prefix across blocks; a number used by a manual block is passed over; manual blocks are never renumbered", () => {
  const def = make([q("a", "Q1"), q("b", "Q7"), q("c", "Q9"), q("o", "Q2"), q("d", "Q1b"), q("e", "Q20"), q("f", "Q21"), q("m1", "M5"), q("m2", "M2")],
    [{ id: "b1", ids: ["a", "b", "c"] }, { id: "other", ids: ["o"], auto: false }, { id: "b2", ids: ["e", "f"] }, { id: "manual", ids: ["m1", "m2", "d"], auto: false }]);
  const r = applyAutoCodes(def);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(codes(r.def, ["a", "b", "c"]), ["Q1", "Q3", "Q4"], "Q2 belongs to a manual block");
  assert.deepEqual(codes(r.def, ["e", "f"]), ["Q5", "Q6"], "the second Q block continues the run");
  assert.deepEqual(codes(r.def, ["o", "m1", "m2", "d"]), ["Q2", "M5", "M2", "Q1b"], "blocks without automatic coding keep their codes");
  assert.equal(nextAutoCode(r.def, "b1"), "Q7", "the next free number after the block's last (Q5, Q6 are the next block's until it is renumbered)");
  assert.equal(nextAutoCode(make([q("t", "INTRO")], [{ id: "x", ids: ["t"] }]), "x"), null, "no pattern yet: the programmer types the first code");
});

test("after an edit: renumbers when an automatic block's questions changed, not while a code is being typed", async () => {
  const { autoCodeAfterEdit } = await import("./autoCode.js");
  const prev = make([q("a", "Q1"), q("b", "Q2"), q("c", "Q3")], [{ id: "b1", ids: ["a", "b", "c"] }]);
  const typing = structuredClone(prev); typing.questions[1].code = "Q";
  assert.equal(autoCodeAfterEdit(prev, typing).def, typing, "a half-typed code changes no order: nothing is renumbered under the cursor");
  const deleted = make([q("a", "Q1"), q("c", "Q3")], [{ id: "b1", ids: ["a", "c"] }]);
  assert.deepEqual(codes(autoCodeAfterEdit(prev, deleted).def, ["a", "c"]), ["Q1", "Q2"]);
  const manual = make([q("a", "Q1"), q("c", "Q3")], [{ id: "b1", ids: ["a", "c"], auto: false }]);
  assert.equal(autoCodeAfterEdit(prev, manual).def, manual);
  const switchedOn = make([q("a", "Q4"), q("c", "Q9")], [{ id: "b1", ids: ["a", "c"] }]);
  assert.deepEqual(codes(autoCodeAfterEdit(manual, switchedOn).def, ["a", "c"]), ["Q1", "Q2"], "switching a block to automatic numbers it at once");
});
