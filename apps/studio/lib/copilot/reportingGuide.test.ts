import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORTING_GUIDE } from "./reportingGuide.ts";
import { reportingIntent } from "./prompt.ts";
import { COPILOT_STABLE_GUIDES } from "../aiPromptCache.ts";

/* engineer B's guide, wired by the orchestrator (2026-10-17): sent with document and report requests only, cached like the other guides */
test("reporting guide: sent for document / report / chart requests, not for ordinary edits", () => {
  for (const t of ["Prepare a Word research plan", "update the Word document", "Create a premium executive report with brand comparison charts", "make a findings deck", "download the statistical analysis plan", "इसकी रिपोर्ट बनाओ"]) assert.equal(reportingIntent(t), true, t);
  for (const t of ["Make Q3 required", "Add a hypothesis about price sensitivity", "Show Q5 only when Q3 = Yes", "Translate the survey into Hindi", "Make the options slide in", "Add a slide-in animation to Q2"]) assert.equal(reportingIntent(t), false, t);
});

test("reporting guide: in the cached prefix list, tells the model it cannot make files or invent numbers, and stays short", () => {
  assert.ok(COPILOT_STABLE_GUIDES.includes(REPORTING_GUIDE));
  assert.match(REPORTING_GUIDE, /You cannot create, attach or link files/);
  assert.match(REPORTING_GUIDE, /Never state a number/);
  assert.ok(REPORTING_GUIDE.length < 2_500, `${REPORTING_GUIDE.length}`);
  /* 2026-10-18: kept documents and report themes — the model is told what the engine does, never to claim it did it */
  assert.match(REPORTING_GUIDE, /Documents are kept once made/);
  assert.match(REPORTING_GUIDE, /changes styling only — never wording, numbers or findings/);
  for (const n of ["Executive Research", "Healthcare Analytics", "Brand Performance", "Consumer Insights", "Academic Research"]) assert.ok(REPORTING_GUIDE.includes(n), n);
});
