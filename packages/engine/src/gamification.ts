import type { SurveyDefinition, Question, Condition, Gamification, GamificationBadge } from "@rescript/schema";
import { BADGE_ICONS } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { evaluateCondition } from "./evaluate.js";
import { assessmentSelectedCodes } from "./assessment.js";

/**
 * S5a item 4 — POINTS, BADGES AND LEVELS (audit GA-06, GA-07), `def.gamification`.
 *
 *   gamificationVariables(def, state)   the calculated variables, recomputed with the survey's calculations
 *                                       (`runCalculations`, so the Runner and the server replay agree):
 *       POINTS_ANSWERED  answered questions (top-level answers of respondent-facing questions)
 *       POINTS_CORRECT   correct answers by the answer key (question.assessment.correct — the quiz / assessment key).
 *                        The respondent's copy keeps the key when perCorrect > 0 and the survey is not a scored paper
 *                        (stripAssessmentSecrets); a scored paper withholds it, and then this is 0
 *       POINTS           perAnswer × answered + perCorrect × correct + the custom variable's number
 *       LEVEL            the 1-based index of the highest level whose minPoints is reached (0 = none)
 *       LEVEL_NAME       that level's name ("" = none)
 *       BADGES           the earned badge ids, comma-separated, in definition order. ONE-TIME: a badge earned stays
 *                        earned when its rule later stops being true (the previous BADGES are kept)
 *   newBadges(before, after, g)         the badges just earned (the Runner's popup)
 *   badgeRule(text)                     the threshold shortcuts IM / Studio write: "POINTS >= 30", "POINTS_CORRECT >= 3"
 *   BADGE_ICON_GLYPHS                   the built-in icon set (no images, no network)
 */
export const BADGE_ICON_GLYPHS: Record<(typeof BADGE_ICONS)[number], string> = {
  star: "⭐", trophy: "🏆", medal: "🏅", rocket: "🚀", fire: "🔥", heart: "❤️", lightbulb: "💡", target: "🎯", crown: "👑", check: "✅",
};
export const GAMIFICATION_VARIABLES = ["POINTS", "POINTS_ANSWERED", "POINTS_CORRECT", "LEVEL", "LEVEL_NAME", "BADGES"] as const;

const NOT_ANSWERABLE = new Set(["hidden", "calculated", "embedded_data", "html", "descriptive", "content"]);
const filled = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

export function gamificationOf(def: Pick<SurveyDefinition, "gamification">): Gamification | null {
  const g = def.gamification;
  return g && g.enabled !== false ? g : null;
}

function isCorrect(q: Question, value: unknown): boolean | null {
  const key = (q as { assessment?: { correct?: unknown[] } }).assessment?.correct;
  if (!Array.isArray(key) || !key.length) return null;
  const sel = assessmentSelectedCodes(value);
  if (!sel.length) return false;
  const want = key.map(String).sort();
  const got = [...sel].sort();
  return want.length === got.length && want.every((c, i) => c === got[i]);
}

export function gamificationVariables(def: SurveyDefinition, state: Pick<ResponseState, "answers" | "calculated" | "embedded"> & Partial<ResponseState>): Record<string, number | string> {
  const g = gamificationOf(def);
  if (!g) return {};
  let answered = 0, correct = 0;
  for (const q of def.questions) {
    if (NOT_ANSWERABLE.has(q.type) || q.settings.hidden) continue;
    const v = state.answers[q.id];
    if (!filled(v)) continue;
    answered += 1;
    if (isCorrect(q, v) === true) correct += 1;
  }
  const custom = g.points.customVariable ? Number(state.calculated[g.points.customVariable]) : 0;
  const points = Math.round((g.points.perAnswer * answered + g.points.perCorrect * correct + (Number.isFinite(custom) ? custom : 0)) * 100) / 100;
  const levels = [...g.levels].sort((a, b) => a.minPoints - b.minPoints);
  let level = 0;
  levels.forEach((l, i) => { if (points >= l.minPoints) level = i + 1; });
  const out: Record<string, number | string> = { POINTS: points, POINTS_ANSWERED: answered, POINTS_CORRECT: correct, LEVEL: level, LEVEL_NAME: level ? levels[level - 1].name : "" };
  /* the badges see this pass's points: a rule "POINTS >= 30" is judged against the new total */
  const view = { ...state, calculated: { ...state.calculated, ...out } } as ResponseState;
  const had = new Set(String(state.calculated.BADGES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const earned = g.badges.filter((b) => had.has(b.id) || safeEval(b.when, def, view)).map((b) => b.id);
  out.BADGES = earned.join(",");
  return out;
}

function safeEval(c: Condition, def: SurveyDefinition, state: ResponseState): boolean {
  try { return evaluateCondition(c, { def, state }); } catch { return false; }
}

export function earnedBadges(value: unknown): string[] {
  return String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** the badges in `after` that were not in `before`, as their definitions */
export function newBadges(before: unknown, after: unknown, g: Gamification | null): GamificationBadge[] {
  if (!g) return [];
  const was = new Set(earnedBadges(before));
  const now = new Set(earnedBadges(after));
  return g.badges.filter((b) => now.has(b.id) && !was.has(b.id));
}

/**
 * The threshold shortcut: "POINTS >= 30" / "POINTS_CORRECT >= 3" / "LEVEL >= 2" / "POINTS_ANSWERED > 5" → a rule on
 * the calculated variable. Anything else → null (the caller parses it as a full condition or refuses it).
 */
export function badgeRule(text: string): Condition | null {
  const m = /^\s*(POINTS|POINTS_ANSWERED|POINTS_CORRECT|LEVEL)\s*(>=|>|=|==|<=|<)\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(text);
  if (!m) return null;
  const op = ({ ">=": "gte", ">": "gt", "=": "eq", "==": "eq", "<=": "lte", "<": "lt" } as const)[m[2] as ">=" | ">" | "=" | "==" | "<=" | "<"];
  return { type: "rule", source: { kind: "calculation", ref: m[1].toUpperCase() }, operator: op, value: Number(m[3]) } as Condition;
}

/** what a programmer must fix: duplicate badge ids, levels out of order, a custom variable that does not exist */
export function lintGamification(def: SurveyDefinition): string[] {
  const g = def.gamification;
  if (!g) return [];
  const out: string[] = [];
  const ids = new Set<string>();
  for (const b of g.badges) { if (ids.has(b.id)) out.push(`gamification: two badges are called “${b.id}”`); ids.add(b.id); }
  const names = new Set<string>();
  for (const l of g.levels) { if (names.has(l.name)) out.push(`gamification: two levels are called “${l.name}”`); names.add(l.name); }
  const cv = g.points.customVariable;
  if (cv && !def.calculations.some((c) => c.targetVariable === cv) && !def.questions.some((q) => q.code === cv && q.type === "calculated")) {
    out.push(`gamification: the custom points variable “${cv}” is not a calculation of this survey`);
  }
  if (g.points.perAnswer === 0 && g.points.perCorrect === 0 && !cv) out.push("gamification: no points are ever given (perAnswer, perCorrect and the custom variable are all off)");
  return out;
}
