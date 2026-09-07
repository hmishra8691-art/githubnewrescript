import { test } from "node:test";
import assert from "node:assert/strict";
import { maxdiffPlugin, DEFAULT_ANCHOR_PROMPT, type MaxDiffConfig } from "./maxdiff.js";

/**
 * MAXDIFF BEYOND STANDARD (§17).
 *
 * The audit's line was "MaxDiff standard-only". Two variants close it, and
 * the first thing these tests protect is the thing a new option most easily
 * breaks: an existing design must regenerate to exactly the rows it produced
 * before, or every study in the field with a stored design becomes suspect.
 */

const ITEMS = [
  "Battery life", "Camera", "Screen size", "Price", "Brand", "Storage",
  "Waterproof", "Weight", "Colour choice", "Warranty",
];

const gen = (cfg: Partial<MaxDiffConfig>, seed = 2026) =>
  maxdiffPlugin.generate({ items: ITEMS, ...cfg } as MaxDiffConfig, seed);
const errs = (cfg: Partial<MaxDiffConfig>) =>
  maxdiffPlugin.validateConfig!({ items: ITEMS, ...cfg } as MaxDiffConfig);

/* ================================================ the regression guard */

test("A STANDARD DESIGN IS UNCHANGED — the new options are inert until asked for", () => {
  const plain = gen({ tasks: 8, versions: 2 });
  const withDefaults = gen({ tasks: 8, versions: 2, anchored: false });
  assert.deepEqual(withDefaults.rows, plain.rows);
  assert.deepEqual(withDefaults.columns, plain.columns);
});

test("a subset as big as the list is not a subset, and cannot perturb the design", () => {
  // itemsPerVersion is normalised away when it changes nothing, so a stray
  // value cannot send a standard design down the express code path
  const plain = gen({ tasks: 8, versions: 2 });
  const noop = gen({ tasks: 8, versions: 2, itemsPerVersion: ITEMS.length });
  assert.deepEqual(noop.rows, plain.rows);
  assert.equal(noop.summary!.itemsPerVersion, undefined);
});

test("generation stays deterministic given (config, seed)", () => {
  assert.deepEqual(gen({ tasks: 6, anchored: true }).rows, gen({ tasks: 6, anchored: true }).rows);
  assert.notDeepEqual(gen({ tasks: 6 }, 1).rows, gen({ tasks: 6 }, 2).rows);
});

/* ====================================================== anchored MaxDiff */

test("anchoring changes no design row — it is a question asked alongside the task", () => {
  const plain = gen({ tasks: 8 });
  const anchored = gen({ tasks: 8, anchored: true });
  assert.deepEqual(anchored.rows, plain.rows,
    "the anchor is a follow-up, not an extra item, so the sets are identical");
});

test("an anchored design says so in its summary, with the wording that will be asked", () => {
  const a = gen({ tasks: 8, anchored: true });
  assert.equal(a.summary!.anchored, true);
  assert.equal(a.summary!.anchorPrompt, DEFAULT_ANCHOR_PROMPT);
  /* and a standard design does not carry the keys at all */
  assert.equal(gen({ tasks: 8 }).summary!.anchored, undefined);
  assert.equal(gen({ tasks: 8 }).summary!.anchorPrompt, undefined);
});

test("a custom anchor prompt is kept verbatim", () => {
  const a = gen({ tasks: 8, anchored: true, anchorPrompt: "  How many of these would you pay extra for?  " });
  assert.equal(a.summary!.anchorPrompt, "How many of these would you pay extra for?");
});

test("an anchored design with a blank prompt falls back rather than asking nothing", () => {
  const a = gen({ tasks: 8, anchored: true, anchorPrompt: "   " });
  assert.equal(a.summary!.anchorPrompt, DEFAULT_ANCHOR_PROMPT);
  assert.deepEqual(errs({ tasks: 8, anchored: true, anchorPrompt: "   " }), []);
});

/* ============================================= express / sparse MaxDiff */

