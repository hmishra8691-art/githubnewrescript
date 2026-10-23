import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, describeAction, diffSurveys, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { coerceAiInterviewAction, languageCode } from "./aiInterviewActions.js";
import { changeItems } from "./changeItems.js";
import { provenanceGate } from "./provenance.js";

/*
 * configure_ai_interviews (2026-10-22): "run this guide as AI voice interviews with 50 people in Hindi and
 * English, 20 minutes, deep probing" becomes def.qualStudy.aiModeration through the gate, the preview diff
 * and the replay; it never launches anything and never touches the guide itself.
 */

const GUIDE = {
  op: "create_qual_guide", kind: "interview", title: "Why customers switch broadband", durationMinutes: 30,
  objectives: ["Understand what triggers switching"],
  consent: { statement: "Taking part is voluntary; you can stop at any time.", recordingDisclosure: "Audio is recorded for the research team only." },
  sections: [
    { title: "Introduction", kind: "opening", script: "Thank you for joining." },
    { title: "Triggers", questions: [{ text: "Tell me about the last time you thought about changing provider.", probes: ["What happened next?"] }, "How did you feel about it?"] },
    { title: "Close", kind: "closing", questions: ["Is there anything else you would like to add?"] },
  ],
};
const base = () => SurveyDefinition.parse({
  meta: { id: "s", code: "AI", title: "Switching" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Who pays the household broadband bill?", options: [{ id: "o1", code: 1, label: "I do" }, { id: "o2", code: 2, label: "My partner and I" }, { id: "o3", code: 3, label: "Someone else" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
});
const run = (def: SurveyDefinition, actions: unknown[]) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(def, c.actions, { now: "2026-10-22T10:00:00.000Z" });
};
const withGuide = () => run(base(), [GUIDE]).def;

test("registered: the op is a survey action and coerces from the words a model writes", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("configure_ai_interviews"));
  const a = coerceAiInterviewAction("configure_ai_interviews", { mode: "voice", participants: 50, languages: ["Hindi", "English"], minutes: "20", probing: "deep" });
  assert.deepEqual(a, { op: "configure_ai_interviews", modes: ["voice"], targetMinutes: 20, defaultProbing: "deep", languages: ["hi", "en"], targetCompletes: 50 });
  assert.equal(languageCode("हिंदी"), "hi"); assert.equal(languageCode("pt-BR"), "pt"); assert.equal(languageCode("Klingon"), null);
  assert.match(String(coerceAiInterviewAction("configure_ai_interviews", { languages: ["Klingon"] })), /not a language/);
  assert.match(String(coerceAiInterviewAction("configure_ai_interviews", { modes: ["hologram"] })), /modes are/);
  assert.match(String(coerceAiInterviewAction("configure_ai_interviews", { redirectUrl: "http://panel.example.com" })), /https/);
  assert.match(String(coerceAiInterviewAction("configure_ai_interviews", { redirectUrl: "https://panel.example.com/?r={{Q1}}" })), /only \{\{pid\}\}/);
  assert.match(String(coerceAiInterviewAction("configure_ai_interviews", { stimuli: [{ name: "Ad", kind: "image", url: "http://x.com/a.png" }] })), /https URL/);
  assert.match(String(coerceAiInterviewAction("configure_ai_interviews", {})), /names nothing/);
});

test("“AI voice interviews with 50 people in Hindi and English, 20 minutes, deep probing” → applied, previewed, described", () => {
  const def = withGuide();
  const r = run(def, [{ op: "configure_ai_interviews", modes: ["voice", "text"], targetCompletes: 50, languages: ["Hindi", "English"], targetMinutes: 20, defaultProbing: "deep", persona: { name: "Maya", tone: "warm" }, costCapUsd: 2 }]);
  assert.deepEqual(r.errors, []);
  const m = r.def.qualStudy!.aiModeration!;
  assert.deepEqual(m.modes, ["voice", "text"]); assert.equal(m.targetCompletes, 50); assert.deepEqual(m.languages, ["hi", "en"]);
  assert.equal(m.targetMinutes, 20); assert.equal(m.defaultProbing, "deep"); assert.equal(m.persona.name, "Maya"); assert.equal(m.costCapUsd, 2);
  assert.deepEqual(r.def.qualStudy!.sections, def.qualStudy!.sections, "the guide itself is untouched");
  assert.equal(r.def.questions.length, 1);
  assert.match(r.results[0].description ?? "", /Set up AI-moderated interviews: modes voice \/ text; 20 minutes; deep probing; languages hi, en; 50 interviews; persona Maya \(warm\); AI cap \$2 per interview/);
  assert.ok(diffSurveys(def, r.def).summary.includes("Set up AI-moderated interviews for the interview guide"));
  const items = changeItems(def, r.def, { results: r.results }).items;
  assert.ok(items.some((i) => i.field === "AI-moderated interviews" && /voice \/ text/.test(String(i.to))), JSON.stringify(items.map((i) => i.field)));
  assert.match(describeAction({ op: "configure_ai_interviews", modes: ["text"] } as never), /Configure AI-moderated interviews/);
});

