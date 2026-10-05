import type { SurveyDefinition } from "@rescript/schema";
import { memoryOf } from "./durable.ts";

/**
 * THE INTELLIGENT MODE OPERATION HISTORY — the pure part (Intelligent Mode
 * upgrade, Phase 5; the audit's R11, R12, R21; migration 0047).
 *
 * One record per operation: what the researcher said, how it was read (the
 * engine, the model, the grammar, a fix from a review), what was detected
 * and targeted, what was proposed, applied, left out and refused, the
 * warnings, the engine operations, the model calls and their charge, the
 * survey before and after, and the status — which only moves along the
 * transitions below, so a record can never claim "saved" for a change that
 * was cancelled, or be applied twice under two numbers.
 *
 *   proposed ─► applied ─► saved ─────► reverted ─► applied (a redo)
 *      │           │  └──► save_failed ─┘ │ ▲
 *      │           └─────────────────────►┘ └── save_failed ─► saved
 *      ├─► cancelled
 *      └─► failed          (an Apply the engine refused: nothing was written)
 *   answered · refused · clarify · failed   (turns that proposed nothing: final)
 *
 * `change_n` — the survey's AI change number — is assigned by the SERVER on
 * the first transition to `applied`, as the survey's max + 1. It used to be
 * the page's `history.length + 1`, which restarted at #001 on every reload
 * and made the audit log's numbers collide.
 *
 * Everything a client sends is bounded here (`coerceOperation`) before it
 * reaches a row: the table is written by browsers, and a record of what
 * happened is no place for an unbounded payload.
 *
 * This module is imported by the route (server), the memory store (tests)
 * and — for types and the closed lists — the browser.
 */

/* ------------------------------------------------------------ the closed lists */

export const OP_STATUSES = ["proposed", "answered", "refused", "clarify", "failed", "cancelled", "applied", "saved", "save_failed", "reverted"] as const;
export type OpStatus = (typeof OP_STATUSES)[number];
export const OP_SOURCES = ["engine", "model", "grammar", "fix", "import", "context"] as const;
export type OpSource = (typeof OP_SOURCES)[number];

/** what a record may be created as — `applied` and after are reached only by a transition, which is where the number is assigned */
export const INITIAL_STATUSES: readonly OpStatus[] = ["proposed", "answered", "refused", "clarify", "failed"];
/** the statuses whose record keeps the survey before and after (the others never wrote anything) */
export const SNAPSHOT_STATUSES: readonly OpStatus[] = ["applied", "saved", "save_failed", "reverted"];
/** the statuses of a change that was written to the survey at some point */
export const CHANGE_STATUSES = SNAPSHOT_STATUSES;

/**
 * The allowed transitions. `proposed → failed` is the one addition to the
 * brief's list: an Apply the engine refuses at the last moment (a grammar
 * proposal gone stale) wrote nothing, and "failed" is what the record must
 * then say — leaving it "proposed" would offer to apply it again.
 */
export const TRANSITIONS: Readonly<Record<OpStatus, readonly OpStatus[]>> = {
  proposed: ["applied", "cancelled", "failed"],
  applied: ["saved", "save_failed", "reverted"],
  saved: ["reverted"],
  save_failed: ["saved", "reverted"],
  reverted: ["applied"],
  answered: [], refused: [], clarify: [], failed: [], cancelled: [],
};
export const canTransition = (from: OpStatus, to: OpStatus) => from === to || TRANSITIONS[from].includes(to);

export const LIMITS = {
  prompt: 4000,
  /** entries in any list */
  items: 200,
  /** characters in any string inside a list or the intent */
  text: 500,
  /** each of before / after, as JSON bytes */
  snapshotBytes: 2 * 1024 * 1024,
  /** one proposed action kept for Reapply, as JSON bytes — a bigger one keeps its description only */
  actionBytes: 20_000,
  intentKeys: 24,
  detail: 2000,
  /** records kept per survey in a memory store (oldest dropped first) */
  memoryRows: 400,
} as const;

/* ------------------------------------------------------------ the record */

export interface OpDetected { what: string; value: string }
/** a proposed change: its words, and — for Reapply — the engine action itself when it is small enough */
export interface OpProposed { description: string; action?: Record<string, unknown> }
export interface OpFailed { description: string; reason: string }
/** one model call the operation made, and what it cost */
export interface OpApiCall { route: string; mode?: string; charge: number; cached?: boolean; promptChars?: number; error?: string }
export type OpIntent = Record<string, string | number | boolean | null>;

