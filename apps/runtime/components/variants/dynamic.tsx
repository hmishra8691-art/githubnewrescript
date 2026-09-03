"use client";
import React from "react";
import { effectiveQuestion, pickAdaptive } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { ctxOf } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { activate, colsClass, useChoice } from "./shared";

/**
 * Dynamic / Adaptive family — Adaptive Question / Scale.
 *
 * Base type `single_select`: the answer is one code, so nothing about logic,
 * piping or the export changes. What adapts is the PRESENTATION — the first
 * alternative in `settings.adaptive` whose condition holds replaces the
 * question's wording and/or its option list.
 *
 * The alternative's text is rendered HERE, above the options, rather than by
 * the question shell: the shell always prints the authored `q.text` (that is
 * the one line every question in the platform shares), so the adapted stem is
 * shown as its own block and the authored text stays as the default stem.
 * Studio says so in the settings panel.
 *
 * Options substituted by an alternative still go through the full option
 * pipeline — masks, list logic, sorting, randomization — because they are fed
 * back through `effectiveQuestion` on a copy of the question rather than
 * rendered raw.
 */

function useNonLive(): boolean {
  const [v, setV] = React.useState(false);
  React.useEffect(() => {
    setV(typeof window !== "undefined" && !!(window as unknown as { __rescriptState?: unknown }).__rescriptState);
  }, []);
  return v;
}

export function AdaptiveQuestion(p: QRProps) {
  const ctx = ctxOf(p);
  const alt = pickAdaptive(p.q, ctx);
  // substituting into the question object (not into the rendered list) is what
  // keeps option logic, masking and randomization applying to the alternative
  const source = alt?.options?.length ? { ...p.q, options: alt.options } : p.q;
  const options = effectiveQuestion(source, ctx).options;
  const { isSelected, pick } = useChoice(p, false, options);
  const nonLive = useNonLive();

  return (
    <div className="rs-adaptive" data-testid="adaptive"
      data-alt={alt ? (alt.label ?? "matched") : ""}>
      {nonLive && (
        <div className="rs-adaptive-tag" data-testid="adaptive-tag">
          {alt ? `adapted: ${alt.label ?? "alternative"}` : "as authored (no alternative matched)"}
        </div>
      )}
      {alt?.text && (
        <p className="rs-adaptive-text" data-testid="adaptive-text"
          dangerouslySetInnerHTML={{ __html: alt.text }} />
      )}
      {alt?.instruction && (
        <p className="rs-adaptive-instruction" data-testid="adaptive-instruction"
          dangerouslySetInnerHTML={{ __html: alt.instruction }} />
      )}
      <div
        className={`rs-options ${(p.q.settings.columnsLayout ?? 1) > 1 ? colsClass(p, 1) : ""}`}
        role="radiogroup"
      >
        {options.map((o) => {
          const sel = isSelected(o);
          return (
            <div key={String(o.code)} className={`rs-option ${sel ? "selected" : ""}`}
              role="radio" aria-checked={sel} tabIndex={0} data-code={String(o.code)}
              onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
              <span className={`rs-adaptive-mark ${sel ? "on" : ""}`} aria-hidden />
              <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
            </div>
          );
        })}
        {options.length === 0 && (
          <div className="rs-error-msg">This adaptive question has no options to show.</div>
        )}
      </div>
    </div>
  );
}

registerVariantRenderer("adaptive", AdaptiveQuestion);
