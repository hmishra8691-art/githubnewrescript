import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_EXAMPLES } from "./examples.ts";
import { buildExample } from "./build.ts";

test("every live example builds through the engine with no refused action, schema error or empty survey", () => {
  for (const ex of DOC_EXAMPLES) {
    const b = buildExample(ex.id)!;
    assert.deepEqual(b.errors, [], `${ex.id}: ${b.errors.join(" | ")}`);
    assert.ok(b.def.questions.length >= 1, ex.id);
    assert.ok(b.json.length > 20, ex.id);
    if (ex.builder.question) assert.ok(b.def.questions.some((q) => q.code === ex.builder.question), `${ex.id}: builder question ${ex.builder.question}`);
  }
  assert.equal(new Set(DOC_EXAMPLES.map((e) => e.id)).size, DOC_EXAMPLES.length, "ids are unique");
});

test("the expression view is the engine's: display logic, skips, validation, piping, masks, branches and quotas", () => {
  const txt = (id: string) => buildExample(id)!.logic.map((l) => `${l.label}: ${l.text}`).join("\n");
  assert.match(txt("display-logic"), /Display Q2 if: Q1 = /);
  assert.match(txt("skip-logic"), /After Q1, skip to Q3 if: Q1 = /);
  assert.match(txt("survey-termination"), /terminate \(screened\) if: Q1 < 18/);
  assert.match(txt("validation-rules"), /Q2 is invalid when:/);
  assert.match(txt("piping"), /Piping in Q2: \{\{BRAND\}\}/);
  assert.match(txt("masking"), /Q2 options mask \(display\): Q1\.Unselected/);
  assert.match(txt("branching"), /Branch .* when: Q1 = /);
  assert.match(txt("quotas"), /Quota Gender — Women \(limit 200\)/);
  assert.match(txt("conditional-logic"), /AND/);
});
