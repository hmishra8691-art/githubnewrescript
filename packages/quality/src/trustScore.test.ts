import { test } from "node:test";
import assert from "node:assert/strict";
import { trustScore } from "./trustScore.js";

test("a stranger starts at 70 with low confidence and is allowed", () => {
  const t = trustScore({ completes: 0 });
  assert.equal(t.score, 70);
  assert.equal(t.confidence, "low");
  assert.equal(t.action, "allow");
  assert.match(t.why, /newcomer/);
});

test("a long clean record earns trust; one bad complete does not undo it", () => {
  const good = trustScore({ completes: 40, classified: { CLEAN: 40 } });
  assert.ok(good.score > 90, String(good.score));
  assert.equal(good.confidence, "high");
  const oneBad = trustScore({ completes: 41, classified: { CLEAN: 40, SUSPICIOUS: 1 } });
  assert.equal(oneBad.action, "allow");
});

test("a newcomer with one rejection is verified, never quarantined on so little", () => {
  const t = trustScore({ completes: 1, rejections: 1 });
  assert.ok(t.score < 65);
  assert.notEqual(t.action, "quarantine");
  assert.equal(t.action, "verify");
});

test("upheld cases and rejections with enough evidence lead to quarantine, with the reasons", () => {
  const t = trustScore({ completes: 6, classified: { CLEAN: 2, SUSPICIOUS: 2 }, rejections: 2, cases: [{ status: "upheld" }, { status: "upheld" }, { status: "upheld" }] });
  assert.ok(t.score < 30, String(t.score));
  assert.equal(t.action, "quarantine");
  assert.ok(t.components.some((c) => /3 fraud cases were upheld/.test(c.sentence)));
});

test("standing risk caps trust; an open case means watch; a quarantined identity stays quarantined", () => {
  const capped = trustScore({ completes: 40, classified: { CLEAN: 40 }, standingRisk: 60 });
  assert.equal(capped.score, 70);
  assert.ok(capped.components.some((c) => c.effect === "cap"));
  assert.equal(trustScore({ completes: 20, classified: { CLEAN: 20 }, cases: [{ status: "open" }] }).action, "watch");
  assert.equal(trustScore({ completes: 20, classified: { CLEAN: 20 }, status: "quarantined" }).action, "quarantine");
});

test("a cleared case counts in the person's favour", () => {
  const before = trustScore({ completes: 5, classified: { CLEAN: 4, REVIEW: 1 } });
  const after = trustScore({ completes: 5, classified: { CLEAN: 4, REVIEW: 1 }, cases: [{ status: "cleared" }] });
  assert.ok(after.score > before.score);
});
