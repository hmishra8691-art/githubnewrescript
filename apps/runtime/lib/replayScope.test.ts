import test from "node:test";
import assert from "node:assert/strict";
import { shouldReplay, sampleRate } from "./replayScope.ts";

test("every save is replayed whenever the replay's result is used", () => {
  for (const isFinal of [true, false]) {
    assert.equal(shouldReplay({ posture: "enforce", recompute: "log", isFinal, sample: 0, random: () => 0.99 }), true);
    assert.equal(shouldReplay({ posture: "log", recompute: "store", isFinal, sample: 0, random: () => 0.99 }), true);
  }
});

test("under log: every final save, a sample of intermediate ones; off replays nothing", () => {
  assert.equal(shouldReplay({ posture: "log", recompute: "log", isFinal: true, sample: 0 }), true);
  assert.equal(shouldReplay({ posture: "log", recompute: "log", isFinal: false, sample: 0.05, random: () => 0.01 }), true);
  assert.equal(shouldReplay({ posture: "log", recompute: "log", isFinal: false, sample: 0.05, random: () => 0.5 }), false);
  assert.equal(shouldReplay({ posture: "log", recompute: "off", isFinal: false, sample: 1, random: () => 0.99 }), true);
  assert.equal(shouldReplay({ posture: "off", recompute: "store", isFinal: true, sample: 1 }), false);
});

test("the sample rate reads the environment safely", () => {
  assert.equal(sampleRate(undefined), 0.05);
  assert.equal(sampleRate(""), 0.05);
  assert.equal(sampleRate("0.2"), 0.2);
  assert.equal(sampleRate("7"), 1);
  assert.equal(sampleRate("-1"), 0);
  assert.equal(sampleRate("abc"), 0.05);
});
