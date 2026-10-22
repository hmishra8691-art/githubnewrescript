import { test } from "node:test";
import assert from "node:assert/strict";
import { acbcStudy, cbcStudy, cvaStudy, menuStudy } from "./fixture.js";
import { conjointAnalysisDefinitions, conjointSuiteReadiness } from "./readiness.js";
import { runAnalysis } from "../analyses/index.js";
import { analysisReadiness } from "../planCheck.js";
import { variableMetadata } from "../dataset.js";

/** the plan entry points (for the analysis plan): what each method can run, ready or why not, and definitions that run */
test("conjointSuiteReadiness / conjointAnalysisDefinitions: every method names its estimators; the definitions run", { timeout: 120_000 }, () => {
  const cases = [
    { s: cbcStudy({ n: 40, dual: true }), v: "CBC", method: "cbc", ids: ["cbc_aggregate", "cbc_hb", "cbc_forced"] },
    { s: acbcStudy({ n: 30 }), v: "ACBC", method: "acbc", ids: ["acbc_aggregate", "acbc_hb"] },
    { s: menuStudy({ n: 40 }), v: "MENU", method: "menu", ids: ["menu_aggregate", "menu_hb"] },
    { s: cvaStudy({ n: 15 }), v: "CVA", method: "cva", ids: ["cva_ols", "cva_hb"] },
  ];
  for (const c of cases) {
    const r = conjointSuiteReadiness(c.s.ds, c.v);
    assert.equal(r.method, c.method);
    assert.deepEqual(r.estimators.map((e) => e.id), c.ids);
    assert.ok(r.estimators[0].ready, `${c.v}: ${r.estimators[0].reason}`);
    if (c.method === "cva") assert.match(r.estimators[1].reason ?? "", /least squares/);
    const defs = conjointAnalysisDefinitions(c.s.def, c.v);
    assert.ok(defs.length >= 1 && defs.every((d) => d.variables[0] === c.v));
    const agg = runAnalysis(defs[0], c.s.ds);
    assert.equal(agg.error, undefined, `${c.v}: ${JSON.stringify(agg.warnings)}`);
    for (const d of defs) assert.equal(analysisReadiness(d, variableMetadata(c.s.def)).ready, true, `${d.name}: ${analysisReadiness(d, variableMetadata(c.s.def)).missing}`);
  }
  // too few respondents for HB: said, not run
  const few = conjointSuiteReadiness(cvaStudy({ n: 5 }).ds, "CVA");
  assert.ok(few.estimators[0].ready);
  const smallAcbc = conjointSuiteReadiness(acbcStudy({ n: 8 }).ds, "ACBC");
  assert.match(smallAcbc.estimators.find((e) => e.kind === "hb")!.reason ?? "", /at least 20 respondents/);
  assert.equal(conjointSuiteReadiness(cvaStudy({ n: 5 }).ds, "NOPE").method, null);
});