export interface OperationFields {
  prompt: string;
  source: OpSource;
  intent: OpIntent;
  detected: OpDetected[];
  targets: string[];
  proposed: OpProposed[];
  applied: string[];
  excluded: string[];
  failed: OpFailed[];
  warnings: string[];
  engineOps: string[];
  apiCalls: OpApiCall[];
  status: OpStatus;
  statusDetail: string | null;
  savedRevision: number | null;
}
/** a record as the History list shows it — without the two surveys */
export interface OperationSummary extends OperationFields {
  id: string;
  surveyId: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  changeN: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
}
export interface OperationRecord extends OperationSummary {
  before: SurveyDefinition | null;
  after: SurveyDefinition | null;
}
export type OperationPatch = Partial<Omit<OperationFields, "source">> & { before?: SurveyDefinition | null; after?: SurveyDefinition | null };

export const emptyFields = (): OperationFields => ({
  prompt: "", source: "engine", intent: {}, detected: [], targets: [], proposed: [], applied: [], excluded: [], failed: [], warnings: [], engineOps: [], apiCalls: [],
  status: "proposed", statusDetail: null, savedRevision: null,
});

export function toSummary(r: OperationRecord): OperationSummary {
  const { before, after, ...rest } = r;
  return { ...rest, hasBefore: !!before, hasAfter: !!after };
}

/* ------------------------------------------------------------ coercion */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, n: number = LIMITS.text): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "").slice(0, n);
const list = <T>(v: unknown, each: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.slice(0, LIMITS.items).map(each).filter((x): x is T => x !== null) : []);
const strs = (v: unknown) => list(v, (x) => { const s = str(x); return s ? s : null; });
const jsonBytes = (v: unknown): number => { try { return new TextEncoder().encode(JSON.stringify(v) ?? "").length; } catch { return Infinity; } };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function coerceIntent(v: unknown): OpIntent {
  if (!isObj(v)) return {};
  const out: OpIntent = {};
  for (const [k, x] of Object.entries(v).slice(0, LIMITS.intentKeys)) {
    const key = k.slice(0, 60);
    if (x === null || typeof x === "boolean") out[key] = x;
    else if (typeof x === "number" && Number.isFinite(x)) out[key] = x;
    else if (typeof x === "string") out[key] = x.slice(0, LIMITS.text);
    // nested values are not an intent's business: dropped
  }
  return out;
}
const coerceDetected = (v: unknown) => list(v, (x) => (isObj(x) && (x.what || x.value) ? { what: str(x.what, 120), value: str(x.value) } : null));
function coerceProposed(v: unknown, warnings: string[]): OpProposed[] {
  let dropped = 0;
  const out = list(v, (x): OpProposed | null => {
    if (typeof x === "string") return x ? { description: x.slice(0, LIMITS.text) } : null;
    if (!isObj(x)) return null;
    const description = str(x.description);
    if (!description) return null;
    if (isObj(x.action) && typeof x.action.op === "string") {
      if (jsonBytes(x.action) <= LIMITS.actionBytes) return { description, action: x.action };
      dropped++;
    }
    return { description };
  });
  if (dropped) warnings.push(`${dropped} proposed action${dropped === 1 ? " was" : "s were"} larger than ${LIMITS.actionBytes / 1000} kB and kept as words only (Reapply cannot replay ${dropped === 1 ? "it" : "them"}).`);
  return out;
}
const coerceFailed = (v: unknown) => list(v, (x): OpFailed | null => {
  if (typeof x === "string") return x ? { description: x.slice(0, LIMITS.text), reason: "" } : null;
  return isObj(x) && (x.description || x.reason) ? { description: str(x.description), reason: str(x.reason) } : null;
});
const coerceApiCalls = (v: unknown) => list(v, (x): OpApiCall | null => {
  if (!isObj(x) || typeof x.route !== "string" || !x.route) return null;
  return {
    route: x.route.slice(0, 120),
    ...(typeof x.mode === "string" && x.mode ? { mode: x.mode.slice(0, 40) } : {}),
    charge: num(x.charge) ?? 0,
    ...(typeof x.cached === "boolean" ? { cached: x.cached } : {}),
    ...(num(x.promptChars) !== null ? { promptChars: Math.max(0, Math.round(num(x.promptChars)!)) } : {}),
    ...(typeof x.error === "string" && x.error ? { error: x.error.slice(0, LIMITS.text) } : {}),
  };
});
/** a survey snapshot: an object shaped like a definition and at most 2 MB — anything else is dropped, with a warning */
function coerceSnapshot(v: unknown, which: "before" | "after", warnings: string[]): SurveyDefinition | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isObj(v) || !Array.isArray(v.questions) || !Array.isArray(v.flow)) { warnings.push(`“${which}” is not a survey definition and was not kept.`); return undefined; }
  const bytes = jsonBytes(v);
  if (bytes > LIMITS.snapshotBytes) { warnings.push(`“${which}” is ${(bytes / 1048576).toFixed(1)} MB — over the 2 MB a record keeps — and was not kept; Compare and Restore are not available for it.`); return undefined; }
  return v as unknown as SurveyDefinition;
}

