import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { COPILOT_AI_INTERVIEW_GUIDE, aiInterviewIntent } from "./aiInterviewGuide.ts";
import { COPILOT_QUAL_GUIDE } from "./researchGuide.ts";
import { COPILOT_SYSTEM_PROMPT, copilotUserPrompt } from "./prompt.ts";
import { COPILOT_STABLE_GUIDES, copilotCall } from "../aiPromptCache.ts";

/*
 * THE AI-INTERVIEW GUIDE (2026-10-22): sent with requests about AI interviews only, cached like every guide,
 * its worked examples apply as written on an interview guide, and it never lets the model say a study is live.
 */
const lines = (g: string) => g.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l));
const withGuide = () => {
  const def = SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "Guide" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const c = coerceSurveyActions([{ op: "create_qual_guide", kind: "interview", consent: { statement: "Voluntary.", recordingDisclosure: "Audio recorded." }, sections: [{ title: "Intro", kind: "opening" }, { title: "Triggers", questions: ["Tell me about switching."] }, { title: "Close", kind: "closing", questions: ["Anything else?"] }] }]);
  return applySurveyActions(def, c.actions).def;
};

test("sent when a request is about AI interviews, not otherwise; cached as a stable block; the system prompt is untouched", () => {
  for (const m of ["Run this guide as AI voice interviews with 50 people in Hindi and English, 20 minutes, deep probing", "set up AI-moderated interviews", "an AI interviewer for each participant", "asynchronous interviews at scale"]) {
    assert.ok(aiInterviewIntent(m), m);
    const p = copilotUserPrompt({ outline: "(survey)", surveyLanguage: "English", mode: "edit", message: m });
    assert.ok(p.includes("configure_ai_interviews"), m);
    const [system] = copilotCall(p);
    assert.ok(system.some((b) => b.includes(COPILOT_AI_INTERVIEW_GUIDE)), "lifted into the cached prefix");
  }
  for (const m of ["Add a question about price", "make Q3 required", "interview guide about switching"]) assert.ok(!aiInterviewIntent(m), m);
  assert.ok(COPILOT_STABLE_GUIDES.includes(COPILOT_AI_INTERVIEW_GUIDE));
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800);
  assert.ok(COPILOT_AI_INTERVIEW_GUIDE.length < 3_000, `${COPILOT_AI_INTERVIEW_GUIDE.length}`);
  assert.ok(COPILOT_QUAL_GUIDE.length < 5_600, `qualitative guide ${COPILOT_QUAL_GUIDE.length}`);
  for (const w of ["never say it is launched or live", "NOT supported", "live human-moderated sessions", "multi-party video calls", "consent.statement"]) assert.ok(COPILOT_AI_INTERVIEW_GUIDE.includes(w), w);
});

test("the worked examples apply as written on an interview guide", () => {
  const [voice, screener] = lines(COPILOT_AI_INTERVIEW_GUIDE);
  const c = coerceSurveyActions([voice, screener]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(withGuide(), c.actions);
  assert.deepEqual(r.errors, []);
  const m = r.def.qualStudy!.aiModeration!;
  assert.deepEqual(m.languages, ["hi", "en"]); assert.equal(m.targetCompletes, 50); assert.equal(m.defaultProbing, "deep");
  assert.equal(m.screener[0].options[1].qualifies, false); assert.deepEqual(m.quotas, [{ segment: "Payers", target: 50 }]);
});
