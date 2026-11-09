import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { briefFromPlan, contextGaps, draftPlanByRules, interviewShape, planToActions, probingFromPlan, readPlan, type InterviewPlan } from "./qualPlanning.js";

const CONTEXT = "We are a mid-size bank. Young professionals aged 25-35 are leaving us for app-only banks. We want to understand why they switch, how they decide which bank to choose, what they feel about our app, and what needs nobody meets today. We will use it to decide what to fix first in the next release.";
const plan = (over: Partial<InterviewPlan> = {}): InterviewPlan => ({
  title: "Why young professionals switch banks", objectives: ["Understand switching triggers", "Map the decision process"], researchQuestions: [], audience: "Professionals aged 25–35 who switched in the last year",
  themes: [
    { name: "Switching triggers", depth: "deep", questions: [{ text: "Tell me about the moment you decided to leave your old bank.", probes: ["What happened just before?"] }] },
    { name: "Choosing a new bank", depth: "deep", questions: [{ text: "Walk me through how you chose your new bank.", probes: ["Who or what influenced you?"] }, { text: "What nearly stopped you?", probes: [] }] },
    { name: "Banking habits", depth: "brief", questions: [{ text: "How do you usually bank day to day?", probes: [] }] },
  ],
  warmUp: ["Tell me a little about yourself."], closing: "Anything else to add?", format: "voice", formatWhy: "stories", expectedInsights: ["The triggers that matter"],
  purpose: "We want to understand how people choose a bank.", invitedBecause: "You recently changed banks.", clarifications: [], source: "model", ...over,
});

test("length and depth are derived from the themes, not fixed: deeper and typed interviews take longer, and an exhausting plan says so", () => {
  const voice = interviewShape(plan());
  assert.ok(voice.minutes >= 15 && voice.minutes <= 25, `${voice.minutes} min`);
  assert.equal(voice.primaryQuestions, 5);
  assert.deepEqual(voice.deep, ["Switching triggers", "Choosing a new bank"]); assert.deepEqual(voice.brief, ["Banking habits"]);
  assert.equal(voice.warnings.length, 0);
  assert.ok(interviewShape(plan({ format: "chat" })).minutes > voice.minutes, "typing is slower than talking");
  const allBrief = interviewShape(plan({ themes: plan().themes.map((t) => ({ ...t, depth: "brief" as const })) }));
  assert.ok(allBrief.minutes < voice.minutes);
  const huge = interviewShape(plan({ themes: Array.from({ length: 7 }, (_, i) => ({ name: `T${i}`, depth: "deep" as const, questions: [{ text: "Q?", probes: [] }, { text: "Q2?", probes: [] }, { text: "Q3?", probes: [] }] })) }));
  assert.ok(huge.warnings.some((w) => /too long|split/.test(w)), huge.warnings.join(" | "));
  assert.ok(huge.warnings.some((w) => /depth everywhere/.test(w)));
});

test("what a brief lacks becomes a question for the researcher; a full brief needs none", () => {
  assert.equal(contextGaps({ context: CONTEXT }).length, 0);
  const thin = contextGaps({ context: "Interviews about our new snack." });
  assert.ok(thin.some((g) => /Who should we interview/.test(g.question)));
  assert.ok(thin.some((g) => /decide or do/.test(g.question)));
  assert.equal(contextGaps({ context: "Interviews about our new snack.", answers: [{ question: "Who?", answer: "Parents of toddlers, to decide whether to launch it nationally because sales are flat" }] }).filter((g) => /Who should|decide or do/.test(g.question)).length, 0);
});

test("without a model the plan is drafted from the researcher's own words, labelled as a rules draft", () => {
  const p = draftPlanByRules({ context: CONTEXT });
  assert.equal(p.source, "rules");
  assert.ok(p.themes.length >= 2, p.themes.map((t) => t.name).join(", "));
  assert.ok(p.themes.some((t) => t.depth === "deep"));
  assert.match(p.audience, /25-35/);
});

test("the model's plan is read defensively: bounded, typed, and null when it has no usable theme", () => {
  assert.equal(readPlan({ title: "x", themes: [] }, { context: "c" }), null);
  const p = readPlan({ title: "T", objectives: ["a"], themes: [{ name: "N", depth: "extreme", questions: ["Why?", { text: "How?", probes: ["Example?"] }] }], format: "telepathy", purpose: "p" }, { context: "c" })!;
  assert.equal(p.themes[0].depth, "medium");
  assert.equal(p.themes[0].questions.length, 2);
  assert.equal(p.format, "hybrid");
  assert.equal(readPlan({ title: "T", themes: [{ name: "N", depth: "deep", questions: ["Q?"] }], format: "voice" }, { context: "c", format: "chat" })!.format, "chat", "the researcher's chosen format wins");
});

test("approving the plan writes the guide and the AI interview settings through the gate; each theme's depth becomes its questions' probing", () => {
  const def0 = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S" }, questions: [], flow: [] });
  const p = plan();
  const c = coerceSurveyActions(planToActions(p, { minutes: 20 }));
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  const r = applySurveyActions(def0, c.actions);
  assert.deepEqual(r.errors, []);
  const q = r.def.qualStudy!;
  assert.equal(q.kind, "interview"); assert.equal(q.durationMinutes, 20);
  assert.equal(q.aiModeration?.format, "voice"); assert.equal(q.aiModeration?.targetMinutes, 20);
  const guideQs = q.sections.flatMap((s) => s.questions.map((x) => ({ id: x.id, text: x.text })));
  const probing = probingFromPlan(p, guideQs);
  assert.equal(probing.length, 4);
  const c2 = coerceSurveyActions([{ op: "configure_ai_interviews", probing }]);
  const r2 = applySurveyActions(r.def, c2.actions);
  assert.deepEqual(r2.errors, []);
  const rules = r2.def.qualStudy!.aiModeration!.probing;
  assert.equal(rules.find((x) => x.questionId === guideQs.find((g) => /moment you decided/.test(g.text))!.id)?.maxFollowUps, 3);
  assert.equal(rules.find((x) => x.questionId === guideQs.find((g) => /day to day/.test(g.text))!.id)?.maxFollowUps, 1);
  const brief = briefFromPlan(p, { context: CONTEXT }, { minutes: 20, approvedAt: "2026-11-08T10:00:00Z" });
  assert.equal(brief.purpose, p.purpose); assert.equal(brief.themes.length, 3); assert.equal(brief.approvedAt, "2026-11-08T10:00:00Z");
});
