"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useRows, useChoice, activate, colsClass, metaText, dropTargetAt } from "./shared";

/**
 * Cards family.
 *
 *   richcards   Profile / Product / Statement Cards — the shared rich-card
 *               grid from the select family (see variants/singleSelect.tsx);
 *               this family only registers the variant, never a second copy.
 *   flipcards   Expandable / Flip Cards: a grid of cards whose front is a
 *               disclosure — open it for the description, price and badge,
 *               then select from the back. Stores one code (single_choice).
 *   cardsort    Sortable / Swipeable Cards: a deck of rows, swiped or tapped
 *               into labelled piles (the options). Stores `{ rowCode:
 *               optionCode }` — the same per-row model as a single-select
 *               matrix, so reporting sees ordinary VAR_<row> values.
 *
 * Per-option content: `meta.description`, `meta.price`, `meta.badge`,
 * `imageUrl` (or `meta.icon` when there is no image).
 */

/* -------------------------------------------------------------- Flip cards */
export function FlipCards(p: QRProps) {
  const options = useOptions(p);
  const { isSelected, pick } = useChoice(p, false, options);
  const [open, setOpen] = React.useState<string | null>(null);

  if (options.length === 0) return <div className="rs-error-msg">No options.</div>;

  // one card open at a time: opening a second closes the first, so the grid
  // never turns into a wall of flipped backs the respondent has to re-read
  const toggle = (code: string) => setOpen((cur) => (cur === code ? null : code));

  return (
    <div className={`rs-flipgrid ${colsClass(p, 3)}`} role="radiogroup">
      {options.map((o) => {
        const code = String(o.code);
        const sel = isSelected(o);
        const flipped = open === code;
        const desc = metaText(o, "description");
        const price = metaText(o, "price");
        const badge = metaText(o, "badge");
        const icon = metaText(o, "icon");
        const plain = o.label.replace(/<[^>]*>/g, "");
        return (
          <div key={code} className={`rs-flipcard ${flipped ? "flipped" : ""} ${sel ? "selected" : ""}`}
            data-code={code} data-flipped={flipped ? "1" : undefined}>
            <div className="rs-flipcard-inner">
              {/* front: a disclosure — click or Enter opens the detail side */}
              <div className="rs-flipface front" role="button" tabIndex={flipped ? -1 : 0}
                aria-expanded={flipped} aria-label={`${plain} — show details`}
                data-testid={`flip-front-${code}`}
                onClick={() => toggle(code)} onKeyDown={activate(() => toggle(code))}>
                {badge && <span className="rs-badge rs-flip-badge">{badge}</span>}
                {o.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="rs-flip-img" src={o.imageUrl} alt="" draggable={false} />
                ) : (
                  <div className="rs-flip-icon" aria-hidden>{icon || "◻"}</div>
                )}
                <div className="rs-flip-title" dangerouslySetInnerHTML={{ __html: o.label }} />
                <div className="rs-flip-foot">
                  <span className={`rs-richcard-select ${sel ? "on" : ""}`}>{sel ? "Selected ✓" : "Details"}</span>
                </div>
              </div>
              {/* back: the detail, and the only place a choice is committed */}
              <div className="rs-flipface back" aria-hidden={!flipped}>
                <div className="rs-flip-title" dangerouslySetInnerHTML={{ __html: o.label }} />
                {desc
                  ? <div className="rs-flip-desc" dangerouslySetInnerHTML={{ __html: desc }} />
                  : <div className="rs-flip-desc rs-judge-hint">No further detail for this option.</div>}
                {(price || badge) && (
                  <div className="rs-flip-meta">
                    {price && <span className="rs-richcard-price">{price}</span>}
                    {badge && <span className="rs-badge">{badge}</span>}
                  </div>
                )}
                <div className="rs-flip-actions">
                  <button type="button" className={`rs-richcard-select ${sel ? "on" : ""}`}
                    role="radio" aria-checked={sel} data-code={code} tabIndex={flipped ? 0 : -1}
                    data-testid={`flip-select-${code}`}
                    onClick={() => { pick(o); setOpen(null); }}>
                    {sel ? "Selected ✓" : "Select"}
                  </button>
                  <button type="button" className="rs-flip-back" tabIndex={flipped ? 0 : -1}
                    data-testid={`flip-back-${code}`}
                    onClick={() => setOpen(null)}>Back</button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- Card sort */
export function CardSort(p: QRProps) {
  const rows = useRows(p);
  const piles = useOptions(p).slice(0, 5);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const [drag, setDrag] = React.useState<{ x: number; active: boolean }>({ x: 0, active: false });
  const [openPile, setOpenPile] = React.useState<string | null>(null);
  const startX = React.useRef(0);

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="cardsort-no-cards">
        This deck has no cards yet — add them in the question’s <strong>Rows</strong>
        {" "}section. Each row is one card; the options are the piles.
      </div>
    );
  }
  if (piles.length < 2) {
    return <div className="rs-error-msg">A card sort needs at least two piles — add them in Options.</div>;
  }

  const remaining = rows.filter((r) => vals[String(r.code)] === undefined);
  const current = remaining[0];
  const done = rows.length - remaining.length;

  const assign = (rowCode: string, pile: string | number) => {
    if (p.q.settings.readOnly) return;
    p.onChange({ ...vals, [rowCode]: pile });
    setDrag({ x: 0, active: false });
  };
  const undo = () => {
    const sorted = rows.filter((r) => vals[String(r.code)] !== undefined);
    const lastCard = sorted[sorted.length - 1];
    if (!lastCard) return;
    const next = { ...vals };
    delete next[String(lastCard.code)];
    p.onChange(next);
  };
  const takeBack = (rowCode: string) => {
    const next = { ...vals };
    delete next[rowCode];
    p.onChange(next);
  };

  /**
   * Pointer swipe: left = first pile, right = second, threshold 80px. A card
   * released ON a pile goes there whatever the direction, so a three-, four-
   * or five-pile sort is still drag-able and not only tappable.
   */
  const leftPile = piles[0];
  const rightPile = piles[1];
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    startX.current = e.clientX;
    setDrag({ x: 0, active: true });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.active) return;
    setDrag({ x: e.clientX - startX.current, active: true });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.active || !current) return;
    const dropped = dropTargetAt(e.clientX, e.clientY);
    const onPile = dropped == null ? undefined : piles.find((o) => String(o.code) === dropped);
    if (onPile) assign(String(current.code), onPile.code);
    else if (drag.x > 80) assign(String(current.code), rightPile.code);
    else if (drag.x < -80) assign(String(current.code), leftPile.code);
    else setDrag({ x: 0, active: false });
  };

  const tilt = Math.max(-14, Math.min(14, drag.x / 10));
  const verdict = drag.x > 40 ? rightPile : drag.x < -40 ? leftPile : null;
  const image = current ? metaText(current, "image") || metaText(current, "imageUrl") : "";
  const desc = current ? metaText(current, "description") : "";

  const cardsIn = (pileCode: string) =>
    rows.filter((r) => String(vals[String(r.code)]) === pileCode);

  return (
    <div className="rs-cardsort">
      <div className="rs-cardsort-head">
        <span data-testid="cardsort-position">
          {current ? `Card ${done + 1} of ${rows.length}` : `All ${rows.length} cards sorted ✓`}
        </span>
        {done > 0 && (
          <button type="button" className="rs-cardsort-undo" data-testid="cardsort-undo"
            onClick={undo}>↩ Undo</button>
        )}
      </div>

      <div className="rs-cardsort-stack">
        {remaining[1] && <div className="rs-cardsort-card behind" aria-hidden />}
        {current ? (
          <div className="rs-cardsort-card" data-row={String(current.code)}
            data-testid="cardsort-card"
            style={{
              transform: `translateX(${drag.x}px) rotate(${tilt}deg)`,
              transition: drag.active ? "none" : "transform .18s ease",
              touchAction: "pan-y",
            }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            {image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" draggable={false} />
            )}
            <div className="rs-cardsort-label" dangerouslySetInnerHTML={{ __html: current.label }} />
            {desc && <div className="rs-cardsort-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
            {verdict && (
              <div className={`rs-cardsort-verdict ${drag.x > 0 ? "right" : "left"}`}>
                {verdict.label.replace(/<[^>]*>/g, "")}
              </div>
            )}
          </div>
        ) : (
          <div className="rs-cardsort-card empty" aria-hidden>Deck empty</div>
        )}
      </div>

      <div className="rs-cardsort-piles" role="group" aria-label="Piles">
        {piles.map((o, k) => {
          const pc = String(o.code);
          const held = cardsIn(pc);
          const expanded = openPile === pc || (!current && held.length > 0);
          return (
            <div key={pc} className={`rs-cardsort-pile ${expanded ? "open" : ""}`} data-drop={pc}>
              <button type="button" className="rs-cardsort-pilebtn"
                data-code={pc} data-testid={`cardsort-pile-${pc}`}
                disabled={!current}
                aria-label={`Put this card in ${o.label.replace(/<[^>]*>/g, "")}`}
                onClick={() => current && assign(String(current.code), o.code)}>
                {k === 0 && <span className="rs-cardsort-dir" aria-hidden>←</span>}
                <span dangerouslySetInnerHTML={{ __html: o.label }} />
                {k === 1 && <span className="rs-cardsort-dir" aria-hidden>→</span>}
              </button>
              <button type="button" className="rs-cardsort-count"
                data-testid={`cardsort-count-${pc}`}
                aria-expanded={expanded} aria-label={`${held.length} cards in ${o.label.replace(/<[^>]*>/g, "")} — show them`}
                onClick={() => setOpenPile(openPile === pc ? null : pc)}>
                {held.length}
              </button>
              {expanded && (
                <ul className="rs-cardsort-held" data-testid={`cardsort-held-${pc}`}>
                  {held.length === 0 && <li className="rs-judge-hint">empty</li>}
                  {held.map((r) => (
                    <li key={String(r.code)}>
                      <button type="button" data-row={String(r.code)}
                        title="take this card back" onClick={() => takeBack(String(r.code))}>
                        <span dangerouslySetInnerHTML={{ __html: r.label }} /> ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

registerVariantRenderer("flipcards", FlipCards);
registerVariantRenderer("cardsort", CardSort);
