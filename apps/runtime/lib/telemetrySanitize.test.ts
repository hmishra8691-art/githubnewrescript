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
