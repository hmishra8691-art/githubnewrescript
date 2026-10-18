"use client";
import type { SurveyDefinition } from "@rescript/schema";
import { applyQualOp, agreement as computeAgreement, type QualOp, type QualSegment, type QualState } from "@rescript/analytics";
import {
  importTranscript, openEndsTranscript, parseSessionInput, parseSpeakerEdit, speakerMap, toWorkspace, allSegments,
  type CodingRow, type EventRow, type QualWorkspace, type SessionRow, type TranscriptRow, type QualTranscriptView, type QualSessionView,
} from "@/lib/qual/qualWorkspace";
import type { QualOperation } from "@/lib/qual/qualAccess";

/**
 * THE QUALITATIVE WORKSPACE'S CLIENT (2026-10-18) — one interface, two homes:
 *
 *   • a saved project talks to `/api/surveys/[id]/qual/**` (the routes decide access again,
 *     store everything, and answer with the refreshed workspace);
 *   • the sandbox (no database) keeps the workspace in the page, runs the same pure functions
 *     the routes run (`qualWorkspace.ts`, `@rescript/analytics` qual), and calls the sandbox
 *     branches of the AI-coding and export routes (fake provider only) — so the browser suite
 *     exercises the real reader, substring check, merge and Word editions.
 *
 * Recordings need storage and a session: saved projects only.
 */

export type Abilities = Record<QualOperation, boolean> & { pii: boolean };
export interface WorkspaceView extends QualWorkspace { available: boolean; note?: string; can: Abilities; stt: { ready: boolean; via?: string; reason?: string } }
export interface CodingReport { added: { codes: number; themes: number; excerpts: number }; rejected: { segmentRef: string; code: string; quote: string; reason: string }[]; problems: string[]; calls: number; batches: number; skippedSegments: number; notRunBatches?: number; redaction: Record<string, number>; estimate: { calls: number; inputTokens: number; outputTokens: number }; provider: string }

export interface QualApi {
  sandbox: boolean;
  load(): Promise<WorkspaceView>;
  saveSession(input: Record<string, unknown>, id?: string): Promise<WorkspaceView>;
  deleteSession(id: string): Promise<WorkspaceView>;
  importText(input: { text: string; title?: string; fileName?: string; sessionId?: string | null }): Promise<{ ws: WorkspaceView; warnings: string[] }>;
  importFile(file: File, input: { title?: string; sessionId?: string | null }): Promise<{ ws: WorkspaceView; warnings: string[] }>;
  updateTranscript(id: string, patch: { title?: string; sessionId?: string | null; speakers?: Record<string, { role?: string; group?: string }> }): Promise<WorkspaceView>;
  deleteTranscript(id: string): Promise<WorkspaceView>;
  openEnds(questionIds: string[], title?: string): Promise<{ ws: WorkspaceView; warnings: string[] }>;
  aiCode(req: { mode: "inductive" | "deductive"; framework?: string; sourceIds?: string[] }): Promise<{ ws: WorkspaceView; report: CodingReport }>;
  op(op: QualOp): Promise<WorkspaceView>;
  settings(redactNames: string[]): Promise<WorkspaceView>;
  exportDocx(type: "guide" | "report", opts?: { interpretation?: string; compare?: { a: string; b: string } | null }): Promise<{ blob: Blob; name: string }>;
  uploadRecording(sessionId: string, file: File, onProgress: (p: number, phase: string) => void): Promise<WorkspaceView>;
  recordingUrl(mediaId: string, download: boolean): Promise<string>;
  transcribe(sessionId: string): Promise<{ ws: WorkspaceView; warnings: string[] }>;
}

export class QualApiError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } }

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const ct = r.headers.get("content-type") ?? "";
  if (!r.ok) {
    const j = ct.includes("json") ? await r.json().catch(() => ({})) : {};
    throw new QualApiError((j as { error?: string }).error ?? `The request failed (${r.status}).`, r.status, (j as { code?: string }).code);
  }
  return (ct.includes("json") ? r.json() : r.blob()) as Promise<T>;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const nameOf = (r: Response, fallback: string) => /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? fallback;

