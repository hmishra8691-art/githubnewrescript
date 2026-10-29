"use client";
import React from "react";
import { sanitizeHtml, type RespondentAssessmentReport } from "@rescript/engine";

/**
 * THE RESULTS REPORT of an assessment (2026-10-25, K4; ported 2026-10-29, docs/ASSESSMENTS-2026-10-29.md).
 *
 * Rendered from the SERVER's result after submission — never from the
 * definition, which a respondent receives with the answer key stripped. Every
 * section is optional (the paper's `report` settings decide), themed with the
 * survey's `--rs-*` variables, readable at phone width (the per-question table
 * becomes cards), and printable (`window.print()` → "Save as PDF"; the print
 * stylesheet hides the survey chrome and expands every explanation).
 *
 * `badge` is shown above the summary — the Studio preview uses it to say the
 * score was computed in the programmer's browser.
 */
export interface AssessmentReportProps {
  report: RespondentAssessmentReport;
  badge?: string;
  /** hide the Print button (e.g. inside the Studio) */
  noPrint?: boolean;
}

const STATUS_WORD: Record<string, string> = { correct: "Correct", incorrect: "Incorrect", partial: "Partly correct", unattempted: "Not attempted" };
const STATUS_MARK: Record<string, string> = { correct: "✓", incorrect: "✗", partial: "◐", unattempted: "–" };
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
/* the question text is the survey's own; sanitised again here, as every HTML the renderer prints (QuestionRenderer) */
const plainHtml = (s: string) => sanitizeHtml(s);

