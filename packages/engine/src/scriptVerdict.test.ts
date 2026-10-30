import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { itemVerdict, expectHolds, verificationSummary, executionReportText, VERDICT_NEEDS_REPAIR, coerceExpect, type ItemRecord, type ScenarioRecord } from "./scriptVerify.js";
import { responseSavePayload, savedWriteProblems } from "./savePayload.js";
import { createResponseState } from "./state.js";
import { applyScriptWrite } from "./scriptWrites.js";

/* S2c item 3 — verdicts, expectations and the save-payload check */

const sc = (id: string, label: string, x: Partial<ScenarioRecord> = {}): ScenarioRecord => ({ id, label, errors: [], effects: [], writes: [], logs: [], ...x });
const rec = (scenarios: ScenarioRecord[], x: Partial<ItemRecord> = {}): ItemRecord => ({ key: "behaviour:b1", kind: "behaviour", label: "Q5 highlight", ran: true, hostRefusals: [], watchdog: [], timedOut: false, scenarios, durationMs: 900, ...x });

test("ran-ok names the effect and the scenario; ran-no-effect when nothing observable happened", () => {
  const ok = itemVerdict(rec([sc("enter", "enter the page"), sc("select-Q1-2", "select “Brand B” in Q1", { effects: [{ kind: "add_class", target: "Q5", detail: "rs-highlight" }] }), sc("clear-Q1", "select then clear Q1")]));
  assert.equal(ok.verdict, "ran-ok");
  assert.equal(ok.summary, "Ran in a test session: 3 scenarios, added class rs-highlight to Q5 on “Brand B”, no errors");
  const none = itemVerdict(rec([sc("enter", "enter the page"), sc("select-Q1-1", "select “Brand A” in Q1")]));
  assert.equal(none.verdict, "ran-no-effect");
  assert.match(none.summary, /did nothing visible/);
  assert.ok(VERDICT_NEEDS_REPAIR(none));
  assert.equal(itemVerdict(rec([sc("enter", "enter the page")]), { effect: "none" }).verdict, "ran-ok", "no effect, as the action said");
});

test("ran-error carries the scenario, the message and the line; blocked; timeout; not-run", () => {
  const err = itemVerdict(rec([sc("enter", "enter the page"), sc("select-Q1-1", "select “Brand A” in Q1", { errors: [{ message: "Cannot read properties of null (reading 'boom')", line: 3 }] })]));
  assert.equal(err.verdict, "ran-error");
  assert.equal(err.summary, "Ran in a test session: error on “select “Brand A” in Q1”: Cannot read properties of null (reading 'boom') (line 3)");
  const refusedWrite = itemVerdict(rec([sc("select-Q1-1", "select “Brand A” in Q1", { writes: [{ call: `setAnswer("Q5")`, ok: false, reason: "Q5 is on screen" }] })]));
  assert.equal(refusedWrite.verdict, "blocked");
  assert.match(refusedWrite.detail[0]!, /setAnswer\("Q5"\) refused: Q5 is on screen \(on “select “Brand A” in Q1”\)/);
  assert.equal(itemVerdict(rec([], { gateRefusal: "the selector matches nothing", ran: false })).verdict, "blocked");
  assert.equal(itemVerdict(rec([sc("enter", "enter the page")], { watchdog: ["stopped: more than 200 commands a second"] })).verdict, "timeout");
  assert.equal(itemVerdict(rec([sc("enter", "enter the page")], { timedOut: true })).verdict, "timeout");
  const nr = itemVerdict(rec([], { ran: false, notRun: "no page of the survey shows it" }));
  assert.equal(nr.verdict, "not-run");
  assert.ok(!VERDICT_NEEDS_REPAIR(nr), "a harness limit is not the script's fault: no repair");
});

