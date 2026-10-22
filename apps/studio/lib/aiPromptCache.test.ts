import test from "node:test";
import assert from "node:assert/strict";
import { COPILOT_ANALYSIS_GUIDE, COPILOT_SYSTEM_PROMPT, COPILOT_UX_GUIDE, copilotUserPrompt, repairPrompt } from "./copilot/prompt.ts";
import { COPILOT_LIST_FILL_GUIDE } from "./copilot/listFillGuide.ts";
import { COPILOT_STABLE_GUIDES, copilotCall, splitStable } from "./aiPromptCache.ts";

/**
 * THE STABLE PREFIX (AI cost audit, 2026-10-17): the guides a copilot request
 * carries become a cacheable system block; the variable text keeps the rest,
 * in order, and nothing is lost or rewritten.
 */
const base = { outline: "Q1 AGE_SCR numeric\nQ2 GENDER single", surveyLanguage: "en", mode: "ux" as const, message: "Add JavaScript on Q3: show 'eligible voter' from 18" };

test("a behaviour request: the UX guide moves to the second system block, the outline and the request stay in the user text", () => {
  const prompt = copilotUserPrompt({ ...base, ux: true, uxOnly: true });
  assert.ok(prompt.includes(COPILOT_UX_GUIDE), "precondition: the prompt carries the guide verbatim");
  const [system, user] = copilotCall(prompt);
  assert.deepEqual(system, [COPILOT_SYSTEM_PROMPT, COPILOT_UX_GUIDE]);
  assert.equal(user.includes(COPILOT_UX_GUIDE), false);
  assert.ok(user.includes("CURRENT SURVEY (outline):\nQ1 AGE_SCR numeric") && user.includes("THIS REQUEST IS LOOK-AND-BEHAVIOUR ONLY") && user.endsWith(`RESEARCHER:\n${base.message}`));
  assert.equal(user.length + COPILOT_UX_GUIDE.length + 2, prompt.length, "only the guide and its blank line left the text");
  assert.equal(user.includes("\n\n\n"), false, "no doubled separator");
});

test("the stable block is the same bytes for two different requests on two different surveys — the cacheable part", () => {
  const a = copilotCall(copilotUserPrompt({ ...base, ux: true }));
  const b = copilotCall(copilotUserPrompt({ ...base, outline: "Q1 BRAND_AWARE multi", message: "Make the options slide in", ux: true, memory: { memory: "theme set", history: [{ role: "user", text: "hi" }] } }));
  assert.deepEqual(a[0], b[0]);
  assert.notEqual(a[1], b[1]);
});

test("several guides: one block, in the prompt's order; a request with none sends the system prompt alone", () => {
  const prompt = copilotUserPrompt({ ...base, mode: "edit", ux: true, analysis: true, listFill: true });
  const [system, user] = copilotCall(prompt);
  assert.deepEqual(system, [COPILOT_SYSTEM_PROMPT, [COPILOT_UX_GUIDE, COPILOT_ANALYSIS_GUIDE, COPILOT_LIST_FILL_GUIDE].join("\n\n")]);
  for (const g of COPILOT_STABLE_GUIDES) assert.equal(user.includes(g), false);
  const plain = copilotUserPrompt({ ...base, mode: "edit" });
  assert.deepEqual(copilotCall(plain), [[COPILOT_SYSTEM_PROMPT], plain], "nothing to lift: unchanged");
});

test("every guide copilotUserPrompt can add is found verbatim (a wording change that breaks caching fails here)", () => {
  const all = copilotUserPrompt({ ...base, mode: "edit", ux: true, analysis: true, translation: true, quota: true, listFill: true, methods: true, findings: true, researchPlan: true, qual: true, aiInterview: true, reporting: true });
  const { stable } = splitStable(all, COPILOT_STABLE_GUIDES);
  assert.equal(stable.length, COPILOT_STABLE_GUIDES.length);
});

test("the repair prompt: the guide it adds is lifted too, the previous answer and the refusals stay", () => {
  const prompt = copilotUserPrompt({ ...base, mode: "edit" });
  const rp = repairPrompt({ prompt, raw: { actions: [{ op: "create_behavior" }] }, refused: ["create_behavior: selector matches nothing"], total: 1, uxGuideSent: false, ops: ["create_behavior"] });
  assert.equal(rp.addedUxGuide, true);
  const [system, user] = copilotCall(rp.text);
  assert.deepEqual(system, [COPILOT_SYSTEM_PROMPT, COPILOT_UX_GUIDE]);
  assert.ok(user.startsWith(prompt) && user.includes("YOUR PREVIOUS ANSWER:") && user.includes("selector matches nothing"));
});

test("splitStable: separators are handled at the start, the middle and the end; absent and empty guides are ignored", () => {
  assert.deepEqual(splitStable("G\n\nrest", ["G"]), { stable: ["G"], variable: "rest" });
  assert.deepEqual(splitStable("a\n\nG\n\nb", ["G"]), { stable: ["G"], variable: "a\n\nb" });
  assert.deepEqual(splitStable("a\n\nG", ["G"]), { stable: ["G"], variable: "a" });
  assert.deepEqual(splitStable("abc", ["X", ""]), { stable: [], variable: "abc" });
});
