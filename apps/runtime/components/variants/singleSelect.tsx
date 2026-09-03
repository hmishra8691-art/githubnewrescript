"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import type { QRProps } from "../QuestionRenderer";
import { StarRating } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useChoice, activate, colsClass, metaText } from "./shared";

/**
 * Single Select and Multi Select families — the presentations that were
 * "coming soon". All of them store exactly what Radio / Checkbox store
 * (`single_choice` / `multiple_choice`), so logic, piping, exports and the
 * variable dictionary see nothing new. `multi` comes from the variant's
 * response model, so one renderer serves both families.
 *
 * Per-option content beyond the label lives in `option.meta`:
 *   icon          emoji or short text drawn large (Icon Select) — or `imageUrl`
 *   description   secondary line (List, Product, Statement, Cards)
 *   price         right-aligned figure (Product)
 *   badge         small tag (List, Product)
 */

function multiOf(p: QRProps): boolean {
  return p.q.type === "multi_select" || p.q.type === "multi_dropdown" || p.q.type === "image_select";
}

/* ------------------------------------------------------------- Icon Select */
export function IconSelect(p: QRProps) {
  const options = useOptions(p);
  const multi = multiOf(p);
  const { isSelected, pick } = useChoice(p, multi, options);
  return (
    <div className={`rs-icongrid ${colsClass(p, 4)}`} role={multi ? "group" : "radiogroup"}>
      {options.map((o) => {
        const sel = isSelected(o);
        const icon = metaText(o, "icon");
        return (
          <div key={String(o.code)} className={`rs-iconopt ${sel ? "selected" : ""}`}
            role={multi ? "checkbox" : "radio"} aria-checked={sel} tabIndex={0}
            data-code={String(o.code)}
            onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
            <div className="rs-iconopt-icon">
              {o.imageUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={o.imageUrl} alt="" />
                : <span aria-hidden>{icon || "◻"}</span>}
            </div>
            <div className="rs-iconopt-label" dangerouslySetInnerHTML={{ __html: o.label }} />
            <span className="rs-cardopt-check">{sel ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- List Select */
export function ListSelect(p: QRProps) {
  const options = useOptions(p);
  const multi = multiOf(p);
  const { isSelected, pick } = useChoice(p, multi, options);
  return (
    <div className="rs-listrows" role={multi ? "group" : "radiogroup"}>
      {options.map((o) => {
        const sel = isSelected(o);
        const desc = metaText(o, "description");
        const badge = metaText(o, "badge");
        const right = metaText(o, "price") || metaText(o, "value");
        return (
          <div key={String(o.code)} className={`rs-listrow ${sel ? "selected" : ""}`}
            role={multi ? "checkbox" : "radio"} aria-checked={sel} tabIndex={0}
            data-code={String(o.code)}
            onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
            <span className={`rs-listrow-mark ${multi ? "box" : "dot"}`} aria-hidden>{sel ? (multi ? "✓" : "●") : ""}</span>
            {o.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="rs-listrow-img" src={o.imageUrl} alt="" />
            )}
            <div className="rs-listrow-body">
              <div className="rs-listrow-title">
                <span dangerouslySetInnerHTML={{ __html: o.label }} />
                {badge && <span className="rs-badge">{badge}</span>}
              </div>
              {desc && <div className="rs-listrow-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
            </div>
            {right && <div className="rs-listrow-right">{right}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ Heart Rating */
/** Stars with a different glyph — same numeric model, same bounds. */
export function HeartRating(p: QRProps) {
  return (
    <div className="rs-hearts">
      <StarRating {...p} />
    </div>
  );
}

/* ------------------------------------------------- Product / Rich cards */
/**
 * Product Choice, Product Multi-Select and Profile / Product / Statement
 * Cards. Image on top, title, description, a price or badge — and a clear
 * "Select" affordance, because a shopper's card should not need a hover to
 * reveal that it is clickable.
 */
export function RichCards(p: QRProps) {
  const options = useOptions(p);
  const multi = multiOf(p);
  const { isSelected, pick } = useChoice(p, multi, options);
  return (
    <div className={`rs-richcards ${colsClass(p, 3)}`} role={multi ? "group" : "radiogroup"}>
      {options.map((o) => {
        const sel = isSelected(o);
        const desc = metaText(o, "description");
        const price = metaText(o, "price");
        const badge = metaText(o, "badge");
        const subtitle = metaText(o, "subtitle");
        return (
          <div key={String(o.code)} className={`rs-richcard ${sel ? "selected" : ""}`}
            role={multi ? "checkbox" : "radio"} aria-checked={sel} tabIndex={0}
            data-code={String(o.code)}
            onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
            {/* over the image when there is one; inline beside the title when there is not,
                so it never covers the product's name */}
            {badge && o.imageUrl && <span className="rs-badge rs-richcard-badge">{badge}</span>}
            {o.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="rs-richcard-img" src={o.imageUrl} alt="" />
            )}
            <div className="rs-richcard-body">
              <div className="rs-richcard-title">
                <span dangerouslySetInnerHTML={{ __html: o.label }} />
                {badge && !o.imageUrl && <span className="rs-badge" style={{ marginLeft: 8 }}>{badge}</span>}
              </div>
              {subtitle && <div className="rs-richcard-sub" dangerouslySetInnerHTML={{ __html: subtitle }} />}
              {desc && <div className="rs-richcard-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
            </div>
            <div className="rs-richcard-foot">
              {price ? <span className="rs-richcard-price">{price}</span> : <span />}
              <span className={`rs-richcard-select ${sel ? "on" : ""}`}>{sel ? "Selected ✓" : "Select"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------- Statement Choice */
/** Full-width statements; pick the one you agree with. Reads best one per line. */
export function StatementChoice(p: QRProps) {
  const options = useOptions(p);
  const multi = multiOf(p);
  const { isSelected, pick } = useChoice(p, multi, options);
  return (
    <div className="rs-statements" role={multi ? "group" : "radiogroup"}>
      {options.map((o, i) => {
        const sel = isSelected(o);
        return (
          <div key={String(o.code)} className={`rs-statement ${sel ? "selected" : ""}`}
            role={multi ? "checkbox" : "radio"} aria-checked={sel} tabIndex={0}
            data-code={String(o.code)}
            onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
            <span className="rs-statement-n">{String.fromCharCode(65 + (i % 26))}</span>
            <blockquote className="rs-statement-text" dangerouslySetInnerHTML={{ __html: o.label }} />
            <span className="rs-cardopt-check">{sel ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- Pairwise Choice */
/**
 * A vs B. Exactly two options are meaningful; if the list holds more, the
 * first two are shown and the editor lint says so. Stores the winner's code.
 */
export function PairwiseChoice(p: QRProps) {
  const options = useOptions(p);
  const pair = options.slice(0, 2);
  const { isSelected, pick } = useChoice(p, false, options);
  if (pair.length < 2) {
    return <div className="rs-error-msg">A pairwise choice needs two options.</div>;
  }
  const side = (o: Option, which: "a" | "b") => {
    const sel = isSelected(o);
    const desc = metaText(o, "description");
    return (
      <div className={`rs-pair-side ${which} ${sel ? "selected" : ""}`} role="radio" aria-checked={sel} tabIndex={0}
        data-code={String(o.code)}
        onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
        {o.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={o.imageUrl} alt="" />
        )}
        <div className="rs-pair-title" dangerouslySetInnerHTML={{ __html: o.label }} />
        {desc && <div className="rs-pair-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
        <span className={`rs-richcard-select ${sel ? "on" : ""}`}>{sel ? "Chosen ✓" : "Choose"}</span>
      </div>
    );
  };
  return (
    <div className="rs-pair" role="radiogroup">
      {side(pair[0], "a")}
      <div className="rs-pair-or" aria-hidden>or</div>
      {side(pair[1], "b")}
    </div>
  );
}

/* ------------------------------------------------------ Multi-Item Carousel */
/** Browse one card at a time and select as many as you like. */
export function MultiCarousel(p: QRProps) {
  const options = useOptions(p);
  const { vals, isSelected, pick } = useChoice(p, true, options);
  const [idx, setIdx] = React.useState(0);
  if (options.length === 0) return <div className="rs-error-msg">No options.</div>;
  const i = Math.min(idx, options.length - 1);
  const o = options[i];
  const sel = isSelected(o);
  const desc = metaText(o, "description");
  return (
    <div className="rs-carousel" data-multi>
      <div className="rs-carousel-row">
        <button type="button" className="rs-carousel-nav" disabled={i === 0} onClick={() => setIdx(i - 1)} aria-label="Previous">‹</button>
        <div className={`rs-cardopt rs-carousel-card ${sel ? "selected" : ""}`} data-code={String(o.code)} onClick={() => pick(o)}>
          {o.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.imageUrl} alt="" />
          )}
          <div className="rs-cardopt-title" dangerouslySetInnerHTML={{ __html: o.label }} />
          {desc && <div className="rs-cardopt-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
          <span className="rs-cardopt-check">{sel ? "✓" : ""}</span>
        </div>
        <button type="button" className="rs-carousel-nav" disabled={i === options.length - 1} onClick={() => setIdx(i + 1)} aria-label="Next">›</button>
      </div>
      <div className="rs-carousel-foot">
        <span className="rs-carousel-dots">
          {options.map((x, j) => (
            <span key={String(x.code)} className={`dot ${j === i ? "on" : ""} ${isSelected(x) ? "picked" : ""}`} onClick={() => setIdx(j)} />
          ))}
        </span>
        <span className="rs-carousel-count">{vals.length} selected</span>
        <button type="button" className={`rs-btn ${sel ? "" : "secondary"}`} style={{ padding: "8px 20px" }} onClick={() => pick(o)}>
          {sel ? "Selected ✓" : "Select this"}
        </button>
      </div>
    </div>
  );
}

registerVariantRenderer("icons", IconSelect);
registerVariantRenderer("listrows", ListSelect);
registerVariantRenderer("hearts", HeartRating);
registerVariantRenderer("richcards", RichCards);
registerVariantRenderer("statements", StatementChoice);
registerVariantRenderer("pairwise", PairwiseChoice);
registerVariantRenderer("multicarousel", MultiCarousel);
