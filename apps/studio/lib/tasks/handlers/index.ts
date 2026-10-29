/**
 * EVERY STEP HANDLER AND PLANNER OF THE EXECUTION ENGINE, REGISTERED ONCE PER PROCESS (2026-10-29, ported from K1).
 *
 * Each family registers itself from its own module; add ONE import + call line per family here (additive):
 *   E1  generic.ts      registerGenericTasks()     — the fallback planner (copilot.generate / rework / turn / check)
 *   E1  generation.ts   registerGenerationTasks()   — survey batches, validators, repair, conjoint/MaxDiff
 *   E2  translation.ts  registerTranslationTasks()  — translation as a task
 *   E3  assessment.ts   registerAssessmentTasks()   — answer key, scoring, report
 * Registration is idempotent (last registration wins), so a hot reload is harmless. The turn route, the task
 * routes and the cron call this before they plan or build anything.
 */
import { registerGenericTasks } from "./generic.ts";
import { registerGenerationTasks } from "./generation.ts";
import { registerTranslationTasks } from "./translation.ts";
import { registerAssessmentTasks } from "./assessment.ts";

export function registerAllTaskHandlers(): void {
  /* idempotent by construction (last registration wins), so there is no module flag to defeat a test's registry reset */
  registerGenericTasks();
  registerGenerationTasks();
  registerTranslationTasks();
  registerAssessmentTasks();
}