async function docx(url: string, body: unknown, fallback: string): Promise<{ blob: Blob; name: string }> {
  const r = await fetch(url, jsonInit("POST", body));
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new QualApiError((j as { error?: string }).error ?? `The document could not be made (${r.status}).`, r.status); }
  return { blob: await r.blob(), name: nameOf(r, fallback) };
}

/* ------------------------------------------------------------ a saved project */

export function httpQualApi(surveyId: string): QualApi {
  const base = `/api/surveys/${surveyId}/qual`;
  let last: WorkspaceView | null = null;
  const merge = (ws: QualWorkspace): WorkspaceView => { last = { ...(last ?? { available: true, can: {} as Abilities, stt: { ready: false } }), ...ws, available: true } as WorkspaceView; return last; };
  const api: QualApi = {
    sandbox: false,
    async load() { last = await call<WorkspaceView>(base); return last; },
    async saveSession(input, id) { const r = await call<{ workspace: QualWorkspace }>(`${base}/sessions`, jsonInit(id ? "PATCH" : "POST", id ? { ...input, id } : input)); return merge(r.workspace); },
    async deleteSession(id) { const r = await call<{ workspace: QualWorkspace }>(`${base}/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" }); return merge(r.workspace); },
    async importText(input) { const r = await call<{ workspace: QualWorkspace; warnings: string[] }>(`${base}/transcripts`, jsonInit("POST", input)); return { ws: merge(r.workspace), warnings: r.warnings ?? [] }; },
    async importFile(file, input) {
      const f = new FormData(); f.set("file", file); if (input.title) f.set("title", input.title); if (input.sessionId) f.set("sessionId", input.sessionId);
      const r = await call<{ workspace: QualWorkspace; warnings: string[] }>(`${base}/transcripts`, { method: "POST", body: f });
      return { ws: merge(r.workspace), warnings: r.warnings ?? [] };
    },
    async updateTranscript(id, patch) { const r = await call<{ workspace: QualWorkspace }>(`${base}/transcripts`, jsonInit("PATCH", { id, ...patch })); return merge(r.workspace); },
    async deleteTranscript(id) { const r = await call<{ workspace: QualWorkspace }>(`${base}/transcripts?id=${encodeURIComponent(id)}`, { method: "DELETE" }); return merge(r.workspace); },
    async openEnds(questionIds, title) { const r = await call<{ workspace: QualWorkspace; warnings: string[] }>(`${base}/transcripts`, jsonInit("POST", { source: "open_ends", questionIds, title })); return { ws: merge(r.workspace), warnings: r.warnings ?? [] }; },
    async aiCode(req) { const r = await call<CodingReport & { workspace: QualWorkspace }>(`${base}/coding`, jsonInit("POST", { action: "ai", ...req, version: last?.version ?? 0 })); return { ws: merge(r.workspace), report: r }; },
    async op(op) { const r = await call<{ workspace: QualWorkspace }>(`${base}/coding`, jsonInit("POST", { action: "op", op, version: last?.version ?? 0 })); return merge(r.workspace); },
    async settings(redactNames) { const r = await call<{ workspace: QualWorkspace }>(`${base}/coding`, jsonInit("POST", { action: "settings", redactNames })); return merge(r.workspace); },
    exportDocx(type, opts = {}) { return docx(`${base}/export`, { type, ...opts }, `${type}.docx`); },
    async uploadRecording(sessionId, file, onProgress) {
      const { RecordingUploader } = await import("@rescript/storage/uploader");
      const up = new RecordingUploader({
        endpoints: { begin: `${base}/recordings/ticket`, parts: `${base}/recordings/parts`, complete: `${base}/recordings/confirm` },
        mimeType: file.type || "audio/mpeg", estimatedBytes: file.size,
        beginExtra: { sessionId, fileName: file.name }, completeExtra: { sessionId },
        onState: (s) => onProgress(s.progress, s.phase),
      });
      await up.begin();
      up.push(file);
      const out = await up.finish(0);
      if (!out.ok) throw new QualApiError(out.error, 500);
      return merge((out.reply as { workspace: QualWorkspace }).workspace);
    },
    async recordingUrl(mediaId, download) { const r = await call<{ url: string }>(`${base}/recordings?mediaId=${encodeURIComponent(mediaId)}${download ? "&download=1" : ""}`); return r.url; },
    async transcribe(sessionId) { const r = await call<{ workspace: QualWorkspace; warnings?: string[] }>(`${base}/recordings/transcribe`, jsonInit("POST", { sessionId })); return { ws: merge(r.workspace), warnings: r.warnings ?? [] }; },
  };
  return api;
}

/* ------------------------------------------------------------ the sandbox */

const SANDBOX_CAN: Abilities = { read: true, manage: true, code: true, report: true, playback: false, settings: true, guide: true, pii: true };

export function sandboxQualApi(getDef: () => SurveyDefinition): QualApi {
  const rows: { sessions: SessionRow[]; transcripts: TranscriptRow[]; coding: CodingRow | null; events: EventRow[] } = { sessions: [], transcripts: [], coding: null, events: [] };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const now = () => new Date().toISOString();
  const view = (): WorkspaceView => ({ ...toWorkspace(rows, { pii: true }), available: true, can: SANDBOX_CAN, stt: { ready: false, reason: "Recordings and speech-to-text need a saved project (storage)." } });
  const event = (action: string, detail: string, ids: string[] = [], actor = "sandbox-user") => rows.events.push({ actor: actor === "ai" ? null : actor, actor_label: actor === "ai" ? "AI (suggested)" : "You", action, detail, ids, created_at: now() });
  const state = (): { state: QualState; version: number } => { const ws = toWorkspace(rows, { pii: true }); return { state: ws.state, version: ws.version }; };
  const setState = (s: QualState) => { rows.coding = { codebook: s.codebook, excerpts: s.excerpts, version: (rows.coding?.version ?? 0) + 1, settings: rows.coding?.settings ?? {} }; };
  const participantsOf = (sid: string | null | undefined): QualSessionView["participants"] => (sid ? toWorkspace(rows, { pii: true }).sessions.find((s) => s.id === sid)?.participants ?? [] : []);
  const addTranscript = (t: ReturnType<typeof importTranscript>): { ws: WorkspaceView; warnings: string[] } => {
    if (!t.ok) throw new QualApiError(t.error, 400);
    const v = t.value;
    const tid = id();
    rows.transcripts.push({ id: tid, session_id: v.session_id ?? null, title: v.title, source: v.source, format: v.format, language: v.language ?? null, segments: v.segments, speakers: v.speakers, status: "ready", error: null, char_count: v.char_count, media_id: null, meta: v.meta, created_at: now() });
    event(v.source === "open_ends" ? "source.open_ends" : "transcript.imported", `Imported “${v.title}” (${v.format}, ${v.segments.length} turns)`, [tid]);
    return { ws: view(), warnings: v.meta.warnings };
  };
  return {
    sandbox: true,
    async load() { return view(); },
    async saveSession(input, sid) {
      const f = parseSessionInput(input, !sid);
      if (!f.ok) throw new QualApiError(f.error, 400);
      if (sid) { const r = rows.sessions.find((s) => s.id === sid); if (!r) throw new QualApiError("no such session", 404); Object.assign(r, f.value); event("session.updated", `Updated the session “${r.title}”`, [sid]); }
      else { const v = f.value; const nid = id(); rows.sessions.push({ id: nid, kind: v.kind ?? "interview", title: v.title!, scheduled_at: v.scheduled_at ?? null, moderator: v.moderator ?? null, participants: v.participants ?? [], consent: v.consent ?? {}, notes: v.notes ?? null, observations: v.observations ?? [], status: v.status ?? "planned", recording_media_id: null }); event("session.created", `Recorded the session “${v.title}”`, [nid]); }
      return view();
    },
    async deleteSession(sid) { rows.sessions = rows.sessions.filter((s) => s.id !== sid); for (const t of rows.transcripts) if (t.session_id === sid) t.session_id = null; return view(); },
    async importText(input) { return addTranscript(importTranscript({ ...input, participants: participantsOf(input.sessionId) })); },
    async importFile(file, input) {
      if (/\.docx$/i.test(file.name)) throw new QualApiError("Word (.docx) transcripts are read on the server — open a saved project, or paste the text.", 400);
      return addTranscript(importTranscript({ text: await file.text(), fileName: file.name, title: input.title, sessionId: input.sessionId, participants: participantsOf(input.sessionId) }));
    },
    async updateTranscript(tid, patch) {
      const t = rows.transcripts.find((x) => x.id === tid); if (!t) throw new QualApiError("no such transcript", 404);
      if (patch.title) t.title = patch.title;
      if (patch.sessionId !== undefined) t.session_id = patch.sessionId;
      if (patch.speakers) { const e = parseSpeakerEdit(patch.speakers, speakerMap(t)); if (!e.ok) throw new QualApiError(e.error, 400); t.speakers = e.value; }
      event("transcript.updated", `Updated “${t.title}”`, [tid]);
      return view();
    },
    async deleteTranscript(tid) {
      const cur = state();
      setState({ ...cur.state, excerpts: cur.state.excerpts.filter((e) => e.sourceId !== tid) });
      rows.transcripts = rows.transcripts.filter((t) => t.id !== tid);
      return view();
    },
    async openEnds() { throw new QualApiError("Open-ended answers come from a saved project's responses — the sandbox has none.", 400); },
    async aiCode(req) {
      const cur = state();
      const ws = toWorkspace(rows, { pii: true });
      const def = getDef();
      const r = await call<CodingReport & { state: QualState; entry: { detail: string } }>(`/api/surveys/sandbox/qual/coding`, jsonInit("POST", { action: "ai", ...req, version: cur.version, state: cur.state, segments: allSegments(ws), settings: rows.coding?.settings ?? {}, objectives: def.qualStudy?.objectives ?? [], fake: (globalThis as { __rescriptQualFake?: unknown[] }).__rescriptQualFake ?? null }));
      setState(r.state);
      event("ai_coding", r.entry.detail, [], "ai");
      return { ws: view(), report: r };
    },
    async op(op) {
      const cur = state();
      const segs: QualSegment[] = allSegments(toWorkspace(rows, { pii: true }));
      const r = applyQualOp(cur.state, op, { actor: "sandbox-user", now: now(), segment: (src, sid) => segs.find((s) => s.sourceId === src && s.id === sid) });
      setState(r.state);
      event(r.entry.action, r.entry.detail, r.entry.ids);
      return view();
    },
    async settings(redactNames) { rows.coding = { ...(rows.coding ?? { codebook: state().state.codebook, excerpts: [], version: 0 }), settings: { redactNames } }; return view(); },
    async exportDocx(type, opts = {}) {
      const ws = toWorkspace(rows, { pii: true });
      const sources = ws.transcripts.map((t: QualTranscriptView) => ({ id: t.id, title: t.title, kind: t.source === "open_ends" ? "open_ends" : "transcript", segments: t.segments.length }));
      return docx(`/api/surveys/sandbox/qual/export`, { type, definition: getDef(), state: ws.state, segments: allSegments(ws), sources, history: ws.history, ...opts }, `${type}.docx`);
    },
    async uploadRecording() { throw new QualApiError("Recordings need a saved project (private storage).", 400); },
    async recordingUrl() { throw new QualApiError("Recordings need a saved project.", 400); },
    async transcribe() { throw new QualApiError("Speech-to-text needs a saved project with a recording.", 400); },
  };
}

/** two coders' agreement, computed where the data already are */
export const agreementOf = (ws: QualWorkspace, a: string, b: string) => computeAgreement(ws.state, a, b, { allUnits: allSegments(ws).filter((s) => s.role !== "moderator").map((s) => `${s.sourceId}|${s.id}`) });