export type Coerced<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

/**
 * A request body as the fields of a record, every one bounded:
 *   prompt ≤ 4000 chars · lists ≤ 200 entries · strings ≤ 500 · the intent
 *   flat, ≤ 24 keys · before / after ≤ 2 MB each, kept only for a status
 *   that wrote something (applied, saved, save_failed, reverted)
 * status and source from the closed lists. `create`: a new record, with
 * defaults, in one of the initial statuses. `update`: only the keys
 * present (a missing key leaves the field as it is); `source` never
 * changes. Too-big or misplaced parts are DROPPED with a warning, never
 * refused: a record of what happened is worth more than its largest part.
 */
export function coerceOperation(body: unknown, mode: "create"): Coerced<OperationFields & { before?: SurveyDefinition | null; after?: SurveyDefinition | null }>;
export function coerceOperation(body: unknown, mode: "update"): Coerced<OperationPatch>;
export function coerceOperation(body: unknown, mode: "create" | "update"): Coerced<OperationPatch | (OperationFields & { before?: SurveyDefinition | null; after?: SurveyDefinition | null })> {
  if (!isObj(body)) return { ok: false, error: "send the operation as a JSON object" };
  const warnings: string[] = [];
  const has = (k: string) => k in body && body[k] !== undefined;
  const out: OperationPatch & { source?: OpSource } = {};
  if (has("status")) {
    if (!OP_STATUSES.includes(body.status as OpStatus)) return { ok: false, error: `unknown status “${str(body.status, 40)}” — one of ${OP_STATUSES.join(", ")}` };
    out.status = body.status as OpStatus;
  }
  if (mode === "create") {
    if (has("source") && !OP_SOURCES.includes(body.source as OpSource)) return { ok: false, error: `unknown source “${str(body.source, 40)}” — one of ${OP_SOURCES.join(", ")}` };
    out.source = (body.source as OpSource | undefined) ?? "engine";
    out.status ??= "proposed";
    if (!INITIAL_STATUSES.includes(out.status)) return { ok: false, error: `a new operation starts as ${INITIAL_STATUSES.join(", ")} — “${out.status}” is reached by updating it` };
  } else if (has("source")) warnings.push("the source of an operation does not change; ignored.");
  if (has("prompt")) {
    const p = str(body.prompt, Infinity);
    if (p.length > LIMITS.prompt) warnings.push(`the prompt was cut to ${LIMITS.prompt} characters.`);
    out.prompt = p.slice(0, LIMITS.prompt);
  }
  if (has("intent")) out.intent = coerceIntent(body.intent);
  if (has("detected")) out.detected = coerceDetected(body.detected);
  if (has("targets")) out.targets = strs(body.targets);
  if (has("proposed")) out.proposed = coerceProposed(body.proposed, warnings);
  if (has("applied")) out.applied = strs(body.applied);
  if (has("excluded")) out.excluded = strs(body.excluded);
  if (has("failed")) out.failed = coerceFailed(body.failed);
  if (has("warnings")) out.warnings = strs(body.warnings);
  if (has("engineOps")) out.engineOps = list(body.engineOps, (x) => { const s = str(x, 60); return s ? s : null; });
  if (has("apiCalls")) out.apiCalls = coerceApiCalls(body.apiCalls);
  if (has("statusDetail")) out.statusDetail = body.statusDetail === null ? null : str(body.statusDetail, LIMITS.detail) || null;
  if (has("savedRevision")) out.savedRevision = num(body.savedRevision);
  for (const k of ["before", "after"] as const) {
    if (!has(k)) continue;
    const snap = coerceSnapshot(body[k], k, warnings);
    if (snap !== undefined) out[k] = snap;
  }
  /* a new record is never in a status that wrote anything (see INITIAL_STATUSES): no survey to keep */
  if (mode === "create") {
    if (out.before !== undefined || out.after !== undefined) warnings.push(`before / after are kept only once an operation is applied; a “${out.status}” record does not keep them.`);
    delete out.before; delete out.after;
    return { ok: true, value: { ...emptyFields(), ...out, source: out.source!, status: out.status! }, warnings };
  }
  return { ok: true, value: out, warnings };
}

