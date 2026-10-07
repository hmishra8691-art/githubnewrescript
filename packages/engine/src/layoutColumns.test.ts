import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutColumns, defaultLayoutColumns, MAX_LAYOUT_COLUMNS } from "./rendererReads.js";

/*
 * LAYOUT — NO "AUTO (FIT WIDTH)"; ONE COLUMN BY DEFAULT (October 2026 review).
 * Five or ten options in a fresh radio question are one column, not three.
 */
const q = (settings: Record<string, unknown>, n = 5, type = "single_select") => ({ type, settings, options: Array.from({ length: n }) });

test("an option list starts as one column, whatever its length", () => {
  for (const n of [2, 5, 10, 25]) assert.equal(layoutColumns(q({}, n)), 1, `${n} options`);
  assert.equal(layoutColumns(q({}, 10, "multi_select")), 1);
  assert.equal(layoutColumns(q({}, 10), "buttons"), 1, "Button Select too — the variant the old auto flow was raised against");
  assert.equal(layoutColumns(q({}, 4), "listrows"), 1);
});

test("the author's choice, 1 to 5, is exactly what is drawn; nonsense falls back", () => {
  for (const n of [1, 2, 3, 4, 5]) assert.equal(layoutColumns(q({ columnsLayout: n }, 20)), n);
  assert.equal(MAX_LAYOUT_COLUMNS, 5);
  assert.equal(layoutColumns(q({ columnsLayout: 9 })), 5, "clamped to the five offered");
  assert.equal(layoutColumns(q({ columnsLayout: 0 })), 1);
  assert.equal(layoutColumns(q({ columnsLayout: null })), 1);
});

test("grids by design keep their designed count when none is stored — shown as that number, never 'auto'", () => {
  assert.equal(defaultLayoutColumns("cards", "single_select"), 2);
  assert.equal(defaultLayoutColumns(undefined, "image_select"), 3);
  assert.equal(defaultLayoutColumns("compare", "single_select", 2), 2);
  assert.equal(defaultLayoutColumns("compare", "single_select", 7), 4);
  assert.equal(layoutColumns(q({ columnsLayout: 1 }), "cards"), 1, "a stored 1 means 1");
});
