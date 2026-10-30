/**
 * S1c (audit D11 / SE-30) — THE RESPONDENT SESSION'S SCRIPT-HEALTH COLLECTOR.
 *
 * Every script failure the Runner sees — a UX script's error, a logic script's error or timeout, a Custom Component
 * that could not run, a code-gate refusal at run time, a refused write request or navigation, a watchdog stop, a
 * validate / submit handler that did not answer — is counted here, one entry per (script, kind, page): the first
 * message (answer text removed, ≤ 200 chars), a count and the browser class. At most 50 entries a session; past
 * that, new (script, kind, page) triples are only counted in `dropped`.
 *
 * The list travels with every save as `scriptHealth` (the save route sanitises it again and stores it in
 * `responses.telemetry.scriptHealth` whatever the survey's telemetry switches say — it describes the survey's code,
 * not the respondent). Shape and redaction are the engine's (`scriptHealth.ts`).
 */
import { redactScriptMessage, sanitizeScriptHealth, SCRIPT_HEALTH_LIMITS, type ScriptHealthEntry, type ScriptHealthKind } from "@rescript/engine";

export interface ScriptIssue {
  /** the script's id (or its name when no id is known) */
  script: string;
  name?: string;
  kind: ScriptHealthKind;
  message: string;
  /** defaults to the collector's current page */
  page?: string;
}

export interface ScriptHealthCollector {
  note(issue: ScriptIssue): void;
  /** the page the next issues happened on (page id; a loop suffix is cut) */
  setPage(pageId: string | null | undefined): void;
  /** the entries so far (copies) */
  list(): ScriptHealthEntry[];
  /** issues not kept because the list was full */
  readonly dropped: number;
}

/** "Chrome desktop", "Safari mobile" — the browser class only */
export function browserClass(device: { browser?: string; type?: string } | null | undefined): string | undefined {
  if (!device?.browser) return undefined;
  return `${device.browser}${device.type && device.type !== "unknown" ? ` ${device.type}` : ""}`.slice(0, SCRIPT_HEALTH_LIMITS.browser);
}

export function createScriptHealthCollector(opts: {
  browser?: string;
  /** the response's answer / embedded strings at the moment of the issue (engine `redactionSet`) */
  redact?: () => string[];
  cap?: number;
  /** what this session counted before a reload (`restore`) */
  initial?: ScriptHealthEntry[];
  /** called after every change (the Runner keeps the list in sessionStorage, so a reload does not lose it) */
  onChange?: (entries: ScriptHealthEntry[]) => void;
} = {}): ScriptHealthCollector {
  const cap = Math.min(opts.cap ?? SCRIPT_HEALTH_LIMITS.entries, SCRIPT_HEALTH_LIMITS.entries);
  const entries = new Map<string, ScriptHealthEntry>();
  for (const e of sanitizeScriptHealth(opts.initial ?? []).slice(0, cap)) entries.set(`${e.script}\u0000${e.kind}\u0000${e.page ?? ""}`, e);
  const changed = () => { try { opts.onChange?.([...entries.values()]); } catch { /* storage full or blocked */ } };
  let page: string | undefined;
  let dropped = 0;
  return {
    setPage(p) { page = p ? String(p).split("@")[0]!.slice(0, SCRIPT_HEALTH_LIMITS.page) : undefined; },
    note(i) {
      const script = String(i.script ?? "").trim().slice(0, SCRIPT_HEALTH_LIMITS.id);
      if (!script) return;
      const pg = i.page ? String(i.page).split("@")[0]!.slice(0, SCRIPT_HEALTH_LIMITS.page) : page;
      const key = `${script}\u0000${i.kind}\u0000${pg ?? ""}`;
      const had = entries.get(key);
      if (had) { had.count = Math.min(SCRIPT_HEALTH_LIMITS.count, had.count + 1); changed(); return; }
      if (entries.size >= cap) { dropped++; return; }
      let redact: string[] = [];
      try { redact = opts.redact?.() ?? []; } catch { /* nothing to redact against */ }
      const e: ScriptHealthEntry = { script, kind: i.kind, message: redactScriptMessage(i.message, redact), count: 1 };
      if (i.name) e.name = redactScriptMessage(i.name, redact).slice(0, SCRIPT_HEALTH_LIMITS.name);
      if (pg) e.page = pg;
      if (opts.browser) e.browser = opts.browser;
      entries.set(key, e);
      changed();
    },
    list: () => [...entries.values()].map((e) => ({ ...e })),
    get dropped() { return dropped; },
  };
}

/*
 * One collector per respondent session in this tab, so the save body (built outside the component) can carry it:
 * `scriptHealthPayload(sessionId)` is what `saveBody` sends as `scriptHealth`.
 */
const bySession = new Map<string, ScriptHealthCollector>();
export function sessionScriptHealth(key: string, make: () => ScriptHealthCollector): ScriptHealthCollector {
  let c = bySession.get(key);
  if (!c) { c = make(); bySession.set(key, c); if (bySession.size > 20) bySession.delete(bySession.keys().next().value as string); }
  return c;
}
export function scriptHealthPayload(key: string | undefined): ScriptHealthEntry[] | undefined {
  const list = key ? bySession.get(key)?.list() : undefined;
  return list?.length ? list : undefined;
}

/** sessionStorage: the session's list survives a reload of the tab (a resume on another device starts afresh) */
const storeKey = (sessionId: string) => `rescript:scripthealth:${sessionId}`;
export function readStoredScriptHealth(sessionId: string | undefined): ScriptHealthEntry[] {
  if (!sessionId || typeof sessionStorage === "undefined") return [];
  try { return sanitizeScriptHealth(JSON.parse(sessionStorage.getItem(storeKey(sessionId)) ?? "[]")); } catch { return []; }
}
export function writeStoredScriptHealth(sessionId: string | undefined, entries: ScriptHealthEntry[]): void {
  if (!sessionId || typeof sessionStorage === "undefined") return;
  try { sessionStorage.setItem(storeKey(sessionId), JSON.stringify(entries)); } catch { /* storage full or blocked */ }
}
