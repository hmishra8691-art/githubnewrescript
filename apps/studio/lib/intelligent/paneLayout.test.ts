import { test } from "node:test";
import assert from "node:assert/strict";
import { paneLayout, splitterKey, readPaneWidths, MIN_MAIN, RAIL } from "./paneLayout.ts";

/* #19: the conversation keeps 600 px; the side panes shrink, then become rails, then drawers */

const L = (width: number, s = 240, i = 360, open = { s: true, i: true }) => paneLayout({ width, structure: { open: open.s, width: s }, inspector: { open: open.i, width: i } });

test("wide windows: both panes docked at their remembered widths", () => {
  for (const w of [1416, 1342, 1256]) {
    const l = L(w);
    assert.equal(l.structure, "docked"); assert.equal(l.inspector, "docked");
    assert.equal(l.structureWidth, 240); assert.equal(l.inspectorWidth, 360);
    assert.ok(l.mainWidth >= MIN_MAIN, `${w}: ${l.mainWidth}`);
    assert.equal(l.structureWidth + l.inspectorWidth + 12 + l.mainWidth, w);
  }
});

test("1024 px with all three open: the conversation keeps 600 (it was 418) — the structure pane becomes a rail, the inspector stays", () => {
  const l = L(1000);
  assert.equal(l.structure, "rail");
  assert.equal(l.inspector, "docked");
  assert.ok(l.mainWidth >= MIN_MAIN, String(l.mainWidth));
  assert.equal(RAIL + 6 + l.inspectorWidth + l.mainWidth, 1000);
  assert.match(l.columns, /^40px minmax\(0, 1fr\) 6px \d+px$/);
});

test("in between: panes shrink toward their minimums before anything collapses", () => {
  const l = L(1100);
  assert.equal(l.structure, "docked"); assert.equal(l.inspector, "docked");
  assert.ok(l.inspectorWidth < 360 && l.inspectorWidth >= 260);
  assert.equal(l.mainWidth, 600);
});

test("a tablet: both rails; a phone: no rails (drawers from the toolbar) — never sideways scrolling", () => {
  const t = L(744);
  assert.deepEqual([t.structure, t.inspector], ["rail", "rail"]);
  assert.ok(t.mainWidth >= MIN_MAIN);
  const p = L(390);
  assert.deepEqual([p.structure, p.inspector], ["hidden", "hidden"]);
  assert.equal(p.mainWidth, 390);
  assert.equal(p.columns, "minmax(0, 1fr)");
});

test("closed panes take nothing; remembered widths are clamped; splitter keys move 16 px (64 with Shift), mirrored in RTL", () => {
  assert.equal(L(1000, 240, 360, { s: false, i: false }).mainWidth, 1000);
  assert.deepEqual(readPaneWidths('{"inspector": 9999, "structure": 10}'), { inspector: 640, structure: 180 });
  assert.deepEqual(readPaneWidths("not json"), { inspector: 360, structure: 240 });
  assert.equal(splitterKey("ArrowLeft", false, 360, "inspector", "end", false), 376, "the inspector's splitter moved left widens it");
  assert.equal(splitterKey("ArrowLeft", false, 360, "inspector", "end", true), 344, "…and narrows it in RTL, where the inspector is on the left");
  assert.equal(splitterKey("ArrowRight", true, 240, "structure", "start", false), 304);
  assert.equal(splitterKey("Home", false, 300, "structure", "start", false), 180);
  assert.equal(splitterKey("End", false, 300, "inspector", "end", false), 640);
  assert.equal(splitterKey("Enter", false, 300, "inspector", "end", false), null);
});
