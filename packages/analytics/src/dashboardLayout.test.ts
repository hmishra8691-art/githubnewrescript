import test from "node:test";
import assert from "node:assert/strict";
import {
  DASHBOARD_COLUMNS, clampBox, compactLayout, firstFreeSlot, flowLayout, isUnpositioned,
  layoutRows, normalizeLayout, placeWidget, resolveOverlaps, sortByPosition,
} from "./dashboardLayout.js";
import type { DashboardWidget } from "./types.js";

const W = (id: string, x: number, y: number, w = 3, h = 2): DashboardWidget =>
  ({ id, type: "chart", x, y, w, h });

const boxes = (list: DashboardWidget[]) => list.map((w) => [w.id, w.x, w.y, w.w, w.h]);

/** no two widgets may share a cell — the property every operation must preserve */
function assertNoOverlap(list: DashboardWidget[]) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!hit, `${a.id} (${a.x},${a.y},${a.w}×${a.h}) overlaps ${b.id} (${b.x},${b.y},${b.w}×${b.h})`);
    }
  }
}

test("a box is forced onto whole cells and never off the right edge", () => {
  assert.deepEqual(clampBox({ x: 2.4, y: 1.6, w: 3.5, h: 2.2 }), { x: 2, y: 2, w: 4, h: 2 });
  assert.deepEqual(clampBox({ x: 11, y: 0, w: 6, h: 2 }), { x: 6, y: 0, w: 6, h: 2 }, "a wide box slides left to fit");
  assert.deepEqual(clampBox({ x: -3, y: -2, w: 0, h: 0 }), { x: 0, y: 0, w: 1, h: 1 }, "nothing smaller than one cell, nothing off the top-left");
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 99, h: 3 }), { x: 0, y: 0, w: DASHBOARD_COLUMNS, h: 3 });
});

test("a dashboard saved before positioning existed flows in its old order", () => {
  /*
   * Every widget at 0,0 is what the old builder wrote. Dropped into a
   * positioned grid as-is they would all pile into the top-left cell, so the
   * migration flows them left-to-right exactly as the CSS auto-flow grid did.
   */
  const legacy = [W("a", 0, 0, 6, 2), W("b", 0, 0, 6, 3), W("c", 0, 0, 4, 2), W("d", 0, 0, 12, 2)];
  assert.ok(isUnpositioned(legacy));
  const out = normalizeLayout(legacy);
  assert.deepEqual(boxes(out), [
    ["a", 0, 0, 6, 2],
    ["b", 6, 0, 6, 3],   // fills the first row beside a
    ["c", 0, 3, 4, 2],   // wraps below the tallest widget of that row
    ["d", 0, 5, 12, 2],  // a full-width widget starts its own row
  ]);
  assertNoOverlap(out);
});

test("a layout that has been positioned is left exactly where it was put", () => {
  const placed = [W("a", 0, 0, 4, 2), W("b", 6, 3, 3, 2), W("c", 0, 8, 12, 1)];
  assert.ok(!isUnpositioned(placed));
  assert.deepEqual(boxes(normalizeLayout(placed)), boxes(placed), "reopening a dashboard must not rearrange it");
});

test("gaps are kept — free placement means the empty space was a decision", () => {
  const withGaps = [W("a", 0, 0, 3, 2), W("b", 8, 6, 3, 2)];
  assert.deepEqual(boxes(normalizeLayout(withGaps)), boxes(withGaps));
});

test("normalizing is idempotent, so reopening never drifts", () => {
  const list = [W("a", 0, 0, 6, 2), W("b", 0, 0, 6, 2), W("c", 0, 0, 5, 3)];
  const once = normalizeLayout(list);
  const twice = normalizeLayout(once);
  assert.deepEqual(boxes(twice), boxes(once));
  assert.deepEqual(boxes(normalizeLayout(twice)), boxes(once));
});

test("a single widget is never treated as an unpositioned dashboard", () => {
  const one = [W("a", 5, 4, 3, 2)];
  assert.ok(!isUnpositioned(one));
  assert.deepEqual(boxes(normalizeLayout(one)), boxes(one));
  assert.deepEqual(normalizeLayout([]), []);
});

