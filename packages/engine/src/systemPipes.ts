import type { SurveyDefinition, Quota } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import type { ResponseState } from "./state.js";
import { loopKeySuffix } from "./state.js";
import { registerSystemPipeResolver } from "./piping.js";
import { parseQuotaRef, parseRandomRef, type PipeToken } from "./pipingTokens.js";
import { effectiveLimit, matchingCells, type QuotaCounts } from "./quotas.js";
import { hashString, mulberry32, subSeed } from "./random.js";
import { stateLanguage } from "./localization.js";

/**
 * SYSTEM PIPING SOURCES (document 15/10/2026, item C).
 *
 * The values the platform itself knows — the survey, the response, the
 * clock, the respondent's device, the link they came by, the quota counts
 * the runtime was given, and random values — resolved for `{{…}}` tokens the
 * way an answer or an Embedded Data field already is (`pipingTokens.ts` has
 * the grammar). Nothing here is invented: a source the runtime does not have
 * at this point resolves to "" (and the Studio's Insert Piped Text menu
 * marks it unavailable rather than offering it).
 *
 * Registered with `piping.ts` on load (see `registerSystemPipeResolver`).
 */

/* ------------------------------------------------------------ the clock */

let clock: () => Date = () => new Date();
/** Tests only: fix "now". `null` restores the real clock. */
export function setPipeClock(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * A date in a display pattern, in the respondent's LOCAL time (the browser's):
 *
 *   YYYY 2026 · YY 26 · MMMM October · MMM Oct · MM 10 · M 10 · DD 07 · D 7
 *   dddd Saturday · ddd Sat · HH 09 · H 9 · hh 09 (12-hour) · h 9 · mm 05 · ss 07 · A AM/PM
 *   [literal text] is kept as written.
 */
export function formatDatePattern(d: Date, pattern: string): string {
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A/g, (tok, literal?: string) => {
    if (literal !== undefined) return literal;
    switch (tok) {
      case "YYYY": return String(d.getFullYear());
      case "YY": return pad(d.getFullYear() % 100);
      case "MMMM": return MONTH_NAMES[d.getMonth()];
      case "MMM": return MONTH_NAMES[d.getMonth()].slice(0, 3);
      case "MM": return pad(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "DD": return pad(d.getDate());
      case "D": return String(d.getDate());
      case "dddd": return DAY_NAMES[d.getDay()];
      case "ddd": return DAY_NAMES[d.getDay()].slice(0, 3);
      case "HH": return pad(h);
      case "H": return String(h);
      case "hh": return pad(h % 12 === 0 ? 12 : h % 12);
      case "h": return String(h % 12 === 0 ? 12 : h % 12);
      case "mm": return pad(d.getMinutes());
      case "ss": return pad(d.getSeconds());
      case "A": return h < 12 ? "AM" : "PM";
      default: return tok;
    }
  });
}

/** The formats the picker offers, by what the source holds. */
export const PIPE_DATE_FORMATS: { date: string[]; time: string[]; datetime: string[] } = {
  date: ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD MMM YYYY", "MMMM D, YYYY", "dddd, D MMMM YYYY"],
  time: ["HH:mm", "HH:mm:ss", "hh:mm A"],
  datetime: ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm", "DD/MM/YYYY HH:mm", "MM/DD/YYYY hh:mm A"],
};

/** What each `date.*` source holds, and the pattern it uses when none is given. */
export const DATE_SOURCE_KINDS: Record<string, { holds: "date" | "time" | "datetime" | "number" | "text"; pattern?: string }> = {
  today: { holds: "date", pattern: "YYYY-MM-DD" },
  now: { holds: "datetime", pattern: "YYYY-MM-DD HH:mm:ss" },
  time: { holds: "time", pattern: "HH:mm" },
  start_date: { holds: "date", pattern: "YYYY-MM-DD" },
  start_time: { holds: "time", pattern: "HH:mm" },
  start: { holds: "datetime", pattern: "YYYY-MM-DD HH:mm:ss" },
  day: { holds: "number", pattern: "D" },
  month: { holds: "number", pattern: "M" },
  month_name: { holds: "text", pattern: "MMMM" },
  year: { holds: "number", pattern: "YYYY" },
  weekday: { holds: "text", pattern: "dddd" },
  timezone: { holds: "text" },
  unix: { holds: "number" },
  iso: { holds: "datetime" },
};