/* ------------------------------------------------------------ transitions */

export type PlannedUpdate =
  | { ok: true; next: OperationPatch; assignChangeN: boolean; warnings: string[] }
  | { ok: false; code: 409; error: string };

/**
 * What an update does to a record whose status is `current.status`: the
 * transition, if there is one, must be allowed; before / after travel only
 * into a status that wrote something; the first arrival at `applied` asks
 * for the survey's next change number (a redo — reverted → applied — keeps
 * the number it had). The same status again is an update of the fields
 * that come with it (a revision folded into an open proposal, a save retried).
 */
export function planUpdate(current: { status: OpStatus; changeN: number | null }, patch: OperationPatch): PlannedUpdate {
  const to = patch.status ?? current.status;
  if (!canTransition(current.status, to)) {
    const allowed = TRANSITIONS[current.status];
    return { ok: false, code: 409, error: `An operation that is ${current.status} cannot become ${to}${allowed.length ? ` (it can become ${allowed.join(" or ")})` : " — that status is final"}.` };
  }
  const warnings: string[] = [];
  const next: OperationPatch = { ...patch };
  if ((next.before !== undefined || next.after !== undefined) && !SNAPSHOT_STATUSES.includes(to)) {
    warnings.push(`before / after are kept only for an applied change; a “${to}” record does not keep them.`);
    delete next.before; delete next.after;
  }
  return { ok: true, next, assignChangeN: to === "applied" && current.changeN == null, warnings };
}

/**
 * The survey's next AI change number: the highest assigned + 1. Gaps stay
 * gaps (a number is never reused: #003 cancelled after #004 was assigned
 * cannot exist, but a deleted row's number is not handed out again by a
 * smaller max either — only a larger one).
 */
export function nextChangeN(rows: readonly ({ changeN?: number | null } | number | null | undefined)[]): number {
  let max = 0;
  for (const r of rows) {
    const n = typeof r === "number" ? r : r?.changeN;
    if (typeof n === "number" && Number.isFinite(n) && n > max) max = n;
  }
  return Math.floor(max) + 1;
}

/**
 * Assign a change number under concurrency: read the numbers in use, try
 * the next one, and — when another request took it first (the unique index
 * on (survey_id, change_n) refused ours) — read again and try once more.
 * Two researchers applying at the same moment get #004 and #005, never
 * #004 twice.
 */
export async function withChangeN<T>(
  read: () => Promise<readonly (number | null)[]>,
  write: (n: number) => Promise<{ ok: true; value: T } | { ok: false; conflict: boolean; error: string }>,
  retries = 1,
): Promise<{ ok: true; value: T; n: number } | { ok: false; error: string }> {
  for (let attempt = 0; ; attempt++) {
    const n = nextChangeN(await read());
    const r = await write(n);
    if (r.ok) return { ok: true, value: r.value, n };
    if (!r.conflict || attempt >= retries) return { ok: false, error: r.conflict ? `AI change #${String(n).padStart(3, "0")} was taken by another change at the same moment; try again.` : r.error };
  }
}

/* ------------------------------------------------------------ rows */

/** the table's row → the record (snake_case → camelCase), tolerant of a row from a partial select */
export function fromRow(r: Record<string, unknown>): OperationRecord {
  const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  return {
    id: String(r.id), surveyId: String(r.survey_id ?? ""), createdBy: (r.created_by as string | null) ?? null,
    createdAt: String(r.created_at ?? ""), updatedAt: String(r.updated_at ?? r.created_at ?? ""),
    changeN: typeof r.change_n === "number" ? r.change_n : null,
    prompt: String(r.prompt ?? ""), source: (OP_SOURCES.includes(r.source as OpSource) ? r.source : "engine") as OpSource,
    intent: isObj(r.intent) ? (r.intent as OpIntent) : {}, detected: arr(r.detected), targets: arr(r.targets), proposed: arr(r.proposed),
    applied: arr(r.applied), excluded: arr(r.excluded), failed: arr(r.failed), warnings: arr(r.warnings), engineOps: arr(r.engine_ops), apiCalls: arr(r.api_calls),
    status: (OP_STATUSES.includes(r.status as OpStatus) ? r.status : "proposed") as OpStatus,
    statusDetail: (r.status_detail as string | null) ?? null, savedRevision: typeof r.saved_revision === "number" ? r.saved_revision : null,
    before: (r.before as SurveyDefinition | null | undefined) ?? null, after: (r.after as SurveyDefinition | null | undefined) ?? null,
    hasBefore: r.has_before !== undefined ? r.has_before !== null : !!r.before, hasAfter: r.has_after !== undefined ? r.has_after !== null : !!r.after,
  };
}
/** the record's fields → the table's columns (only those present) */
export function toRow(f: OperationPatch & { source?: OpSource }): Record<string, unknown> {
  const map: [keyof (OperationPatch & { source?: OpSource }), string][] = [
    ["prompt", "prompt"], ["source", "source"], ["intent", "intent"], ["detected", "detected"], ["targets", "targets"], ["proposed", "proposed"],
    ["applied", "applied"], ["excluded", "excluded"], ["failed", "failed"], ["warnings", "warnings"], ["engineOps", "engine_ops"], ["apiCalls", "api_calls"],
    ["status", "status"], ["statusDetail", "status_detail"], ["savedRevision", "saved_revision"], ["before", "before"], ["after", "after"],
  ];
  const out: Record<string, unknown> = {};
  for (const [k, col] of map) if (f[k] !== undefined) out[col] = f[k];
  return out;
}

