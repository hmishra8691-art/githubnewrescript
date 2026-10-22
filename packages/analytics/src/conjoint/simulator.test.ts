import { test } from "node:test";
import assert from "node:assert/strict";
import { demandCurve, interpolate, optimiseProduct, sensitivity, simulateShares, willingnessToPay, type UtilityModel } from "./simulator.js";
import { simulatorTables } from "./simulatorTables.js";

/**
 * THE MARKET SIMULATOR — every rule and tool checked against arithmetic done by hand.
 */
const attrs = [
  { name: "Brand", levels: ["A", "B"] },
  { name: "Speed", levels: ["Slow", "Fast"] },
  { name: "Price", levels: ["$100", "$200", "$300"], values: [100, 200, 300] },
];
/** price utility falls 1 per $100: +1, 0, −1 */
const one = (levels: Record<string, number[]>, none?: number, id = "r"): UtilityModel["respondents"][number] => ({ id, levels, ...(none != null ? { none } : {}) });
const base = { Brand: [0.5, -0.5], Speed: [-0.4, 0.4], Price: [1, 0, -1] };
const M = (respondents = [one(base, -0.5)]): UtilityModel => ({ kind: "choice", source: "test", attributes: attrs, priceAttribute: "Price", respondents });
const P = (name: string, b: string, s: string, price?: number, cost?: number) => ({ name, levels: { Brand: b, Speed: s, ...(price == null ? { Price: "$200" } : {}) }, ...(price != null ? { price } : {}), ...(cost != null ? { cost } : {}) });

test("logit, first choice and None: the shares are the formulas", () => {
  const m = M();
  const r = simulateShares(m, [P("x", "A", "Fast"), P("y", "B", "Slow")]);
  const u = [0.5 + 0.4 + 0, -0.5 - 0.4 + 0, -0.5];
  const e = u.map(Math.exp), Z = e.reduce((t, v) => t + v, 0);
  assert.ok(Math.abs(r.products[0].share - e[0] / Z) < 1e-12 && Math.abs(r.none! - e[2] / Z) < 1e-12);
  const fc = simulateShares(m, [P("x", "A", "Fast"), P("y", "B", "Slow")], { rule: "first_choice" });
  assert.deepEqual([fc.products[0].share, fc.products[1].share, fc.none], [1, 0, 0]);
  const noNone = simulateShares(m, [P("x", "A", "Fast")], { none: false });
  assert.equal(noNone.none, null);
  assert.equal(noNone.products[0].share, 1);
});

test("prices interpolate between tested levels (and are flagged outside them); revenue and profit", () => {
  assert.deepEqual(interpolate([100, 200, 300], [1, 0, -1], 150), { u: 0.5, extrapolated: false });
  assert.ok(interpolate([100, 200, 300], [1, 0, -1], 350).extrapolated);
  const r = simulateShares(M(), [P("x", "A", "Fast", 150, 60), P("y", "B", "Fast", 250)], { marketSize: 1000 });
  const u = [0.5 + 0.4 + 0.5, -0.5 + 0.4 - 0.5, -0.5];
  const e = u.map(Math.exp), Z = e.reduce((t, v) => t + v, 0);
  assert.ok(Math.abs(r.products[0].share - e[0] / Z) < 1e-12);
  assert.ok(Math.abs(r.products[0].revenue! - (e[0] / Z) * 150 * 1000) < 1e-6);
  assert.ok(Math.abs(r.products[0].profit! - (e[0] / Z) * 90 * 1000) < 1e-6);
  assert.equal(r.products[1].profit, null, "no cost → no profit");
  const out = simulateShares(M(), [P("x", "A", "Fast", 400)]);
  assert.ok(out.products[0].extrapolated);
});

