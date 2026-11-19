import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "./dataset.js";
import { def, synthRows, spec } from "./analyses/fixture.js";
import { compareSyntheticToReal } from "./syntheticValidation.js";

/* P3-05: a simulation is compared with the field before it is trusted for anything beyond logic testing */

test("two samples from the same population are 'close'; a simulation that answers differently is flagged on those questions", () => {
  const real = buildDataset(def, synthRows(400, 11), { spec });
  const sameKind = buildDataset(def, synthRows(400, 99), { spec });
  const close = compareSyntheticToReal(sameKind, real);
  assert.ok(close.variables.length >= 3, JSON.stringify(close.variables.map((v) => v.variable)));
  assert.equal(close.verdict, "close", JSON.stringify(close));
  assert.ok(close.meanTvd < 0.1);

  /* a simulation where everyone is a woman from region 1 */
  const skewed = synthRows(400, 5).map((r) => {
    const answers = { ...(r.answers as Record<string, unknown>) };
    const g = def.questions.find((q) => q.variableName === "GENDER")!, reg = def.questions.find((q) => q.variableName === "REGION")!;
    answers[g.id] = 2; answers[reg.id] = 1;
    return { ...r, answers };
  });
  const far = compareSyntheticToReal(buildDataset(def, skewed, { spec }), real);
  assert.ok(far.diverging.includes("GENDER") && far.diverging.includes("REGION"), JSON.stringify(far.diverging));
  assert.notEqual(far.verdict, "close");
  assert.match(far.note, /not as evidence about the population or for power/);
  const g = far.variables.find((v) => v.variable === "GENDER")!;
  assert.ok(g.tvd > 0.4 && g.biggest);
});
