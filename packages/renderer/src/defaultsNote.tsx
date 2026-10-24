"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { unresolvedDefaultsFor, type EvalContext } from "@rescript/engine";

/**
 * PREVIEW / TEST ONLY (2026-10-24, client item A63): a configured default /
 * piped value that resolves to nothing — `{{Q1}}` before Q1 is answered, a
 * name that is not a number in a numeric cell — is listed under the question
 * so the programmer sees why the field is empty. Rendered only when the
 * Runner passes a `programmerView` (preview, test mode, test links); a live
 * respondent gets nothing — no note, no `{{…}}` syntax, just an empty field.
 */
export function DefaultsNote({ q, ctx }: { q: Question; ctx: EvalContext }): JSX.Element | null {
  let missing: ReturnType<typeof unresolvedDefaultsFor> = [];
  try { missing = unresolvedDefaultsFor(q, ctx); } catch { missing = []; }
  if (!missing.length) return null;
  return (
    <div className="rs-defaults-note" role="note" data-testid="rs-default-unresolved"
      style={{ margin: "6px 0", padding: "6px 10px", borderRadius: 6, fontSize: "0.85em", background: "#fff7ed", color: "#9a3412", border: "1px dashed #fdba74" }}>
      Test note — a default / piped value resolved to nothing, so the field starts empty
      {" "}(live respondents only see the empty field):{" "}
      {missing.map((m, i) => (
        <span key={i} data-testid="rs-default-unresolved-item">{i ? "; " : ""}<strong>{m.field}</strong> ← <code>{m.configured}</code></span>
      ))}
    </div>
  );
}
