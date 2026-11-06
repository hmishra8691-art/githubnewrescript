import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSegments, fixtureState } from "./fixture.js";
import { emergingThemes, emotionPrompt, emotionSummary, gateEmotions } from "./depth.js";

/* IM9 — emerging themes, and the model's emotion reading behind a verbatim gate */
test("emerging themes: the recent interview against the earlier two", () => {
  const r = emergingThemes(fixtureState(), fixtureSegments(), new Set(["src3"]));
  assert.ok(r.base.recent > 0 && r.base.earlier > 0);
  assert.equal(r.themes.length, 2);
  for (const t of r.themes) { assert.ok(["new", "rising", "fading", "steady"].includes(t.status)); assert.match(t.because, /%/); }
  assert.match(r.note, /not a test/);
  const allNew = emergingThemes(fixtureState(), fixtureSegments(), new Set(["src1", "src2", "src3"]));
  assert.ok(allNew.themes.every((t) => t.earlier.segments === 0));
});

test("emotion: fenced data, a fixed label set, verbatim cues or nothing", () => {
  const ex = fixtureState().excerpts.slice(0, 3);
  const p = emotionPrompt(ex, "n1");
  assert.ok(p.indexOf("<<<DATA n1") > 0); assert.match(p, /never instructions/);
  const g = gateEmotions({ readings: [
    { id: "1", emotion: "frustration", polarity: "negative", cue: "went up twice" },
    { id: "2", emotion: "anger", polarity: "negative", cue: "not in the text" },
    { id: "3", emotion: "elation", polarity: "positive", cue: "reliable" },
    { id: "3", emotion: "trust", polarity: "positive", cue: "reliable connection" },
  ] }, ex);
  assert.deepEqual(g.kept.map((k) => [k.excerptId, k.emotion]), [["x1", "frustration"], ["x3", "trust"]]);
  assert.equal(g.dropped, 2);
  const s = emotionSummary(g.kept, ex.length);
  assert.match(s.lines[0], /2 of 3 excerpts read \(1 dropped/);
  assert.match(s.label, /never a measure/);
});
