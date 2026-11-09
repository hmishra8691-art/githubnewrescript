import type { ClientStep } from "../copilot/taskStore.ts";

/**
 * WHO DOES WHAT INSIDE THE TASK ENGINE (2026-11-07; the researcher-facing workspace was removed 2026-11-08).
 *
 * Intelligent mode is the only place a researcher starts and follows AI work; the agents behind it are internal.
 * This registry still names every agent and the exact step kinds it owns, because the engine relies on that map:
 * every step kind a registered handler runs has exactly one owner (tested), and Intelligent mode tells building
 * steps from independent checks by it (lib/intelligent/taskPhases.ts). It is never shown to the researcher.
 */

export type AgentId = "design" | "writer" | "logic" | "translation" | "assessment" | "validation" | "analysis" | "writing" | "decision";
export type AgentAvailability = "active" | "partial" | "planned";
export type Stage = "design" | "collect" | "analyze" | "act";

export interface AgentDef {
  id: AgentId;
  name: string;
  /** what it does, in a researcher's words */
  role: string;
  stage: Stage;
  availability: AgentAvailability;
  /** the step kinds (exact, or a prefix ending in ".") the engine runs for it */
  kinds: string[];
  /** a deterministic checker, not a model call */
  deterministic?: boolean;
  /** for partial and planned agents: what exists and what does not, said plainly */
  note?: string;
}

export const AGENTS: AgentDef[] = [
  { id: "design", name: "Research design", role: "Turns the brief into a design: structure, blocks, method designs, rotation and quotas", stage: "design", availability: "active",
    kinds: ["gen.design", "gen.skeleton", "gen.methods_design", "gen.randomization", "gen.quotas"] },
  { id: "writer", name: "Questionnaire writer", role: "Writes and reworks questions in batches, and repairs what the final check finds", stage: "design", availability: "active",
    kinds: ["gen.batch", "gen.batch_repair", "gen.edit_batch", "gen.repair", "copilot.generate", "copilot.rework", "copilot.turn", ""] },
  { id: "logic", name: "Logic", role: "Adds skip, display and branch logic over the questions written", stage: "design", availability: "active", kinds: ["gen.logic"] },
  { id: "translation", name: "Translation", role: "Translates the questionnaire into a target language, batch by batch", stage: "design", availability: "active", kinds: ["translation.prepare", "translation.batch"] },
  { id: "assessment", name: "Assessment", role: "Sets scoring and answer keys for exams and scored question sets", stage: "design", availability: "active", kinds: ["assessment.settings"] },
  { id: "validation", name: "Validation", role: "Checks every deliverable against its completion criteria before a task may complete", stage: "design", availability: "active", deterministic: true,
    kinds: ["gen.validate", "copilot.check", "assessment.validate", "translation.verify"] },
  { id: "analysis", name: "Analysis", role: "Writes the analysis plan, runs every planned analysis on the data, and verifies findings and hypothesis verdicts", stage: "analyze", availability: "active", deterministic: true,
    kinds: ["gen.analysis_plan", "analysis.check", "analysis.apply", "analysis.verify"] },
  { id: "writing", name: "Report writing", role: "Writes the findings storyline from the latest verified run, then hands it to the deck and Word report", stage: "act", availability: "active", deterministic: true,
    kinds: ["report.evidence", "report.storyline", "report.check"] },
  { id: "decision", name: "Decision", role: "Turns verdicts and the findings that hold into recommended actions, each tied to its evidence", stage: "act", availability: "active", deterministic: true,
    kinds: ["decision.evidence", "decision.brief", "decision.check"] },
];

/** the agent a step belongs to; a plan item of the survey_build path (no kind) is the questionnaire writer's */
export function agentOf(step: Pick<ClientStep, "kind">): AgentId | null {
  const kind = step.kind ?? "";
  for (const a of AGENTS) if (a.kinds.some((k) => (k.endsWith(".") ? kind.startsWith(k) : k === kind))) return a.id;
  return null;
}
