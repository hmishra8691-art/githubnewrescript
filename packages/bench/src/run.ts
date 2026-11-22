import type { Suite } from "./core.js";
import { agentDesign, agentInstructions, agentModel, agentOperations } from "./suites/agent.js";
import { fraudRedTeam } from "./suites/fraud.js";
import { importFidelity } from "./suites/importFidelity.js";
import { analyticsPerf, programmingPerf } from "./suites/perf.js";
import { verifierPlanted } from "./suites/verifier.js";
import { speechProviders } from "./suites/speech.js";

/**
 * EVERY BENCHMARK THERE IS, in the order the scorecard prints them. A new suite is added here and nowhere else.
 * Reporting and dashboards has none yet: its Level 5 tests are about people reading a report, which Phase 1 does
 * not measure, and the scorecard says "No benchmark yet" for it instead of leaving it out.
 */
export function allSuites(root: string): Suite[] {
  return [agentInstructions, agentOperations, agentDesign, verifierPlanted, agentModel, programmingPerf, analyticsPerf, importFidelity(root), speechProviders, fraudRedTeam];
}
