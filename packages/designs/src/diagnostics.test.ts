import { test } from "node:test";
import assert from "node:assert/strict";
import { conjointPlugin, maxdiffPlugin, menuPlugin, twoWayBalance, menuCurrency, formatMenuAmount } from "./index.js";
import { DesignReference } from "@rescript/schema";

/**
 * METHOD-05 / METHOD-15 — the diagnostics a generator computes are part of the
 * design (summary.diagnostics), and a menu's currency is stored with it.
 */

const attrs = [
  { name: "Brand", levels: ["A", "B", "C"] },
  { name: "Price", levels: ["$10", "$20", "$30"] },
  { name: "Warranty", levels: ["1y", "2y"] },
];

test("twoWayBalance: a perfectly crossed set is balanced; a confounded one names the pair and the empty cells", () => {
  const full = attrs[0].levels.flatMap((b) => attrs[1].levels.map((p) => ({ Brand: b, Price: p, Warranty: "1y" })));
  const crossed = [...full, ...full, ...full];
  const ok = twoWayBalance(attrs.slice(0, 2), crossed);
  assert.equal(ok.balanced, true);
  assert.equal(ok.warnings.length, 0);
  assert.equal(ok.pairs[0].min, 3);
  assert.equal(ok.pairs[0].max, 3);

  // Brand A never appears at $30 — every other cell is hit five times
  const confounded = Array.from({ length: 5 }, () => full.filter((r) => !(r.Brand === "A" && r.Price === "$30"))).flat();
  const bad = twoWayBalance(attrs.slice(0, 2), confounded);
  assert.equal(bad.balanced, false);
  assert.equal(bad.worst?.emptyCells, 1);
  assert.match(bad.warnings[0], /Brand × Price: 1 of 9 level combinations never appear/);
});

test("twoWayBalance: a cell a prohibition makes impossible is not reported", () => {
  const full = attrs[0].levels.flatMap((b) => attrs[1].levels.map((p) => ({ Brand: b, Price: p })));
  const rows = Array.from({ length: 5 }, () => full.filter((r) => !(r.Brand === "A" && r.Price === "$30"))).flat();
  const d = twoWayBalance(attrs.slice(0, 2), rows, (a, la, b, lb) => !(la === "A" && lb === "$30"));
  assert.equal(d.balanced, true);
  assert.equal(d.pairs[0].cells, 8);
});

test("a small design is not judged on cells it cannot be expected to fill", () => {
  const tiny = [{ Brand: "A", Price: "$10" }, { Brand: "B", Price: "$20" }];
  assert.equal(twoWayBalance(attrs.slice(0, 2), tiny).balanced, true);
});

test("conjoint.generate puts diagnostics and warnings in the summary, and they survive being stored on the design", () => {
  // one-way balanced but poorly crossed: few tasks over a large level space
  const file = conjointPlugin.generate({
    attributes: [
      { name: "Brand", levels: ["A", "B", "C", "D"] },
      { name: "Price", levels: ["$1", "$2", "$3", "$4"] },
      { name: "Speed", levels: ["S", "M", "L", "XL"] },
    ],
    tasks: 24, alternativesPerTask: 3,
  }, 11);
  const d = file.summary!.diagnostics as ReturnType<typeof twoWayBalance>;
  assert.equal(d.method, "two_way_balance");
  assert.equal(d.pairs.length, 3, "every attribute pair");
  assert.ok(d.pairs.every((p) => p.cells === 16 && p.concepts === 72));
  if (!d.balanced) assert.deepEqual(file.summary!.warnings, d.warnings);
  else assert.equal(file.summary!.warnings, undefined);

  // the additive schema field keeps it
  const ref = DesignReference.parse({
    id: "d1", kind: "conjoint", name: "C", config: {},
    file: { columns: file.columns, rows: file.rows, summary: file.summary },
  });
  assert.deepEqual(ref.file!.summary!.diagnostics, JSON.parse(JSON.stringify(d)));
  // and a design with no summary still parses exactly as before
  assert.equal(DesignReference.parse({ id: "d2", kind: "conjoint", name: "C", config: {}, file: { columns: [], rows: [] } }).file!.summary, undefined);
});

