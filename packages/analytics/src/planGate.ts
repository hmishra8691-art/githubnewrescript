import type { SurveyDefinition } from "@rescript/schema";
import { registerPlanItemReadiness, type PlanItemForGate, type PlanItemReadinessResult } from "@rescript/engine";
import { variableMetadata } from "./dataset.js";
import { plannedItemReadiness } from "./planCheck.js";

/**
 * THE ONE READINESS RULE, REGISTERED WITH THE ENGINE'S ACTION GATE (engine weakness #12, 2026-10-22).
 *
 * `plannedItemReadiness` — what Data Analytics shows as "invalid" and the apply skips — judged on a planned item at
 * the moment an action writes it, with the survey's own variable dictionary (so a grid counts its rows, a CBC
 * question is a CBC question). The engine refuses an item this calls not ready, naming the missing role or
 * variable, instead of storing it. Call `registerPlanReadinessGate()` once wherever survey actions are applied
 * with the analytics package loaded (the copilot route, the browser's replay on Apply, the eval harness).
 */
export function planItemGate(item: PlanItemForGate, def: SurveyDefinition): PlanItemReadinessResult {
  const r = plannedItemReadiness(item.kind === "crosstab" ? { kind: "crosstab", crosstab: item.crosstab } : { kind: "test", test: item.test }, variableMetadata(def), def);
  return { ready: r.ready, missing: r.missing, warnings: r.warnings };
}

export function registerPlanReadinessGate(): void { registerPlanItemReadiness(planItemGate); }
