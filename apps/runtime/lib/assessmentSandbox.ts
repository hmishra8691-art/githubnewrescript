import type { SurveyDefinition } from "@rescript/schema";
import { assessmentAnalytics, assessmentColumnNames, assessmentColumns, scoreAssessment, type AssessmentResult } from "@rescript/engine";

/**
 * THE SANDBOX'S ASSESSMENTS (K4 2026-10-25, ported 2026-10-29) — a runtime with NO database keeps "Take the test" papers and their
 * attempts in this process's memory, so the Studio's unsaved sandbox and the browser suite can run the whole
 * respondent path: the stripped paper in the page, submit, the server-scored report, the reload, the export.
 * The same rules as the database path: the full definition (with the key) stays HERE, the page receives the
 * stripped one, scoring is `scoreAssessment` against the stored definition. Restarting the server forgets it.
 * Refused (403) wherever a database is configured — a real paper is taken through /s or /t.
 */

export interface SandboxAttempt { id: string; submittedAt: string; answers: Record<string, unknown>; result: AssessmentResult }
export interface SandboxPaper { token: string; observerKey: string; def: SurveyDefinition; createdAt: string; attempts: SandboxAttempt[] }

const G = globalThis as unknown as { __rescriptAssessmentSandbox?: Map<string, SandboxPaper> };
const papers = (): Map<string, SandboxPaper> => (G.__rescriptAssessmentSandbox ??= new Map());
const hex = (n: number) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };

export const sandboxAvailable = (): boolean => !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const MAX_PAPERS = 50;
const MAX_ATTEMPTS = 500;

export function launchPaper(def: SurveyDefinition): SandboxPaper {
  const m = papers();
  if (m.size >= MAX_PAPERS) { const oldest = [...m.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]; m.delete(oldest.token); }
  const p: SandboxPaper = { token: hex(12), observerKey: hex(16), def, createdAt: new Date().toISOString(), attempts: [] };
  m.set(p.token, p);
  return p;
}

export const paperByToken = (token: string): SandboxPaper | null => (/^[0-9a-f]{24}$/.test(token) ? papers().get(token) ?? null : null);
export const paperByObserver = (key: string): SandboxPaper | null => [...papers().values()].find((p) => p.observerKey === key) ?? null;

export function submitAttempt(p: SandboxPaper, answers: Record<string, unknown>): SandboxAttempt {
  /* 128-bit attempt id: with the paper token, the only credential for the attempt's report (token-bound, never guessable) */
  const a: SandboxAttempt = { id: hex(16), submittedAt: new Date().toISOString(), answers: JSON.parse(JSON.stringify(answers ?? {})), result: scoreAssessment(p.def, answers ?? {}) };
  p.attempts.push(a);
  if (p.attempts.length > MAX_ATTEMPTS) p.attempts.shift();
  return a;
}

/** the researcher's view: every attempt with its export columns, the CSV and the item analysis */
export function paperResponses(p: SandboxPaper) {
  const header = ["ATTEMPT_ID", "SUBMITTED_AT", ...assessmentColumnNames(p.def).columns];
  const rows = p.attempts.map((a) => ({ id: a.id, submittedAt: a.submittedAt, columns: assessmentColumns(p.def, a.result) }));
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header.join(","), ...rows.map((r) => [r.id, r.submittedAt, ...header.slice(2).map((h) => r.columns[h])].map(cell).join(","))].join("\n");
  return { header, rows, csv, analytics: assessmentAnalytics(p.def, p.attempts.map((a) => a.result)), results: p.attempts.map((a) => ({ id: a.id, submittedAt: a.submittedAt, result: a.result })) };
}

/** an attempt of this paper, by its id (32 hex) — the paper token AND the attempt id are both needed */
export const attemptOf = (p: SandboxPaper, id: string): SandboxAttempt | null => (/^[0-9a-f]{32}$/.test(id) ? p.attempts.find((a) => a.id === id) ?? null : null);
