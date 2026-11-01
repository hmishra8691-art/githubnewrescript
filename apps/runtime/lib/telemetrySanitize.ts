/**
 * Keep only the fields the collector defines, drop anything the survey has
 * switched off, and bound the size. Clipboard text never arrives (the
 * collector records lengths only) — this guards against a tampered client.
 *
 * (Moved out of api/session/save/route.ts in S5b so it can be unit-tested; the S5b fields — scroll depth,
 * question visibility, answer history — are kept only when their category is on, and listed in `disabled` when it is off.)
 */
import { HISTORY_CAP, HISTORY_CLOSED_TYPES, HISTORY_TEXT_TYPES, historyValue } from "./paradata.ts";

export const TELEMETRY_KEYS = ["timing", "focus", "clipboard", "navigation", "interaction", "device", "network", "visibility", "answerHistory"] as const;
/** the S5b categories a collector reports in `measured` */
const MEASURABLE = ["visibility", "answerHistory"];

/**
 * S5b (TE-02): a question's value history as the server keeps it — re-derived from the DEFINITION's question type,
 * never the client's word: a closed type keeps validated codes / numbers / cells, typed text `{ len }` only, any
 * other (or unknown) question nothing.
 */
function sanitizeHistory(h: unknown, type: string | undefined): [number, unknown][] | undefined {
  if (!Array.isArray(h) || !type || !(HISTORY_CLOSED_TYPES.has(type) || HISTORY_TEXT_TYPES.has(type))) return undefined;
  const out: [number, unknown][] = [];
  for (const e of h.slice(-HISTORY_CAP)) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "number" || !Number.isFinite(e[0])) continue;
    if (HISTORY_TEXT_TYPES.has(type)) {
      const len = (e[1] as { len?: unknown } | null)?.len;
      if (typeof len === "number" && Number.isFinite(len) && len >= 0) out.push([e[0], { len: Math.round(len) }]);
      continue;
    }
    const v = historyValue(type, e[1]);
    if (v !== undefined) out.push([e[0], v]);
  }
  return out.length ? out : undefined;
}

