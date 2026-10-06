"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useRows } from "./shared";
import { anchor } from "../authoring";
import { CardFace, cardFrameClass } from "../CardFace";

/**
 * Swipe / Gesture family — card decks that store an ordinary single-select
 * matrix (`{ rowCode: optionCode }`), so a swiped answer and a tapped grid
 * answer are the same data.
 *
 *   swiperate   one card at a time with a scale of buttons beneath it
 *   swipe4      one card at a time with four directional buckets
 *
 * The existing `SwipeDeck` is hard-wired to two verdicts (like / dislike), so
 * these decks own their gesture handling rather than trying to bend it: the
 * shared part — the drag maths — is small, and the differences (a five-point
 * scale, a vertical axis) are the whole point of the variants.
 */

const plain = (s: string) => s.replace(/<[^>]*>/g, "");
const THRESHOLD = 70;

/* -------------------------------------------------------------- deck state */
function useDeck(p: QRProps) {
  const rows = useRows(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const judged = rows.filter((r) => vals[String(r.code)] !== undefined);
  const remaining = rows.filter((r) => vals[String(r.code)] === undefined);
  const judge = (rowCode: string, optCode: string | number) =>
    p.onChange({ ...vals, [rowCode]: optCode });
  const undo = () => {
    const last = judged[judged.length - 1];
    if (!last) return;
    const next = { ...vals };
    delete next[String(last.code)];
    p.onChange(next);
  };
  return { rows, vals, judged, remaining, current: remaining[0], judge, undo };
}

/**
 * Pointer drag on a card. Kept out of `usePointerDrag` (which reports drops
 * against `[data-drop]` targets) because a swipe has no target — only a
 * direction and a distance.
 */
function useSwipe(onCommit: (dx: number, dy: number) => void) {
  const [off, setOff] = React.useState<{ x: number; y: number } | null>(null);
  const start = React.useRef<{ x: number; y: number } | null>(null);
  const live = React.useRef({ x: 0, y: 0 });
  const stop = () => { start.current = null; live.current = { x: 0, y: 0 }; setOff(null); };
  const swipeProps = {
    style: { touchAction: "none" as const },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      start.current = { x: e.clientX, y: e.clientY };
      live.current = { x: 0, y: 0 };
      setOff({ x: 0, y: 0 });
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return;
      live.current = { x: e.clientX - start.current.x, y: e.clientY - start.current.y };
      setOff(live.current);
    },
    onPointerUp: () => {
      if (!start.current) return;
      const { x, y } = live.current;
      stop();
      onCommit(x, y);
    },
    onPointerCancel: stop,
  };
  return { off: off ?? { x: 0, y: 0 }, dragging: off != null, swipeProps };
}

function DeckShell({
  label, count, total, onUndo, canUndo, children, footer, testid,
}: {
  label: string | null; count: number; total: number;
  onUndo(): void; canUndo: boolean; children: React.ReactNode; footer: React.ReactNode; testid: string;
}) {
  return (
    <div className={`rs-swipex ${testid}`}>
      <div className="rs-swipex-progress" data-testid={`${testid}-progress`}>
        {label == null ? `All ${total} cards judged ✓` : `Card ${count} of ${total}`}
        {canUndo && (
          <button type="button" className="rs-swipex-undo" data-testid={`${testid}-undo`}
            onClick={onUndo} aria-label="Undo the last card">↩ Undo</button>
        )}
      </div>
      {children}
      {footer}
    </div>
  );
}

/** The summary shown once the deck is empty; a chip re-opens that card. */
function DeckSummary({ p, testid }: { p: QRProps; testid: string }) {
  const rows = useRows(p);
  const options = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  return (
    <div className="rs-swipex-summary" data-testid={`${testid}-summary`}>
      {rows.map((r) => {
        const rc = String(r.code);
        const o = options.find((x) => String(x.code) === String(vals[rc]));
        return (
          <button key={rc} type="button" className="rs-swipex-chip" data-row={rc} {...anchor("row", rc)}
            title="Judge this card again"
            onClick={() => { const next = { ...vals }; delete next[rc]; p.onChange(next); }}>
            <span dangerouslySetInnerHTML={{ __html: r.label }} />
            <strong>{o ? plain(o.label) : "?"}</strong>
          </button>
        );
      })}
    </div>
  );
}

