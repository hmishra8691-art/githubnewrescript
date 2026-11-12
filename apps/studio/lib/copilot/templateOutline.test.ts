/**
 * A SURVEY MADE FROM A RESEARCH TEMPLATE TELLS INTELLIGENT MODE ITS METHOD (2026-11-12).
 * The template's guide travels in the survey's own research plan; the outline the copilot reads on every turn
 * carries the methodology and the "keep intact" rules — so "make this CBC about electric vehicles" is answered
 * knowing that levels live in the design and the holdouts stay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { advancedTemplates, findSurveyTemplate } from "@rescript/templates";
import { copilotOutline } from "./outline.ts";

test("the outline of every advanced template carries its methodology and what to keep intact", () => {
  for (const t of advancedTemplates()) {
    const def = t.build("o");
    const outline = copilotOutline(def, {});
    const text = typeof outline === "string" ? outline : JSON.stringify(outline);
    assert.ok(text.includes("methodology: "), `${t.key}: methodology`);
    assert.ok(text.includes("Method — keep intact: "), `${t.key}: the rules for changing it`);
    assert.ok(text.includes(t.guide!.whenEditing.slice(0, 60)), `${t.key}: the guide's own words`);
    assert.ok(/fictional/i.test(text), `${t.key}: says its content is fictional`);
  }
});

test("the conjoint template says where its levels live, in the words the copilot needs", () => {
  const text = JSON.stringify(copilotOutline(findSurveyTemplate("adv_cbc")!.build("o"), {}));
  assert.match(text, /Change attributes or levels in the DESIGN, then regenerate/);
  assert.match(text, /Keep at least two holdout tasks/);
});

test("a survey with no methodology or assumptions has an outline without those words", () => {
  const def = findSurveyTemplate("nps_relationship")!.build("o");
  assert.ok(!JSON.stringify(copilotOutline(def, {})).includes("method rules and assumptions"));
});