test("each version draws from its own subset, and no more than asked", () => {
  const e = gen({ tasks: 4, itemsPerTask: 4, versions: 4, itemsPerVersion: 5 });
  const byVersion = new Map<string, Set<string>>();
  for (const r of e.rows as Record<string, unknown>[]) {
    const v = String(r.version);
    if (!byVersion.has(v)) byVersion.set(v, new Set());
    byVersion.get(v)!.add(String(r.item_index));
  }
  assert.equal(byVersion.size, 4);
  for (const [v, set] of byVersion) {
    assert.ok(set.size <= 5, `version ${v} used ${set.size} items, more than the 5 it may draw from`);
  }
});

test("THE COVERAGE PROPERTY — every item is shown by some version", () => {
  // the failure this replaces: each version reaching for the same head of the
  // list, so the tail is never scaled and is silently absent from the results
  const e = gen({ tasks: 5, itemsPerTask: 4, versions: 4, itemsPerVersion: 5 });
  assert.deepEqual(e.summary!.neverShown, []);
  assert.equal(e.summary!.itemsCovered, ITEMS.length);
  const counts = e.summary!.itemShowCounts as Record<string, number>;
  for (const item of ITEMS) assert.ok(counts[item] > 0, `${item} was never shown`);
});

test("express still balances how often each item is shown", () => {
  const e = gen({ tasks: 6, itemsPerTask: 4, versions: 5, itemsPerVersion: 6 });
  const counts = Object.values(e.summary!.itemShowCounts as Record<string, number>);
  const spread = Math.max(...counts) - Math.min(...counts);
  assert.ok(spread <= 3, `show counts spread by ${spread}: ${JSON.stringify(e.summary!.itemShowCounts)}`);
});

test("express reports the subset size it used", () => {
  const e = gen({ tasks: 4, itemsPerTask: 4, versions: 4, itemsPerVersion: 5 });
  assert.equal(e.summary!.itemsPerVersion, 5);
});

/* ================================================= what is refused, and why */

test("a configuration that cannot cover the list is refused, naming the fix", () => {
  const twelve = [...ITEMS, "Refresh rate", "Charging speed"];
  const e = maxdiffPlugin.validateConfig!(
    { items: twelve, tasks: 4, itemsPerTask: 4, versions: 2, itemsPerVersion: 5 } as MaxDiffConfig,
  );
  const coverage = e.find((m) => /cannot cover/.test(m));
  assert.ok(coverage, `expected a coverage error, got: ${e.join(" | ")}`);
  assert.match(coverage, /cannot cover 12 items/);
  assert.match(coverage, /at least 3 versions/, "it says how many versions would work");
});

test("express with a single version is refused — the items left out are left out of the study", () => {
  const e = errs({ tasks: 4, itemsPerTask: 4, versions: 1, itemsPerVersion: 5 });
  assert.ok(e.some((m) => /more than one version/.test(m)));
});

test("a subset too small to vary a task is refused", () => {
  const e = errs({ tasks: 4, itemsPerTask: 5, versions: 5, itemsPerVersion: 5 });
  assert.ok(e.some((m) => /leave a task something to vary/.test(m)), e.join(" | "));
});

test("a valid express configuration passes", () => {
  assert.deepEqual(errs({ tasks: 5, itemsPerTask: 4, versions: 4, itemsPerVersion: 5 }), []);
});

test("the standard validations still hold with the new fields present", () => {
  assert.ok(maxdiffPlugin.validateConfig!({ items: ["A", "B"], itemsPerTask: 4, anchored: true } as MaxDiffConfig)
    .some((m) => /at least itemsPerTask \+ 1 items/.test(m)));
  assert.ok(maxdiffPlugin.validateConfig!({ items: ["A", "A", "B", "C", "D"], anchored: true } as MaxDiffConfig)
    .some((m) => /unique/.test(m)));
});

/* ======================================================== the config surface */

test("the Studio is offered a control for each variant", () => {
  const names = maxdiffPlugin.configFields.map((f) => f.name);
  for (const n of ["anchored", "anchorPrompt", "itemsPerVersion"]) {
    assert.ok(names.includes(n), `${n} is editable`);
  }
  assert.equal(maxdiffPlugin.configFields.find((f) => f.name === "anchored")!.type, "boolean");
  assert.equal(maxdiffPlugin.configFields.find((f) => f.name === "itemsPerVersion")!.type, "number");
  /* no default on itemsPerVersion: an accidental value changes the design */
  assert.equal(maxdiffPlugin.configFields.find((f) => f.name === "itemsPerVersion")!.default, undefined);
});
