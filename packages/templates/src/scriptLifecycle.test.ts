import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkScripts, scriptWrites } from "./scriptLifecycle.js";
import type { TestCase } from "./testCases.js";

const DEF = SurveyDefinition.parse({
  meta: { id: "sl", code: "SL", title: "Scripts", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "How many cars?", required: true, settings: { minValue: 0, maxValue: 5 } },
    { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", text: "How many bikes?", required: true, settings: { minValue: 0, maxValue: 5 } },
  ],
  /* declared so it is exported; its own expression never runs (the guard is never true) — the script computes it */
  calculations: [{ id: "c1", targetVariable: "TOTAL", label: "Vehicles", expression: "0", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "gt", value: 100 } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [
    { id: "s_total", name: "Total", scope: "page", ref: "p2", event: "on_submit", code: "setCalc('TOTAL', (get('Q1') || 0) + (get('Q2') || 0));", origin: "ai" },
    { id: "s_never", name: "Never", scope: "survey", event: "on_submit", code: "setCalc('TOTAL', 99);", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "gt", value: 50 }, origin: "ai" },
    { id: "s_throw", name: "Throws", scope: "page", ref: "p1", event: "on_submit", code: "const x = null; x.y = 1;", origin: "person" },
    { id: "s_bad", name: "Bad", scope: "survey", event: "on_load", code: "window.location = 'x'", origin: "import" },
    { id: "s_done", name: "At the end", scope: "survey", event: "on_complete", code: "flag('done');" },
    { id: "s_off", name: "Off", scope: "survey", event: "on_load", code: "log(1)", enabled: false },
  ],
});
const CASE = (expect: number): TestCase => ({ id: "t1", name: "two cars, one bike", input: { answers: { q1: 2, q2: 1 } }, expectations: { variables: { TOTAL: expect } } });
const by = (r: ReturnType<typeof checkScripts>, id: string) => r.scripts.find((s) => s.id === id)!;

test("what a script writes, read from its code", () => {
  assert.deepEqual(scriptWrites("setCalc('TOTAL', 1); set(\"Q3\", 2); ctx.setEmbedded(`src`, 'x'); flag('done')"), ["TOTAL", "Q3", "src", "done"]);
});

test("generated, refused, not reached, failing, on_complete and switched off — without test cases", () => {
  const r = checkScripts(DEF, { count: 40 });
  assert.equal(r.simulated, 40);
  assert.equal(by(r, "s_total").stage, "executed");
  assert.equal(by(r, "s_total").executed.respondents, 40);
  assert.match(by(r, "s_total").summary, /not validated: no passing test case checks TOTAL/);
  assert.equal(by(r, "s_never").stage, "not_reached");
  assert.equal(by(r, "s_throw").stage, "failing");
  assert.equal(by(r, "s_bad").stage, "refused");
  assert.equal(by(r, "s_done").stage, "generated");
  assert.match(by(r, "s_done").summary, /simulation cannot execute them/);
  assert.equal(by(r, "s_off").stage, "generated");
  assert.match(by(r, "s_off").summary, /switched off/);
  assert.equal(by(r, "s_total").origin, "ai");
  assert.equal(by(r, "s_off").origin, "unknown");
});

test("validated only by a PASSING case that checks what the script writes", () => {
  const ok = checkScripts(DEF, { count: 10, cases: [CASE(3)] });
  assert.equal(by(ok, "s_total").stage, "validated");
  assert.deepEqual(by(ok, "s_total").validated.cases[0].covers, ["TOTAL"]);
  const wrong = checkScripts(DEF, { count: 10, cases: [CASE(4)] });
  assert.equal(by(wrong, "s_total").stage, "failing");
  assert.match(by(wrong, "s_total").summary, /two cars, one bike/);
  const unrelated = checkScripts(DEF, { count: 10, cases: [{ id: "t2", name: "ends", input: { answers: { q1: 1, q2: 1 } }, expectations: { endStatus: "complete" } }] });
  assert.equal(by(unrelated, "s_total").stage, "executed", "a case that never checks TOTAL does not validate the script that computes it");
});
