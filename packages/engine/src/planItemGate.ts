import type { PlannedCrosstab, PlannedTest, SurveyDefinition } from "@rescript/schema";

/**
 * THE ONE READINESS RULE, AT ACTION TIME (engine weakness #12, 2026-10-22).
 *
 * The analytics package's `plannedItemReadiness` (planCheck.ts) is the single rule the builder, the run route, the
 * plan editor and the apply read: a planned crosstab or test that it calls "not ready" is shown invalid in Data
 * Analytics and skipped by the apply. The copilot's analysis-plan actions (add_crosstab, add_analysis_test,
 * set_analysis_plan, update_*) used to store such an item anyway, and the researcher learnt it was invalid later.
 *
 * The engine cannot import the analytics package (analytics depends on the engine — dependency-boundaries), so the
 * rule is REGISTERED here by whoever loads both (`registerPlanReadinessGate()` in @rescript/analytics: the copilot
 * route, the browser's replay on Apply, the eval harness). With it registered, `applyAnalysisAction` refuses an item
 * that is not ready with the rule's own words ("An ANOVA compares groups — choose the grouping variable."), so the
 * one repair call can fix it; nothing invalid is stored silently. Without it (an engine unit test, a caller that
 * never loads analytics) the actions behave exactly as before.
 *
 * Kept on `globalThis` under a symbol: a bundler that ends up with two copies of the engine module still shares the
 * one registered rule. Stored plans are never re-checked here — only what an action writes.
 */

export type PlanItemForGate = { kind: "crosstab"; crosstab: PlannedCrosstab } | { kind: "test"; test: PlannedTest };
export interface PlanItemReadinessResult { ready: boolean; missing: string[]; warnings: string[] }
export type PlanItemReadinessFn = (item: PlanItemForGate, def: SurveyDefinition) => PlanItemReadinessResult;

const KEY = Symbol.for("rescript.engine.planItemReadiness");
type Holder = { [KEY]?: PlanItemReadinessFn | null };

export function registerPlanItemReadiness(fn: PlanItemReadinessFn | null): void { (globalThis as Holder)[KEY] = fn; }
export function planItemReadinessRule(): PlanItemReadinessFn | null { return (globalThis as Holder)[KEY] ?? null; }

/** the registered rule on one item, or null when none is registered (or it threw — a rule that fails never blocks a change) */
export function checkPlanItem(item: PlanItemForGate, def: SurveyDefinition): PlanItemReadinessResult | null {
  const fn = planItemReadinessRule();
  if (!fn) return null;
  try { return fn(item, def); } catch { return null; }
}
