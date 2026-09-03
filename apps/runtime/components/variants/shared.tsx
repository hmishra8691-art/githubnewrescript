"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import { effectiveQuestion, toggleMultiValue } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { ctxOf } from "../QuestionRenderer";

/**
 * Helpers shared by the variant families. Everything here is presentation
 * plumbing; response models stay with the base types in the engine.
 */

/** The options as the respondent should see them — logic, masks, sorting, randomization applied. */
export function useOptions(p: QRProps): Option[] {
  return effectiveQuestion(p.q, ctxOf(p)).options;
}

/** Rows (items) as the respondent should see them. */
export function useRows(p: QRProps) {
  return effectiveQuestion(p.q, ctxOf(p)).rows;
}

/** Single- or multi-choice selection state and a toggler, driven by the response model. */
export function useChoice(p: QRProps, multi: boolean, options: Option[]) {
  const vals: (string | number)[] = multi
    ? (Array.isArray(p.value) ? (p.value as (string | number)[]) : p.value == null ? [] : [p.value as string | number])
    : p.value == null ? [] : [p.value as string | number];
  const isSelected = (o: Option) => vals.some((v) => String(v) === String(o.code));
  const pick = (o: Option) => {
    if (p.q.settings.readOnly) return;
    if (multi) p.onChange(toggleMultiValue(vals, o.code, options, p.q.settings.maxSelections));
    else p.onChange(isSelected(o) ? null : o.code);
  };
  return { vals, isSelected, pick };
}

/** Keyboard activation for a clickable non-button element. */
export function activate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/** `settings.columnsLayout` as a grid class suffix, clamped 1–4. */
export function colsClass(p: QRProps, fallback = 1): string {
  const n = p.q.settings.columnsLayout ?? fallback;
  return `cols-${Math.min(Math.max(n, 1), 4)}`;
}

/** Deterministic per-respondent shuffle seed for a question — same as the engine's randomizer scope. */
export function seedFor(p: QRProps, salt = ""): number {
  const s = `${p.state.seed ?? ""}:${p.q.id}:${salt}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text in an option's `meta` bag, HTML allowed (labels already are). */
export function metaText(o: { meta?: Record<string, unknown> }, key: string): string {
  const v = o.meta?.[key];
  return v == null ? "" : String(v);
}

/** Side answers (`<id>__rt`, `<id>__passed`) — stored beside the answer, like `__other`. */
export function sideKey(p: QRProps, suffix: string): string {
  return p.loop ? `${p.q.id}@${p.loop.code}__${suffix}` : `${p.q.id}__${suffix}`;
}
export function setSide(p: QRProps, suffix: string, v: unknown): void {
  (p.state.answers as Record<string, unknown>)[sideKey(p, suffix)] = v;
}
export function getSide<T = unknown>(p: QRProps, suffix: string): T | undefined {
  return (p.state.answers as Record<string, unknown>)[sideKey(p, suffix)] as T | undefined;
}

/** Pointer-drag hook: returns props for a draggable and the current drag position. */
export function usePointerDrag<T>(onDrop: (payload: T, clientX: number, clientY: number) => void) {
  const [drag, setDrag] = React.useState<{ payload: T; x: number; y: number } | null>(null);
  const start = (payload: T) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ payload, x: e.clientX, y: e.clientY });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, x: e.clientX, y: e.clientY });
  };
  const end = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    onDrop(d.payload, e.clientX, e.clientY);
  };
  return { drag, handleProps: (payload: T) => ({ onPointerDown: start(payload), onPointerMove: move, onPointerUp: end, onPointerCancel: () => setDrag(null) }) };
}

/** Which element with `[data-drop]` is under a point — for pointer-drag targets. */
export function dropTargetAt(x: number, y: number, attr = "data-drop"): string | null {
  const el = typeof document === "undefined" ? null : document.elementFromPoint(x, y);
  const hit = el?.closest?.(`[${attr}]`) as HTMLElement | null;
  return hit?.getAttribute(attr) ?? null;
}
