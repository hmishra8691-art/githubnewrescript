import { test } from "node:test";
import assert from "node:assert/strict";
import { menuPlugin, priceValue, menuTaskItems, menuTotal } from "./menu.js";

/**
 * MENU-BASED CONJOINT — the generator.
 *
 * Every item on every task; price points frequency-balanced per item; no two
 * tasks in a version share a price vector; required items flagged; the
 * numeric price parsed for totals; validation refusing the designs that
 * cannot be estimated or cannot be fielded.
 */

const cfg = {
  items: [
    { name: "Base plan", levels: ["$10", "$15", "$20"] },
    { name: "Extra storage", levels: ["$2", "$4"] },
    { name: "Priority support", levels: ["$3", "$5", "$8"] },
    { name: "Family sharing", levels: ["free", "$2"] },
  ],
  requiredItems: ["Base plan"],
  tasks: 8,
  versions: 2,
};

test("priceValue parses what respondents will see", () => {
  assert.equal(priceValue("$4.99"), 4.99);
  assert.equal(priceValue("₹1,299"), 1299);
  assert.equal(priceValue("free"), 0);
  assert.equal(priceValue("Included"), 0);
  assert.equal(priceValue("12 €"), 12);
  assert.ok(Number.isNaN(priceValue("n/a")));
});

test("EVERY ITEM ON EVERY TASK, price points balanced, no repeated price vector within a version, deterministic", () => {
  const a = menuPlugin.generate(cfg, 7);
  const b = menuPlugin.generate(cfg, 7);
  assert.deepEqual(a.rows, b.rows, "same seed → same design");
  assert.deepEqual(a.columns, ["version", "task", "item", "item_label", "price", "price_index", "price_value", "required"]);
  assert.equal(a.rows.length, 2 * 8 * 4, "versions × tasks × items");
  for (let v = 1; v <= 2; v++) {
    const keys = new Set<string>();
    for (let t = 1; t <= 8; t++) {
      const items = menuTaskItems(a.rows, String(v), String(t));
      assert.equal(items.length, 4, "the whole menu, every task");
      assert.deepEqual(items.map((i) => i.label), ["Base plan", "Extra storage", "Priority support", "Family sharing"], "in menu order");
      keys.add(items.map((i) => i.price).join("|"));
    }
    assert.equal(keys.size, 8, `version ${v}: eight different price vectors`);
  }
  // balance: over 16 tasks, a 2-level item shows each price 8 times, a 3-level item 5 or 6 times
  const freq = (a.summary as any).priceFrequencies;
  assert.deepEqual(freq["Extra storage"], { "$2": 8, "$4": 8 });
  for (const n of Object.values(freq["Base plan"]) as number[]) assert.ok(n >= 5 && n <= 6, `3 levels over 16 tasks: ${n}`);
  // required flag, parsed prices
  const t1 = menuTaskItems(a.rows, "1", "1");
  assert.equal(t1[0].required, true);
  assert.equal(t1[1].required, false);
  assert.ok(t1.every((i) => Number.isFinite(i.priceValue)));
  assert.deepEqual((a.summary as any).requiredItems, ["Base plan"]);
  assert.equal((a.summary as any).currency, "$", "detected from the first symbolled price");

  const other = menuPlugin.generate(cfg, 8);
  assert.notDeepEqual(other.rows.map((r) => r.price), a.rows.map((r) => r.price), "a different seed → a different design");
});

test("menuTotal counts required items whether or not they were ticked", () => {
  const items = [
    { item: "1", label: "Base", price: "$10", priceValue: 10, required: true },
    { item: "2", label: "Add-on", price: "$4", priceValue: 4, required: false },
    { item: "3", label: "Other", price: "$3", priceValue: 3, required: false },
  ];
  assert.equal(menuTotal(items, []), 10);
  assert.equal(menuTotal(items, ["2"]), 14);
  assert.equal(menuTotal(items, ["1", "2", "3"]), 17);
});

test("VALIDATION refuses what cannot be estimated or fielded, in words", () => {
  const v = (c: any) => menuPlugin.validateConfig!(c);
  assert.match(v({ items: [{ name: "A", levels: ["$1", "$2"] }] })[0], /at least 2 items/);
  assert.match(v({ items: [{ name: "A", levels: ["$1"] }, { name: "B", levels: ["$1", "$2"] }] })[0], /needs at least 2 price points/);
  assert.match(v({ items: [{ name: "A", levels: ["cheap", "dear"] }, { name: "B", levels: ["$1", "$2"] }] })[0], /has no number in it/);
  assert.match(v({ items: [{ name: "A", levels: ["$1", "$2"] }, { name: "A", levels: ["$1", "$2"] }] })[0], /unique/);
  assert.match(v({ ...cfg, requiredItems: ["Nope"] })[0], /"Nope" is not on the menu/);
  assert.match(v({ items: cfg.items.slice(0, 2), requiredItems: ["Base plan", "Extra storage"] })[0], /nothing left to choose/);
  assert.match(v({ items: cfg.items.slice(0, 2), tasks: 10 })[0], /Only 6 distinct price combinations exist, but each version has 10 tasks/);
  assert.match(v({ ...cfg, minSelections: 3, maxSelections: 2 })[0], /Minimum items is above the maximum/);
  assert.deepEqual(v(cfg), []);
  assert.throws(() => menuPlugin.generate({ items: [] } as any, 1), /at least 2 items/, "generate refuses too");
});