export function AssessmentReport({ report, badge, noPrint }: AssessmentReportProps) {
  const r = report;
  const sec = r.sections;
  const [filter, setFilter] = React.useState<"all" | "incorrect" | "unattempted">("all");
  const qs = (r.questions ?? []).filter((q) => filter === "all" || (filter === "incorrect" ? q.status === "incorrect" || q.status === "partial" : q.status === "unattempted"));
  return (
    <section className="rs-asmt" data-testid="assessment-report" aria-label="Your results">
      {badge && <div className="rs-asmt-badge" data-testid="assessment-badge">{badge}</div>}
      <header className="rs-asmt-head">
        <h2>{r.title ? `${r.title} — your results` : "Your results"}</h2>
        {!noPrint && (
          <button type="button" className="rs-btn rs-asmt-print" data-testid="assessment-print" onClick={() => window.print()}>
            Print / save as PDF
          </button>
        )}
      </header>

      {sec.summary && r.marks !== undefined && (
        <div className="rs-asmt-summary" data-testid="assessment-summary">
          <div className="rs-asmt-score">
            <span className="rs-asmt-big" data-testid="assessment-score">{fmt(r.marks)}</span>
            <span className="rs-asmt-of">/ {fmt(r.maxMarks)} marks</span>
          </div>
          <div className="rs-asmt-kpis">
            <span><b data-testid="assessment-pct">{fmt(r.percentage)}%</b> score</span>
            <span><b>{r.correct}</b> correct</span>
            <span><b>{r.incorrect}</b> incorrect</span>
            {!!r.partial && <span><b>{r.partial}</b> partly correct</span>}
            <span><b>{r.unattempted}</b> not attempted</span>
            {!!r.negative && <span><b>−{fmt(r.negative)}</b> negative marks</span>}
          </div>
          {r.passed !== null && r.passed !== undefined && (
            <div className={`rs-asmt-verdict ${r.passed ? "pass" : "fail"}`} data-testid="assessment-verdict">
              {r.passed ? "Passed" : "Not passed"} — pass mark {fmt(r.passMark)}
            </div>
          )}
        </div>
      )}

      {sec.weakAreas && !!r.weakAreas && (
        <div className="rs-asmt-block" data-testid="assessment-weak">
          <h3>Weak areas</h3>
          {r.weakAreas.length ? (
            <ul>{r.weakAreas.map((w) => <li key={w.topic} data-topic={w.topic}><b>{w.topic}</b> — {w.reason}</li>)}</ul>
          ) : <p className="rs-asmt-muted">No topic below the threshold — well done.</p>}
        </div>
      )}

      {sec.recommendations && !!r.recommendations?.length && (
        <div className="rs-asmt-block" data-testid="assessment-recommendations">
          <h3>Recommended revision</h3>
          <ol>{r.recommendations.map((x) => <li key={x.topic}>{x.reason}{x.questions.length ? <span className="rs-asmt-muted"> — questions {x.questions.join(", ")}</span> : null}</li>)}</ol>
        </div>
      )}

      {sec.topicBreakdown && !!r.topics?.length && (
        <div className="rs-asmt-block" data-testid="assessment-topics">
          <h3>By topic</h3>
          <div className="rs-asmt-tablewrap">
            <table className="rs-asmt-table">
              <thead><tr><th>Topic</th><th>Questions</th><th>Attempted</th><th>Correct</th><th>Accuracy</th><th>Marks</th></tr></thead>
              <tbody>
                {r.topics.map((t) => (
                  <tr key={t.topic} data-topic={t.topic}>
                    <td data-label="Topic">{t.topic}</td>
                    <td data-label="Questions">{t.questions}</td>
                    <td data-label="Attempted">{t.attempted}</td>
                    <td data-label="Correct">{t.correct}</td>
                    <td data-label="Accuracy">{t.accuracy === null ? "–" : `${fmt(t.accuracy)}%`}</td>
                    <td data-label="Marks">{fmt(t.marks)} / {fmt(t.maxMarks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sec.perQuestion && !!r.questions?.length && (
        <div className="rs-asmt-block" data-testid="assessment-questions">
          <div className="rs-asmt-qhead">
            <h3>Question by question</h3>
            <div className="rs-asmt-filter" role="group" aria-label="Show">
              {(["all", "incorrect", "unattempted"] as const).map((f) => (
                <button key={f} type="button" className={filter === f ? "on" : ""} aria-pressed={filter === f} data-testid={`assessment-filter-${f}`} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "incorrect" ? "Mistakes" : "Not attempted"}
                </button>
              ))}
            </div>
          </div>
          <ol className="rs-asmt-qs">
            {qs.map((q) => (
              <li key={q.id} className={`rs-asmt-q ${q.status}`} data-testid="assessment-q" data-qid={q.id} data-status={q.status}>
                <div className="rs-asmt-qtop">
                  <span className="rs-asmt-code">{q.code}</span>
                  <span className="rs-asmt-status" data-testid="assessment-q-status"><span aria-hidden>{STATUS_MARK[q.status]}</span> {STATUS_WORD[q.status]}</span>
                  <span className="rs-asmt-marks">{q.marks > 0 ? "+" : ""}{fmt(q.marks)} / {fmt(q.maxMarks)}</span>
                  <span className="rs-asmt-topic">{q.topic}{q.subtopic ? ` · ${q.subtopic}` : ""}</span>
                </div>
                <div className="rs-asmt-qtext" dangerouslySetInnerHTML={{ __html: plainHtml(q.text) }} />
                <dl className="rs-asmt-answers">
                  <dt>Your answer</dt>
                  <dd data-testid="assessment-q-selected">{q.selectedLabels.length ? q.selectedLabels.join(", ") : <i>not attempted</i>}</dd>
                  <dt>Correct answer</dt>
                  <dd data-testid="assessment-q-correct">{q.correctLabels.join(", ")}</dd>
                </dl>
                {q.mistakeExplanation && (
                  <p className="rs-asmt-mistake" data-testid="assessment-q-mistake"><b>Why your answer is wrong:</b> {q.mistakeExplanation}</p>
                )}
                {q.explanation && (
                  <details className="rs-asmt-why" open={q.status !== "correct"}>
                    <summary>Explanation</summary>
                    <p data-testid="assessment-q-explanation">{q.explanation}</p>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
