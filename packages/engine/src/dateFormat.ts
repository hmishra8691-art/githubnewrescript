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
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A stored date (YYYY-MM-DD) in a display format; "" when it is not a date. */
export function formatDateAs(iso: unknown, fmt: DateFormat | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return "";
  const [, y, mo, d] = m;
  const mon = MONTHS[Number(mo) - 1] ?? mo;
  switch (fmt ?? "MM/DD/YYYY") {
    case "MM/DD/YYYY": return `${mo}/${d}/${y}`;
    case "DD/MM/YYYY": return `${d}/${mo}/${y}`;
    case "YYYY/MM/DD": return `${y}/${mo}/${d}`;
    case "MM-DD-YYYY": return `${mo}-${d}-${y}`;
    case "DD-MM-YYYY": return `${d}-${mo}-${y}`;
    case "YYYY-MM-DD": return `${y}-${mo}-${d}`;
    case "DD MMM YYYY": return `${d} ${mon} ${y}`;
    case "MMM DD, YYYY": return `${mon} ${d}, ${y}`;
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
  const name = (s: string) => {
    const i = MONTHS.findIndex((mn) => mn.toLowerCase() === s.slice(0, 3).toLowerCase());
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
    case "DD MMM YYYY": {
      const x = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(t);
      if (x) { d = Number(x[1]); m = name(x[2]); y = Number(x[3]); ok = true; }
      break;
    }
    case "MMM DD, YYYY": {
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
