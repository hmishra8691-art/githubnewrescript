"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { SafeImage, MediaEmbed } from "../Media";
import { useOptions, useRows, activate, metaText } from "./shared";

/**
 * Carousel family.
 *
 *   carouseljudge   Judge each carousel item. One card at a time; the input
 *                   under the card is a choice scale, a slider or a comment
 *                   box depending on the BASE TYPE the editor selected
 *                   (matrix_single / matrix_numeric / matrix_text). All three
 *                   store `{ rowCode: value }` — the per-row model — so the
 *                   variant is one presentation over three ordinary matrices
 *                   rather than three near-identical variants.
 *   comparecarousel Two items side by side per slide, ‹ › slides the window by
 *                   one, choosing stores that option's code (single_choice).
 *
 * Per-item content beyond the label lives in `row.meta`: `image`, `description`.
 */

/** A judgement is missing when it is null, undefined or an empty string. */
function unjudged(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

type JudgeMode = "choice" | "slider" | "text";
function judgeMode(p: QRProps): JudgeMode {
  if (p.q.type === "matrix_numeric") return "slider";
  if (p.q.type === "matrix_text") return "text";
  return "choice";
}

/* --------------------------------------------------- Carousel + judgement */
export function CarouselJudge(p: QRProps) {
  const rows = useRows(p);
  const options = useOptions(p);
  const mode = judgeMode(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const [idx, setIdx] = React.useState(0);

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="judge-no-items">
        This carousel has no items yet — add them in the question’s
        <strong> Rows </strong> section. Each row becomes one card.
      </div>
    );
  }

  const i = Math.min(idx, rows.length - 1);
  const row = rows[i];
  const rc = String(row.code);
  const value = vals[rc];
  const judged = rows.filter((r) => !unjudged(vals[String(r.code)])).length;

  /**
   * Commit a judgement and, for the tap-once inputs, move to the next card
   * that still needs one. A slider fires on every step of a drag and a
   * comment on every keystroke, so advancing there would yank the control out
   * from under the respondent — only a choice advances.
   */
  const judge = (v: unknown, advance: boolean) => {
    if (p.q.settings.readOnly) return;
    const next = { ...vals, [rc]: v };
    p.onChange(next);
    if (!advance) return;
    const after = [...rows.slice(i + 1), ...rows.slice(0, i)];
    const nxt = after.find((r) => unjudged(next[String(r.code)]));
    if (nxt) setIdx(rows.indexOf(nxt));
  };

  const min = p.q.settings.minValue ?? 0;
  const max = p.q.settings.maxValue ?? 10;
  const image = metaText(row, "image") || metaText(row, "imageUrl");
  const desc = metaText(row, "description");

  return (
    <div className="rs-carousel rs-judge" data-mode={mode}>
      <div className="rs-carousel-row">
        <button type="button" className="rs-carousel-nav" disabled={i === 0}
          onClick={() => setIdx(i - 1)} aria-label="Previous">‹</button>
        <div className="rs-judge-card" data-row={rc}>
          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <SafeImage className="rs-judge-img" src={image} alt="" draggable={false} />
          )}
          <div className="rs-judge-title" dangerouslySetInnerHTML={{ __html: row.label }} />
          {desc && <div className="rs-judge-desc" dangerouslySetInnerHTML={{ __html: desc }} />}

          {mode === "choice" && (
            <div className="rs-judge-scale" role="radiogroup" aria-label={`Your judgement of ${row.label.replace(/<[^>]*>/g, "")}`}>
              {options.length === 0 && (
                <span className="rs-judge-hint">Add the scale points in the question’s Options section.</span>
              )}
              {options.map((o) => {
                const on = String(value) === String(o.code);
                return (
                  <button key={String(o.code)} type="button"
                    className={`rs-judge-btn ${on ? "on" : ""}`}
                    role="radio" aria-checked={on}
                    data-row={rc} data-code={String(o.code)}
                    onClick={() => judge(on ? null : o.code, !on)}>
                    <span dangerouslySetInnerHTML={{ __html: o.label }} />
                  </button>
                );
              })}
            </div>
          )}

          {mode === "slider" && (
            <div className="rs-judge-slider">
              <span className="rs-judge-end">{p.q.settings.sliderLeftLabel ?? min}</span>
              <input type="range" min={min} max={max} step={p.q.settings.step ?? 1}
                data-row={rc} data-testid={`judge-slider-${rc}`}
                aria-label={`Your rating of ${row.label.replace(/<[^>]*>/g, "")}`}
                value={unjudged(value) ? Math.round((min + max) / 2) : Number(value)}
                onChange={(e) => judge(Number(e.target.value), false)} />
              <span className="rs-judge-end">{p.q.settings.sliderRightLabel ?? max}</span>
              <span className="rs-judge-val" data-row={rc}>{unjudged(value) ? "—" : String(value)}</span>
            </div>
          )}

          {mode === "text" && (
            <textarea className="rs-input rs-judge-text" rows={3}
              data-row={rc} data-testid={`judge-text-${rc}`}
              aria-label={`Your comment on ${row.label.replace(/<[^>]*>/g, "")}`}
              placeholder={p.q.settings.placeholder ?? "Your thoughts on this item…"}
              value={value == null ? "" : String(value)}
              onChange={(e) => judge(e.target.value, false)} />
          )}
        </div>
        <button type="button" className="rs-carousel-nav" disabled={i === rows.length - 1}
          onClick={() => setIdx(i + 1)} aria-label="Next">›</button>
      </div>
      <div className="rs-carousel-foot">
        <span className="rs-carousel-dots">
          {rows.map((r, j) => {
            const done = !unjudged(vals[String(r.code)]);
            return (
              <span key={String(r.code)}
                className={`dot ${j === i ? "on" : ""} ${done ? "picked" : ""}`}
                role="button" tabIndex={0}
                data-row={String(r.code)}
                aria-label={`${r.label.replace(/<[^>]*>/g, "")}${done ? " — judged" : ""}`}
                title={done ? "judged ✓" : "not judged yet"}
                onClick={() => setIdx(j)} onKeyDown={activate(() => setIdx(j))}>
                {done ? <span className="tick" aria-hidden>✓</span> : null}
              </span>
            );
          })}
        </span>
        <span className="rs-carousel-count" data-testid="judge-position">
          Item {i + 1} of {rows.length}
        </span>
        <span className="rs-carousel-count" data-testid="judge-progress">
          {judged} of {rows.length} judged
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ Comparison carousel */
/**
 * A sliding window of two options: [0,1], [1,2], [2,3]… Each ‹ › moves the
 * window by ONE, so every neighbouring pair is seen side by side and the
 * respondent can carry one item forward while the other changes — which is
 * the whole point of comparing in a carousel rather than in a grid.
 */
