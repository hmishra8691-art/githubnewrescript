import { test } from "node:test";
import assert from "node:assert/strict";
import { cachePending, clearPending, readPending, mergeResumeSnapshot, cachePreviewState, readPreviewState, type PendingAnswers } from "./resume.ts";

/* a minimal localStorage, so the browser-only cache can run under node */
function installStorage(): Map<string, string> {
  const m = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage, sessionStorage: storage };
  return m;
}

const pending = (stepIndex: number, answers: Record<string, unknown> = {}): PendingAnswers =>
  ({ answers, calculated: {}, embedded: {}, flags: [], stepIndex, at: 1 });

/* RUNTIME-06: after Back, the locally cached position is LOWER than the server's — and it must win */
test("a cached step lower than the saved one wins (Back, then reload before the save landed)", () => {
  const saved = { answers: { Q1: 1, Q2: 2, Q3: 3 }, calculated: {}, embedded: {}, flags: [], stepIndex: 6 };
  const r = mergeResumeSnapshot(saved, pending(2));
  assert.equal(r.stepIndex, 2);
  assert.deepEqual(r.answers, { Q1: 1, Q2: 2, Q3: 3 }, "answers to later pages are kept, not discarded");
});

test("a cached step higher than the saved one still wins (Next, save failed)", () => {
  const r = mergeResumeSnapshot({ answers: { Q1: 1 }, stepIndex: 2 }, pending(4, { Q2: "x" }));
  assert.equal(r.stepIndex, 4);
  assert.deepEqual(r.answers, { Q1: 1, Q2: "x" });
});

test("a corrupt cached step falls back to the server's", () => {
  const p = { ...pending(0), stepIndex: -3 };
  assert.equal(mergeResumeSnapshot({ answers: {}, stepIndex: 5 }, p).stepIndex, 5);
  const q = { ...pending(0), stepIndex: Number.NaN };
  assert.equal(mergeResumeSnapshot({ answers: {}, stepIndex: 5 }, q).stepIndex, 5);
  assert.equal(mergeResumeSnapshot(null, q).stepIndex, 0);
});

test("cached answers override saved ones; no saved row is fine", () => {
  const r = mergeResumeSnapshot(undefined, pending(3, { Q1: "new" }));
  assert.deepEqual(r, { answers: { Q1: "new" }, calculated: {}, embedded: {}, flags: [], stepIndex: 3 });
});

test("an acknowledgement clears only the snapshot its own save carried", async () => {
  installStorage();
  const sid = "session-abcdefghijklmnop";
  const first = cachePending(sid, { answers: { Q1: 1 }, calculated: {}, embedded: {}, flags: [], stepIndex: 4 });
  await new Promise((r) => setTimeout(r, 3));
  const second = cachePending(sid, { answers: { Q1: 1 }, calculated: {}, embedded: {}, flags: [], stepIndex: 2 });
  assert.notEqual(first, second);
  clearPending(sid, first); // the older save acknowledged late
  assert.equal(readPending(sid)?.stepIndex, 2, "the Back snapshot survives the stale ack");
  clearPending(sid, second);
  assert.equal(readPending(sid), null);
});

test("clearPending without a stamp still clears unconditionally", () => {
  installStorage();
  const sid = "session-abcdefghijklmnop";
  cachePending(sid, { answers: {}, calculated: {}, embedded: {}, flags: [], stepIndex: 1 });
  clearPending(sid);
  assert.equal(readPending(sid), null);
});

/* conjoint audit 2026-10-17: a preview reload keeps its seed, so a CBC answer (a design alternative of the
   seed's version) is restored onto the same concepts, in the same order */
test("a preview snapshot carries the response seed back after a reload", () => {
  installStorage();
  cachePreviewState("cj:full", { answers: { q1: { "1": "2" } }, calculated: {}, embedded: {}, flags: [], stepIndex: 1, seed: 424242 });
  const back = readPreviewState("cj:full");
  assert.equal(back?.seed, 424242);
  assert.deepEqual(back?.answers, { q1: { "1": "2" } });
  cachePreviewState("old:full", { answers: {}, calculated: {}, embedded: {}, flags: [], stepIndex: 0 });
  assert.equal(readPreviewState("old:full")?.seed, undefined, "a snapshot without one (written before) reads as before");
});

/* SECTION NAVIGATION (2026-10-30): the Back trail and the seen pages survive a reload in this browser */
test("the section-navigation trail round-trips, is cleaned, and clears", async () => {
  const m = installStorage();
  const { writeNavTrail, readNavTrail, clearNavTrail } = await import("./resume.ts");
  writeNavTrail("sess1", { visited: ["p1", "p2"], seen: ["p1", "p2", "p4", 7 as unknown as string] });
  const t = readNavTrail("sess1");
  assert.deepEqual(t?.visited, ["p1", "p2"]);
  assert.deepEqual(t?.seen, ["p1", "p2", "p4"], "non-string ids are dropped");
  m.set("rescript:nav:bad", "{not json");
  assert.equal(readNavTrail("bad"), null);
  clearNavTrail("sess1");
  assert.equal(readNavTrail("sess1"), null);
});

/* 0077: the row's navigation trail survives the merge with a pending snapshot, so the Runner can weigh it */
test("mergeResumeSnapshot keeps the row's nav and its save time", () => {
  const saved = { answers: { Q1: 1 }, stepIndex: 3, nav: { v: 1, stack: ["p1"], visited: ["p1", "p2"] }, savedAt: "2026-10-30T10:00:00.000Z" };
  const r = mergeResumeSnapshot(saved, pending(4));
  assert.deepEqual(r.nav, saved.nav);
  assert.equal(r.savedAt, saved.savedAt);
  assert.equal("nav" in mergeResumeSnapshot({ answers: {}, stepIndex: 1 }, pending(2)), false, "no row trail → nothing invented");
});