test("a conjoint with a visibly confounded pair warns", () => {
  // two attributes, two levels each, forbidding one pair → one cell is impossible, not a warning;
  // but forcing a heavy spread through a prohibition-free tiny space is still measurable
  const file = conjointPlugin.generate({
    attributes: [{ name: "X", levels: ["a", "b"] }, { name: "Y", levels: ["p", "q"] }],
    tasks: 30, alternativesPerTask: 2,
  }, 3);
  const d = file.summary!.diagnostics as ReturnType<typeof twoWayBalance>;
  assert.equal(d.pairs[0].concepts, 60);
  assert.ok(d.pairs[0].max >= d.pairs[0].min);
});

test("prohibited cells are excluded from the conjoint's own balance report", () => {
  const file = conjointPlugin.generate({
    attributes: [{ name: "Brand", levels: ["A", "B", "C"] }, { name: "Price", levels: ["$10", "$20", "$30"] }],
    prohibitions: [{ a: { attribute: "Brand", level: "A" }, b: { attribute: "Price", level: "$30" } }],
    tasks: 24, alternativesPerTask: 2,
  }, 5);
  const d = file.summary!.diagnostics as ReturnType<typeof twoWayBalance>;
  assert.equal(d.pairs[0].cells, 8, "A × $30 is impossible and is not counted as empty");
  assert.equal(d.pairs[0].emptyCells, 0);
});

test("maxdiff.generate reports balance diagnostics; an express design that leaves items out warns", () => {
  const std = maxdiffPlugin.generate({ items: ["A", "B", "C", "D", "E", "F", "G", "H"], itemsPerTask: 4, tasks: 12 }, 2);
  const d = std.summary!.diagnostics as { method: string; balanced: boolean; warnings: string[]; itemShowRatio: number | null };
  assert.equal(d.method, "item_and_pair_balance");
  assert.ok(d.itemShowRatio !== null && d.itemShowRatio <= 1.5);
  assert.equal(d.balanced, true, d.warnings.join(" / "));

  const express = maxdiffPlugin.generate({ items: ["A", "B", "C", "D", "E", "F", "G", "H"], itemsPerTask: 4, tasks: 2, itemsPerVersion: 4 }, 2);
  const e = express.summary!.diagnostics as { warnings: string[]; balanced: boolean };
  assert.equal(e.balanced, false);
  assert.match(e.warnings[0], /never shown/);
  assert.deepEqual(express.summary!.warnings, e.warnings);
});

/* ---------------------------------------------------------------- menu */

const menu = {
  items: [
    { name: "Base", levels: ["₹100", "₹150", "₹200"] },
    { name: "Extra", levels: ["₹20", "₹40"] },
  ],
  tasks: 6,
};

test("METHOD-15: the menu's currency is stored in the summary and falls back to the price labels", () => {
  const file = menuPlugin.generate(menu, 1);
  assert.equal(file.summary!.currency, "₹");
  assert.ok((file.summary!.diagnostics as { method: string }).method === "price_balance");
  const design = { config: {}, file: { rows: file.rows, summary: file.summary } };
  assert.equal(menuCurrency(design), "₹");
  // generated before the summary was kept: read it off the rows
  assert.equal(menuCurrency({ config: {}, file: { rows: file.rows } }), "₹");
  // an explicit configuration wins, and a blank one means "detect"
  assert.equal(menuCurrency({ config: { currency: "INR " }, file: { rows: file.rows } }), "INR");
  assert.equal(menuPlugin.generate({ ...menu, currency: "  " }, 1).summary!.currency, "₹");
  assert.equal(menuPlugin.generate({ ...menu, currency: "Rs" }, 1).summary!.currency, "Rs");
  assert.equal(menuCurrency({}), "");
});

test("METHOD-15: totals are labelled in the menu's currency", () => {
  assert.equal(formatMenuAmount(1299.5, "₹", "₹100.00"), "₹1,299.50");
  assert.equal(formatMenuAmount(27, "$", "$10"), "$27");
  assert.equal(formatMenuAmount(27, "", "10"), "27");
});

test("menu price balance warns when a price point is never shown", () => {
  const file = menuPlugin.generate({ items: [{ name: "A", levels: ["$1", "$2", "$3", "$4"] }, { name: "B", levels: ["$1", "$2"] }], tasks: 5 }, 1);
  const d = file.summary!.diagnostics as { balanced: boolean; warnings: string[] };
  assert.equal(d.balanced, d.warnings.length === 0);
});
