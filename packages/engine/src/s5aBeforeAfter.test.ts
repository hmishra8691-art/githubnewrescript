import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { beforeAfterView, clampPosition, stepPosition, DwellClock, beforeAfterParadata, beforeAfterKeys, lintBeforeAfter } from "./beforeAfter.js";
import { variantCatalogue } from "./capabilityRegistry.js";
import { capabilitiesMentioned } from "./capabilities.js";
const findCapability = (t: string) => capabilitiesMentioned(t)[0] as { status: string; note?: string } | undefined;

/* S5a item 2 (MM2-06): the before / after comparison slider */

const created = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "comparison.before_after", text: "Compare the redesign" },
  ] as SurveyAction[]);
})();

test("the variant exists in the comparison family, numeric, with its defaults", () => {
  const v = variantRegistry.get("comparison.before_after");
  assert.ok(v);
  assert.equal(v!.family, "comparison");
  assert.equal(v!.baseType, "numeric");
  assert.equal(v!.renderer, "beforeafter");
  assert.ok(created.results.every((r) => r.ok), JSON.stringify(created.results));
  const q = created.def.questions[0];
  assert.equal(q.variant, "comparison.before_after");
  assert.equal(q.settings.beforeAfter?.startPosition, 50);
  const settable = variantCatalogue().find((x) => x.id === "comparison.before_after")!.settings.map((s) => s.key);
  assert.ok(settable.includes("beforeAfter") && settable.includes("recordPosition"), settable.join(","));
});

test("IM: set_question_media with two items gives before and after", () => {
  const c = coerceSurveyActions([{ op: "set_question_media", target: "Q1", items: [{ url: "https://cdn.example.com/old.jpg", alt: "Old pack" }, { url: "https://cdn.example.com/new.jpg", alt: "New pack" }] }]);
  const r = applySurveyActions(created.def, c.actions);
  assert.ok(r.results[0].ok, r.results[0].error);
  const v = beforeAfterView(r.def.questions[0]);
  assert.equal(v.before?.url, "https://cdn.example.com/old.jpg");
  assert.equal(v.after?.alt, "New pack");
  assert.equal(v.askRating, true);
  assert.deepEqual([v.min, v.max], [1, 5]);
  assert.deepEqual(lintBeforeAfter(r.def.questions[0]), []);
  assert.match(lintBeforeAfter(created.def.questions[0])[0], /needs two images/);
});

test("divider: bounded, arrows move 5 %, Home / End", () => {
  assert.equal(clampPosition(-3), 0);
  assert.equal(clampPosition(140), 100);
  assert.equal(clampPosition("x"), 50);
  assert.equal(stepPosition(50, "ArrowRight"), 55);
  assert.equal(stepPosition(50, "ArrowLeft"), 45);
  assert.equal(stepPosition(2, "ArrowLeft"), 0);
  assert.equal(stepPosition(50, "End"), 100);
  assert.equal(stepPosition(50, "Home"), 0);
  assert.equal(stepPosition(50, "PageUp"), 75);
  assert.equal(stepPosition(50, "a"), null);
});

test("dwell per side and the paradata keys", () => {
  const d = new DwellClock(50, 0);
  d.move(20, 3000); // 3 s on the before side (≥ 50)
  d.move(80, 5000); // 2 s on the after side
  const s = d.seconds(6000); // 1 s more before
  assert.deepEqual(s, { before: 4, after: 2 });
  assert.deepEqual(beforeAfterKeys("q 7"), { position: "BA_Q_7_POSITION", dwellBefore: "BA_Q_7_DWELL_BEFORE", dwellAfter: "BA_Q_7_DWELL_AFTER" });
  assert.deepEqual(beforeAfterParadata("Q7", 62.34, s), { BA_Q7_POSITION: 62.3, BA_Q7_DWELL_BEFORE: 4, BA_Q7_DWELL_AFTER: 2 });
});

test("position as the answer: bounds 0–100, lint says so when they are not", () => {
  const q = { code: "Q9", text: "x", settings: { mediaItems: [{ id: "a", url: "https://a/x.jpg" }, { id: "b", url: "https://a/y.jpg" }], beforeAfter: { askRating: false }, minValue: 1, maxValue: 5 } };
  assert.deepEqual([beforeAfterView(q as never).min, beforeAfterView(q as never).max], [0, 100]);
  assert.match(lintBeforeAfter(q as never).join(" "), /minValue 0 and maxValue 100/);
});

test("capabilities: before/after supported; 360 not supported with the alternative", () => {
  assert.equal(findCapability("before and after slider")?.status ?? "missing", "supported");
  const p = findCapability("360 panorama");
  assert.equal(p?.status, "not_supported");
  assert.match(p?.note ?? "", /Pannellum|Photo Sphere/);
});
