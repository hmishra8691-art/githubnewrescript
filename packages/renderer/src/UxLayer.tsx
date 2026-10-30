"use client";
import * as React from "react";
import type { SurveyDefinition, UxBehavior, UxEffect, UxTarget } from "@rescript/schema";
import {
  UX_PRESET_FRAMES, checkDeclarations, compileUxCss, evaluateUxTriggers, resolveUxTarget, uxAnimationNeedsRuntime,
  uxPlayToken, uxSelector, uxToken, uxAnswered, uxSelectedCodes, defaultUxLookups, validateUxScript, UX_SCRIPT_EVENT_ALIASES,
  uxGuardHolds, createResponseState, guardScriptLoops, popupUiFor, type ResponseState, type ScriptWrite,
  codeGate, gateReason, isComponentBehavior,
} from "@rescript/engine";
import { DomBridge, answerLockReason, HIDING_STYLE } from "./uxDom";
import { uxSandboxDoc } from "./uxSandbox";
import { closeUxPopups, openUxPopup, placeUxPopups } from "./uxPopup";

/**
 * THE UX LAYER — the runtime half of the survey's styles, animations and
 * behaviours (engine `ux.ts` is the other half).
 *
 * Mounted inside the survey shell, it
 *   · injects the compiled, scoped stylesheet;
 *   · marks answered questions (`data-rs-ux-answered`), numbers staggered
 *     elements (`--rs-ux-i`) and replays page-level animations on each page;
 *   · runs declarative behaviours: the engine decides which fire, hold or are
 *     released (`evaluateUxTriggers`), this applies their effects to the
 *     survey's own elements and reverts held ones;
 *   · runs each script behaviour in a SANDBOXED FRAME — an opaque origin
 *     (`sandbox="allow-scripts"`, no same-origin) with a CSP that forbids
 *     every network request — that can only post `rs` commands back. The
 *     frame cannot read the page, its cookies, storage, the Studio's session
 *     or any API; every command it sends is checked here (target resolved
 *     against the survey, styles through the engine's CSS gate, class names
 *     namespaced, text inserted as text) and rate-limited.
 *
 * Everything it changes is outside React's own attributes — tokens in
 * `data-rs-ux-on`, inline custom properties, appended message nodes — so a
 * re-render of the question never erases it, and it never erases a
 * re-render.
 */

export interface UxLayerProps {
  def: SurveyDefinition;
  /** the survey shell (carries data-rs-ux / data-rs-block / data-rs-page) */
  rootRef: React.RefObject<HTMLElement | null>;
  /** answers on the current page, by question id */
  values: Record<string, unknown>;
  /** every answer so far, by question id (scripts' getAnswer) */
  allValues?: Record<string, unknown>;
  /** the response so far — what a behaviour's `when` is read against (embedded data and calculations included) */
  state?: ResponseState | null;
  /** the questions on the page, in order */
  shown: string[];
  /** changes whenever the page (or loop iteration) changes */
  pageKey: string;
  blockId?: string;
  pageId?: string;
  pageIndex?: number;
  onLog?: (line: string) => void;
  /** drawn inside another page (the Studio's preview): what scripts add to the body stays in the shell */
  contained?: boolean;
  /** #14c (2026-10-22): the respondent's language — the popup's close label and direction follow it (absent: the shell's data-language, else the survey's source language) */
  language?: string | null;
  /**
   * SECTION NAVIGATION (2026-10-30): `rs.goToPage` / `rs.goToSection` arrive
   * here as commands and the HOST decides — the Runner runs the engine's
   * `goToPage` with the survey's own rule. Absent (the Studio canvas), a
   * script's navigation is reported as unavailable, never silently dropped.
   */
  onNavigate?: (target: string, as: "page" | "section") => { ok: boolean; reason?: string };
  /**
   * S1a — THE WRITE CHANNEL: `rs.setAnswer` / `rs.setEmbedded` / `rs.setCalc` / `rs.flag` arrive here as
   * REQUESTS and the host decides with the engine (`applyScriptWrite`), like `onNavigate`. The answer goes back to
   * the frame as the promise's `{ ok, reason }`; a refusal is logged to the script's console with the reason.
   * Absent (the Studio canvas), every write is refused as unavailable — never silently dropped.
   */
  onScriptWrite?: (write: ScriptWrite, script: { id: string; label: string; target: UxTarget }) => { ok: boolean; reason?: string };
  /**
   * S1a — THE PAGE LIFECYCLE: the layer puts here a function the Runner calls on Next to run the scripts'
   * `rs.listen("validate")` / `rs.listen("submit")` handlers. It asks every frame of the page that listens for the
   * event and resolves with what each answered — or `timedOut` for a frame that did not answer within `timeoutMs`.
   */
  lifecycleRef?: React.MutableRefObject<UxAskFrames | null>;
  /**
   * S1c (D11 / SE-30) — LIVE SCRIPT HEALTH: every failure of a script on this page (its error, a gate refusal, a
   * component that could not run, a refused write or navigation, a watchdog stop), structured, for the Runner's
   * session collector. Called in every mode, unlike `onLog`.
   */
  onScriptIssue?: (issue: UxScriptIssue) => void;
  /**
   * S2c — THE TEST SESSION'S TRACE (the Studio's verification harness; absent in the survey): every script frame's
   * start, each effect the host applied (op, target, how many elements it reached), each mirror op, each refusal,
   * error and rs.log line — so a proposal's script can be judged by what it actually did.
   */
  onTrace?: (t: UxTrace) => void;
}

