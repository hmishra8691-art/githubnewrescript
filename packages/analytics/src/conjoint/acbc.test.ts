import { test } from "node:test";
import assert from "node:assert/strict";
import { acbcStudy, ACBC_ATTRS, ACBC_MU, corr, spec } from "./fixture.js";
import { acbcCoding, acbcSets } from "./acbc.js";
import { runAnalysis } from "../analyses/index.js";
import { normalizeAcbc, submitByo, emptyAcbcAnswer, nearConcepts } from "@rescript/engine";

/**
 * ADAPTIVE CBC — recovery through the platform's OWN interview engine. Respondents with KNOWN
 * part-worths, a known summed-price slope and a threshold answer the real ACBC state machine
 * (@rescript/engine acbc.ts): BYO with each level's price increment, screening against their
 * threshold (logistic), unacceptable / must-have questions confirmed only when the rule is
 * near-certain under their utilities, and the tournament (Gumbel). Measured:
 *   aggregate (heterogeneity 0.2): max |utility − μ| 0.153; price −0.0099 per unit (truth ≈ −0.0125)
 *   HB (heterogeneity 0.8, 300 respondents, 3,000 + 2,000 iterations × 2 chains): max |μ̂ − μ| 0.134,
 *     r(individual, truth) 0.796, price −0.0126 (truth mean −0.0125), R̂ 1.07
 */
const A = (kind: "conjoint" | "hb", options: Record<string, unknown> = {}) => ({ name: kind, kind, dataset: spec, variables: ["ACBC"], options });

test("ACBC coding: BYO per attribute, screening vs threshold, implied rule screens, tournament — the summed price as one linear term", () => {
  const s = acbcStudy({ n: 5 });
  const a = s.rows[0].answers!.q_acbc as Parameters<typeof acbcSets>[1];
  const { sets, stages } = acbcSets(s.coding, a);
  assert.equal(stages.filter((x) => x === "byo").length, ACBC_ATTRS.length);
  assert.equal(stages.filter((x) => x === "screen").length, a.screens.reduce((t, sc) => t + Object.keys(sc.verdicts).length, 0));
  assert.equal(stages.filter((x) => x === "tournament").length, a.tournament.filter((r) => r.chosen).length);
  const screen = sets[stages.indexOf("screen")];
  assert.equal(screen.alternatives.length, 2);
  assert.equal(screen.alternatives[1][s.coding.thresholdIdx], 1, "the second alternative is the threshold");
  assert.ok(screen.alternatives[0][s.coding.priceIdx] !== 0, "a screened concept carries its (varied) summed price");
  // without a summed price there is no price column, and concepts carry no price
  const plain = acbcCoding({ attributes: ACBC_ATTRS });
  assert.equal(plain.priceIdx, -1);
  const cfg = normalizeAcbc({ attributes: ACBC_ATTRS });
  const ans = submitByo(cfg, emptyAcbcAnswer(), 7, { Brand: "Alpha", Screen: "6in", Battery: "2 days", Storage: "64 GB" });
  assert.ok(ans.screens[0].concepts.every((c) => !("price" in c)), "no summed price → concepts exactly as before");
  // with one: every concept is priced within ± variation of its list price
  const cfgP = normalizeAcbc(s.config);
  const ansP = submitByo(cfgP, emptyAcbcAnswer(), 7, { Brand: "Alpha", Screen: "6in", Battery: "2 days", Storage: "64 GB" });
  for (const c of ansP.screens[0].concepts) {
    const list = 300 + [0, 50, 100][ACBC_ATTRS[0].levels.indexOf(c.profile.Brand)] + [0, 40, 80][ACBC_ATTRS[1].levels.indexOf(c.profile.Screen)] + [0, 30, 60][ACBC_ATTRS[2].levels.indexOf(c.profile.Battery)] + [0, 50][ACBC_ATTRS[3].levels.indexOf(c.profile.Storage)];
    assert.ok(c.price! >= list * 0.7 - 1 && c.price! <= list * 1.3 + 1, `${c.price} vs list ${list}`);
  }
  // the same concepts as without a price (the price uses its own random stream)
  assert.deepEqual(nearConcepts(cfgP, ansP, 7, 2, 4, new Set()).map((c) => c.profile), nearConcepts(cfg, { ...ansP }, 7, 2, 4, new Set()).map((c) => c.profile));
});

