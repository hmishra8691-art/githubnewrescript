import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SurveyDefinition } from "@rescript/schema";
import { applyScriptWrite, createResponseState, logicScriptScope, logicStatics, LOGIC_SHIM, type ScriptWrite } from "@rescript/engine";
import { runLogicEvent, runCustomScriptRules, logicAsk, onChangeScheduler, type LogicRunner } from "./logicScripts.ts";
import { runScriptLifecycle } from "./scriptLifecycle.ts";

/*
 * S1b item 2: the Runner's orchestration of logic scripts — gate before send, the frame's answer applied in order
 * through the engine with the script's declared scope, timeouts, error() through the S1a lifecycle helper,
 * custom_script rules, on_change debounce + flush.
 */

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age",
      validation: [{ kind: "custom_script", value: "chk", message: "Could not check" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Pick", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
    { id: "h1", code: "H1", variableName: "H1", type: "hidden", text: "H" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["h1"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [
    { id: "s1", name: "first", scope: "page", ref: "p1", event: "on_submit", code: "set('H1', 'x'); setCalc('C', get('H1') + '!'); set('Q2', 1); log('ran', getCalc('C'));" },
    { id: "s2", name: "second", scope: "page", ref: "p1", event: "on_submit", code: "if (getCalc('C') === 'x!') error('stop here', 'AGE'); error('page level');" },
    { id: "bad", name: "bad", scope: "page", ref: "p1", event: "on_submit", code: "fetch('https://x')" },
    { id: "chk", name: "chk", scope: "question", ref: "q1", event: "on_validate", code: "if (value > 120) error('Too old: ' + value); if (value === 99) throw new Error('x');" },
  ],
});

/** the frame, in a vm context: exactly the shim the frame runs */
function vmRunner(): LogicRunner & { calls: number } {
  const ctx = vm.createContext({});
  vm.runInContext(`${LOGIC_SHIM}; globalThis.__rsLogic = __rsLogic;`, ctx);
  const api = (ctx as any).__rsLogic;
  api.statics(JSON.parse(JSON.stringify(logicStatics(def))));
  const compile = vm.runInContext(`(function (p, b) { return Function.apply(null, p.concat([b])); })`, ctx);
  const r = { calls: 0, async run(req: unknown) { r.calls++; return JSON.parse(JSON.stringify(api.run(JSON.parse(JSON.stringify(req)), compile))); } };
  return r;
}

const apply = (state: ReturnType<typeof createResponseState>, shown: string[], seen: ScriptWrite[] = []) =>
  (w: ScriptWrite, s: { id: string; scope: "survey" | "page" | "question"; ref?: string }) => { seen.push(w); return applyScriptWrite(def, state, w, { scriptId: s.id, scope: logicScriptScope(s), shown }); };

test("an event: gate-refused scripts are never sent; writes applied in order with the declared scope; refusals logged", async () => {
  const state = createResponseState(def, { seed: 1 });
  const seen: ScriptWrite[] = [];
  const o = await runLogicEvent(def, state, "on_submit", { scopeRef: ["p1", "q1", "q2"], runner: vmRunner(), apply: apply(state, ["q1", "q2"], seen) });
  assert.deepEqual(o.refusedScripts, ["bad"]);
  assert.ok(o.logs.some((l) => l.startsWith("[bad] refused: ")));
  assert.equal(o.ran, 2);
  assert.deepEqual(seen.map((w) => w.kind), ["answer", "calculated", "answer"], "in call order");
  assert.equal(state.answers.h1, "x", "hidden target written from a page script");
  assert.equal(state.calculated.C, "x!", "the overlay let the script read its own write");
  assert.equal(state.answers.q2, undefined, "Q2 is on screen and not the script's question: refused");
  assert.ok(o.logs.some((l) => /^\[first\] set\("Q2"\) refused: Q2 is on screen/.test(l)));
  assert.deepEqual(o.logs.filter((l) => l.startsWith("[first] ran")), ["[first] ran x!"]);
  assert.equal(o.written, 2);
  assert.equal(o.refusedWrites, 1);
  assert.deepEqual(o.errors, [{ message: "stop here", questionRef: "AGE" }, { message: "page level" }]);
});

test("a frame that does not answer: nothing is written, the run is logged as timed out", async () => {
  const state = createResponseState(def, { seed: 1 });
  const o = await runLogicEvent(def, state, "on_submit", { scopeRef: ["p1"], runner: { run: async () => null }, apply: apply(state, []), timeoutMs: 10 });
  assert.equal(o.timedOut, true);
  assert.equal(state.answers.h1, undefined);
  assert.ok(o.logs.some((l) => /no answer within 10 ms — not run, nothing written/.test(l)));
  const none = await runLogicEvent(def, state, "on_load", { runner: null, apply: apply(state, []) });
  assert.equal(none.ran, 0, "no scripts for the event: the frame is not even asked");
});

test("error() goes through the S1a lifecycle helper: mapped to the page's question by variable, else the banner", async () => {
  const state = createResponseState(def, { seed: 1 });
  const lines: string[] = [];
  const ask = logicAsk("logic on_submit", (t) => runLogicEvent(def, state, "on_submit", { scopeRef: ["p1"], runner: vmRunner(), apply: apply(state, ["q1", "q2"]), timeoutMs: t }), (o) => lines.push(...o.logs));
  const life = await runScriptLifecycle(ask, "validate", { questions: def.questions.slice(0, 2) });
  assert.deepEqual(life.errors, [{ questionId: "q1", message: "stop here" }, { questionId: "", message: "page level" }]);
  assert.ok(lines.length > 0);
  const slow = logicAsk("x", async () => ({ logs: [], errors: [], ran: 0, refusedScripts: [], written: 0, refusedWrites: 0, timedOut: true }));
  const l2 = await runScriptLifecycle(slow, "validate", { questions: [] });
  assert.equal(l2.timedOut, 1);
  assert.deepEqual(l2.errors, []);
});

test("custom_script rules run in the frame with the value under test; a failing script uses the rule's message", async () => {
  const state = createResponseState(def, { seed: 1 });
  const run = (value: unknown) => runCustomScriptRules(def, state, [{ questionId: "q1", script: "chk", value, failMessage: "Could not check" }], { runner: vmRunner(), apply: apply(state, []) });
  assert.deepEqual((await run(130)).errors, [{ questionId: "q1", message: "Too old: 130" }]);
  assert.deepEqual((await run(30)).errors, []);
  assert.deepEqual((await run(99)).errors, [{ questionId: "q1", message: "Could not check" }]);
  const timedOut = await runCustomScriptRules(def, state, [{ questionId: "q1", script: "chk", value: 130 }], { runner: { run: async () => null }, apply: apply(state, []) });
  assert.deepEqual(timedOut.errors, [], "a rule whose script did not answer does not hold the respondent");
});

test("on_change: debounced per question; flush runs what is pending and waits for it", async () => {
  const ran: string[] = [];
  const sch = onChangeScheduler(async (id) => { await new Promise((r) => setTimeout(r, 5)); ran.push(id); }, 30);
  sch.schedule("q1"); sch.schedule("q1"); sch.schedule("q2"); sch.schedule("q1");
  assert.equal(sch.pending(), 2);
  await sch.flush();
  assert.deepEqual(ran.sort(), ["q1", "q2"], "one run per question, not one per keystroke");
  sch.schedule("q2");
  await new Promise((r) => setTimeout(r, 60));
  await sch.flush();
  assert.deepEqual(ran.sort(), ["q1", "q2", "q2"]);
  sch.schedule("q3"); sch.cancel();
  await sch.flush();
  assert.ok(!ran.includes("q3"));
});