test("randomized first choice: with no attribute error it converges on the logit; attribute error relieves IIA for a near-duplicate", () => {
  const m = M();
  const prods = [P("x", "A", "Fast"), P("y", "B", "Slow")];
  const logit = simulateShares(m, prods, { none: false });
  const rfc = simulateShares(m, prods, { none: false, rule: "rfc", rfc: { draws: 20000, attributeSd: 0, seed: 3 } });
  assert.ok(Math.abs(rfc.products[0].share - logit.products[0].share) < 0.015, `${rfc.products[0].share} vs ${logit.products[0].share}`);
  // add a near-copy of y (same levels): logit gives the pair 2× y's odds (IIA); RFC with shared attribute error gives them less
  // adding a near-copy of y: under the logit (IIA) x loses share as if y2 were a new product; under RFC the copy shares
  // y's attribute errors, so it mostly splits y's share and x loses much less
  const dup = [...prods, { ...P("y2", "B", "Slow") }];
  const opts = { none: false, rule: "rfc" as const, rfc: { draws: 20000, attributeSd: 1.5, productScale: 0.3, seed: 3 } };
  const logitLoss = logit.products[0].share - simulateShares(m, dup, { none: false }).products[0].share;
  const rfcLoss = simulateShares(m, prods, opts).products[0].share - simulateShares(m, dup, opts).products[0].share;
  assert.ok(rfcLoss < logitLoss / 2, `x loses ${rfcLoss.toFixed(3)} under RFC vs ${logitLoss.toFixed(3)} under the logit`);
  // deterministic: same seed, same shares
  assert.deepEqual(simulateShares(m, dup, { rule: "rfc", rfc: { seed: 9 } }), simulateShares(m, dup, { rule: "rfc", rfc: { seed: 9 } }));
});

test("WTP: the market WTP equals Δu ÷ price slope for one logit respondent; demand falls with price; sensitivity; segments", () => {
  const m = M();
  const prods = [P("x", "A", "Slow", 200), P("y", "B", "Fast", 200)];
  const w = willingnessToPay(m, prods, 0, "Speed", "Fast")!;
  // Slow → Fast adds 0.8 utility; price slope −0.01 per $ → $80
  assert.ok(Math.abs(w.marketWtp! - 80) < 0.01, `${w.marketWtp}`);
  assert.ok(Math.abs(w.utilityWtpMedian! - 80) < 1e-6);
  const d = demandCurve(m, prods, 0, { points: 5 })!;
  assert.deepEqual(d.rows.map((r) => r.price), [100, 150, 200, 250, 300]);
  for (let k = 1; k < d.rows.length; k++) { assert.ok(d.rows[k].share < d.rows[k - 1].share); assert.ok(d.rows[k].elasticity! < 0); }
  const s = sensitivity(m, prods, 0);
  assert.ok(s.rows.find((r) => r.attribute === "Speed" && r.level === "Fast")!.delta > 0);
  assert.ok(s.rows.find((r) => r.attribute === "Speed" && r.level === "Slow")!.current);
  // two segments with opposite brand tastes
  const two = M([one({ ...base, Brand: [2, -2] }, -5, "a"), one({ ...base, Brand: [-2, 2] }, -5, "b")]);
  const seg = simulateShares(two, prods, { segments: new Map([["a", "North"], ["b", "South"]]) });
  assert.equal(seg.bySegment.length, 2);
  assert.ok(seg.bySegment[0].shares[0] > 0.7 && seg.bySegment[1].shares[0] < 0.3);
});

test("optimisation: exhaustive search finds the configuration a hand calculation picks; prohibitions respected; revenue trades share for price", () => {
  const m = M();
  const prods = [P("x", "B", "Slow", 200), P("y", "A", "Fast", 200)];
  const best = optimiseProduct(m, prods, 0, { objective: "share" });
  assert.ok(best.exhaustive);
  assert.deepEqual(best.best!.levels, { Brand: "A", Speed: "Fast" });
  assert.equal(best.best!.price, 200, "for share the price is held, not driven to the cheapest");
  const legal = optimiseProduct(m, prods, 0, { objective: "share", isLegal: (l) => !(l.Brand === "A" && l.Speed === "Fast") });
  assert.deepEqual(legal.best!.levels, { Brand: "A", Speed: "Slow" });
  const rev = optimiseProduct(m, prods, 0, { objective: "revenue" });
  assert.ok(rev.best!.price != null);
  const fixed = optimiseProduct(m, prods, 0, { objective: "share", fixed: ["Brand"] });
  assert.equal(fixed.best!.levels.Brand, "B");
});

test("the simulator's tables carry their assumptions", () => {
  const m = M();
  const t = simulatorTables(m, { products: [P("x", "A", "Fast", 200, 50), P("y", "B", "Slow", 200)], demand: true, sensitivity: true, wtp: [{ attribute: "Speed", level: "Fast", product: "y" }], optimize: { objective: "profit" } }, null);
  assert.deepEqual(t.tables.map((x) => x.id), ["sim_shares", "sim_demand", "sim_sensitivity", "sim_wtp", "sim_optimise"]);
  assert.ok(t.tables[0].notes!.some((n) => /not market shares/.test(n)));
  assert.ok(t.tables.find((x) => x.id === "sim_wtp")!.notes!.some((n) => /overstates/.test(n)));
  assert.ok(t.tables[0].columns.some((c) => c.key === "profit"));
});
