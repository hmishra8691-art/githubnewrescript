"use client";
import { ResearchDesignEditor } from "../../studio/ResearchDesignEditor";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import type { AnalysisPlan, PlannedCrosstab, PlannedDerived, PlannedSegment, PlannedTest } from "@rescript/schema";
import { buildAnalysisFramework, explainPlanItem, hypothesisCoverage, inferQuestionAnalysis, methodologyAdvice, planSampleSize, prioritizeCrosstabs, reviewAnalysisPlan, sampleSizeReview, type SurveyAction } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import { Linked } from "./CopilotCard";
import type { Copilot } from "./useCopilot";

/**
 * THE ANALYSIS FRAMEWORK — Intelligent → Analysis.
 *
 * The study's analysis, planned before fieldwork and kept in the definition:
 *
 *   Hypotheses   each one with the constructs it names, whether they are
 *                measured, and what the plan runs for it
 *   Variables    every question's role and measurement, as inferred or set
 *   Plan         the crosstabs (most important first), tests, derived
 *                variables and segments — with the engine's checks on them
 *
 * Nothing here calls the model. "Plan the analysis" is the engine's own
 * framework offered as a proposal (previewed in Changes, applied as one
 * undoable change); the copilot refines it through the same actions when
 * asked in words. The researcher can also edit the plan by hand in the
 * question's Properties → Analysis.
 */
const word = (m: string) => m.replace(/_/g, " ");

/**
 * "WHY?" — one planned item explained by the engine (`explainPlanItem`): the
 * objective and hypotheses it serves, its variables and their levels, the
 * rule that chose the method, what the run produces, the base it needs
 * against the sample the quotas or the design expect, and its limitations.
 * Computed only when opened; nothing here asks the model.
 */
function WhyExpander({ def, plan, item, V }: { def: SurveyDefinition; plan: AnalysisPlan; item: PlannedCrosstab | PlannedTest | PlannedDerived | PlannedSegment; V: (p: { v: string }) => React.ReactElement }) {
  const [open, setOpen] = React.useState(false);
  const e = React.useMemo(() => (open ? explainPlanItem(def, item, plan) : null), [open, def, item, plan]);
  const short = !!e?.expectedSample && e.requiredBase.minimum > e.expectedSample.n;
  return (
    <details className="cp-why" data-testid="an-why" onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary data-testid="an-why-toggle">Why?</summary>
      {e && (
        <div className="cp-why-body" data-testid="an-why-body">
          <p data-testid="an-why-text">{e.text}</p>
          <dl>
            <dt>Objective</dt>
            <dd data-testid="an-why-objective">{e.objective}</dd>
            <dt>Variables</dt>
            <dd data-testid="an-why-variables"><ul>{e.variables.map((v) => <li key={`${v.role}:${v.name}`}><V v={v.name} /> <b>{v.role}</b> · {v.level}{v.categories ? `, ${v.categories} categories` : ""}{v.designRole !== v.role ? ` · ${v.designRole}` : ""}{v.text ? <span className="iqi-dim"> — {v.text}</span> : null}</li>)}</ul></dd>
            <dt>Why this method</dt>
            <dd data-testid="an-why-rule">{e.why}</dd>
            <dt>Expected output</dt>
            <dd data-testid="an-why-output">{e.expectedOutput}</dd>
            <dt>Required sample</dt>
            <dd data-testid="an-why-sample" data-short={short ? "true" : "false"}>
              about <b>{e.requiredBase.minimum}</b> completes ({e.requiredBase.note}){e.requiredBase.recommended ? `; ${e.requiredBase.recommended} for power` : ""}
              {" — "}{e.expectedSample ? <span className={short ? "cp-outdated" : undefined}>{short ? `more than ${e.expectedSample.note}` : `${e.expectedSample.note}: enough`}</span> : <span className="iqi-dim">no expected sample recorded</span>}
              <div className="iqi-dim">{e.requiredBase.rule}</div>
            </dd>
            {e.limitations.length > 0 && <><dt>Limitations</dt><dd data-testid="an-why-limits"><ul>{e.limitations.map((l) => <li key={l}>{l}</li>)}</ul></dd></>}
          </dl>
        </div>
      )}
    </details>
  );
}

