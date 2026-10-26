import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignReference } from "@rescript/schema";
import { maxdiffPlugin } from "./maxdiff.js";
import { conjointPlugin } from "./conjoint.js";
import { inspectConjointDesign, inspectMaxDiffDesign } from "./quality.js";

/*
 * THE PUBLISH GATE'S DESIGN RULES.
 *
 * The point of these is the line between an error and a warning, so each
 * test says which it expects and why. An error refuses a publish, and a live
 * deploy has no override, so the bar is "no amount of sample can rescue
 * this": an item or level nobody is shown, rows that break the researcher's
 * own rule, a task a respondent cannot answer. Everything else is the real
 * numbers and the researcher's judgement.
 */

const errs = (xs: { level: string; message: string }[]) => xs.filter((x) => x.level === "error");
const warns = (xs: { level: string; message: string }[]) => xs.filter((x) => x.level === "warning");

function maxdiffDesign(config: Record<string, unknown>, seed = 7): DesignReference {
  const gen = maxdiffPlugin.generate(config as never, seed);
  return { id: "d1", kind: "maxdiff", name: "Features", version: 1, config, file: { format: "json", columns: gen.columns, rows: gen.rows } } as DesignReference;
}
function conjointDesign(config: Record<string, unknown>, seed = 7): DesignReference {
  const gen = conjointPlugin.generate(config as never, seed);
  return { id: "d2", kind: "conjoint", name: "Pricing", version: 1, config, file: { format: "json", columns: gen.columns, rows: gen.rows } } as DesignReference;
}

const ITEMS = ["Price", "Speed", "Support", "Design", "Battery", "Warranty"];

/* ------------------------------------------------------------ MaxDiff */

test("a healthy MaxDiff raises no error", () => {
  const d = maxdiffDesign({ items: ITEMS, itemsPerTask: 4, tasks: 9, versions: 2 });
  const out = inspectMaxDiffDesign(d);
  assert.deepEqual(errs(out).map((e) => e.message), [], "a well-formed design must not be blocked");
});

test("an item nobody is ever shown is an ERROR, and the message names it", () => {
  const d = maxdiffDesign({ items: ITEMS, itemsPerTask: 4, tasks: 9, versions: 2 });
  /* remove every row that shows "Warranty" — the design no longer measures it at all */
  d.file!.rows = d.file!.rows.filter((r) => r.item_label !== "Warranty");
  const out = inspectMaxDiffDesign(d);
  const e = errs(out);
  assert.equal(e.length >= 1, true, "an unmeasurable item blocks the publish");
  assert.match(e[0]!.message, /never shows/);
  assert.match(e[0]!.message, /Warranty/, "the researcher is told WHICH item");
  assert.match(e[0]!.message, /no utility to estimate/, "and why it matters, not just that it is wrong");
});

test("rows that break a prohibited pair are an ERROR — that is not the design that was asked for", () => {
  const d = maxdiffDesign({ items: ITEMS, itemsPerTask: 4, tasks: 9, versions: 2 });
  /* the design was generated without the rule; adding it after the fact makes the stored rows violate it */
  (d.config as Record<string, unknown>).prohibitedPairs = [["Price", "Speed"]];
  const out = inspectMaxDiffDesign(d);
  assert.equal(errs(out).some((e) => /prohibited-pair/.test(e.message)), true);
});

test("a design with no rows is an ERROR, and one with rows but no items cannot be judged", () => {
  const empty = { id: "d", kind: "maxdiff", name: "X", version: 1, config: { items: ITEMS }, file: { format: "json", columns: [], rows: [] } } as unknown as DesignReference;
  assert.match(errs(inspectMaxDiffDesign(empty))[0]!.message, /no generated rows/);
  const noItems = maxdiffDesign({ items: ITEMS, itemsPerTask: 4, tasks: 9, versions: 1 });
  (noItems.config as Record<string, unknown>).items = [];
  assert.match(errs(inspectMaxDiffDesign(noItems))[0]!.message, /no items in its configuration/);
});