function dateSource(key: string, fmt: string | undefined, state: ResponseState): string {
  const startKeys = key === "start_date" || key === "start_time" || key === "start";
  const d = startKeys ? new Date(state.startedAt) : clock();
  if (Number.isNaN(d.getTime())) return "";
  if (key === "timezone") {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { return ""; }
  }
  if (key === "unix") return String(Math.floor(d.getTime() / 1000));
  if (key === "iso" && !fmt) return d.toISOString();
  const spec = DATE_SOURCE_KINDS[key];
  return formatDatePattern(d, fmt || spec?.pattern || "YYYY-MM-DD HH:mm:ss");
}

/* ------------------------------------------------------------ the device */

export interface DeviceInfo {
  type: "desktop" | "tablet" | "mobile" | "";
  os: string;
  browser: string;
  screen: string;
  viewport: string;
  language: string;
  user_agent: string;
}

/**
 * The respondent's device, from what THEIR browser reports (user agent,
 * screen, window, language). Pure, so it is tested here and the Runner only
 * hands it `navigator` / `screen` values. Unknown parts are "", never a guess.
 */
export function describeDevice(input: {
  userAgent?: string; screenWidth?: number; screenHeight?: number;
  viewportWidth?: number; viewportHeight?: number; language?: string; maxTouchPoints?: number;
}): DeviceInfo {
  const ua = input.userAgent ?? "";
  const touchMac = /Macintosh/.test(ua) && (input.maxTouchPoints ?? 0) > 1; // iPadOS reports itself as a Mac
  const type: DeviceInfo["type"] = !ua ? ""
    : /iPad|Tablet|PlayBook|Silk/i.test(ua) || touchMac || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? "tablet"
    : /Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua) ? "mobile"
    : "desktop";
  const os = !ua ? ""
    : /Windows NT/i.test(ua) ? "Windows"
    : /iPhone|iPad|iPod/i.test(ua) || touchMac ? "iOS"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Android/i.test(ua) ? "Android"
    : /CrOS/i.test(ua) ? "ChromeOS"
    : /Linux/i.test(ua) ? "Linux"
    : "Other";
  const browser = !ua ? ""
    : /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Other";
  const size = (w?: number, h?: number) => (w && h ? `${Math.round(w)}x${Math.round(h)}` : "");
  return {
    type, os, browser,
    screen: size(input.screenWidth, input.screenHeight),
    viewport: size(input.viewportWidth, input.viewportHeight),
    language: input.language ?? "",
    user_agent: ua,
  };
}

/**
 * What the Runner records in `state.meta` when a session starts, so system
 * sources can read it wherever the flow is evaluated (embedded data, piping).
 */
export function runtimePipeMeta(input: {
  channel: "live" | "test" | "preview" | string;
  language?: string | null;
  device?: Parameters<typeof describeDevice>[0] | null;
}): Record<string, unknown> {
  return {
    channel: input.channel,
    ...(input.language ? { language: input.language } : {}),
    ...(input.device ? { device: describeDevice(input.device) } : {}),
  };
}

/* ------------------------------------------------------------ quotas */

/** A quota by id or name (case-insensitive), as `{{quota.X.…}}` names it. */
export function findPipeQuota(def: SurveyDefinition, name: string): Quota | undefined {
  const wanted = name.toLowerCase();
  return (def.quotas ?? []).find((q) => q.id.toLowerCase() === wanted) ?? (def.quotas ?? []).find((q) => q.name.toLowerCase() === wanted);
}

/**
 * A quota's numbers, from the counts the runtime was given when the session
 * started (the same `quotaCounts` every quota check reads). Totals are across
 * the quota's cells; `cell` is the cell(s) this respondent falls in.
 */
export function quotaPipeValue(def: SurveyDefinition, state: ResponseState, counts: QuotaCounts | undefined, quota: Quota, prop: string): string {
  const cells = quota.cells ?? [];
  const count = cells.reduce((n, c) => n + (counts?.[quota.id]?.[c.id] ?? 0), 0);
  const limit = cells.reduce((n, c) => n + Math.max(0, effectiveLimit(quota, c.limit, c.limitType)), 0);
  switch (prop) {
    case "id": return quota.id;
    case "name": return quota.name;
    case "count": return String(count);
    case "limit": return String(limit);
    case "remaining": return String(Math.max(0, limit - count));
    case "percent": return limit > 0 ? String(Math.min(100, Math.round((count / limit) * 100))) : "0";
    case "status": {
      const limited = cells.filter((c) => effectiveLimit(quota, c.limit, c.limitType) > 0);
      const full = limited.length > 0 && limited.every((c) => (counts?.[quota.id]?.[c.id] ?? 0) >= effectiveLimit(quota, c.limit, c.limitType));
      return full ? "full" : "open";
    }
    case "cell": {
      const ids = new Set(matchingCells(def, state, quota));
      return cells.filter((c) => ids.has(c.id)).map((c) => c.label).join(", ");
    }
    default: return "";
  }
}