export function CompareCarousel(p: QRProps) {
  const options = useOptions(p);
  const [start, setStart] = React.useState(0);
  if (options.length < 2) {
    return <div className="rs-error-msg">A comparison carousel needs at least two options.</div>;
  }
  const last = options.length - 2;
  const w = Math.min(start, last);
  const pair = [options[w], options[w + 1]];
  const chosen = options.find((o) => String(o.code) === String(p.value));

  const pick = (code: string | number) => {
    if (p.q.settings.readOnly) return;
    p.onChange(String(p.value) === String(code) ? null : code);
  };

  return (
    <div className="rs-comparecar">
      <div className="rs-comparecar-pick" data-testid="comparecar-pick" aria-live="polite">
        {chosen
          ? <>Your pick: <strong dangerouslySetInnerHTML={{ __html: chosen.label }} /></>
          : <span className="rs-judge-hint">Nothing picked yet — compare the pairs and choose one.</span>}
      </div>
      <div className="rs-carousel-row">
        <button type="button" className="rs-carousel-nav" disabled={w === 0}
          onClick={() => setStart(w - 1)} aria-label="Previous">‹</button>
        <div className="rs-comparecar-pair" role="radiogroup" aria-label="Compare these two">
          {pair.map((o, k) => {
            const sel = String(p.value) === String(o.code);
            const desc = metaText(o, "description");
            const price = metaText(o, "price");
            return (
              <div key={String(o.code)} className={`rs-comparecar-side ${sel ? "selected" : ""}`}
                data-code={String(o.code)} data-side={k === 0 ? "a" : "b"}>
                {o.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <SafeImage src={o.imageUrl} alt="" draggable={false} />
                ) : (
                  <div className="rs-comparecar-noimg" aria-hidden>🖼</div>
                )}
                <div className="rs-comparecar-title" dangerouslySetInnerHTML={{ __html: o.label }} />
                {desc && <div className="rs-comparecar-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
                {price && <div className="rs-comparecar-price">{price}</div>}
                <button type="button" className={`rs-richcard-select ${sel ? "on" : ""}`}
                  role="radio" aria-checked={sel} data-code={String(o.code)}
                  onClick={() => pick(o.code)}>
                  {sel ? "Chosen ✓" : "Choose this"}
                </button>
              </div>
            );
          })}
        </div>
        <button type="button" className="rs-carousel-nav" disabled={w >= last}
          onClick={() => setStart(w + 1)} aria-label="Next">›</button>
      </div>
      <div className="rs-carousel-foot">
        <span className="rs-carousel-dots">
          {options.slice(0, last + 1).map((o, j) => (
            <span key={String(o.code)}
              className={`dot ${j === w ? "on" : ""}`}
              role="button" tabIndex={0}
              aria-label={`Pair ${j + 1}`}
              onClick={() => setStart(j)} onKeyDown={activate(() => setStart(j))} />
          ))}
        </span>
        <span className="rs-carousel-count" data-testid="comparecar-position">
          Pair {w + 1} of {last + 1}
        </span>
      </div>
    </div>
  );
}

registerVariantRenderer("carouseljudge", CarouselJudge);
registerVariantRenderer("comparecarousel", CompareCarousel);
