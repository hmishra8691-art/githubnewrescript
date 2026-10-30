/**
 * S1c (audit D11 / SE-30) — LIVE SCRIPT HEALTH. What a survey's code did wrong in the field, so the researcher learns
 * a script is broken from the Studio rather than from a respondent's console.
 *
 * The runtime counts every script failure of a respondent session — a UX script's error, a logic script's error or
 * timeout, a Custom Component that "could not run", a code-gate refusal at run time, a refused write request, a
 * refused navigation, a watchdog stop, a lifecycle (validate / submit) handler that did not answer — one entry per
 * (script, kind, page), with the FIRST message (≤ 200 chars, answer text removed) and a count. It travels with every
 * save as `scriptHealth`; the save route sanitises it (`sanitizeScriptHealth`, again redacting the posted answers)
 * and stores it in `responses.telemetry.scriptHealth` REGARDLESS of the survey's telemetry switches: it describes the
 * survey's code, not the respondent (no timing, no device beyond a browser class, no answer).
 *
 * The Studio's script-health view reads it back over the survey's responses (`aggregateScriptHealth`).
 *
 * Pure: shared by the runtime collector, the save route and the Studio route; never throws.
 */

export const SCRIPT_HEALTH_KINDS = [
  "ux_error",           // a UX script threw, or called rs.error outside validate
  "logic_error",        // a Scripts-panel script threw
  "logic_timeout",      // a logic run did not answer within its bound (nothing written)
  "lifecycle_timeout",  // a UX validate / submit handler did not answer within its bound
  "component_not_run",  // a Custom Component's code was refused or its element was missing
  "gate_refused",       // the code gate refused a script at run time (it never ran)
  "write_refused",      // the engine refused a write request (rs.setAnswer, set(), …)
  "navigation_refused", // rs.goToPage / rs.goToSection refused
  "watchdog",           // a frame was stopped: not responding, or too many commands a second
] as const;
export type ScriptHealthKind = (typeof SCRIPT_HEALTH_KINDS)[number];

export interface ScriptHealthEntry {
  /** the script's id (UX behaviour id, Scripts-panel script id, `uxb_component_<question id>`) — or its name when no id is known */
  script: string;
  /** what the author called it */
  name?: string;
  kind: ScriptHealthKind;
  /** the page it happened on (page id, without a loop suffix) */
  page?: string;
  /** the first message, ≤ 200 chars, answer text removed */
  message: string;
  /** how often in this session */
  count: number;
  /** coarse browser class: "Chrome desktop", "Safari mobile" … */
  browser?: string;
}

export const SCRIPT_HEALTH_LIMITS = { entries: 50, message: 200, id: 120, name: 120, page: 120, browser: 40, count: 100_000 } as const;

const KIND_SET = new Set<string>(SCRIPT_HEALTH_KINDS);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(CONTROL, " ").trim().slice(0, n);

/** the strings an answer holds (codes and typed text alike), for redaction */
function answerStrings(values: unknown, out: Set<string>, depth = 0): void {
  if (values == null || depth > 4 || out.size > 2000) return;
  if (typeof values === "string") { const t = values.trim(); if (t.length >= 3) out.add(t); return; }
  if (typeof values === "number") { const t = String(values); if (t.length >= 4) out.add(t); return; }
  if (Array.isArray(values)) { for (const v of values.slice(0, 200)) answerStrings(v, out, depth + 1); return; }
  if (typeof values === "object") for (const v of Object.values(values as Record<string, unknown>).slice(0, 2000)) answerStrings(v, out, depth + 1);
}

