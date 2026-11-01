import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeTelemetry, TELEMETRY_KEYS } from "./telemetrySanitize.ts";

const base = () => ({
  v: 1, startedAt: 1, submittedAt: 99,
  pages: [{ pageId: "p1", step: 0, enteredAt: 1, leftAt: 50, via: "start", questionIds: ["q1"], outOfFocusMs: 0, blurs: 0, pointerEvents: 2, keyEvents: 0, scrollEvents: 3, scrollDepth: 140 }],
  questions: { q1: { changes: 1, firstChangeAt: 10, lastChangeAt: 10, pastes: 0, pasteChars: 0, typedChars: 0, copies: 0, visibleMs: 900, firstSeenAt: 5, text: "SECRET" } },
  focus: { blurs: 0, totalOutOfFocusMs: 0, longestOutOfFocusMs: 0 },
  clipboard: { copies: 0, pastes: 0, pasteChars: 0, largePastes: 0, pasteQuestions: 0, text: "SECRET" },
  navigation: { back: 0, forward: 0, reloads: 0, jumps: 0, sequence: [] },
  interaction: { pointerEvents: 2, keyEvents: 0, scrollEvents: 3 },
  disabled: ["bogus"], measured: ["visibility", "bogus"],
});

test("S5b: visibility fields are kept (clamped) when the category is on, and nothing unknown survives", () => {
  const s = sanitizeTelemetry(base(), {});
  assert.equal(s.pages[0].scrollDepth, 100);
  assert.equal(s.questions.q1.visibleMs, 900);
  assert.equal(s.questions.q1.firstSeenAt, 5);
  assert.deepEqual(s.measured, ["visibility"]);
  assert.deepEqual(s.disabled, []);
  assert.ok(!JSON.stringify(s).includes("SECRET"));
});

test("S5b: visibility off → no scroll depth / visible time, listed in disabled, not in measured", () => {
  const s = sanitizeTelemetry(base(), { visibility: false });
  assert.equal(s.pages[0].scrollDepth, undefined);
  assert.equal(s.questions.q1.visibleMs, undefined);
  assert.equal(s.questions.q1.firstSeenAt, undefined);
  assert.ok(s.disabled.includes("visibility"));
  assert.deepEqual(s.measured, []);
});

test("the category list matches the schema's switches", async () => {
  const schema = await import("@rescript/schema");
  assert.deepEqual([...TELEMETRY_KEYS], [...schema.TELEMETRY_CATEGORIES]);
});

test("S5b answer history: re-derived from the definition's type — text keeps length only, unknown questions nothing", () => {
  const t: any = base();
  t.measured = ["visibility", "answerHistory"];
  t.questions = {
    q1: { changes: 3, history: [[10, "1"], [20, "2"], [30, "1"], ["bad", "3"], [40, { deep: { x: 1 } }]] },
    oe: { changes: 2, history: [[10, "SECRET TEXT"], [20, { len: 7, text: "SECRET" }]] },
    gx: { changes: 1, history: [[10, { lat: 51.5, lng: 0.1 }]] },
    zz: { changes: 1, history: [[10, "1"]] },
  };
  const types = { q1: "single_select", oe: "open_text", gx: "geo" };
  const s = sanitizeTelemetry(t, {}, types);
  assert.deepEqual(s.questions.q1.history, [[10, "1"], [20, "2"], [30, "1"]]);
  assert.deepEqual(s.questions.oe.history, [[20, { len: 7 }]]);
  assert.equal(s.questions.gx.history, undefined);
  assert.equal(s.questions.zz.history, undefined, "not in the definition: nothing");
  assert.ok(!JSON.stringify(s).includes("SECRET"));
  assert.deepEqual(s.measured, ["visibility", "answerHistory"]);
  const off = sanitizeTelemetry(t, { answerHistory: false }, types);
  assert.equal(off.questions.q1.history, undefined);
  assert.ok(off.disabled.includes("answerHistory"));
});

test("S5b answer history: at most 20 entries survive", () => {
  const t: any = base();
  t.questions = { q1: { changes: 30, history: Array.from({ length: 30 }, (_, i) => [i, String(i % 5)]), historyDropped: 10 } };
  const s = sanitizeTelemetry(t, {}, { q1: "single_select" });
  assert.equal(s.questions.q1.history.length, 20);
  assert.equal(s.questions.q1.historyDropped, 10);
});

test("S5b idle: periods and per-visit idle time kept when on, nothing when off", () => {
  const t: any = base();
  t.measured = ["idle"];
  t.pages[0].idleMs = 61000;
  t.idle = { thresholdMs: 60000, periods: [{ pageId: "p1", at: 1000, ms: 61000, prompted: true, note: "x" }, "junk"], totalMs: 61000, longestMs: 61000, prompts: 1, extra: "SECRET" };
  const s = sanitizeTelemetry(t, {});
  assert.deepEqual(s.idle, { thresholdMs: 60000, periods: [{ pageId: "p1", at: 1000, ms: 61000, prompted: true }], totalMs: 61000, longestMs: 61000, prompts: 1 });
  assert.equal(s.pages[0].idleMs, 61000);
  assert.deepEqual(s.measured, ["idle"]);
  const off = sanitizeTelemetry(t, { idle: false });
  assert.equal(off.idle, undefined);
  assert.equal(off.pages[0].idleMs, undefined);
  assert.ok(off.disabled.includes("idle"));
});
