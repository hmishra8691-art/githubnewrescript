import type { SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import { visibleQuestions } from "./flow.js";
import { flattenVariables } from "./flatten.js";
import { evaluateCondition, type EvalTrace } from "./evaluate.js";
import { explainOptions, type OptionPipelineTrace } from "./carryforward.js";
import { quotaStatus, type QuotaCounts, type QuotaCellStatus } from "./quotas.js";

/**
 * Programmer inspector (requirements §24–25): a full snapshot of the
 * session's technical state, rendered by the test runtime's debug panel.
 */

export interface InspectorSnapshot {
  page: { index: number; pageId: string; title?: string; sectionPath: string[] } | null;
  loop: { loopVar: string; code: string; label: string; index: number } | null;
  visibleQuestionIds: string[];
  answers: Record<string, unknown>;
  flatVariables: Record<string, unknown>;
  calculated: Record<string, unknown>;
  embedded: Record<string, unknown>;
  flags: string[];
  displayLogicResults: { questionId: string; visible: boolean; trace: EvalTrace[] }[];
  /**
   * Stage-by-stage option pipeline for every question on this page whose
   * option list is dynamic — the runtime half of the option debugger
   * (reqs §15, §29).
   */
  optionPipelines: { questionId: string; code: string; trace: OptionPipelineTrace }[];
  quotas: QuotaCellStatus[];
  status: string;
  seed: number;
  stepIndex: number;
  totalSteps: number;
}

export function inspect(
  def: SurveyDefinition,
  state: ResponseState,
  steps: RuntimeStep[],
  quotaCounts: QuotaCounts = {},
): InspectorSnapshot {
  const step = steps[state.stepIndex];
  const pageStep = step?.kind === "page" ? step : null;

  const displayLogicResults: InspectorSnapshot["displayLogicResults"] = [];
  if (pageStep) {
    for (const qid of pageStep.questionIds) {
      const q = def.questions.find((x) => x.id === qid);
      if (!q) continue;
      const trace: EvalTrace[] = [];
      const visible = evaluateCondition(q.displayLogic, {
        def,
        state,
        loop: pageStep.loop,
        trace,
      });
      displayLogicResults.push({ questionId: qid, visible, trace });
    }
  }

  const optionPipelines: InspectorSnapshot["optionPipelines"] = [];
  if (pageStep) {
    for (const qid of pageStep.questionIds) {
      const q = def.questions.find((x) => x.id === qid);
      if (!q) continue;
      const dynamic =
        !!q.carryForward ||
        (q.listLogic?.length ?? 0) > 0 ||
        (q.optionPipeline?.length ?? 0) > 0 ||
        q.options.some((o) => o.logic || o.visibleIf) ||
        !!q.randomization?.enabled;
      if (!dynamic) continue;
      try {
        optionPipelines.push({
          questionId: qid,
          code: q.code,
          trace: explainOptions(q, { def, state, loop: pageStep.loop }),
        });
      } catch {
        /* a broken definition must never break the inspector */
      }
    }
  }

  return {
    page: pageStep
      ? {
          index: state.stepIndex,
          pageId: pageStep.pageId,
          title: pageStep.title,
          sectionPath: pageStep.sectionPath,
        }
      : null,
    loop: pageStep?.loop ?? null,
    visibleQuestionIds: pageStep
      ? visibleQuestions(def, pageStep, state, quotaCounts).map((q) => q.id)
      : [],
    answers: state.answers,
    flatVariables: flattenVariables(def, state),
    calculated: state.calculated,
    embedded: state.embedded,
    flags: state.flags,
    displayLogicResults,
    optionPipelines,
    quotas: quotaStatus(def, state, quotaCounts),
    status: state.status,
    seed: state.seed,
    stepIndex: state.stepIndex,
    totalSteps: steps.length,
  };
}
