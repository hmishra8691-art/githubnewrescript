/**
 * SCHEDULING LIVE HUMAN-MODERATED SESSIONS IN WORDS (2026-10-22, G2).
 *
 * "schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments" → a request the Studio
 * shows as a PREVIEW card (each session's local time, its UTC instant, its size and segment) and creates only when
 * the researcher presses the button. The engine only reads the sentence (deterministic, no model) and turns a
 * local date and time in a named time zone into an instant (Intl, no dependency). Pure; `now` is injected.
 *
 * Read honestly: a day or a time the sentence does not give is left out (the card asks for it), "next Tuesday" is
 * the first Tuesday after today in the session's time zone (the card prints the date), and abbreviations are read
 * as the IANA zone named on the card (EST → America/New_York, which follows daylight saving).
 */

export type LiveKind = "focus_group" | "interview";
export interface LiveDaySpec { weekday?: number; offsetDays?: number; date?: { y: number; m: number; d: number } }
export interface LiveScheduleRequest {
  op: "schedule_live";
  text: string;
  count: number;
  kind: LiveKind;
  /** participants per session (1 for an IDI) */
  size: number;
  day?: LiveDaySpec;
  time?: { h: number; min: number };
  timeZone?: string;
  /** what the sentence called the zone ("IST") */
  zoneLabel?: string;
  segments: string[];
  durationMinutes: number;
  parallel: boolean;
  record: boolean;
  recordVideo: boolean;
  title?: string;
}

const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const num = (s: string | undefined): number | undefined => (s == null ? undefined : /^\d+$/.test(s) ? Number(s) : WORD_NUM[s.toLowerCase()]);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** abbreviations and names → the IANA zone used (shown on the card) */
export const ZONE_ALIASES: Record<string, string> = {
  ist: "Asia/Kolkata", "india time": "Asia/Kolkata", "indian time": "Asia/Kolkata",
  utc: "UTC", gmt: "Europe/London", bst: "Europe/London", "uk time": "Europe/London", "london time": "Europe/London",
  cet: "Europe/Paris", cest: "Europe/Paris", "paris time": "Europe/Paris", "berlin time": "Europe/Berlin",
  est: "America/New_York", edt: "America/New_York", et: "America/New_York", "eastern time": "America/New_York", "new york time": "America/New_York",
  cst: "America/Chicago", cdt: "America/Chicago", "central time": "America/Chicago",
  mst: "America/Denver", mdt: "America/Denver", "mountain time": "America/Denver",
  pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pt: "America/Los_Angeles", "pacific time": "America/Los_Angeles",
  sgt: "Asia/Singapore", "singapore time": "Asia/Singapore", jst: "Asia/Tokyo", "tokyo time": "Asia/Tokyo",
  aest: "Australia/Sydney", aedt: "Australia/Sydney", "sydney time": "Australia/Sydney",
  gst: "Asia/Dubai", "dubai time": "Asia/Dubai", pkt: "Asia/Karachi", wib: "Asia/Jakarta", hkt: "Asia/Hong_Kong", cat: "Africa/Maputo", eat: "Africa/Nairobi", wat: "Africa/Lagos", sast: "Africa/Johannesburg", brt: "America/Sao_Paulo",
};

/** true when Intl knows the zone */
export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** the zone's offset from UTC (minutes) at an instant */
export function zoneOffsetMinutes(atMs: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(atMs))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

/** a wall-clock time in a zone → the UTC instant (ms); the second pass settles a DST edge */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - zoneOffsetMinutes(guess, timeZone) * 60000;
  t = guess - zoneOffsetMinutes(t, timeZone) * 60000;
  return t;
}

/** the calendar date (and weekday) an instant falls on in a zone */
export function zonedDate(atMs: number, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const local = new Date(atMs + zoneOffsetMinutes(atMs, timeZone) * 60000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), weekday: local.getUTCDay() };
}

