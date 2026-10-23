"use client";
import type { SurveyDefinition } from "@rescript/schema";
import { applyQualOp, agreement as computeAgreement, excerptClip, type QualOp, type QualSegment, type QualState } from "@rescript/analytics";
import type { ChunkTranscript } from "@rescript/media";
import { transcribeInBrowser } from "@/lib/qual/browserAudio";
import {
  importTranscript, openEndsTranscript, parseSessionInput, parseSpeakerEdit, speakerMap, toWorkspace, allSegments, sttTranscript,
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
  exportDocx(type: "guide" | "report" | "deck", opts?: { interpretation?: string; compare?: { a: string; b: string } | null; compareGroups?: [string, string] | null }): Promise<{ blob: Blob; name: string }>;
  uploadRecording(sessionId: string, file: File, onProgress: (p: number, phase: string) => void): Promise<WorkspaceView>;
  recordingUrl(mediaId: string, download: boolean): Promise<string>;
  transcribe(sessionId: string): Promise<{ ws: WorkspaceView; warnings: string[] }>;
  /**
   * #17: transcribe a recording in ANY format the browser can decode (M4A/AAC, MP4, WebM/Opus, OGG, FLAC…):
   * decoded here to 16 kHz mono WAV parts (≤ 24 MB, 2 s overlap), each transcribed with word timings, merged on
   * the recording's clock. A saved project needs the session's recording uploaded (the clips play from it); the
   * sandbox keeps the file in the page.
   */
  transcribeInBrowser(file: File, opts: { sessionId?: string | null; title?: string; language?: string }, onProgress?: (done: number, total: number, phase: string) => void): Promise<{ ws: WorkspaceView; warnings: string[] }>;
  /** the excerpt's clip: a playable URL and the excerpt's own time range (its words when the transcript has word timings) */
  clip(excerptId: string): Promise<{ url: string; start: number; end: number; approximate: boolean; byWords?: boolean }>;
  /** the sandbox's rows, for the synthesis / double-coding / highlights / correction / groups client (F2 2026-10-22); saved projects have none */
  sandboxHandle?: SandboxHandle;
}

export interface SandboxHandle {
  rows: { sessions: SessionRow[]; transcripts: TranscriptRow[]; coding: CodingRow | null; events: EventRow[] };
  view(): WorkspaceView;
  setState(s: QualState): void;
  event(action: string, detail: string, ids?: string[], actor?: string): void;
  addTranscript(t: ReturnType<typeof importTranscript>): { ws: WorkspaceView; warnings: string[] };
  addSession(input: Record<string, unknown>): string;
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
/** one part of a recording decoded in the browser (#17): a dropped connection or a gateway hiccup is retried — the route never pays twice for a part it already has */
async function sendPart<T>(url: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call<T>(url, init); }
    catch (e) {
      const retryable = e instanceof TypeError || (e instanceof QualApiError && (e.status === 502 || e.status === 503 || e.status === 504 || (e.status === 409 && /retries/.test(e.message))));
      if (!retryable || attempt >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  }
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
    async transcribeInBrowser(file, opts, onProgress) {
      if (!opts.sessionId) throw new QualApiError("Choose the session the recording belongs to — its clips play from the stored recording.", 400);
      const sid = opts.sessionId;
      const r = await transcribeInBrowser(file, async (p) => {
        const res = await sendPart<{ workspace?: QualWorkspace; warnings?: string[] }>(`${base}/recordings/chunk`, {
          method: "POST", body: p.wav as unknown as BodyInit,
          headers: { "content-type": "audio/wav", "x-session-id": sid, "x-part-index": String(p.plan.index), "x-part-count": String(p.count), "x-offset": String(p.plan.offsetSeconds), "x-duration": String(p.plan.durationSeconds), "x-overlap-before": String(p.plan.overlapBefore), "x-overlap-after": String(p.plan.overlapAfter), ...(opts.language ? { "x-language": opts.language } : {}) },
        });
        return { final: res.workspace ? res : undefined };
      }, onProgress);
      const fin = r.final as { workspace?: QualWorkspace; warnings?: string[] } | null;
      if (!fin?.workspace) throw new QualApiError("The parts were sent, but the transcript did not come back — press Transcribe again to finish it (parts already transcribed are not paid twice).", 202);
      return { ws: merge(fin.workspace), warnings: fin.warnings ?? [] };
    },
    async clip(excerptId) { return call(`${base}/highlights?clip=${encodeURIComponent(excerptId)}`); },
    async transcribe(sessionId) {
      /* a long recording is transcribed in parts: the route answers 202 { continue: true } until it is done (F2 2026-10-22) */
      let r = await call<{ workspace?: QualWorkspace; warnings?: string[]; continue?: boolean }>(`${base}/recordings/transcribe`, jsonInit("POST", { sessionId }));
      for (let i = 0; r.continue && i < 60; i++) { await new Promise((ok) => setTimeout(ok, r.workspace ? 0 : 1500)); r = await call(`${base}/recordings/transcribe`, jsonInit("POST", { sessionId })); }
      if (!r.workspace) throw new QualApiError("The transcription is still running — press Transcribe again to continue it.", 202);
      return { ws: merge(r.workspace), warnings: r.warnings ?? [] };
    },
  };
  return api;
}

