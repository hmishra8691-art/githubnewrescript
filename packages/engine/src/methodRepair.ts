import type { Question, SurveyDefinition } from "@rescript/schema";
import { stripHtmlText } from "./html.js";
import { isMethodOp } from "./methodActions.js";

/**
 * REFUSED MAXDIFF / CONJOINT ACTIONS — CORRECTED BY THE STUDIO WHERE ONLY ONE CORRECTION EXISTS, EXPLAINED WHERE
 * IT DOES NOT (engine weakness #13, 2026-10-22).
 *
 * A model writes a design that the gate or the generator refuses: 5 items per task from a list of 5, 6 alternatives
 * from attributes that make 4 concepts, a None option beside dual-response, a level listed twice, 6 rating profiles
 * for 9 part-worths. Before this, such a refusal at the gate (`create_conjoint … needs …`) never reached the one
 * repair call at all (only apply-time refusals did), so the researcher got "nothing was changed".
 *
 * `autoFixMethodAction` is the deterministic half: where the refusal has exactly ONE least-change correction, the
 * Studio makes it and says so (no model call, no charge). It never invents content: missing attributes, levels,
 * items or prices, and prohibitions that rule out every concept, are never "fixed" — `explainMethodRefusal` turns
 * those into the precise reason the repair call (and, if that fails too, the researcher) is given.
 *
 * Works on a plain action object — the model's raw JSON or the gate's typed action (both spellings are read) — and
 * returns a new object; the caller passes it back through the gate, so a "fix" is never trusted on its own.
 */

export interface MethodFix { action: Record<string, unknown>; note: string }

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.trim())) ? Number(v.trim()) : undefined);
const firstKey = (o: Record<string, unknown>, keys: string[]): string | undefined => keys.find((k) => o[k] !== undefined && o[k] !== null);
const norm = (s: string) => stripHtmlText(s).trim().toLowerCase().replace(/\s+/g, " ");
const labelOf = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : x && typeof x === "object" ? String((x as Record<string, unknown>).label ?? (x as Record<string, unknown>).name ?? "") : "");

const PER_TASK = ["perTask", "itemsPerTask", "items_per_task"];
const TASKS = ["tasks", "tasksPerVersion"];
const VERSIONS = ["versions", "blocks"];
const APPEARANCES = ["appearances", "appearancesPerItem"];
const ALTERNATIVES = ["alternatives", "alternativesPerTask", "concepts", "conceptsPerTask"];
const PROFILES = ["profiles", "profilesPerVersion", "pairs"];

function questionByRef(def: SurveyDefinition | undefined, ref: unknown): Question | undefined {
  if (!def || typeof ref !== "string") return undefined;
  const r = ref.trim();
  return def.questions.find((q) => q.code === r || q.id === r || q.variableName === r) ?? def.questions.find((q) => q.code.toLowerCase() === r.toLowerCase());
}
/** the items a MaxDiff action scales: its list, or the options of the question it takes them from (as the gate counts them) */
function maxdiffItems(def: SurveyDefinition | undefined, o: Record<string, unknown>): string[] | null {
  if (Array.isArray(o.items)) return o.items.map(labelOf).filter(Boolean);
  const q = questionByRef(def, o.itemsFrom ?? o.items_from ?? o.source);
  if (!q) return null;
  const grid = /matrix|grid/.test(q.type) || ((q.rows?.length ?? 0) > 0 && (q.options?.length ?? 0) > 0 && /matrix/.test(q.variant ?? ""));
  const list = (grid && q.rows?.length ? q.rows : q.options ?? []) as { label: string; flags?: string[] }[];
  return list.filter((x) => !(x.flags ?? []).some((f) => ["exclusive", "other_specify", "none_of_above", "dont_know", "refused"].includes(f))).map((x) => stripHtmlText(x.label).trim()).filter(Boolean);
}
const dedupe = (xs: unknown[]): { out: unknown[]; dropped: string[] } => {
  const seen = new Set<string>(); const out: unknown[] = []; const dropped: string[] = [];
  for (const x of xs) { const k = norm(labelOf(x)); if (k && seen.has(k)) { dropped.push(labelOf(x)); continue; } seen.add(k); out.push(x); }
  return { out, dropped };
};