function NoCards({ testid }: { testid: string }) {
  return (
    <div className="rs-empty-hint" data-testid={`${testid}-no-cards`}>
      This deck has no cards yet — add them in the question’s <strong>Rows</strong> section.
      Each row becomes one card; the options are the verdicts.
    </div>
  );
}

/* --------------------------------------------------------- Swipe to rate */
/**
 * A deck whose swipe records a RATING, a RANK or a CATEGORY — the review's
 * "Response Type: Rate / Rank / Categorize" (October 2026). The answer is an
 * ordinary single-select matrix in all three (`{ cardCode: code }`):
 *
 *   rate        the options are scale points under the card; the two
 *               extremes double as the swipe directions
 *   categorize  the options are categories, shown as chips under the card;
 *               swipe left / right files it in the first / last
 *   rank        the order cards are swiped right is their rank — swipe right
 *               "this one next", swipe left "not yet" (the card goes to the
 *               back); the stored code is the rank number, 1 for the first
 *
 * The card itself is `CardFace`: image, title, subtitle, description, price
 * and extra fields.
 */
export function SwipeRate(p: QRProps) {
  const mode = p.q.settings.swipeResponse ?? "rate";
  const all = useOptions(p);
  const options = mode === "rate" ? all.slice(0, 5) : all;
  const { rows, vals, judged, judge, undo } = useDeck(p);
  /* rank: "not yet" sends a card to the back — the deck's own order, this page's state */
  const [later, setLater] = React.useState<string[]>([]);
  const remaining = rows.filter((r) => vals[String(r.code)] === undefined)
    .sort((a, b) => later.indexOf(String(a.code)) - later.indexOf(String(b.code)));
  const current = remaining[0];
  const low = options[0];
  const high = options[options.length - 1];
  const nextRank = judged.length + 1;

  const { off, dragging, swipeProps } = useSwipe((dx) => {
    if (!current) return;
    const rc = String(current.code);
    if (mode === "rank") {
      if (dx > THRESHOLD) judge(rc, nextRank);
      else if (dx < -THRESHOLD) setLater((l) => [...l.filter((x) => x !== rc), rc]);
      return;
    }
    if (dx > THRESHOLD && high) judge(rc, high.code);
    else if (dx < -THRESHOLD && low) judge(rc, low.code);
  });

  if (rows.length === 0) return <NoCards testid="swiperate" />;
  if (mode !== "rank" && options.length === 0) {
    return <div className="rs-empty-hint" data-testid="swiperate-empty">
      {mode === "categorize" ? "Add categories — each is a place a card can be filed." : "Add options — they are the points on the scale."}
    </div>;
  }

  const verdict = mode === "rank"
    ? (off.x > 40 ? `#${nextRank}` : off.x < -40 ? "Not yet" : null)
    : (off.x > 40 ? plain(high?.label ?? "") : off.x < -40 ? plain(low?.label ?? "") : null);

  const footer = (rowCode: string | null) => {
    if (mode === "rank") {
      return (
        <div className="rs-swipex-rank" role="group" aria-label="Rank">
          <button type="button" className="rs-swipex-step" data-testid="swiperate-later" disabled={rowCode == null || remaining.length < 2}
            onClick={() => rowCode && setLater((l) => [...l.filter((x) => x !== rowCode), rowCode])}>← Not yet</button>
          <button type="button" className="rs-swipex-step primary" data-testid="swiperate-rank" disabled={rowCode == null}
            onClick={() => rowCode && judge(rowCode, nextRank)}>Rank #{nextRank} →</button>
        </div>
      );
    }
    return (
      <div className={`rs-swipex-scale ${mode === "categorize" ? "categories" : ""}`} role="group" aria-label={mode === "categorize" ? "Category" : "Rating"}>
        {options.map((o) => (
          <button key={String(o.code)} type="button" className="rs-swipex-step"
            data-code={String(o.code)} {...anchor("option", String(o.code))}
            disabled={rowCode == null}
            aria-label={plain(o.label)}
            onClick={() => rowCode && judge(rowCode, o.code)}>
            <span dangerouslySetInnerHTML={{ __html: o.label }} />
          </button>
        ))}
      </div>
    );
  };

  return (
    <DeckShell testid="swiperate" total={rows.length} count={judged.length + 1}
      canUndo={judged.length > 0} onUndo={undo}
      label={current ? plain(current.label) : null}
      footer={current ? footer(String(current.code)) : (mode === "rank" ? <RankSummary p={p} /> : <DeckSummary p={p} testid="swiperate" />)}>
      {current ? (
        <div className="rs-swipex-stack" data-mode={mode}>
          <div className={`rs-swipex-card ${cardFrameClass(p.q.settings, "3:4")}`}
            data-row={String(current.code)} {...anchor("row", String(current.code))}
            {...swipeProps}
            style={{
              ...swipeProps.style,
              transform: `translateX(${off.x}px) rotate(${Math.max(-12, Math.min(12, off.x / 12))}deg)`,
              transition: dragging ? "none" : "transform .18s ease",
            }}>
            <CardFace row={current} settings={p.q.settings} />
            <div className="rs-swipex-ends" aria-hidden>
              <span>← {mode === "rank" ? "Not yet" : plain(low?.label ?? "")}</span>
              <span>{mode === "rank" ? `Rank #${nextRank}` : plain(high?.label ?? "")} →</span>
            </div>
            {verdict && (
              <div className={`rs-swipex-verdict ${off.x > 0 ? "right" : "left"}`}>{verdict}</div>
            )}
          </div>
        </div>
      ) : null}
    </DeckShell>
  );
}

