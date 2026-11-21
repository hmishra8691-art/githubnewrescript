import type { SurveyDefinition } from "@rescript/schema";
import { BADGE_ICON_GLYPHS, earnedBadges, gamificationOf } from "./gamification.js";
import { portalSettings } from "./portalPolicy.js";

/**
 * WHAT A PERSON HAS EARNED (Respondent Intelligence Engine, phase 6, 2026-11-20).
 *
 * Nothing new is awarded here. A survey's points, level and badges are its gamification (gamification.ts), already
 * computed with every interview and stored with it; this reads them back for the person who earned them. The one
 * thing worked out here is a STREAK: for an assessment taken at intervals, how many in a row were completed on time.
 *
 *   on time   = within the interval plus a grace of half of it (a weekly check-in done on day 10 still counts;
 *               one done on day 12 starts a new streak);
 *   current   = the run that ends with the latest completion — and only while the next one is not yet overdue by
 *               more than the same grace;
 *   best      = the longest run so far.
 *
 * Rewards here are recognition. They are not money and not a prize: nothing can be redeemed.
 */
export interface EarnedBadge { id: string; title: string; description: string | null; icon: string }
export interface Achievements {
  /** from the latest completed interview */
  points: number | null;
  level: { index: number; name: string } | null;
  nextLevel: { name: string; pointsToGo: number } | null;
  badges: EarnedBadge[];
  /** every badge the survey defines, earned or not — shown so a person can see what there is */
  badgesAvailable: number;
  completions: number;
  streak: { current: number; best: number; every: number } | null;
}

const DAY = 86_400_000;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** runs of on-time completions; `completedAt` in any order */
export function streakOf(completedAt: string[], everyDays: number, now: number): { current: number; best: number } {
  const t = completedAt.map((s) => Date.parse(s)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!t.length || everyDays <= 0) return { current: 0, best: 0 };
  const limit = everyDays * 1.5 * DAY;
  let run = 1, best = 1;
  for (let i = 1; i < t.length; i++) {
    /* two completions inside one interval are one period's work, not two steps of a streak */
    if (t[i]! - t[i - 1]! < everyDays * 0.5 * DAY) continue;
    run = t[i]! - t[i - 1]! <= limit ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return { current: now - t.at(-1)! <= limit ? run : 0, best };
}

export interface CompletedFacts { completedAt: string; calculated: Record<string, unknown> }

/** null = this survey shows no rewards (the switch is off, or it awards nothing and is not taken at intervals) */
export function buildAchievements(live: SurveyDefinition, attempts: CompletedFacts[], now: number): Achievements | null {
  const portal = portalSettings(live);
  if (!portal?.show.rewards) return null;
  const g = gamificationOf(live);
  const every = portal.series?.repeatEveryDays ?? null;
  if (!g && !every) return null;
  const done = [...attempts].filter((a) => !Number.isNaN(Date.parse(a.completedAt))).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const latest = done.at(-1);
  const out: Achievements = { points: null, level: null, nextLevel: null, badges: [], badgesAvailable: g?.badges.length ?? 0, completions: done.length, streak: every ? { ...streakOf(done.map((a) => a.completedAt), every, now), every } : null };
  if (g && latest) {
    out.points = num(latest.calculated.POINTS);
    const levels = [...g.levels].sort((a, b) => a.minPoints - b.minPoints);
    const idx = num(latest.calculated.LEVEL) ?? 0;
    if (idx >= 1 && levels[idx - 1]) out.level = { index: idx, name: levels[idx - 1]!.name };
    const next = levels[idx];
    if (next && out.points !== null) out.nextLevel = { name: next.name, pointsToGo: Math.max(0, Math.round((next.minPoints - out.points) * 100) / 100) };
    /* a badge once earned stays earned: any completed interview counts */
    const earned = new Set(done.flatMap((a) => earnedBadges(a.calculated.BADGES)));
    out.badges = g.badges.filter((b) => earned.has(b.id)).map((b) => ({ id: b.id, title: b.title, description: b.description ?? null, icon: BADGE_ICON_GLYPHS[b.icon] ?? "" }));
  }
  return out;
}
