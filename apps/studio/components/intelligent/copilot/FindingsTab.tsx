"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import type { Finding, Verdict } from "@rescript/analytics";
import { Icon } from "../../ui/Icon";
import type { Copilot } from "./useCopilot";
import { useStudio } from "../../studio/store";

/**
 * THE FINDINGS — Intelligent → Findings.
 *
 * What the data said, from the latest analysis run: each hypothesis with its
 * verdict and the reason; the findings strongest first, each with its test,
 * p-value, effect size and base, so every line traces to a table in
 * Analytics; the caveats; and the run itself — when it was made, on how many
 * completes, by which milestone — with "Run the plan now" and the next
 * milestone due. An untested hypothesis offers to plan a test (the copilot's
 * analysis actions); the whole thing can be put to the copilot in words.
 *
 * Nothing here computes: the runs are the Studio's, stored by the analytics
 * route at the fieldwork milestones or on request. The Analytics workspace
 * stays the place to open a result and work on it.
 */
const VERDICT_WORD: Record<Verdict, string> = { supported: "supported", not_supported: "not supported", mixed: "mixed", inconclusive: "inconclusive", untested: "untested" };
const VERDICT_SEV: Record<Verdict, string> = { supported: "suggestion", not_supported: "critical", mixed: "warning", inconclusive: "warning", untested: "warning" };
const STRENGTH_SEV: Record<Finding["strength"], string> = { strong: "critical", moderate: "warning", weak: "suggestion", none: "suggestion" };
const MILESTONE_WORD: Record<string, string> = { first_results: "first results (30 completes)", halfway: "halfway to target", target_reached: "target reached", field_end: "end of fieldwork", manual: "on request" };

