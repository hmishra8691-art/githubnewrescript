"use client";
import React from "react";
import type { Question, SurveyDefinition } from "@rescript/schema";
import { lintPipingTokens } from "@rescript/engine";
import { InsertPipedText } from "./InsertPipedText";

/**
 * DEFAULT / PIPED VALUE — one box for every open-ended field (2026-10-24,
 * client item A63).
 *
 * The State section has always had this box for a QUESTION ("static, or
 * {{Q1}} piped"). Every field a respondent types into now gets the same box
 * — a Text / Numeric List field, a Text or Numeric Matrix row, a Constant
 * Sum row, a cell or column of a composite grid, an "Other — specify" box —
 * and it is this one component everywhere, so the box behaves the same way:
 * empty by default (nothing changes), a static value or a `{{…}}` token
 * inserted with the shared Insert piped text picker, and a warning chip the
 * moment a token would not resolve (the existing `lintPipingTokens` rule,
 * the one question text uses). The runtime resolves it when the question is
 * first shown and fills the field; the respondent never sees the box or the
 * syntax (see engine `defaultValue.ts`).
 */
export function DefaultValueBox({ def, q, value, onChange, accept = "text", label = "Default / piped value", placeholder, testId = "default-value", compact, title }: {
  def: SurveyDefinition;
  /** the question the field belongs to (its loop variables resolve against it) */
  q?: Question;
  value: unknown;
  onChange(next: string | undefined): void;
  /** a numeric field is offered numeric sources */
  accept?: "text" | "number";
  label?: string;
  placeholder?: string;
  testId?: string;
  /** one line beside other controls, instead of a labelled field */
  compact?: boolean;
  title?: string;
}): JSX.Element {
  const text = value == null ? "" : String(value);
  const problems = text.includes("{{") ? lintPipingTokens(def, text, q) : [];
  const ref = React.useRef<HTMLInputElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const at = el && document.activeElement === el ? el.selectionStart ?? text.length : text.length;
    onChange(`${text.slice(0, at)}${token}${text.slice(at)}` || undefined);
  };
  const box = (
    <>
      <input ref={ref} className="input mono" data-testid={testId} value={text}
        placeholder={placeholder ?? (accept === "number" ? "default, or {{Q1}} piped" : "static, or {{Q1}} piped")}
        title={title ?? "The value this field starts with: static, or piped from an earlier answer / embedded data. Filled in when the question is first shown, only while the field is empty — the respondent can change it. Empty = no default."}
        style={compact ? { width: 170, maxWidth: 170 } : undefined}
        onChange={(e) => onChange(e.target.value || undefined)} />
      <InsertPipedText def={def} accept={accept} label="Pipe" testId={`${testId}-pipe`} onInsert={insert} />
      {problems.map((p, i) => (
        <span key={i} className="chip warn" data-testid={`${testId}-warning`} title="This token resolves to nothing — the field will start empty in the live survey">{p}</span>
      ))}
    </>
  );
  if (compact) return <span className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }} data-testid={`${testId}-box`} title={label}>{box}</span>;
  return (
    <label className="f" style={{ marginTop: 8 }} data-testid={`${testId}-box`}>
      <span>{label}</span>
      <span className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }}>{box}</span>
    </label>
  );
}
