import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildAchievements, streakOf } from "./achievements.js";
import { badgeRule } from "./gamification.js";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

test("a streak: completions in a row, each within the interval plus half of it; the current one ends when the next is overdue", () => {
  /* weekly, done every 7 days: five in a row, the last three days ago */
  assert.deepEqual(streakOf([31, 24, 17, 10, 3].map(ago), 7, NOW), { current: 5, best: 5 });
  /* a gap of 14 days breaks it: best is the earlier run, current the later */
  assert.deepEqual(streakOf([45, 38, 31, 17, 10, 3].map(ago), 7, NOW), { current: 3, best: 3 });
  assert.deepEqual(streakOf([52, 45, 38, 31, 17, 10].map(ago), 7, NOW), { current: 2, best: 4 });
  /* day 10 still counts (the grace is half the interval), day 11 does not */
  assert.equal(streakOf([13, 3].map(ago), 7, NOW).current, 2);
  assert.equal(streakOf([14, 3].map(ago), 7, NOW).current, 1);
  /* nothing for 11 days: the streak is over, the best stays */
  assert.deepEqual(streakOf([25, 18, 11].map(ago), 7, NOW), { current: 0, best: 3 });
  /* two on the same day are one period's work */
  assert.deepEqual(streakOf([10, 10, 3].map(ago), 7, NOW), { current: 2, best: 2 });
  assert.deepEqual(streakOf([], 7, NOW), { current: 0, best: 0 });
  assert.deepEqual(streakOf([ago(1), "not a date"], 7, NOW), { current: 1, best: 1 });
});

const def = (portal: Record<string, unknown>, gamification: Record<string, unknown> | null = {
  points: { perAnswer: 10 },
  levels: [{ name: "Starter", minPoints: 0 }, { name: "Regular", minPoints: 30 }, { name: "Expert", minPoints: 60 }],
  badges: [
    { id: "first", title: "First steps", description: "Finish once", icon: "star", when: badgeRule("POINTS >= 10")! },
    { id: "thirty", title: "Thirty up", icon: "trophy", when: badgeRule("POINTS >= 30")! },
  ],
}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T", version: "1", schemaVersion: 1, status: "live" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Q" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  ...(gamification ? { gamification } : {}),
  portal: { enabled: true, ...portal },
});

test("what was earned is read back from the interviews: points and level from the latest, a badge once earned stays", () => {
  const live = def({ show: { rewards: true } });
  const a = buildAchievements(live, [
    { completedAt: ago(20), calculated: { POINTS: 40, LEVEL: 2, BADGES: "first,thirty" } },
    { completedAt: ago(2), calculated: { POINTS: 20, LEVEL: 1, BADGES: "first" } },
  ], NOW)!;
  assert.deepEqual([a.points, a.level, a.nextLevel], [20, { index: 1, name: "Starter" }, { name: "Regular", pointsToGo: 10 }]);
  assert.deepEqual(a.badges.map((b) => [b.id, b.title, b.description]), [["first", "First steps", "Finish once"], ["thirty", "Thirty up", null]]);
  assert.deepEqual([a.badgesAvailable, a.completions, a.streak], [2, 2, null]);
  /* the top level has no next one; a missing figure is not invented */
  const top = buildAchievements(live, [{ completedAt: ago(1), calculated: { POINTS: 90, LEVEL: 3, BADGES: "" } }], NOW)!;
  assert.deepEqual([top.level!.name, top.nextLevel], ["Expert", null]);
  const bare = buildAchievements(live, [{ completedAt: ago(1), calculated: {} }], NOW)!;
  assert.deepEqual([bare.points, bare.level, bare.badges], [null, null, []]);
  assert.equal(buildAchievements(live, [], NOW)!.completions, 0);
});

test("shown only with its switch; a survey that awards nothing shows a streak if it is taken at intervals, else nothing", () => {
  const attempts = [10, 3].map((d) => ({ completedAt: ago(d), calculated: { POINTS: 10 } }));
  assert.equal(buildAchievements(def({}), attempts, NOW), null);
  assert.equal(buildAchievements(def({ show: { rewards: true } }, null), attempts, NOW), null);
  const diary = buildAchievements(def({ show: { rewards: true }, series: { id: "d", label: "Diary", repeatEveryDays: 7 } }, null), attempts, NOW)!;
  assert.deepEqual([diary.streak, diary.points, diary.badgesAvailable], [{ current: 2, best: 2, every: 7 }, null, 0]);
  assert.equal(buildAchievements(def({ enabled: false, show: { rewards: true } }), attempts, NOW), null);
});
