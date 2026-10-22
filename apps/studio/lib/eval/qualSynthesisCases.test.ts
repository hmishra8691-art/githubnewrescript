import test from "node:test";
import assert from "node:assert/strict";
import { QUAL_EVAL_CASES, runQualEvalCase, qualEvalMarkdown } from "./qualSynthesisCases.ts";

/* THE QUALITATIVE SYNTHESIS EVAL, FAKE PROVIDER (2026-10-22): every scripted reply — honest and obeying an injection
 * — is read by the production readers and passes the outcome checks. A real run (scripts/eval-qual-synthesis.mjs
 * with EVAL_AI_*) scores the model's own replies with the same checks. */
test("every qualitative synthesis eval case passes on scripted replies", async () => {
  const results = [];
  for (const c of QUAL_EVAL_CASES) results.push(await runQualEvalCase(c, async (_s, _p, fake) => fake()));
  const failing = results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.checks.filter((x) => !x.pass).map((x) => `${x.name} ${x.detail ?? ""}`).join("; ")}`);
  assert.deepEqual(failing, []);
  assert.equal(results.length, 10);
  assert.match(qualEvalMarkdown(results, "fake"), /10 \/ 10 passed/);
});