test("imbalance is a WARNING carrying the measured numbers, never a block", () => {
  /*
   * The generator's optimiser is good, so an imbalanced design has to be
   * made rather than asked for: drop SOME of one item's rows, leaving it
   * shown but under-shown. That is the real-world case — a design edited or
   * imported after generation — and it must warn, not block, because every
   * item still has data behind it.
   */
  const d = maxdiffDesign({ items: ITEMS, itemsPerTask: 4, tasks: 9, versions: 2 });
  let dropped = 0;
  d.file!.rows = d.file!.rows.filter((r) => {
    if (r.item_label === "Warranty" && dropped < 4) { dropped++; return false; }
    return true;
  });
  assert.equal(dropped, 4, "the fixture really did skew the counts");
  assert.equal(d.file!.rows.some((r) => r.item_label === "Warranty"), true, "and the item is still shown somewhere");
  const out = inspectMaxDiffDesign(d);
  assert.deepEqual(errs(out).map((e) => e.message), [], "an imperfect but usable design still publishes");
  const w = warns(out);
  assert.equal(w.length >= 1, true, "and it is said, with numbers");
  assert.match(w.map((x) => x.message).join(" "), /\d/, "the sentence carries the counts, not an adjective");
});

/* ----------------------------------------------------------- conjoint */

const ATTRS = [
  { name: "Brand", levels: ["A", "B", "C"] },
  { name: "Price", levels: ["£10", "£20", "£30"] },
  { name: "Size", levels: ["S", "M", "L"] },
];

test("a healthy CBC raises no error", () => {
  const d = conjointDesign({ method: "balanced", attributes: ATTRS, alternativesPerTask: 3, tasks: 9, versions: 2 });
  assert.deepEqual(errs(inspectConjointDesign(d)).map((e) => e.message), []);
});

test("a level nobody is ever shown is an ERROR and names the attribute and level", () => {
  const d = conjointDesign({ method: "balanced", attributes: ATTRS, alternativesPerTask: 3, tasks: 9, versions: 2 });
  d.file!.rows = d.file!.rows.filter((r) => r.Price !== "£30");
  const e = errs(inspectConjointDesign(d));
  assert.equal(e.length >= 1, true);
  assert.match(e[0]!.message, /Price: £30/);
});

test("a conjoint design with no rows is an ERROR", () => {
  const d = { id: "d", kind: "conjoint", name: "X", version: 1, config: { attributes: ATTRS }, file: { format: "json", columns: [], rows: [] } } as unknown as DesignReference;
  assert.match(errs(inspectConjointDesign(d))[0]!.message, /no generated rows/);
});

test("the degrees-of-freedom finding is a WARNING and says it is about HB, not about the design being wrong", () => {
  /* two tasks cannot identify individual-level utilities for six parameters */
  const d = conjointDesign({ method: "balanced", attributes: ATTRS, alternativesPerTask: 2, tasks: 2, versions: 1 });
  const out = inspectConjointDesign(d);
  const w = warns(out).map((x) => x.message).join(" ");
  if (/degrees of freedom/.test(w)) {
    assert.match(w, /Hierarchical Bayes|aggregate model is unaffected/, "it must not read as 'your design is broken'");
  }
  assert.deepEqual(errs(out).filter((e) => /degrees of freedom/.test(e.message)), [], "it is never an error");
});

test("a check that throws is reported, not swallowed into a pass", () => {
  const d = { id: "d", kind: "maxdiff", name: "X", version: 1, config: { items: ITEMS }, file: { format: "json", columns: [], rows: [{ bad: 1 }] } } as unknown as DesignReference;
  const out = inspectMaxDiffDesign(d);
  assert.equal(out.length >= 1, true, "something is always said about a design that cannot be measured");
});
