import test from "node:test";
import assert from "node:assert/strict";
import { isCardVisible, scrollDepthPct, visibleStart, visibleStop, historyValue, pushHistory, HISTORY_CAP, type HistoryEntry } from "./paradata.ts";

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

/* S5b item 2 (TE-02): answer-value history */

test("historyValue: closed values kept, typed text as its length only, other types nothing", () => {
  assert.equal(historyValue("single_select", "2"), "2");
  assert.equal(historyValue("nps", 9), 9);
  assert.equal(historyValue("single_select", undefined), null);
  assert.deepEqual(historyValue("multi_select", ["a", "b"]), ["a", "b"]);
  assert.deepEqual(historyValue("matrix_single", { r1: "1", r2: "4" }), { r1: "1", r2: "4" });
  assert.deepEqual(historyValue("matrix_multi", { r1: ["1", "2"] }), { r1: ["1", "2"] });
  assert.deepEqual(historyValue("open_text", "my secret answer"), { len: 16 });
  assert.deepEqual(historyValue("long_text", "abc"), { len: 3 });
  assert.deepEqual(historyValue("matrix_text", { r1: "abc", r2: "de" }), { len: 5 });
  assert.equal(historyValue("geo", { lat: 1, lng: 2 }), undefined, "a place is never kept");
  assert.equal(historyValue("date", "1990-01-01"), undefined);
  assert.equal(historyValue("upload", { url: "x" }), undefined);
  assert.equal(historyValue(undefined, "1"), undefined);
  assert.equal(historyValue("matrix_single", { r1: { deep: 1 } }), undefined, "nested objects are refused");
  assert.equal((historyValue("dropdown", "x".repeat(100)) as string).length, 40);
});

test("pushHistory keeps the latest 20 and counts what it dropped", () => {
  const h: HistoryEntry[] = [];
  let d = 0;
  for (let i = 0; i < 25; i++) d = pushHistory(h, [i * 10, String(i)], d);
  assert.equal(h.length, HISTORY_CAP);
  assert.equal(d, 5);
  assert.deepEqual(h[0], [50, "5"]);
  assert.deepEqual(h[19], [240, "24"]);
});
