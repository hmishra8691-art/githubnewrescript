"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useRows, metaText } from "./shared";

/**
 * Comparison family — Multi-Item / Attribute Comparison (`attrcompare`).
 *
 * A comparison table: the OPTIONS are the columns (the items being compared)
 * and the ROWS are the attributes. Each cell's text lives in
 * `option.meta.attributes[rowCode]`, so one option carries all of its own
 * values and adding an attribute never has to touch the options.
 *
 * The answer is one code — the item chosen — so this is an ordinary
 * `single_select` for logic, piping, exports and the dictionary. The table is
 * purely how the question is presented.
 *
 * "Pairwise / Tournament Comparison" stays planned; it is a different family
 * member with a different response shape.
 */

/** `option.meta.attributes` — a bag keyed by row code. */
function cellText(o: { meta?: Record<string, unknown> }, rowCode: string): string {
  const bag = o.meta?.attributes;
  if (bag && typeof bag === "object" && !Array.isArray(bag)) {
    const v = (bag as Record<string, unknown>)[rowCode];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  // an attribute may also be stored flat on the option (meta.price, meta.weight)
  const flat = o.meta?.[rowCode];
  return flat === undefined || flat === null ? "" : String(flat);
}

export function AttributeCompare(p: QRProps) {
  const options = useOptions(p);
  const rows = useRows(p);
  const chosen = options.find((o) => String(o.code) === String(p.value));

  if (options.length === 0) {
    return <div className="rs-error-msg">Nothing to compare — add the items in Options.</div>;
  }

  const pick = (code: string | number) => {
    if (p.q.settings.readOnly) return;
    p.onChange(String(p.value) === String(code) ? null : code);
  };

  const chooseCell = (o: { code: string | number; label: string }) => {
    const sel = String(p.value) === String(o.code);
    return (
      <button type="button" className={`rs-richcard-select ${sel ? "on" : ""}`}
        aria-pressed={sel} data-code={String(o.code)}
        data-testid={`attr-choose-${String(o.code)}`}
        aria-label={`Choose ${o.label.replace(/<[^>]*>/g, "")}`}
        onClick={() => pick(o.code)}>
        {sel ? "Chosen ✓" : "Choose"}
      </button>
    );
  };

  return (
    <div className="rs-attrcompare">
      <div className="rs-attrcompare-pick" data-testid="attr-pick" aria-live="polite">
        {chosen
          ? <>Your pick: <strong dangerouslySetInnerHTML={{ __html: chosen.label }} /></>
          : <span className="rs-judge-hint">Compare the attributes below, then choose one.</span>}
      </div>
      {/* the TABLE scrolls, never the page — a six-item comparison on a phone
          would otherwise push the whole survey sideways */}
      <div className="rs-attrcompare-wrap" data-testid="attr-scroll" tabIndex={0}>
        <table className="rs-attrtable">
          <caption className="rs-sr-only">Items compared across {rows.length} attributes</caption>
          <thead>
            <tr>
              <th scope="col" className="attr">Attribute</th>
              {options.map((o) => {
                const sel = String(p.value) === String(o.code);
                return (
                  <th key={String(o.code)} scope="col" className={sel ? "chosen" : ""} data-code={String(o.code)}>
                    {o.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.imageUrl} alt="" draggable={false} />
                    )}
                    <span className="rs-attr-item" dangerouslySetInnerHTML={{ __html: o.label }} />
                    {metaText(o, "badge") && <span className="rs-badge">{metaText(o, "badge")}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="attr rs-judge-hint" colSpan={options.length + 1}>
                  No attributes yet — add them in the question’s attribute grid.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const rc = String(r.code);
              return (
                <tr key={rc} data-row={rc}>
                  <th scope="row" className="attr" dangerouslySetInnerHTML={{ __html: r.label }} />
                  {options.map((o) => {
                    const sel = String(p.value) === String(o.code);
                    const txt = cellText(o, rc);
                    return (
                      <td key={String(o.code)} className={sel ? "chosen" : ""}
                        data-row={rc} data-code={String(o.code)}>
                        {txt || <span className="rs-judge-hint">—</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="attr">Your choice</th>
              {options.map((o) => (
                <td key={String(o.code)} className={String(p.value) === String(o.code) ? "chosen" : ""}>
                  {chooseCell(o)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

registerVariantRenderer("attrcompare", AttributeCompare);
