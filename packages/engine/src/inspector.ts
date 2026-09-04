import type { SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import { visibleQuestions } from "./flow.js";
import { flattenVariables } from "./flatten.js";
import { evaluateCondition, type EvalTrace } from "./evaluate.js";
import { explainOptions, type OptionPipelineTrace } from "./carryforward.js";
import { quotaStatus, type QuotaCounts, type QuotaCellStatus } from "./quotas.js";
import { listFillLoopItems, pendingListFills, unusedListFillDestinations } from "./listFill.js";

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
  /**
   * What each List Fill has allocated to THIS respondent, and what is still
   * waiting to run (§32). A tester's first question about a List Fill is
   * "why did I get that one" — so the items are shown next to the reason,
   * with every option's fate available behind it.
   */
  listFills: {
    listFillId: string;
    name: string;
    /** allocated already: the items, read back from the stored variables */
    items: { code: string; label: string; position: number }[];
    /** true when this list is due to run but has not yet */
    pending: boolean;
    /** destinations left unfilled, and the rule that applies to each */
    unusedDestinations: { questionId: string; rule: string }[];
  }[];
  status: string;
  seed: number;
  stepIndex: number;
  totalSteps: number;
}

/**
 * Each List Fill's state for this respondent.
 *
 * Read from the variables the allocation wrote, never re-decided — the
 * inspector must show what happened, and deciding again here would both
 * report a different answer and consume sample capacity.
 */
function listFillReport(def: SurveyDefinition, state: ResponseState): InspectorSnapshot["listFills"] {
  const pending = new Set(pendingListFills(def, state).map((lf) => lf.id));
  const unused = unusedListFillDestinations(def, state);
  return def.listFills.map((lf) => {
    const items = listFillLoopItems(def, state, lf.id).map((it, i) => ({ ...it, position: i + 1 }));
    return {
      listFillId: lf.id,
      name: lf.name ?? lf.id,
      items,
      pending: pending.has(lf.id),
      unusedDestinations: lf.destinations
        .filter((d) => unused.has(d.questionId))
        .map((d) => ({ questionId: d.questionId, rule: unused.get(d.questionId)! })),
    };
  });
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
    listFills: listFillReport(def, state),
    status: state.status,
    seed: state.seed,
    stepIndex: state.stepIndex,
    totalSteps: steps.length,
  };
}
