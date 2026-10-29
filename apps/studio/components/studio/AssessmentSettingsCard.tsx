"use client";
import React from "react";
import type { AssessmentSettings } from "@rescript/schema";
import { AssessmentSettings as AssessmentSettingsSchema } from "@rescript/schema";
import { gradedQuestions, validateAssessment } from "@rescript/engine";
import { useStudio } from "./store";
import { SANDBOX_OBSERVER_KEY } from "../analytics/AssessmentCard";

/**
 * ASSESSMENT — the survey-wide card (Survey Settings, below Quality; K4 2026-10-25, ported 2026-10-29 step 4B;
 * docs/ASSESSMENTS-2026-10-29.md part B).
 *
 * One checkbox — "This survey is a test or quiz" — and nothing else until it is ticked, so an ordinary survey
 * sees one new line. Ticked: default marking (UPSC +2 / −0.66), multi-answer credit, pass mark, when the
 * respondent sees results (after submitting — the default and the only safe choice for an exam —, never, or per
 * question during the paper, which necessarily puts the key in the browser and says so in a visible warning),
 * which report sections they see, the weak-area threshold and the expected number of questions, then the
 * paper's validation. Unticking keeps every key (enabled: false), so ticking again restores the paper.
 * The results (distribution, item analysis, Word) are in Data Analytics → Assessment results.
 */
const SECTIONS: [keyof AssessmentSettings["report"], string][] = [
  ["summary", "Score, percentage, pass / fail"], ["perQuestion", "Every question: your answer, the correct answer"], ["explanations", "Explanations (and why the chosen option is wrong)"],
  ["topicBreakdown", "Topic breakdown"], ["weakAreas", "Weak areas"], ["recommendations", "Recommended revision topics"],
];

