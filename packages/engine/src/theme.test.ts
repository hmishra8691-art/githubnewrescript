import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, Branding } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys } from "./surveyActions.js";
import { applyThemePatch, diffTheme, withoutPresentation } from "./theme.js";

/**
 * THE COPILOT'S THEME IS THE SURVEY'S BRANDING — the same settings the
 * Branding panel edits, gated field by field, and a look-only change.
 */
const base = () => applySurveyActions(SurveyDefinition.parse({ meta: { id: "t", code: "S", title: "Theme" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] }), [
  { op: "create_block", title: "One" },
  { op: "create_question", ref: "Q", type: "single", text: "Pick", options: ["A", "B"] },
], { ids: (p) => `${p}_1` }).def;

test("a theme patch: every value through its gate, the result through the Branding schema", () => {
  const b = Branding.parse({});
  const r = applyThemePatch(b, {
    colors: { primary: "#c9a227", background: "#0b0b0f", surface: "rgba(20,20,28,.92)", text: "#f5f1e6", bogus: "#fff" },
    typography: { fontFamily: "'Playfair Display', Georgia, serif", headingWeight: 700, lineHeight: "1.6", baseSize: "huge" },
    background: { image: "https://cdn.example.com/bg.jpg", overlay: "rgba(0,0,0,.55)", size: "cover" },
    appearance: { optionStyle: "cards", controlStyle: "custom", shadow: "medium", selectedTint: 18 },
    responsive: { mobile: { baseSize: "15px", cardPadding: "16px" }, watch: {} },
    logoUrl: "javascript:alert(1)",
    footerHtml: "<p onclick=\"x()\">hi</p>",
    layout: { cardStyle: "glass" },
  });
  assert.equal(r.branding.colors.primary, "#c9a227");
  assert.equal(r.branding.background?.image, "https://cdn.example.com/bg.jpg");
  assert.equal(r.branding.appearance?.optionStyle, "cards");
  assert.equal(r.branding.responsive?.mobile?.baseSize, "15px");
  assert.equal(r.branding.typography.baseSize, "16px", "a bad value leaves the old one");
  const e = r.errors.join("\n");
  for (const re of [/colors\.bogus is not a theme setting/, /typography\.baseSize is not a length/, /responsive\.watch is not a device/, /logoUrl must load from https/, /footerHtml may not contain/, /layout\.cardStyle must be one of flat, card, line/]) assert.match(e, re);
  assert.ok(r.changes.includes("primary colour: #2563eb → #c9a227"), r.changes.join("\n"));
  assert.ok(r.changes.includes("background image: default → https://cdn.example.com/bg.jpg"));
  // null resets
  const back = applyThemePatch(r.branding, { background: null, responsive: { mobile: null } });
  assert.equal(back.branding.background, undefined);
  assert.equal(back.branding.responsive?.mobile, undefined);
  const logo = applyThemePatch({ ...r.branding, logoUrl: "https://cdn.example.com/logo.png" } as never, { logoUrl: null });
  assert.equal(logo.branding.logoUrl, undefined, "a top-level setting resets with null");
  const colours = applyThemePatch(r.branding, { colors: null });
  assert.match(colours.errors.join(" "), /colors cannot be removed, only changed/);
  assert.equal(colours.branding.colors.primary, "#c9a227");
  assert.deepEqual(diffTheme(b, b), []);
});

test("set_theme and set_custom_html are look-only: allowed in a look-only request, the structure proven unchanged", () => {
  const d = base();
  const c = coerceSurveyActions([
    { op: "set_theme", label: "Premium dark", colors: { primary: "#c9a227", background: "#0b0b0f" }, appearance: { optionStyle: "cards" }, background: { image: "https://cdn.example.com/bg.jpg", overlay: "rgba(0,0,0,.5)" } },
    { op: "set_custom_html", target: "Q1", html: "<p class=\"note\">Pick the one you use most.</p>" },
    { op: "set_custom_html", target: "Q1", html: "<img src=x onerror=alert(1)>" },
  ]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(d, c.actions, { uxOnly: true });
  assert.equal(r.results[0].ok, true); assert.equal(r.results[1].ok, true);
  assert.match(r.errors.join(" "), /custom HTML may not contain scripts, frames, styles, event handlers/);
  assert.equal(r.uxOnly, true); assert.equal(r.structureUnchanged, true);
  assert.equal(r.def.branding.colors.primary, "#c9a227");
  assert.equal(r.def.questions[0].customHtml, "<p class=\"note\">Pick the one you use most.</p>");
  assert.match(r.results[0].description, /Theme “Premium dark”: primary colour: #2563eb → #c9a227; page background colour: #f8fafc → #0b0b0f/);
  const diff = diffSurveys(d, r.def);
  assert.ok(diff.summary.some((l) => /^Theme: primary colour/.test(l)), diff.summary.join("\n"));
  // structure is not presentation: a label change is
  const labels = applySurveyActions(d, coerceSurveyActions([{ op: "set_theme", buttons: { nextLabel: "Continue" } }]).actions);
  assert.equal(labels.structureUnchanged, false, "button labels are wording the respondent reads, not look");
  assert.deepEqual(withoutPresentation(r.def), withoutPresentation(d));
});
