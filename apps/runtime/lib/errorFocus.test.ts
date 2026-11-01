import { test } from "node:test";
import assert from "node:assert/strict";
import { firstInvalidTarget, prefersReducedMotion } from "./errorFocus.ts";

const PAGE = ["q1", "q2", "q3"];

test("D19: no errors, no target", () => {
  assert.equal(firstInvalidTarget([], PAGE), null);
});

test("D19: the first invalid question in PAGE order, not in error order", () => {
  // built-in errors come before script errors in the list; the page is read top to bottom
  const t = firstInvalidTarget([{ questionId: "q3" }, { questionId: "q2" }], PAGE);
  assert.deepEqual(t, { kind: "question", questionId: "q2" });
});

test("D19: blocking errors win over warnings; warnings alone are focused when they refused the page", () => {
  assert.deepEqual(
    firstInvalidTarget([{ questionId: "q1", severity: "warning" }, { questionId: "q3", severity: "error" }], PAGE),
    { kind: "question", questionId: "q3" },
  );
  assert.deepEqual(
    firstInvalidTarget([{ questionId: "q2", severity: "warning" }, { questionId: "q1", severity: "warning" }], PAGE),
    { kind: "question", questionId: "q1" },
  );
});

test("D19: a page-level message (no question, or one not on this page) focuses the banner", () => {
  assert.deepEqual(firstInvalidTarget([{ questionId: "" }], PAGE), { kind: "banner" });
  assert.deepEqual(firstInvalidTarget([{ questionId: "elsewhere" }], PAGE), { kind: "banner" });
});

test("D19: a question error beats a page-level one (the banner is announced anyway)", () => {
  assert.deepEqual(firstInvalidTarget([{ questionId: "" }, { questionId: "q2" }], PAGE), { kind: "question", questionId: "q2" });
});

test("D19: a blocking page-level error beats a question warning", () => {
  assert.deepEqual(firstInvalidTarget([{ questionId: "q1", severity: "warning" }, { questionId: "" }], PAGE), { kind: "banner" });
});

test("D19: conversational mode — the page is the one question on screen", () => {
  assert.deepEqual(firstInvalidTarget([{ questionId: "q2" }], ["q2"]), { kind: "question", questionId: "q2" });
});

test("D19: reduced motion is read safely", () => {
  assert.equal(prefersReducedMotion(undefined), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error("x"); } }), false);
});
