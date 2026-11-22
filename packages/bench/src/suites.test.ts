import { test } from "node:test";
import assert from "node:assert/strict";
import { allSuites } from "./run.js";
import { EDIT_TASKS, OPS_TASKS, SAFE_TASKS, agentInstructions, agentOperations, runEdit } from "./suites/agent.js";
import { LARGE, conditioned, largeSurvey, manyRows } from "./suites/perf.js";
import { speechProviders } from "./suites/speech.js";
import { agentModel } from "./suites/agent.js";

test("the registry: unique ids, every one an area's", () => {
  const suites = allSuites(process.cwd());
  assert.equal(new Set(suites.map((s) => s.id)).size, suites.length);
  for (const s of suites) assert.ok(s.id.startsWith(`${s.area}.`), s.id);
});

test("the instruction corpus is well formed and its grader tells a right edit from none", () => {
  assert.ok(EDIT_TASKS.length >= 30);
  assert.equal(new Set(EDIT_TASKS.map((t) => t.id)).size, EDIT_TASKS.length);
  for (const t of EDIT_TASKS) assert.ok(t.plain !== t.free && t.plain.length > 5 && t.free.length > 5, t.id);
  const required = EDIT_TASKS.find((t) => t.id === "require")!;
  assert.equal(runEdit(required.plain, required.grade).outcome, "correct");
  /* the same sentence against another task's grader: an applied edit that is not what was asked is "wrong" */
  assert.equal(runEdit(required.plain, EDIT_TASKS.find((t) => t.id === "delete")!.grade).outcome, "wrong");
  assert.equal(runEdit("Write me a poem about cars", required.grade).outcome === "correct", false);
});

test("the instruction suite never lets an out-of-scope sentence change the survey, and counts every case", async () => {
  const r = await agentInstructions.run();
  assert.equal(r.status, "measured");
  assert.equal(r.cases.length, EDIT_TASKS.length * 2 + SAFE_TASKS.length);
  assert.equal(r.metrics.find((m) => m.id === "unsafe")!.value, 0);
  assert.ok(r.caveat && /no language model/i.test(r.caveat));
});

test("the operations suite reads the catalogue's own sentences", async () => {
  const r = await agentOperations.run();
  assert.equal(r.cases.length, OPS_TASKS.length);
  assert.equal(r.metrics.find((m) => m.id === "catalogue_examples")!.value, 100);
  for (const c of r.cases.filter((x) => x.group === "left alone")) assert.ok(c.pass, c.id);
});

test("what cannot be measured says so and scores nothing", async () => {
  for (const s of [agentModel, speechProviders]) {
    const r = await s.run();
    assert.equal(r.status, "blocked");
    assert.ok(r.reason && r.reason.length > 40);
    assert.equal(r.metrics.length, 0);
  }
});

test("the large survey and the large data set are the size they say", () => {
  const def = largeSurvey();
  assert.equal(def.questions.length, LARGE.questions + 1);
  assert.equal(JSON.stringify(def.flow).split('"type":"loop"').length - 1, LARGE.loops);
  /* the schema drops a field it does not know: the conditions must have survived the parse */
  assert.ok(conditioned(def) >= 170, `${conditioned(def)} conditioned questions`);
  const rows = manyRows(1000);
  assert.equal(rows.length, 1000);
  assert.deepEqual(manyRows(50), manyRows(50));
});
