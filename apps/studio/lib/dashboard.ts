import "server-only";

/**
 * The server-only door onto the dashboard statistics.
 *
 * The work itself lives in `dashboardCore.ts`, free of `server-only` so a
 * test can drive it over a fake Supabase — the same split `advancedModels` /
 * `advancedModelsCore` and `modelJobs` / `modelJobsCore` already use. It was
 * made when the project list was found to be reporting 0 questions for any
 * survey built after its version was cut, and the module could not be tested
 * at all: importing it threw "This module cannot be imported from a Client
 * Component module."
 *
 * Both callers (`/api/surveys` and `/api/surveys/[id]/overview`) import this
 * file and are unchanged.
 */
export * from "./dashboardCore.ts";
