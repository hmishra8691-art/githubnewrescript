"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, useRows, activate, colsClass, usePointerDrag, dropTargetAt } from "./shared";

/**
 * Drag & Drop family — three ways to answer with a pointer, each storing
 * exactly what an ordinary question of the same shape stores:
 *
 *   dragbuckets    matrix_single   { rowCode: bucketCode }
 *   dragscale      matrix_numeric  { rowCode: number }
 *   chipallocation allocation      { optionCode: number }
 *
 * Every one of them is answerable without a pointer at all: an item can be
 * tapped and then its destination tapped, the scale takes arrow keys, and the
 * chips have + / − buttons. That is not a courtesy — a drag is impossible on a
 * screen reader and unreliable on a cheap touchscreen, and a survey that only
 * works one way loses the respondents who cannot use it.
 */

/* ------------------------------------------------------------ drag plumbing */

/**
 * Pointer drag with a real tap fallback.
 *
 * `usePointerDrag` reports every pointer-up as a drop, so a chip that lives
 * INSIDE a drop zone could never be tapped: the "drop" landed on the chip's
 * own container and the tap never happened. Measuring how far the pointer
 * travelled separates the two gestures — under ~6px is a tap, anything more
 * is a drag.
 */
export function useTapOrDrag<T>(
  onDrop: (payload: T, target: string | null, x: number, y: number) => void,
  onTap: (payload: T) => void,
) {
  const start = React.useRef<{ x: number; y: number } | null>(null);
  const { drag, handleProps } = usePointerDrag<T>((payload, x, y) => {
    const s = start.current;
    start.current = null;
    if (!s || Math.hypot(x - s.x, y - s.y) <= 6) {
      onTap(payload);
      return;
    }
    onDrop(payload, dropTargetAt(x, y), x, y);
  });
  const dragProps = (payload: T) => {
    const hp = handleProps(payload);
    return {
      ...hp,
      onPointerDown: (e: React.PointerEvent) => {
        start.current = { x: e.clientX, y: e.clientY };
        hp.onPointerDown(e);
      },
    };
  };
  return { drag, dragProps };
}

/** The chip that follows the pointer while dragging, so the gesture is visible. */
export function DragGhost({ drag, children }: { drag: { x: number; y: number } | null; children: React.ReactNode }) {
  if (!drag) return null;
  return (
    <div className="rs-dd-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden>
      {children}
    </div>
  );
}

const plain = (s: string) => s.replace(/<[^>]*>/g, "");

/* --------------------------------------------------- Drag into Buckets */
/**
 * Items start in a pool and end up in one of several NAMED areas — a
 * free-form categorisation, deliberately not the drag MATRIX (which is a grid
 * with column headers). Big labelled boxes read as containers you can put
 * something in; a table cell does not.
 */