/** `types`: question id → type, from the survey definition (the history is kept only for questions it knows) */
export function sanitizeTelemetry(t: any, cfg: any, types?: Record<string, string>): any {
  const on = (k: string) => !cfg || cfg[k] !== false;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const optNum = (x: unknown, min = -Infinity, max = Infinity) => (typeof x === "number" && Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : undefined);
  const pages = Array.isArray(t.pages) ? t.pages.slice(0, 2000).map((v: any) => ({
    pageId: String(v.pageId ?? "").slice(0, 80), step: num(v.step), enteredAt: num(v.enteredAt),
    leftAt: typeof v.leftAt === "number" ? v.leftAt : undefined,
    via: ["start", "next", "back", "reload", "jump"].includes(v.via) ? v.via : "next",
    questionIds: Array.isArray(v.questionIds) ? v.questionIds.slice(0, 200).map(String) : [],
    outOfFocusMs: on("focus") ? num(v.outOfFocusMs) : 0, blurs: on("focus") ? num(v.blurs) : 0,
    pointerEvents: on("interaction") ? num(v.pointerEvents) : 0, keyEvents: on("interaction") ? num(v.keyEvents) : 0, scrollEvents: on("interaction") ? num(v.scrollEvents) : 0,
    scrollDepth: on("visibility") ? optNum(v.scrollDepth, 0, 100) : undefined,
  })) : [];
  const questions: Record<string, unknown> = {};
  if (t.questions && typeof t.questions === "object") {
    for (const [k, q] of Object.entries(t.questions as Record<string, any>).slice(0, 2000)) {
      questions[String(k).slice(0, 80)] = {
        firstChangeAt: typeof q?.firstChangeAt === "number" ? q.firstChangeAt : undefined,
        lastChangeAt: typeof q?.lastChangeAt === "number" ? q.lastChangeAt : undefined,
        changes: num(q?.changes), latencyMs: typeof q?.latencyMs === "number" ? q.latencyMs : undefined,
        pastes: on("clipboard") ? num(q?.pastes) : 0, pasteChars: on("clipboard") ? num(q?.pasteChars) : 0,
        typedChars: on("interaction") ? num(q?.typedChars) : 0, copies: on("clipboard") ? num(q?.copies) : 0,
        visibleMs: on("visibility") ? optNum(q?.visibleMs, 0) : undefined,
        firstSeenAt: on("visibility") ? optNum(q?.firstSeenAt, 0) : undefined,
        history: on("answerHistory") ? sanitizeHistory(q?.history, types?.[String(k)]) : undefined,
        historyDropped: on("answerHistory") && Array.isArray(q?.history) ? optNum(q?.historyDropped, 0) : undefined,
      };
    }
  }
  const d = t.device && typeof t.device === "object" && on("device") ? {
    type: ["desktop", "tablet", "mobile"].includes(t.device.type) ? t.device.type : "unknown",
    browser: String(t.device.browser ?? "").slice(0, 40), os: String(t.device.os ?? "").slice(0, 40),
    screen: String(t.device.screen ?? "").slice(0, 20), viewport: String(t.device.viewport ?? "").slice(0, 20),
    dpr: num(t.device.dpr), locale: String(t.device.locale ?? "").slice(0, 20), language: String(t.device.language ?? "").slice(0, 10),
    timezone: String(t.device.timezone ?? "").slice(0, 60), tzOffset: num(t.device.tzOffset),
    touch: !!t.device.touch, webdriver: !!t.device.webdriver,
    hardwareConcurrency: typeof t.device.hardwareConcurrency === "number" ? t.device.hardwareConcurrency : undefined,
    platform: t.device.platform ? String(t.device.platform).slice(0, 40) : undefined,
  } : undefined;
  const disabled = new Set<string>(Array.isArray(t.disabled) ? t.disabled.map(String).filter((k: string) => (TELEMETRY_KEYS as readonly string[]).includes(k)) : []);
  for (const k of TELEMETRY_KEYS) if (!on(k)) disabled.add(k);
  const measured = Array.isArray(t.measured) ? [...new Set<string>(t.measured.map(String))].filter((k) => MEASURABLE.includes(k) && !disabled.has(k)) : [];
  return {
    v: 1, startedAt: num(t.startedAt), submittedAt: typeof t.submittedAt === "number" ? t.submittedAt : undefined,
    pages: on("timing") || on("navigation") ? pages : [],
    questions: on("timing") ? questions : {},
    focus: on("focus") ? { blurs: num(t.focus?.blurs), totalOutOfFocusMs: num(t.focus?.totalOutOfFocusMs), longestOutOfFocusMs: num(t.focus?.longestOutOfFocusMs) } : { blurs: 0, totalOutOfFocusMs: 0, longestOutOfFocusMs: 0 },
    clipboard: on("clipboard") ? { copies: num(t.clipboard?.copies), pastes: num(t.clipboard?.pastes), pasteChars: num(t.clipboard?.pasteChars), largePastes: num(t.clipboard?.largePastes), pasteQuestions: num(t.clipboard?.pasteQuestions) } : { copies: 0, pastes: 0, pasteChars: 0, largePastes: 0, pasteQuestions: 0 },
    navigation: on("navigation") ? { back: num(t.navigation?.back), forward: num(t.navigation?.forward), reloads: num(t.navigation?.reloads), jumps: num(t.navigation?.jumps), sequence: Array.isArray(t.navigation?.sequence) ? t.navigation.sequence.slice(0, 500).map((x: unknown) => String(x).slice(0, 90)) : [] } : { back: 0, forward: 0, reloads: 0, jumps: 0, sequence: [] },
    interaction: on("interaction") ? { pointerEvents: num(t.interaction?.pointerEvents), keyEvents: num(t.interaction?.keyEvents), scrollEvents: num(t.interaction?.scrollEvents) } : { pointerEvents: 0, keyEvents: 0, scrollEvents: 0 },
    device: d,
    disabled: [...disabled],
    measured,
  };
}
