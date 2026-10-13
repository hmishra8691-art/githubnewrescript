import type { AnalysisPlan, PlannedCrosstab, PlannedTest, SurveyDefinition } from "@rescript/schema";
import { structuredHypotheses, type StructuredHypothesis } from "./hypotheses.js";

/**
 * WHAT A PLAN ITEM READS, WHICH HYPOTHESIS IT SERVES, AND HOW MUCH IT MATTERS
 * (Data Analytics audit, Oct 2026 — P-6, P-7, P-8).
 *
 * The plan builder tagged an item with every hypothesis that names the
 * construct of ANY question the item touches, so a table of the outcome by
 * the sample profile carried the tag of the hypothesis about price — nearly
 * everything was "answers a hypothesis" and priority 1. The honest question
 * is what the item actually READS: the variables of its rows, columns,
 * outcome, predictors, groups, moderator and mediator, and the constructs
 * those variables measure. An item serves a hypothesis when it reads the
 * constructs on both of the hypothesis's sides.
 *
 * Pure and dependency-light: this file reads the survey and the plan, nothing
 * else, so the builder, the plan review and the workspace share one answer.
 */

export type PlanItem = PlannedCrosstab | PlannedTest;

/** the variable names an item reads — every one, once, in the order it names them */
export function planItemReads(item: PlanItem): string[] {
  const names = "rows" in item
    ? [...item.rows, ...item.columns]
    : [item.outcome, ...item.variables, item.groupBy, item.moderator, item.mediator];
  return [...new Set(names.filter((v): v is string => !!v))];
}

const resolveQuestion = (def: SurveyDefinition, ref: string) => def.questions.find((q) => q.variableName === ref || q.code === ref || q.id === ref);

/** the constructs one variable measures: those listing its question, the one its analysis names; a derived variable measures what its sources do */
export function variableConstructs(def: SurveyDefinition, plan: AnalysisPlan | undefined, name: string, seen: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  const q = resolveQuestion(def, name);
  if (q) {
    for (const c of def.research?.constructs ?? []) if (c.questionIds.includes(q.id)) out.add(c.name);
    if (q.analysis?.construct) out.add(q.analysis.construct);
    return out;
  }
  const d = plan?.derived.find((x) => x.name === name);
  if (d) for (const f of d.from) for (const c of variableConstructs(def, plan, f, seen)) out.add(c);
  return out;
}

export function constructsRead(def: SurveyDefinition, plan: AnalysisPlan | undefined, variables: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const v of variables) for (const c of variableConstructs(def, plan, v)) out.add(c);
  return out;
}

/** the words a hypothesis uses for a group and the labels an answer list gives it */
const GROUP_WORDS: Record<string, string[]> = { women: ["female", "females", "woman"], woman: ["female", "women"], men: ["male", "males", "man"], man: ["male", "men"], girls: ["female", "females"], boys: ["male", "males"] };

/** the question whose answer option is the group a "differs" hypothesis names ("women are more satisfied…" → the gender question), when one is found */
function groupQuestionOf(def: SurveyDefinition, group: string | undefined): string | undefined {
  if (!group) return undefined;
  const g = group.trim().toLowerCase();
  const forms = new Set([g, g.replace(/s$/, ""), `${g}s`, ...(GROUP_WORDS[g] ?? [])]);
  const hits = def.questions.filter((q) => (q.options ?? []).some((o) => forms.has(String(o.label ?? "").trim().toLowerCase())));
  return hits.length === 1 ? hits[0].variableName : undefined;
}

export type HypothesisFit = "fits" | "misses" | "unknown";

/**
 * Does an item that reads `reads` serve this hypothesis? A side the design
 * could not resolve to a construct cannot be judged, and says "unknown" —
 * the old tag is then kept rather than guessed away.
 */
export function hypothesisFit(def: SurveyDefinition, plan: AnalysisPlan | undefined, h: StructuredHypothesis, item: PlanItem): { fit: HypothesisFit; /** both the independent and dependent side are resolved and read */ complete: boolean } {
  const reads = planItemReads(item);
  const read = constructsRead(def, plan, reads);
  const need = [h.constructs.independent, h.constructs.dependent].filter((c): c is NonNullable<typeof c> => !!c);
  const groupQ = h.type === "difference" ? groupQuestionOf(def, h.group) : undefined;
  if (!need.length && !groupQ) return { fit: "unknown", complete: false };
  const missingConstruct = need.some((c) => !read.has(c.name));
  const missingGroup = !!groupQ && !reads.some((r) => r === groupQ || resolveQuestion(def, r)?.variableName === groupQ);
  if (missingConstruct || missingGroup) return { fit: "misses", complete: false };
  /* complete: both sides of the claim are read — the cause and the effect, or the effect and the group that is said to differ */
  return { fit: "fits", complete: !!h.constructs.dependent && (!!h.constructs.independent || !!groupQ) };
}

export interface RetagChange { id: string; kind: "crosstab" | "test"; before: string[]; after: string[]; priorityBefore: number; priorityAfter: number }

const byLabel = (a: string, b: string) => (Number(/\d+/.exec(a)?.[0]) || 0) - (Number(/\d+/.exec(b)?.[0]) || 0);

