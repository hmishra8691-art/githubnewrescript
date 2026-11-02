import type { MigrationReport } from "@rescript/import";

/**
 * IMPORT SESSIONS (I4, migration 0080): one record per import run — what file, what the reader made of it,
 * what happened to it (analyzed → applied → rolled back), and, for 90 days, the file itself.
 *
 * This module is the pure core and the in-memory store (the sandbox, a Studio without a database, the unit
 * tests). The database store is `sessionsServer.ts`; both implement `SessionStore`, so the routes do not know
 * which one they talk to.
 */
export const IMPORT_BUCKET = "rescript-imports";
export const SOURCE_RETENTION_DAYS = 90;
/** a canonical survey or a prior definition larger than this is not kept (the session says so) */
export const MAX_KEPT_JSON_BYTES = 4_000_000;

export type SessionStatus = "analyzed" | "applied" | "rolled_back" | "failed" | "discarded";

export interface ReportDigest {
  title: string | null;
  /** the detection's sentence ("Qualtrics survey (QSF)") — what a re-analysis reports the source as */
  label?: string;
  ok: boolean;
  summary: string[];
  questions: number;
  review: number;
  risks: { high: number; medium: number; low: number };
  mapping: Record<string, number>;
  fidelity: { detected: number; imported: number; partial: number; unsupported: number; importedPct: number | null } | null;
  graph: { findings: Record<string, number>; first: { kind: string; severity: string; location: string; message: string }[] };
  scripts: { location: string; verdict: string; summary: string }[];
}

