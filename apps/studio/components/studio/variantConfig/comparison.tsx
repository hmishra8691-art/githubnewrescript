"use client";
import React from "react";
import type { Option, Question, QuestionRow } from "@rescript/schema";
import { registerVariantSettings, registerOptionMetaFields, BADGE } from "./registry";

/**
 * Studio authoring for the comparison family — the attribute grid for
 * `attrcompare`.
 *
 * A comparison table needs a value per (item × attribute). Per-option meta
 * fields can only hold a flat string, so the cells live in
 * `option.meta.attributes[rowCode]` and are edited here as the grid the
 * respondent will see: attributes down the side, items across the top. The
 * attribute list itself is edited here too — `single_select` has no Rows
 * section in the generic editor, and inventing one would change the editor
 * for every option-based question.
 */

type AttrBag = Record<string, unknown>;

function bagOf(o: Option): AttrBag {
  const bag = o.meta?.attributes;
  return bag && typeof bag === "object" && !Array.isArray(bag) ? { ...(bag as AttrBag) } : {};
}

function withBag(o: Option, bag: AttrBag): Option {
  const meta = { ...(o.meta ?? {}) };
  if (Object.keys(bag).length) meta.attributes = bag; else delete meta.attributes;
  return { ...o, meta: Object.keys(meta).length ? meta : undefined };
}

function freshCode(rows: QuestionRow[]): string {
  let n = rows.length + 1;
  const used = new Set(rows.map((r) => String(r.code)));
  while (used.has(`a${n}`)) n++;
  return `a${n}`;
}

registerOptionMetaFields("attrcompare", [BADGE]);

registerVariantSettings("attrcompare", ({ q, patch }) => {
  const rows = q.rows;
  const options = q.options;

  const setCell = (optIdx: number, rowCode: string, value: string) => {
    patch({
      options: options.map((o, j) => {
        if (j !== optIdx) return o;
        const bag = bagOf(o);
        if (value) bag[rowCode] = value; else delete bag[rowCode];
        return withBag(o, bag);
      }) as Question["options"],
    });
  };
  const setLabel = (i: number, label: string) =>
    patch({ rows: rows.map((r, j) => (j === i ? { ...r, label } : r)) });
  /** Renaming an attribute's code moves every cell keyed by it, in one edit. */
  const setCode = (i: number, code: string) => {
    const from = String(rows[i].code);
    if (!code || code === from || rows.some((r, j) => j !== i && String(r.code) === code)) return;
    patch({
      rows: rows.map((r, j) => (j === i ? { ...r, code } : r)),
      options: options.map((o) => {
        const bag = bagOf(o);
        if (!(from in bag)) return o;
        const v = bag[from];
        delete bag[from];
        bag[code] = v;
        return withBag(o, bag);
      }) as Question["options"],
    });
  };
  const addAttr = () =>
    patch({
      rows: [...rows, { code: freshCode(rows), label: "New attribute", flags: [], validation: [], required: false }] as Question["rows"],
    });
  const removeAttr = (i: number) => {
    const code = String(rows[i].code);
    patch({
      rows: rows.filter((_, j) => j !== i),
      options: options.map((o) => {
        const bag = bagOf(o);
        if (!(code in bag)) return o;
        delete bag[code];
        return withBag(o, bag);
      }) as Question["options"],
    });
  };

  return (
    <>
      <h3 className="sec">Attributes compared</h3>
      {options.length === 0 ? (
        <div className="chip warn" data-testid="attr-no-options">
          Add the items being compared in <strong>Options</strong> above — each one becomes a column.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="grid" data-testid="attr-grid">
            <thead>
              <tr>
                <th style={{ minWidth: 150 }}>Attribute</th>
                {options.map((o, j) => (
                  <th key={`${o.code}_${j}`} dangerouslySetInnerHTML={{ __html: o.label || String(o.code) }} />
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={options.length + 2}>No attributes yet — add the first one below.</td></tr>
              )}
              {rows.map((r, i) => {
                const rc = String(r.code);
                return (
                  <tr key={`${rc}_${i}`}>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <input className="input code-input" style={{ width: 74, flex: "none" }}
                          title="attribute code — the key cells are stored under"
                          data-testid={`attr-code-${i}`}
                          value={rc} onChange={(e) => setCode(i, e.target.value)} />
                        <input className="input" style={{ flex: 1, minWidth: 90 }} placeholder="attribute name"
                          data-testid={`attr-label-${i}`}
                          value={r.label} onChange={(e) => setLabel(i, e.target.value)} />
                      </div>
                    </td>
                    {options.map((o, j) => (
                      <td key={`${o.code}_${j}`}>
                        <input className="input" style={{ width: 130 }} placeholder="—"
                          data-testid={`attr-cell-${i}-${j}`}
                          value={String(bagOf(o)[rc] ?? "")}
                          onChange={(e) => setCell(j, rc, e.target.value)} />
                      </td>
                    ))}
                    <td>
                      <button className="btn small" data-testid={`attr-remove-${i}`}
                        title="remove this attribute" onClick={() => removeAttr(i)}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn small" data-testid="attr-add" onClick={addAttr}>+ attribute</button>
        <span className="chip">
          Cells are stored on each option as <code className="code">meta.attributes.&lt;code&gt;</code>.
        </span>
      </div>
    </>
  );
});
