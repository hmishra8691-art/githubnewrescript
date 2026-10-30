import test from "node:test";
import assert from "node:assert/strict";
import { redactionSet, sanitizeScriptHealth } from "@rescript/engine";
import { createScriptHealthCollector, browserClass, sessionScriptHealth, scriptHealthPayload } from "./scriptHealth.ts";
import { runLogicEvent, type LogicRunner } from "./logicScripts.ts";
import { runScriptLifecycle } from "./scriptLifecycle.ts";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "@rescript/engine";

/* S1c item 1 (D11 / SE-30): the respondent session's script-health collector and what feeds it */

test("collector: one entry per script / kind / page, counted; first message kept, answer text removed; capped", () => {
  const answers = { q_name: "Jane Smith", q_city: "Lisbon" };
  const c = createScriptHealthCollector({ browser: browserClass({ browser: "Chrome", type: "desktop" }), redact: () => redactionSet(answers), cap: 3 });
  c.setPage("p1@brand=a");
  c.note({ script: "uxb_1", name: "Spend band", kind: "ux_error", message: "cannot read Jane Smith of undefined" });
  c.note({ script: "uxb_1", name: "Spend band", kind: "ux_error", message: "second message is not kept" });
  c.note({ script: "uxb_1", kind: "write_refused", message: "rs.setAnswer(\"Q2\") refused: Q2 is on screen" });
  c.setPage("p2");
  c.note({ script: "uxb_1", kind: "ux_error", message: "from Lisbon" });
  c.note({ script: "uxb_9", kind: "watchdog", message: "over the cap" });
  c.note({ script: "", kind: "ux_error", message: "no id: ignored" });
  const l = c.list();
  assert.equal(l.length, 3);
  assert.deepEqual(l[0], { script: "uxb_1", name: "Spend band", kind: "ux_error", page: "p1", message: "cannot read … of undefined", count: 2, browser: "Chrome desktop" });
  assert.equal(l[1]!.kind, "write_refused");
  assert.equal(l[2]!.page, "p2");
  assert.equal(l[2]!.message, "from …");
  assert.equal(c.dropped, 1);
  // what the collector sends passes the route's sanitiser unchanged
  assert.deepEqual(sanitizeScriptHealth(l), l);
});

test("collector: restored after a reload, and every change reported for sessionStorage", () => {
  let saved: unknown[] = [];
  const c = createScriptHealthCollector({ initial: [{ script: "s1", kind: "logic_error", message: "x", count: 4 }], onChange: (l) => { saved = l; } });
  c.note({ script: "s1", kind: "logic_error", message: "x" });
  assert.equal(c.list()[0]!.count, 5);
  assert.equal(saved.length, 1);
  assert.equal(browserClass(undefined), undefined);
  assert.equal(browserClass({ browser: "Safari", type: "unknown" }), "Safari");
  const a = sessionScriptHealth("sess-a", () => createScriptHealthCollector());
  assert.equal(sessionScriptHealth("sess-a", () => { throw new Error("made twice"); }), a);
  assert.equal(scriptHealthPayload("sess-a"), undefined, "nothing to send while empty");
  a.note({ script: "b", kind: "ux_error", message: "m" });
  assert.equal(scriptHealthPayload("sess-a")!.length, 1);
});

test("logic runs report gate refusals, errors, timeouts and refused writes as structured issues", async () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "N" }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
    scripts: [
      { id: "ok", name: "writer", scope: "survey", event: "on_submit", code: "set('NOPE', 1)" },
      { id: "thrower", name: "thrower", scope: "survey", event: "on_submit", code: "throw new Error('x')" },
      { id: "bad", name: "bad", scope: "survey", event: "on_submit", code: "window.location = 'x'" },
    ],
  });
  const state = createResponseState(def, { seed: 1 });
  const runner: LogicRunner = { run: async ({ scripts }) => scripts.map((s) => s.id === "ok"
    ? { name: s.name, writes: [{ kind: "answer", ref: "NOPE", value: 1 }], logs: [], errors: [] }
    : { name: s.name, writes: [], logs: [], errors: [], failed: "Error: x" }) };
  const o = await runLogicEvent(def, state, "on_submit", { runner, apply: () => ({ ok: false, reason: "no such question" }) });
  const kinds = o.issues.map((i) => `${i.script}:${i.kind}`).sort();
  assert.deepEqual(kinds, ["bad:gate_refused", "ok:write_refused", "thrower:logic_error"]);
  const late = await runLogicEvent(def, state, "on_submit", { runner: { run: async () => null }, apply: () => ({ ok: true }), timeoutMs: 10 });
  assert.deepEqual(late.issues.filter((i) => i.kind === "logic_timeout").map((i) => i.script).sort(), ["ok", "thrower"]);
  // a UX frame that does not answer its validate handler in time is named (id) for the collector; a logic run is not
  const life = await runScriptLifecycle(async () => [{ script: "Checker", id: "uxb_chk", timedOut: true }, { script: "logic on_submit", timedOut: true }], "validate", { questions: [] }, 20);
  assert.deepEqual(life.stalled, [{ id: "uxb_chk", name: "Checker" }]);
});
