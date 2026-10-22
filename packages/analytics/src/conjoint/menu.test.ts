import { test } from "node:test";
import assert from "node:assert/strict";
import { menuStudy, MENU_TRUE, corr, spec } from "./fixture.js";
import { menuLayout, menuItems, simulateMenu, menuPriceCurve, menuTasks, fitMenuAggregate, selectCrossEffects } from "./menu.js";
import { runAnalysis } from "../analyses/index.js";

/**
 * MENU-BASED CONJOINT — recovery on a real menu design (a required base plan, four optional items,
 * an exclusive two-item support section, "buy nothing" offered), with KNOWN parameters on the
 * standardised price scale: a buy-anything logit, item logits with one planted cross-price effect
 * (Cloud is taken more when Music is dearer: +0.6), and the section's multinomial logit. Measured at
 * 800 respondents × 10 menus, heterogeneity 0.3: every item / section parameter within 0.08 of the
 * truth, the planted cross effect z = 14.9 and the only one kept of 24 tested.
 */
const M = (kind: "conjoint" | "hb", options: Record<string, unknown> = {}) => ({ name: kind, kind, dataset: spec, variables: ["MENU"], options });
const study = menuStudy({ n: 800, het: 0.3 });

test("menu aggregate model: item logits (own and cross price), the section MNL and the buy-anything logit recover the truth; the counts table is unchanged in place", () => {
  const r = runAnalysis(M("conjoint"), study.ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  assert.equal(r.tables[0].id, "menu_counts", "the counts keep their place");
  assert.match(r.tables[0].title, /counts, not a model/);
  const mm = r.tables.find((t) => t.id === "menu_model")!;
  const est = (model: string, parameter: string) => mm.rows.find((x) => x.model === model && x.parameter === parameter)!.estimate as number;
  const errs: [string, number][] = [];
  for (const [k, v] of Object.entries(MENU_TRUE.items)) {
    errs.push([`${k} constant`, est(`Item: ${k}`, "constant") - v.constant], [`${k} own`, est(`Item: ${k}`, "own price") - v.own]);
  }
  errs.push(["Cloud ← Music", est("Item: Cloud", "price of Music") - MENU_TRUE.items.Cloud.crossMusic!]);
  for (const [k, v] of Object.entries(MENU_TRUE.support)) errs.push([`${k} constant`, est("Section: Support", `${k} constant`) - v.constant], [`${k} own`, est("Section: Support", `${k} own price`) - v.own]);
  errs.push(["buy constant", est("Buy anything", "constant") - MENU_TRUE.buy.constant], ["buy base price", est("Buy anything", "price of Base plan") - MENU_TRUE.buy.base], ["buy optional prices", est("Buy anything", "optional prices (mean, standardised)") - 6 * MENU_TRUE.buy.other]);
  const worst = errs.reduce((b, e) => (Math.abs(e[1]) > Math.abs(b[1]) ? e : b));
  assert.ok(Math.abs(worst[1]) < 0.2, `worst: ${worst[0]} off by ${worst[1].toFixed(3)}`);
  // the planted cross effect is the one kept
  const kept = r.tables.find((t) => t.id === "menu_cross")!.rows.filter((x) => x.kept === "yes");
  assert.deepEqual(kept.map((x) => [x.item, x.of]), [["Cloud", "Music"]]);
  // per currency unit: Data's own price −1.0 on a half-range of $2 → −0.5 per $
  assert.ok(Math.abs((mm.rows.find((x) => x.model === "Item: Data" && x.parameter === "own price")!.perUnit as number) - est("Item: Data", "own price") / 2) < 1e-3);
  // observed vs predicted take rates agree in sample
  for (const row of r.tables.find((t) => t.id === "menu_fit")!.rows) assert.ok(Math.abs((row.observed as number) - (row.predicted as number)) < 1.5, JSON.stringify(row));
  assert.ok(!r.warnings.some((w) => /no choice model is estimated/.test(w)));
  console.log(`  menu aggregate: worst parameter ${worst[0]} off by ${worst[1].toFixed(3)}; cross effect kept: Cloud ← Music`);
});

test("menu simulator: take rates fall with own price, rise with a substitute's price; a bundle below its à-la-carte total is taken more than at full price; price curves", () => {
  const data = menuTasks(study.ds, "q_menu")!;
  const tasks = data.respondents.flatMap((r) => r.tasks);
  const L = menuLayout(menuItems(study.design.rows), true, { "3": ["4"] });
  const fit = fitMenuAggregate(L, tasks);
  const B = [{ id: "agg", beta: fit.beta }];
  const take = (prices: Record<string, string>) => simulateMenu(L, B, { prices }).items;
  const lo = take({ Data: "$2" }).find((i) => i.label === "Data")!.take, hi = take({ Data: "$6" }).find((i) => i.label === "Data")!.take;
  assert.ok(lo > hi + 0.15, `Data take ${lo} at $2 vs ${hi} at $6`);
  const cloudCheapMusic = take({ Music: "$4" }).find((i) => i.label === "Cloud")!.take, cloudDearMusic = take({ Music: "$8" }).find((i) => i.label === "Cloud")!.take;
  assert.ok(cloudDearMusic > cloudCheapMusic + 0.05, "Cloud gains when Music is dearer (substitutes)");
  const bundle = (price: string) => simulateMenu(L, B, { bundles: [{ name: "Trio", items: ["Cloud", "Music", "Insurance"], price }] }, { draws: 8000 }).bundles[0];
  const cheap = bundle("$10"), full = bundle("$14");
  assert.equal(full.listPrice, 14, "the middle prices: Cloud $5 + Music $6 + Insurance $3");
  assert.ok(cheap.take > full.take + 0.03, `bundle at $10: ${cheap.take}, at $14: ${full.take}`);
  const curve = menuPriceCurve(L, B, {}, "Data")!;
  assert.equal(curve.rows.length, 7);
  for (let k = 1; k < curve.rows.length; k++) assert.ok(curve.rows[k].take <= curve.rows[k - 1].take + 1e-12);
  assert.ok(curve.bestItemPrice >= 2 && curve.bestItemPrice <= 6);
  // cross effects: none / list / auto
  assert.deepEqual(selectCrossEffects(L.items, tasks, true, "none", "linear").cross, {});
  assert.deepEqual(selectCrossEffects(L.items, tasks, true, [["Cloud", "Music"]], "linear").cross, { "3": ["4"] });
});

test("menu scenarios in the analysis: a saved / asked-for scenario with a bundle; part-worth price coding", () => {
  const r = runAnalysis(M("conjoint", { menuScenario: { name: "Premium at $12", prices: { Data: "$4" }, bundles: [{ name: "Premium", items: ["Cloud", "Music", "Insurance"], price: "$12" }] } }), study.ds);
  const sim = r.tables.find((t) => t.id === "menu_sim")!;
  assert.match(sim.title, /Premium at \$12/);
  assert.equal(sim.rows.find((x) => x.item === "Data")!.price, 4);
  const b = r.tables.find((t) => t.id === "menu_sim_bundles")!;
  assert.ok(b.notes!.some((n) => /ASSUMPTION/.test(n)));
  assert.ok((b.rows[0].take as number) > 0);
  const pw = runAnalysis(M("conjoint", { menuPriceCoding: "partworth" }), study.ds);
  assert.ok(pw.tables.find((t) => t.id === "menu_model")!.rows.some((x) => /price \$6 \(vs \$2\)/.test(String(x.parameter))));
});

test("menu hierarchical Bayes: converges and recovers item-level heterogeneity", { timeout: 240_000 }, () => {
  const s = menuStudy({ n: 250, het: 0.8, tasks: 12, seed: 23 });
  const r = runAnalysis(M("hb", { burnIn: 5000, draws: 3000, seed: 3, timeBudgetMs: 900_000, crossEffects: [["Cloud", "Music"]] }), s.ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const mean = r.tables.find((t) => t.id === "hb_mean")!;
  assert.ok(mean, `estimates withheld: ${r.warnings.join(" ")}`);
  for (const row of mean.rows) assert.ok((row.rhat as number) < 1.1, `${row.model} ${row.parameter} R̂ ${row.rhat}`);
  const m = (model: string, p: string) => mean.rows.find((x) => x.model === model && x.parameter === p)!.mean as number;
  for (const [k, v] of Object.entries(MENU_TRUE.items)) {
    assert.ok(Math.abs(m(`Item: ${k}`, "constant") - v.constant) < 0.3, `${k} constant ${m(`Item: ${k}`, "constant")}`);
    assert.ok(Math.abs(m(`Item: ${k}`, "own price") - v.own) < 0.3, `${k} own ${m(`Item: ${k}`, "own price")}`);
  }
  const ind = r.tables.find((t) => t.id === "hb_individual")!;
  const names = ind.columns.slice(2).map((c) => c.label);
  const est: number[] = [], tru: number[] = [];
  ind.rows.forEach((row, i) => { for (const it of Object.keys(MENU_TRUE.items)) { est.push(row[`u${names.indexOf(`${it}: constant`)}`] as number); tru.push(s.truth[i].items[it].constant); } });
  const rInd = corr(est, tru);
  assert.ok(rInd > 0.5, `r(individual item constants) = ${rInd.toFixed(3)}`);
  assert.ok(r.tables.some((t) => t.id === "menu_sim"), "the menu simulator on individual utilities");
  console.log(`  menu HB: r(individual item constants) = ${rInd.toFixed(3)}`);
});