/** S2c: one event of a script frame, as the test session records it */
export type UxTrace =
  | { script: string; name: string; kind: "ready" }
  | { script: string; name: string; kind: "effect"; op: string; target: UxTarget; detail?: string; count: number }
  | { script: string; name: string; kind: "dom"; op: string; el: Element | null }
  | { script: string; name: string; kind: "refused" | "error" | "log"; text: string; line?: number };

/** S1c: one script failure as the layer reports it (kind: engine SCRIPT_HEALTH_KINDS) */
export interface UxScriptIssue { script: string; name: string; kind: "ux_error" | "component_not_run" | "gate_refused" | "write_refused" | "navigation_refused" | "watchdog"; message: string }

/** S1a: one frame's answer to a lifecycle event (see `lifecycleRef`) */
export interface UxFrameAnswer { script: string; /** S1c: the behaviour's id */ id?: string; errors?: { message: string; ref?: string | null }[]; timedOut?: boolean }
export type UxAskFrames = (ev: "validate" | "submit", timeoutMs: number) => Promise<UxFrameAnswer[]>;

/** the popup words of each mounted shell (set by its UxLayer) — read when a popup opens in it */
const popupLabels = new WeakMap<HTMLElement, { close: string; message: string; dir: "ltr" | "rtl" }>();

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** the elements a target names, inside this survey's shell only */
export function uxElements(root: HTMLElement, t: UxTarget, opts: { content?: boolean } = {}): HTMLElement[] {
  const s = uxSelector(t, { content: opts.content });
  if (s.root && !root.matches(s.root.replace(/:hover|:focus-within/g, ""))) return [];
  if (!s.inner) return [root];
  try { return [...root.querySelectorAll<HTMLElement>(s.inner)]; } catch { return []; }
}