/* ------------------------------------------------------------ random */

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * A random value that lasts as long as it was asked to:
 *
 *   per:respondent (default) — the same value every time for this respondent
 *                              (their id when the link carries one, else their
 *                              session's seed — which a resume and a reload keep)
 *   per:session              — the same value for this session
 *   per:loop                 — a value per loop iteration, stable for each
 *   per:each                 — a new value every time it is evaluated
 *
 * Stable values are DERIVED from the seed, not stored: nothing to save, and a
 * resumed respondent gets the value they had. Two identical tokens give the
 * same value; `|key:NAME` makes one draw independently.
 */
export function randomPipeValue(t: Pick<PipeToken, "ref" | "per" | "key">, state: ResponseState, loop?: EvalContext["loop"]): string {
  const r = parseRandomRef(t.ref);
  if (!r) return "";
  const per = t.per ?? "respondent";
  let rand: () => number;
  if (per === "each") rand = Math.random;
  else {
    const base = per === "respondent" && state.respondentId ? hashString(`respondent:${state.respondentId}`) : (state.seed ?? 0);
    const scope = per === "session" ? `@session:${state.sessionId}` : per === "loop" ? loopKeySuffix(loop ?? null) : "";
    rand = mulberry32(subSeed(base, `pipe:${t.ref}${t.key ? `#${t.key}` : ""}${scope}`));
  }
  const num = (i: number, dflt: number) => {
    const n = Number(r.args[i]);
    return r.args[i] === undefined || r.args[i] === "" || !Number.isFinite(n) ? dflt : n;
  };
  switch (r.kind) {
    case "int": {
      const lo = Math.ceil(num(0, 1)), hi = Math.floor(num(1, 100));
      if (hi < lo) return "";
      return String(lo + Math.floor(rand() * (hi - lo + 1)));
    }
    case "decimal": {
      const lo = num(0, 0), hi = num(1, 1), places = Math.max(0, Math.min(10, Math.trunc(num(2, 2))));
      if (hi < lo) return "";
      return (lo + rand() * (hi - lo)).toFixed(places);
    }
    case "pick": return r.args.length ? r.args[Math.floor(rand() * r.args.length)] : "";
    case "id": {
      const len = Math.max(1, Math.min(64, Math.trunc(num(0, 8))));
      let s = "";
      for (let i = 0; i < len; i++) s += ALNUM[Math.floor(rand() * ALNUM.length)];
      return s;
    }
    case "bool": return rand() < 0.5 ? "true" : "false";
    case "uuid": {
      const b = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
  }
  return "";
}

/* ------------------------------------------------------------ the resolver */

/** One system token's value as plain text; "" when the platform has none here. */
export function resolveSystemPipe(t: PipeToken, ctx: EvalContext): string {
  const { def, state } = ctx;
  const meta = (state.meta ?? {}) as Record<string, unknown>;
  if (t.ref.startsWith("random.")) return randomPipeValue(t, state, ctx.loop);
  const q = parseQuotaRef(t.ref);
  if (q) {
    const quota = findPipeQuota(def, q.quota);
    return quota ? quotaPipeValue(def, state, ctx.quotaCounts, quota, q.prop) : "";
  }
  const dot = t.ref.indexOf(".");
  const ns = t.ref.slice(0, dot);
  const key = t.ref.slice(dot + 1);
  switch (ns) {
    case "survey":
      if (key === "id") return def.meta?.id ?? "";
      if (key === "code") return def.meta?.code ?? "";
      if (key === "name") return def.meta?.title ?? "";
      if (key === "version") return String(state.surveyVersion ?? def.meta?.version ?? "");
      return "";
    case "response":
      if (key === "id") return state.sessionId ?? "";
      if (key === "respondent_id") return state.respondentId ?? "";
      if (key === "status") return state.status ?? "";
      if (key === "language") {
        return stateLanguage(state) ?? (typeof meta.language === "string" ? meta.language : "") ?? "";
      }
      return "";
    case "date":
      return dateSource(key, t.fmt, state);
    case "device": {
      const d = meta.device as Partial<DeviceInfo> | undefined;
      const v = d?.[key as keyof DeviceInfo];
      return v == null ? "" : String(v);
    }
    case "distribution":
      if (key === "channel") return typeof meta.channel === "string" ? meta.channel : "";
      if (key === "link_type") return def.deployment?.access?.mode ?? "open";
      return "";
  }
  return "";
}

registerSystemPipeResolver(resolveSystemPipe);
