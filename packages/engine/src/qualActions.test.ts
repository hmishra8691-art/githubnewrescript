import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, describeAction, diffSurveys, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { coerceQualAction, guideMinutes, lintQualStudy, QUAL_ACTION_OPS } from "./qualActions.js";

/*
 * THE QUALITATIVE STUDY ACTIONS (2026-10-18): create_qual_guide writes def.qualStudy from a request,
 * update_qual_guide patches only what it names; both go through the gate, the preview diff and the
 * replay like every other action.
 */

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "QS", title: "Switching" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });

const IDI = {
  op: "create_qual_guide", kind: "idi", title: "Why customers switch broadband", durationMinutes: 60,
  objectives: ["Understand what triggers switching", "Learn how providers are compared"],
  protocol: "One-to-one remote video interviews moderated by a senior researcher; audio and video recorded with consent.",
  screening: ["Pays the household broadband bill", "Exclude: works in telecoms or market research"],
  consent: { statement: "Taking part is voluntary; you can stop at any time.", recordingDisclosure: "The session is recorded (audio and video) for analysis by the research team only and deleted after 12 months." },
  segments: [{ name: "Recent switchers", target: 6 }, { name: "Considered but stayed", target: 6 }],
  sessionPlan: { sessions: 12, participantsPerSession: 1, mode: "remote" },
  sections: [
    { title: "Introduction", kind: "intro", minutes: 5, script: "Thank you for joining. There are no right or wrong answers. With your permission I will record this conversation." },
    { title: "Context", kind: "warm-up", minutes: 10, questions: ["Tell me about how your household uses the internet."] },
    { title: "Triggers", minutes: 20, purpose: "Objective 1", instructions: ["Let the participant tell the story in order before probing"], questions: [
      { text: "Think about the last time you considered switching provider. What happened?", probes: ["What tipped the decision?", "Who else was involved?"], conditionalProbes: [{ if: "price", ask: "What would a fair price have been?" }] },
      "How did you feel about your provider at that point?",
    ] },
    { title: "Comparing providers", minutes: 15, questions: [{ text: "When you compare providers, what do you look at first?", probes: ["Which source did you trust most?"] }] },
    { title: "Wrap-up", kind: "closing", minutes: 5, questions: ["Is there anything else you would like to add?"] },
  ],
};

const run = (def: SurveyDefinition, actions: unknown[]) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(def, c.actions, { now: "2026-10-18T10:00:00.000Z" });
};

test("the ops are in the engine's vocabulary", () => {
  for (const op of QUAL_ACTION_OPS) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
});

test("create_qual_guide: an interview guide from a request — sections, timing, scripts, probes, conditional probes, screening, consent, segments, plan", () => {
  const r = run(empty(), [IDI]);
  assert.deepEqual(r.errors, []);
  const s = r.def.qualStudy!;
  assert.equal(s.kind, "interview");
  assert.deepEqual(s.sections.map((x) => [x.id, x.title, x.kind, x.minutes]), [["s1", "Introduction", "opening", 5], ["s2", "Context", "warm_up", 10], ["s3", "Triggers", "main", 20], ["s4", "Comparing providers", "main", 15], ["s5", "Wrap-up", "closing", 5]]);
  const q = s.sections[2].questions[0];
  assert.equal(q.id, "s3q1");
  assert.deepEqual(q.probes, ["What tipped the decision?", "Who else was involved?"]);
  assert.deepEqual(q.conditionalProbes, [{ ifMentions: "price", ask: "What would a fair price have been?" }]);
  assert.deepEqual(s.screening.map((x) => x.rule), ["include", "exclude"]);
  assert.deepEqual(s.segments.map((x) => [x.id, x.name, x.target]), [["seg1", "Recent switchers", 6], ["seg2", "Considered but stayed", 6]]);
  assert.equal(s.sessionPlan.mode, "remote");
  assert.equal(guideMinutes(s), 55);
  assert.equal(s.updatedAt, "2026-10-18T10:00:00.000Z");
  assert.match(r.results[0].description, /^Create the interview guide: 5 sections, 5 questions, 55 minutes timed of 60$/);
  assert.equal(r.def.questions.length, 0);
  const d = diffSurveys(empty(), r.def);
  assert.equal(d.empty, false);
  assert.deepEqual(d.summary, ["Create the interview guide: 5 sections, 5 questions"]);
});