export function AnalysisTab({ copilot, def, onSelect }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void }) {
  const plan = def.research?.analysisPlan;
  const coverage = React.useMemo(() => hypothesisCoverage(def), [def]);
  const proposed = React.useMemo(() => (plan ? null : buildAnalysisFramework(def)), [def, plan]);
  const shown = plan ?? proposed!;
  // the saved plan's checks include the sample-size ones; an unsaved proposal is checked against the sample too, so the warnings appear with the plan either way
  const issues = React.useMemo(() => [...reviewAnalysisPlan(def), ...(plan ? [] : sampleSizeReview(def, proposed!))], [def, plan, proposed]);
  const sample = React.useMemo(() => (def.questions.length ? planSampleSize(def, shown) : null), [def, shown]);
  const top = React.useMemo(() => prioritizeCrosstabs(def, 8, shown), [def, shown]);
  const [showAll, setShowAll] = React.useState(false);
  const roles = React.useMemo(() => def.questions.filter((q) => !["html", "custom_component"].includes(q.type)).map((q) => ({ q, a: inferQuestionAnalysis(def, q) })), [def]);
  const advice = React.useMemo(() => methodologyAdvice([def.research?.objective ?? "", ...(def.research?.hypotheses ?? [])].join(". ")), [def.research]);
  const byVar = new Map(def.questions.map((q) => [q.variableName, q]));
  const V = ({ v }: { v: string }) => { const q = byVar.get(v); return q ? <button type="button" className="cp-ref" onClick={() => onSelect(q.id)} data-testid="an-var">{q.code}</button> : <span className="mono">{v}</span>; };
  const propose = (merge: boolean) => copilot.previewFix([{ op: "propose_analysis_plan", ...(merge ? { merge: true } : {}) } as SurveyAction], merge ? "Add the engine's analysis plan" : "Plan the analysis");
  const empty = !def.questions.length;
  const status: Record<string, string> = { testable: "testable", partly: "measured, nothing planned", unmeasured: "not measured", unlinked: "nothing measures it" };

  return (
    <div className="cp-analysis" data-testid="cp-analysis">
      {empty && <p className="cp-empty">Add questions — or ask the copilot to build the survey from a hypothesis — and the analysis framework appears here: what each question is for, and the tables and tests the design implies.</p>}
      {!empty && (
        <>
          <section data-testid="an-plan-head">
            <div className="row" style={{ alignItems: "center", gap: 8 }}>
              <div className="iq-label">Analysis plan{plan ? ` · ${plan.source ?? "saved"}${plan.updatedAt ? ` · ${new Date(plan.updatedAt).toLocaleDateString()}` : ""}` : " · proposed by the engine, not saved"}</div>
              <span className="grow" />
              {!plan && <button type="button" className="iq-btn primary" onClick={() => propose(false)} data-testid="an-propose">Plan the analysis</button>}
              {plan && <button type="button" className="iq-btn" onClick={() => propose(true)} data-testid="an-propose-merge" title="Add what the engine would plan that is not planned yet">Add the engine's suggestions</button>}
              {plan && <button type="button" className="iq-btn" onClick={() => propose(false)} data-testid="an-propose-replace" title="Replace the plan with the engine's framework (confirmed before applying)">Re-plan</button>}
            </div>
            {sample && (shown.crosstabs.length + shown.tests.length) > 0 && (
              <p className="iqi-dim" data-testid="an-sample" data-short={sample.expected && sample.minimum > sample.expected.n ? "true" : "false"}>
                The plan needs about <b>{sample.minimum}</b> completes{sample.driver ? <> — driven by {sample.driver.title.replace(/^./, (c) => c.toLowerCase())} ({sample.driver.requiredBase.note})</> : null}.{" "}
                {sample.expected ? (sample.minimum > sample.expected.n ? <b className="cp-outdated">That is more than {sample.expected.note}.</b> : <>{sample.expected.note.replace(/^./, (c) => c.toUpperCase())}: enough.</>) : <>No sample is recorded — quota targets or the research design's sample size would let the plan be checked against it.</>}
              </p>
            )}
            {!plan && <p className="iqi-dim" data-testid="an-unsaved">This is what the engine would plan from the research design and the question types. Save it to the survey to refine it — in words (“add a crosstab of purchase intent by country”, “test H2 with a regression”) or in each question's Properties → Analysis.</p>}
          </section>

          {issues.length > 0 && (
            <section data-testid="an-issues">
              <div className="iq-label">Checks · {issues.length}</div>
              <ul className="cp-review-list">
                {issues.map((i, k) => (
                  <li key={k} data-severity={i.level} data-testid="an-issue"><span className={`cp-sev v-${i.level}`}>{i.level}</span> <Linked text={i.message} def={def} onSelect={onSelect} />{i.suggestion && <div className="iqi-dim">{i.suggestion}</div>}
                    {i.fix && <div><button type="button" className="iq-btn" data-testid="an-issue-fix" disabled={copilot.busy} onClick={() => copilot.previewFix([i.fix as SurveyAction], `Create embedded variable ${i.fix!.name}`)}>Create {i.fix.name}</button></div>}</li>
                ))}
              </ul>
            </section>
          )}

          <section data-testid="an-hypotheses">
            <div className="iq-label">Hypotheses · {coverage.length}</div>
            {!coverage.length && <p className="iqi-dim">No hypotheses recorded. Tell the copilot the research objective and hypotheses and it records them (set_research), or write them in the research design below.</p>}
            <details className="cp-ux-code" data-testid="an-design-editor" open={!coverage.length}>
              <summary>Research design — objective, hypotheses, population, constructs (edit by hand)</summary>
              <ResearchDesignEditor compact />
            </details>
            {coverage.map((h) => (
              <div key={h.label} className="cp-block" data-testid="an-hyp" data-status={h.status}>
                <div><b>{h.label}</b> {h.text} <span className={`cp-sev v-${h.status === "testable" ? "suggestion" : h.status === "partly" ? "warning" : "critical"}`}>{status[h.status]}</span></div>
                {h.constructs.length > 0 && <div className="iqi-dim">{h.constructs.map((c) => <span key={c.name} style={{ marginRight: 8 }}>{c.name} <i>({c.role})</i>: {c.measured ? c.questions.map((code) => <Linked key={code} text={code} def={def} onSelect={onSelect} />) : <b>not measured</b>}</span>)}</div>}
                {(h.tests.length > 0 || h.crosstabs.length > 0) && <div className="iqi-dim">Runs: {[...h.tests.map((t) => `${word(t.method)}${t.outcome ? ` on ${t.outcome}` : ""}`), ...h.crosstabs.map((x) => `${x.rows.join("+")} by ${x.columns.join("+")}`)].join(" · ")}</div>}
              </div>
            ))}
            {advice && (
              <details className="cp-ux-code" data-testid="an-method-advice">
                <summary>Method for “{advice.goal.slice(0, 60)}{advice.goal.length > 60 ? "…" : ""}” — recommended: {advice.recommended}</summary>
                <table className="iqi-table"><tbody>
                  {advice.options.map((o) => <tr key={o.method}><td><b>{o.method}</b><div className="iqi-dim">{o.fit}</div><div className="iqi-dim mono">{o.implementedAs}</div></td><td><div>+ {o.strengths.join("; ")}</div><div className="iqi-dim">− {o.tradeoffs.join("; ")}</div></td></tr>)}
                </tbody></table>
              </details>
            )}
          </section>

          <section data-testid="an-crosstabs">
            <div className="iq-label">Crosstabs · the most important first · {shown.crosstabs.length}</div>
            {!shown.crosstabs.length && <p className="iqi-dim">No crosstabs: mark an outcome (role “dependent”) and a demographic (role “segmentation”) in Properties → Analysis, or ask the copilot.</p>}
            <table className="iqi-table" data-testid="an-crosstab-table"><tbody>
              {(showAll ? shown.crosstabs : top).map((x) => (
                <tr key={x.id} data-testid="an-crosstab" data-priority={x.priority}>
                  <td><span className={`cp-sev v-${x.priority === 1 ? "critical" : x.priority === 2 ? "warning" : "suggestion"}`}>P{x.priority}</span></td>
                  <td>{x.rows.map((v, i) => <React.Fragment key={v}>{i > 0 && ", "}<V v={v} /></React.Fragment>)} <span className="iqi-dim">by</span> {x.columns.map((v, i) => <React.Fragment key={v}>{i > 0 && ", "}<V v={v} /></React.Fragment>)}
                    <div className="iqi-dim">{x.reason}{x.hypotheses.length ? ` · ${x.hypotheses.join(", ")}` : ""}{x.measure === "mean" ? " · means" : ""}</div>
                    <WhyExpander def={def} plan={shown} item={x} V={V} /></td>
                  {plan && <td><button type="button" className="iq-btn" data-testid="an-crosstab-remove" onClick={() => copilot.previewFix([{ op: "remove_crosstab", id: x.id } as SurveyAction], `Remove planned crosstab ${x.rows.join("+")} by ${x.columns.join("+")}`)}>Remove…</button></td>}
                </tr>
              ))}
            </tbody></table>
            {shown.crosstabs.length > top.length && <button type="button" className="iq-btn" onClick={() => setShowAll((v) => !v)} data-testid="an-crosstabs-all">{showAll ? "Show the most important" : `Show all ${shown.crosstabs.length}`}</button>}
          </section>

          <section data-testid="an-tests">
            <div className="iq-label">Tests and models · {shown.tests.length}</div>
            <table className="iqi-table"><tbody>
              {shown.tests.map((t) => (
                <tr key={t.id} data-testid="an-test" data-method={t.method}>
                  <td><b>{word(t.method)}</b><div className="iqi-dim">{t.reason}{t.hypotheses.length ? ` · ${t.hypotheses.join(", ")}` : ""}</div><WhyExpander def={def} plan={shown} item={t} V={V} /></td>
                  <td>{t.outcome && <><V v={t.outcome} /> <span className="iqi-dim">~</span> </>}{t.variables.map((v, i) => <React.Fragment key={v}>{i > 0 && " + "}<V v={v} /></React.Fragment>)}{t.groupBy && <> <span className="iqi-dim">across</span> <V v={t.groupBy} /></>}{t.moderator && <> <span className="iqi-dim">×</span> <V v={t.moderator} /></>}{t.mediator && <> <span className="iqi-dim">via</span> <V v={t.mediator} /></>}</td>
                  {plan && <td><button type="button" className="iq-btn" data-testid="an-test-remove" onClick={() => copilot.previewFix([{ op: "remove_analysis_test", id: t.id } as SurveyAction], `Remove planned ${word(t.method)}`)}>Remove…</button></td>}
                </tr>
              ))}
            </tbody></table>
            {(shown.derived.length > 0 || shown.segments.length > 0) && (
              <div className="iqi-dim" data-testid="an-derived">
                {shown.derived.length > 0 && <>Derived: {shown.derived.map((d) => `${d.name} (${word(d.kind)} of ${d.from.join(", ")})`).join("; ")}. </>}
                {shown.segments.length > 0 && <>Segments: {shown.segments.map((s) => s.name).join(", ")}.</>}
                <ul className="cp-why-list" data-testid="an-derived-list">
                  {shown.derived.map((d) => <li key={`d:${d.name}`} data-testid="an-derived-item"><span className="mono">{d.name}</span> <WhyExpander def={def} plan={shown} item={d} V={V} /></li>)}
                  {shown.segments.map((sg) => <li key={`s:${sg.name}`} data-testid="an-segment-item">{sg.name} <WhyExpander def={def} plan={shown} item={sg} V={V} /></li>)}
                </ul>
              </div>
            )}
          </section>

          <section data-testid="an-variables">
            <div className="iq-label">Variables · {roles.length}</div>
            <table className="iqi-table"><tbody>
              {roles.map(({ q, a }) => (
                <tr key={q.id} data-testid="an-variable" data-role={a.role}>
                  <td><button type="button" className="cp-ref" onClick={() => onSelect(q.id)}>{q.code}</button> <span className="mono iqi-dim">{q.variableName}</span></td>
                  <td>{a.role}{a.inferred.includes("role") ? <span className="iqi-dim"> (inferred)</span> : ""} · {a.measurement}{a.construct ? <div className="iqi-dim">{a.construct}{a.hypotheses.length ? ` · ${a.hypotheses.join(", ")}` : ""}</div> : null}</td>
                  <td className="iqi-dim">{a.primary.map(word).join(", ")}{a.crosstabBy.length ? ` · by ${a.crosstabBy.join(", ")}` : ""}</td>
                </tr>
              ))}
            </tbody></table>
          </section>
          <p className="iqi-dim"><Icon name="info" size={12} /> Hypotheses are {hypothesisLabel(0)}, {hypothesisLabel(1)}… by their position in the research design. Once responses exist, Analytics → “Create the planned analyses” runs this plan as it is written.</p>
        </>
      )}
    </div>
  );
}
