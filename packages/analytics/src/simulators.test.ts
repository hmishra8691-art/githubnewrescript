import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { mulberry32 } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { kds } from "./analyses/knownFixture.js";
import { maxdiffShares, turfPortfolio, priceWhatIf, type MaxdiffShareResult, type PortfolioResult, type PriceWhatIf } from "./simulators.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };

/* ---- a MaxDiff with known utilities (as in maxdiffOptOut.test) */
const ITEMS = ["Reliability", "Price", "Colour", "Packaging", "Advert", "Slogan"];
const TRUE_U = [1.4, 0.7, -0.6, -0.9, -1.3, -1.8];
const SETS = [[1, 2, 3, 4], [1, 2, 5, 6], [3, 4, 5, 6], [1, 3, 4, 5], [2, 3, 4, 6], [1, 2, 4, 5]];
const mdDef = SurveyDefinition.parse({
  meta: { id: "md", code: "MD", title: "MaxDiff", version: "1.0" },
  designs: [{ id: "d", kind: "maxdiff", name: "MD", config: { items: ITEMS, itemsPerTask: 4 }, file: { format: "json", columns: ["version", "task", "position", "item_index", "item_label"], rows: SETS.flatMap((set, t) => set.map((i, p) => ({ version: 1, task: t + 1, position: p + 1, item_index: i, item_label: ITEMS[i - 1] }))) } }],
  questions: [{ id: "q", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q"] }],
});
function maxdiffResult() {
  const r = mulberry32(7);
  const g = () => -Math.log(-Math.log(Math.max(r(), 1e-9)));
  const rows = Array.from({ length: 300 }, (_, i) => {
    const ans: Record<string, unknown> = {};
    SETS.forEach((set, t) => {
      const u = set.map((x) => TRUE_U[x - 1]! + g());
      const bi = u.indexOf(Math.max(...u));
      const rest = set.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -TRUE_U[set[k]! - 1]! + g());
      ans[String(t + 1)] = { best: String(set[bi]), worst: String(set[rest[uw.indexOf(Math.max(...uw))]!]) };
    });
    return { id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, answers: { q: ans }, calculated: {}, embedded: {}, flags: [] } as AnalyticsRow;
  });
  return runAnalysis({ name: "maxdiff", kind: "maxdiff", dataset: spec, variables: ["MD"] }, buildDataset(mdDef, rows, { spec }));
}

test("MaxDiff shares: every item reproduces the result's own shares; a subset re-normalises in utility order", () => {
  const res = maxdiffResult();
  const own = new Map(res.tables.find((t) => t.id === "maxdiff")!.rows.map((r) => [String(r.item), r.share as number]));
  const all = maxdiffShares(res, []) as MaxdiffShareResult;
  for (const it of all.items) assert.ok(Math.abs(it.share - own.get(it.item)!) <= 0.11, `${it.item}: ${it.share} vs ${own.get(it.item)}`);
  const sub = maxdiffShares(res, ["Colour", "Reliability", "Slogan", "Unicorn"]) as MaxdiffShareResult;
  assert.deepEqual(sub.items.map((x) => x.item), ["Reliability", "Colour", "Slogan"]);
  assert.ok(Math.abs(sub.items.reduce((a, x) => a + x.share, 0) - 100) < 0.2);
  assert.deepEqual(sub.unknown, ["Unicorn"]);
  assert.ok(sub.notes.some((n) => /IIA/.test(n.text)));
  assert.ok(sub.notes.some((n) => /sets of 4 items/.test(n.text)), "the set size is read back from the result");
  const lg = maxdiffShares(res, ["Reliability", "Slogan"], { rule: "logit" }) as MaxdiffShareResult;
  const du = lg.items[0]!.utility - lg.items[1]!.utility;
  assert.ok(Math.abs(lg.items[0]!.share - 100 / (1 + Math.exp(-du))) < 0.06, "logit: e^u / Σe^u");
  assert.ok("error" in maxdiffShares(res, ["Colour"]), "one item is not a choice");
});

test("TURF portfolio: reach equals TURF's own, unique reach and gains add up, the best swap improves reach", () => {
  const ds = kds();
  const turf = runAnalysis({ name: "t", kind: "turf", dataset: spec, variables: ["AWARE"] }, ds);
  const single = new Map(turf.tables.find((t) => t.id === "single")!.rows.map((r) => [String(r.item), r.reach as number]));
  const p = turfPortfolio(ds, ["AWARE"], ["Alpha"]) as PortfolioResult;
  assert.equal(p.reach, single.get("Alpha"));
  const best2 = turf.tables.find((t) => t.id === "turf")!.rows.find((r) => r.size === 2)!;
  const top = p.add[0]!;
  assert.equal(top.reach, best2.reach, "Alpha plus the best addition reaches what TURF's best pair does when Alpha is in it");
  const two = turfPortfolio(ds, ["AWARE"], ["Alpha", top.item]) as PortfolioResult;
  assert.equal(two.reach, top.reach);
  assert.equal(two.items.find((x) => x.item === top.item)!.unique, top.gain, "what an item adds on its own = what removing it loses");
  const weak = turfPortfolio(ds, ["AWARE"], ["Gamma"]) as PortfolioResult;
  if (weak.bestSwap) assert.ok(weak.bestSwap.reach > weak.reach);
  assert.deepEqual((turfPortfolio(ds, ["AWARE"], ["Alpha", "Zeta"]) as PortfolioResult).unknown, ["Zeta"]);
});

test("price what-if: interpolates between tested prices, exact at a tested one, refuses outside the range", () => {
  const ldef = SurveyDefinition.parse({ meta: { id: "l", code: "L", title: "L", version: "1.0" }, questions: [{ id: "q_l", code: "PRICE_LADDER", variableName: "PRICE_LADDER", type: "numeric", variant: "numeric.price_ladder", text: "x", settings: { minValue: 0, maxValue: 25, priceLadder: { prices: [10, 15, 20, 25] } } }], flow: [] });
  const rows = [25, 20, 15, 15, 10, 0, null, 20].map((v, i) => ({ id: `r${i}`, session_id: `s${i}`, status: "complete", answers: v == null ? {} : { q_l: v }, calculated: {}, embedded: {}, flags: [] }) as AnalyticsRow);
  const res = runAnalysis({ name: "gg", kind: "pricing", dataset: spec, variables: ["PRICE_LADDER"], options: { method: "gabor_granger", ladder: true, prices: [10, 15, 20, 25] } }, buildDataset(ldef, rows, { spec }));
  const at15 = priceWhatIf(res, 15) as PriceWhatIf;
  assert.equal(at15.demand!.wouldBuy, 71.4);
  const mid = priceWhatIf(res, 12.5, { marketSize: 10000 }) as PriceWhatIf;
  assert.deepEqual(mid.demand!.between, [10, 15]);
  assert.equal(mid.demand!.wouldBuy, 78.6, "halfway between 85.71 and 71.43");
  assert.equal(mid.demand!.buyers, 7855, "from the table's displayed 85.7 and 71.4");
  const out = priceWhatIf(res, 40) as PriceWhatIf;
  assert.equal(out.demand, undefined);
  assert.ok(out.notes.some((n) => /outside the tested prices \(10–25\)/.test(n.text)));
  assert.ok("error" in priceWhatIf(maxdiffResult(), 10), "not a pricing result");
});

test("price what-if on Van Westendorp: the curves at the price and where it sits in the acceptable range", () => {
  const def = SurveyDefinition.parse({ meta: { id: "p", code: "P", title: "P", version: "1.0" }, questions: ["TC", "C", "E", "TE"].map((v) => ({ id: `q_${v}`, code: v, variableName: v, type: "numeric", text: v })), flow: [] });
  const r = mulberry32(3);
  const rows = Array.from({ length: 200 }, (_, i) => { const b = 8 + r() * 8; return { id: `r${i}`, session_id: `s${i}`, status: "complete", answers: { q_TC: b * 0.5, q_C: b * 0.8, q_E: b * 1.2, q_TE: b * 1.6 }, calculated: {}, embedded: {}, flags: [] } as AnalyticsRow; });
  const res = runAnalysis({ name: "vw", kind: "pricing", dataset: spec, variables: ["TC", "C", "E", "TE"] }, buildDataset(def, rows, { spec }));
  const vw = Object.fromEntries(res.tables.find((t) => t.id === "vw")!.rows.map((x) => [String(x.m), x.v as number]));
  const pmc = Object.entries(vw).find(([k]) => /PMC/.test(k))![1], pme = Object.entries(vw).find(([k]) => /PME/.test(k))![1];
  const inside = priceWhatIf(res, (pmc + pme) / 2) as PriceWhatIf;
  assert.equal(inside.vanWestendorp!.inRange, "inside the acceptable range");
  assert.ok(Math.abs(inside.vanWestendorp!.acceptable + inside.vanWestendorp!.tooCheap + inside.vanWestendorp!.tooExpensive - 100) < 0.2);
  assert.equal((priceWhatIf(res, pme * 1.3) as PriceWhatIf).vanWestendorp!.inRange, "above the acceptable range");
});
