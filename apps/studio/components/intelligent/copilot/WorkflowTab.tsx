"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import type { ExecutionMode, WorkflowStep } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import type { Copilot } from "./useCopilot";
import { useStudio } from "../../studio/store";

/**
 * THE RESEARCH WORKFLOW — Intelligent → Workflow (Research Engine audit,
 * Phase 6: the research agent).
 *
 * One objective, twelve steps: clarify assumptions → structured hypotheses
 * → research framework → questionnaire → variables → analysis plan →
 * crosstab and test recommendations → reporting framework → design
 * document → survey structure → after fieldwork, the deck. Every step says
 * what was found and what happens next — the engine's own actions (one
 * click opens them in Changes for approval, like any proposal), a question
 * only the researcher can answer (an example sentence goes to the input
 * box to finish), a document (one click produces it), or a model call,
 * priced before it is made. The execution choice — internal (nothing is
 * sent to a model) or cloud — is the project's, switched here, and one
 * request can be let through to the cloud on its own.
 *
 * Nothing here runs by itself: the researcher directs in plain language
 * and approves step by step. The planner is the engine's (`researchWorkflow`),
 * and runs on the survey as it stands in the editor, the open proposal
 * included, so a step applied is a step done at once.
 */
const MARK: Record<WorkflowStep["status"], { icon: "check" | "chevron-right" | "info" | "sparkle" | "layers"; word: string }> = {
  done: { icon: "check", word: "done" }, ready: { icon: "chevron-right", word: "ready" }, needs_input: { icon: "info", word: "your answer" }, model: { icon: "sparkle", word: "the model" }, blocked: { icon: "layers", word: "waits" },
};
const TIER_WORD: Record<string, string> = { small: "short call", large: "drafting call" };
const credits = (n: number) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n > 0 ? n.toFixed(4) : "0");

