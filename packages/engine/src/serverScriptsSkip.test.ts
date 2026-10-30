import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkSubmission, createResponseState, validateQuestion, validatePage } from "./index.js";

/**
 * AUDIT 2026-10-30 D1 — THE SERVER NEVER RUNS AUTHOR CODE.
 *
 * The save replay (`checkSubmission`) reached `runScript` through a
 * `custom_script` validation rule: author JavaScript ran in the server's own
 * realm (it could read `process`), an endless loop hung the save route, and a
 * script switched off in the editor still ran. These pin the fix: the server
 * records the rule as a soft `client_only` note and never executes it; the
 * browser still runs it; `enabled:false` is off everywhere.
 */

const G = globalThis as unknown as Record<string, unknown>;

function survey(code: string, enabled = true) {
  return SurveyDefinition.parse({
    meta: { id: "s", title: "t" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "Age", settings: {}, options: [],
      validation: [{ kind: "custom_script", value: "probe" }],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
    scripts: [{ id: "probe", name: "probe", scope: "survey", event: "on_validate", enabled, code }],
    branding: {},
  });
}

const posted = { answers: { q1: 30 }, status: "complete", stepIndex: 1 };
const prior = { seed: 1, sessionId: "x" };

test("D1: checkSubmission never executes a custom_script rule (sentinel global untouched)", () => {
  delete G.__S0A_SENTINEL__;
  const def = survey('globalThis.__S0A_SENTINEL__ = "ran"; error("server ran author code");');
  const r = checkSubmission({ def, prior, posted });
  assert.equal(G.__S0A_SENTINEL__, undefined, "author code must not run on the server");
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  const notes = r.soft.filter((p) => p.code === "client_only");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].questionId, "q1");
  assert.equal(notes[0].pageId, "p1");
});

test("D1: a script that throws, loops forever or touches process does not run on the server", () => {
  for (const code of [
    'throw new Error("boom");',
    "while (true) {}",
    "for (;;) { }",
    'if (get.constructor("return typeof process")() === "object") error("SERVER RAN AUTHOR CODE: process reachable");',
    'get.constructor("process.exit(3)")();',
  ]) {
    const t0 = Date.now();
    const r = checkSubmission({ def: survey(code), prior, posted });
    assert.ok(Date.now() - t0 < 2000, `returned promptly for ${code}`);
    assert.equal(r.ok, true, `${code}: ${JSON.stringify(r.hard)}`);
    assert.ok(r.soft.some((p) => p.code === "client_only"), code);
    assert.ok(!JSON.stringify(r).includes("SERVER RAN AUTHOR CODE"));
  }
});

test("D1 regression (port of ssa/s1-probe4.mjs): process is not reachable through the replay", () => {
  const def = survey("if (get.constructor('return typeof process')() === 'object') error('SERVER RAN AUTHOR CODE: process reachable');");
  const r = checkSubmission({ def, prior: { seed: 1, sessionId: "x" }, posted: { answers: { q1: 30 }, status: "complete", stepIndex: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.hard, []);
  assert.ok(!JSON.stringify(r).includes("process reachable"));
});

test("D1: the browser path (default scripts:'run') still executes the rule", () => {
  const def = survey('if (Number(value) % 2 !== 0) error("even only");');
  const state = createResponseState(def, { sessionId: "b" });
  const q = def.questions[0];
  assert.equal(validateQuestion(def, q, 4, { def, state }).length, 0);
  assert.equal(validateQuestion(def, q, 7, { def, state })[0]?.message, "even only");
});

test("D1: enabled:false is not run in the browser path either", () => {
  delete G.__S0A_SENTINEL__;
  const def = survey('globalThis.__S0A_SENTINEL__ = "ran"; error("disabled script ran");', false);
  const state = createResponseState(def, { sessionId: "b" });
  state.answers.q1 = 7;
  const errs = validatePage(def, def.questions, { def, state });
  assert.equal(errs.length, 0);
  assert.equal(G.__S0A_SENTINEL__, undefined);
  // and the server does not even record a note for a disabled rule
  const r = checkSubmission({ def, prior, posted });
  assert.equal(r.soft.filter((p) => p.code === "client_only").length, 0);
});

test("D1: scripts:'skip' on validatePage records the rule without running it", () => {
  delete G.__S0A_SENTINEL__;
  const def = survey('globalThis.__S0A_SENTINEL__ = "ran";');
  const state = createResponseState(def, { sessionId: "b" });
  state.answers.q1 = 7;
  const skippedScripts: { questionId?: string; script: string }[] = [];
  const errs = validatePage(def, def.questions, { def, state, scripts: "skip", skippedScripts });
  assert.equal(errs.length, 0);
  assert.equal(G.__S0A_SENTINEL__, undefined);
  assert.deepEqual(skippedScripts, [{ questionId: "q1", script: "probe" }]);
});