test("overlapping widgets are pushed down, never left stacked on top of each other", () => {
  const stacked = [W("a", 0, 0, 6, 2), W("b", 2, 1, 6, 2), W("c", 3, 0, 4, 2)];
  const out = resolveOverlaps(stacked);
  assertNoOverlap(out);
});

test("the widget just dropped keeps the cell it was dropped on; the others give way", () => {
  const list = [W("a", 0, 0, 6, 2), W("b", 0, 2, 6, 2)];
  const out = placeWidget(list, "b", { x: 0, y: 0, w: 6, h: 2 });
  const b = out.find((w) => w.id === "b")!, a = out.find((w) => w.id === "a")!;
  assert.deepEqual([b.x, b.y], [0, 0], "the dragged widget lands where it was dropped");
  assert.equal(a.y, 2, "the widget that was there moves down");
  assertNoOverlap(out);
});

test("a resize that swallows a neighbour pushes it down rather than covering it", () => {
  const list = [W("a", 0, 0, 3, 2), W("b", 3, 0, 3, 2)];
  const out = placeWidget(list, "a", { x: 0, y: 0, w: 12, h: 3 });
  const a = out.find((w) => w.id === "a")!, b = out.find((w) => w.id === "b")!;
  assert.deepEqual([a.x, a.y, a.w, a.h], [0, 0, 12, 3]);
  assert.equal(b.y, 3, "the neighbour is below the enlarged widget");
  assertNoOverlap(out);
});

test("placing a widget keeps the array in its saved order", () => {
  const list = [W("a", 0, 0), W("b", 3, 0), W("c", 6, 0)];
  const out = placeWidget(list, "c", { x: 0, y: 0, w: 3, h: 2 });
  assert.deepEqual(out.map((w) => w.id), ["a", "b", "c"], "a drag must not rewrite the definition's order");
});

test("a widget dragged off the right edge slides back onto the grid", () => {
  const out = placeWidget([W("a", 0, 0, 4, 2)], "a", { x: 10, y: 1, w: 4, h: 2 });
  assert.deepEqual([out[0].x, out[0].y, out[0].w], [8, 1, 4]);
});

test("tidying pulls everything up without letting anything collide", () => {
  const holey = [W("a", 0, 0, 4, 2), W("b", 4, 5, 4, 2), W("c", 0, 9, 4, 3)];
  const out = compactLayout(holey);
  assertNoOverlap(out);
  assert.equal(out.find((w) => w.id === "b")!.y, 0, "b rises beside a");
  assert.equal(out.find((w) => w.id === "c")!.y, 2, "c rises to just under a");
  assert.deepEqual(out.map((w) => w.id), ["a", "b", "c"], "tidying keeps the saved order too");
});

test("tidying a layout with no gaps changes nothing", () => {
  const tight = [W("a", 0, 0, 6, 2), W("b", 6, 0, 6, 2), W("c", 0, 2, 12, 2)];
  assert.deepEqual(boxes(compactLayout(tight)), boxes(tight));
});

test("widgets are read left to right, top to bottom, whatever the array order", () => {
  const scrambled = [W("d", 6, 4), W("a", 0, 0), W("c", 0, 4), W("b", 6, 0)];
  assert.deepEqual(sortByPosition(scrambled).map((w) => w.id), ["a", "b", "c", "d"]);
});

test("a new widget goes in the first hole big enough for it", () => {
  const list = [W("a", 0, 0, 6, 2), W("b", 6, 0, 3, 2)];
  assert.deepEqual(firstFreeSlot(list, 3, 2), { x: 9, y: 0 }, "the gap on the first row");
  assert.deepEqual(firstFreeSlot(list, 6, 2), { x: 0, y: 2 }, "too wide for the gap, so the next row");
  assert.deepEqual(firstFreeSlot([], 4, 2), { x: 0, y: 0 });
});

test("a new widget never lands on top of an existing one", () => {
  let list: DashboardWidget[] = [];
  for (let i = 0; i < 12; i++) {
    const slot = firstFreeSlot(list, 5, 2);
    list = [...list, { id: `w${i}`, type: "chart", w: 5, h: 2, ...slot }];
  }
  assertNoOverlap(list);
});

test("the canvas is tall enough for the lowest widget", () => {
  assert.equal(layoutRows([W("a", 0, 0, 3, 2), W("b", 3, 4, 3, 3)]), 7);
  assert.equal(layoutRows([]), 0);
});
