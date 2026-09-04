"use client";
import type { TelemetryConfig } from "@rescript/schema";
import type { ResponseTelemetry, PageVisit, DeviceInfo } from "@rescript/quality";

/**
 * The event collector — what the runtime records about HOW a respondent
 * answered, for the quality engine.
 *
 * Everything recorded is derived metadata: durations, counts, lengths, a
 * coarse device class. Specifically NOT recorded: clipboard contents, typed
 * text, keystrokes, mouse coordinates, the raw IP (the server hashes it),
 * or any fingerprinting beyond screen size / timezone / language.
 *
 * The survey's `quality.telemetry` config switches each category off; a
 * category that is off is listed in `disabled` so the engine treats a zero as
 * "not measured" rather than "nothing happened".
 *
 * Page visits: one entry per arrival on a page (a back move creates a new
 * visit). Question timings: first/last change and the page-entry → first
 * change latency on the visit where it happened. Out-of-focus time is
 * attributed to the visit in progress and subtracted from dwell by the engine.
 */

export interface TelemetryCollector {
  readonly data: ResponseTelemetry;
  /** a page appeared (or re-appeared) */
  enterPage(pageId: string, step: number, questionIds: string[], via: PageVisit["via"]): void;
  /** the current page is being left */
  leavePage(): void;
  /** an answer changed */
  answerChanged(questionId: string): void;
  /** the survey ended */
  submitted(): void;
  /** stop listening */
  dispose(): void;
  /** the coarse device description, for the server-side device hash */
  device: DeviceInfo | undefined;
}

const now = () => Date.now();

export function detectDevice(): DeviceInfo | undefined {
  if (typeof window === "undefined" || typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent ?? "";
  const w = window.innerWidth, h = window.innerHeight;
  const type: DeviceInfo["type"] = /Mobi|Android(?!.*Tablet)|iPhone|iPod/i.test(ua) ? "mobile" : /iPad|Tablet|Android/i.test(ua) ? "tablet" : /Windows|Macintosh|Linux|CrOS/i.test(ua) ? "desktop" : "unknown";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) && !/Chrome/.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : /MSIE|Trident/.test(ua) ? "IE" : "Other";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Other";
  let timezone = "";
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { /* unsupported */ }
  return {
    type, browser, os,
    screen: `${screen?.width ?? 0}x${screen?.height ?? 0}`,
    viewport: `${w}x${h}`,
    dpr: Math.round((window.devicePixelRatio ?? 1) * 100) / 100,
    locale: navigator.language ?? "",
    language: (navigator.language ?? "").split("-")[0],
    languages: Array.isArray(navigator.languages) ? [...navigator.languages].slice(0, 5) : undefined,
    timezone,
    tzOffset: new Date().getTimezoneOffset(),
    touch: "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0,
    webdriver: !!(navigator as any).webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    platform: (navigator as any).userAgentData?.platform ?? navigator.platform,
  };
}

/** Stable per-tab marker so a reload is recognised as a reload, not a fresh start. */
function reloadCount(sessionId: string | undefined): number {
  if (!sessionId || typeof sessionStorage === "undefined") return 0;
  try {
    const key = `rescript:loads:${sessionId}`;
    const n = Number(sessionStorage.getItem(key) ?? "0");
    sessionStorage.setItem(key, String(n + 1));
    return n; // 0 on the first load
  } catch { return 0; }
}

