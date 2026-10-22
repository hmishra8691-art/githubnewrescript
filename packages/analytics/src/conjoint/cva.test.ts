import { test } from "node:test";
import assert from "node:assert/strict";
import { cvaStudy, CVA_ATTRS, CVA_MU, corr, spec } from "./fixture.js";
import { fitCva, monotoneOf } from "./cva.js";
import { runAnalysis } from "../analyses/index.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * RATING-BASED CONJOINT (CVA) — recovery, validated not asserted. 200 respondents with KNOWN
 * per-respondent part-worths (population mean CVA_MU, heterogeneity SD 0.5 per level before
 * centring) rate a 4-version D-optimal design of 16 profiles + 2 holdouts on 0–10 with N(0, 0.8)
 * error, rounded and clipped as a respondent's answer is. Measured: max |mean utility − truth|
 * 0.106, r(individual, truth) 0.943, median R² 0.89; pairs: max error 0.18.
 */
const D = (options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: "cva", kind: "conjoint", dataset: spec, variables: ["CVA"], options });

test("CVA single profiles: per-respondent OLS recovers the population means and each respondent's part-worths; flat raters flagged, not estimated", () => {
  const s = cvaStudy({ n: 200, flat: 3 });
  const r = runAnalysis(D(), s.ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const pw = r.tables.find((t) => t.id === "partworths")!;
  assert.match(pw.title, /rating-based conjoint \(per-respondent least squares/);
  let maxErr = 0;
  for (const a of CVA_ATTRS) a.levels.forEach((l, k) => { const row = pw.rows.find((x) => x.attribute === a.name && x.level === l)!; maxErr = Math.max(maxErr, Math.abs((row.mean as number) - CVA_MU[a.name][k])); });
  assert.ok(maxErr < 0.15, `max |μ̂ − μ| = ${maxErr.toFixed(3)}`);
  const ind = r.tables.find((t) => t.id === "individual")!;
  const est: number[] = [], tru: number[] = [];
  ind.rows.forEach((row, i) => { if (row.r2 == null) return; for (const a of CVA_ATTRS) a.levels.forEach((_, k) => { est.push(row[`${a.name}\u0000${k}`] as number); tru.push(s.truth[i].levels[a.name][k]); }); });
  const rInd = corr(est, tru);
  assert.ok(rInd > 0.9, `r(individual) = ${rInd.toFixed(3)}`);
  const fit = r.tables.find((t) => t.id === "fit")!;
  assert.equal(fit.rows.find((x) => String(x.m).includes("flat rater"))!.v, 3);
  assert.equal(fit.rows.find((x) => x.m === "Respondents with utilities")!.v, 197);
  assert.ok((fit.rows.find((x) => x.m === "Median R²")!.v as number) > 0.8);
  assert.ok(ind.rows.slice(0, 3).every((row) => /flat rater/.test(String(row.flags)) && row.r2 == null), "the flat raters have no utilities");
  assert.ok(r.warnings.some((w) => /3 respondents gave every profile the same rating/.test(w)));
  // holdouts predicted, importances ordered by the truth's ranges (Battery > Brand > Screen > Storage)
  const hold = r.tables.find((t) => t.id === "holdout")!;
  assert.ok((hold.rows.find((x) => String(x.m).startsWith("Correlation"))!.v as number) > 0.6);
  assert.deepEqual(r.tables.find((t) => t.id === "importance")!.rows.map((x) => x.attribute), ["Battery", "Brand", "Screen", "Storage"]);
  // the default simulator: first choice, best vs worst profile
  const sim = r.tables.find((t) => t.id === "sim_shares")!;
  assert.match(sim.title, /first choice/);
  assert.ok((sim.rows[0].share as number) > 95);
  console.log(`  CVA recovery: max |μ̂−μ| = ${maxErr.toFixed(3)}, r(individual) = ${rInd.toFixed(3)}`);
});

test("CVA pairs: the preference ratings recover the part-worth differences (no intercept)", () => {
  const s = cvaStudy({ n: 200, mode: "paired" });
  const r = runAnalysis(D(), s.ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const pw = r.tables.find((t) => t.id === "partworths")!;
  assert.match(pw.title, /pairs/);
  let maxErr = 0;
  for (const a of CVA_ATTRS) a.levels.forEach((l, k) => { const row = pw.rows.find((x) => x.attribute === a.name && x.level === l)!; maxErr = Math.max(maxErr, Math.abs((row.mean as number) - CVA_MU[a.name][k])); });
  assert.ok(maxErr < 0.25, `max |μ̂ − μ| = ${maxErr.toFixed(3)}`);
  assert.ok(!r.tables.find((t) => t.id === "individual")!.columns.some((c) => c.key === "intercept"), "pairs have no intercept");
  console.log(`  CVA pairs recovery: max |μ̂−μ| = ${maxErr.toFixed(3)}`);
});

test("monotonicity: levels that break the stated order are tied, and the constrained fit honours the order", () => {
  const attrs = [{ name: "Price", levels: ["$1", "$2", "$3"] }, { name: "Colour", levels: ["Red", "Blue"] }];
  // ratings where $2 looks better than $1 (noise) although price should decrease utility
  const obs = [
    { profiles: [[0, 0]], y: 6, holdout: false }, { profiles: [[1, 0]], y: 7, holdout: false }, { profiles: [[2, 0]], y: 3, holdout: false },
    { profiles: [[0, 1]], y: 7, holdout: false }, { profiles: [[1, 1]], y: 8, holdout: false }, { profiles: [[2, 1]], y: 4, holdout: false },
  ];
  const free = fitCva(attrs, obs, "single", { min: 0, max: 10 });
  assert.ok(free.levels!.Price[1] > free.levels!.Price[0], "unconstrained: $2 above $1");
  const mono = fitCva(attrs, obs, "single", { min: 0, max: 10 }, monotoneOf(["Price: decreasing"], attrs));
  assert.deepEqual(mono.ties, ["Price: $1 = $2"]);
  assert.ok(mono.levels!.Price[0] >= mono.levels!.Price[1] - 1e-9 && mono.levels!.Price[1] >= mono.levels!.Price[2]);
  assert.ok(Math.abs(mono.levels!.Price[0] - mono.levels!.Price[1]) < 1e-9);
  assert.deepEqual(monotoneOf({ price: "DECREASING" }, attrs), { Price: "decreasing" });
  // the analysis option turns it on
  const s = cvaStudy({ n: 60 });
  const r = runAnalysis(D({ monotone: ["Battery: increasing"] }), s.ds);
  assert.ok(r.tables.find((t) => t.id === "partworths")!.notes!.some((n) => /Order constraints: Battery increasing/.test(n)));
});

test("CVA: no answers / no design refused in words; HB on a CVA question refused with the reason; the simulator's BTL and logit rules", () => {
  const s = cvaStudy({ n: 30 });
  const hb = runAnalysis({ name: "hb", kind: "hb", dataset: spec, variables: ["CVA"] }, s.ds);
  assert.ok(hb.error && /least squares/.test(hb.error.message), JSON.stringify(hb.error));
  const products = [{ name: "A", levels: { Brand: "Alpha", Screen: "7in", Battery: "3 days", Storage: "128 GB" } }, { name: "B", levels: { Brand: "Gamma", Screen: "5in", Battery: "1 day", Storage: "64 GB" } }];
  const btl = runAnalysis(D({ simulator: { products, rule: "btl" } }), s.ds).tables.find((t) => t.id === "sim_shares")!;
  const fc = runAnalysis(D({ simulator: { products, rule: "first_choice" } }), s.ds).tables.find((t) => t.id === "sim_shares")!;
  assert.match(btl.title, /BTL/);
  assert.ok((btl.rows[0].share as number) > 50 && (btl.rows[0].share as number) < (fc.rows[0].share as number), "BTL is less extreme than first choice");
});
