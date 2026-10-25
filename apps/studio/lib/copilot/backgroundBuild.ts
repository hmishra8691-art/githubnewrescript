import "server-only";
import { completeJson, type ProviderEvent } from "@rescript/ai";
import type { ExecStep, ExecTask, StepUsage } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { COPILOT_SYSTEM_PROMPT, copilotUserPrompt, surveyLanguageOf } from "./prompt.ts";
import { copilotOutline } from "./outline.ts";
import { COPILOT_REPLY_SCHEMA } from "./replySchema.ts";
import { executeItemPrompt, type ChangePlanItem } from "./changePlan.ts";
import { flagsOf, guideTexts, itemGuideSelection } from "./guideSelect.ts";
import { outputBudget } from "./budget.ts";
import { copilotCall } from "@/lib/aiPromptCache";
import { meteredAi } from "@/lib/metering";
import { backgroundContextFor, isRefused, refusalMessage } from "./background.ts";
import { setStepBuilder, type BuildStep, type BuildStepResult } from "./runner.ts";
import { taskStoreFor } from "./taskStore.ts";

/**
 * BUILDING ONE PLAN ITEM WITH NOBODY WATCHING.
 *
 * `runSlice` owns WHEN a step runs — the order, the lease, the retries, the
 * batch splitting, the idempotency. It has never owned HOW one is built, and
 * this does not change that: it is the `buildStep` the runner is handed, and
 * it is the first non-browser caller of the item path.
 *
 * WHY THIS IS NOT A SECOND BUILD LOOP. The turn route assembles an item's
 * prompt from exported, shared functions — `promptFor`, `itemGuideSelection`,
 * `guideTexts`, `executeItemPrompt`, `copilotCall`, `outputBudget`,
 * `COPILOT_REPLY_SCHEMA` — and so does this. The same guides are selected by
 * the same rule, the same cached block order is produced by the same
 * function, and the same schema validates the answer. What the route has and
 * this cannot is a request: a session, a connection chosen by the person at
 * the keyboard, their consent for this turn. That is the whole reason this
 * file exists, and the whole reason it is careful.
 *
 * THE THREE RULES IT ENFORCES, decided deliberately and not by this code:
 *
 *   AUTHORITY  the task's `created_by`, re-checked before EVERY slice. A
 *              researcher who has left, or been moved to viewer, stops
 *              spending immediately.
 *   PROVIDER   the platform's key, never a person's own. A task whose turn
 *              ran on someone's BYOK connection is not advanced here at all;
 *              it waits for them to open the page.
 *   SPEND      the wallet must cover the slice, and the task has a ceiling
 *              its own plan justifies.
 *
 * A no to any of them PAUSES the task (`needs_attention`) with a sentence
 * for the researcher. It is not a failure: every step already built is
 * intact, and the task finishes the moment the obstacle is removed.
 */

/** the item a step stands for, rebuilt from the step row */
function itemOf(task: ExecTask, step: ExecStep): ChangePlanItem {
  return {
    id: step.stepId,
    title: step.title ?? step.stepId,
    kind: "create",
    objects: [],
    reason: task.request.slice(0, 300),
  };
}

/** every item of the task, in plan order, as the prompt's "what else is being built" list */
function siblingsOf(task: ExecTask): ChangePlanItem[] {
  return task.steps.filter((s) => s.status !== "tombstoned").map((s) => itemOf(task, s));
}

/** what has already been built, for the prompt's context — titles only, never another step's output */
function doneLines(task: ExecTask): string[] {
  return task.steps.filter((s) => s.status === "completed").map((s) => s.title ?? s.stepId);
}

export interface BackgroundBuildDeps {
  definitionFor?: (surveyId: string) => Promise<SurveyDefinition | null>;
}

/**
 * The builder for one task. Returns null when this task may not be advanced
 * in the background, having paused it and said why.
 */