/** the redaction set of a response: every answer and embedded value of 3+ characters (numbers of 4+ digits) */
export function redactionSet(...sources: unknown[]): string[] {
  const out = new Set<string>();
  for (const s of sources) answerStrings(s, out);
  // longest first, so "Jane Smith" goes before "Jane"
  return [...out].sort((a, b) => b.length - a.length);
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const LONG_DIGITS = /\d{6,}/g;

/**
 * A message as it may be stored: control characters out, every answer / embedded value replaced by "…", e-mail
 * addresses and long digit runs (phone numbers, ids) replaced too, then cut to 200 characters.
 */
export function redactScriptMessage(message: unknown, redact: string[] = []): string {
  let m = clip(message, 2000);
  for (const r of redact) if (r && m.includes(r)) m = m.split(r).join("…");
  m = m.replace(EMAIL, "…").replace(LONG_DIGITS, "…");
  return m.slice(0, SCRIPT_HEALTH_LIMITS.message);
}

const entryKey = (e: Pick<ScriptHealthEntry, "script" | "kind" | "page">) => `${e.script}\u0000${e.kind}\u0000${e.page ?? ""}`;

/**
 * The save route's check of a posted list: shape, bounds, a known kind, the message redacted again against what the
 * save itself carries (`redact`, from `redactionSet(answers, embedded)`). Unknown fields are dropped; duplicates of
 * one (script, kind, page) are merged. Anything that is not a list → [].
 */
export function sanitizeScriptHealth(raw: unknown, redact: string[] = []): ScriptHealthEntry[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, ScriptHealthEntry>();
  for (const x of raw.slice(0, SCRIPT_HEALTH_LIMITS.entries * 2)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    const script = clip(o.script, SCRIPT_HEALTH_LIMITS.id);
    if (!KIND_SET.has(kind) || !script) continue;
    const count = Math.max(1, Math.min(SCRIPT_HEALTH_LIMITS.count, Math.floor(Number(o.count) || 1)));
    const e: ScriptHealthEntry = { script, kind: kind as ScriptHealthKind, message: redactScriptMessage(o.message, redact), count };
    const name = clip(o.name, SCRIPT_HEALTH_LIMITS.name); if (name) e.name = redactScriptMessage(name, redact).slice(0, SCRIPT_HEALTH_LIMITS.name);
    const page = clip(o.page, SCRIPT_HEALTH_LIMITS.page); if (page) e.page = page;
    const browser = clip(o.browser, SCRIPT_HEALTH_LIMITS.browser); if (browser) e.browser = browser;
    const k = entryKey(e);
    const had = out.get(k);
    if (had) had.count = Math.min(SCRIPT_HEALTH_LIMITS.count, had.count + e.count);
    else if (out.size < SCRIPT_HEALTH_LIMITS.entries) out.set(k, e);
  }
  return [...out.values()];
}

/**
 * Keep what a session reported before (a reload starts the collector from zero): per (script, kind, page) the
 * larger count, the earlier entry's message. Bounded like a posted list.
 */
export function mergeScriptHealth(stored: unknown, posted: ScriptHealthEntry[]): ScriptHealthEntry[] {
  const prior = sanitizeScriptHealth(stored);
  if (!prior.length) return posted;
  const out = new Map(prior.map((e) => [entryKey(e), { ...e }]));
  for (const e of posted) {
    const had = out.get(entryKey(e));
    if (had) had.count = Math.max(had.count, e.count);
    else if (out.size < SCRIPT_HEALTH_LIMITS.entries) out.set(entryKey(e), e);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ the researcher's view */

export interface ScriptHealthRow {
  /** responses.telemetry (or the sandbox row's script_health): `{ scriptHealth: ScriptHealthEntry[] }` */
  telemetry?: unknown;
  /** when the row was last saved (ISO) */
  last_saved_at?: string | null;
  started_at?: string | null;
}

export interface ScriptHealthScript {
  script: string;
  name: string;
  /** total failures counted (all kinds) */
  failures: number;
  /** sessions with at least one failure of this script */
  sessions: number;
  /** the latest save of a session that reported it (ISO) */
  lastSeen: string | null;
  kinds: Partial<Record<ScriptHealthKind, number>>;
  /** the most frequent messages, at most 5 */
  messages: { message: string; kind: ScriptHealthKind; count: number }[];
  pages: string[];
  browsers: string[];
}

export interface ScriptHealthSummary {
  /** sessions read */
  sessions: number;
  /** sessions with any failure */
  affected: number;
  scripts: ScriptHealthScript[];
}

/** the stored entries of one row (`telemetry.scriptHealth`), tolerant of anything */
export function scriptHealthOf(telemetry: unknown): ScriptHealthEntry[] {
  if (!telemetry || typeof telemetry !== "object") return [];
  return sanitizeScriptHealth((telemetry as { scriptHealth?: unknown }).scriptHealth);
}

/** per script over the survey's sessions: failures, sessions affected, last seen, top messages, pages */
export function aggregateScriptHealth(rows: ScriptHealthRow[]): ScriptHealthSummary {
  const by = new Map<string, ScriptHealthScript & { msg: Map<string, { message: string; kind: ScriptHealthKind; count: number }>; pageSet: Set<string>; browserSet: Set<string> }>();
  let affected = 0;
  for (const row of rows) {
    const entries = scriptHealthOf(row.telemetry);
    if (!entries.length) continue;
    affected++;
    const when = row.last_saved_at ?? row.started_at ?? null;
    const seen = new Set<string>();
    for (const e of entries) {
      let s = by.get(e.script);
      if (!s) { s = { script: e.script, name: e.name ?? e.script, failures: 0, sessions: 0, lastSeen: null, kinds: {}, messages: [], pages: [], browsers: [], msg: new Map(), pageSet: new Set(), browserSet: new Set() }; by.set(e.script, s); }
      if (e.name && s.name === s.script) s.name = e.name;
      s.failures += e.count;
      s.kinds[e.kind] = (s.kinds[e.kind] ?? 0) + e.count;
      if (!seen.has(e.script)) { seen.add(e.script); s.sessions++; if (when && (!s.lastSeen || when > s.lastSeen)) s.lastSeen = when; }
      const mk = `${e.kind}\u0000${e.message}`;
      const m = s.msg.get(mk);
      if (m) m.count += e.count; else s.msg.set(mk, { message: e.message, kind: e.kind, count: e.count });
      if (e.page) s.pageSet.add(e.page);
      if (e.browser) s.browserSet.add(e.browser);
    }
  }
  const scripts = [...by.values()].map(({ msg, pageSet, browserSet, ...s }) => ({
    ...s,
    messages: [...msg.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    pages: [...pageSet].sort().slice(0, 20),
    browsers: [...browserSet].sort().slice(0, 10),
  })).sort((a, b) => b.sessions - a.sessions || b.failures - a.failures || a.name.localeCompare(b.name));
  return { sessions: rows.length, affected, scripts };
}

/** one chip's words: "no errors in N sessions" / "failed in K of N sessions" */
export function scriptHealthChipText(summary: Pick<ScriptHealthSummary, "sessions">, script: Pick<ScriptHealthScript, "sessions"> | undefined): string {
  const n = summary.sessions;
  const sess = (k: number) => `${k.toLocaleString("en-US")} session${k === 1 ? "" : "s"}`;
  if (!script || !script.sessions) return n ? `no errors in ${sess(n)}` : "no sessions yet";
  return `failed in ${script.sessions.toLocaleString("en-US")} of ${sess(n)}`;
}
