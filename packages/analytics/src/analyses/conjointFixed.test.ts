import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { conjointPlugin } from "@rescript/designs";
import { designVersionFor, mulberry32 } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { cbcCoding, FIXED_ATTR } from "./choice.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * FIXED ALTERNATIVES IN THE CHOICE MODEL (2026-11-10).
 *
 * A population with KNOWN part-worths and a known pull toward "My current phone" (a constant) and toward a fixed
 * competitor (its levels' part-worths plus its own constant). The analysis must recover the part-worths as well as it
 * does without fixed alternatives, recover each constant, and leave the designed attributes' levels alone.
 */
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];
const TRUE: Record<string, number[]> = { Brand: [0.5, 0.0, -0.5], Storage: [-0.6, 0.1, 0.5], Price: [0.9, 0.1, -1.0] };
const ASC_CURRENT = 0.8, ASC_BETA = -0.4, NONE = -0.7;
const CONFIG = { attributes: ATTRS, tasks: 10, alternativesPerTask: 3, versions: 6, noneOption: true, method: "efficient" as const, fixedAlternatives: ["My current phone", "Beta today | Brand: Beta; Price: $299", "Another phone [specify]"] };
const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-9)));

function study(n: number) {
  const design = conjointPlugin.generate(CONFIG, 404);
  const def = SurveyDefinition.parse({
    meta: { id: "cf", code: "CF", title: "Fixed alternatives", version: "1.0" },
    designs: [{ id: "d", kind: "conjoint", name: "CBC", config: CONFIG, file: { format: "json", columns: design.columns, rows: design.rows } }],
    questions: [{ id: "q", code: "Q1", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q"] }],
  });
  const r = mulberry32(99);
  const rows: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const seed = 1000 + i;
    const version = designVersionFor(def.questions[0], design.rows, seed);
    const mine = design.rows.filter((x) => String(x.version) === version);
    const ans: Record<string, unknown> = {};
    for (const t of [...new Set(mine.map((x) => String(x.task)))]) {
      const alts = mine.filter((x) => String(x.task) === t);
      const u = alts.map((a) => {
        if (Number(a.none_option) === 1) return NONE + gumbel(r);
        const lv = ATTRS.reduce((s, at) => { const l = String(a[at.name] ?? ""); return s + (l === "" ? 0 : TRUE[at.name][at.levels.indexOf(l)]); }, 0);
        const k = Number(a.fixed_option);
        return lv + (k === 1 ? ASC_CURRENT : k === 2 ? ASC_BETA : k === 3 ? -1.5 : 0) + gumbel(r);
      });
      const pick = alts[u.indexOf(Math.max(...u))];
      ans[t] = String(pick.alt);
      if (Number(pick.fixed_option) === 3) ans[`${t}_other`] = "A refurbished Delta";
    }
    rows.push({ id: `r${i}`, session_id: `s${i}`, respondent_code: `L${i}`, status: "complete", is_test: false, started_at: "2026-06-01T10:00:00.000Z", completed_at: "2026-06-01T10:07:00.000Z", quality: { classification: "CLEAN", qualityScore: 90, riskScore: 5 }, answers: { q: ans, q_version: version }, calculated: {}, embedded: {}, flags: [], seed } as AnalyticsRow);
  }
  return { def, design, rows };
}
const spec = { environment: "LIVE" as const, dataset: "all" as const };

test("the coding: one constant per fixed alternative, after None; a fixed alternative's levels are levels, never new ones", () => {
  const { design } = study(1);
  const c = cbcCoding(design.rows, design.columns, CONFIG);
  assert.deepEqual(c.attrs, ["Brand", "Storage", "Price"]);
  assert.deepEqual(c.levels.Price, ["$199", "$299", "$399"]);
  assert.equal(c.p, 6 + 1 + 3, "six level parameters, None, three constants");
  assert.deepEqual(c.fixed.map((f) => [f.num, f.label, f.i]), [[1, "My current phone", 7], [2, "Beta today", 8], [3, "Another phone", 9]]);
  const beta = design.rows.find((x) => Number(x.fixed_option) === 2)!;
  const x = c.featuresOf(beta);
  assert.equal(x[8], 1);
  assert.deepEqual([x[0], x[1]], [1, 0], "Brand: Beta");
  assert.deepEqual([x[2], x[3]], [0, 0], "Storage is not specified: it adds nothing");
  assert.deepEqual([x[4], x[5]], [1, 0], "Price: $299");
  const lr = c.levelRows();
  assert.deepEqual(lr.attr.slice(-4), [null, FIXED_ATTR, FIXED_ATTR, FIXED_ATTR], "None is still the only null attribute");
});

test("the model recovers the part-worths AND each fixed alternative's constant, and reports the typed answers as text", () => {
  const { def, rows } = study(700);
  const r = runAnalysis({ name: "conjoint", kind: "conjoint", dataset: spec, variables: ["CBC"] } as AnalysisDefinition, buildDataset(def, rows, { spec }));
  const pw = r.tables.find((t) => t.id === "partworths")!.rows;
  for (const at of ATTRS) at.levels.forEach((l, k) => {
    const got = Number(pw.find((x) => x.attribute === at.name && x.level === l)!.utility);
    assert.ok(Math.abs(got - TRUE[at.name][k]) < 0.15, `${at.name} ${l}: ${got} vs ${TRUE[at.name][k]}`);
  });
  const fixed = r.tables.find((t) => t.id === "fixed")!;
  const row = (name: string) => fixed.rows.find((x) => x.alternative === name)!;
  assert.ok(Math.abs(Number(row("My current phone").constant) - ASC_CURRENT) < 0.15, `current: ${row("My current phone").constant}`);
  assert.ok(Math.abs(Number(row("Beta today").constant) - ASC_BETA) < 0.2, `beta: ${row("Beta today").constant}`);
  assert.equal(row("Beta today").levels, "Brand: Beta; Price: $299");
  assert.ok(Math.abs(Number(row("Beta today").utility) - (ASC_BETA + 0.0 + 0.1)) < 0.2, "total utility = constant + its levels");
  assert.match(String(row("My current phone").levels), /its constant is its whole utility/);
  assert.ok(Number(row("My current phone").chosen) > Number(row("Another phone").chosen));
  assert.match(fixed.notes!.join(" "), /typed answers? for the “specify” alternative are in the data as text/);
  assert.ok(!pw.some((x) => /current|Another|Delta/i.test(String(x.level))), "no fixed alternative and no typed text among the levels");
  /* the existing tables keep their places */
  assert.deepEqual(r.tables.slice(0, 4).map((t) => t.id), ["importance", "partworths", "fit", "simulation"]);
});
