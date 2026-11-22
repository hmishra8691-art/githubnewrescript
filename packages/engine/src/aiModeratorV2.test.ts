import { test } from "node:test";
import assert from "node:assert/strict";
import { QualStudy } from "@rescript/schema";
import {
  buildModeratorPlan, finishTurn, guideAdherence, moderatorGuideBlock, prepareTurn, startInterview, namesPersonalValue, answerNovelty, fakeModeratorReply,
  type ModeratorPlan, type ModeratorState, type PreparedTurn,
} from "./aiModerator.js";

/*
 * Q3 — THE MODERATOR, VERSION 2: laddering to a personal value, stopping when a topic is exhausted, each section kept to
 * its minutes, concepts and screen-share tasks as stimuli, and a record of how closely the interview kept to its guide.
 * The "model" is scripted (what a provider would answer); the rules' own path runs where no model is used.
 */
const T0 = Date.parse("2026-11-22T10:00:00Z");
const min = (m: number) => T0 + m * 60_000;
const answer = (text: string) => ({ kind: "answer" as const, text });
const model = (p: PreparedTurn) => { assert.equal(p.kind, "model", p.kind === "final" ? p.reply.decision.reason : ""); return p as Extract<PreparedTurn, { kind: "model" }>; };
const final = (p: PreparedTurn) => { assert.equal(p.kind, "final"); return p as Extract<PreparedTurn, { kind: "final" }>; };

const study = (mod: Record<string, unknown> = {}, sections?: unknown[]) => QualStudy.parse({
  kind: "interview", title: "Choosing a car", durationMinutes: 20,
  objectives: ["Understand what matters when choosing a car", "Learn how people try the booking website"],
  consent: { statement: "Voluntary; stop any time." },
  sections: sections ?? [
    { id: "s1", title: "Hello", kind: "opening", script: "Thanks for joining." },
    { id: "s2", title: "What matters", minutes: 4, questions: [
      { id: "q1", text: "What matters most to you when you choose a car?" },
      { id: "q2", text: "Tell me about the last car you bought." },
      { id: "q3", text: "Who else had a say in it?" },
    ] },
    { id: "s3", title: "Concept", kind: "concept", stimuli: ["Board A"], questions: [{ id: "q4", text: "What do you make of this idea?" }] },
    { id: "s4", title: "The website", stimuli: ["Book a test drive"] },
    { id: "s5", title: "Close", kind: "closing", questions: [{ id: "q9", text: "Anything else to add?" }] },
  ],
  aiModeration: {
    modes: ["text"], defaultProbing: "light", probing: [{ questionId: "q1", depth: "deep", ladder: 3 }], maxTurns: 40, costCapUsd: 1,
    stimuli: [
      { name: "Board A", kind: "concept", text: "A car subscription: one monthly price, insurance and servicing included, swap models twice a year." },
      { name: "Book a test drive", kind: "screen_share", text: "Go to the dealer's website and book a test drive for Saturday." },
    ],
    ...mod,
  },
});
const planOf = (s = study()) => buildModeratorPlan(s, { guideLanguage: "en" });
const opened = (plan: ModeratorPlan): ModeratorState => final(startInterview(plan, { now: T0, language: "en" })).state;