export interface ImportSession {
  id: string;
  /** null = the sandbox (no organisation) */
  customerId: string | null;
  userId: string | null;
  surveyId: string | null;
  into: "new" | "merge";
  scope: "full" | "structure" | "questions";
  fileName: string;
  format: string;
  platform: string | null;
  fingerprint: string;
  sizeBytes: number;
  storageProvider: string | null;
  bucket: string | null;
  storageKey: string | null;
  sourceExpiresAt: string;
  status: SessionStatus;
  reportDigest: ReportDigest;
  canonical: unknown | null;
  decisions: unknown[];
  priorDefinition: unknown | null;
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

export type NewSession = Omit<ImportSession, "id" | "createdAt" | "appliedAt" | "rolledBackAt" | "storageProvider" | "bucket" | "storageKey" | "sourceExpiresAt" | "status"> & { status?: SessionStatus };

export function digestReport(r: MigrationReport): ReportDigest {
  const f = r.fidelity?.totals;
  return {
    title: r.source.title ?? null, label: r.source.label, ok: r.ok, summary: r.summary.slice(0, 20),
    questions: r.created?.questions ?? r.detected.questions, review: r.review.length,
    risks: { high: r.risks.high.length, medium: r.risks.medium.length, low: r.risks.low.length },
    mapping: { ...(r.mapping?.summary ?? {}) },
    fidelity: f ? { detected: f.detected, imported: f.imported, partial: f.partial, unsupported: f.unsupported, importedPct: r.fidelity.importedPct } : null,
    graph: { findings: { ...(r.graph?.stats.findings ?? {}) }, first: (r.graph?.findings ?? []).filter((x) => x.severity !== "info").slice(0, 50).map((x) => ({ kind: x.kind, severity: x.severity, location: x.location, message: x.message })) },
    scripts: (r.scripts ?? []).slice(0, 100).map((s) => ({ location: s.location, verdict: s.verdict, summary: s.summary.slice(0, 400) })),
  };
}

/** where the file's bytes live: never a name a person could guess from outside, never outside the organisation's prefix */
export function sourceKey(customerId: string | null, sessionId: string, fileName: string): string {
  /* the base name only (a browser may send a path), then a plain-character name with no leading dots */
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const safe = base.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(-80) || "upload";
  return `${customerId ?? "sandbox"}/imports/${sessionId}/${safe}`;
}

export function expiryFrom(created: Date, days = SOURCE_RETENTION_DAYS): string {
  return new Date(created.getTime() + days * 86_400_000).toISOString();
}

/** the value if its JSON fits, else null — the caller records why */
export function bounded(v: unknown, max = MAX_KEPT_JSON_BYTES): unknown | null {
  if (v === undefined || v === null) return null;
  try { return JSON.stringify(v).length <= max ? v : null; } catch { return null; }
}

export type RollbackPlan =
  | { action: "restore_definition"; definition: unknown }
  | { action: "delete_project"; surveyId: string }
  | { action: "refuse"; status: number; reason: string };

/**
 * What rolling an import back means. Nothing collected is ever destroyed by a rollback: a new project that
 * already has responses is refused (deleting it is the owner's explicit act, in Project settings). A merge is
 * undone by restoring the survey exactly as it was when the import was applied — in the editor, as one edit.
 */
export function rollbackPlan(s: ImportSession, facts: { responses: number }): RollbackPlan {
  if (s.status !== "applied") return { action: "refuse", status: 409, reason: `Only an applied import can be rolled back; this one is ${s.status.replace("_", " ")}.` };
  if (s.into === "merge") {
    if (s.priorDefinition === null) return { action: "refuse", status: 410, reason: "The survey as it was before this import was not kept (it was larger than the limit), so it cannot be restored here. Use the version history." };
    return { action: "restore_definition", definition: s.priorDefinition };
  }
  if (!s.surveyId) return { action: "refuse", status: 409, reason: "The project this import created is no longer there." };
  if (facts.responses > 0) return { action: "refuse", status: 409, reason: `The project already has ${facts.responses} response${facts.responses === 1 ? "" : "s"}. A rollback never deletes collected data — delete the project yourself in its settings if that is what you mean.` };
  return { action: "delete_project", surveyId: s.surveyId };
}

/** the list a person sees: newest first, their organisation's (or the sandbox's) only, without the heavy fields */
export type SessionSummary = Omit<ImportSession, "canonical" | "priorDefinition" | "decisions"> & { hasSource: boolean; hasPrior: boolean; decisions: number };
export function summarize(s: ImportSession): SessionSummary {
  const { canonical: _c, priorDefinition, decisions, ...rest } = s;
  return { ...rest, hasSource: !!s.storageKey && Date.parse(s.sourceExpiresAt) > Date.now(), hasPrior: priorDefinition !== null, decisions: decisions.length };
}

export interface SessionStore {
  readonly kind: "database" | "memory";
  create(s: NewSession, source: Uint8Array | null): Promise<ImportSession>;
  get(id: string): Promise<ImportSession | null>;
  list(filter: { customerId: string | null; surveyId?: string | null; limit?: number }): Promise<ImportSession[]>;
  update(id: string, patch: Partial<Pick<ImportSession, "status" | "surveyId" | "appliedAt" | "rolledBackAt" | "decisions" | "error" | "reportDigest">>): Promise<ImportSession | null>;
  /** sessions whose source is due for removal (expired), oldest first */
  expired(limit: number): Promise<ImportSession[]>;
  /** remove the stored file and clear its key; idempotent */
  dropSource(s: ImportSession): Promise<void>;
}

/**
 * THE IN-MEMORY STORE — one per server process (the sandbox's fixture survey; a Studio without a database).
 * Bounded: the newest 100 sessions and their files; lost on restart, which is what "sandbox" means.
 */
export function memorySessionStore(now: () => Date = () => new Date()): SessionStore {
  const rows = new Map<string, ImportSession>();
  const files = new Map<string, Uint8Array>();
  let n = 0;
  const trim = () => { while (rows.size > 100) { const oldest = [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]; rows.delete(oldest.id); if (oldest.storageKey) files.delete(oldest.storageKey); } };
  return {
    kind: "memory",
    async create(s, source) {
      const created = now();
      const id = `mem-${created.getTime().toString(36)}-${(++n).toString(36)}`;
      const key = source ? sourceKey(s.customerId, id, s.fileName) : null;
      if (key && source) files.set(key, source);
      const row: ImportSession = { ...s, id, status: s.status ?? "analyzed", createdAt: created.toISOString(), appliedAt: null, rolledBackAt: null, storageProvider: key ? "memory" : null, bucket: key ? IMPORT_BUCKET : null, storageKey: key, sourceExpiresAt: expiryFrom(created) };
      rows.set(id, row); trim();
      return row;
    },
    async get(id) { return rows.get(id) ?? null; },
    async list({ customerId, surveyId, limit = 50 }) {
      return [...rows.values()].filter((r) => r.customerId === customerId && (surveyId === undefined || surveyId === null || r.surveyId === surveyId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit);
    },
    async update(id, patch) { const r = rows.get(id); if (!r) return null; const next = { ...r, ...patch }; rows.set(id, next); return next; },
    async expired(limit) { const t = now().getTime(); return [...rows.values()].filter((r) => r.storageKey && Date.parse(r.sourceExpiresAt) <= t).sort((a, b) => a.sourceExpiresAt.localeCompare(b.sourceExpiresAt)).slice(0, limit); },
    async dropSource(s) { if (s.storageKey) files.delete(s.storageKey); const r = rows.get(s.id); if (r) rows.set(s.id, { ...r, storageKey: null, bucket: null, storageProvider: null }); },
  };
}