/* ------------------------------------------------------------ the sandbox */

/* playback: the sandbox plays recordings transcribed in this page (kept as object URLs, never uploaded) — #17 */
const SANDBOX_CAN: Abilities = { read: true, manage: true, code: true, report: true, playback: true, settings: true, guide: true, pii: true };
/** recordings the sandbox transcribed in this page: transcript media id → object URL */
export const SANDBOX_MEDIA = new Map<string, { url: string; name: string }>();

export function sandboxQualApi(getDef: () => SurveyDefinition): QualApi {
  const rows: { sessions: SessionRow[]; transcripts: TranscriptRow[]; coding: CodingRow | null; events: EventRow[] } = { sessions: [], transcripts: [], coding: null, events: [] };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const now = () => new Date().toISOString();
  const view = (): WorkspaceView => ({ ...toWorkspace(rows, { pii: true }), available: true, can: SANDBOX_CAN, stt: { ready: false, reason: "Uploading recordings needs a saved project (storage); “Transcribe a recording” works here, in this page." } });
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
  let sandboxHandleRef: SandboxHandle | null = null;
  const addSession = (input: Record<string, unknown>): string => { const f = parseSessionInput(input, true); if (!f.ok) throw new QualApiError(f.error, 400); const v = f.value; const nid = id(); rows.sessions.push({ id: nid, kind: v.kind ?? "interview", title: v.title!, scheduled_at: v.scheduled_at ?? null, moderator: v.moderator ?? null, participants: v.participants ?? [], consent: v.consent ?? {}, notes: v.notes ?? null, observations: v.observations ?? [], status: v.status ?? "planned", recording_media_id: null }); event("session.created", `Recorded the session “${v.title}”`, [nid]); return nid; };
  return {
    sandbox: true,
    get sandboxHandle() { return (sandboxHandleRef ??= { rows, view, setState, event, addTranscript, addSession }); },
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
      /* F2 2026-10-22: the sandbox's AI synthesis records travel with the report (the route re-checks staleness) */
      const { sandboxReportExtras } = await import("./synthesisApi");
      /* the sandbox's section order (#18) — the same one the Research tab sets for the qualitative report and deck */
      const { sandboxTheme } = await import("@/lib/artifacts/sandboxStore");
      const { sessionStore } = await import("@/lib/artifacts/client");
      const structure = sandboxTheme(sessionStore()).structure;
      return docx(`/api/surveys/sandbox/qual/export`, { type, definition: getDef(), state: ws.state, segments: allSegments(ws), sources, history: ws.history, ...sandboxReportExtras(sandboxHandleRef), ...(structure ? { structure } : {}), ...opts }, `${type}.docx`);
    },
    async uploadRecording() { throw new QualApiError("Recordings need a saved project (private storage).", 400); },
    async recordingUrl(mediaId) { const m = SANDBOX_MEDIA.get(mediaId); if (!m) throw new QualApiError("Recordings need a saved project.", 400); return m.url; },
    async transcribeInBrowser(file, opts, onProgress) {
      const r = await transcribeInBrowser(file, async (p) => {
        const res = await sendPart<{ part: ChunkTranscript }>(`/api/surveys/sandbox/qual/recordings/chunk`, {
          method: "POST", body: p.wav as unknown as BodyInit,
          headers: { "content-type": "audio/wav", "x-part-index": String(p.plan.index), "x-part-count": String(p.count), "x-offset": String(p.plan.offsetSeconds), "x-duration": String(p.plan.durationSeconds), "x-overlap-before": String(p.plan.overlapBefore), "x-overlap-after": String(p.plan.overlapAfter), ...(opts.language ? { "x-language": opts.language } : {}) },
        });
        return { part: res.part };
      }, onProgress);
      if (!r.merged || !r.merged.text.trim()) throw new QualApiError("The transcription service heard no speech in this recording.", 422);
      const m = r.merged;
      const t = sttTranscript({ text: m.text, segments: m.segments, ...(m.words.length ? { words: m.words } : {}), diarized: m.diarized, model: "stt", durationSeconds: Math.round(r.durationSeconds) }, opts.title?.trim() || `${file.name} (transcribed)`, participantsOf(opts.sessionId));
      t.meta.warnings = [...m.warnings, ...t.meta.warnings];
      t.meta.parts = r.parts; t.meta.split = "browser";
      const mediaId = `local:${id()}`;
      SANDBOX_MEDIA.set(mediaId, { url: URL.createObjectURL(file), name: file.name });
      const tid = id();
      rows.transcripts.push({ id: tid, session_id: opts.sessionId ?? null, title: t.title, source: "stt", format: "stt", language: t.language ?? null, segments: t.segments, speakers: t.speakers, status: "ready", error: null, char_count: t.char_count, media_id: mediaId, meta: t.meta, created_at: now() });
      event("transcript.transcribed", `Transcribed “${file.name}” in this browser (${r.parts} part${r.parts === 1 ? "" : "s"}, ${Math.round(r.durationSeconds)} s${m.wordTimings ? ", word timings" : ""})`, [tid]);
      return { ws: view(), warnings: t.meta.warnings };
    },
    async clip(excerptId) {
      const ws = view();
      const e = ws.state.excerpts.find((x) => x.id === excerptId);
      if (!e) throw new QualApiError("no such excerpt", 404);
      const media = ws.transcripts.find((t) => t.id === e.sourceId)?.mediaId;
      const m = media ? SANDBOX_MEDIA.get(media) : null;
      const range = excerptClip(e, allSegments(ws));
      if (!m || !range) throw new QualApiError("This excerpt has no clip: its transcript has no recording in this page or no timestamps.", 404);
      return { url: m.url, ...range };
    },
    async transcribe() { throw new QualApiError("Speech-to-text needs a saved project with a recording.", 400); },
  };
}

/** two coders' agreement, computed where the data already are */
export const agreementOf = (ws: QualWorkspace, a: string, b: string) => computeAgreement(ws.state, a, b, { allUnits: allSegments(ws).filter((s) => s.role !== "moderator").map((s) => `${s.sourceId}|${s.id}`) });

/*
 * ONE SANDBOX WORKSPACE PER PAGE (F2 2026-10-22): the Qualitative panel and Intelligent Mode's qualitative cards
 * ("summarise the themes", "make a highlight reel …") read and write the same sandbox data, and switching tabs no
 * longer empties it. A saved project's data are in the database and need no such sharing.
 */
let sharedSandbox: { api: QualApi; getDef: { current: () => SurveyDefinition } } | null = null;
export function sharedSandboxQualApi(getDef: () => SurveyDefinition): QualApi {
  if (!sharedSandbox) { const ref = { current: getDef }; sharedSandbox = { api: sandboxQualApi(() => ref.current()), getDef: ref }; }
  else sharedSandbox.getDef.current = getDef;
  return sharedSandbox.api;
}