export function WorkflowTab({ copilot, def, onTemplate }: { copilot: Copilot; def: SurveyDefinition; /** put a sentence in the input box to finish */ onTemplate(sentence: string): void }) {
  const s = useStudio();
  const wf = copilot.workflow;
  const info = copilot.workflowInfo;
  React.useEffect(() => { if (!info && !copilot.workflowLoading && !copilot.workflowError) void copilot.refreshWorkflow(); }, [info, copilot]);
  const once = copilot.cloudOnce;
  const mode: ExecutionMode = info?.mode.effective ?? (copilot.available === false ? "internal" : copilot.executionMode);
  const costOf = (id: string) => info?.cost.steps.find((c) => c.id === id) ?? null;
  /* the steps a model would be asked for — in internal mode they ask the researcher instead, and the line says so */
  const modelSteps = wf.steps.filter((x) => x.status === "model" || (x.status === "needs_input" && !!x.model));
  const total = modelSteps.reduce((t, x) => t + (costOf(x.id)?.charge ?? 0), 0);
  /* a model step the route has not priced yet (the survey moved on since): priced once, not in a loop */
  const unpriced = modelSteps.filter((x) => !costOf(x.id)).map((x) => x.id).join(",");
  const pricedFor = React.useRef("");
  React.useEffect(() => { if (info && unpriced && unpriced !== pricedFor.current && !copilot.workflowLoading) { pricedFor.current = unpriced; void copilot.refreshWorkflow(); } }, [info, unpriced, copilot]);
  const run = (step: WorkflowStep) => { void copilot.runWorkflowStep(step); };
  void def;

  return (
    <div className="cp-analysis cp-workflow" data-testid="cp-workflow" data-mode={mode} data-next={wf.next?.id ?? ""}>
      <section>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <div className="iq-label">Research workflow · {wf.done} of {wf.total}</div>
          <span className="grow" />
          <button type="button" className="iq-btn" data-testid="wf-refresh" disabled={copilot.workflowLoading} onClick={() => void copilot.refreshWorkflow()} title="Read the project's execution mode, the data and the costs again">{copilot.workflowLoading ? "Reading…" : "Refresh"}</button>
        </div>
        <p className="iqi-dim" data-testid="wf-summary">{wf.summary}{copilot.workflowObjective && !def.research?.objective ? ` Objective to record: “${copilot.workflowObjective}”.` : ""}</p>
        {copilot.workflowError && <p className="iq-error" data-testid="wf-error"><Icon name="warning" size={12} /> {copilot.workflowError}</p>}
        <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }} data-testid="wf-mode" data-value={mode}>
          <span className="iqi-dim">Execution:</span>
          <button type="button" className={`iq-btn${copilot.executionMode === "internal" ? " primary" : ""}`} data-testid="wf-mode-internal" aria-pressed={copilot.executionMode === "internal"} disabled={s.readOnly && s.surveyDbId !== "sandbox"} onClick={() => void copilot.setExecutionMode("internal")} title="Nothing is sent to a language model: the engine's own steps, the standard items, your answers">Internal</button>
          <button type="button" className={`iq-btn${copilot.executionMode === "cloud" ? " primary" : ""}`} data-testid="wf-mode-cloud" aria-pressed={copilot.executionMode === "cloud"} disabled={(s.readOnly && s.surveyDbId !== "sandbox") || copilot.available === false || info?.model.configured === false} onClick={() => void copilot.setExecutionMode("cloud")} title={copilot.available === false || info?.model.configured === false ? "No language model is configured on this Studio" : "Model steps go to the language model, priced before each call"}>Cloud</button>
          {info && <span className="iqi-dim" data-testid="wf-model">{info.model.configured ? `${info.model.large}${info.model.small !== info.model.large ? ` · ${info.model.small} for short calls` : ""}` : "no model configured"}{!info.mode.sandbox && info.mode.project !== mode ? ` · project: ${info.mode.project}` : ""}</span>}
        </div>
        {modelSteps.length > 0 && (
          <p className="iqi-dim" data-testid="wf-cost">
            {mode === "cloud" ? `Model steps from here: ${modelSteps.map((x) => `${x.title.toLowerCase()} (${TIER_WORD[x.tier] ?? x.tier}${costOf(x.id) ? `, ${costOf(x.id)!.model}, ~${credits(costOf(x.id)!.charge)} credits` : ""})`).join("; ")} — about ${credits(total)} credits in all, each approved before it is made.` : `In internal mode the model is not called: ${modelSteps.length === 1 ? "one step is" : `${modelSteps.length} steps are`} yours to answer instead.`}
          </p>
        )}
        {mode === "internal" && copilot.executionMode === "internal" && copilot.available !== false && info?.model.configured !== false && (
          <label className="iqi-dim row" style={{ gap: 6, alignItems: "center" }} data-testid="wf-once">
            <input type="checkbox" checked={once} onChange={(e) => copilot.setCloudOnce(e.target.checked)} data-testid="wf-once-box" /> let the next model request through to the cloud, once
          </label>
        )}
      </section>
      <section>
        <ol className="wf-steps" data-testid="wf-steps">
          {wf.steps.map((step) => {
            const m = MARK[step.status];
            const cost = step.status === "model" ? costOf(step.id) : null;
            const isNext = wf.next?.id === step.id;
            return (
              <li key={step.id} className={`wf-step wf-${step.status}${isNext ? " next" : ""}`} data-testid={`wf-step-${step.id}`} data-status={step.status} data-executor={step.executor}>
                <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                  <span className={`wf-mark v-${step.status}`} title={m.word}><Icon name={m.icon} size={12} /></span>
                  <div className="grow">
                    <div className="wf-title"><strong>{step.title}</strong> <span className="iqi-dim">· {m.word}{step.tier !== "none" && step.status !== "done" ? ` · ${TIER_WORD[step.tier] ?? step.tier}` : ""}</span></div>
                    <div className="iqi-dim wf-why" data-testid={`wf-why-${step.id}`}>{step.why}</div>
                    {step.status === "ready" && (step.actions?.length || step.output) && !s.readOnly && (
                      <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <button type="button" className={`iq-btn${isNext ? " primary" : ""}`} data-testid={`wf-do-${step.id}`} disabled={copilot.busy} onClick={() => run(step)} title={step.sentence}>
                          {step.executor === "output" ? `Produce ${step.output?.type === "findings_pptx" ? "the deck" : "the document"}` : `Do it (${step.actions!.length} ${step.actions!.length === 1 ? "change" : "changes"}) — review in Changes`}
                        </button>
                      </div>
                    )}
                    {(step.status === "model" || (step.status === "needs_input" && step.model)) && step.sentence && !s.readOnly && (
                      <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <button type="button" className={`iq-btn${isNext ? " primary" : ""}`} data-testid={`wf-ask-${step.id}`} disabled={copilot.busy || (mode === "internal" && !once)} onClick={() => run(step)} title={step.sentence}>
                          Ask the model{cost ? ` (~${credits(cost.charge)} credits, ${cost.model})` : ""}
                        </button>
                      </div>
                    )}
                    {step.questions && step.questions.length > 0 && step.status !== "done" && (
                      <ul className="wf-questions" data-testid={`wf-questions-${step.id}`}>
                        {step.questions.map((q, i) => (
                          <li key={i}><span>{q.ask}</span> {!s.readOnly && <button type="button" className="iq-chip" data-testid="wf-example" onClick={() => onTemplate(q.example)} title="Put this sentence in the box to finish">{q.example}</button>}</li>
                        ))}
                      </ul>
                    )}
                    {step.status === "blocked" && step.blockedBy && <div className="iqi-dim" data-testid={`wf-blocked-${step.id}`}>waits on {wf.steps.find((x) => x.id === step.blockedBy)?.title.toLowerCase() ?? step.blockedBy}</div>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      <section>
        <p className="iqi-dim">Every change goes through Changes for your approval; every model call is priced here first; History keeps each step with its cost and can roll it back. Start from a sentence too: “start the research workflow for …”.</p>
      </section>
    </div>
  );
}