export function DragBuckets(p: QRProps) {
  const rows = useRows(p);
  const options = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const [held, setHeld] = React.useState<string | null>(null);

  const assign = (rc: string, bucket: string | number | null) => {
    const next = { ...vals };
    if (bucket == null) delete next[rc];
    else next[rc] = bucket;
    p.onChange(next);
  };

  const { drag, dragProps } = useTapOrDrag<string>(
    (rc, target) => {
      setHeld(null);
      if (!target) return;
      if (target === "pool") return assign(rc, null);
      const m = /^bucket-(.*)$/.exec(target);
      if (m) {
        const opt = options.find((o) => String(o.code) === m[1]);
        if (opt) assign(rc, opt.code);
      }
    },
    (rc) => setHeld((h) => (h === rc ? null : rc)),
  );

  const pool = rows.filter((r) => vals[String(r.code)] === undefined);
  const sorted = rows.length - pool.length;
  const heldRow = rows.find((r) => String(r.code) === held);

  if (rows.length === 0 || options.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="dragbuckets-empty">
        This question needs <strong>rows</strong> (the items to sort) and{" "}
        <strong>options</strong> (the buckets to sort them into).
      </div>
    );
  }

  const chip = (rc: string, label: string, inBucket: boolean) => (
    <button
      key={rc}
      type="button"
      className={`rs-dd-chip ${held === rc ? "held" : ""} ${inBucket ? "placed" : ""}`}
      data-row={rc}
      aria-pressed={held === rc}
      {...dragProps(rc)}
      // the pool and the buckets have their own click handlers; a tap on a
      // chip is the chip's business, not its container's
      onClick={(e) => e.stopPropagation()}
      onKeyDown={activate(() => setHeld((h) => (h === rc ? null : rc)))}
    >
      <span className="rs-dd-grip" aria-hidden>⠿</span>
      <span dangerouslySetInnerHTML={{ __html: label }} />
    </button>
  );

  return (
    <div className="rs-dd">
      <div className="rs-dd-status" data-testid="dragbuckets-progress">
        {sorted} / {rows.length} sorted
        {heldRow && <span className="rs-dd-hint"> — now pick a bucket for “{plain(heldRow.label)}”</span>}
      </div>

      <div className="rs-dd-pool" data-drop="pool" role="group" aria-label="Unsorted items"
        onClick={() => { if (held) { assign(held, null); setHeld(null); } }}>
        {pool.length === 0
          ? <span className="rs-dd-empty">All items sorted — drop one here to take it back.</span>
          : pool.map((r) => chip(String(r.code), r.label, false))}
      </div>

      <div className={`rs-dd-buckets ${colsClass(p, 3)}`}>
        {options.map((o) => {
          const code = String(o.code);
          const mine = rows.filter((r) => String(vals[String(r.code)]) === code);
          return (
            <div key={code} className={`rs-dd-bucket ${held ? "armed" : ""}`}
              data-drop={`bucket-${code}`} data-code={code}
              role="button" tabIndex={0}
              aria-label={`Bucket ${plain(o.label)}`}
              onClick={() => { if (held) { assign(held, o.code); setHeld(null); } }}
              onKeyDown={activate(() => { if (held) { assign(held, o.code); setHeld(null); } })}>
              <div className="rs-dd-bucket-head">
                <span dangerouslySetInnerHTML={{ __html: o.label }} />
                <span className="rs-dd-count">{mine.length}</span>
              </div>
              <div className="rs-dd-bucket-body">
                {mine.length === 0
                  ? <span className="rs-dd-empty">drop items here</span>
                  : mine.map((r) => chip(String(r.code), r.label, true))}
              </div>
            </div>
          );
        })}
      </div>
      <DragGhost drag={drag}>{drag ? plain(rows.find((r) => String(r.code) === drag.payload)?.label ?? "") : null}</DragGhost>
    </div>
  );
}

/* --------------------------------------------------------- Drag onto Scale */
/**
 * Position IS the answer: an item dropped 70% along a 0–100 track scores 70.
 * Respondents place items relative to each other far more consistently than
 * they assign absolute numbers, and the stored data is an ordinary numeric
 * matrix, so nothing downstream has to know.
 */
