import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys } from "@rescript/engine";
import { COPILOT_QUAL_STUDY_GUIDE } from "./qualStudyGuide.ts";
import { COPILOT_QUAL_GUIDE, qualIntent } from "./researchGuide.ts";
import { copilotUserPrompt } from "./prompt.ts";

/*
 * THE MODERATED-STUDY GUIDE (2026-10-18): it rides inside the qualitative guide, its worked examples
 * apply as written — create, then a PATCH that changes one section and nothing else — and it never
 * lets the model claim a live session.
 */

const lines = (g: string) => g.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l));
const empty = () => SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "Guide" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });

test("sent with qualitative requests: the qualitative guide ends with it; moderated / transcript / codebook requests ask for it", () => {
  assert.ok(COPILOT_QUAL_GUIDE.endsWith(COPILOT_QUAL_STUDY_GUIDE));
  for (const m of ["Create a 60-minute interview guide for moderated IDIs", "a focus-group discussion guide about loyalty", "propose a codebook for the transcripts"]) {
    assert.ok(qualIntent(m), m);
    assert.ok(copilotUserPrompt({ outline: "(survey)", surveyLanguage: "English", mode: "edit", message: m }).includes("create_qual_guide"), m);
  }
  /* G2 2026-10-22: live human-moderated sessions now run in the browser (Live sessions) — the guide says so, and that booking is a preview card */
  for (const w of ["RUNS them live in the browser", "Live sessions", "never say a session is booked", "configure_ai_interviews", "a PATCH: name only what changes", "never population percentages", "every quote must be verbatim"]) assert.ok(COPILOT_QUAL_STUDY_GUIDE.includes(w), w);
});

test("the worked examples: create an interview guide, then add one question to one section — every other part is unchanged", () => {
  const [create, update] = lines(COPILOT_QUAL_STUDY_GUIDE);
  const c1 = coerceSurveyActions([create]);
  assert.deepEqual(c1.rejected, []);
  const r1 = applySurveyActions(empty(), c1.actions);
  assert.deepEqual(r1.errors, []);
  const g = r1.def.qualStudy!;
  assert.deepEqual(g.sections.map((s) => s.kind), ["opening", "main", "closing"]);
  assert.equal(g.sections[1].questions[0].conditionalProbes[0].ifMentions, "price");
  const c2 = coerceSurveyActions([update]);
  assert.deepEqual(c2.rejected, []);
  const r2 = applySurveyActions(r1.def, c2.actions);
  assert.deepEqual(r2.errors, []);
  const h = r2.def.qualStudy!;
  assert.deepEqual(h.sections[1].questions.map((q) => q.text), ["Tell me about the last time you thought about changing provider.", "Who else had a say in the decision?"]);
  assert.deepEqual(h.sections[0], g.sections[0]);
  assert.deepEqual(h.sections[2], g.sections[2]);
  assert.deepEqual(diffSurveys(r1.def, r2.def).summary, ["Change guide section “Switching triggers”"]);
  assert.equal(r2.def.questions.length, 0, "the moderated guide is not the questionnaire");
});
