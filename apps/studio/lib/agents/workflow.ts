import type { ModuleKey, ModuleStatus } from "../projectOverview.ts";
import { STAGES, type Stage } from "./workspace.ts";

/**
 * DESIGN → COLLECT → ANALYZE → ACT, FROM WHAT IS SAVED (ResLens redesign, 2026-11-07).
 *
 * The reference journey, drawn over the module states the Project overview already computes (lib/projectOverview.ts
 * `moduleStates`) — no second opinion about a project's state. Each stage is the worst of its modules: any module
 * needing attention marks the stage; all configured completes it; nothing configured has not started. A stage whose
 * modules could not be read (the sandbox has no saved responses, reports or runs) is UNKNOWN, never "not started".
 */
export const STAGE_MODULES: Record<Stage, ModuleKey[]> = {
  design: ["research", "programming", "quotas", "languages"],
  collect: ["fieldwork", "collection", "quality"],
  analyze: ["analysis"],
  act: ["reporting"],
};

export type StageState = "done" | "in_progress" | "attention" | "not_started" | "unknown";
export interface StageView { id: Stage; label: string; question: string; state: StageState; modules: ModuleStatus[] }

export function workflowStages(modules: ModuleStatus[], opts: { unknown?: Stage[] } = {}): StageView[] {
  return STAGES.map((s) => {
    const mine = STAGE_MODULES[s.id].map((k) => modules.find((m) => m.key === k)).filter((m): m is ModuleStatus => !!m);
    let state: StageState;
    if (opts.unknown?.includes(s.id) || !mine.length) state = "unknown";
    else if (mine.some((m) => m.state === "needs_attention")) state = "attention";
    else if (mine.every((m) => m.state === "configured")) state = "done";
    else if (mine.every((m) => m.state === "not_configured")) state = "not_started";
    else state = "in_progress";
    return { ...s, state, modules: opts.unknown?.includes(s.id) ? [] : mine };
  });
}
