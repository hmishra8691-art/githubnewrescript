"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import type { AutoPunchExplanation } from "@rescript/engine";

/**
 * PROGRAMMER CHROME ON A QUESTION — preview and test only (brief 19/10/2026).
 *
 * The Runner hands `QuestionRenderer` a `programmerView` when, and only when,
 * the page is a preview, the runtime's test mode or a test link
 * (`revealsHiddenQuestions` in the engine decides; the mode comes from the
 * route that served the page, never from the URL). A live link passes
 * nothing, and this module renders nothing: no banner, no badge, no colour,
 * no stylesheet — the DOM a respondent gets is byte-for-byte what it was.
 *
 * Everything here hangs on the question CONTAINER, so every question type —
 * single, multi, text, numeric, grid, rating, ranking, allocation, MaxDiff,
 * media, custom — gets the same treatment without any renderer knowing:
 *
 *   · the hidden-question theme: light purple card, dashed purple border, a
 *     purple header with an eye-slash, "HIDDEN QUESTION — TEST MODE", the
 *     question number with "🔒 HIDDEN", an information banner at the top and
 *     "Visibility: Hidden from live respondents" at the foot;
 *   · the auto-punch visualisation: the options a rule put into the answer
 *     are painted green with an AUTO-PUNCHED badge — by a stylesheet scoped
 *     to this card that addresses the `data-rs-el="option"` / `"row"`
 *     anchors every option renderer already carries — plus an Auto-Punch
 *     Status line, the selected answer and an expandable details table. A
 *     manual selection is not in `punchedCodes`, so it keeps the theme colour.
 */
export interface ProgrammerView {
  mode: "preview" | "test";
  /** `settings.hidden`: draw the hidden-question theme */
  hidden: boolean;
  /** what the question's auto-punch rules did; null / absent = no answer-side rules */
  autoPunch?: AutoPunchExplanation | null;
}

export const HIDDEN_BANNER_TEXT = "Hidden Question: This question is not visible to respondents in the live survey. It is displayed here for testing purposes only.";
export const HIDDEN_FOOTER_TEXT = "Visibility: Hidden from live respondents";

/** The class list the container gets; "" on a live link. */
export function programmerCardClass(pv: ProgrammerView | null | undefined): string {
  if (!pv) return "";
  const out: string[] = ["rs-programmer-q"];
  if (pv.hidden) out.push("rs-hidden-q");
  if (pv.autoPunch) out.push("rs-autopunch-q", `rs-autopunch-${pv.autoPunch.status}`);
  return out.join(" ");
}

/** CSS attribute-selector escaping for an option code or a question id. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * The stylesheet that paints this card's punched options green. Scoped to
 * the card by its `data-qid`, so two cards on one page never colour each
 * other's options. Specificity beats `.rs-option.selected` on purpose.
 */
export function autoPunchCss(qid: string, ap: AutoPunchExplanation): string {
  const card = `.rs-card[data-qid="${esc(qid)}"]`;
  const rules: string[] = [];
  const paint = (sel: string) => {
    rules.push(`${sel}{background:#DCFCE7 !important;border-color:#16A34A !important;box-shadow:inset 0 0 0 1px #16A34A;position:relative}`);
    rules.push(`${sel} input[type="radio"],${sel} input[type="checkbox"],${sel} input[type="range"]{accent-color:#16A34A !important}`);
    rules.push(`${sel}::after{content:"AUTO-PUNCHED";margin-inline-start:8px;font-size:10px;font-weight:700;letter-spacing:.06em;color:#fff;background:#16A34A;border-radius:999px;padding:2px 7px;line-height:1.4;white-space:nowrap;align-self:center}`);
  };
  for (const code of new Set(ap.punchedCodes)) paint(`${card} [data-rs-el="option"][data-rs-id="${esc(code)}"]`);
  for (const [row, codes] of Object.entries(ap.punchedRows)) {
    rules.push(`${card} [data-rs-el="row"][data-rs-id="${esc(row)}"]{background:#DCFCE7}`);
    for (const code of new Set(codes)) paint(`${card} [data-rs-el="row"][data-rs-id="${esc(row)}"] [data-rs-el="option"][data-rs-id="${esc(code)}"]`);
  }
  return rules.join("\n");
}

