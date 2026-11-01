import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { gamificationVariables, newBadges, badgeRule, lintGamification, BADGE_ICON_GLYPHS } from "./gamification.js";
import { runCalculations } from "./flow.js";
import { buildVariableDictionary } from "./variables.js";
import { stripAssessmentSecrets } from "./assessment.js";
import { flattenVariables } from "./flatten.js";

/* S5a item 4 (GA-06, GA-07): points, badges, levels */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Capital of France?", options: ["Paris", "Lyon"] },
    { op: "create_question", type: "single", text: "2 + 2?", options: ["3", "4"] },
    { op: "create_question", type: "single", text: "Enjoying it?", options: ["Yes", "No"] },
  ] as SurveyAction[]).def;
})();
const act = (def: SurveyDefinition, raw: unknown[]) => { const c = coerceSurveyActions(raw); assert.equal(c.rejected.length, 0, JSON.stringify(c.rejected)); const r = applySurveyActions(def, c.actions); assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results)); return r.def; };
const state = (answers: Record<string, unknown>, calculated: Record<string, unknown> = {}) => ({ surveyId: "s", surveyVersion: "1", sessionId: "x", seed: 1, startedAt: "", status: "in_progress", answers, embedded: {}, calculated, flags: [] } as never);

const gamified = () => {
  let d = act(base, [{ op: "set_answer_key", target: "Q1", correct: [1] }, { op: "set_answer_key", target: "Q2", correct: [2] }]);
  d = act(d, [{ op: "set_gamification", perAnswer: 10, perCorrect: 5,
    badges: [{ id: "starter", title: "Starter", icon: "rocket", when: "POINTS_ANSWERED >= 1" }, { id: "brain", title: "Big brain", icon: "lightbulb", when: "POINTS_CORRECT >= 2" }, { id: "thirty", title: "Thirty", minPoints: 30 }],
    levels: [{ name: "Silver", minPoints: 20 }, { name: "Bronze", minPoints: 10 }, { name: "Gold", minPoints: 30 }], hud: { position: "bottom-left" } }]);
  return d;
};

test("points per answer + per correct answer (the answer key); levels by threshold", () => {
  const d = gamified();
  assert.equal(d.gamification?.hud.position, "bottom-left");
  const q = d.questions;
  const v = gamificationVariables(d, state({ [q[0].id]: 1, [q[1].id]: 1 }));
  assert.equal(v.POINTS_ANSWERED, 2);
  assert.equal(v.POINTS_CORRECT, 1);
  assert.equal(v.POINTS, 25);
  assert.equal(v.LEVEL, 2); // Bronze 10, Silver 20 (sorted)
  assert.equal(v.LEVEL_NAME, "Silver");
  assert.equal(v.BADGES, "starter");
  const all = gamificationVariables(d, state({ [q[0].id]: 1, [q[1].id]: 2, [q[2].id]: 1 }));
  assert.equal(all.POINTS, 40);
  assert.equal(all.LEVEL_NAME, "Gold");
  assert.equal(all.BADGES, "starter,brain,thirty");
});

test("badges are one-time: an earned badge stays when its rule stops being true; newBadges names only the new", () => {
  const d = gamified();
  const q = d.questions;
  const s = state({ [q[0].id]: 1, [q[1].id]: 2 });
  runCalculations(d, s as never, "on_change");
  const st = s as unknown as { answers: Record<string, unknown>; calculated: Record<string, unknown> };
  assert.equal(st.calculated.BADGES, "starter,brain,thirty");
  const before = st.calculated.BADGES;
  st.answers[q[1].id] = 1; // now only one correct
  runCalculations(d, s as never, "on_change");
  assert.equal(st.calculated.POINTS_CORRECT, 1);
  assert.equal(st.calculated.BADGES, "starter,brain,thirty", "brain (and thirty) stay earned");
  st.answers[q[2].id] = 1;
  runCalculations(d, s as never, "on_change");
  assert.deepEqual(newBadges(before, st.calculated.BADGES, d.gamification!).map((b) => b.id), []);
  assert.deepEqual(newBadges("starter", "starter,brain", d.gamification!).map((b) => b.title), ["Big brain"]);
});