/**
 * The one correction of a refused MaxDiff / conjoint action, or null when there is none to make without asking
 * the researcher. `reason` is the refusal the gate or the generator gave; `def` resolves `itemsFrom`.
 */
export function autoFixMethodAction(action: Record<string, unknown>, reason: string, def?: SurveyDefinition): MethodFix | null {
  const op = String(action.op ?? action.action ?? "");
  if (!isMethodOp(op) || op === "simulate_conjoint") return null;
  const o: Record<string, unknown> = { ...action };
  const r = reason;
  const isMaxDiff = op.endsWith("_maxdiff");

  /* the same item / level listed twice — the second mention dropped (the list keeps its order) */
  if (isMaxDiff && /lists? “.+?” twice|Items must be unique/i.test(r) && Array.isArray(o.items)) {
    const { out, dropped } = dedupe(o.items);
    if (dropped.length) { o.items = out; return { action: o, note: `removed the repeated item${dropped.length === 1 ? "" : "s"} ${dropped.map((d) => `“${d}”`).join(", ")} (a MaxDiff item may appear once)` }; }
  }
  if (!isMaxDiff && /lists "(.+?)" more than once|every level must be different/i.test(r) && Array.isArray(o.attributes)) {
    const notes: string[] = [];
    o.attributes = (o.attributes as unknown[]).map((a) => {
      if (!a || typeof a !== "object" || !Array.isArray((a as Record<string, unknown>).levels)) return a;
      const x = a as Record<string, unknown>;
      const { out, dropped } = dedupe(x.levels as unknown[]);
      if (dropped.length) notes.push(`${labelOf(x)}: ${dropped.map((d) => `“${d}”`).join(", ")}`);
      return dropped.length ? { ...x, levels: out } : x;
    });
    if (notes.length) return { action: o, note: `removed the repeated level${notes.length === 1 ? "" : "s"} (${notes.join("; ")}) — a level may appear once` };
  }

  if (isMaxDiff) {
    const items = maxdiffItems(def, o);
    const n = items?.length ?? null;
    const pk = firstKey(o, PER_TASK);
    const per = pk ? num(o[pk]) : undefined;
    /* items per task: at least 3 (best and worst need a middle), at most one fewer than the items */
    if (pk && per !== undefined && /perTask|itemsPerTask|items per task|requires at least itemsPerTask \+ 1/i.test(r) && n !== null && n >= 4) {
      const fixed = Math.max(3, Math.min(Math.round(per), n - 1));
      if (fixed !== per) { o[pk] = fixed; return { action: o, note: `${fixed} items per task instead of ${per} — ${per > n - 1 ? `${n} items allow at most ${n - 1} per task (one must be left out to compare)` : "a best–worst task needs at least 3 items"}` }; }
    }
    /*
     * Too few tasks for the appearances asked, or to show every item once: the fewest tasks that work — only when the
     * action did not STATE the tasks (an update that raised the appearances, keeping the stored tasks). Tasks the
     * researcher stated are theirs: more tasks, more versions, more items per task or fewer appearances would each
     * fix it, so the refusal goes to the repair (and the researcher) with the reason.
     */
    const tk = firstKey(o, TASKS), ak = firstKey(o, APPEARANCES);
    const atLeast = /Use at least (\d+) tasks/i.exec(r);
    if (atLeast && !tk) {
      const need = Number(atLeast[1]);
      const key = tk ?? "tasks";
      const was = tk ? num(o[tk]) : undefined;
      if (need > 0 && need !== was) { o[key] = need; return { action: o, note: `${need} tasks${was !== undefined ? ` instead of ${was}` : ""} — the fewest that show each item ${ak ? `${num(o[ak]) ?? "the asked number of"} times` : "as often as the design needs"}` }; }
    }
    if (/cannot show all (\d+) items even once/i.test(r) && n !== null && !tk) {
      const versions = num(o[firstKey(o, VERSIONS) ?? "versions"]) ?? 1;
      const p = per ?? 4;
      const need = Math.ceil(n / Math.max(1, versions * p));
      const key = tk ?? "tasks";
      const was = tk ? num(o[tk]) : undefined;
      if (need > (was ?? 0)) { o[key] = need; return { action: o, note: `${need} tasks${was !== undefined ? ` instead of ${was}` : ""} — the fewest that show all ${n} items at least once` }; }
    }
    return null;
  }

  /* conjoint */
  /* dual-response None replaces the in-task None: the None option is dropped (keeping dualResponse, which is the newer and explicit ask) */
  if (/dual-response None replaces the None alternative/i.test(r) && (o.none !== undefined || o.noneOption !== undefined)) {
    delete o.none; delete o.noneOption; delete o.noneLabel;
    return { action: o, note: "no None alternative inside the task — dual-response asks “would you actually buy it?” after each choice instead (the two cannot be combined)" };
  }
  /* more alternatives per task than the attributes can make different concepts: as many as there are */
  const space = /make only (\d+) different concepts, and each task needs (\d+)/i.exec(r);
  if (space) {
    const k = firstKey(o, ALTERNATIVES) ?? "alternatives";
    const can = Number(space[1]);
    if (can >= 2) { o[k] = can; return { action: o, note: `${can} alternatives per task instead of ${space[2]} — these attributes make only ${can} different concepts` }; }
  }
  /* too few rating profiles to estimate each respondent's part-worths: the fewest that identify them */
  const prof = /cannot identify (\d+) part-worths.*?use at least (\d+)/i.exec(r);
  if (prof) {
    const k = firstKey(o, PROFILES) ?? "profiles";
    const need = Number(prof[2]);
    const was = num(o[k]);
    if (need > (was ?? 0)) { o[k] = need; return { action: o, note: `${need} ${/pairs/i.test(r) ? "pairs" : "profiles"} per version${was !== undefined ? ` instead of ${was}` : ""} — the fewest that identify ${prof[1]} part-worths for one respondent` }; }
  }
  return null;
}

