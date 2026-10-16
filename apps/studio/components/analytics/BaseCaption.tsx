"use client";
import React from "react";
import type { AnalysisResult, DatasetSpec, RunScope } from "@rescript/analytics";
import { baseCaption, baseCaptionParts, runCaption } from "@rescript/analytics";

/**
 * THE BASE CAPTION — the one line under every result that says what the n
 * is a count of (audit 2026-10-16, OR-03 "the base of 20").
 *
 *   n = 20 · answered Q5 · 20 of 84 completes in scope (filter: Region = West; LIVE; clean dataset)
 *
 * Every surface that prints a base — the result header, the table footer,
 * the report block, the findings header — prints it through this component,
 * so the scope is never separated from the number. The words come from
 * `@rescript/analytics`' `baseCaption`, read off the result's own
 * provenance (the analysis as run: dataset spec, filter, weighting); nothing
 * is computed here.
 */
export function BaseCaption({ result, segment, labelOf, variant = "full", testId = "ax-base", style, prefix }: {
  result: Pick<AnalysisResult, "base" | "variablesUsed" | "provenance">;
  /** the segment the figures on screen are for, when one is selected */
  segment?: { name: string; n: number } | null;
  labelOf?: (variable: string) => string;
  /** `short` leaves out who answered — for a panel or a table footer where the header already said */
  variant?: "full" | "short";
  testId?: string;
  style?: React.CSSProperties;
  /** text before the caption on the same line ("Base: ") */
  prefix?: string;
}) {
  const text = captionText(result, { segment, labelOf, variant });
  return <div className="muted ax-base-caption" style={{ fontSize: 12.5, ...style }} data-testid={testId} title={captionText(result, { segment, labelOf, variant: "full" })}>{prefix}{text}</div>;
}

/** the caption as text — for a title attribute, a tooltip, a TSV footer */
export function captionText(result: Pick<AnalysisResult, "base" | "variablesUsed" | "provenance">, opts: { segment?: { name: string; n: number } | null; labelOf?: (v: string) => string; variant?: "full" | "short" } = {}): string {
  const input = { base: result.base, variablesUsed: result.variablesUsed, definition: result.provenance?.definition ?? null, segment: opts.segment ?? null, ...(opts.labelOf ? { labelOf: opts.labelOf } : {}) };
  if (opts.variant === "short") {
    const p = baseCaptionParts(input);
    const head = [p.n, p.segment, p.inScope].filter(Boolean).join(" · ");
    return p.scope.length ? `${head} (${p.scope.join("; ")})` : head;
  }
  return baseCaption(input);
}

/** the scope alone, for a footer that already prints its own n: "25 of 30 completes in scope (LIVE; all responses)" */
export function scopeText(result: Pick<AnalysisResult, "base" | "variablesUsed" | "provenance">, opts: { segment?: { name: string; n: number } | null; labelOf?: (v: string) => string } = {}): string {
  const p = baseCaptionParts({ base: result.base, variablesUsed: result.variablesUsed, definition: result.provenance?.definition ?? null, segment: opts.segment ?? null, ...(opts.labelOf ? { labelOf: opts.labelOf } : {}) });
  const head = [p.segment, p.inScope].filter(Boolean).join(" · ");
  return p.scope.length ? `${head} (${p.scope.join("; ")})` : head;
}

/** the caption of a plan run: "n = 40 completes in scope (LIVE; clean dataset)" — from the scope the run recorded, or its environment alone for older runs */
export function RunBaseCaption({ run, scope, testId = "ax-run-base", style }: { run: { n: number; environment: DatasetSpec["environment"] }; scope?: RunScope | null; testId?: string; style?: React.CSSProperties }) {
  return <span className="muted ax-base-caption" style={{ fontSize: 12.5, ...style }} data-testid={testId}>{runCaption(run, scope ?? null)}</span>;
}
