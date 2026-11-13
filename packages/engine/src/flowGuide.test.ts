import test from "node:test";
import assert from "node:assert/strict";
import { flowNodePlainSummary, flowNodeChecks } from "./index.js";

const def = { meta: { id: "s", code: "S", title: "t", version: "1.0" }, questions: [], flow: [], quotas: [{ id: "qt1", name: "Men 18–34" }, { id: "qt2", name: "Women" }] } as any;
const page = (id: string) => ({ type: "page", id, questionIds: [] });
const rule = { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: "1" };
const levels = (n: any) => flowNodeChecks(def, n).map((c) => c.level);

test("a randomizer says how many parts each respondent sees and in what kind of order", () => {
  const r = (x: object) => ({ type: "randomizer", id: "r", children: [page("a"), page("b"), page("c")], ...x }) as any;
  assert.equal(flowNodePlainSummary(def, r({})), "Each respondent sees all 3 parts inside, in a different order each time.");
  assert.match(flowNodePlainSummary(def, r({ show: 2 }))!, /sees 2 of the 3 parts inside, picked at random/);
  assert.match(flowNodePlainSummary(def, r({ order: "williams" }))!, /balanced order/);
  assert.match(flowNodePlainSummary(def, r({ evenPresentation: true }))!, /equally often/);
  assert.match(flowNodePlainSummary(def, r({ visibleIf: rule }))!, /only runs when its condition is met/);
  assert.deepEqual(levels(r({})), []);
  assert.deepEqual(levels(r({ children: [page("a")] })), ["problem"]);
  assert.deepEqual(levels(r({ show: 5 })), ["warning"]);
});

test("a quota check names its quotas and what happens when they are full; missing pieces are problems", () => {
  const q = (x: object) => ({ type: "quota_check", id: "q", quotaIds: ["qt1"], onFull: { kind: "terminate" }, ...x }) as any;
  assert.equal(flowNodePlainSummary(def, q({})), "When “Men 18–34” is full, the survey ends for them, counted as quota full.");
  assert.match(flowNodePlainSummary(def, q({ quotaIds: ["qt1", "qt2"], onFull: { kind: "flag" } }))!, /“Men 18–34” and “Women” are full, they continue, marked as over quota/);
  assert.deepEqual(levels(q({})), []);
  assert.deepEqual(levels(q({ quotaIds: [] })), ["problem"]);
  assert.deepEqual(levels(q({ quotaIds: ["gone"] })), ["problem"]);
  assert.deepEqual(levels(q({ onFull: { kind: "redirect", url: "" } })), ["problem"]);
  assert.deepEqual(levels(q({ onFull: { kind: "redirect", url: "https://panel.example/full" } })), []);
  assert.match(flowNodeChecks({ ...def, quotas: [] }, q({}))[0]!.message, /no quotas yet/);
});

test("an end point, a redirect and saved values each read as a sentence", () => {
  assert.equal(flowNodePlainSummary(def, { type: "end", id: "e", status: "screened" } as any), "The survey ends here as screened out (not eligible).");
  assert.match(flowNodePlainSummary(def, { type: "end", id: "e", status: "complete", message: "Thanks", redirectUrl: "https://panel.example/done?id=1" } as any)!, /showing your message, then the respondent is sent to panel\.example/);
  assert.deepEqual(levels({ type: "end", id: "e", status: "complete", redirectUrl: "panel.example" }), ["problem"]);
  assert.equal(flowNodePlainSummary(def, { type: "redirect", id: "r", url: "https://" } as any), "No link is set yet.");
  assert.deepEqual(levels({ type: "redirect", id: "r", url: "https://" }), ["problem"]);
  assert.deepEqual(levels({ type: "redirect", id: "r", url: "https://a.example/x" }), ["tip"]);
  const ed = { type: "embedded_data", id: "d", fields: [{ name: "pid", source: "url" }, { name: "", source: "static" }, { name: "PID", source: "panel" }] } as any;
  assert.match(flowNodePlainSummary(def, ed)!, /Saves 2 hidden values with each response: pid \(from the survey link\) and PID \(from the panel\)/);
  assert.deepEqual(levels(ed), ["problem", "warning"]);
});

test("a branch warns about a path with no condition, and never changes the node it reads", () => {
  const b = { type: "branch", id: "b", branches: [{ id: "1", label: "Owners", when: { type: "group", op: "and", children: [] }, children: [] }, { id: "2", when: rule, children: [] }], otherwise: [] } as any;
  const before = JSON.stringify(b);
  assert.match(flowNodePlainSummary(def, b)!, /one of 2 paths/);
  const c = flowNodeChecks(def, b);
  assert.equal(c[0]!.level, "warning"); assert.match(c[0]!.message, /“Owners” has no condition yet.*never reached/);
  assert.equal(c[1]!.level, "tip");
  assert.equal(JSON.stringify(b), before);
  assert.equal(flowNodePlainSummary(def, { type: "page", id: "p", questionIds: [] } as any), null);
});
