"use client";
import React from "react";
import type { Question, QuestionAssessment } from "@rescript/schema";
import { assessmentSettings, validateAssessment } from "@rescript/engine";
import { useStudio } from "./store";
import { CollapsibleSection } from "./CollapsibleSection";

/**
 * ASSESSMENT — the per-question half, in Properties (K4 2026-10-25, ported 2026-10-29 step 4B;
 * docs/ASSESSMENTS-2026-10-29.md part B).
 *
 * Shown ONLY when the survey is a test / quiz (Survey Settings → Assessment → "This survey is a test or quiz")
 * and only on choice questions (single / multi / dropdown / image choice — the types the engine scores), so an
 * ordinary survey's Properties panel is unchanged. The answer key (tick the correct option(s)), marks and
 * negative marks (blank = the paper's default), multi-answer credit, topic / subtopic, difficulty, the
 * explanation and an optional "why this is wrong" note per option. It writes `question.assessment` through the
 * panel's ordinary `patch` (one undo step, the same path every other property takes); the shape is the one the
 * engine actions `set_answer_key` / `clear_answer_key` write. Everything here is stripped from what a respondent
 * receives; the paper is scored on the server after submission.
 */
const CHOICE = new Set(["single_select", "multi_select", "dropdown", "image_select"]);
const plain = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export function AssessmentQuestionSection({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const settings = assessmentSettings(s.def);
  if (!settings || !CHOICE.has(q.type)) return null;
  const a: QuestionAssessment | undefined = q.assessment;
  const set = (next: Partial<QuestionAssessment> | null) => {
    if (next === null) { patch({ assessment: undefined }); return; }
    const merged = { correct: [], ...(a ?? {}), ...next } as QuestionAssessment;
    for (const k of Object.keys(merged) as (keyof QuestionAssessment)[]) if (merged[k] === undefined || merged[k] === "") delete merged[k];
    delete merged.withheld;
    patch({ assessment: merged });
  };
  const multi = q.type === "multi_select";
  const correct = (a?.correct ?? []).map(String);
  const toggle = (code: string | number) => {
    const c = String(code);
    const next = multi ? (correct.includes(c) ? correct.filter((x) => x !== c) : [...correct, c]) : [c];
    const codes = next.map((x) => (q.options ?? []).find((o) => String(o.code) === x)?.code).filter((x): x is string | number => x !== undefined);
    set({ correct: codes });
  };
  const issues = a ? validateAssessment(s.def, { scopeCodes: [String(q.code)] }) : null;
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  return (
    <CollapsibleSection id="assessment" title="Assessment (answer key)" active={!!a}>
      <div className="card" style={{ padding: 10 }} data-testid="assessment-section">
        {!a ? (
          <div>
            <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>Score this question: mark the correct answer, its marks, topic and explanation. The key is never sent to respondents; the paper is scored on the server after they submit.</p>
            <button type="button" className="btn small" data-testid="assessment-enable-q" onClick={() => set({ correct: [] })}>Add an answer key</button>
          </div>
        ) : (
          <>
            <div className="f"><span>Correct answer{multi ? "s" : ""}</span></div>
            <div style={{ display: "grid", gap: 4, marginBottom: 8 }} role={multi ? "group" : "radiogroup"} aria-label="Correct answer">
              {(q.options ?? []).map((o) => (
                <label key={String(o.code)} className="row" style={{ gap: 6, fontSize: 13 }}>
                  <input type={multi ? "checkbox" : "radio"} name={`asmt-${q.id}`} checked={correct.includes(String(o.code))} data-testid={`assessment-correct-${o.code}`} onChange={() => toggle(o.code)} />
                  <span className="mono" style={{ minWidth: 22 }}>{String(o.code)}</span>
                  <span>{plain(o.label).slice(0, 80)}</span>
                </label>
              ))}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="f" style={{ width: 90 }}><span>Marks</span>
                <input className="input" type="number" step="0.01" min={0} data-testid="assessment-marks" placeholder={String(settings.defaultMarks)}
                  value={a.marks ?? ""} onChange={(e) => set({ marks: num(e.target.value) })} /></label>
              <label className="f" style={{ width: 110 }}><span>Negative marks</span>
                <input className="input" type="number" step="0.01" min={0} data-testid="assessment-negative" placeholder={String(settings.defaultNegativeMarks)}
                  value={a.negativeMarks ?? ""} onChange={(e) => { const n = num(e.target.value); set({ negativeMarks: n === undefined ? undefined : Math.abs(n) }); }} /></label>
              <label className="f" style={{ width: 110 }}><span>Difficulty</span>
                <select className="select" value={a.difficulty ?? ""} data-testid="assessment-difficulty" onChange={(e) => set({ difficulty: (e.target.value || undefined) as QuestionAssessment["difficulty"] })}>
                  <option value="">—</option><option value="easy">easy</option><option value="medium">medium</option><option value="hard">hard</option>
                </select></label>
            </div>
            {multi && (
              <label className="f"><span>Partial credit</span>
                <select className="select" value={a.partialCredit ?? ""} data-testid="assessment-partial-q" onChange={(e) => set({ partialCredit: (e.target.value || undefined) as QuestionAssessment["partialCredit"] })}>
                  <option value="">The paper&apos;s rule ({settings.partialCredit === "none" ? "all or nothing" : settings.partialCredit === "proportional" ? "proportional" : "proportional, none if any pick is wrong"})</option>
                  <option value="none">All or nothing</option>
                  <option value="proportional">Proportional (wrong picks cancel right ones)</option>
                  <option value="proportional_no_wrong">Proportional, none if any pick is wrong</option>
                </select></label>
            )}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="f grow"><span>Topic</span>
                <input className="input" data-testid="assessment-topic" placeholder="e.g. Polity" value={a.topic ?? ""} onChange={(e) => set({ topic: e.target.value || undefined })} /></label>
              <label className="f grow"><span>Subtopic</span>
                <input className="input" data-testid="assessment-subtopic" placeholder="e.g. Fundamental Rights" value={a.subtopic ?? ""} onChange={(e) => set({ subtopic: e.target.value || undefined })} /></label>
            </div>
            <label className="f"><span>Explanation (why the correct answer is correct)</span>
              <textarea className="input" rows={3} data-testid="assessment-explanation" value={a.explanation ?? ""} onChange={(e) => set({ explanation: e.target.value || undefined })} /></label>
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: "pointer", fontSize: 12.5 }} data-testid="assessment-optexp-toggle">Why each wrong option is wrong (optional)</summary>
              {(q.options ?? []).filter((o) => !correct.includes(String(o.code))).map((o) => (
                <label key={String(o.code)} className="f" style={{ marginTop: 4 }}><span>{String(o.code)} · {plain(o.label).slice(0, 50)}</span>
                  <input className="input" data-testid={`assessment-optexp-${o.code}`} value={a.optionExplanations?.[String(o.code)] ?? ""}
                    onChange={(e) => { const m = { ...(a.optionExplanations ?? {}) }; if (e.target.value) m[String(o.code)] = e.target.value; else delete m[String(o.code)]; set({ optionExplanations: Object.keys(m).length ? m : undefined }); }} /></label>
              ))}
            </details>
            <label className="row" style={{ gap: 6, fontSize: 12.5, marginTop: 6 }}>
              <input type="checkbox" checked={!!a.ungraded} data-testid="assessment-ungraded" onChange={(e) => set({ ungraded: e.target.checked || undefined })} /> not scored (a survey question inside the paper)
            </label>
            {issues && (issues.errors.length > 0 || issues.warnings.length > 0) && (
              <ul className="tc-list" data-testid="assessment-q-issues" style={{ marginTop: 6, fontSize: 12.5 }}>
                {[...issues.errors, ...issues.warnings].map((i, k) => <li key={k} className={issues.errors.includes(i) ? "err" : "warn"}>{i.message}</li>)}
              </ul>
            )}
            <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>Hidden from respondents until they submit.</span>
              <button type="button" className="btn small" data-testid="assessment-clear-q" onClick={() => set(null)}>Remove key</button>
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}
