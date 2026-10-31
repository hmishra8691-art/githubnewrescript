import { test } from "node:test";
import assert from "node:assert/strict";
import type { CustomScript, UxAnimation, UxBehavior, UxStyle } from "@rescript/schema";
import { duplicateLogicScript, duplicateUxItem } from "./manage.ts";

/* S3b item 2 (MM-06): duplicate — new id, "(copy)" name, scripts switched off so the two never both run */

const beh: UxBehavior = { id: "uxb_1", label: "Highlight", target: { kind: "question", questionId: "q1" }, effects: [], script: "rs.addClass('self','hl');", source: "question_custom_js", createdAt: "2026-01-01" };
const style: UxStyle = { id: "uxs_1", label: "Cards", target: { kind: "survey" }, rules: [{ declarations: { "border-radius": "8px" } }] } as UxStyle;
const anim = { id: "uxa_1", label: "Fade", target: { kind: "survey" }, preset: "fade-up", trigger: "appear", durationMs: 400, delayMs: 0, easing: "ease-out", staggerMs: 0, iterations: 1 } as UxAnimation;
const logic: CustomScript = { id: "script_1", name: "Total", scope: "survey", event: "on_change", code: "setCalc('T', 1);", enabled: true };

test("a behaviour script: new id, (copy), switched off, same code, not marked as moved Custom code; the original is untouched", () => {
  const c = duplicateUxItem("behavior", beh, "uxb_2", "2026-10-31");
  assert.equal(c.id, "uxb_2");
  assert.equal(c.label, "Highlight (copy)");
  assert.equal(c.enabled, false);
  assert.equal(c.script, beh.script);
  assert.equal(c.source, undefined);
  assert.equal(c.createdAt, "2026-10-31");
  assert.equal(beh.enabled, undefined);
  assert.equal(beh.id, "uxb_1");
  c.target.questionId = "qX";
  assert.equal(beh.target.questionId, "q1", "a deep copy");
});

test("a copy of a copy is numbered; long names stay within the limit", () => {
  const c1 = duplicateUxItem("behavior", beh, "a");
  const c2 = duplicateUxItem("behavior", c1, "b");
  const c3 = duplicateUxItem("behavior", c2, "c");
  assert.deepEqual([c2.label, c3.label], ["Highlight (copy 2)", "Highlight (copy 3)"]);
  const long = duplicateUxItem("behavior", { ...beh, label: "x".repeat(160) }, "d");
  assert.ok(long.label.length <= 160 && long.label.endsWith("(copy)"));
});

test("styles and animations: copied, no switch (they apply at once)", () => {
  const s = duplicateUxItem("style", style, "uxs_2");
  assert.equal(s.label, "Cards (copy)");
  assert.equal((s as unknown as UxBehavior).enabled, undefined);
  assert.deepEqual(s.rules, style.rules);
  const a = duplicateUxItem("animation", anim, "uxa_2");
  assert.equal(a.id, "uxa_2");
  assert.equal(a.preset, "fade-up");
});

test("a logic script: new id, (copy), switched off", () => {
  const c = duplicateLogicScript(logic, "script_2");
  assert.deepEqual([c.id, c.name, c.enabled, c.code, c.event], ["script_2", "Total (copy)", false, logic.code, "on_change"]);
  assert.equal(logic.enabled, true);
});