/**
 * Re-tag every item of the plan with the hypotheses it actually serves.
 * Tags that the item's reads do not support are dropped (an item left with
 * none and priority 1 becomes priority 2 — profiling, not testing); a
 * hypothesis whose two sides the item reads is added. Tags of a hypothesis
 * the design cannot resolve are left as they were. Mutates the items.
 */
export function retagPlanHypotheses(def: SurveyDefinition, plan: AnalysisPlan): RetagChange[] {
  const hs = structuredHypotheses(def);
  if (!hs.length) return [];
  const changes: RetagChange[] = [];
  const each = (item: PlanItem, kind: "crosstab" | "test") => {
    const before = [...item.hypotheses];
    const keep = before.filter((label) => { const h = hs.find((x) => x.label === label); return !h || hypothesisFit(def, plan, h, item).fit !== "misses"; });
    const add = hs.filter((h) => !keep.includes(h.label) && hypothesisFit(def, plan, h, item).complete).map((h) => h.label);
    const after = [...new Set([...keep, ...add])].sort(byLabel);
    if (after.join() === before.join()) return;
    const priorityBefore = item.priority;
    item.hypotheses = after;
    if (before.length && !after.length && item.priority === 1) item.priority = 2;
    if (!before.length && after.length && item.priority > 1) item.priority = 1;
    changes.push({ id: item.id, kind, before, after, priorityBefore, priorityAfter: item.priority });
  };
  for (const x of plan.crosstabs) each(x, "crosstab");
  for (const t of plan.tests) each(t, "test");
  return changes;
}

export interface PlanTagIssue { itemId: string; hypothesis: string; message: string }

/** tags that a saved or hand-edited plan carries without the item reading what the hypothesis is about — the plan review's version of the retag, read-only */
export function planTagIssues(def: SurveyDefinition, plan: AnalysisPlan): PlanTagIssue[] {
  const hs = structuredHypotheses(def);
  const out: PlanTagIssue[] = [];
  for (const item of [...plan.crosstabs, ...plan.tests]) for (const label of item.hypotheses) {
    const h = hs.find((x) => x.label === label);
    if (h && hypothesisFit(def, plan, h, item).fit === "misses") out.push({ itemId: item.id, hypothesis: label, message: `${label} (“${h.text.slice(0, 70)}${h.text.length > 70 ? "…" : ""}”) is tagged on an item that does not read what it is about.` });
  }
  return out;
}

/* ------------------------------------------------------------ tiers (P-7) */

export const PLAN_TIERS = ["essential", "recommended", "exploratory"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];
const DEMANDED = new Set(["maxdiff_scores", "conjoint_utilities", "nps"]);

/** a tier is stored when the researcher set one; otherwise it follows from what the item serves */
export function planTierOf(item: PlanItem): PlanTier {
  if (item.tier) return item.tier;
  const demanded = "method" in item && (DEMANDED.has(item.method) || /^between-arms/.test(item.reason ?? ""));
  if (item.hypotheses.length || demanded) return "essential";
  if (item.priority >= 3) return "exploratory";
  return "recommended";
}

const TIER_RANK: Record<PlanTier, number> = { essential: 0, recommended: 1, exploratory: 2 };

/** how many items the plan applies by default beyond the essential ones — enough to profile every outcome, few enough to read */
export const PLAN_ITEM_CAP = 40;

export interface PlanScope {
  /** ids of the items that are applied */
  inScope: Set<string>;
  /** items left out, in the order they would come next, each with why */
  notShown: { id: string; kind: "crosstab" | "test"; tier: PlanTier; why: string }[];
  tiers: Record<PlanTier, number>;
}

/**
 * WHICH ITEMS THE PLAN APPLIES. Every essential item always; then the rest in
 * tier and priority order up to `cap` in all; an item that already has a saved
 * analysis (`keep`) stays, so a cap never un-applies work. Whatever is left is
 * listed in `notShown` — never silently dropped.
 */
export function planScope(plan: AnalysisPlan, opts: { cap?: number; keep?: ReadonlySet<string> } = {}): PlanScope {
  const cap = opts.cap ?? PLAN_ITEM_CAP;
  const all = [
    ...plan.crosstabs.map((item, order) => ({ item, kind: "crosstab" as const, order })),
    ...plan.tests.map((item, order) => ({ item, kind: "test" as const, order: plan.crosstabs.length + order })),
  ].map((x) => ({ ...x, tier: planTierOf(x.item) }));
  const ranked = [...all].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.item.priority - b.item.priority || b.item.hypotheses.length - a.item.hypotheses.length || a.order - b.order);
  const inScope = new Set<string>();
  const notShown: PlanScope["notShown"] = [];
  for (const x of ranked) {
    if (x.tier === "essential" || opts.keep?.has(x.item.id) || inScope.size < cap) inScope.add(x.item.id);
    else notShown.push({ id: x.item.id, kind: x.kind, tier: x.tier, why: `beyond the ${cap} items the plan applies by default (${x.tier})` });
  }
  const tiers: Record<PlanTier, number> = { essential: 0, recommended: 0, exploratory: 0 };
  for (const x of all) tiers[x.tier]++;
  return { inScope, notShown, tiers };
}