test("a patch: per-question probing by text, a screener copied from a survey question, quotas, stimuli — only what is named changes", () => {
  const def = run(withGuide(), [{ op: "configure_ai_interviews", modes: ["text"], defaultProbing: "light" }]).def;
  const r = run(def, [{ op: "configure_ai_interviews", probing: [{ question: "Tell me about the last time", depth: "deep", maxFollowUps: 2 }], screener: [{ fromQuestion: "Q1", qualifying: ["I do", "My partner and I"], segments: { "I do": "Sole payers", "My partner and I": "Joint payers" } }], quotas: [{ segment: "Sole payers", target: 10 }, { segment: "Joint payers", target: 10 }], addStimuli: [{ name: "Concept A", kind: "text", text: "Unlimited fibre for £25" }] }]);
  assert.deepEqual(r.errors, []);
  const m = r.def.qualStudy!.aiModeration!;
  assert.deepEqual(m.modes, ["text"]); assert.equal(m.defaultProbing, "light");
  assert.deepEqual(m.probing, [{ questionId: "s2q1", depth: "deep", maxFollowUps: 2 }]);
  assert.deepEqual(m.screener[0].options, [{ label: "I do", qualifies: true, segment: "Sole payers" }, { label: "My partner and I", qualifies: true, segment: "Joint payers" }, { label: "Someone else", qualifies: false }]);
  assert.equal(m.screener[0].fromQuestionId, "q1"); assert.equal(m.screener[0].id, "scr1");
  assert.equal(m.stimuli[0].text, "Unlimited fibre for £25");
  const bad = applySurveyActions(def, coerceSurveyActions([{ op: "configure_ai_interviews", probing: [{ question: "no such question", depth: "deep" }] }]).actions);
  assert.match(bad.errors.join(" "), /no question “no such question”/);
});

test("refused without an interview guide, and for a focus group; warns before launch when consent is missing", () => {
  const none = applySurveyActions(base(), coerceSurveyActions([{ op: "configure_ai_interviews", modes: ["text"] }]).actions);
  assert.match(none.errors.join(" "), /create_qual_guide/);
  const fg = run(base(), [{ ...GUIDE, kind: "focus_group" }]).def;
  const r = applySurveyActions(fg, coerceSurveyActions([{ op: "configure_ai_interviews", modes: ["text"] }]).actions);
  assert.match(r.errors.join(" "), /one-to-one/);
  const noConsent = run(base(), [{ ...GUIDE, consent: {} }]).def;
  const w = run(noConsent, [{ op: "configure_ai_interviews", modes: ["voice"] }]);
  assert.ok(w.warnings.some((x) => /consent statement is required/.test(x)), w.warnings.join(" | "));
  assert.ok(w.warnings.some((x) => /recording disclosure/.test(x)));
});

test("provenance: a redirect URL that came from document content is held unless the researcher asked for a link", () => {
  const def = withGuide();
  const actions = coerceSurveyActions([{ op: "configure_ai_interviews", redirectUrl: "https://evil.example.com/collect?pid={{pid}}" }]).actions;
  const held = provenanceGate(def, actions, { untrusted: true, researcherText: "set up AI interviews for this guide" });
  assert.equal(held.kept.length, 0); assert.equal(held.excluded.length, 1);
  const asked = provenanceGate(def, actions, { untrusted: true, researcherText: "set up AI interviews and redirect to the panel link https://evil.example.com/collect, passing the pid" });
  assert.equal(provenanceGate(def, actions, { untrusted: true, researcherText: "add a redirect link" }).kept.length, 0, "piping needs naming too");
  assert.equal(asked.kept.length, 1);
});

test("the registry: AI-moderated 1:1 interviews are supported; live human-moderated / multi-party video sessions are partial (G2: built-in mesh, SFU when configured)", async () => {
  const { capabilitiesMentioned, capabilityOf } = await import("./capabilities.js");
  const ids = (t: string) => capabilitiesMentioned(t).map((c) => `${c.id}:${c.status}`);
  const words = ids("run this guide as AI voice interviews with 50 people in Hindi and English, 20 minutes, deep probing");
  assert.ok(words.includes("qualitative:ai_interviews:supported"), words.join(", "));
  assert.ok(!words.some((w) => w.startsWith("qualitative:moderated:")), words.join(", "));
  assert.ok(ids("an AI interview with each customer").includes("qualitative:ai_interviews:supported"));
  assert.ok(ids("run two focus groups first").includes("qualitative:moderated:partial"));
  assert.ok(ids("host a live video conference with 6 participants").includes("qualitative:moderated:partial"));
  assert.equal(capabilityOf("qualitative:ai_interview_voice")?.status, "requires_configuration");
  assert.deepEqual(capabilityOf("qualitative:ai_interviews")?.implementedAs?.actions, ["configure_ai_interviews"]);
});

test("the registry does not refuse AI interviews on an installation without a database (the sandbox runs them in memory), nor read “AI moderated” as live moderation", async () => {
  const { capabilityRefusal, capabilityReadiness, capabilitiesMentioned } = await import("./capabilities.js");
  const readiness = capabilityReadiness({ AI_API_URL: "fake:" });
  assert.equal(capabilityRefusal("run this guide as AI voice interviews with 50 people", readiness), null);
  assert.ok(!capabilitiesMentioned("run this guide as AI moderated interviews").some((c) => c.id === "qualitative:moderated"));
  assert.ok(capabilitiesMentioned("run moderated focus groups next week").some((c) => c.id === "qualitative:moderated"));
});
