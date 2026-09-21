"use client";
import React from "react";
import type { QuestionColumn } from "@rescript/schema";
import { effectiveQuestion } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { NumberField, ctxOf } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useRows, activate, usePointerDrag, dropTargetAt } from "./shared";
import { anchor, cellAnchor } from "../authoring";

/**
 * Grid / Matrix family — the presentations that were "coming soon".
 *
 *   starmatrix   Star Rating Matrix     matrix_numeric, per_row  → {rowCode: n}
 *   summatrix    Constant-Sum Matrix    composite, cells         → {rowCode: {colId: n}}
 *   dragmatrix   Drag-and-Drop Matrix   matrix_single, per_row   → {rowCode: optionCode}
 *
 * (Slider Matrix reuses the slider family's `slidermatrix` renderer — one
 * renderer, two registry entries, exactly as Product Choice and Rich Cards
 * share `richcards`.)
 *
 * Every one of them stores what its base type already stores, so logic,
 * piping, the variable dictionary and the CSV layout see nothing new.
 */

/** The rows-are-missing hint every row-driven renderer owes the programmer. */
function NoRows({ what }: { what: string }) {
  return (
    <div className="rs-empty-hint" data-testid="matrix-no-rows">
      This {what} has no rows yet — add them in the question’s <strong>Rows</strong> section.
    </div>
  );
}

/* ------------------------------------------------------ Star Rating Matrix */
/**
 * One row of stars per item. Same numbers a Numeric Matrix stores, so a
 * rating grid reports as `VAR_<row>` like every other per-row question; the
 * stars are only how it is asked.
 */