/**
 * The refusal, made precise for the one repair call (and the researcher): which prohibitions, which attribute, what
 * cannot be assumed. The engine's reason first, unchanged; what it cannot say alone after it.
 */
export function explainMethodRefusal(action: Record<string, unknown>, reason: string): string {
  const op = String(action.op ?? action.action ?? "");
  if (!isMethodOp(op)) return reason;
  const extra: string[] = [];
  const pros = action.prohibitions ?? action.addProhibitions;
  if (/prohibitions (?:rule out every|leave only)|appears in no legal (?:concept|profile)/i.test(reason) && Array.isArray(pros) && pros.length) {
    const said = pros.slice(0, 8).map((p) => {
      if (Array.isArray(p)) return p.map(labelOf).join(" with ");
      if (p && typeof p === "object") {
        const x = p as Record<string, unknown>;
        if (x.a && x.b) return [x.a, x.b, ...(Array.isArray(x.also) ? x.also : [])].map((l) => (l && typeof l === "object" ? `${(l as Record<string, unknown>).attribute} ${(l as Record<string, unknown>).level}` : String(l))).join(" with ");
        return Object.entries(x).filter(([k]) => k !== "note").map(([k, v]) => `${k} ${labelOf(v)}`).join(" with ");
      }
      return String(p);
    });
    extra.push(`The prohibitions given were: ${said.join("; ")}. The Studio cannot choose which to drop — remove or relax the one that is not essential, or ask the researcher which combinations must really never be shown.`);
  }
  if (/needs at least 2 levels|needs the attributes and their levels|needs the items|needs the menu/i.test(reason)) extra.push("Do not invent attributes, levels, items or prices: use what the researcher or the brief stated, otherwise leave the action out and ask for them in \"reply\".");
  if (/does not apply to/i.test(reason)) extra.push("Either drop that field or use the method it belongs to — keep the method the researcher asked for.");
  return extra.length ? `${reason} ${extra.join(" ")}` : reason;
}
