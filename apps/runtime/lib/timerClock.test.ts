import { test } from "node:test";
import assert from "node:assert/strict";
import { PageClock, usesLiveBehavior, effectiveDevice } from "./timerClock.ts";

const T = (ref: string, timer: Record<string, unknown>, scope: "page" | "question" = "page") =>
  ({ ref, key: `TIMER_${ref.toUpperCase()}`, scope, ...(scope === "question" ? { questionId: ref.toLowerCase() } : {}), timer: { show: "countdown", onTimeout: "advance", ...timer } }) as never;

test("S4b clock: one clock per page; entering the same page keeps it, a new page restarts it", () => {
  const c = new PageClock();
  assert.equal(c.enter("0|p1", 1000), true);
  assert.equal(c.enter("0|p1", 5000), false);
  assert.equal(c.elapsed(6000), 5);
  assert.equal(c.enter("1|p2", 7000), true);
  assert.equal(c.elapsed(7500), 0.5);
});

test("S4b clock: a timer runs out once; the countdown is the soonest visible one; wall time (hidden tab keeps counting)", () => {
  const c = new PageClock();
  c.enter("0|p1", 0);
  const timers = [T("p1", { limitSeconds: 30 }), T("Q1", { limitSeconds: 10, show: "hidden" }, "question"), T("Q2", { limitSeconds: 20 }, "question")];
  const a = c.step(timers, 4000);
  assert.equal(a.expired.length, 0);
  assert.equal(a.view.countdown?.ref, "Q2"); // Q1 is hidden: the soonest VISIBLE countdown
  assert.equal(a.view.countdown?.remaining, 16);
  /* a hidden tab delivers no ticks — the next tick, 15 s later, sees the wall time */
  const b = c.step(timers, 19000);
  assert.deepEqual(b.expired.map((t: { ref: string }) => t.ref), ["Q1"]);
  assert.equal(c.step(timers, 19500).expired.length, 0, "fires once");
  assert.ok(c.timedOut.has("Q1"));
});

test("S4b clock: the warning is announced once, at warnAtSeconds left — not every second", () => {
  const c = new PageClock();
  c.enter("k", 0);
  const timers = [T("p1", { limitSeconds: 30, warnAtSeconds: 10 })];
  assert.equal(c.step(timers, 15000).warn, null);
  const w = c.step(timers, 20500);
  assert.equal(w.warn?.remaining, 10);
  assert.equal(c.step(timers, 21500).warn, null);
  assert.equal(c.step(timers, 25000).warn, null);
});

test("S4b clock: minSeconds — minWait counts down and 'ready' is reported once", () => {
  const c = new PageClock();
  c.enter("k", 0);
  const timers = [T("p1", { minSeconds: 10 })];
  const a = c.step(timers, 3200);
  assert.equal(a.view.minWait, 7);
  assert.equal(a.ready, false);
  const b = c.step(timers, 10000);
  assert.equal(b.view.minWait, 0);
  assert.equal(b.ready, true);
  assert.equal(c.step(timers, 11000).ready, false);
});

test("S4b clock: lock — a page lock locks the page, a question lock only its question", () => {
  const c = new PageClock();
  c.enter("k", 0);
  const v = c.step([T("Q1", { limitSeconds: 5, onTimeout: "lock" }, "question")], 6000).view;
  assert.deepEqual(v.lockedQuestions, ["q1"]);
  assert.equal(v.pageLocked, false);
  assert.equal(c.step([T("p1", { limitSeconds: 5, onTimeout: "lock" })], 6000).view.pageLocked, true);
});

test("S4b: usesLiveBehavior finds a time rule anywhere; device alone does not need the clock", () => {
  const rule = (ref: string) => ({ type: "rule", source: { kind: "behavior", ref }, operator: "gt", value: 5 });
  assert.equal(usesLiveBehavior({ questions: [{ displayLogic: rule("time_on_page") }], flow: [] } as never), true);
  assert.equal(usesLiveBehavior({ questions: [{ displayLogic: rule("device") }], flow: [] } as never), false);
  assert.equal(usesLiveBehavior({ questions: [], flow: [{ type: "page", visibleIf: rule("elapsed") }] } as never), true);
});

test("S4b: effectiveDevice — detection, and the preview's device switch when changed", () => {
  assert.equal(effectiveDevice("mobile", "desktop", false), "mobile");
  assert.equal(effectiveDevice("unknown", "desktop", false), undefined);
  assert.equal(effectiveDevice("desktop", "mobile", true), "mobile");
  assert.equal(effectiveDevice("mobile", "desktop", true), "mobile");
});

test("audit 2026-11-07: a reload / resume continues a timed page from its stored arrival — refreshing never grants a fresh allowance", () => {
  const timers = [{ ref: "P1", key: "TIMER_P1", timer: { limitSeconds: 30, show: "countdown", onTimeout: "advance" } }] as never;
  const c = new PageClock();
  assert.equal(c.enter("3|p1", 100_000, 80_000), true); // mounted after a reload, 20 s after the page was first shown
  assert.equal(Math.round(c.elapsed(100_000)), 20);
  assert.equal(c.view(timers, 100_000).countdown?.remaining, 10);
  const fresh = new PageClock();
  fresh.enter("3|p1", 100_000);
  assert.equal(Math.round(fresh.elapsed(100_000)), 0);
});
