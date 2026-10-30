import { test } from "node:test";
import assert from "node:assert/strict";
import { codeGate } from "@rescript/engine";
import { SURVEY_TEMPLATES, buildMasterDemoSurvey } from "./index.js";

/* S0b D3: every logic script the product ships (the master demo, every template) passes the code gate unchanged */
test("the master demo's and every template's scripts pass the logic-script code gate", () => {
  const defs: [string, { scripts?: { name: string; code: string }[] }][] = [["master demo", buildMasterDemoSurvey()]];
  for (const t of SURVEY_TEMPLATES) defs.push([t.key, t.build(`gate_${t.key}`) as never]);
  let n = 0;
  for (const [name, d] of defs) for (const s of d.scripts ?? []) {
    n++;
    assert.deepEqual(codeGate(s.code, "logic").errors, [], `${name} · ${s.name}`);
  }
  assert.ok(n >= 10, `scripts checked: ${n}`);
});
