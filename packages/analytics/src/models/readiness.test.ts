import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisReadiness } from "../planCheck.js";
import { ANALYSIS_KINDS, type AnalysisDefinition } from "../types.js";
import { RUNNERS, runAnalysis } from "../analyses/index.js";
import { variableMetadata } from "../dataset.js";
import { buildXlsx } from "../export/xlsx.js";
import { advancedDataset, advSpec } from "./fixture.js";

/**
 * THE ONE READINESS RULE covers the advanced models: the builder's Run button,
 * the run route (422) and the plan read `analysisReadiness`, so an HB on a
 * non-choice question, an LCA with one indicator or a non-identified SEM is
 * refused with a reason before anything runs.
 */
const { def, ds } = advancedDataset({ n: 120 });
const vars = variableMetadata(def);
const D = (kind: AnalysisDefinition["kind"], variables: string[], options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: advSpec, variables, options });

test("the advanced kinds are registered: listed, grouped, and every one has a runner", () => {
  for (const k of ["hb", "lca", "sem"] as const) {
    const info = ANALYSIS_KINDS.find((x) => x.kind === k);
    assert.ok(info && info.group === "Advanced models", k);
    assert.equal(typeof RUNNERS[k], "function");
  }
});

test("HB readiness: one CBC or MaxDiff question; a non-choice question and a runaway iteration count are refused", () => {
  assert.equal(analysisReadiness(D("hb", ["CBC"]), vars).ready, true);
  assert.equal(analysisReadiness(D("hb", ["MD"]), vars).ready, true);
  assert.equal(analysisReadiness(D("hb", ["CBC_TASKS"]), vars).ready, true, "the picker's name for the conjoint question");
  assert.equal(analysisReadiness(D("hb", ["MD_TASKS"]), vars).ready, true);
  const wrong = analysisReadiness(D("hb", ["SAT"]), vars);
  assert.equal(wrong.ready, false); assert.match(wrong.missing.join(" "), /CBC \(conjoint\) or MaxDiff question/);
  assert.equal(analysisReadiness(D("hb", []), vars).ready, false);
  assert.match(analysisReadiness(D("hb", ["CBC", "MD"]), vars).missing.join(" "), /only that question/);
  assert.match(analysisReadiness(D("hb", ["CBC"], { burnIn: 150_000, draws: 100_000 }), vars).missing.join(" "), /limit is 200,000/);
});

test("LCA readiness: two or more indicators, a sane class range, and identification from the code frames", () => {
  assert.equal(analysisReadiness(D("lca", ["U1", "U2", "U3", "U4", "U5", "U6"], { maxClasses: 4 }), vars).ready, true);
  assert.match(analysisReadiness(D("lca", ["U1"]), vars).missing.join(" "), /at least two categorical indicators/);
  assert.match(analysisReadiness(D("lca", ["U1", "U2", "U3"], { minClasses: 3, maxClasses: 2 }), vars).missing.join(" "), /class range/);
  assert.match(analysisReadiness(D("lca", ["U1", "U2", "U3"], { maxClasses: 9 }), vars).missing.join(" "), /class range/);
  // three binary indicators: 7 free cell frequencies; K = 2 needs 7 parameters (ok), K = 3 needs 11 (not identified)
  const r = analysisReadiness(D("lca", ["U1", "U2", "U3"], { maxClasses: 3 }), vars);
  assert.equal(r.ready, true, "a warning: the larger K will be reported as not identified");
  assert.match(r.warnings.join(" "), /3 classes are not identified.*at most 2 classes/);
  assert.equal(analysisReadiness(D("lca", ["U1", "U2", "U3"], { minClasses: 3, maxClasses: 3 }), vars).ready, false);
});

test("SEM readiness: syntax required, parsed and identified — a non-identified model is refused before running", () => {
  const ok = "X =~ X1 + X2 + X3\nM =~ M1 + M2 + M3\nM ~ X";
  assert.equal(analysisReadiness(D("sem", [], { syntax: ok }), vars).ready, true, "no variable list needed: the syntax names them");
  assert.match(analysisReadiness(D("sem", [], {}), vars).missing.join(" "), /Write the model/);
  const two = analysisReadiness(D("sem", [], { syntax: "F =~ X1 + X2" }), vars);
  assert.equal(two.ready, false); assert.ok(two.codes.includes("not_identified")); assert.match(two.missing.join(" "), /two indicators/);
  const trule = analysisReadiness(D("sem", [], { syntax: "F =~ X1 + X2 + X3\nX1 ~~ X2\nX1 ~~ X3\nX2 ~~ X3" }), vars);
  assert.equal(trule.ready, false); assert.match(trule.missing.join(" "), /t-rule/);
  const unknown = analysisReadiness(D("sem", [], { syntax: "F =~ X1 + X2 + NOPE" }), vars);
  assert.equal(unknown.ready, false); assert.match(unknown.missing.join(" "), /NOPE is not a variable/);
  const parse = analysisReadiness(D("sem", [], { syntax: "F =~ X1 + X2 + X3\nX1 ~ 1" }), vars);
  assert.ok(parse.codes.includes("invalid_model"));
  // without a dictionary (the run route's call) identification is still checked
  assert.equal(analysisReadiness(D("sem", [], { syntax: "F =~ a + b" })).ready, false);
  assert.equal(analysisReadiness(D("sem", [], { syntax: "F =~ a + b + c" })).ready, true);
  // a text variable cannot be an SEM indicator
  const meta = [...vars, { name: "TXT", label: "Text", role: "text" as const, derived: false, hidden: false }];
  assert.match(analysisReadiness(D("sem", [], { syntax: "F =~ X1 + X2 + TXT" }), meta).missing.join(" "), /not numeric or scale/);
});

test("advanced results export through the analysis export path (one sheet per table)", { timeout: 60_000 }, async () => {
  const r = runAnalysis(D("sem", [], { syntax: "X =~ X1 + X2 + X3\nM =~ M1 + M2 + M3\nY =~ Y1 + Y2 + Y3\nM ~ X\nY ~ X + M" }), ds);
  const l = runAnalysis(D("lca", ["U1", "U2", "U3", "U4"], { maxClasses: 2, starts: 5 }), ds);
  const report = { title: "Advanced", mode: "live", blocks: [...r.tables.map((t, i) => ({ id: `s${i}`, type: "table", analysisId: "sem", tableId: t.id })), ...l.tables.map((t, i) => ({ id: `l${i}`, type: "table", analysisId: "lca", tableId: t.id }))] };
  const buf = await buildXlsx({ report: report as never, results: { sem: r, lca: l } as never, theme: undefined as never });
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
  assert.ok(bytes.length > 2000);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK", "a zip (xlsx) file");
});