export function FindingsTab({ copilot, def }: { copilot: Copilot; def: SurveyDefinition }) {
  const s = useStudio();
  const run = copilot.analysisRun;
  const [onlySig, setOnlySig] = React.useState(true);
  const plan = def.research?.analysisPlan;
  const hyps = def.research?.hypotheses ?? [];
  const shown = React.useMemo(() => (run ? run.findings.filter((f) => f.kind !== "inconclusive" && (!onlySig || f.significant || ["nps", "topbox", "reliability"].includes(f.kind))) : []), [run, onlySig]);
  const sigCount = run ? run.findings.filter((f) => f.significant).length : 0;
  const ask = (t: string) => void copilot.ask(t);
  const sandbox = s.surveyDbId === "sandbox";
  const analyticsHref = `/analytics?survey=${encodeURIComponent(s.surveyDbId)}&tab=analysis`;

  return (
    <div className="cp-analysis cp-findings" data-testid="cp-findings">
      <section>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <div className="iq-label">Findings{run ? ` · ${sigCount} significant of ${run.findings.length}` : ""}</div>
          <span className="grow" />
          {plan && <button type="button" className="iq-btn primary" data-testid="fd-run" disabled={copilot.running || sandbox} onClick={() => void copilot.runPlanNow()} title={sandbox ? "The sandbox has no responses" : "Run every planned analysis on the live completes now and keep the findings"}>{copilot.running ? "Running…" : run ? "Run again" : "Run the plan now"}</button>}
        </div>
        {!plan && <p className="cp-empty" data-testid="fd-no-plan">There is no analysis plan yet — plan it in the Analysis tab (or ask the copilot) and the plan runs by itself at the fieldwork milestones, with the findings here.</p>}
        {plan && !run && <p className="cp-empty" data-testid="fd-no-run">The plan has not been run on responses yet. It runs by itself at the first 30 completes, halfway to target, at target and at the end of fieldwork{copilot.runDue ? ` — ${MILESTONE_WORD[copilot.runDue] ?? copilot.runDue} is due now` : ""}; or run it now.</p>}
        {copilot.runError && <p className="iq-error" data-testid="fd-error"><Icon name="warning" size={12} /> {copilot.runError}</p>}
        {run && (
          <p className="iqi-dim" data-testid="fd-run-meta">
            Run {MILESTONE_WORD[run.trigger] ?? run.trigger} · {new Date(run.computedAt).toLocaleString()} · {run.n} {run.environment.toLowerCase()} completes{run.items?.length ? ` · ${run.items.length} analyses` : ""}
            {copilot.runDue && <> · <b>{MILESTONE_WORD[copilot.runDue] ?? copilot.runDue} is due</b></>}
            {plan?.autoRun === false && <> · automatic runs off</>}
          </p>
        )}
        {run && run.n < 30 && <p className="iq-warning" data-testid="fd-small"><Icon name="warning" size={12} /> Only {run.n} completes — read every finding with caution; nothing here is conclusive yet.</p>}
      </section>

      {run && hyps.length > 0 && (
        <section data-testid="fd-verdicts">
          <div className="iq-label">Hypotheses · {hyps.length}</div>
          {hyps.map((text, i) => {
            const label = hypothesisLabel(i);
            const v = run.verdicts.find((x) => x.label === label);
            const verdict: Verdict = v?.verdict ?? "untested";
            return (
              <div key={label} className="cp-block" data-testid="fd-verdict" data-label={label} data-verdict={verdict}>
                <div><b>{label}</b> {text} <span className={`cp-sev v-${VERDICT_SEV[verdict]}`}>{VERDICT_WORD[verdict]}</span></div>
                {v?.reason && <div className="iqi-dim">{v.reason}</div>}
                {verdict === "untested" && !s.readOnly && <div><button type="button" className="iq-btn" data-testid="fd-plan-test" disabled={copilot.busy} onClick={() => ask(`${label} (“${text}”) is untested: add the crosstab or test to the analysis plan that would test it, naming the questions that measure it.`)}>Plan a test</button></div>}
              </div>
            );
          })}
        </section>
      )}

      {run && (
        <section data-testid="fd-list">
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <div className="iq-label">What the data says · strongest first</div>
            <span className="grow" />
            <label className="iqi-dim" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={onlySig} onChange={(e) => setOnlySig(e.target.checked)} data-testid="fd-only-sig" /> significant only</label>
          </div>
          {!shown.length && <p className="iqi-dim" data-testid="fd-none">{onlySig ? "No significant finding yet — untick to see the null results." : "No findings yet."}</p>}
          <ul className="cp-review-list">
            {shown.slice(0, 40).map((f) => (
              <li key={f.id} data-testid="fd-finding" data-kind={f.kind} data-strength={f.strength} data-significant={f.significant ? "1" : "0"}>
                <span className={`cp-sev v-${f.significant ? STRENGTH_SEV[f.strength] : "suggestion"}`}>{f.significant ? f.strength : f.kind === "nps" || f.kind === "topbox" || f.kind === "reliability" ? f.kind : "n.s."}</span> {f.headline}
                <div className="iqi-dim">
                  {f.analysis.name}{f.hypotheses.length ? ` · ${f.hypotheses.join(", ")}` : ""} · n = {f.evidence.n}{f.evidence.effect ? ` · ${f.evidence.effect.name} = ${f.evidence.effect.value.toFixed(2)}` : ""}{f.chart ? ` · ${String(f.chart).replace(/_/g, " ")}` : ""}
                  {f.detail ? <> · {f.detail}</> : null}
                </div>
              </li>
            ))}
          </ul>
          {run.warnings.length > 0 && <p className="iqi-dim" data-testid="fd-warnings"><Icon name="info" size={12} /> {run.warnings.slice(0, 3).join(" ")}</p>}
        </section>
      )}

      {plan && (
        <section data-testid="fd-report">
          <div className="iq-label">The report</div>
          <p className="iqi-dim">A draft written from the run — cover, executive summary in the run's own sentences, the hypotheses with their verdicts, a section per hypothesis with its analyses drawn and captioned, the other findings, methodology and caveats — into Analytics → Reports, to edit, publish and export as PowerPoint or Excel. It is drafted by itself when the target is reached or the field closes{plan.autoReport === false ? " (turned off for this survey)" : ""}.</p>
          {copilot.lastReport && <p className="iq-warning" data-testid="fd-report-done"><Icon name="info" size={12} /> Drafted “{copilot.lastReport.name}” — <a href={`/analytics?survey=${encodeURIComponent(s.surveyDbId)}&tab=reports`} data-testid="fd-open-report">open it in Reports</a>.</p>}
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <button type="button" className="iq-btn primary" data-testid="fd-draft-report" disabled={!run || copilot.drafting || sandbox || s.readOnly} onClick={() => void copilot.draftReport()} title={sandbox ? "The sandbox has no run to report on" : !run ? "Run the plan first" : "Draft the findings report from the latest run"}>{copilot.drafting ? "Drafting…" : "Draft the report"}</button>
            {run && !s.readOnly && <button type="button" className="iq-btn" data-testid="fd-ask" disabled={copilot.busy} onClick={() => ask("What did we find? Summarise the findings and say whether each hypothesis held, with the tests and p-values.")}>Ask the copilot to narrate</button>}
            {run && !s.readOnly && <button type="button" className="iq-btn" data-testid="fd-ask-summary" disabled={copilot.busy} onClick={() => ask("Write the executive summary for the client report: three short paragraphs — what we set out to learn, what the data showed (with the tests and bases), and what it means — from the run's findings only.")}>Draft the executive summary in words</button>}
            {!sandbox && <a className="iq-btn" href={analyticsHref} data-testid="fd-open-analytics">Open in Analytics</a>}
          </div>
        </section>
      )}
    </div>
  );
}
