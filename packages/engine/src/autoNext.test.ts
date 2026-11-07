import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { autoNextKind, autoNextOn, autoNextReady } from "./index.js";

const o = (n: number) => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `O${i + 1}` }));
const def = (autoAdvance: boolean | undefined, qs: Record<string, unknown>[]) => SurveyDefinition.parse({
  meta: { id: "an", code: "AN", title: "a", version: "1" }, branding: { layout: { ...(autoAdvance === undefined ? {} : { autoAdvance }) } },
  questions: qs, flow: [{ type: "page", id: "p", questionIds: qs.map((q) => q.id as string) }],
});
const single = { id: "s", code: "S", variableName: "S", type: "single_select", text: "s", options: [...o(2), { code: 9, label: "Other", flags: ["other_specify"] }] };
const single2 = { id: "t", code: "T", variableName: "T", type: "single_select", text: "t", options: o(2) };
const multi = { id: "m", code: "M", variableName: "M", type: "multi_select", text: "m", options: o(3) };
const grid = { id: "g", code: "G", variableName: "G", type: "matrix_single", text: "g", options: o(3), rows: [{ code: "r1", label: "R1" }, { code: "r2", label: "R2" }] };
const text = { id: "x", code: "X", variableName: "X", type: "open_text", text: "x" };

test("auto-next: which questions can move the page on", () => {
  const d = def(true, [single, multi, grid, text, { id: "n", code: "N", variableName: "N", type: "numeric", text: "n" }]);
  assert.deepEqual(d.questions.map((q) => autoNextKind(q)), ["single", null, "grid", null, null]);
});

test("auto-next: a single choice advances when answered; Other waits for its box; off by default", () => {
  const d = def(true, [single]); const q = d.questions;
  assert.equal(autoNextReady(d, q, () => 1), true);
  assert.equal(autoNextReady(d, q, () => undefined), false);
  assert.equal(autoNextReady(d, q, () => 9), false);
  const off = def(undefined, [single]);
  assert.equal(autoNextReady(off, off.questions, () => 1), false);
});

test("auto-next: a multi-select on the page means the page waits; two singles advance after both", () => {
  const d = def(true, [single2, multi]);
  assert.equal(autoNextReady(d, d.questions, (q) => (q.id === "t" ? 1 : [1, 2])), false);
  const two = def(true, [single2, { ...single2, id: "t2", code: "T2", variableName: "T2" }]);
  assert.equal(autoNextReady(two, two.questions, (q) => (q.id === "t" ? 1 : undefined)), false);
  assert.equal(autoNextReady(two, two.questions, () => 2), true);
});

test("auto-next: a single-choice grid advances once every row is answered", () => {
  const d = def(true, [grid]);
  assert.equal(autoNextReady(d, d.questions, () => ({ r1: 1 })), false);
  assert.equal(autoNextReady(d, d.questions, () => ({ r1: 1, r2: 3 })), true);
});

test("auto-next: a question's own setting overrides the survey's", () => {
  const on = def(false, [{ ...single2, settings: { autoNext: true } }]);
  assert.equal(autoNextOn(on, on.questions[0]), true);
  assert.equal(autoNextReady(on, on.questions, () => 1), true);
  const offQ = def(true, [{ ...single2, settings: { autoNext: false } }]);
  assert.equal(autoNextReady(offQ, offQ.questions, () => 1), false);
  const page = def(true, [single2, text]);
  assert.equal(autoNextReady(page, page.questions, () => 1), false, "an open end on the page waits for Next");
});