const EyeSlash = () => (
  <svg className="rs-hidden-eye" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

/** Above the question text: the banner and the purple header. Nothing when the question is not hidden. */
export function HiddenQuestionHead({ q, pv }: { q: Question; pv: ProgrammerView }) {
  if (!pv.hidden) return null;
  return (
    <>
      <div className="rs-hidden-banner" role="note" data-testid="rs-hidden-banner">
        <span aria-hidden="true">{"ℹ️"}</span> <strong>Hidden Question:</strong> {HIDDEN_BANNER_TEXT.replace(/^Hidden Question: /, "")}
      </div>
      <div className="rs-hidden-head" data-testid="rs-hidden-head">
        <EyeSlash />
        <span className="rs-hidden-badge" data-testid="rs-hidden-badge">HIDDEN QUESTION — {pv.mode === "test" ? "TEST" : "PREVIEW"} MODE</span>
        <span className="rs-hidden-qnum" data-testid="rs-hidden-qnum">{q.code} — <span aria-hidden="true">{"\u{1F512}"}</span> HIDDEN</span>
      </div>
    </>
  );
}

/** Below the answer: the auto-punch status and details, then the visibility line. */
export function ProgrammerFoot({ q, pv }: { q: Question; pv: ProgrammerView }) {
  const ap = pv.autoPunch ?? null;
  return (
    <>
      {ap && (
        <div className="rs-autopunch" data-testid="rs-autopunch" data-status={ap.status}>
          <style dangerouslySetInnerHTML={{ __html: autoPunchCss(q.id, ap) }} />
          <div className="rs-autopunch-status" data-testid="rs-autopunch-status">
            <strong>Auto-Punch Status:</strong> <span aria-hidden="true">{ap.statusIcon}</span> {ap.statusLabel}
          </div>
          <div className="rs-autopunch-selected" data-testid="rs-autopunch-selected">
            <strong>Selected Answer:</strong> {ap.selectedAnswer || "—"}
          </div>
          <details className="rs-autopunch-details" data-testid="rs-autopunch-details">
            <summary>Auto-Punch Details</summary>
            <table>
              <tbody>
                {ap.rules.map((r, i) => (
                  <React.Fragment key={r.ruleId || i}>
                    {ap.rules.length > 1 && (
                      <tr className="rs-autopunch-rule"><th colSpan={2}>Rule {i + 1}{r.label ? ` — ${r.label}` : ""}{r.mode !== "if" ? ` (${r.mode === "else_if" ? "ELSE IF" : "ELSE"})` : ""}</th></tr>
                    )}
                    <tr><th>Source Question</th><td>{r.sourceQuestions.join(", ") || "—"}</td></tr>
                    <tr><th>Condition</th><td>{r.condition}</td></tr>
                    <tr><th>Target Question</th><td>{r.target}</td></tr>
                    <tr><th>{r.action === "set_value" ? "Set Value" : r.action === "clear" ? "Action" : r.action === "deselect" ? "Deselected Option" : "Selected Option"}</th><td>{r.action === "clear" ? "Clear the answer" : r.selected.join(", ") || "—"}</td></tr>
                    <tr><th>Execution Result</th><td data-testid="rs-autopunch-result">{r.result === null ? "NOT REACHED" : r.result ? "TRUE" : "FALSE"}</td></tr>
                    <tr><th>Status</th><td>{r.status === "applied" ? "Successfully Applied" : r.status === "condition_false" ? "Condition not met" : "Not reached (an earlier branch matched)"}</td></tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
      {pv.hidden && (
        <div className="rs-hidden-foot" data-testid="rs-hidden-foot">
          <EyeSlash /> {HIDDEN_FOOTER_TEXT}
        </div>
      )}
    </>
  );
}