test("custom points variable is added; lint names a missing one", () => {
  let d = act(base, [{ op: "set_gamification", perAnswer: 0, customVariable: "BONUS", badges: [] }]);
  assert.match(lintGamification(d).join(" "), /BONUS/);
  d = { ...d, calculations: [{ id: "c1", targetVariable: "BONUS", expression: "7", trigger: "on_change" } as never] };
  assert.deepEqual(lintGamification(d), []);
  assert.equal(gamificationVariables(d, state({}, { BONUS: 7 })).POINTS, 7);
});

test("exported: the dictionary declares POINTS / LEVEL / BADGES and flatten carries them", () => {
  const d = gamified();
  const names = buildVariableDictionary(d).map((v) => v.name);
  for (const n of ["POINTS", "POINTS_ANSWERED", "POINTS_CORRECT", "LEVEL", "LEVEL_NAME", "BADGES"]) assert.ok(names.includes(n), n);
  const lv = buildVariableDictionary(d).find((v) => v.name === "LEVEL")!;
  assert.equal(lv.valueLabels["3"], "Gold");
  const s = state({ [d.questions[0].id]: 1 });
  runCalculations(d, s as never, "on_change");
  assert.equal(flattenVariables(d, s as never).POINTS, 15);
  assert.equal(buildVariableDictionary(base).some((v) => v.name === "POINTS"), false, "no gamification, no columns");
});

test("set_gamification: shortcuts, refusals, add/remove, clear", () => {
  assert.deepEqual(badgeRule("POINTS >= 30"), { type: "rule", source: { kind: "calculation", ref: "POINTS" }, operator: "gte", value: 30 });
  assert.equal(badgeRule("Q1 = 2"), null);
  assert.ok(BADGE_ICON_GLYPHS.trophy);
  const bad = coerceSurveyActions([{ op: "set_gamification", badges: [{ id: "x", title: "X", icon: "unicorn", when: "POINTS > 1" }] }]);
  assert.equal(bad.actions.length, 0); assert.match(JSON.stringify(bad.rejected), /icon must be one of/);
  const nowhen = coerceSurveyActions([{ op: "set_gamification", badges: [{ id: "x", title: "X" }] }]);
  assert.match(JSON.stringify(nowhen.rejected), /give .{0,2}when/);
  const unreadable = applySurveyActions(base, coerceSurveyActions([{ op: "set_gamification", badges: [{ id: "x", title: "X", when: "the moon is full" }] }]).actions);
  assert.equal(unreadable.results[0].ok, false);
  let d = gamified();
  d = act(d, [{ op: "set_gamification", addBadges: [{ id: "q1", title: "Paris!", icon: "target", when: `${d.questions[0].code} = 1` }], removeBadges: ["thirty"] }]);
  assert.deepEqual(d.gamification!.badges.map((b) => b.id), ["starter", "brain", "q1"]);
  assert.match(gamificationVariables(d, state({ [d.questions[0].id]: 1 })).BADGES as string, /q1/);
  d = act(d, [{ op: "set_gamification", clear: true }]);
  assert.equal(d.gamification, undefined);
});

test("the respondent copy keeps the key when correct answers score points (not a scored paper); a paper strips it", () => {
  const d = { ...gamified(), assessment: undefined } as SurveyDefinition; // keys on the questions, not a scored paper (set_answer_key makes one)
  assert.deepEqual(stripAssessmentSecrets(d).questions[0].assessment?.correct?.map(String), ["1"]);
  const noCorrect = act(d, [{ op: "set_gamification", perCorrect: 0 }]);
  assert.equal(stripAssessmentSecrets(noCorrect).questions[0].assessment?.correct?.length ?? 0, 0);
  const paper = { ...d, assessment: { enabled: true, showResults: "after_submit" } } as SurveyDefinition;
  assert.equal(stripAssessmentSecrets(paper).questions[0].assessment?.correct?.length ?? 0, 0);
});
