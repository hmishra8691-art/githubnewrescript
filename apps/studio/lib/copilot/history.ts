import type { SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "@rescript/engine";
import {
  CHANGE_STATUSES, INITIAL_STATUSES,
  type OpApiCall, type OpDetected, type OpFailed, type OpIntent, type OpProposed, type OpSource, type OpStatus, type OperationRecord, type OperationSummary,
} from "./operations.ts";

/**
 * THE OPERATION HISTORY IN THE BROWSER — the pure part (Intelligent Mode
 * upgrade, Phase 5).
 *
 *   OpsRecorder     every operation of this page, recorded on the server as
 *                   it happens: created at once (optimistically, so the UI
 *                   never waits), each later change queued behind the
 *                   create — an Apply clicked before the turn's record came
 *                   back still lands on the right record, in order
 *   saveFailure     why a save did not happen, in the store's own words
 *   appliedKicker   what an applied card may truthfully say
 *   observeUndo     which AI change a ⌘Z / ⌘⇧Z just undid or redid
 *   statusWord, sourceWord, apiCallWords, canRestore, reapplyActions
 *
 * A record that could not be written says so ("not recorded: …"), as does
 * an audit row that could not be written ("not in the audit log: …"): the
 * old history swallowed both (the audit's R11).
 */

/* ------------------------------------------------------------ words */

export const STATUS_WORDS: Record<OpStatus, string> = {
  proposed: "Proposed", answered: "Answered", refused: "Refused", clarify: "Clarifying", failed: "Failed", cancelled: "Cancelled",
  applied: "Applied", saved: "Saved", save_failed: "Not saved", reverted: "Reverted",
};
export const SOURCE_WORDS: Record<OpSource, string> = { engine: "Engine", model: "Model", grammar: "Grammar", fix: "Fix", import: "Import", context: "Context" };
export const statusWord = (s: OpStatus) => STATUS_WORDS[s] ?? s;
export const sourceWord = (s: OpSource) => SOURCE_WORDS[s] ?? s;
export const changeNumber = (n: number | null | undefined) => (n ? `#${String(n).padStart(3, "0")}` : "");

/** a model call in one line: "/api/copilot/turn · edit · 0.0123 credits · cached · 12,345 chars" */
export function apiCallWords(c: OpApiCall, money: (charge: number) => string = (x) => `${x} credits`): string {
  return [c.route, c.mode, c.charge > 0 ? money(c.charge) : "no charge", c.cached ? "cached" : "", c.promptChars ? `${c.promptChars.toLocaleString("en")} chars sent` : "", c.error ? `failed: ${c.error}` : ""].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------ saving, honestly */

/** the store's save state, as far as this module needs it */
export type SaveStateLike = { kind: string; message?: string; heldByName?: string | null };
export interface SaveFailure { kind: string; short: string; message: string }
/**
 * Why `flushDraft()` returned false, from the store's save state after it:
 * a conflict (someone saved a newer version), the lock lost (this session
 * is no longer the editor), signed out, an error with its message — or, if
 * the state says none of those, that the editor is read-only or the save
 * simply did not complete.
 */
export function saveFailure(st: SaveStateLike | null | undefined, readOnly = false): SaveFailure {
  const m = (fallback: string) => (st?.message ? st.message : fallback);
  switch (st?.kind) {
    case "conflict": return { kind: "conflict", short: "conflict", message: m("the survey was changed elsewhere; this save was refused") };
    case "lock_lost": return { kind: "lock_lost", short: "lock lost", message: m(`this session no longer holds the editing lock${st.heldByName ? ` (${st.heldByName} has it)` : ""}`) };
    case "signed_out": return { kind: "signed_out", short: "signed out", message: m("your session has ended") };
    case "unavailable": return { kind: "unavailable", short: "autosave unavailable", message: m("autosave is not available on this installation") };
    case "error": return { kind: "error", short: "error", message: m("the save failed") };
    default: return readOnly
      ? { kind: "read_only", short: "read-only", message: "this project is read-only right now — this session does not hold the editing lock" }
      : { kind: "incomplete", short: "not saved", message: "the save did not complete" };
  }
}

/** where an applied change stands with the save: on its way, stored, refused (with why), or the sandbox (nothing is stored there) */
export type SaveView = { state: "saving" } | { state: "saved"; revision?: number | null } | { state: "sandbox" } | { state: "failed"; kind: string; short: string; message: string };

/**
 * The kicker of an applied card — only what is true:
 *   APPLIED · SAVING…                     the store has it; the save is on its way
 *   APPLIED · SAVED                       flushDraft() returned true
 *   APPLIED · NOT SAVED — CONFLICT        it did not, and why
 *   APPLIED · SANDBOX (NOT SAVED)         the sandbox stores nothing
 * followed by "· AI CHANGE #00n" once the server has numbered it.
 */
export function appliedKicker(save: SaveView | undefined, n: number | null | undefined): string {
  const head = !save ? "APPLIED"
    : save.state === "saving" ? "APPLIED · SAVING…"
    : save.state === "saved" ? "APPLIED · SAVED"
    : save.state === "sandbox" ? "APPLIED · SANDBOX (NOT SAVED)"
    : `APPLIED · NOT SAVED — ${save.short.toUpperCase()}`;
  return n ? `${head} · AI CHANGE ${changeNumber(n)}` : head;
}

/* ------------------------------------------------------------ undo, observed */

export interface ObservedChange { key: string; before: SurveyDefinition; after: SurveyDefinition; reverted?: boolean }
/**
 * WHICH AI CHANGE THE STORE'S ⌘Z (or ⌘⇧Z) JUST MOVED — the audit's R21: the
 * history used to keep saying "applied" after the change had been undone.
 * Walking the changes newest first: a reverted change whose `after` is the
 * survey now was redone; the first change still standing whose `before` is
 * the survey now was undone; a change still standing that the survey is not
 * back before means nothing was (an edit made after it is what ⌘Z took).
 * `after` must be the survey as the store holds it after the apply (it
 * normalises option codes and order) — compared by identity first, so the
 * usual case costs nothing.
 */
export function observeUndo(changes: readonly ObservedChange[], def: SurveyDefinition, same: (a: SurveyDefinition, b: SurveyDefinition) => boolean, depth = 10): { key: string; to: "reverted" | "applied" } | null {
  for (const c of [...changes].reverse().slice(0, depth)) {
    if (c.reverted) { if (same(def, c.after)) return { key: c.key, to: "applied" }; continue; }
    return same(def, c.before) ? { key: c.key, to: "reverted" } : null;
  }
  return null;
}

/**
 * Two surveys equal regardless of the order of their keys — for a survey
 * read back from the table, where jsonb stores keys sorted, so the plain
 * JSON comparison would call every restored change "changed since".
 */
export function sameSurveyCanonical(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/* ------------------------------------------------------------ the entries */

/** one operation as this page knows it */
export interface ClientOp {
  /** this page's key (the server's id once known, for an operation read back from the server) */
  key: string;
  serverId: string | null;
  createdAt: string;
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
  changeN: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
  /** the record could not be written (or updated): why — said on the entry */
  recordError?: string;
  /** the audit row (/api/copilot/record) could not be written: why */
  auditError?: string;
  /** made on this page (the others were read back from the server) */
  local: boolean;
  /** the save, for a change applied on this page */
  save?: SaveView;
}
export type NewOp = Pick<ClientOp, "prompt" | "source" | "status"> & Partial<Pick<ClientOp, "intent" | "detected" | "targets" | "proposed" | "failed" | "warnings" | "apiCalls" | "statusDetail">>;
export type OpUpdate = Partial<Pick<ClientOp, "prompt" | "intent" | "detected" | "targets" | "proposed" | "applied" | "excluded" | "failed" | "warnings" | "engineOps" | "apiCalls" | "status" | "statusDetail" | "savedRevision">> & { before?: SurveyDefinition; after?: SurveyDefinition };

/** an applied change (applied / saved / not saved / reverted) — what used to be the whole history */
export const isChange = (o: Pick<ClientOp, "status">) => (CHANGE_STATUSES as readonly string[]).includes(o.status);

/** the actions of an entry, for Reapply: kept on the page, or the ones the record carries */
export function reapplyActions(o: Pick<ClientOp, "proposed">, kept?: readonly SurveyAction[] | null): SurveyAction[] {
  if (kept?.length) return [...kept];
  return o.proposed.map((p) => p.action).filter((a): a is Record<string, unknown> => !!a && typeof a.op === "string") as unknown as SurveyAction[];
}
/** Reapply is offered for a change that was applied, reverted or cancelled — and has actions to replay */
export const canReapply = (o: Pick<ClientOp, "status" | "proposed">, kept?: readonly SurveyAction[] | null) =>
  ["applied", "saved", "save_failed", "reverted", "cancelled"].includes(o.status) && reapplyActions(o, kept).length > 0;
/**
 * Restore is offered for a change that is standing (applied, saved, not
 * saved) and whose survey before was kept. `latest`: no change standing
 * after it — restoring it takes back that change only; otherwise the
 * restore also undoes what came after, and asks first.
 */
export function canRestore(o: ClientOp, all: readonly ClientOp[]): { offered: boolean; latest: boolean } {
  const standing = (x: ClientOp) => ["applied", "saved", "save_failed"].includes(x.status);
  if (!standing(o) || !o.hasBefore) return { offered: false, latest: false };
  const later = all.some((x) => x !== o && standing(x) && x.createdAt > o.createdAt);
  return { offered: true, latest: !later };
}

/* ------------------------------------------------------------ the recorder */

export type Send = (method: "GET" | "POST" | "PATCH", body: Record<string, unknown> | null, query?: Record<string, string>) => Promise<{ status: number; data: Record<string, unknown> | null }>;

const reason = (r: { status: number; data: Record<string, unknown> | null }) => String(r.data?.error ?? (r.status ? `HTTP ${r.status}` : "the network request failed"));
let seq = 0;

/**
 * THE PAGE'S OPERATIONS, kept in step with the server's record of them.
 *
 * `create` returns at once with the entry; its POST runs behind it. Every
 * `update` is applied to the entry immediately (the UI is never behind what
 * happened) and sent behind the previous request for the same entry — the
 * POST first — so the server sees the transitions in the order they
 * happened. The server's answer is authoritative for what only it decides
 * (the AI change number) and for whether it agreed (a refused transition or
 * an unreachable server becomes the entry's `recordError`).
 */
export class OpsRecorder {
  private ops = new Map<string, ClientOp>();
  private chains = new Map<string, Promise<unknown>>();
  /** the POST body of each entry, kept until it is accepted — an update retries the create once before giving up */
  private pending = new Map<string, Record<string, unknown>>();
  private listeners = new Set<() => void>();
  /** false: the server keeps the history in its memory (the sandbox, or the table is not set up yet); null: not known yet */
  durable: boolean | null = null;
  /** the server's list has been read at least once */
  loaded = false;
  loadError: string | null = null;
  private send: Send;
  private now: () => string;
  /* written out (not parameter properties): the unit tests run this file with type stripping only */
  constructor(send: Send, now: () => string = () => new Date().toISOString()) { this.send = send; this.now = now; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const f of this.listeners) f(); }
  private set(key: string, patch: Partial<ClientOp>) { const o = this.ops.get(key); if (o) { this.ops.set(key, { ...o, ...patch }); this.emit(); } }

  get(key: string): ClientOp | undefined { return this.ops.get(key); }
  /** newest first */
  list(): ClientOp[] { return [...this.ops.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)); }

  create(op: NewOp): ClientOp {
    const key = `op_${Date.now().toString(36)}_${(seq++).toString(36)}`;
    const entry: ClientOp = {
      key, serverId: null, createdAt: this.now(), prompt: op.prompt, source: op.source, intent: op.intent ?? {}, detected: op.detected ?? [], targets: op.targets ?? [],
      proposed: op.proposed ?? [], applied: [], excluded: [], failed: op.failed ?? [], warnings: op.warnings ?? [], engineOps: [], apiCalls: op.apiCalls ?? [],
      status: INITIAL_STATUSES.includes(op.status) ? op.status : "proposed", statusDetail: op.statusDetail ?? null, savedRevision: null, changeN: null, hasBefore: false, hasAfter: false, local: true,
    };
    this.ops.set(key, entry);
    const body: Record<string, unknown> = { prompt: entry.prompt, source: entry.source, status: entry.status, intent: entry.intent, detected: entry.detected, targets: entry.targets, proposed: entry.proposed, failed: entry.failed, warnings: entry.warnings, apiCalls: entry.apiCalls, statusDetail: entry.statusDetail };
    this.pending.set(key, body);
    this.chains.set(key, this.post(key));
    this.emit();
    return entry;
  }
  private async post(key: string): Promise<boolean> {
    const body = this.pending.get(key);
    if (!body) return !!this.ops.get(key)?.serverId;
    const r = await this.send("POST", body).catch(() => ({ status: 0, data: null }));
    if (r.status >= 200 && r.status < 300 && typeof r.data?.id === "string") {
      this.pending.delete(key);
      if (typeof r.data.durable === "boolean") this.durable = r.data.durable;
      // the server's clock orders the merged list; this page's entry keeps its own place until then
      this.set(key, { serverId: r.data.id, recordError: undefined });
      return true;
    }
    this.set(key, { recordError: `not recorded: ${reason(r)}` });
    return false;
  }

  /**
   * Change an entry and record the change. Resolves with the entry as the
   * server left it (with its AI change number), or as this page has it with
   * `recordError` set when the server could not be told.
   */
  update(key: string, u: OpUpdate): Promise<ClientOp | null> {
    const cur = this.ops.get(key);
    if (!cur) return Promise.resolve(null);
    const { before, after, ...fields } = u;
    this.set(key, { ...fields, ...(before ? { hasBefore: true } : {}), ...(after ? { hasAfter: true } : {}) });
    const prev = this.chains.get(key) ?? Promise.resolve(true);
    const next = prev.then(async () => {
      if (!this.ops.get(key)?.serverId && !(await this.post(key))) return this.ops.get(key) ?? null;
      const r = await this.send("PATCH", { id: this.ops.get(key)!.serverId, ...fields, ...(before ? { before } : {}), ...(after ? { after } : {}) }).catch(() => ({ status: 0, data: null }));
      if (r.status >= 200 && r.status < 300 && r.data?.operation) {
        const op = r.data.operation as OperationSummary;
        if (typeof r.data.durable === "boolean") this.durable = r.data.durable;
        this.set(key, { changeN: op.changeN ?? null, status: op.status, recordError: undefined });
      } else this.set(key, { recordError: `not recorded: ${reason(r)}` });
      return this.ops.get(key) ?? null;
    });
    this.chains.set(key, next.catch(() => null));
    return next;
  }

  /** say something on an entry that is not part of its record (the audit row's failure, the save's state) */
  note(key: string, patch: Pick<Partial<ClientOp>, "auditError" | "save">) { this.set(key, patch); }

  /**
   * The server's list, merged: an operation this page already has keeps this
   * page's richer entry (its save state, its errors) with the server's number
   * filled in; the others — earlier sessions, other people — join as read.
   */
  merge(rows: readonly OperationSummary[], durable?: boolean) {
    if (typeof durable === "boolean") this.durable = durable;
    this.loaded = true; this.loadError = null;
    const byServer = new Map([...this.ops.values()].filter((o) => o.serverId).map((o) => [o.serverId!, o]));
    for (const r of rows) {
      const mine = byServer.get(r.id);
      if (mine) { if (mine.changeN == null && r.changeN != null) this.ops.set(mine.key, { ...mine, changeN: r.changeN }); continue; }
      this.ops.set(r.id, {
        key: r.id, serverId: r.id, createdAt: r.createdAt, prompt: r.prompt, source: r.source, intent: r.intent, detected: r.detected, targets: r.targets, proposed: r.proposed,
        applied: r.applied, excluded: r.excluded, failed: r.failed, warnings: r.warnings, engineOps: r.engineOps, apiCalls: r.apiCalls, status: r.status, statusDetail: r.statusDetail,
        savedRevision: r.savedRevision, changeN: r.changeN, hasBefore: r.hasBefore, hasAfter: r.hasAfter, local: false,
      });
    }
    this.emit();
  }
  /** read the server's list (GET) and merge it */
  async refresh(): Promise<void> {
    const r = await this.send("GET", null).catch(() => ({ status: 0, data: null }));
    if (r.status === 200 && Array.isArray(r.data?.operations)) this.merge(r.data!.operations as OperationSummary[], r.data!.durable as boolean | undefined);
    else { this.loadError = reason(r); this.emit(); }
  }
  /** one record with the surveys before and after (Compare, Restore after a reload) */
  async fetchOne(key: string): Promise<OperationRecord | null> {
    await (this.chains.get(key) ?? Promise.resolve());
    const id = this.ops.get(key)?.serverId;
    if (!id) return null;
    const r = await this.send("GET", null, { id }).catch(() => ({ status: 0, data: null }));
    return r.status === 200 && r.data?.operation ? (r.data.operation as OperationRecord) : null;
  }
  /** resolves when everything queued for an entry has been sent */
  settled(key: string): Promise<unknown> { return this.chains.get(key) ?? Promise.resolve(); }
}