export function DragScale(p: QRProps) {
  const rows = useRows(p);
  const min = p.q.settings.minValue ?? 0;
  const max = p.q.settings.maxValue ?? 100;
  const step = p.q.settings.step && p.q.settings.step > 0 ? p.q.settings.step : 1;
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const trackRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const wantFocus = React.useRef<string | null>(null);
  const [held, setHeld] = React.useState<string | null>(null);

  // How wide the track actually is, because "do these two chips overlap?" is a
  // question in pixels: 20 points apart is comfortable on a laptop and a
  // collision on a phone.
  const [trackW, setTrackW] = React.useState(0);
  React.useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setTrackW(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // after a keyboard placement the chip moves from the pool onto the track;
  // without this the focus is dropped and the next arrow key goes nowhere
  React.useEffect(() => {
    const rc = wantFocus.current;
    if (!rc) return;
    wantFocus.current = null;
    (rootRef.current?.querySelector(`[data-row="${rc}"]`) as HTMLElement | null)?.focus();
  });

  const span = max - min || 1;
  const snap = (v: number) => {
    const s = min + Math.round((v - min) / step) * step;
    return Number(Math.min(max, Math.max(min, s)).toFixed(6));
  };
  const valueAtX = (x: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return snap(min + span / 2);
    return snap(min + Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * span);
  };
  const place = (rc: string, v: number) => p.onChange({ ...vals, [rc]: v });
  const lift = (rc: string) => {
    const next = { ...vals };
    delete next[rc];
    p.onChange(next);
  };

  const { drag, dragProps } = useTapOrDrag<string>(
    (rc, target, x) => {
      setHeld(null);
      if (target === "track") place(rc, valueAtX(x));
      else if (target === "pool") lift(rc);
    },
    (rc) => {
      // a tap on a placed item returns it to the pool; on a pooled item it
      // arms the click-then-click path
      if (numOf(vals[rc]) != null) lift(rc);
      else setHeld((h) => (h === rc ? null : rc));
    },
  );

  const nudge = (rc: string, dir: -1 | 1) => {
    wantFocus.current = rc;
    const cur = numOf(vals[rc]);
    // an item that is not on the scale yet has nothing to nudge — it lands in
    // the middle first, then the arrows move it
    place(rc, cur == null ? snap(min + span / 2) : snap(cur + dir * step));
  };
  const onChipKey = (rc: string) => (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); nudge(rc, -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); nudge(rc, 1); }
    else if (e.key === "Home") { e.preventDefault(); wantFocus.current = rc; place(rc, min); }
    else if (e.key === "End") { e.preventDefault(); wantFocus.current = rc; place(rc, max); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (numOf(vals[rc]) != null) lift(rc);
      else { wantFocus.current = rc; place(rc, snap(min + span / 2)); }
    }
  };

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="dragscale-empty">
        This question needs <strong>rows</strong> — each row is one item to place on the scale.
      </div>
    );
  }

  const placed = rows
    .map((r) => ({ r, v: numOf(vals[String(r.code)]) }))
    .filter((x): x is { r: typeof rows[number]; v: number } => x.v != null)
    .map((x) => ({ ...x, pct: ((x.v - min) / span) * 100 }))
    .sort((a, b) => a.pct - b.pct);

  // items closer together than a chip is wide would sit on top of each other,
  // so they stack into lanes instead of hiding one another
  const gapPct = trackW > 0 ? Math.min(45, Math.max(8, (120 / trackW) * 100)) : 12;
  const lanes: number[][] = [];
  const laneOf = new Map<string, number>();
  for (const item of placed) {
    let lane = 0;
    while ((lanes[lane] ?? []).some((other) => Math.abs(other - item.pct) < gapPct)) lane++;
    (lanes[lane] ??= []).push(item.pct);
    laneOf.set(String(item.r.code), lane);
  }
  const pool = rows.filter((r) => numOf(vals[String(r.code)]) == null);
  const ticks = Array.from({ length: 11 }, (_, i) => i * 10);

  return (
    <div className="rs-dd rs-ds" ref={rootRef}>
      <div className="rs-dd-status" data-testid="dragscale-progress">
        {placed.length} / {rows.length} placed
      </div>

      <div className="rs-ds-zone" data-drop="track">
        <div className="rs-ds-placed" style={{ height: Math.max(1, lanes.length) * 34 + 6 }}>
          {placed.map((x) => {
            const rc = String(x.r.code);
            return (
              <button key={rc} type="button"
                className="rs-dd-chip on-scale"
                data-row={rc} data-value={x.v}
                aria-label={`${plain(x.r.label)}: ${x.v}. Arrow keys to move, Enter to remove.`}
                style={{
                  left: `${x.pct}%`,
                  bottom: (laneOf.get(rc) ?? 0) * 34,
                  // centred on its value, except at the ends, where a centred
                  // chip would hang off the card
                  transform: x.pct < 15 ? "translateX(0)" : x.pct > 85 ? "translateX(-100%)" : "translateX(-50%)",
                }}
                {...dragProps(rc)}
                onKeyDown={onChipKey(rc)}>
                <span dangerouslySetInnerHTML={{ __html: x.r.label }} />
                <span className="rs-ds-val">{x.v}</span>
              </button>
            );
          })}
        </div>
        <div className="rs-ds-track" ref={trackRef}
          onClick={(e) => {
            if (!held) return;
            place(held, valueAtX(e.clientX));
            setHeld(null);
          }}>
          {ticks.map((t) => <span key={t} className={`rs-ds-tick ${t % 50 === 0 ? "major" : ""}`} style={{ left: `${t}%` }} />)}
          {placed.map((x) => (
            <span key={String(x.r.code)} className="rs-ds-marker" style={{ left: `${x.pct}%` }} aria-hidden />
          ))}
        </div>
        <div className="rs-ds-ends">
          <span>{p.q.settings.sliderLeftLabel ?? min}</span>
          <span>{p.q.settings.sliderRightLabel ?? max}</span>
        </div>
      </div>

      <div className="rs-dd-pool" data-drop="pool" role="group" aria-label="Items not yet placed"
        onClick={() => { if (held && numOf(vals[held]) != null) { lift(held); setHeld(null); } }}>
        {pool.length === 0
          ? <span className="rs-dd-empty">All items placed — drag one back here to undo.</span>
          : pool.map((r) => {
            const rc = String(r.code);
            return (
              <button key={rc} type="button"
                className={`rs-dd-chip ${held === rc ? "held" : ""}`}
                data-row={rc} aria-pressed={held === rc}
                aria-label={`${plain(r.label)}: not placed. Arrow keys to place on the scale.`}
                {...dragProps(rc)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={onChipKey(rc)}>
                <span className="rs-dd-grip" aria-hidden>⠿</span>
                <span dangerouslySetInnerHTML={{ __html: r.label }} />
              </button>
            );
          })}
      </div>
      <DragGhost drag={drag}>{drag ? plain(rows.find((r) => String(r.code) === drag.payload)?.label ?? "") : null}</DragGhost>
    </div>
  );
}

function numOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------- Chip / drag allocation */
/**
 * A constant sum a respondent cannot get wrong: the chips in the pool ARE the
 * budget, so the total is right by construction instead of being scolded into
 * place by a validator. Stored as an ordinary allocation — chips × chipValue —
 * so the existing sum rules still apply to hand-authored data.
 */
type ChipPayload = { from: string | null };

export function ChipAllocation(p: QRProps) {
  const options = useOptions(p);
  const target = p.q.settings.sumTarget ?? 100;
  const chipValue = p.q.settings.chipValue && p.q.settings.chipValue > 0 ? p.q.settings.chipValue : 10;
  const unit = p.q.settings.sumUnit ?? "";
  const totalChips = Math.max(1, Math.round(target / chipValue));
  const vals = (p.value ?? {}) as Record<string, unknown>;

  const chipsOf = (code: string) => Math.max(0, Math.round((numOf(vals[code]) ?? 0) / chipValue));
  const used = options.reduce((a, o) => a + chipsOf(String(o.code)), 0);
  const left = Math.max(0, totalChips - used);
  const amount = (chips: number) => Number((chips * chipValue).toFixed(6));

  const setChips = (patch: Record<string, number>) => {
    const next = { ...vals };
    for (const [code, chips] of Object.entries(patch)) {
      if (chips <= 0) delete next[code];
      else next[code] = amount(chips);
    }
    p.onChange(next);
  };
  const add = (code: string, n: number) => {
    const cur = chipsOf(code);
    const room = n > 0 ? Math.min(n, left) : Math.max(n, -cur);
    if (room === 0) return;
    setChips({ [code]: cur + room });
  };
  const move = (from: string, to: string) => {
    if (from === to || chipsOf(from) === 0) return;
    setChips({ [from]: chipsOf(from) - 1, [to]: chipsOf(to) + 1 });
  };

  const { drag, dragProps } = useTapOrDrag<ChipPayload>(
    (payload, targetKey) => {
      if (!targetKey) return;
      const m = /^item-(.*)$/.exec(targetKey);
      if (m) {
        const opt = options.find((o) => String(o.code) === m[1]);
        if (!opt) return;
        if (payload.from == null) add(String(opt.code), 1);
        else move(payload.from, String(opt.code));
      } else if (targetKey === "pool" && payload.from != null) {
        add(payload.from, -1);
      }
    },
    // taps on a chip are deliberately inert: + and − are the accessible path
    // and a chip that vanished when brushed would be maddening
    () => {},
  );

  if (options.length === 0) {
    return <div className="rs-empty-hint" data-testid="chipalloc-empty">Add options — each one is something to allocate to.</div>;
  }

  const total = used * chipValue;
  return (
    <div className="rs-dd rs-ca">
      <div className={`rs-ca-status ${total === target ? "ok" : "bad"}`} data-testid="chipalloc-total">
        {Number(total.toFixed(6))} / {target}{unit} allocated
        <span className="rs-dd-hint"> — {left} chip{left === 1 ? "" : "s"} left, {Number(chipValue.toFixed(6))}{unit} each</span>
      </div>

      <div className="rs-ca-pool" data-drop="pool" role="group" aria-label="Chips left to allocate">
        {left === 0
          ? <span className="rs-dd-empty">No chips left — drag one back here or press −.</span>
          : Array.from({ length: left }, (_, i) => (
            <span key={i} className="rs-ca-chip" data-testid="chipalloc-poolchip" {...dragProps({ from: null })} aria-hidden />
          ))}
      </div>

      <div className="rs-ca-items">
        {options.map((o) => {
          const code = String(o.code);
          const n = chipsOf(code);
          return (
            <div key={code} className={`rs-ca-item ${n > 0 ? "filled" : ""}`} data-drop={`item-${code}`} data-code={code}>
              <div className="rs-ca-item-head">
                <span className="rs-ca-item-label" dangerouslySetInnerHTML={{ __html: o.label }} />
                <span className="rs-ca-item-val" data-testid={`chipalloc-value-${code}`}>
                  {Number(amount(n).toFixed(6))}{unit}
                </span>
              </div>
              <div className="rs-ca-item-body">
                <button type="button" className="rs-ca-btn" data-testid={`chipalloc-minus-${code}`}
                  disabled={n === 0} aria-label={`Remove one chip from ${plain(o.label)}`}
                  onClick={() => add(code, -1)}>−</button>
                <div className="rs-ca-holds">
                  {n === 0
                    ? <span className="rs-dd-empty">drop chips here</span>
                    : Array.from({ length: n }, (_, i) => (
                      <span key={i} className="rs-ca-chip on" {...dragProps({ from: code })} aria-hidden />
                    ))}
                </div>
                <button type="button" className="rs-ca-btn" data-testid={`chipalloc-plus-${code}`}
                  disabled={left === 0} aria-label={`Add one chip to ${plain(o.label)}`}
                  onClick={() => add(code, 1)}>+</button>
              </div>
            </div>
          );
        })}
      </div>
      <DragGhost drag={drag}><span className="rs-ca-chip on" /></DragGhost>
    </div>
  );
}

registerVariantRenderer("dragbuckets", DragBuckets);
registerVariantRenderer("dragscale", DragScale);
registerVariantRenderer("chipallocation", ChipAllocation);
