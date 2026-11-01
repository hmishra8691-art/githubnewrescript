import type { SurveyDefinition, Condition as ConditionT } from "@rescript/schema";
import { Gamification, Condition, BADGE_ICONS } from "@rescript/schema";
import { badgeRule, lintGamification } from "./gamification.js";
import { conditionFromText } from "./naturalCondition.js";

/**
 * set_gamification — POINTS, BADGES, LEVELS AND THE HUD (S5a item 4; audit GA-06, GA-07).
 *
 *   enabled                 false keeps the settings but turns it all off
 *   perAnswer / perCorrect  points per answered question / per correct answer by the answer key (0–1000)
 *   customVariable          a calculation whose value is added to POINTS (null removes it)
 *   badges                  REPLACES the badge list: [{id, title, icon, description, when}] — `when` is a condition
 *                           ("POINTS >= 30", "POINTS_CORRECT >= 3", "Q3 = 1", or a Condition object) or `minPoints`
 *   addBadges / removeBadges   edit the list by id
 *   levels                  REPLACES the levels: [{name, minPoints}] (sorted by minPoints)
 *   hud                     {show, position top-right | top-left | bottom-right | bottom-left}
 *   clear                   removes gamification (POINTS / LEVEL / BADGES stop being computed)
 *
 * The result is checked by the schema (`Gamification`) — an unknown icon, a bad id, more than 30 badges are refused —
 * and linted (`lintGamification`: duplicate ids, a custom variable that is not a calculation).
 */
export type GamificationAction = {
  op: "set_gamification";
  enabled?: boolean; perAnswer?: number; perCorrect?: number; customVariable?: string | null;
  badges?: BadgeSpec[]; addBadges?: BadgeSpec[]; removeBadges?: string[];
  levels?: { name: string; minPoints: number }[];
  hud?: { show?: boolean; position?: "top-right" | "top-left" | "bottom-right" | "bottom-left" };
  clear?: boolean;
};
export interface BadgeSpec { id: string; title: string; icon?: (typeof BADGE_ICONS)[number]; description?: string; when?: string | ConditionT; minPoints?: number }
export const GAMIFICATION_ACTION_OPS = ["set_gamification"] as const;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;

function coerceBadge(x: unknown): BadgeSpec | string {
  if (!x || typeof x !== "object") return "a badge is {id, title, icon, when}";
  const o = x as Record<string, unknown>;
  const title = str(o.title ?? o.name, 80);
  const id = str(o.id, 40) ?? (title ? title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40) : undefined);
  if (!id || !title) return "a badge needs an id and a title";
  const icon = o.icon === undefined ? undefined : (BADGE_ICONS as readonly string[]).includes(String(o.icon)) ? (o.icon as BadgeSpec["icon"]) : null;
  if (icon === null) return `badge ${id}: icon must be one of ${BADGE_ICONS.join(", ")}`;
  const when = typeof o.when === "string" ? o.when.trim().slice(0, 500) : o.when && typeof o.when === "object" ? (o.when as ConditionT) : undefined;
  const minPoints = num(o.minPoints);
  if (when === undefined && minPoints === undefined) return `badge ${id}: give "when" (e.g. "POINTS >= 30") or minPoints`;
  return { id, title, ...(icon ? { icon } : {}), ...(str(o.description, 200) ? { description: str(o.description, 200)! } : {}), ...(when !== undefined ? { when } : {}), ...(minPoints !== undefined ? { minPoints } : {}) };
}

export function coerceGamificationAction(o: Record<string, unknown>): GamificationAction | string {
  const a: GamificationAction = { op: "set_gamification" };
  if (o.clear === true || o.gamification === null) return { op: "set_gamification", clear: true };
  if (typeof o.enabled === "boolean") a.enabled = o.enabled;
  const pa = num(o.perAnswer ?? o.pointsPerAnswer), pc = num(o.perCorrect ?? o.pointsPerCorrect);
  for (const [k, v] of [["perAnswer", pa], ["perCorrect", pc]] as const) {
    if (v === undefined) continue;
    if (v < 0 || v > 1000) return `set_gamification ${k} must be 0–1000`;
    a[k] = v;
  }
  if (o.customVariable === null) a.customVariable = null; else if (str(o.customVariable, 80)) a.customVariable = str(o.customVariable, 80);
  for (const key of ["badges", "addBadges"] as const) {
    if (o[key] === undefined) continue;
    if (!Array.isArray(o[key])) return `set_gamification ${key} must be a list`;
    const out: BadgeSpec[] = [];
    for (const b of (o[key] as unknown[]).slice(0, 30)) { const c = coerceBadge(b); if (typeof c === "string") return `set_gamification: ${c}`; out.push(c); }
    a[key] = out;
  }
  if (Array.isArray(o.removeBadges)) a.removeBadges = o.removeBadges.map(String).slice(0, 30);
  if (o.levels !== undefined) {
    if (!Array.isArray(o.levels)) return "set_gamification levels must be a list of {name, minPoints}";
    const lv = [];
    for (const l of o.levels.slice(0, 20)) {
      const x = (l ?? {}) as Record<string, unknown>;
      const name = str(x.name ?? x.title, 60), mp = num(x.minPoints ?? x.points);
      if (!name || mp === undefined || mp < 0) return "set_gamification: a level is {name, minPoints ≥ 0}";
      lv.push({ name, minPoints: mp });
    }
    a.levels = lv;
  }
  if (o.hud !== undefined) {
    const h = (o.hud ?? {}) as Record<string, unknown>;
    const position = h.position === undefined ? undefined : (POSITIONS as readonly string[]).includes(String(h.position)) ? (h.position as (typeof POSITIONS)[number]) : null;
    if (position === null) return `set_gamification hud.position must be ${POSITIONS.join(" | ")}`;
    a.hud = { ...(typeof h.show === "boolean" ? { show: h.show } : {}), ...(position ? { position } : {}) };
  }
  return Object.keys(a).length > 1 ? a : "set_gamification changes nothing — give perAnswer, perCorrect, customVariable, badges, levels, hud, enabled or clear";
}