export function StarMatrix(p: QRProps) {
  const rows = useRows(p);
  // stars start at one: a "zero stars" rating is indistinguishable from an
  // unrated row once it is stored as a number
  const min = Math.max(1, p.q.settings.minValue ?? 1);
  const max = Math.min(Math.max(p.q.settings.maxValue ?? 5, min + 1), min + 9);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const [hover, setHover] = React.useState<{ row: string; n: number } | null>(null);
  const scale = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  if (rows.length === 0) return <NoRows what="rating grid" />;

  const set = (rc: string, n: number) => {
    if (p.q.settings.readOnly) return;
    const next = { ...vals };
    // clicking the star you already chose clears the row
    if (Number(next[rc]) === n) delete next[rc];
    else next[rc] = n;
    p.onChange(next);
  };
  const rated = rows.filter((r) => vals[String(r.code)] != null).length;

  return (
    <div className="rs-starmatrix">
      <div className="rs-starmatrix-progress" data-testid="starmatrix-progress">
        {rated} / {rows.length} rated
      </div>
      {rows.map((row) => {
        const rc = String(row.code);
        const val = vals[rc] == null ? 0 : Number(vals[rc]);
        const shown = hover?.row === rc ? hover.n : val;
        const plain = row.label.replace(/<[^>]*>/g, "");
        return (
          <div key={rc} className={`rs-starmatrix-row ${val ? "rated" : ""}`} data-row={rc} {...anchor("row", rc)}>
            <span className="rs-starmatrix-label" dangerouslySetInnerHTML={{ __html: row.label }} />
            <span className="rs-starmatrix-stars" role="radiogroup" aria-label={plain}
              onMouseLeave={() => setHover(null)}>
              {scale.map((n) => (
                <button key={n} type="button"
                  className={n <= shown ? "on" : ""}
                  data-star={n}
                  role="radio"
                  aria-checked={val === n}
                  aria-label={`${plain}: ${n} of ${max}`}
                  disabled={p.q.settings.readOnly}
                  onMouseEnter={() => setHover({ row: rc, n })}
                  onFocus={() => setHover({ row: rc, n })}
                  onBlur={() => setHover(null)}
                  onClick={() => set(rc, n)}>
                  ★
                </button>
              ))}
            </span>
            <span className="rs-starmatrix-val" data-testid={`starmatrix-val-${rc}`}>
              {val ? `${val} / ${max}` : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------ Constant-Sum Matrix */
/**
 * Starter columns for a cell grid the programmer has not configured yet.
 *
 * `QuestionVariantDef.defaults` can seed settings, options and rows but not
 * columns, so a freshly picked Constant-Sum Matrix arrives with `columns: []`
 * and would render an empty table. Rather than show nothing, fall back to
 * three numeric columns; the Studio settings block offers a one-click
 * "create these columns" that writes exactly these ids into `q.columns`, so
 * the moment the programmer wants to rename, retype or validate them — or
 * wants them in the variable dictionary — nothing the respondent typed moves.
 *
 * Keep the ids in step with `starterSumColumns` in
 * apps/studio/components/studio/variantConfig/matrix.tsx.
 */
export function fallbackSumColumns(p: QRProps): QuestionColumn[] {
  return [1, 2, 3].map((n) => ({
    id: `c${n}`,
    label: `Column ${n}`,
    responseType: "numeric" as const,
    variableStem: `${p.q.variableName}_C${n}`,
    options: [],
    validation: [],
    readOnly: false,
    min: 0,
    flags: [],
  }));
}

export function SumMatrix(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const rows = view.rows;
  const columns = view.columns.length ? view.columns : fallbackSumColumns(p);
  const cells = (p.value ?? {}) as Record<string, Record<string, unknown>>;
  const target = p.q.settings.sumTarget ?? 100;
  const unit = p.q.settings.sumUnit ?? "";

  if (rows.length === 0) return <NoRows what="grid" />;

  const setCell = (rc: string, colId: string, v: number | null) => {
    const row = { ...(cells[rc] ?? {}) };
    if (v == null) delete row[colId];
    else row[colId] = v;
    p.onChange({ ...cells, [rc]: row });
  };
  const totalOf = (rc: string) =>
    columns.reduce((a, c) => a + (Number(cells[rc]?.[c.id]) || 0), 0);

  return (
    <div className="rs-table-wrap">
      <table className="rs-matrix rs-summatrix">
        <thead>
          <tr>
            <th className="rowlabel" />
            {columns.map((c) => (
              <th key={c.id} {...anchor("column", c.id)} style={c.width ? { width: c.width } : undefined}
                dangerouslySetInnerHTML={{ __html: c.label }} />
            ))}
            <th className="rs-summatrix-th-total">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rc = String(row.code);
            const total = totalOf(rc);
            const state = total === target ? "ok" : total > target ? "over" : "under";
            const plain = row.label.replace(/<[^>]*>/g, "");
            return (
              <tr key={rc} data-row={rc} {...anchor("row", rc)}>
                <td className="rowlabel" dangerouslySetInnerHTML={{ __html: row.label }} />
                {columns.map((c) => (
                  <td key={c.id} data-row={rc} data-col={c.id} {...cellAnchor(rc, c.id)}>
                    <NumberField className="rs-input" min={c.min ?? 0} max={c.max}
                      ariaLabel={`${plain} — ${c.label.replace(/<[^>]*>/g, "")}`}
                      readOnly={p.q.settings.readOnly || c.readOnly}
                      value={cells[rc]?.[c.id]}
                      onChange={(n) => setCell(rc, c.id, n)} />
                  </td>
                ))}
                <td className={`rs-summatrix-total ${state}`}
                  data-testid={`summatrix-total-${rc}`}>
                  {total} / {target}{unit}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------- Drag-and-Drop Matrix */
const POOL = "__pool__";

/**
 * The options are the columns; the rows are chips you move into them.
 * Identical data to a Single-Select Matrix (`{rowCode: optionCode}`), so
 * reporting and logic see ordinary VAR_<row> values.
 *
 * Pointer-based, never HTML5 drag: a real drag moves the chip, and a plain
 * tap — chip, then column — does the same thing, which is what a touch
 * respondent and the test suite both need.
 */
export function DragMatrix(p: QRProps) {
  const rows = useRows(p);
  const options = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const [picked, setPicked] = React.useState<string | null>(null);
  const down = React.useRef<{ x: number; y: number } | null>(null);
  const moved = React.useRef(false);

  const place = (rc: string, code: string | number | null) => {
    if (p.q.settings.readOnly) return;
    const next = { ...vals };
    if (code == null) delete next[rc];
    else next[rc] = code;
    p.onChange(next);
    setPicked(null);
  };

  const { drag, handleProps } = usePointerDrag<string>((rc, x, y) => {
    const d = down.current;
    moved.current = !!d && Math.hypot(x - d.x, y - d.y) > 6;
    if (!moved.current) return; // a tap — the click handler owns it
    const t = dropTargetAt(x, y);
    if (t == null) return;
    place(rc, t === POOL ? null : t);
  });

  if (rows.length === 0) return <NoRows what="grid" />;
  if (options.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="dragmatrix-no-options">
        This grid has no columns yet — its <strong>Options</strong> become the
        columns items are dragged into.
      </div>
    );
  }

  const placedCount = rows.filter((r) => vals[String(r.code)] != null).length;
  const inPool = rows.filter((r) => vals[String(r.code)] == null);

  const chip = (row: (typeof rows)[number], placed: boolean) => {
    const rc = String(row.code);
    const hp = handleProps(rc);
    const isPicked = picked === rc;
    return (
      <span key={rc}
        className={`rs-dragchip ${isPicked ? "picked" : ""} ${drag?.payload === rc ? "dragging" : ""}`}
        data-row={rc} {...anchor("row", rc)}
        role="button"
        tabIndex={0}
        aria-pressed={isPicked}
        aria-label={placed
          ? `${row.label.replace(/<[^>]*>/g, "")} — placed; activate to return it`
          : `${row.label.replace(/<[^>]*>/g, "")} — activate, then choose a column`}
        {...hp}
        onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; hp.onPointerDown(e); }}
        onClick={(e) => {
          // the pool and the columns are themselves click targets — a chip's
          // click must not also read as "drop the armed item here"
          e.stopPropagation();
          if (moved.current) { moved.current = false; return; }
          if (placed) place(rc, null);
          else setPicked(isPicked ? null : rc);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          activate(() => {
            if (placed) place(rc, null);
            else setPicked(isPicked ? null : rc);
          })(e);
        }}
        dangerouslySetInnerHTML={{ __html: row.label }}
      />
    );
  };

  return (
    <div className="rs-dragmatrix">
      <div className="rs-dragmatrix-progress" data-testid="dragmatrix-progress">
        {placedCount} / {rows.length} placed
      </div>
      <div className={`rs-dragpool ${picked ? "armed" : ""}`}
        data-drop={POOL}
        role="group"
        aria-label="Items still to place"
        onClick={() => { if (picked) place(picked, null); }}>
        {inPool.length === 0
          ? <span className="rs-dragpool-empty">All items placed ✓</span>
          : inPool.map((r) => chip(r, false))}
      </div>
      <div className="rs-dragcols">
        {options.map((o) => {
          const code = String(o.code);
          const mine = rows.filter((r) => String(vals[String(r.code)]) === code);
          return (
            <div key={code}
              className={`rs-dragcol ${picked ? "armed" : ""}`}
              data-drop={code}
              data-code={code} {...anchor("option", code)}
              role="button"
              tabIndex={0}
              aria-label={`Place the chosen item in ${o.label.replace(/<[^>]*>/g, "")}`}
              onClick={() => { if (picked) place(picked, o.code); }}
              onKeyDown={activate(() => { if (picked) place(picked, o.code); })}>
              <div className="rs-dragcol-head" dangerouslySetInnerHTML={{ __html: o.label }} />
              <div className="rs-dragcol-body">
                {mine.length === 0
                  ? <span className="rs-dragcol-empty">drop here</span>
                  : mine.map((r) => chip(r, true))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- Likert Matrix */
/**
 * AN AGREEMENT SCALE THAT LOOKS LIKE ONE.
 *
 * Likert, Rating and Single-Select Matrix were one renderer with three option
 * presets, and both September reviews said so — "all four are displaying
 * essentially the same preview", then "they should have clearly different
 * structures and visual presentation based on their purpose".
 *
 * A Likert grid is a bipolar agreement scale, so it is drawn as one: the
 * columns are the scale, labelled in full across the top, and each cell is a
 * whole tappable band rather than a bare radio dot — graded from the
 * disagree end to the agree end so the direction of the scale is visible
 * before a respondent reads a single word. The answer is still one option
 * code per row, exactly as `matrix_single` has always stored it.
 */
export function LikertMatrix(p: QRProps) {
  const rows = useRows(p);
  const opts = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  if (rows.length === 0) return <NoRows what="Likert grid" />;
  const set = (rc: string, code: string | number) => {
    if (p.q.settings.readOnly) return;
    const next = { ...vals };
    if (String(next[rc]) === String(code)) delete next[rc];
    else next[rc] = code;
    p.onChange(next);
  };
  const answered = rows.filter((r) => vals[String(r.code)] != null).length;
  return (
    <div className="rs-likert" data-testid="likert-matrix">
      <div className="rs-likert-progress">{answered} / {rows.length} answered</div>
      <div className="rs-table-wrap">
        <table className="rs-matrix rs-likert-table">
          <thead>
            <tr>
              <th className="rowlabel" />
              {opts.map((o, i) => (
                <th key={String(o.code)} {...anchor("column", o.code)}
                  className={`rs-likert-head p${Math.round((i / Math.max(1, opts.length - 1)) * 100)}`}>
                  <span dangerouslySetInnerHTML={{ __html: o.label }} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rc = String(row.code);
              return (
                <tr key={rc} {...anchor("row", rc)}>
                  <td className="rowlabel" dangerouslySetInnerHTML={{ __html: row.label }} />
                  {opts.map((o, i) => {
                    const on = String(vals[rc]) === String(o.code);
                    /* 0…100 across the scale — the CSS grades the band from it */
                    const pos = Math.round((i / Math.max(1, opts.length - 1)) * 100);
                    return (
                      <td key={String(o.code)} {...cellAnchor(rc, o.code)} className="rs-likert-cell">
                        <button type="button"
                          className={`rs-likert-band${on ? " on" : ""}`}
                          style={{ ["--p" as string]: String(pos) }}
                          role="radio" aria-checked={on}
                          disabled={p.q.settings.readOnly}
                          aria-label={`${row.label.replace(/<[^>]*>/g, "")}: ${o.label.replace(/<[^>]*>/g, "")}`}
                          onClick={() => set(rc, o.code)}>
                          <span className="rs-likert-dot" aria-hidden="true" />
                          <span className="rs-likert-cap">{o.label.replace(/<[^>]*>/g, "")}</span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- Rating Matrix */
/**
 * A NUMBERED RATING, NOT A COLUMN OF WORDS.
 *
 * "The Preview should clearly look like a rating question rather than a
 * standard Single Select Matrix. The rating range should be configurable
 * where required." The range is the option list — five entries is 1–5, ten
 * is 1–10 — and each point is drawn as a numbered chip with the ends named,
 * so the scale reads as a scale. Still one code per row.
 */
export function RatingMatrix(p: QRProps) {
  const rows = useRows(p);
  const opts = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  if (rows.length === 0) return <NoRows what="rating grid" />;
  const set = (rc: string, code: string | number) => {
    if (p.q.settings.readOnly) return;
    const next = { ...vals };
    if (String(next[rc]) === String(code)) delete next[rc];
    else next[rc] = code;
    p.onChange(next);
  };
  const left = p.q.settings.sliderLeftLabel ?? p.q.settings.npsLeftLabel;
  const right = p.q.settings.sliderRightLabel ?? p.q.settings.npsRightLabel;
  const answered = rows.filter((r) => vals[String(r.code)] != null).length;
  return (
    <div className="rs-ratingmatrix" data-testid="rating-matrix">
      <div className="rs-ratingmatrix-progress">{answered} / {rows.length} rated</div>
      {(left || right) && (
        <div className="rs-ratingmatrix-ends">
          <span>{left ?? ""}</span><span>{right ?? ""}</span>
        </div>
      )}
      {rows.map((row) => {
        const rc = String(row.code);
        return (
          <div key={rc} className="rs-ratingmatrix-row" {...anchor("row", rc)}>
            <span className="rs-ratingmatrix-label" dangerouslySetInnerHTML={{ __html: row.label }} />
            <span className="rs-ratingmatrix-scale" role="radiogroup"
              aria-label={row.label.replace(/<[^>]*>/g, "")}>
              {opts.map((o) => {
                const on = String(vals[rc]) === String(o.code);
                return (
                  <button key={String(o.code)} type="button"
                    className={`rs-ratingmatrix-pt${on ? " on" : ""}`}
                    {...cellAnchor(rc, o.code)}
                    role="radio" aria-checked={on}
                    disabled={p.q.settings.readOnly}
                    aria-label={`${row.label.replace(/<[^>]*>/g, "")}: ${o.label.replace(/<[^>]*>/g, "")}`}
                    onClick={() => set(rc, o.code)}>
                    {o.label.replace(/<[^>]*>/g, "")}
                  </button>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

registerVariantRenderer("starmatrix", StarMatrix);
registerVariantRenderer("summatrix", SumMatrix);
registerVariantRenderer("dragmatrix", DragMatrix);
registerVariantRenderer("likert", LikertMatrix);
registerVariantRenderer("ratingmatrix", RatingMatrix);
