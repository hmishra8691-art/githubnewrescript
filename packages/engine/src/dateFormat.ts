/**
 * DATE AND TIME AS THE PROGRAMMER CHOSE TO SHOW THEM (October 2026 review).
 *
 * "Currently, the Preview displays the date format as MM/DD/YYYY. Add a Date
 * Format dropdown so the survey programmer can select the required format"
 * and "Time Format: 12-hour → 09:30 AM, 24-hour → 09:30; optional settings:
 * Show/Hide Seconds". A native date input draws whatever the respondent's
 * browser locale says, so the format could never be chosen.
 *
 * The answer is always stored the same way — a date as YYYY-MM-DD, a time as
 * 24-hour HH:MM (or HH:MM:SS) — so logic, date bounds, exports and every
 * existing answer read it unchanged. Only what the respondent sees and types
 * follows the format. Pure, so the runtime and the tests use the same rules.
 */

export const DATE_FORMATS = [
  "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "MM-DD-YYYY",
  "DD-MM-YYYY", "YYYY-MM-DD", "DD MMM YYYY", "MMM DD, YYYY",
  /* the month written out (October 2026 review, Date/Time Range) */
  "DD MMMM YYYY", "MMMM DD, YYYY",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A stored date (YYYY-MM-DD) in a display format; "" when it is not a date. */
export function formatDateAs(iso: unknown, fmt: DateFormat | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return "";
  const [, y, mo, d] = m;
  const mon = MONTHS[Number(mo) - 1] ?? mo;
  const month = MONTH_NAMES[Number(mo) - 1] ?? mo;
  switch (fmt ?? "MM/DD/YYYY") {
    case "MM/DD/YYYY": return `${mo}/${d}/${y}`;
    case "DD/MM/YYYY": return `${d}/${mo}/${y}`;
    case "YYYY/MM/DD": return `${y}/${mo}/${d}`;
    case "MM-DD-YYYY": return `${mo}-${d}-${y}`;
    case "DD-MM-YYYY": return `${d}-${mo}-${y}`;
    case "YYYY-MM-DD": return `${y}-${mo}-${d}`;
    case "DD MMM YYYY": return `${d} ${mon} ${y}`;
    case "MMM DD, YYYY": return `${mon} ${d}, ${y}`;
    case "DD MMMM YYYY": return `${d} ${month} ${y}`;
    case "MMMM DD, YYYY": return `${month} ${d}, ${y}`;
  }
}

/** Is y-m-d a real calendar day? (31 February is not.) */
function realDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/**
 * What the respondent typed, in the chosen format, as a stored date — or null
 * when it is not a complete, real date in that format. Day and month may be
 * written with one digit; a month name is matched on its first three letters.
 */
export function parseDateAs(text: string, fmt: DateFormat | undefined): string | null {
  const t = text.trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  const num = (re: RegExp, order: "mdy" | "dmy" | "ymd") => {
    const x = re.exec(t);
    if (!x) return false;
    const [a, b, c] = [Number(x[1]), Number(x[2]), Number(x[3])];
    if (order === "mdy") [m, d, y] = [a, b, c];
    else if (order === "dmy") [d, m, y] = [a, b, c];
    else [y, m, d] = [a, b, c];
    return true;
  };
  /* a month by its name or any start of it from three letters ("Sep", "Sept", "September") — not "Septober" */
  const name = (s: string) => {
    const w = s.toLowerCase();
    const i = MONTH_NAMES.findIndex((mn) => w.length >= 3 && mn.toLowerCase().startsWith(w));
    return i < 0 ? NaN : i + 1;
  };
  let ok = false;
  switch (fmt ?? "MM/DD/YYYY") {
    case "MM/DD/YYYY": ok = num(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, "mdy"); break;
    case "DD/MM/YYYY": ok = num(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, "dmy"); break;
    case "YYYY/MM/DD": ok = num(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, "ymd"); break;
    case "MM-DD-YYYY": ok = num(/^(\d{1,2})-(\d{1,2})-(\d{4})$/, "mdy"); break;
    case "DD-MM-YYYY": ok = num(/^(\d{1,2})-(\d{1,2})-(\d{4})$/, "dmy"); break;
    case "YYYY-MM-DD": ok = num(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, "ymd"); break;
    case "DD MMM YYYY":
    case "DD MMMM YYYY": {
      const x = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(t);
      if (x) { d = Number(x[1]); m = name(x[2]); y = Number(x[3]); ok = true; }
      break;
    }
    case "MMM DD, YYYY":
    case "MMMM DD, YYYY": {
      const x = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
      if (x) { m = name(x[1]); d = Number(x[2]); y = Number(x[3]); ok = true; }
      break;
    }
  }
  if (!ok || !realDay(y!, m!, d!)) return null;
  return `${pad(y!, 4)}-${pad(m!)}-${pad(d!)}`;
}

/** The placeholder that shows the respondent what to type ("DD/MM/YYYY"). */
export function datePlaceholder(fmt: DateFormat | undefined): string {
  return fmt ?? "MM/DD/YYYY";
}

/** A stored time (HH:MM or HH:MM:SS, 24-hour) for display; "" when it is not one. */
export function formatTimeAs(stored: unknown, opts: { hour12?: boolean; seconds?: boolean } = {}): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(stored ?? "").trim());
  if (!m) return "";
  const h = Number(m[1]);
  const sec = opts.seconds ? `:${m[3] ?? "00"}` : "";
  if (opts.hour12) return `${pad(h % 12 === 0 ? 12 : h % 12)}:${m[2]}${sec} ${h >= 12 ? "PM" : "AM"}`;
  return `${pad(h)}:${m[2]}${sec}`;
}

