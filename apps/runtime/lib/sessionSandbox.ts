import type { SurveyDefinition } from "@rescript/schema";
import type { NavTrail } from "@rescript/engine";
import { sandboxAvailable } from "./assessmentSandbox";

/**
 * THE SANDBOX'S RESPONSE ROWS (section navigation, 2026-10-30) — a runtime with NO database keeps a test survey and
 * its sessions in this process's memory, shaped like `public.responses`, so the whole save / resume path — the
 * replay check, `responses.nav` (0077), a resume link opened on another device — runs in the browser suite exactly
 * as it does against Postgres. Refused wherever a database is configured (`sandboxAvailable`); restarting the server
 * forgets it. Same idea as `assessmentSandbox.ts`.
 */
export { sandboxAvailable };

export interface SandboxSurvey { token: string; def: SurveyDefinition; createdAt: string }
export interface SandboxRow {
  session_id: string; survey: string; seed: number; status: string; is_test: true; respondent_code: string;
  answers: Record<string, unknown>; calculated: Record<string, unknown>; embedded: Record<string, unknown>; flags: unknown[];
  step_index: number; nav: NavTrail | null; started_at: string; last_saved_at: string | null; completed_at: string | null;
  /** D6 / 0078: the highest save seq applied */
  save_seq: number;
  /** S1a: the script-write paradata of the last save (`state.scriptWrites`, sanitised) */
  script_writes?: { script: string; kind: string; target: string; at: string }[];
}

const G = globalThis as unknown as { __rescriptSessionSandbox?: { surveys: Map<string, SandboxSurvey>; rows: Map<string, SandboxRow> } };
const store = () => (G.__rescriptSessionSandbox ??= { surveys: new Map(), rows: new Map() });
const hex = (n: number) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };
const MAX_SURVEYS = 50;
const MAX_ROWS = 2000;

/** the survey id the Runner and the resume pointer use for a sandbox survey */
export const sandboxSurveyId = (token: string) => `sbx_${token}`;

export function launchSandboxSurvey(def: SurveyDefinition): SandboxSurvey {
  const s = store();
  if (s.surveys.size >= MAX_SURVEYS) { const oldest = [...s.surveys.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]; s.surveys.delete(oldest.token); }
  const v: SandboxSurvey = { token: hex(12), def, createdAt: new Date().toISOString() };
  s.surveys.set(v.token, v);
  return v;
}

export const sandboxSurvey = (token: string): SandboxSurvey | null => (/^[0-9a-f]{24}$/.test(token) ? store().surveys.get(token) ?? null : null);
export const sandboxRow = (sessionId: string): SandboxRow | null => (sandboxAvailable() && typeof sessionId === "string" ? store().rows.get(sessionId) ?? null : null);

export function startSandboxSession(survey: SandboxSurvey): SandboxRow {
  const s = store();
  if (s.rows.size >= MAX_ROWS) { const oldest = [...s.rows.values()].sort((a, b) => a.started_at.localeCompare(b.started_at))[0]; s.rows.delete(oldest.session_id); }
  const n = [...s.rows.values()].filter((r) => r.survey === survey.token).length + 1;
  const row: SandboxRow = {
    session_id: hex(16), survey: survey.token, seed: Math.floor(Math.random() * 2 ** 31), status: "in_progress", is_test: true,
    respondent_code: `T${String(n).padStart(4, "0")}`, answers: {}, calculated: {}, embedded: {}, flags: [], step_index: 0, nav: null,
    started_at: new Date().toISOString(), last_saved_at: null, completed_at: null, save_seq: 0,
  };
  s.rows.set(row.session_id, row);
  return row;
}