interface Undo { run(): void }
/** the inline properties the UX layer set on each element — so clearing them never touches React's own */
const setByUx = new WeakMap<HTMLElement, Set<string>>();
/** apply one effect; returns how to revert it (for held conditions) */
function applyEffect(root: HTMLElement, def: SurveyDefinition, owner: UxTarget, e: UxEffect, ownerId: string): Undo[] {
  const t = e.target ?? owner;
  /*
   * THE SURVEY'S POPUP: one per behaviour (or script), whatever the target matches. Its close is the
   * undo, so a held condition (select_option…) closes it when it stops holding, and a page change
   * closes it with everything else the page held.
   */
  if (e.do === "show_popup") {
    if (!e.text) return [];
    const anchor = e.placement === "anchored" || e.placement === "inline" ? uxElements(root, t)[0] ?? null : null;
    const labels = popupLabels.get(root) ?? popupUiFor(def, root.getAttribute("data-language"));
    return [{ run: openUxPopup({ root, owner: ownerId, anchor, effect: e, labels }) }];
  }
  if (e.do === "hide_popup") { closeUxPopups(root); return []; }
  const content = e.do === "animate" && ["survey", "block", "page"].includes(t.kind);
  const els = uxElements(root, t, { content });
  const undo: Undo[] = [];
  for (const el of els) {
    switch (e.do) {
      case "add_class": case "remove_class": case "toggle_class": {
        const tok = uxToken(e.className ?? "on");
        const has = (el.getAttribute("data-rs-ux-on") ?? "").split(/\s+/).filter(Boolean);
        const on = e.do === "add_class" ? true : e.do === "remove_class" ? false : !has.includes(tok);
        const next = on ? [...new Set([...has, tok])] : has.filter((x) => x !== tok);
        el.setAttribute("data-rs-ux-on", next.join(" "));
        if (on !== has.includes(tok)) undo.push({ run: () => { const cur = (el.getAttribute("data-rs-ux-on") ?? "").split(/\s+/).filter(Boolean); el.setAttribute("data-rs-ux-on", (on ? cur.filter((x) => x !== tok) : [...cur, tok]).join(" ")); } });
        break;
      }
      case "animate": {
        if (reducedMotion() || typeof el.animate !== "function") break;
        const frames = UX_PRESET_FRAMES[e.preset ?? "pulse"];
        if (frames) el.animate(frames as Keyframe[], { duration: e.durationMs ?? 450, easing: "ease-out" });
        break;
      }
      case "set_style": {
        const c = checkDeclarations(e.style ?? {}, { target: t });
        const prev: [string, string, string][] = [];
        for (const [k, v] of Object.entries(c.ok)) {
          prev.push([k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
          const important = /!important\s*$/i.test(v);
          el.style.setProperty(k, v.replace(/!important\s*$/i, "").trim(), important ? "important" : "");
          const mine = setByUx.get(el) ?? new Set<string>(); mine.add(k); setByUx.set(el, mine);
        }
        undo.push({ run: () => { for (const [k, v, p] of prev) if (v) el.style.setProperty(k, v, p); else el.style.removeProperty(k); } });
        break;
      }
      case "show": if (el.hasAttribute("data-rs-ux-hidden")) { el.removeAttribute("data-rs-ux-hidden"); undo.push({ run: () => el.setAttribute("data-rs-ux-hidden", "") }); } break;
      case "hide": if (!el.hasAttribute("data-rs-ux-hidden")) { el.setAttribute("data-rs-ux-hidden", ""); undo.push({ run: () => el.removeAttribute("data-rs-ux-hidden") }); } break;
      case "show_message": {
        const key = `${ownerId}`;
        let m = el.querySelector<HTMLElement>(`:scope > [data-rs-ux-msg="${CSS.escape(key)}"]`);
        if (!m) {
          m = document.createElement("div");
          m.className = "rs-ux-message";
          m.setAttribute("data-rs-ux-msg", key);
          m.setAttribute("role", "status");
          m.setAttribute("aria-live", "polite");
          el.appendChild(m);
        }
        m.textContent = e.text ?? "";
        if (!reducedMotion() && typeof m.animate === "function") m.animate((UX_PRESET_FRAMES[e.preset ?? "fade-up"] ?? UX_PRESET_FRAMES["fade-up"]) as Keyframe[], { duration: e.durationMs ?? 320, easing: "ease-out" });
        const node = m;
        undo.push({ run: () => node.remove() });
        break;
      }
      case "hide_message": for (const m of el.querySelectorAll(":scope > [data-rs-ux-msg]")) m.remove(); break;
      case "scroll_into_view": el.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" }); break;
      case "focus": { const f = el.matches("input,select,textarea,button,[tabindex]") ? el : el.querySelector<HTMLElement>("input,select,textarea,button,[tabindex]"); f?.focus({ preventScroll: false }); break; }
    }
  }
  return undo;
}

/* ------------------------------------------------------------ the sandbox */

const SANDBOX_DOC = uxSandboxDoc({ aliases: UX_SCRIPT_EVENT_ALIASES });
const COMMANDS_PER_SECOND = 200;
/** how long a frame outlives its page, so a click on Next that was already sent to it is handled once */
const SCRIPT_GRACE_MS = 150;
/** D8: the host pings each frame this often; a frame that misses HEARTBEAT_MISSES in a row while the page is shown is stopped */
const HEARTBEAT_MS = 2000;
const HEARTBEAT_MISSES = 3;
/**
 * pages that are closing but not yet undone. A new page's script must start from
 * the survey as it is, not from the previous page's script's changes (two pages'
 * scripts often touch the same element — the body, the Next button), so the new
 * frame's first act is to finish whatever the old ones were still holding.
 */
const closing = new Set<() => void>();

interface ScriptHost { frame: HTMLIFrameElement; behavior: UxBehavior; listens: { ev: string; target: string }[]; undo: Undo[]; dom: DomBridge; started: boolean; dispose(): void; close(): void; /** S1a: lifecycle requests waiting for the frame's answer */ waiting: Map<number, (errors: UxFrameAnswer["errors"]) => void> }
let lifecycleN = 0;

function plainText(s: string) { return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

/* ------------------------------------------------------------ the component */

export function UxLayer(p: UxLayerProps) {
  const { def } = p;
  /* the definition object may be rebuilt on every render; what matters is whether its UX changed */
  const uxSig = `${def.meta.id}|${JSON.stringify(def.ux ?? null)}`;
  const defRef = React.useRef(def);
  defRef.current = def;
  const prevValues = React.useRef<Record<string, unknown> | null>(null);
  const lastPage = React.useRef<string | null>(null);
  const active = React.useRef(new Map<string, Undo[]>());
  const fired = React.useRef(new Set<string>());
  const scripts = React.useRef<ScriptHost[]>([]);
  const log = React.useRef(p.onLog);
  log.current = p.onLog;
  const issueRef = React.useRef(p.onScriptIssue);
  issueRef.current = p.onScriptIssue;
  const traceRef = React.useRef(p.onTrace);
  traceRef.current = p.onTrace;
  const navigate = React.useRef(p.onNavigate);
  navigate.current = p.onNavigate;
  const writeRef = React.useRef(p.onScriptWrite);
  writeRef.current = p.onScriptWrite;
  const behaviors = def.ux?.behaviors ?? [];
  const animations = def.ux?.animations ?? [];

  const byCode = React.useMemo(() => new Map(def.questions.map((q) => [q.id, String(q.code)])), [def.questions]);
  /*
   * #14c THE POPUP'S OWN WORDS in the respondent's language (the close button's label, the name of a popup with no
   * title) and its direction — kept for the shell, read when a popup opens. Set during render so the first popup of
   * a page already has them.
   */
  {
    const root = p.rootRef.current;
    const lang = p.language ?? root?.getAttribute("data-language") ?? null;
    if (root) popupLabels.set(root, popupUiFor(def, lang));
  }
  /* without a response state (the Studio's UX preview), the answers on hand are the whole response */
  const stateFromValues = (): ResponseState => ({ ...createResponseState(def, { seed: 1, sessionId: "ux" }), answers: { ...(p.allValues ?? {}), ...p.values } as ResponseState["answers"] });
  const stateRef = React.useRef<() => ResponseState>(stateFromValues);
  stateRef.current = () => p.state ?? stateFromValues();
  /*
   * CONDITIONAL STYLES AND ANIMATIONS: one that has a `when` is in the
   * stylesheet only while it holds. Which ones hold is part of the memo key,
   * so the sheet is rebuilt exactly when an answer flips one of them.
   */
  const guarded = [...(def.ux?.styles ?? []), ...(def.ux?.animations ?? [])].filter((x) => x.when);
  const liveState = guarded.length ? (p.state ?? stateFromValues()) : null;
  const guardSig = guarded.map((x) => (uxGuardHolds(def, x, liveState, p.values) ? "1" : "0")).join("");
  const css = React.useMemo(
    () => compileUxCss(def, guarded.length ? { state: liveState, now: p.values } : undefined),
    [uxSig, guardSig], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const answersByCode = React.useCallback(() => {
    const out: Record<string, unknown> = {};
    const all = { ...(p.allValues ?? {}), ...p.values };
    for (const [id, v] of Object.entries(all)) { const c = byCode.get(id); if (c) out[c] = v; }
    return out;
  }, [p.allValues, p.values, byCode]);
  /*
   * S1a: what a script reads besides the page's answers — every LOOP iteration's answer by `CODE@item` (for
   * `rs.getAnswer(code, loopKey)`), and the embedded data and calculated variables (`rs.getEmbedded`, `rs.getCalc`).
   */
  const readsFor = (): { byKey: Record<string, unknown>; vars: { embedded: Record<string, unknown>; calculated: Record<string, unknown> } } => {
    const st = p.state;
    const byKey: Record<string, unknown> = {};
    if (st) for (const [k, v] of Object.entries(st.answers)) {
      const at = k.indexOf("@");
      if (at < 0 || k.includes("__")) continue;
      const c = byCode.get(k.slice(0, at));
      if (c) byKey[`${c}${k.slice(at)}`] = v;
    }
    return { byKey, vars: { embedded: { ...(st?.embedded ?? {}) }, calculated: { ...(st?.calculated ?? {}) } } };
  };
  const readsRef = React.useRef(readsFor);
  readsRef.current = readsFor;

  /* every render: answered marks, triggers */
  React.useEffect(() => {
    const root = p.rootRef.current;
    if (!root) return;
    const pageChanged = lastPage.current !== p.pageKey;
    if (pageChanged) {
      // a new page: held effects of the old one go with it — and every popup (one opened by a momentary event has no undo)
      for (const undo of active.current.values()) for (const u of undo) u.run();
      active.current.clear();
      closeUxPopups(root);
      prevValues.current = null;
      lastPage.current = p.pageKey;
    }
    for (const card of root.querySelectorAll<HTMLElement>('[data-rs-el="question"][data-rs-id]')) {
      const id = card.getAttribute("data-rs-id")!;
      if (uxAnswered(p.values[id])) card.setAttribute("data-rs-ux-answered", ""); else card.removeAttribute("data-rs-ux-answered");
    }
    if (pageChanged) {
      for (const a of animations) {
        if (a.staggerMs) uxElements(root, a.target).forEach((el, i) => el.style.setProperty("--rs-ux-i", String(i)));
        if (uxAnimationNeedsRuntime(a)) {
          const tok = uxPlayToken(a.id);
          const content = ["survey", "block", "page"].includes(a.target.kind);
          for (const el of uxElements(root, a.target, { content })) {
            const cur = (el.getAttribute("data-rs-ux-play") ?? "").split(/\s+/).filter((x) => x && x !== tok);
            el.setAttribute("data-rs-ux-play", cur.join(" "));
            void el.offsetWidth; // restart the animation
            el.setAttribute("data-rs-ux-play", [...cur, tok].join(" "));
          }
        }
      }
    }
    if (behaviors.length) {
      const r = evaluateUxTriggers({ def, prev: prevValues.current, now: p.values, shown: p.shown, blockId: p.blockId, active: new Set(active.current.keys()), fired: fired.current, state: p.state ?? stateFromValues() });
      for (const b of r.release) { for (const u of active.current.get(b.id) ?? []) u.run(); active.current.delete(b.id); }
      for (const b of r.hold) { active.current.set(b.id, b.effects.flatMap((e) => applyEffect(root, def, b.target, e, b.id))); if (b.once) fired.current.add(b.id); }
      for (const b of r.fire) { for (const e of b.effects) applyEffect(root, def, b.target, e, b.id); if (b.once) fired.current.add(b.id); }
    }
    // an anchored popup follows its target when the page re-renders around it
    placeUxPopups(root);
    // scripts hear about answers
    const prev = prevValues.current;
    for (const s of scripts.current) {
      s.frame.contentWindow?.postMessage({ __rsux: 1, type: "answers", answers: answersByCode(), ...readsFor() }, "*");
      if (!prev) continue;
      // a script behaviour hears events only while its `when` holds
      if (!uxGuardHolds(def, s.behavior, p.state ?? stateFromValues(), p.values)) continue;
      for (const qid of p.shown) {
        if (JSON.stringify(prev[qid] ?? null) === JSON.stringify(p.values[qid] ?? null)) continue;
        const code = byCode.get(qid)!;
        const before = uxSelectedCodes(prev[qid]), now = uxSelectedCodes(p.values[qid]);
        const self = s.behavior.target.questionId === qid;
        const post = (ev: string, payload: unknown) => s.frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev, target: code, self, payload }, "*");
        post("change", { question: code, value: p.values[qid] });
        if (uxAnswered(p.values[qid])) post("answer", { question: code, value: p.values[qid] });
        for (const c of now) if (!before.has(c)) post("select", { question: code, value: p.values[qid], option: c });
        for (const c of before) if (!now.has(c)) post("deselect", { question: code, value: p.values[qid], option: c });
      }
    }
    prevValues.current = { ...p.values };
  });

  /*
   * Leaving the survey (the end page) or unmounting: popups and held effects go. Under React's
   * StrictMode the layer is mounted, unmounted and mounted again at once — so this also forgets the
   * page, and the next run applies what holds again instead of believing it is still applied.
   */
  React.useEffect(() => {
    const root = p.rootRef.current;
    return () => {
      for (const undo of active.current.values()) for (const u of undo) u.run();
      active.current.clear();
      lastPage.current = null;
      if (root) closeUxPopups(root);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* click / hover behaviours: delegated on the shell */
  React.useEffect(() => {
    const root = p.rootRef.current;
    const pointer = behaviors.filter((b) => !b.script && (b.on === "click" || b.on === "hover"));
    if (!root || !pointer.length) return;
    const within = (b: UxBehavior, node: EventTarget | null) => {
      if (!(node instanceof Element)) return null;
      const s = uxSelector(b.target);
      if (s.root && !root.matches(s.root)) return null;
      return s.inner ? node.closest(s.inner) : root;
    };
    const onClick = (ev: Event) => { for (const b of pointer.filter((x) => x.on === "click")) { if (b.once && fired.current.has(b.id)) continue; if (!uxGuardHolds(defRef.current, b, stateRef.current())) continue; if (within(b, ev.target)) { for (const e of b.effects) applyEffect(root, def, b.target, e, b.id); if (b.once) fired.current.add(b.id); } } };
    const onOver = (ev: Event) => { for (const b of pointer.filter((x) => x.on === "hover")) if (within(b, ev.target) && !active.current.has(b.id) && uxGuardHolds(defRef.current, b, stateRef.current())) active.current.set(b.id, b.effects.flatMap((e) => applyEffect(root, def, b.target, e, b.id))); };
    const onOut = (ev: MouseEvent) => { for (const b of pointer.filter((x) => x.on === "hover")) { if (!active.current.has(b.id)) continue; const from = within(b, ev.target), to = within(b, ev.relatedTarget); if (from && from !== to) { for (const u of active.current.get(b.id)!) u.run(); active.current.delete(b.id); } } };
    root.addEventListener("click", onClick);
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut as EventListener);
    return () => { root.removeEventListener("click", onClick); root.removeEventListener("mouseover", onOver); root.removeEventListener("mouseout", onOut as EventListener); };
  }, [p.pageKey, uxSig]); // eslint-disable-line react-hooks/exhaustive-deps

  /* script behaviours: one sandboxed frame each, per page */
  React.useEffect(() => {
    const maybeRoot = p.rootRef.current;
    // a script belongs to what it is attached to: it runs on the pages that show it
    const withScript = behaviors.filter((b) => b.script && (!b.target.questionId || p.shown.includes(b.target.questionId)) && (!b.target.blockId || b.target.blockId === p.blockId) && (!b.target.pageId || b.target.pageId === p.pageId));
    if (!maybeRoot || !withScript.length || typeof document === "undefined") return;
    const root: HTMLElement = maybeRoot;
    const look = defaultUxLookups(def);
    const hosts: ScriptHost[] = [];
    for (const b of withScript) {
      /*
       * One reporter for everything a script says. The Studio's preview and a
       * test interview show it in the inspector; EVERY mode also writes
       * errors and refusals to the browser console, because a script that
       * fails in a live survey used to fail silently and the programmer had
       * nothing to open.
       */
      const where = `${b.label}${b.target.questionId ? ` (${byCode.get(b.target.questionId) ?? ""})` : ""}`;
      const trace = (t: Record<string, unknown>) => { try { traceRef.current?.({ script: b.id, name: b.label, ...t } as UxTrace); } catch { /* a test hook never breaks the page */ } };
      const report = (text: string, level: "log" | "warn" | "error" = "log", kind?: UxScriptIssue["kind"]) => {
        log.current?.(`[ux script “${b.label}”] ${level === "error" ? "ERROR: " : ""}${text}`);
        if (level === "error") console.error(`[rescript:script] ${where}: ${text}`);
        else if (level === "warn") console.warn(`[rescript:script] ${where}: ${text}`);
        /* S1c: a failure is also counted for the survey's script health (the Runner's collector) */
        if (kind) { try { issueRef.current?.({ script: b.id, name: b.label, kind, message: text }); } catch { /* never break the page */ } }
      };
      /*
       * Validated again here, not only when it was proposed: a definition can
       * be edited by hand or arrive from an import. A loop could hang the
       * frame — and a sandboxed frame may share the page's thread — so a
       * script that does not pass the gate never runs.
       */
      /*
       * S1b: a CUSTOM COMPONENT's code (a runtime-only behaviour, engine withComponentBehaviors) is checked by the code
       * gate's component flavour on the author's own code, and its mirror is the component's element only.
       */
      const component = isComponentBehavior(b) ? def.questions.find((q) => q.id === b.target.questionId) ?? null : null;
      if (component) {
        const g = codeGate(component.customJs ?? "", "component");
        if (!g.ok) { report(`not run: ${gateReason(g)}`, "warn", "component_not_run"); continue; }
      } else {
        const check = validateUxScript(b.script!, def);
        if (check.errors.length) { report(`not run: ${check.errors.join("; ")}`, "warn", "gate_refused"); continue; }
        for (const w of check.warnings) report(`note: ${w}`, "warn");
      }
      const mirrorRoot: HTMLElement | null = component ? root.querySelector<HTMLElement>(`[data-rs-component="${CSS.escape(component.id)}"]`) : root;
      if (!mirrorRoot) { report("not run: the component is not on this page", "warn", "component_not_run"); continue; }
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("data-rs-ux-sandbox", b.id);
      frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
      frame.srcdoc = SANDBOX_DOC;
      const post = (m: Record<string, unknown>) => frame.contentWindow?.postMessage({ __rsux: 1, ...m }, "*");
      const dom = new DomBridge({ root: mirrorRoot, id: b.id, owner: b.target, log: (t) => report(t, "warn"), post, contain: !!p.contained, ...(traceRef.current ? { onOp: (op: string, el: Element | null, refused?: string) => trace(refused ? { kind: "refused", text: refused } : { kind: "dom", op, el }) } : {}) });
      let beat: ReturnType<typeof setInterval> | null = null;
      const host: ScriptHost = { frame, behavior: b, listens: [], undo: [], dom, started: false, waiting: new Map(), dispose: () => { if (beat) { clearInterval(beat); beat = null; } dom.dispose(); window.removeEventListener("message", onMessage); root.removeEventListener("click", onDom); root.removeEventListener("mouseover", onDom); frame.remove(); }, close: () => { if (!host.started) { host.dispose(); for (const u of host.undo) u.run(); return; } dom.freeze(); root.removeEventListener("click", onDom); root.removeEventListener("mouseover", onDom); const finish = () => { if (!closing.delete(finish)) return; host.dispose(); for (const u of host.undo) u.run(); }; closing.add(finish); setTimeout(finish, SCRIPT_GRACE_MS); } };
      let windowStart = Date.now(), count = 0;
      let awaiting = 0, missed = 0, beatN = 0;
      const resolve = (spec: unknown): UxTarget | null => {
        if (spec === "self" || spec == null) return b.target;
        const t = resolveUxTarget(def, spec, look);
        if (typeof t === "string") { report(`${t}`); trace({ kind: "refused", text: t }); return null; }
        return t;
      };
      const effect = (e: UxEffect, t: UxTarget | null) => {
        if (!t) return;
        const undo = applyEffect(root, def, t, { ...e, target: t }, b.id);
        host.undo.push(...undo);
        /* S2c: what changed — a class op counts only the elements it actually changed (removing an absent class is nothing) */
        if (traceRef.current) trace({ kind: "effect", op: e.do, target: t, detail: e.className ?? e.text ?? e.preset ?? (e.style ? Object.keys(e.style).join(",") : undefined), count: e.do === "show_popup" ? 1 : /class$/.test(e.do) ? undo.length : uxElements(root, t).length });
      };
      function onMessage(ev: MessageEvent) {
        if (ev.source !== frame.contentWindow) return;
        const m = ev.data as { __rsux?: number; cmd?: string; args?: unknown[]; id?: number };
        if (!m || m.__rsux !== 1 || typeof m.cmd !== "string") return;
        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; count = 0; }
        if (++count > COMMANDS_PER_SECOND) { report(`stopped: more than ${COMMANDS_PER_SECOND} commands a second`, "warn", "watchdog"); host.dispose(); return; }
        const a = Array.isArray(m.args) ? m.args : [];
        const str = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : String(x)).slice(0, 600);
        switch (m.cmd) {
          case "pong": awaiting = 0; missed = 0; break;
          case "ready": {
            host.started = true;
            trace({ kind: "ready" });
            /*
             * THE HEARTBEAT (S0b D8). Every HEARTBEAT_MS the host pings the frame; a frame that misses
             * HEARTBEAT_MISSES pings in a row while the page is shown is stuck (an endless promise chain, a
             * catastrophic regex, an allocation storm), so it is disposed, everything it changed is put back and
             * the script is logged "stopped: not responding". This only helps when the browser runs the
             * sandboxed frame OUT of process: a frame that shares the page's thread freezes this timer too.
             */
            if (!beat) beat = setInterval(() => {
              if (typeof document !== "undefined" && document.visibilityState === "hidden") { awaiting = 0; missed = 0; return; }
              if (awaiting) missed++;
              if (missed >= HEARTBEAT_MISSES) {
                report(`stopped: not responding (no answer to ${HEARTBEAT_MISSES} heartbeats in ${(HEARTBEAT_MS * HEARTBEAT_MISSES) / 1000} s) — its changes were undone`, "warn", "watchdog");
                host.dispose();
                for (const u of host.undo) u.run();
                host.undo.length = 0;
                return;
              }
              awaiting = ++beatN;
              frame.contentWindow?.postMessage({ __rsux: 1, type: "ping", n: beatN }, "*");
            }, HEARTBEAT_MS);
            for (const f of Array.from(closing)) f();
            const questions: Record<string, unknown> = {};
            for (const q of def.questions) questions[String(q.code)] = { code: String(q.code), type: q.type, text: plainText(q.text ?? ""), options: (q.options ?? []).map((o) => ({ code: String(o.code), label: plainText(o.label) })) };
            const tree = dom.tree();
            dom.primed(tree);
            // loops are bounded, not banned: every loop body counts its iterations (see guardScriptLoops)
            post({ type: "init", code: guardScriptLoops(b.script!).code, tree, answers: answersByCode(), ...readsRef.current(), meta: { questions, block: p.blockId ? { id: p.blockId } : null, page: p.pageId ? { id: p.pageId, index: p.pageIndex ?? null } : null } });
            dom.watch((t) => post({ type: "sync", tree: t }));
            frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev: "page", target: "self", self: true, payload: {} }, "*");
            break;
          }
          case "listen": host.listens.push({ ev: str(a[0]), target: str(a[1]) || "self" }); break;
          case "addClass": effect({ do: "add_class", className: str(a[1]) }, resolve(a[0])); break;
          case "removeClass": effect({ do: "remove_class", className: str(a[1]) }, resolve(a[0])); break;
          case "toggleClass": effect({ do: "toggle_class", className: str(a[1]) }, resolve(a[0])); break;
          case "animate": { const preset = str(a[1]); const opts = (a[2] && typeof a[2] === "object" ? a[2] : {}) as { duration?: number }; if (UX_PRESET_FRAMES[preset as keyof typeof UX_PRESET_FRAMES]) effect({ do: "animate", preset: preset as never, durationMs: Math.max(50, Math.min(10000, Number(opts.duration) || 450)) }, resolve(a[0])); else report(`“${preset}” is not a preset`); break; }
          case "setStyle": { const style = a[1] && typeof a[1] === "object" ? Object.fromEntries(Object.entries(a[1] as Record<string, unknown>).map(([k, v]) => [k, str(v)])) : {}; const c = checkDeclarations(style, { origin: "script" }); if (c.errors.length) report(`${c.errors.join("; ")}`);
            const st = resolve(a[0]);
            // D12: no hiding / disabling style on an answer input or a required question
            const lock = st ? uxElements(root, st).map((el) => answerLockReason(el)).find(Boolean) : null;
            if (c.errors.length) trace({ kind: "refused", text: `rs.setStyle: ${c.errors.join("; ")}` });
            if (lock) for (const [k, v] of Object.entries(c.ok)) if (HIDING_STYLE(k, v)) { report(`rs.setStyle: ${k}: ${v} refused on ${lock}`, "warn"); trace({ kind: "refused", text: `rs.setStyle: ${k}: ${v} refused on ${lock}` }); delete c.ok[k]; }
            effect({ do: "set_style", style: c.ok }, st); break; }
          case "clearStyle": { const t = resolve(a[0]); if (t) for (const el of uxElements(root, t)) { for (const k of setByUx.get(el) ?? []) el.style.removeProperty(k); setByUx.delete(el); } break; }
          case "show": effect({ do: "show" }, resolve(a[0])); break;
          case "hide": {
            /*
             * D12: rs.hide() cannot take an answer input or a required question away from the respondent (refused,
             * with the reason); hiding an ANSWERED question is allowed but said — the answer stays stored and is
             * still validated, which is rarely what the author meant.
             */
            const ht = resolve(a[0]);
            const els = ht ? uxElements(root, ht) : [];
            const lock = els.map((el) => answerLockReason(el)).find(Boolean);
            if (lock) { report(`rs.hide refused: the target is ${lock}`, "warn"); trace({ kind: "refused", text: `rs.hide refused: the target is ${lock}` }); break; }
            const values = { ...(p.allValues ?? {}), ...p.values } as Record<string, unknown>;
            const answered = els.flatMap((el) => [el, ...el.querySelectorAll("[data-qid]")]).map((el) => el.getAttribute("data-qid")).filter((id): id is string => !!id && values[id] != null && values[id] !== "" && !(Array.isArray(values[id]) && (values[id] as unknown[]).length === 0));
            if (answered.length) report(`rs.hide: ${[...new Set(answered)].map((id) => byCode.get(id) ?? id).join(", ")} already has an answer — hiding it keeps the answer stored and validated`, "warn");
            effect({ do: "hide" }, ht); break;
          }
          case "showMessage": effect({ do: "show_message", text: str(a[1]) }, resolve(a[0])); break;
          case "popup": {
            // the survey's own popup — rs.popup(text, { title, placement, target, dismiss, autoMs }); one per script, replaced by the next
            const o = (a[1] && typeof a[1] === "object" ? a[1] : {}) as Record<string, unknown>;
            const text = str(a[0]);
            if (!text) { report("rs.popup needs text"); break; }
            const pick = <T extends string>(v: unknown, list: readonly T[], what: string): T | undefined => { if (v == null || v === "") return undefined; if ((list as readonly string[]).includes(String(v))) return String(v) as T; report(`rs.popup: “${str(v)}” is not a ${what} (${list.join(", ")})`); return undefined; };
            const placement = pick(o.placement, ["center", "anchored", "top", "inline"] as const, "placement");
            const dismiss = pick(o.dismiss, ["button", "auto", "none"] as const, "dismiss");
            const autoMs = Number(o.autoMs) > 0 ? Math.max(1000, Math.min(60000, Math.round(Number(o.autoMs)))) : undefined;
            effect({ do: "show_popup", text, ...(o.title ? { title: str(o.title).slice(0, 120) } : {}), ...(placement ? { placement } : {}), ...(dismiss ? { dismiss } : {}), ...(autoMs ? { autoMs } : {}) }, resolve(o.target ?? "self"));
            break;
          }
          case "closePopup": closeUxPopups(root, b.id); break;
          case "hideMessage": effect({ do: "hide_message" }, resolve(a[0])); break;
          case "scrollTo": effect({ do: "scroll_into_view" }, resolve(a[0])); break;
          case "focus": effect({ do: "focus" }, resolve(a[0])); break;
          case "goToPage":
          case "goToSection": {
            const target = str(a[0]).trim();
            const fn = m.cmd === "goToPage" ? "rs.goToPage" : "rs.goToSection";
            if (!target) { report(`${fn} needs a ${m.cmd === "goToPage" ? "page id or question code" : "section id or title"}`, "warn"); break; }
            const nav = navigate.current;
            if (!nav) { report(`${fn}("${target}") refused: navigation is not available here`, "warn", "navigation_refused"); trace({ kind: "refused", text: `${fn}("${target}") refused: navigation is not available here` }); break; }
            // after the current event finishes, so a click handler's own effects land on the page it was written for
            setTimeout(() => {
              const r = nav(target, m.cmd === "goToPage" ? "page" : "section");
              if (r.ok) { report(`${fn}("${target}") — navigated`); trace({ kind: "effect", op: "navigate", target: { kind: "page", pageId: target } as UxTarget, count: 1 }); }
              else { report(`${fn}("${target}") refused: ${r.reason ?? "not allowed"}`, "warn", "navigation_refused"); trace({ kind: "refused", text: `${fn}("${target}") refused: ${r.reason ?? "not allowed"}` }); }
            }, 0);
            break;
          }
          case "setAnswer":
          case "setEmbedded":
          case "setCalc":
          case "flag": {
            /* S1a: a write is a REQUEST — the host decides with the engine; the frame's promise gets { ok, reason } */
            const id = typeof m.id === "number" ? m.id : 0;
            const name = str(a[0]).trim().slice(0, 200);
            const write: ScriptWrite = m.cmd === "setAnswer" ? { kind: "answer", ref: name, value: a[1] ?? null, loopKey: a[2] == null ? null : str(a[2]) }
              : m.cmd === "setEmbedded" ? { kind: "embedded", name, value: a[1] ?? null }
              : m.cmd === "setCalc" ? { kind: "calculated", name, value: a[1] ?? null }
              : { kind: "flag", name };
            const call = `rs.${m.cmd}("${name}")`;
            const fn = writeRef.current;
            let result: { ok: boolean; reason?: string };
            try { result = fn ? fn(write, { id: b.id, label: b.label, target: b.target }) : { ok: false, reason: "writes are not available here" }; }
            catch (e) { result = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
            if (result.ok) report(`${call} — written`);
            else report(`${call} refused: ${result.reason ?? "not allowed"}`, "warn", "write_refused");
            if (id) post({ type: "reply", id, result: { ok: !!result.ok, ...(result.reason ? { reason: result.reason } : {}) } });
            break;
          }
          case "lifecycleDone": {
            const f = host.waiting.get(Number(a[0]));
            if (!f) break;
            host.waiting.delete(Number(a[0]));
            const list = Array.isArray(a[1]) ? (a[1] as unknown[]).slice(0, 20) : [];
            f(list.map((e) => { const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>; return { message: str(o.message).slice(0, 500), ref: o.ref == null ? null : str(o.ref).slice(0, 200) }; }));
            break;
          }
          case "log": report(`${a.map(str).join(" ")}`); trace({ kind: "log", text: a.map(str).join(" ") }); break;
          case "ops": dom.apply(a[0]); break;
          case "want": dom.want(str(a[0])); break;
          case "resync": dom.resync((t) => post({ type: "sync", tree: t }), true); break;
          case "error": report(str(a[0]), "error", "ux_error"); trace({ kind: "error", text: str(a[0]), ...(typeof a[1] === "number" ? { line: a[1] } : {}) }); break;
          default: break;
        }
      }
      // clicks and hovers reach the script only for the targets it listens to
      function onDom(ev: Event) {
        const kind = ev.type === "click" ? "click" : "hover";
        for (const l of host.listens.filter((x) => x.ev === kind)) {
          const t = resolve(l.target);
          if (!t) continue;
          const s = uxSelector(t);
          if (s.root && !root.matches(s.root)) continue;
          const hit = s.inner ? (ev.target instanceof Element ? ev.target.closest(s.inner) : null) : root;
          if (hit) frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev: kind, target: l.target, self: l.target === "self", payload: { target: l.target } }, "*");
        }
      }
      window.addEventListener("message", onMessage);
      root.addEventListener("click", onDom);
      root.addEventListener("mouseover", onDom);
      root.appendChild(frame);
      hosts.push(host);
    }
    scripts.current = hosts;
    // leaving the page: what was already handed to a script is handled, then everything it changed is put back
    return () => { for (const h of hosts) h.close(); scripts.current = []; };
  }, [p.pageKey, uxSig]); // eslint-disable-line react-hooks/exhaustive-deps

  /* S1a: the lifecycle on Next — ask the frames of this page that listen for validate / submit, each bounded */
  React.useEffect(() => {
    const ref = p.lifecycleRef;
    if (!ref) return;
    ref.current = (ev, timeoutMs) => Promise.all(scripts.current
      .filter((s) => s.started && s.listens.some((l) => l.ev === ev))
      .map((s) => new Promise<UxFrameAnswer>((resolve) => {
        const id = ++lifecycleN;
        const timer = setTimeout(() => { s.waiting.delete(id); resolve({ script: s.behavior.label, id: s.behavior.id, timedOut: true }); }, timeoutMs);
        s.waiting.set(id, (errors) => { clearTimeout(timer); resolve({ script: s.behavior.label, errors: errors ?? [] }); });
        s.frame.contentWindow?.postMessage({ __rsux: 1, type: "lifecycle", ev, id }, "*");
      })));
    return () => { if (ref.current) ref.current = null; };
  });

  /* the page-complete event for scripts */
  const complete = p.shown.length > 0 && p.shown.every((id) => { const q = def.questions.find((x) => x.id === id); return !q || q.type === "html" || q.type === "calculated" || q.settings?.hidden || uxAnswered(p.values[id]); });
  React.useEffect(() => {
    if (!complete) return;
    for (const s of scripts.current) s.frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev: "complete", target: "self", self: true, payload: {} }, "*");
  }, [complete, p.pageKey]);

  return css ? <style data-rs-ux-css="" dangerouslySetInnerHTML={{ __html: css }} /> : null;
}
