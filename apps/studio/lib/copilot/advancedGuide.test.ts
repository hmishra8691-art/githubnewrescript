import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_METHODS } from "@rescript/schema";
import { COPILOT_ANALYSIS_GUIDE, COPILOT_SYSTEM_PROMPT } from "./prompt.ts";
import { COPILOT_METHODS_GUIDE } from "./methodsGuide.ts";

/*
 * ADVANCED MODELS IN THE COPILOT'S GUIDES (2026-10-22): HB, latent class and SEM are planned like any test, with
 * their options; the mediation bootstrap, ω, Gabor–Granger and the re-run policy are documented; the guide never
 * says to keep them out of the plan any more; every method the guide names is one the schema accepts; and the
 * system prompt itself did not grow (the guidance lives in the guides).
 */
test("the analysis guide plans the advanced models with their options, and names only methods the schema has", () => {
  const g = COPILOT_ANALYSIS_GUIDE;
  for (const w of ["hb:", "latent_class:", "sem:", "\"bootstrap\":5000", "\"omega\":true", "\"method\":\"gabor_granger\"", "\"minClasses\":2", "\"hypothesisPaths\"", "\"advancedRerun\":{\"mode\":\"threshold\"", "Covariates are not estimated", "refuses with the reason"]) assert.ok(g.includes(w), w);
  assert.ok(!/never plan them/.test(g), "the old 'never plan them' line is gone");
  const listed = /Methods the platform runs: ([^.]+)\./.exec(g)![1].split(",").map((m) => m.trim().replace(/\s*\(.*$/, ""));
  for (const m of listed) assert.ok((ANALYSIS_METHODS as readonly string[]).includes(m), `${m} is a schema method`);
  for (const m of ["hb", "latent_class", "sem"]) assert.ok(listed.includes(m), m);
  /* the SEM example's newlines reach the model as the two characters \n inside a JSON string */
  assert.match(g, /"syntax":"TRUST =~ M1 \+ M2 \+ M3\\nINTENT/);
});

test("the methods guide points an HB request at the analysis plan; the system prompt stays under its cap", () => {
  assert.match(COPILOT_METHODS_GUIDE, /"op":"add_analysis_test","method":"hb"/);
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800, `${COPILOT_SYSTEM_PROMPT.length}`);
});