test("expect hints: the class on the named question in the named scenario; write; message; a miss says what was seen", () => {
  const r = rec([sc("enter", "enter the page"), sc("select-Q1-2", "select “Brand B” in Q1", { effects: [{ kind: "add_class", target: "Q5", detail: "rs-highlight" }] }), sc("select-Q1-1", "select “Brand A” in Q1", { effects: [{ kind: "write", target: "H_SEG", detail: "1" }] })]);
  assert.equal(expectHolds(r, { on: "select Q1=2", effect: "class rs-highlight on Q5" }).met, true);
  assert.equal(expectHolds(r, { on: "select Q1=1", effect: "class rs-highlight on Q5" }).met, false);
  assert.equal(expectHolds(r, { effect: "write H_SEG" }).met, true);
  assert.equal(expectHolds(r, { effect: "message" }).met, false);
  const miss = itemVerdict(r, { on: "select Q1=2", effect: "class rs-highlight on Q4" });
  assert.equal(miss.verdict, "ran-no-effect");
  assert.equal(miss.expectMet, false);
  assert.match(miss.summary, /expected “class rs-highlight on Q4” on “select Q1=2” — saw added class rs-highlight to Q5/);
  assert.equal(itemVerdict(r, { on: "select Q1=2", effect: "class rs-highlight on Q5" }).expectMet, true);
  assert.deepEqual(coerceExpect("message"), { effect: "message" });
  assert.deepEqual(coerceExpect({ on: "select Q1=2", effect: "write Q9", junk: 1 }), { on: "select Q1=2", effect: "write Q9" });
  assert.equal(coerceExpect(42), undefined);
});

test("the summary and the repair report", () => {
  const verdicts = [itemVerdict(rec([sc("enter", "enter the page")])), itemVerdict(rec([sc("enter", "enter the page", { effects: [{ kind: "message", target: "Q3" }] })], { key: "behaviour:b2", label: "msg" }))];
  assert.deepEqual(verificationSummary({ verdicts }), { ok: false, text: "1 of 2 scripts did not pass the test session" });
  const text = executionReportText({ verdicts, items: [rec([sc("enter", "enter the page", { logs: ["hello"] })]), rec([], { key: "behaviour:b2" })] });
  assert.match(text, /Q5 highlight \[ran-no-effect\]/);
  assert.match(text, /log: hello/);
  assert.match(text, /scenarios: enter the page → no effect/);
});

test("the save payload: an accepted write is in the state AND in what the Runner posts (labelled script-written)", () => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Brand?", options: ["A", "B"] },
    { op: "create_question", type: "hidden", text: "Segment", variableName: "H_SEG", options: ["Low", "High"] },
    { op: "create_embedded", name: "SRC", source: "url" },
  ] as SurveyAction[]);
  assert.ok(r.results.every((x) => x.ok), r.results.map((x) => x.error).join("; "));
  const def = r.def;
  const seg = def.questions.find((q) => q.type === "hidden")!;
  const state = createResponseState(def, { seed: 1, sessionId: "t" });
  const w = applyScriptWrite(def, state, { kind: "answer", ref: String(seg.code), value: 2 }, { scriptId: "s1", scope: { kind: "survey" }, shown: [], loop: null, quotaCounts: {} });
  assert.ok(w.ok, w.reason);
  const e = applyScriptWrite(def, state, { kind: "embedded", name: "SRC", value: "panel" }, { scriptId: "s1", scope: { kind: "survey" }, shown: [], loop: null, quotaCounts: {} });
  assert.ok(e.ok, e.reason);
  const writes = [{ kind: "answer" as const, target: w.target ?? seg.id, value: state.answers[w.target ?? seg.id] }, { kind: "embedded" as const, target: "SRC", value: "panel" }];
  assert.deepEqual(savedWriteProblems(state, writes), []);
  const p = responseSavePayload(state);
  assert.deepEqual(Object.keys(p), ["status", "stepIndex", "answers", "calculated", "embedded", "flags", "scriptWrites"]);
  // a value the state does not hold, and one no script wrote
  assert.match(savedWriteProblems(state, [{ kind: "answer", target: w.target ?? seg.id, value: 1 }])[0]!, /the state holds 2, the harness saw 1/);
  state.answers["other"] = 5;
  assert.match(savedWriteProblems(state, [{ kind: "answer", target: "other", value: 5 }])[0]!, /not labelled as script-written/);
  assert.match(savedWriteProblems(state, [{ kind: "calculated", target: "NOPE", value: 1 }])[0]!, /accepted but not in the response state/);
});