/** Today in the respondent's own calendar (not UTC), as a stored date. */
export function localToday(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The respondent's current clock time as a stored time. */
export function localNow(now: Date = new Date(), seconds = false): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}${seconds ? `:${pad(now.getSeconds())}` : ""}`;
}

/**
 * What a Date / Time Picker starts with, before the respondent touches it:
 * nothing, their own today / now, or the programmer's fixed value. Read when
 * the question is first shown, so "current" is the respondent's day, not the
 * day the survey was written.
 */
export function initialDateValue(settings: { defaultDateMode?: string; defaultDate?: string }, now?: Date): string | null {
  if (settings.defaultDateMode === "current") return localToday(now);
  if (settings.defaultDateMode === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(settings.defaultDate ?? "")) return settings.defaultDate!;
  return null;
}
export function initialTimeValue(settings: { defaultTimeMode?: string; defaultTime?: string; showSeconds?: boolean }, now?: Date): string | null {
  if (settings.defaultTimeMode === "current") return localNow(now, !!settings.showSeconds);
  if (settings.defaultTimeMode === "custom" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(settings.defaultTime ?? "")) return settings.defaultTime!;
  return null;
}

/* ------------------------------------------------ date-time and duration (QT-12) */

const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A DATE AND A TIME, as the `datetime.datetime` variant stores it: an ISO
 * local date-time, "YYYY-MM-DDTHH:MM" (or with seconds), no zone — the
 * respondent's wall clock, exactly like the date and time pickers store
 * theirs. Null when the text is not one, or names a day or hour that does
 * not exist ("2026-02-30T10:00", "…T25:00").
 */
export function parseLocalDateTime(stored: unknown): { date: string; time: string; ms: number } | null {
  const m = LOCAL_DT.exec(String(stored ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "00"].map(Number);
  if (!realDay(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  // compared as a naive wall-clock instant, the same footing a date-only bound ("2026-01-01" = UTC midnight) stands on
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ""}`, ms: Date.UTC(y, mo - 1, d, h, mi, s) };
}
export function isLocalDateTime(stored: unknown): boolean {
  return parseLocalDateTime(stored) != null;
}

/** A stored date-time for display, in the question's date and time formats; "" when it is not one. */
export function formatDateTimeAs(stored: unknown, fmt: DateFormat | undefined, opts: { hour12?: boolean; seconds?: boolean } = {}): string {
  const p = parseLocalDateTime(stored);
  return p ? `${formatDateAs(p.date, fmt)} ${formatTimeAs(p.time, opts)}` : "";
}

/** Which parts a duration is entered in: hours-minutes-seconds, hours-minutes, minutes-seconds. */
export type DurationParts = "hms" | "hm" | "ms";

/**
 * A DURATION IN SECONDS, split into the parts the respondent types. The
 * leading part carries the overflow — 2 h 30 min entered as minutes and
 * seconds is 150 min 0 s — so nothing is lost by the choice of parts.
 */
export function splitDuration(seconds: unknown, parts: DurationParts = "hms"): { h: number; m: number; s: number } | null {
  if (seconds == null || seconds === "") return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  const total = Math.round(n);
  if (parts === "ms") return { h: 0, m: Math.floor(total / 60), s: total % 60 };
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (parts === "hm") return { h, m: m + Math.round((total % 60) / 60), s: 0 };
  return { h, m, s: total % 60 };
}

/** The parts back to seconds; null when every part is empty. */
export function joinDuration(h: number | null | undefined, m: number | null | undefined, s: number | null | undefined): number | null {
  if (h == null && m == null && s == null) return null;
  return Math.max(0, Math.round((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)));
}

/** A duration for people: "1 h 30 min", "45 s", "0 s". Seconds are whole. */
export function formatDuration(seconds: unknown, parts: DurationParts = "hms"): string {
  const d = splitDuration(seconds, parts);
  if (!d) return "";
  const out: string[] = [];
  if (d.h) out.push(`${d.h} h`);
  if (d.m) out.push(`${d.m} min`);
  if (d.s) out.push(`${d.s} s`);
  return out.length ? out.join(" ") : parts === "hm" ? "0 min" : "0 s";
}

/**
 * Typed text to seconds — what a pasted or posted duration may look like:
 * "5400", "1:30:00", "90:00" (min:sec), "1h 30m", "1 h 30 min 15 s", "45s".
 * A bare number is seconds, the unit the answer is stored in. Null when the
 * text is not a duration.
 */
export function parseDuration(text: unknown): number | null {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] == null ? null : Number(clock[3])];
    if (b > 59 || (c != null && c > 59)) return null;
    return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const re = /(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?![a-z])/g;
  let total = 0, seen = 0, used = "";
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const unit = m[2][0];
    total += Number(m[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
    seen++; used += m[0];
  }
  return seen && used.replace(/\s/g, "") === t.replace(/[\s,]/g, "") ? Math.round(total) : null;
}
