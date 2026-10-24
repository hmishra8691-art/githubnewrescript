/**
 * WHAT "DONE" MEANS. (scaffold, 2026-10-24) — Owner: R4.
 *
 * A task is `completed` only when every step completed AND the deliverable
 * spec passes. Checked by DETERMINISTIC CODE, never by a model, and built out
 * of the validators that already exist — `lintVariables`,
 * `validateActionOutcome`, `plannedItemReadiness`, `lintLanguage`, the
 * conjoint and MaxDiff design-structure validators. Write no second
 * validator.
 */
import type { DeliverableReport, DeliverableSpec } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

const TODO = (what: string): never => { throw new Error(`deliverable: ${what} is not implemented yet (R4)`); };

/** the one gate on `completed`. `def` is the survey as the task would leave it. */
export function checkDeliverable(_spec: DeliverableSpec, _def: SurveyDefinition): DeliverableReport {
  return TODO("checkDeliverable");
}

/** read a spec off the researcher's request and the plan, at task creation time */
export function specFromRequest(_request: string, _hint?: Partial<DeliverableSpec>): DeliverableSpec {
  return TODO("specFromRequest");
}