test("update_qual_guide is a PATCH: only what is named changes — every other section is byte-identical", () => {
  const before = run(empty(), [IDI]).def;
  const r = run(before, [{
    op: "update_qual_guide",
    sections: [{ target: "Triggers", updateQuestions: [{ target: "s3q1", addProbes: ["What happened next?"] }], addQuestions: ["What would have made you stay?"] }],
    addSections: [{ title: "Concept reactions", kind: "concept", minutes: 10, stimuli: ["Concept A: price lock", "Concept B: loyalty rewards"], questions: ["What is your first reaction to this idea?"] }],
    removeObjectives: ["Learn how providers are compared"],
  }]);
  assert.deepEqual(r.errors, []);
  const a = before.qualStudy!, b = r.def.qualStudy!;
  for (const id of ["s1", "s2", "s4", "s5"]) assert.deepEqual(b.sections.find((x) => x.id === id), a.sections.find((x) => x.id === id), `${id} untouched`);
  assert.deepEqual(b.sections.map((x) => x.title), ["Introduction", "Context", "Triggers", "Comparing providers", "Concept reactions", "Wrap-up"], "a new topic goes before the closing");
  const trig = b.sections.find((x) => x.id === "s3")!;
  assert.deepEqual(trig.questions[0].probes, ["What tipped the decision?", "Who else was involved?", "What happened next?"]);
  assert.deepEqual(trig.questions[0].conditionalProbes, a.sections[2].questions[0].conditionalProbes, "the conditional probe kept");
  assert.equal(trig.questions[2].text, "What would have made you stay?");
  assert.equal(trig.questions[2].id, "s3q3");
  assert.deepEqual(b.objectives, ["Understand what triggers switching"]);
  for (const k of ["screening", "consent", "segments", "sessionPlan", "protocol", "durationMinutes"] as const) assert.deepEqual(b[k], a[k], k);
  assert.match(r.results[0].description, /^Update the interview guide: −objective .*“Triggers”: edited .*\+“What would have made you stay\?”; \+section “Concept reactions” \(1 question\)$/);
  assert.equal(r.results[0].destructive, undefined);
  const d = diffSurveys(before, r.def);
  assert.deepEqual(d.summary, ["Add guide section “Concept reactions”", "Change guide section “Triggers”", "Change the interview guide's objectives"]);
});

test("removing a section or replacing the guide is destructive; create refuses when a guide exists", () => {
  const before = run(empty(), [IDI]).def;
  const rm = run(before, [{ op: "update_qual_guide", removeSections: ["Comparing providers"] }]);
  assert.match(rm.results[0].destructive ?? "", /Removes “Comparing providers”/);
  const again = applySurveyActions(before, coerceSurveyActions([IDI]).actions);
  assert.equal(again.results[0].ok, false);
  assert.match(again.results[0].error ?? "", /already has an interview guide — change it with update_qual_guide/);
  const rep = run(before, [{ ...IDI, replace: true, kind: "focus_group", groundRules: ["One person speaks at a time"] }]);
  assert.match(rep.results[0].destructive ?? "", /Replaces the existing interview guide \(5 sections\)/);
  assert.equal(rep.def.qualStudy!.kind, "focus_group");
});

test("errors name what is wrong; nothing is half-applied", () => {
  const before = run(empty(), [IDI]).def;
  const bad = applySurveyActions(before, coerceSurveyActions([{ op: "update_qual_guide", sections: [{ target: "Pricing", addQuestions: ["x"] }] }]).actions);
  assert.equal(bad.results[0].ok, false);
  assert.match(bad.results[0].error ?? "", /there is no section “Pricing” — add it with addSections/);
  assert.deepEqual(bad.def.qualStudy, before.qualStudy);
  const none = applySurveyActions(empty(), coerceSurveyActions([{ op: "update_qual_guide", addObjectives: ["x"] }]).actions);
  assert.match(none.results[0].error ?? "", /create one with create_qual_guide/);
  assert.match(String(coerceQualAction("create_qual_guide", { kind: "survey", sections: [{ title: "x" }] })), /kind is "interview" or "focus_group"/);
  assert.match(String(coerceQualAction("create_qual_guide", { kind: "interview" })), /needs sections/);
  assert.match(String(coerceQualAction("update_qual_guide", {})), /names nothing to change/);
  assert.match(String(coerceQualAction("update_qual_guide", { sections: [{ target: "s3", updateQuestions: [{ target: "s3q1", conditionalProbes: [{ if: "price" }] }] }] })), /ifMentions .* and ask/);
  assert.equal(coerceQualAction("set_probe", {}), null);
});