test("the plan: a laddered question, section minutes (the guide's 4, the rest shared by steps), a concept board and a screen-share task", () => {
  const plan = planOf();
  const q1 = plan.steps.find((s) => s.key === "q1")!;
  assert.equal(q1.ladder, 3); assert.equal(q1.maxFollowUps, 3);
  assert.equal(plan.sectionMinutes!.s2, 4, "the guide's own minutes");
  assert.ok(Math.abs(plan.sectionMinutes!.s3 + plan.sectionMinutes!.s4 + plan.sectionMinutes!.s5 - 16) <= 0.2, "the other 16 minutes shared by their steps (rounded to a tenth)");
  assert.ok(!namesPersonalValue("Low running costs and a good safety rating"), "a feature that mentions safety is not a value");
  const share = plan.steps.find((s) => s.key === "s4:stimulus")!;
  assert.match(share.text, /^Go to the dealer's website and book a test drive for Saturday\. Please share your screen and talk me through/);
  const block = moderatorGuideBlock(plan);
  assert.match(block, /concept: “A car subscription/);
  assert.match(block, /a screen share — the participant shows: Go to the dealer's website.*you cannot see it/);
  assert.match(block, /LADDER up to 3 rungs/);
  assert.match(block, /section about 4 min/);
});

test("laddering by the rules: why it matters, rung by rung, until a personal value is named; the ladder is recorded", () => {
  const plan = planOf();
  let st = opened(plan);
  /* the model is unavailable: the rules ladder */
  let p = final(prepareTurn(plan, st, answer("Reliability, mostly. I want it to start every morning."), { now: min(1), modelAvailable: false }));
  assert.equal(p.reply.intent, "probe"); assert.equal(p.reply.say, "Why is that important to you?");
  assert.match(p.reply.decision.reason, /laddering: rung 1 of 3/);
  st = p.state;
  p = final(prepareTurn(plan, st, answer("Because I commute and cannot be late for my shifts at the hospital."), { now: min(2), modelAvailable: false }));
  assert.equal(p.reply.say, "And what does that do for you?");
  st = p.state;
  p = final(prepareTurn(plan, st, answer("It gives me peace of mind, I can look after my family without worrying."), { now: min(3), modelAvailable: false }));
  assert.equal(p.reply.intent, "next", "a personal value ends the ladder");
  assert.match(p.reply.decision.reason, /ladder reached a personal value/);
  assert.deepEqual(p.state.ladders, [{ step: "q1", rungs: 2, value: true }]);
  assert.ok(namesPersonalValue("it's about my independence")); assert.ok(!namesPersonalValue("it is red and fast"));
});

test("laddering with the model: the request asks for the next rung; a model probe counts as a rung", () => {
  const plan = planOf();
  const st = opened(plan);
  const p = model(prepareTurn(plan, st, answer("Low running costs and a good safety rating."), { now: min(1) }));
  assert.deepEqual(p.ctx.ladder, { rung: 1, of: 3 });
  assert.match(p.request.user, /LADDER \(rung 1 of 3\)/);
  const f = finishTurn(plan, p, { intent: "probe", say: "Why does a good safety rating matter to you?" }, { now: min(1) });
  assert.equal(f.state.rung, 1);
});

test("a topic is exhausted when a follow-up brings nothing new: no more probing, and it is recorded", () => {
  const plan = planOf(study({ probing: [{ questionId: "q2", depth: "deep" }] }));
  let st = opened(plan);
  /* move past q1 (not laddered here: depth light) */
  st = finishTurn(plan, model(prepareTurn(plan, st, answer("Reliability and price, and how it feels to drive."), { now: min(1) })), { intent: "next", say: "Thanks. Tell me about the last car you bought." }, { now: min(1) }).state;
  assert.equal(plan.steps[st.step].key, "q2");
  st = finishTurn(plan, model(prepareTurn(plan, st, answer("A used hatchback from a dealer near work, two years ago."), { now: min(2) })), { intent: "probe", say: "What made you choose that dealer?" }, { now: min(2) }).state;
  const p = model(prepareTurn(plan, st, answer("It was a used hatchback from the dealer near work."), { now: min(3) }));
  assert.equal(p.ctx.exhausted, true);
  assert.deepEqual(p.ctx.allowed, ["next", "check_in"], "no probe once exhausted");
  assert.match(p.request.user, /EXHAUSTED: the last answer added nothing new/);
  assert.match(p.fallback.decision.reason, /topic is exhausted/);
  assert.deepEqual(p.state.exhausted, ["q2"]);
  assert.ok(answerNovelty("used hatchback dealer", ["a used hatchback from a dealer"]) < 0.34);
  assert.equal(answerNovelty("anything", []), 1);
  /* switched off: the same answer may still be probed */
  const off = planOf(study({ probing: [{ questionId: "q2", depth: "deep" }], stopWhenExhausted: false }));
  let so = opened(off);
  so = finishTurn(off, model(prepareTurn(off, so, answer("Reliability and price, and how it feels to drive."), { now: min(1) })), { intent: "next", say: "Thanks. Tell me about the last car you bought." }, { now: min(1) }).state;
  so = finishTurn(off, model(prepareTurn(off, so, answer("A used hatchback from a dealer near work, two years ago."), { now: min(2) })), { intent: "probe", say: "What made you choose that dealer?" }, { now: min(2) }).state;
  assert.ok(model(prepareTurn(off, so, answer("It was a used hatchback from the dealer near work."), { now: min(3) })).ctx.allowed.includes("probe"));
});

test("a section well over its minutes moves on to the next section; the skip and the overrun are recorded", () => {
  const plan = planOf(study({ probing: [] }));
  let st = opened(plan);
  /* q1 at minute 1, q2 answered at minute 7: section s2 (4 minutes) is at 1.75× — q3 is skipped, the concept comes next */
  st = finishTurn(plan, model(prepareTurn(plan, st, answer("Reliability and price, and how it feels to drive."), { now: min(1) })), { intent: "next", say: "Thanks. Tell me about the last car you bought." }, { now: min(1) }).state;
  const p = model(prepareTurn(plan, st, answer("A used hatchback from a dealer near work, two years ago, after a long search."), { now: min(7) }));
  assert.deepEqual(p.ctx.allowed, ["next", "check_in"], "no follow-up in a section over its minutes");
  assert.equal(p.ctx.target.kind === "step" && plan.steps[p.ctx.target.index].key, "q4");
  const f = finishTurn(plan, p, fakeModeratorReply(plan, p), { now: min(7) });
  assert.equal(plan.steps[f.state.step].key, "q4");
  assert.ok(f.state.skipped.includes("q3"));
  assert.equal(f.state.sectionsOver![0].sectionId, "s2"); assert.equal(f.state.sectionsOver![0].budget, 4); assert.deepEqual(f.state.sectionsOver![0].skipped, ["q3"]);
  assert.ok(f.state.flags.some((x) => x.kind === "over_time" && /section “What matters” ran well over its minutes/.test(x.note)));
  /* timing off: q3 is asked */
  const off = planOf(study({ probing: [], sectionTiming: false }));
  let so = opened(off);
  so = finishTurn(off, model(prepareTurn(off, so, answer("Reliability and price, and how it feels to drive."), { now: min(1) })), { intent: "next", say: "Thanks. Tell me about the last car you bought." }, { now: min(1) }).state;
  const po = model(prepareTurn(off, so, answer("A used hatchback from a dealer near work, two years ago, after a long search."), { now: min(7) }));
  assert.equal(po.ctx.target.kind === "step" && off.steps[po.ctx.target.index].key, "q3");
});

test("guide adherence: steps asked in order, those missed and why, objectives covered, ladders, exhausted topics, sections over", () => {
  const plan = planOf(study({ probing: [] }));
  let st = opened(plan);
  st = finishTurn(plan, model(prepareTurn(plan, st, answer("What matters when choosing a car is reliability and price."), { now: min(1) })), { intent: "next", say: "Thanks. Tell me about the last car you bought.", covered: ["O1"] }, { now: min(1) }).state;
  const p = model(prepareTurn(plan, st, answer("A used hatchback from a dealer near work, two years ago, after a long search."), { now: min(7) }));
  st = finishTurn(plan, p, fakeModeratorReply(plan, p), { now: min(7) }).state;
  const a = guideAdherence(plan, st);
  assert.equal(a.steps, 5, "q1 q2 q3 q4 and the screen-share task; the closing is not counted");
  assert.equal(a.stepsAsked, 3); // q1, q2, q4
  assert.deepEqual(a.missed, [{ key: "q3", why: "skipped_for_time" }, { key: "s4:stimulus", why: "not_reached" }]);
  assert.equal(a.inOrder, true);
  assert.equal(a.objectivesCovered, 1); assert.equal(a.objectives, 2);
  assert.equal(a.score, Math.round((0.6 * (3 / 5) + 0.4 * (1 / 2)) * 1000) / 10);
  assert.equal(a.sectionsOver[0].sectionId, "s2");
});