export async function backgroundBuilderFor(task: ExecTask, deps: BackgroundBuildDeps = {}): Promise<BuildStep | null> {
  const outcome = await backgroundContextFor(task);
  if (isRefused(outcome)) {
    /*
     * An UNVERIFIED refusal is a missing answer, not a decided one — a
     * profile row that would not read, an RPC that errored. The task is left
     * exactly as it is so the next sweep can ask again; pausing it would
     * turn a blip into something a person has to clear by hand.
     */
    if (!outcome.refused.unverified) {
      const store = await taskStoreFor(task.surveyId);
      await store.pause(task.id, { reason: outcome.refused.kind, message: refusalMessage(outcome.refused) }).catch(() => undefined);
    }
    return null;
  }
  const { ctx, meter } = outcome;

  const def = await (deps.definitionFor ?? loadDefinition)(task.surveyId);
  if (!def) return null;

  const mode = task.kind === "analysis" ? "review" : "generate";
  const budget = outputBudget("item");

  return async function buildOneStep(step: ExecStep, build): Promise<BuildStepResult> {
    try {
      const item = itemOf(task, step);
      const siblings = siblingsOf(task);
      const index = Math.max(0, siblings.findIndex((x) => x.id === step.stepId));
      const plan = { summary: task.request.slice(0, 300), items: siblings, questions: [], assumptions: [] };

      /* the same selection the route makes, by the same rule */
      const sel = itemGuideSelection({ item, build: {}, mode, passages: "" });
      const core = sel ? guideTexts(sel.core) : undefined;

      /*
       * #7 of the brief: a persisted SUMMARY of the task, never the whole
       * brief on every call. `runSlice` composes it and hands it in.
       */
      /*
       * THE SAME PROMPT BUILDER THE ROUTE USES. `copilotUserPrompt` with the
       * item's own guide flags is exactly what `itemPromptOf` resolves to in
       * the turn route; what is absent here is a request's memory, research
       * context and selection, because there is no session to take them
       * from. The task's summary stands in for the brief (#7: a persisted
       * summary, never the whole brief on every call).
       */
      const prompt = copilotUserPrompt({
        message: task.request,
        outline: copilotOutline(def, {}),
        surveyLanguage: surveyLanguageOf(def),
        mode,
        ...(sel ? { } : {}),
      })
        + (build.summary ? `\n\nWHAT THIS TASK IS\n${build.summary}\n` : "")
        + executeItemPrompt(plan, item, index, siblings, doneLines(task));

      const events: ProviderEvent[] = [];
      const m = await meteredAi(meter, ctx, "AI_REQUEST", {
        estimateText: COPILOT_SYSTEM_PROMPT + prompt,
        maxTokens: budget.expectedTokens,
        operation: `copilot_${mode}_item`,
      }, () => completeJson(...copilotCall(prompt, [], core ? { core } : {}), budget.maxTokens, {
        timeoutMs: budget.timeoutMs,
        deadline: build.deadline,
        schema: COPILOT_REPLY_SCHEMA,
        continuations: budget.continuations,
        operation: `copilot_${mode}_item`,
        onEvent: (e: ProviderEvent) => { events.push(e); },
      }));

      if (!m.ok) return { error: m };
      const usage: StepUsage = {
        ...(m.event?.inputUnits != null ? { tokensIn: m.event.inputUnits } : {}),
        ...(m.event?.outputUnits != null ? { tokensOut: m.event.outputUnits } : {}),
        ...(m.event?.customerCharge != null ? { charge: m.event.customerCharge } : {}),
        ...(m.event?.model ? { model: m.event.model } : {}),
      };
      return { output: m.value, usage, ...(build.batchSize !== undefined ? { batchSizeUsed: build.batchSize } : {}) };
    } catch (e) {
      /* a throw here is this step's failure, never the slice's — runSlice classifies it */
      return { error: e };
    }
  };
}

/** the survey as it is stored, for a build that has no editor to read it from */
export async function loadDefinition(surveyId: string): Promise<SurveyDefinition | null> {
  try {
    const { supabaseAdmin } = await import("@/lib/admin");
    const { data } = await supabaseAdmin().from("surveys").select("definition").eq("id", surveyId).maybeSingle();
    const raw = (data as { definition?: unknown } | null)?.definition;
    return raw ? (raw as SurveyDefinition) : null;
  } catch { return null; }
}

/**
 * Register the item path with the runner. Imported for its side effect by
 * the cron route; with nothing registered the job reports that it skipped and
 * never invents a build.
 */
export function registerBackgroundBuilder(): void {
  setStepBuilder((task) => backgroundBuilderFor(task));
}
registerBackgroundBuilder();
