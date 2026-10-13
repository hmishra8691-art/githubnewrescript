import { test } from "node:test";
import assert from "node:assert/strict";
import { divergingLayout, divergingSeriesOrder, stackShares } from "./chartLayout.js";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("C-2: a stack is normalised to 100 whatever its parts add up to", () => {
  for (const sum of [0, 22, 30, 69, 78]) {
    const s = stackShares(sum ? [sum / 2, sum / 4, sum / 4] : [0, 0, 0]);
    close(s.reduce((a, b) => a + b, 0), sum ? 100 : 0);
  }
  assert.deepEqual(stackShares([null, -5, 10]), [0, 0, 100]);
});

test("C-1: diverging layout for 3-, 4-, 5- and 7-point scales — neutral centred, order outward, nothing past 100", () => {
  for (const k of [3, 4, 5, 7]) {
    const shares = stackShares(Array.from({ length: k }, (_, i) => i + 1));
    const lay = divergingLayout(shares)!;
    assert.equal(lay.segments.length, k);
    // segments tile without gaps: every series' span equals its share
    lay.segments.forEach((sg) => close(sg.to - sg.from, shares[sg.index]));
    close(lay.left + lay.right, 100);
    const half = Math.floor(k / 2);
    if (k % 2) { const n = lay.segments[half]; close(n.from, -n.to); }              // the neutral is centred
    // lower half is left of centre and ordered outward: series 0 is the farthest left
    for (let j = 0; j < half; j++) assert.ok(lay.segments[j].to <= 1e-9 + (k % 2 ? -shares[half] / 2 : 0));
    for (let j = 1; j < half; j++) assert.ok(lay.segments[j - 1].from < lay.segments[j].from, "most negative series is farthest from the centre");
    // upper half is right of centre, the last series farthest right
    for (let j = k - half; j < k; j++) assert.ok(lay.segments[j].from >= (k % 2 ? shares[half] / 2 : 0) - 1e-9);
    assert.ok(lay.segments[k - 1].to > lay.segments[k - half].to - 1e-9);
  }
});

test("C-1: a single series is not a diverging bar", () => {
  assert.equal(divergingLayout([100]), null);
});

test("C-1: an extreme distribution does not overflow — the axis follows the bar", () => {
  const lay = divergingLayout(stackShares([1, 1, 1, 1, 96]))!;
  assert.ok(lay.right > 95 && lay.right <= 100 && lay.left < 5);
});

test("C-1: signed series order for stacking charts has a half neutral on each side", () => {
  assert.deepEqual(divergingSeriesOrder(5).map((x) => `${x.index}${x.sign > 0 ? "+" : "-"}${x.half ? "h" : ""}`), ["2-h", "1-", "0-", "2+h", "3+", "4+"]);
  assert.deepEqual(divergingSeriesOrder(4).map((x) => `${x.index}${x.sign > 0 ? "+" : "-"}`), ["1-", "0-", "2+", "3+"]);
});