/* ------------------------------------------------------------ the store */

export type UpdateResult = { ok: true; record: OperationRecord; warnings: string[] } | { ok: false; status: 404 | 409 | 500; error: string };

export interface OperationStore {
  /** false: this server's memory — the table is not set up yet, or this is the sandbox */
  durable: boolean;
  /** newest first, without before / after */
  list(surveyKey: string, limit?: number): Promise<OperationSummary[]>;
  get(surveyKey: string, id: string): Promise<OperationRecord | null>;
  create(surveyKey: string, fields: OperationFields, meta: { userId: string | null; surveyId: string }): Promise<OperationRecord>;
  update(surveyKey: string, id: string, patch: OperationPatch): Promise<UpdateResult>;
}

let memSeq = 0;
/**
 * THE MEMORY STORE — the table's behaviour in this process: the same
 * transitions, the same numbering (max + 1 per survey, unique), the list
 * without the surveys. Keyed by `surveyKey` (the survey id; for the
 * sandbox, "sandbox:<the browser tab's key>" — see the route).
 */
export class MemoryOperationStore implements OperationStore {
  durable = false;
  private rows: Map<string, OperationRecord[]>;
  /* written out (not a parameter property): the unit tests run this file with type stripping only */
  constructor(rows: Map<string, OperationRecord[]> = memoryOf<OperationRecord[]>("operations")) { this.rows = rows; }
  private slot(key: string): OperationRecord[] { let s = this.rows.get(key); if (!s) { s = []; this.rows.set(key, s); } return s; }
  async list(key: string, limit = 200) {
    return [...this.slot(key)].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, limit).map(toSummary);
  }
  async get(key: string, id: string) { const r = this.slot(key).find((x) => x.id === id); return r ? structuredClone(r) : null; }
  async create(key: string, fields: OperationFields, meta: { userId: string | null; surveyId: string }) {
    const s = this.slot(key);
    // a strictly increasing timestamp, so "newest first" is the order they were made even within one millisecond
    const last = s.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), "");
    let at = new Date().toISOString();
    if (at <= last) at = new Date(Date.parse(last) + 1).toISOString();
    const rec: OperationRecord = { ...fields, id: `mem_${Date.now().toString(36)}_${(memSeq++).toString(36)}`, surveyId: meta.surveyId, createdBy: meta.userId, createdAt: at, updatedAt: at, changeN: null, before: null, after: null, hasBefore: false, hasAfter: false };
    s.push(rec);
    // bounded: the oldest records go first — a memory store is a stand-in, not an archive
    if (s.length > LIMITS.memoryRows) s.splice(0, s.length - LIMITS.memoryRows);
    return structuredClone(rec);
  }
  async update(key: string, id: string, patch: OperationPatch): Promise<UpdateResult> {
    const s = this.slot(key);
    const cur = s.find((x) => x.id === id);
    if (!cur) return { ok: false, status: 404, error: "No such operation." };
    const plan = planUpdate(cur, patch);
    if (!plan.ok) return { ok: false, status: plan.code, error: plan.error };
    const next: OperationRecord = { ...cur, ...plan.next, updatedAt: new Date().toISOString() } as OperationRecord;
    if (plan.assignChangeN) next.changeN = nextChangeN(s);
    next.hasBefore = !!next.before; next.hasAfter = !!next.after;
    s[s.indexOf(cur)] = next;
    return { ok: true, record: structuredClone(next), warnings: plan.warnings };
  }
}