test("ACBC aggregate logit (quick look): recovers the part-worths and the price slope; counts and fit by stage are labelled", () => {
  const s = acbcStudy({ n: 300, het: 0.2 });
  const r = runAnalysis(A("conjoint"), s.ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const pw = r.tables.find((t) => t.id === "partworths")!;
  assert.match(pw.title, /ACBC aggregate multinomial logit/);
  let maxErr = 0;
  for (const a of ACBC_ATTRS) a.levels.forEach((l, k) => { const row = pw.rows.find((x) => x.attribute === a.name && x.level === l)!; maxErr = Math.max(maxErr, Math.abs((row.utility as number) - ACBC_MU[a.name][k])); });
  assert.ok(maxErr < 0.25, `max |utility − μ| = ${maxErr.toFixed(3)}`);
  const price = pw.rows.find((x) => x.attribute === "Price (summed)" && x.level === "per 1 currency unit")!.utility as number;
  const truePrice = s.truth.reduce((t, x) => t + x.price, 0) / s.truth.length;
  assert.ok(price < 0 && Math.abs(price - truePrice) / Math.abs(truePrice) < 0.3, `price ${price} vs ${truePrice}`);
  assert.ok(pw.rows.some((x) => x.attribute === "Threshold"));
  const fit = r.tables.find((t) => t.id === "fit")!;
  assert.deepEqual(new Set(fit.rows.map((x) => x.stage)), new Set(["Build-your-own", "Screening (vs threshold)", "Tournament", "Rules (implied screens)"]));
  const counts = r.tables.find((t) => t.id === "counts")!;
  assert.match(counts.title, /raw, not a model/);
  assert.equal(counts.rows.length, ACBC_ATTRS.reduce((t, a) => t + a.levels.length, 0));
  assert.ok(!r.warnings.some((w) => /No ACBC estimator/.test(w)));
  console.log(`  ACBC aggregate: max |u−μ| = ${maxErr.toFixed(3)}, price ${price} per unit (truth ${truePrice.toFixed(4)})`);
});

test("ACBC hierarchical Bayes: population means, individual utilities and the price slope recovered; diagnostics valid", { timeout: 180_000 }, () => {
  const s = acbcStudy({ n: 300, het: 0.8 });
  const r = runAnalysis(A("hb", { burnIn: 3000, draws: 2000, seed: 4, timeBudgetMs: 600_000 }), s.ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const mean = r.tables.find((t) => t.id === "hb_mean")!;
  assert.ok(mean, `estimates withheld: ${r.warnings.join(" ")}`);
  let maxErr = 0;
  for (const a of ACBC_ATTRS) a.levels.forEach((l, k) => { const row = mean.rows.find((x) => x.attribute === a.name && x.level === l)!; maxErr = Math.max(maxErr, Math.abs((row.mean as number) - ACBC_MU[a.name][k])); assert.ok((row.rhat as number) < 1.1, `${a.name}=${l} R̂ ${row.rhat}`); });
  assert.ok(maxErr < 0.25, `max |μ̂ − μ| = ${maxErr.toFixed(3)}`);
  const ind = r.tables.find((t) => t.id === "hb_individual")!;
  const est: number[] = [], tru: number[] = [];
  ind.rows.forEach((row, i) => { let l = 0; for (const a of ACBC_ATTRS) a.levels.forEach((_, k) => { est.push(row[`u${l}`] as number); tru.push(s.truth[i].levels[a.name][k]); l++; }); });
  const rInd = corr(est, tru);
  assert.ok(rInd > 0.7, `r(individual) = ${rInd.toFixed(3)}`);
  const price = r.tables.find((t) => t.id === "acbc_price")!.rows.find((x) => x.m === "Population mean (per 1 unit)")!.v as number;
  const truePrice = s.truth.reduce((t, x) => t + x.price, 0) / s.truth.length;
  assert.ok(Math.abs(price - truePrice) / Math.abs(truePrice) < 0.15, `price ${price} vs ${truePrice}`);
  const diag = r.tables.find((t) => t.id === "hb_diagnostics")!;
  assert.match(String(diag.rows.find((x) => x.m === "Model")!.v), /ACBC: BYO \+ screening vs threshold/);
  const rlh = r.tables.find((t) => t.id === "hb_fit")!.rows.find((x) => String(x.m).startsWith("Root likelihood"))!.v as number;
  assert.ok(rlh > 0.5, `RLH ${rlh}`);
  console.log(`  ACBC HB: max |μ̂−μ| = ${maxErr.toFixed(3)}, r(individual) = ${rInd.toFixed(3)}, price ${price} (truth ${truePrice.toFixed(5)}), RLH ${rlh}`);
});
