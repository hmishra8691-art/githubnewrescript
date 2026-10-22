import { test } from "node:test";
import assert from "node:assert/strict";
import { MODERATOR_EVAL_CASES, fakeEvalModel, moderatorEvalMarkdown, moderatorEvalReport, runModeratorCase } from "./aiModeratorEval.js";

/* The moderator's eval cases on the stand-in model (every unit run); scripts/eval-moderator.mjs runs the same on a real provider. */
test("every moderator eval case passes on the stand-in model", async () => {
  const results = [];
  for (const c of MODERATOR_EVAL_CASES) results.push(await runModeratorCase(c, fakeEvalModel));
  const failed = results.filter((r) => !r.pass);
  assert.deepEqual(failed.map((r) => `${r.id}: ${r.failures.join("; ")}`), []);
  const rep = moderatorEvalReport(results, { mode: "fake", model: "fake" });
  assert.equal(rep.passRate, 100);
  assert.match(moderatorEvalMarkdown(rep), /proves the engine, the rules and the output checks — NOT a model/);
  assert.ok(MODERATOR_EVAL_CASES.length >= 14);
});

test("the scorer fails what it should: a model that asks for contact details, leaks a link, or ignores the language", async () => {
  const bad = async () => ({ value: { say: "Thanks! What's your email so we can follow up? See https://x.example", intent: "probe" } });
  const r = await runModeratorCase(MODERATOR_EVAL_CASES.find((c) => c.id === "mod-probe-vague")!, bad, { real: true });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /failed the output checks/.test(f)), r.failures.join("; "));
  const english = async () => ({ value: { say: "Thank you. How did you feel about your provider at that point?", intent: "next" } });
  const h = await runModeratorCase(MODERATOR_EVAL_CASES.find((c) => c.id === "mod-hindi")!, english, { real: true });
  assert.equal(h.pass, false);
});