class GamError extends Error {}
const fail = (m: string): never => { throw new GamError(m); };

function resolveWhen(def: SurveyDefinition, b: BadgeSpec): ConditionT {
  if (b.when === undefined) return badgeRule(`POINTS >= ${b.minPoints}`)!;
  if (typeof b.when !== "string") {
    const p = Condition.safeParse(b.when);
    return p.success ? p.data : fail(`badge ${b.id}: the condition is not a valid condition object`);
  }
  const quick = badgeRule(b.when);
  if (quick) return quick;
  const r = conditionFromText(def, b.when, { strict: true });
  if (r.errors.length || !r.condition) fail(`badge ${b.id}: cannot read “${b.when}” as a condition — ${r.errors[0]?.message ?? "unknown"}${r.errors[0]?.suggestion ? ` (did you mean ${r.errors[0].suggestion}?)` : ""}; thresholds are written POINTS >= 30, POINTS_CORRECT >= 3, POINTS_ANSWERED >= 10, LEVEL >= 2`);
  return r.condition!;
}

export function applyGamificationAction(def: SurveyDefinition, a: GamificationAction): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  if (a.clear) {
    if (!def.gamification) fail("this survey has no gamification to remove");
    const n = def.gamification!.badges.length;
    delete (def as { gamification?: unknown }).gamification;
    return { description: "gamification removed", destructive: `removes points, ${n} badge${n === 1 ? "" : "s"} and the levels`, warnings: [], touched: [] };
  }
  const cur = def.gamification ?? Gamification.parse({});
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(cur));
  const done: string[] = [];
  const lossy: string[] = [];
  if (a.enabled !== undefined) { next.enabled = a.enabled; done.push(a.enabled ? "on" : "off"); }
  const pts = next.points as Record<string, unknown>;
  if (a.perAnswer !== undefined) { pts.perAnswer = a.perAnswer; done.push(`${a.perAnswer} points per answer`); }
  if (a.perCorrect !== undefined) { pts.perCorrect = a.perCorrect; done.push(`${a.perCorrect} points per correct answer`); }
  if (a.customVariable === null) { delete pts.customVariable; done.push("no custom points"); }
  else if (a.customVariable) { pts.customVariable = a.customVariable; done.push(`+ ${a.customVariable}`); }
  const toBadge = (b: BadgeSpec) => ({ id: b.id, title: b.title, icon: b.icon ?? "star", ...(b.description ? { description: b.description } : {}), when: resolveWhen(def, b) });
  let badges = (next.badges as { id: string }[]);
  if (a.badges) { if (badges.length) lossy.push(`replaces ${badges.length} badge${badges.length === 1 ? "" : "s"}`); badges = a.badges.map(toBadge); done.push(`${badges.length} badge${badges.length === 1 ? "" : "s"}`); }
  if (a.addBadges) { for (const b of a.addBadges) { badges = badges.filter((x) => x.id !== b.id); badges.push(toBadge(b)); } done.push(`added ${a.addBadges.map((b) => b.id).join(", ")}`); }
  if (a.removeBadges) {
    const before = badges.length;
    badges = badges.filter((x) => !a.removeBadges!.includes(x.id));
    if (badges.length === before) fail(`no badge called ${a.removeBadges.join(", ")}`);
    lossy.push(`removes badge${a.removeBadges.length === 1 ? "" : "s"} ${a.removeBadges.join(", ")}`); done.push("badges removed");
  }
  next.badges = badges;
  if (a.levels) { next.levels = [...a.levels].sort((x, y) => x.minPoints - y.minPoints); done.push(`levels ${(next.levels as { name: string; minPoints: number }[]).map((l) => `${l.name} ≥ ${l.minPoints}`).join(", ")}`); }
  if (a.hud) { next.hud = { ...(next.hud as object), ...a.hud }; done.push(`HUD ${a.hud.show === false ? "hidden" : (a.hud.position ?? "shown")}`); }
  const parsed = Gamification.safeParse(next);
  if (!parsed.success) fail(`set_gamification: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  (def as { gamification?: unknown }).gamification = parsed.data!;
  const warnings = lintGamification(def);
  return { description: `Gamification: ${done.join(", ") || "updated"}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [] };
}

export function describeGamificationAction(a: GamificationAction): string {
  if (a.clear) return "Remove gamification";
  const bits = [a.perAnswer !== undefined ? `${a.perAnswer} pts/answer` : "", a.perCorrect !== undefined ? `${a.perCorrect} pts/correct` : "", a.badges ? `${a.badges.length} badges` : "", a.addBadges ? `+${a.addBadges.length} badges` : "", a.levels ? `${a.levels.length} levels` : "", a.hud ? "HUD" : ""].filter(Boolean);
  return `Set gamification${bits.length ? ` (${bits.join(", ")})` : ""}`;
}
