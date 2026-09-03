"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useRows } from "./shared";

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
          <button key={rc} type="button" className="rs-swipex-chip" data-row={rc}
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
 * A deck where the verdict is a scale rather than a yes/no: the options are
 * laid out as buttons under the card, and the two extremes double as the
 * swipe directions — the fast gesture for "definitely" and "definitely not",
 * a tap for everything in between.
 */
export function SwipeRate(p: QRProps) {
  const options = useOptions(p).slice(0, 5);
  const { rows, current, judged, judge, undo } = useDeck(p);
  const low = options[0];
  const high = options[options.length - 1];

  const { off, dragging, swipeProps } = useSwipe((dx) => {
    if (!current) return;
    if (dx > THRESHOLD && high) judge(String(current.code), high.code);
    else if (dx < -THRESHOLD && low) judge(String(current.code), low.code);
  });

  if (rows.length === 0) return <NoCards testid="swiperate" />;
  if (options.length === 0) {
    return <div className="rs-empty-hint" data-testid="swiperate-empty">Add options — they are the points on the scale.</div>;
  }

  const verdict = off.x > 40 ? high : off.x < -40 ? low : null;
  const scale = (rowCode: string | null) => (
    <div className="rs-swipex-scale" role="group" aria-label="Rating">
      {options.map((o) => (
        <button key={String(o.code)} type="button" className="rs-swipex-step"
          data-code={String(o.code)}
          disabled={rowCode == null}
          aria-label={plain(o.label)}
          onClick={() => rowCode && judge(rowCode, o.code)}>
          <span dangerouslySetInnerHTML={{ __html: o.label }} />
        </button>
      ))}
    </div>
  );

  return (
    <DeckShell testid="swiperate" total={rows.length} count={judged.length + 1}
      canUndo={judged.length > 0} onUndo={undo}
      label={current ? plain(current.label) : null}
      footer={current ? scale(String(current.code)) : <DeckSummary p={p} testid="swiperate" />}>
      {current ? (
        <div className="rs-swipex-stack">
          <div className="rs-swipex-card"
            data-row={String(current.code)}
            {...swipeProps}
            style={{
              ...swipeProps.style,
              transform: `translateX(${off.x}px) rotate(${Math.max(-12, Math.min(12, off.x / 12))}deg)`,
              transition: dragging ? "none" : "transform .18s ease",
            }}>
            <div className="rs-swipex-label" dangerouslySetInnerHTML={{ __html: current.label }} />
            <div className="rs-swipex-ends" aria-hidden>
              <span>← {plain(low.label)}</span>
              <span>{plain(high.label)} →</span>
            </div>
            {verdict && (
              <div className={`rs-swipex-verdict ${off.x > 0 ? "right" : "left"}`}>{plain(verdict.label)}</div>
            )}
          </div>
        </div>
      ) : null}
    </DeckShell>
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
        data-dir={d} data-code={String(o.code)} data-testid={`swipe4-${d}`}
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
            <div className="rs-swipex-card"
              data-row={String(current.code)}
              {...swipeProps}
              style={{
                ...swipeProps.style,
                transform: `translate(${off.x}px, ${off.y}px) rotate(${Math.max(-10, Math.min(10, off.x / 14))}deg)`,
                transition: dragging ? "none" : "transform .18s ease",
              }}>
              <div className="rs-swipex-label" dangerouslySetInnerHTML={{ __html: current.label }} />
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