/** Rank mode's summary: the cards in the order they were ranked; a chip re-opens that card (and everything after it). */
function RankSummary({ p }: { p: QRProps }) {
  const rows = useRows(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const ranked = rows.filter((r) => vals[String(r.code)] != null).sort((a, b) => Number(vals[String(a.code)]) - Number(vals[String(b.code)]));
  return (
    <ol className="rs-swipex-summary rs-swipex-ranked" data-testid="swiperate-ranking">
      {ranked.map((r) => {
        const rc = String(r.code);
        const n = Number(vals[rc]);
        return (
          <li key={rc}>
            <button type="button" className="rs-swipex-chip" data-row={rc} {...anchor("row", rc)}
              title="Rank this card and the ones after it again"
              onClick={() => {
                const next = { ...vals };
                for (const x of ranked) if (Number(vals[String(x.code)]) >= n) delete next[String(x.code)];
                p.onChange(next);
              }}>
              <strong>#{n}</strong> <span dangerouslySetInnerHTML={{ __html: r.label }} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------ Four-direction swipe */
type Dir = "left" | "right" | "up" | "down";
const DIRS: Dir[] = ["left", "right", "up", "down"];
const ARROW: Record<Dir, string> = { left: "←", right: "→", up: "↑", down: "↓" };

/** The option each direction commits, from `settings.swipeDirections` with the
 *  option order as the default (first → left, second → right, then up, down). */
export function swipeMapping(
  options: Option[],
  configured: Partial<Record<Dir, string | number>> | undefined,
): Partial<Record<Dir, Option>> {
  const out: Partial<Record<Dir, Option>> = {};
  DIRS.forEach((d, i) => {
    const want = configured?.[d];
    const byCode = want == null ? undefined : options.find((o) => String(o.code) === String(want));
    out[d] = byCode ?? (want == null ? options[i] : undefined);
  });
  return out;
}

export function Swipe4(p: QRProps) {
  const options = useOptions(p);
  const { rows, current, judged, judge, undo } = useDeck(p);
  const map = swipeMapping(options, p.q.settings.swipeDirections);

  const { off, dragging, swipeProps } = useSwipe((dx, dy) => {
    if (!current) return;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const dir: Dir | null = horizontal
      ? dx > THRESHOLD ? "right" : dx < -THRESHOLD ? "left" : null
      : dy > THRESHOLD ? "down" : dy < -THRESHOLD ? "up" : null;
    const o = dir ? map[dir] : undefined;
    if (o) judge(String(current.code), o.code);
  });

  if (rows.length === 0) return <NoCards testid="swipe4" />;
  if (options.length === 0) {
    return <div className="rs-empty-hint" data-testid="swipe4-empty">Add options — up to four become the swipe directions.</div>;
  }

  const activeDir: Dir | null = (() => {
    const horizontal = Math.abs(off.x) >= Math.abs(off.y);
    if (horizontal) return off.x > 40 ? "right" : off.x < -40 ? "left" : null;
    return off.y > 40 ? "down" : off.y < -40 ? "up" : null;
  })();

  const arrow = (d: Dir) => {
    const o = map[d];
    if (!o) return <span className="rs-sw4-arrow empty" aria-hidden />;
    return (
      <button type="button" className={`rs-sw4-arrow ${d} ${activeDir === d ? "active" : ""}`}
        data-dir={d} data-code={String(o.code)} {...anchor("option", String(o.code))} data-testid={`swipe4-${d}`}
        disabled={!current}
        aria-label={`${plain(o.label)} (swipe ${d})`}
        onClick={() => current && judge(String(current.code), o.code)}>
        <span className="rs-sw4-glyph" aria-hidden>{ARROW[d]}</span>
        <span className="rs-sw4-label" dangerouslySetInnerHTML={{ __html: o.label }} />
      </button>
    );
  };

  return (
    <DeckShell testid="swipe4" total={rows.length} count={judged.length + 1}
      canUndo={judged.length > 0} onUndo={undo}
      label={current ? plain(current.label) : null}
      footer={current ? null : <DeckSummary p={p} testid="swipe4" />}>
      {current ? (
        <div className="rs-sw4-grid">
          <div className="rs-sw4-up">{arrow("up")}</div>
          <div className="rs-sw4-left">{arrow("left")}</div>
          <div className="rs-sw4-mid">
            {/*
              * A CARD, NOT A STRIP (October 2026 review): "the swipe area is
              * currently displayed as a long, flat rectangle … The swipe area
              * should use a proper card-shaped container, preferably a
              * portrait or near-square aspect ratio" — 4:5 unless the
              * programmer picks another, centered between the four arrows,
              * and the same size on a phone as on a desktop.
              */}
            <div className={`rs-swipex-card ${cardFrameClass(p.q.settings, "4:5")}`}
              data-testid="swipe4-card"
              data-row={String(current.code)} {...anchor("row", String(current.code))}
              {...swipeProps}
              style={{
                ...swipeProps.style,
                transform: `translate(${off.x}px, ${off.y}px) rotate(${Math.max(-10, Math.min(10, off.x / 14))}deg)`,
                transition: dragging ? "none" : "transform .18s ease",
              }}>
              <CardFace row={current} settings={p.q.settings} />
              {activeDir && map[activeDir] && (
                <div className={`rs-swipex-verdict ${activeDir}`}>{plain(map[activeDir]!.label)}</div>
              )}
            </div>
          </div>
          <div className="rs-sw4-right">{arrow("right")}</div>
          <div className="rs-sw4-down">{arrow("down")}</div>
        </div>
      ) : null}
    </DeckShell>
  );
}

registerVariantRenderer("swiperate", SwipeRate);
registerVariantRenderer("swipe4", Swipe4);
