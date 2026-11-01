import test from "node:test";
import assert from "node:assert/strict";
import { isCardVisible, scrollDepthPct, visibleStart, visibleStop } from "./paradata.ts";

/* S5b item 1 (TE-04): visibility + scroll depth arithmetic */

test("isCardVisible: half of the card, or a tall card filling half the viewport", () => {
  assert.equal(isCardVisible(0.5, 100, 800), true);
  assert.equal(isCardVisible(0.49, 100, 800), false);
  // a grid 3× the viewport: ratio 0.33 but it fills the whole viewport
  assert.equal(isCardVisible(0.33, 800, 800), true);
  assert.equal(isCardVisible(0.2, 300, 800), false);
  assert.equal(isCardVisible(0.2, 300, 0), false);
});

test("scrollDepthPct: viewport bottom over page height, clamped, a fitting page is 100", () => {
  assert.equal(scrollDepthPct(0, 800, 800), 100);
  assert.equal(scrollDepthPct(0, 800, 3200), 25);
  assert.equal(scrollDepthPct(1600, 800, 3200), 75);
  assert.equal(scrollDepthPct(5000, 800, 3200), 100);
  assert.equal(scrollDepthPct(-50, 800, 1600), 50);
  assert.equal(scrollDepthPct(0, 800, 0), 100);
});

test("visibleStart / visibleStop accumulate visible ms and keep the first-seen time", () => {
  const open = new Map<string, number>();
  const q: any = { changes: 0, pastes: 0, pasteChars: 0, typedChars: 0, copies: 0 };
  visibleStart(open, q, "q1", 1000);
  visibleStart(open, q, "q1", 1500); // idempotent while visible
  visibleStop(open, q, "q1", 3000);
  assert.equal(q.visibleMs, 2000);
  assert.equal(q.firstSeenAt, 1000);
  visibleStop(open, q, "q1", 4000); // not open: no change
  assert.equal(q.visibleMs, 2000);
  visibleStart(open, q, "q1", 5000);
  visibleStop(open, q, "q1", 5500);
  assert.equal(q.visibleMs, 2500);
  assert.equal(q.firstSeenAt, 1000);
});