export function AssessmentSettingsCard() {
  const s = useStudio();
  const raw = s.def.assessment;
  const parsed = raw ? AssessmentSettingsSchema.safeParse(raw) : null;
  const cfg = parsed?.success ? parsed.data : null;
  const on = !!cfg?.enabled;
  const patch = (p: Partial<AssessmentSettings>) => s.update((d) => { d.assessment = AssessmentSettingsSchema.parse({ ...(d.assessment ?? {}), ...p }); });
  const v = on ? validateAssessment(s.def, { requireExplanations: false }) : null;
  const graded = on ? gradedQuestions(s.def).length : 0;
  const num = (x: string) => (x.trim() === "" ? undefined : Number(x));
  const sandbox = s.surveyDbId === "sandbox";
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  /* SANDBOX ONLY (no database): hand the paper to the runtime's in-memory store and open its take page /x/<token>.
     The tab is opened inside the click (a window opened after an await is a blocked pop-up). The observer key is
     kept in this tab so Data Analytics → Assessment results can read this paper's attempts. */
  const take = async () => {
    setBusy(true); setMsg(null);
    const w = window.open("", "_blank");
    try {
      const r = await fetch("/api/surveys/sandbox/assessment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: s.def }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { w?.close(); setMsg(j.error ?? `could not start the test (${r.status})`); return; }
      try { window.sessionStorage.setItem(SANDBOX_OBSERVER_KEY, String(j.observerKey ?? "")); } catch { /* private mode: results still on the take page */ }
      if (w) { w.opener = null; w.location.href = j.takeUrl; } else window.open(j.takeUrl, "_blank", "noopener");
      setMsg("The test opened in a new tab. Submit it there; the results are on that page and in Data Analytics → Assessment results.");
    } catch (e) { w?.close(); setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div data-testid="assessment-settings">
      <h3 className="sec" id="assessment">Assessment</h3>
      <label className="row" style={{ gap: 6, fontSize: 13, marginBottom: 8 }}
        title="A scored paper: an answer key per question (Properties → Assessment), marks, a pass mark and a results report. The key never reaches a respondent's browser before they submit.">
        <input type="checkbox" data-testid="assessment-enabled" checked={on}
          onChange={(e) => patch({ enabled: e.target.checked })} />
        This survey is a test or quiz (answer key, marks, results report)
      </label>
      {on && cfg && (
        <>
          <div className="settings-grid">
            <label className="f"><span>Title on the report</span>
              <input className="input" data-testid="assessment-title" value={cfg.title ?? ""} placeholder={s.def.meta.title} onChange={(e) => patch({ title: e.target.value || undefined })} /></label>
            <label className="f"><span>Marks per correct answer</span>
              <input className="input" type="number" step="0.01" min={0} data-testid="assessment-default-marks" value={cfg.defaultMarks} onChange={(e) => patch({ defaultMarks: num(e.target.value) ?? 1 })} /></label>
            <label className="f"><span>Marks deducted per wrong answer</span>
              <input className="input" type="number" step="0.01" min={0} data-testid="assessment-default-negative" value={cfg.defaultNegativeMarks} onChange={(e) => patch({ defaultNegativeMarks: Math.abs(num(e.target.value) ?? 0) })} /></label>
            <label className="f"><span>Multi-answer credit</span>
              <select className="select" data-testid="assessment-partial" value={cfg.partialCredit} onChange={(e) => patch({ partialCredit: e.target.value as AssessmentSettings["partialCredit"] })}>
                <option value="none">All or nothing</option>
                <option value="proportional">Proportional (wrong picks cancel right ones)</option>
                <option value="proportional_no_wrong">Proportional, none if any pick is wrong</option>
              </select></label>
            <label className="f"><span>Pass at % of maximum</span>
              <input className="input" type="number" min={0} max={100} data-testid="assessment-pass-percent" value={cfg.passPercent ?? ""} placeholder="no pass mark" onChange={(e) => { const n = num(e.target.value); patch({ passPercent: n === undefined ? undefined : Math.min(100, Math.max(0, n)) }); }} /></label>
            <label className="f"><span>…or at marks</span>
              <input className="input" type="number" step="0.01" data-testid="assessment-pass-marks" value={cfg.passMarks ?? ""} placeholder="—" onChange={(e) => patch({ passMarks: num(e.target.value) })} /></label>
            <label className="f"><span>Respondent sees results</span>
              <select className="select" data-testid="assessment-show" value={cfg.showResults} onChange={(e) => patch({ showResults: e.target.value as AssessmentSettings["showResults"] })}>
                <option value="after_submit">After submitting (key stays on the server)</option>
                <option value="never">Never (scored for the researcher only)</option>
                <option value="per_question">Per question during the paper (key sent to the browser)</option>
              </select></label>
            <label className="f"><span>Weak area below accuracy %</span>
              <input className="input" type="number" min={0} max={100} data-testid="assessment-weak" value={cfg.weakThreshold} onChange={(e) => patch({ weakThreshold: Math.min(100, Math.max(0, num(e.target.value) ?? 60)) })} /></label>
            <label className="f"><span>Expected number of questions</span>
              <input className="input" type="number" min={1} data-testid="assessment-expected" value={cfg.expectedQuestions ?? ""} placeholder={String(graded)} onChange={(e) => { const n = num(e.target.value); patch({ expectedQuestions: n === undefined || n < 1 ? undefined : Math.round(n) }); }} /></label>
          </div>
          {cfg.showResults === "per_question" && (
            <div className="alert" role="alert" data-testid="assessment-per-question-warning" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Per-question feedback needs the answer key in the respondent&apos;s browser — anyone can read every correct answer from the page before answering. Use “After submitting” for an exam.
            </div>
          )}
          <div className="f"><span>The respondent&apos;s report shows</span></div>
          <div style={{ display: "grid", gap: 2, marginBottom: 8 }}>
            {SECTIONS.map(([k, label]) => (
              <label key={k} className="row" style={{ gap: 6, fontSize: 13 }}>
                <input type="checkbox" data-testid={`assessment-sec-${k}`} checked={cfg.report[k]} disabled={cfg.showResults === "never"}
                  onChange={(e) => patch({ report: { ...cfg.report, [k]: e.target.checked } })} /> {label}
              </label>
            ))}
          </div>
          <div className={`chip ${v && v.ok ? "on" : "warn"}`} data-testid="assessment-validation" data-ok={v?.ok ? "1" : "0"} data-graded={graded}>
            {v?.ok ? `${graded} scored question${graded === 1 ? "" : "s"} — the paper is valid` : `${v?.errors.length ?? 0} problem${v?.errors.length === 1 ? "" : "s"} in the paper`}
            {v && v.warnings.length > 0 ? ` · ${v.warnings.length} warning${v.warnings.length === 1 ? "" : "s"}` : ""}
          </div>
          {v && (v.errors.length > 0 || v.warnings.length > 0) && (
            <ul className="tc-list" data-testid="assessment-issues" style={{ fontSize: 12.5, maxHeight: 160, overflow: "auto" }}>
              {v.errors.slice(0, 30).map((i, k) => <li key={`e${k}`} className="err">{i.message}</li>)}
              {v.warnings.slice(0, 10).map((i, k) => <li key={`w${k}`} className="warn">{i.message}</li>)}
            </ul>
          )}
          {sandbox && (
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <button type="button" className="btn small" data-testid="assessment-take" disabled={busy || graded === 0} onClick={take}>{busy ? "…" : "Take the test (sandbox)"}</button>
            </div>
          )}
          {msg && <p className="muted" style={{ fontSize: 12.5 }} data-testid="assessment-msg">{msg}</p>}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Key each question under <strong>Properties → Assessment</strong>. Try the paper with <strong>Preview</strong> (tick “as a respondent” to see exactly what a respondent receives) or <strong>Test Survey</strong>; scores, item analysis and the Word answer key are in <strong>Data Analytics → Assessment results</strong>.
          </p>
        </>
      )}
    </div>
  );
}
