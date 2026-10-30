import { createHash } from "node:crypto";
import type { SurveyDefinition } from "@rescript/schema";
import { diffScriptItems, scriptAuditDetail, scriptAuditSentence, type ScriptAuditAction } from "@rescript/engine";

/**
 * S1c item 3 (audit SE-29) — THE SCRIPT AUDIT LOG, the pure half (the draft route and `/api/surveys/[id]/script-audit`).
 *
 * `scriptAuditRows(before, after)` → one `audit_logs` row per changed code-bearing item (engine `diffScriptItems`),
 * fingerprinted with sha-256 (first 16 hex digits) — never the code. At most `SCRIPT_AUDIT_MAX_PER_SAVE` rows per save;
 * the last one then says how many more changed (`detail.more`), so an import of 300 scripts is one burst, not 300 rows.
 *
 * THE SANDBOX (no database): `/sandbox` never writes a draft, so the editor posts its definition to
 * `/api/surveys/sandbox/script-audit` after each autosave tick; this module keeps the last definition and the entries
 * in memory (one process, capped at 200 entries, lost on restart) — enough for the Versions panel and the browser suite.
 */
export const SCRIPT_AUDIT_MAX_PER_SAVE = 40;
export const sha256Short = (code: string) => createHash("sha256").update(code, "utf8").digest("hex").slice(0, 16);

export interface ScriptAuditRow { action: ScriptAuditAction; entityId: string; detail: Record<string, unknown> }

export function scriptAuditRows(before: SurveyDefinition | null | undefined, after: SurveyDefinition, max = SCRIPT_AUDIT_MAX_PER_SAVE): ScriptAuditRow[] {
  let changes;
  try { changes = diffScriptItems(before ?? null, after, sha256Short); } catch { return []; }
  const rows = changes.slice(0, max).map((c) => ({ action: c.action, entityId: c.itemId, detail: scriptAuditDetail(c) }));
  if (changes.length > max && rows.length) rows[rows.length - 1]!.detail.more = changes.length - max;
  return rows;
}

/** an entry as the Versions panel shows it */
export interface ScriptAuditEntry { id: string; action: string; at: string; who: string; detail: Record<string, unknown>; text: string }

export function scriptAuditEntry(r: { id: string | number; action: string; created_at: string; who: string; detail: Record<string, unknown> | null }): ScriptAuditEntry {
  const detail = r.detail ?? {};
  return { id: String(r.id), action: r.action, at: r.created_at, who: r.who, detail, text: scriptAuditSentence(r.action, detail, r.who) };
}

/* ------------------------------------------------------------ the sandbox's memory */

const SANDBOX_MAX = 200;
interface SandboxAudit { last: SurveyDefinition | null; entries: ScriptAuditEntry[]; seq: number }
const g = globalThis as unknown as { __rescriptSandboxScriptAudit?: SandboxAudit };
const store = (): SandboxAudit => (g.__rescriptSandboxScriptAudit ??= { last: null, entries: [], seq: 0 });

/**
 * The sandbox editor's definition after a save tick. The FIRST definition a fresh process sees is the baseline (the
 * fixture as loaded), not a burst of "added" rows. Returns the entries this call added.
 */
export function recordSandboxDefinition(def: SurveyDefinition, now = new Date().toISOString(), who = "You (sandbox)", baseline = false): ScriptAuditEntry[] {
  const s = store();
  // the editor opening (or reloading) the fixture: compare later saves with what it loaded, not with the last session
  if (!s.last || baseline) { s.last = def; return []; }
  const rows = scriptAuditRows(s.last, def);
  s.last = def;
  const added = rows.map((r) => scriptAuditEntry({ id: `sb${++s.seq}`, action: r.action, created_at: now, who, detail: r.detail }));
  s.entries = [...added.reverse(), ...s.entries].slice(0, SANDBOX_MAX);
  return added;
}
export const sandboxScriptAudit = (): ScriptAuditEntry[] => store().entries;
export function resetSandboxScriptAudit(): void { g.__rescriptSandboxScriptAudit = { last: null, entries: [], seq: 0 }; }