export function createTelemetryCollector(cfg: TelemetryConfig | undefined, sessionId: string | undefined): TelemetryCollector {
  const c = cfg ?? ({} as Partial<TelemetryConfig>);
  const on = (k: keyof TelemetryConfig) => (c as any)[k] !== false;
  const disabled = (["timing", "focus", "clipboard", "navigation", "interaction", "device", "network"] as const).filter((k) => !on(k));
  const startedAt = now();
  const reloads = on("navigation") ? reloadCount(sessionId) : 0;

  const data: ResponseTelemetry = {
    v: 1, startedAt, pages: [], questions: {},
    focus: { blurs: 0, totalOutOfFocusMs: 0, longestOutOfFocusMs: 0 },
    clipboard: { copies: 0, pastes: 0, pasteChars: 0, largePastes: 0, pasteQuestions: 0 },
    navigation: { back: 0, forward: 0, reloads, jumps: 0, sequence: [] },
    interaction: { pointerEvents: 0, keyEvents: 0, scrollEvents: 0 },
    device: on("device") ? detectDevice() : undefined,
    disabled,
  };

  let current: PageVisit | null = null;
  let hiddenSince: number | null = null;
  const pasteQuestions = new Set<string>();
  const listeners: [string, EventListener, EventTarget, AddEventListenerOptions | undefined][] = [];
  const listen = (target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, fn, opts);
    listeners.push([type, fn, target, opts]);
  };

  /** the question a DOM event happened inside, from the renderer's data-qid */
  const questionOf = (e: Event): string | null => {
    const el = e.target as Element | null;
    const card = el?.closest?.("[data-qid]") as HTMLElement | null;
    return card?.dataset.qid ?? null;
  };
  const qt = (qid: string) => (data.questions[qid] ??= { changes: 0, pastes: 0, pasteChars: 0, typedChars: 0, copies: 0 });

  if (typeof window !== "undefined") {
    if (on("focus")) {
      const hide = () => { if (hiddenSince === null) { hiddenSince = now(); data.focus.blurs++; if (current) current.blurs++; } };
      const show = () => {
        if (hiddenSince === null) return;
        const ms = now() - hiddenSince;
        hiddenSince = null;
        data.focus.totalOutOfFocusMs += ms;
        data.focus.longestOutOfFocusMs = Math.max(data.focus.longestOutOfFocusMs, ms);
        if (current) current.outOfFocusMs += ms;
      };
      listen(document, "visibilitychange", () => (document.visibilityState === "hidden" ? hide() : show()));
      listen(window, "blur", hide);
      listen(window, "focus", show);
    }
    if (on("clipboard")) {
      listen(document, "paste", (e) => {
        const text = (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
        const len = text.length; // length only — the text itself is never stored
        data.clipboard.pastes++;
        data.clipboard.pasteChars += len;
        if (len >= 200) data.clipboard.largePastes++;
        const qid = questionOf(e);
        if (qid) { const q = qt(qid); q.pastes++; q.pasteChars += len; pasteQuestions.add(qid); data.clipboard.pasteQuestions = pasteQuestions.size; }
      }, { capture: true });
      listen(document, "copy", (e) => { data.clipboard.copies++; const qid = questionOf(e); if (qid) qt(qid).copies++; }, { capture: true });
    }
    if (on("interaction")) {
      listen(document, "pointerdown", () => { data.interaction.pointerEvents++; if (current) current.pointerEvents++; }, { capture: true, passive: true });
      listen(document, "keydown", (e) => {
        data.interaction.keyEvents++;
        if (current) current.keyEvents++;
        const ke = e as KeyboardEvent;
        if (ke.key?.length === 1) { const qid = questionOf(e); if (qid) qt(qid).typedChars++; }
      }, { capture: true, passive: true });
      listen(window, "scroll", () => { data.interaction.scrollEvents++; if (current) current.scrollEvents++; }, { passive: true });
    }
  }

  const leavePage = () => {
    if (!current) return;
    current.leftAt = now();
    current = null;
  };

  return {
    data,
    device: data.device,
    enterPage(pageId, step, questionIds, via) {
      if (!on("timing") && !on("navigation")) return;
      leavePage();
      const visit: PageVisit = { pageId, step, enteredAt: now(), via, questionIds, outOfFocusMs: 0, blurs: 0, pointerEvents: 0, keyEvents: 0, scrollEvents: 0 };
      current = visit;
      data.pages.push(visit);
      if (on("navigation")) {
        if (via === "back") data.navigation.back++;
        else if (via === "next") data.navigation.forward++;
        else if (via === "jump") data.navigation.jumps++;
        data.navigation.sequence.push(`${pageId}${via === "back" ? "<" : via === "reload" ? "~" : via === "jump" ? "^" : ">"}`);
        if (data.navigation.sequence.length > 500) data.navigation.sequence.splice(0, data.navigation.sequence.length - 500);
      }
    },
    leavePage,
    answerChanged(questionId) {
      if (!on("timing")) return;
      const q = qt(questionId);
      const t = now();
      if (q.firstChangeAt === undefined) {
        q.firstChangeAt = t;
        if (current && current.questionIds.includes(questionId)) q.latencyMs = t - current.enteredAt;
      }
      q.lastChangeAt = t;
      q.changes++;
    },
    submitted() {
      leavePage();
      data.submittedAt = now();
    },
    dispose() {
      for (const [type, fn, target, opts] of listeners) target.removeEventListener(type, fn, opts);
      listeners.length = 0;
    },
  };
}