test("the focus-group guide: ground rules, an exercise; the lint says what a methodologist would", () => {
  const r = run(empty(), [{
    op: "create_qual_guide", kind: "focus group", durationMinutes: 90, objectives: ["Explore reactions to two loyalty concepts"],
    groundRules: ["One person speaks at a time", "There are no right or wrong answers", "What is said here stays here"],
    consent: { recordingDisclosure: "Audio and video are recorded; clients may watch from the viewing room." },
    sections: [
      { title: "Welcome", kind: "opening", minutes: 10, script: "Welcome everyone…" },
      { title: "Card sort", kind: "exercise", minutes: 20, exercise: { title: "Sort the benefits", instructions: "Sort the cards from most to least important", materials: ["12 benefit cards"] } },
      { title: "Concepts", kind: "concept", minutes: 40, stimuli: ["Concept A", "Concept B"], questions: ["Don't you think Concept A is better?", "What would make Concept B more appealing?"] },
      { title: "Close", kind: "closing", minutes: 10, questions: ["Anything else?"] },
    ],
  }]);
  const s = r.def.qualStudy!;
  assert.equal(s.kind, "focus_group");
  assert.equal(s.sections[1].exercise!.materials[0], "12 benefit cards");
  assert.ok(r.warnings?.some?.((w: string) => /leads the participant/.test(w)) ?? lintQualStudy(s).some((w) => /leads the participant/.test(w)));
  const lint = lintQualStudy(s);
  assert.ok(lint.some((w) => /Don't you think Concept A is better\?” leads the participant/.test(w)), lint.join("\n"));
  assert.ok(!lint.some((w) => /ground rules/.test(w)));
  const noRules = lintQualStudy({ ...s, groundRules: [], consent: {}, sections: s.sections.filter((x) => x.kind !== "closing"), durationMinutes: 30 });
  for (const re of [/no ground rules/, /No recording disclosure/, /no closing section/, /timed for 70 minutes but the session is 30/]) assert.ok(noRules.some((w) => re.test(w)), String(re));
  assert.match(describeAction(coerceSurveyActions([{ op: "update_qual_guide", addGroundRules: ["Phones away"] }]).actions[0]), /Update the qualitative guide \(addGroundRules\)/);
});

import { changeItems } from "./changeItems.js";
test("the review lists a guide change item by item (Qualitative guide), and the diff names the sections it touched", () => {
  const before = run(empty(), [IDI]).def;
  const created = changeItems(empty(), before);
  const g = created.items.filter((i) => i.category === "Qualitative guide");
  assert.ok(g.length >= 5, "the guide's fields and sections");
  assert.ok(g.some((i) => i.kind === "added" && i.field === "section “Triggers”"));
  assert.ok(g.every((i) => i.level === "research" && !i.question));
  assert.deepEqual(diffSurveys(empty(), before).qualGuide, { added: ["s1", "s2", "s3", "s4", "s5"], removed: [], changed: [] });
  const after = run(before, [{ op: "update_qual_guide", sections: [{ target: "Triggers", addQuestions: ["What would have made you stay?"] }], removeSections: ["Comparing providers"] }]);
  const items = changeItems(before, after.def, { results: after.results }).items.filter((i) => i.category === "Qualitative guide");
  assert.deepEqual(items.map((i) => [i.kind, i.field]), [["modified", "section “Triggers”"], ["removed", "section “Comparing providers”"]]);
  assert.match(items[0].to ?? "", /What would have made you stay\?/);
  assert.match(items[1].destructive ?? "", /Removes “Comparing providers”/);
  assert.deepEqual(diffSurveys(before, after.def).qualGuide, { added: [], removed: ["s4"], changed: ["s3"] });
  assert.equal(changeItems(before, before).items.length, 0, "no change, no item");
});
