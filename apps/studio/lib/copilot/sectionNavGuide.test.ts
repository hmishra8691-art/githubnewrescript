import { test } from "node:test";
import assert from "node:assert/strict";
import { COPILOT_UX_GUIDE, COPILOT_SYSTEM_PROMPT, uxIntent } from "./prompt.ts";
import { guideForOp } from "./guideSelect.ts";

/** SECTION NAVIGATION (2026-10-30): a navigator request is a settings action from the UX guide, not a script nav bar */
test("navigator requests read as look-and-behaviour, so the UX guide (which documents set_navigation) is sent", () => {
  for (const t of ["add a section navigator", "let respondents jump between sections", "Add a nav bar at the top so students can move freely between subjects"]) {
    assert.equal(uxIntent(t).ux, true, t);
  }
  assert.equal(guideForOp("set_navigation"), "ux");
  assert.ok(COPILOT_UX_GUIDE.includes('"op":"set_navigation"'));
  assert.match(COPILOT_UX_GUIDE, /BUILT-IN navigator[^]*Never build one from a script/);
  assert.match(COPILOT_UX_GUIDE, /rs\.goToSection/);
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800, "the system prompt is untouched by this guidance");
});