/** "6 pm", "6:30pm", "18:00", "at 6" (evening hours read as pm only with pm / evening) */
function readTime(t: string): { h: number; min: number } | undefined {
  let m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i.exec(t);
  if (m) { let h = Number(m[1]) % 12; if (/^p/i.test(m[3])) h += 12; const min = Number(m[2] ?? 0); return h < 24 && min < 60 ? { h, min } : undefined; }
  m = /\b(?:at\s+)?([01]?\d|2[0-3])[:h]([0-5]\d)\b/i.exec(t);
  if (m) return { h: Number(m[1]), min: Number(m[2]) };
  m = /\bat\s+(\d{1,2})(?:\s*o'?clock)?(\s+in\s+the\s+(?:evening|afternoon))?\b(?!\s*(?:participants|people|minutes|hours|%))/i.exec(t);
  if (m) { let h = Number(m[1]); if (m[2] && h < 12) h += 12; return h < 24 ? { h, min: 0 } : undefined; }
  if (/\bnoon\b/i.test(t)) return { h: 12, min: 0 };
  return undefined;
}

function readDay(t: string): LiveDaySpec | undefined {
  if (/\btoday\b|\btonight\b/i.test(t)) return { offsetDays: 0 };
  if (/\btomorrow\b/i.test(t)) return { offsetDays: 1 };
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return { date: { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } };
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})[a-z]*\\.?(?:\\s+(\\d{4}))?\\b`, "i").exec(t);
  if (m) return { date: { y: m[3] ? Number(m[3]) : 0, m: MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1, d: Number(m[1]) } };
  m = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(t);
  if (m) return { date: { y: m[3] ? Number(m[3]) : 0, m: MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1, d: Number(m[2]) } };
  m = new RegExp(`\\b(?:(next|this|coming|on)\\s+)?(${WEEKDAYS.join("|")}|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\\b`, "i").exec(t);
  if (m) {
    const w = m[2].toLowerCase();
    const idx = WEEKDAYS.findIndex((d) => d.startsWith(w.slice(0, 3)));
    if (idx >= 0) return { weekday: idx };
  }
  if (/\bnext\s+week\b/i.test(t)) return { offsetDays: 7 };
  return undefined;
}

function readZone(t: string): { tz: string; label: string } | undefined {
  const iana = /\b([A-Z][a-z]+\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?)\b/.exec(t);
  if (iana && validTimeZone(iana[1])) return { tz: iana[1], label: iana[1] };
  const lower = t.toLowerCase();
  for (const name of Object.keys(ZONE_ALIASES).filter((k) => k.includes(" ")).sort((a, b) => b.length - a.length)) if (lower.includes(name)) return { tz: ZONE_ALIASES[name], label: name };
  const m = /\b(IST|UTC|GMT|BST|CEST|CET|EST|EDT|ET|CST|CDT|MST|MDT|PST|PDT|PT|SGT|JST|AEST|AEDT|GST|PKT|WIB|HKT|CAT|EAT|WAT|SAST|BRT)\b/.exec(t);
  if (m) return { tz: ZONE_ALIASES[m[1].toLowerCase()], label: m[1] };
  return undefined;
}

function readSegments(t: string): string[] {
  const clean = (s: string) => s.replace(/^(?:the|a|an|one)\s+/i, "").replace(/\s+(?:participants?|people|respondents?)$/i, "").trim();
  const split = (s: string) => s.split(/\s*(?:,|\band\b|&|\/|\bplus\b)\s*/i).map(clean).filter((x) => x && x.length <= 60 && !/^(?:each|both|all|them)$/i.test(x));
  let m = /\bwith\s+(.{2,120}?)\s+(?:segments?|groups?\s+(?:of\s+participants|segments?)|cohorts?|audiences?)\b/i.exec(t);
  if (m) return split(m[1]);
  m = /\b(?:segments?|cohorts?)\s*[:=]?\s+(.{2,120}?)(?:$|\s+(?:at|on|next|for|with)\b)/i.exec(t);
  if (m) return split(m[1]);
  m = /\bone\s+(?:with|for|in)\s+(.{2,40}?)\s+and\s+one\s+(?:with|for|in)\s+(.{2,40}?)(?:\s+(?:participants|people))?(?=$|[,.]|\s+(?:at|on|next)\b)/i.exec(t);
  if (m) return [clean(m[1]), clean(m[2])];
  return [];
}

/**
 * "schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments" → the request, or null
 * when the sentence is not about scheduling LIVE human-moderated sessions (AI-moderated interviews and text group
 * sessions are other requests).
 */
export function interpretLiveSchedule(raw: string): LiveScheduleRequest | null {
  const text = String(raw ?? "").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 400 || /\n/.test(String(raw ?? ""))) return null;
  const kindWord = /\b(focus[\s-]?groups?|fgds?|idis?|in[\s-]?depth\s+interviews?|depth\s+interviews?|(?:live|video|moderated|human[\s-]moderated|1[:-]1|one[\s-]on[\s-]one)\s+(?:interviews?|sessions?|calls?)|interviews?|live\s+sessions?|video\s+sessions?)\b/i.exec(text);
  if (!kindWord) return null;
  /* "schedule / book / arrange" is scheduling; "set up / run / host live …" only with a day or a time — "run two moderated
     focus groups before the survey" is a study design the copilot answers, not a booking */
  const schedule = /\b(?:schedule|book|arrange)\b/i.test(text);
  const setUpLive = /\b(?:set\s+up|run|host|organi[sz]e|create)\b/i.test(text) && /\b(?:live|video|moderated|human)\b/i.test(text) && !!(readDay(text) || readTime(text));
  if (!schedule && !setUpLive) return null;
  /* AI-moderated interviews and text group sessions are other features */
  if (/\b(?:ai[\s-]?(?:moderated|moderator|led|run|voice|video|text|chat)?\s*interviews?|by\s+the\s+ai|ai\s+moderat\w*|text\s+(?:group|session|discussion)|group\s+session|remesh)\b/i.test(text) && !/\bhuman\b/i.test(text)) return null;
  /* the survey's own settings ("schedule the reminder e-mails for the interviews survey") are not sessions */
  if (/\b(?:reminders?|e-?mails?|quotas?|questions?|invitations?|fieldwork)\b/i.test(text.slice(0, kindWord.index)) && !/\b(?:live|video|moderated)\b/i.test(text)) return null;
  const kw = kindWord[1].toLowerCase();
  const kind: LiveKind = /focus|fgd|session|calls?/.test(kw) && !/interview|idi|1[:-]1|one[\s-]on/.test(kw) ? "focus_group" : "interview";
  const before = text.slice(0, kindWord.index);
  const cm = /\b(\d{1,2}|a|an|one|single|two|couple(?:\s+of)?|pair\s+of|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:live|video|moderated|online|virtual|in[\s-]depth|more|separate|evening|morning)\s+)*$/i.exec(before);
  const count = Math.max(1, Math.min(12, num(cm?.[1]?.replace(/\s+of$/i, "")) ?? 1));
  let size = kind === "interview" ? 1 : 6;
  const sm = /\b(?:of|with)\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(?:participants?|people|respondents?|each|members?))?\b(?!\s*(?:pm|am|minutes?|mins?|hours?|%|:))/i.exec(text.slice(kindWord.index))
    ?? /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:participants?|people|respondents?)(?:\s+(?:each|per\s+(?:group|session)))?\b/i.exec(text);
  if (sm && kind === "focus_group") size = Math.max(1, Math.min(12, num(sm[1]) ?? size));
  const dm = /\b(\d{2,3})\s*(?:minutes?|mins?)\b|\b(\d(?:\.\d)?|one|two|an?)\s*(?:hours?|hrs?)\b/i.exec(text);
  const durationMinutes = dm ? (dm[1] ? Number(dm[1]) : Math.round((num(dm[2]) ?? (dm[2] === "a" || dm[2] === "an" ? 1 : Number(dm[2]))) * 60)) : (kind === "focus_group" ? 90 : 60);
  const zone = readZone(text);
  const time = readTime(text);
  const day = readDay(text);
  const tm = /\b(?:called|named|titled)\s+[“"']?(.{2,80}?)[”"']?$/i.exec(text);
  return {
    op: "schedule_live", text, count, kind, size,
    ...(day ? { day } : {}), ...(time ? { time } : {}), ...(zone ? { timeZone: zone.tz, zoneLabel: zone.label } : {}),
    segments: readSegments(text),
    durationMinutes: Math.max(15, Math.min(240, durationMinutes || 90)),
    parallel: /\b(?:at\s+the\s+same\s+time|in\s+parallel|simultaneous(?:ly)?|concurrent(?:ly)?)\b/i.test(text),
    record: !/\b(?:no|without|don'?t|do\s+not)\s+record(?:ing)?\b/i.test(text),
    recordVideo: /\b(?:record(?:ing)?\s+(?:the\s+)?video|video\s+recording|with\s+video\s+recorded)\b/i.test(text),
    ...(tm ? { title: tm[1].trim() } : {}),
  };
}

export interface ResolvedLiveSession { index: number; title: string; segment?: string; size: number; startsAt: string; localDate: string; localTime: string; endsLocalTime: string; timeZone: string; durationMinutes: number }
export interface ResolvedLiveSchedule { sessions: ResolvedLiveSession[]; timeZone: string; problems: string[]; notes: string[] }

const pad = (n: number) => String(n).padStart(2, "0");

/** the request's sessions as instants, in the request's zone (else the fallback zone) — problems say what is missing */
export function resolveLiveSchedule(r: LiveScheduleRequest, o: { now: number; fallbackTimeZone?: string; baseTitle?: string; meshMaxParticipants?: number }): ResolvedLiveSchedule {
  const problems: string[] = [];
  const notes: string[] = [];
  const tz = r.timeZone && validTimeZone(r.timeZone) ? r.timeZone : (o.fallbackTimeZone && validTimeZone(o.fallbackTimeZone) ? o.fallbackTimeZone : "UTC");
  if (!r.timeZone) notes.push(`No time zone named — read as ${tz}.`);
  else if (r.zoneLabel && r.zoneLabel !== tz) notes.push(`${r.zoneLabel} read as ${tz}${/^(?:EST|CST|MST|PST|ET|PT)$/i.test(r.zoneLabel) ? " (follows daylight saving)" : ""}.`);
  if (!r.day) problems.push("Which day? Name one (e.g. “next Tuesday”, “3 Nov”).");
  if (!r.time) problems.push("What time? Name one (e.g. “6 pm”).");
  const today = zonedDate(o.now, tz);
  let date: { y: number; m: number; d: number } | null = null;
  if (r.day?.date) {
    const d = r.day.date;
    let y = d.y || today.y;
    if (!d.y && Date.UTC(y, d.m - 1, d.d) < Date.UTC(today.y, today.m - 1, today.d)) y += 1;
    date = { y, m: d.m, d: d.d };
    const check = new Date(Date.UTC(date.y, date.m - 1, date.d));
    if (check.getUTCMonth() !== date.m - 1) { problems.push("That date does not exist."); date = null; }
  } else if (r.day) {
    const base = Date.UTC(today.y, today.m - 1, today.d);
    const add = r.day.weekday != null ? ((r.day.weekday - today.weekday + 7) % 7 || 7) : (r.day.offsetDays ?? 0);
    const t = new Date(base + add * 86400000);
    date = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const sessions: ResolvedLiveSession[] = [];
  if (date && r.time) {
    const first = zonedToUtc(date.y, date.m, date.d, r.time.h, r.time.min, tz);
    if (first < o.now) problems.push("That time has already passed.");
    const gap = r.parallel ? 0 : (r.durationMinutes + 30) * 60000;
    for (let i = 0; i < r.count; i++) {
      const at = first + i * gap;
      const local = zonedDate(at, tz);
      const off = zoneOffsetMinutes(at, tz);
      const lt = new Date(at + off * 60000);
      const end = new Date(at + (r.durationMinutes + off) * 60000);
      const segment = r.segments.length ? r.segments[i % r.segments.length] : undefined;
      const base = o.baseTitle?.trim() || (r.kind === "focus_group" ? "Focus group" : "Interview");
      sessions.push({
        index: i + 1, title: r.title && r.count === 1 ? r.title : `${r.title ?? base} ${i + 1}${segment ? ` — ${segment}` : ""}`.slice(0, 200), ...(segment ? { segment } : {}), size: r.size,
        startsAt: new Date(at).toISOString(), localDate: `${local.y}-${pad(local.m)}-${pad(local.d)}`, localTime: `${pad(lt.getUTCHours())}:${pad(lt.getUTCMinutes())}`, endsLocalTime: `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`, timeZone: tz, durationMinutes: r.durationMinutes,
      });
    }
    if (r.count > 1 && !r.parallel) notes.push(`One after the other, ${r.durationMinutes + 30} minutes apart (say “at the same time” to run them in parallel).`);
  }
  if (r.segments.length && r.segments.length !== r.count) notes.push(`${r.segments.length} segment${r.segments.length === 1 ? "" : "s"} for ${r.count} session${r.count === 1 ? "" : "s"} — assigned in turn.`);
  const mesh = o.meshMaxParticipants ?? 6;
  if (r.size > mesh) notes.push(`${r.size} participants is more than the built-in browser connection carries well (${mesh}); it needs the LiveKit option (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).`);
  return { sessions, timeZone: tz, problems, notes };
}

export function describeLiveSchedule(r: LiveScheduleRequest): string {
  const what = r.kind === "focus_group" ? `focus group${r.count === 1 ? "" : "s"} of ${r.size}` : `in-depth interview${r.count === 1 ? "" : "s"}`;
  return `Schedule ${r.count} live ${what}${r.segments.length ? ` (${r.segments.join(", ")})` : ""}, moderated by you in the browser.`;
}
