import {
  parseTranscript, suggestRole, redactText, openEndSegments, emptyCodebook,
  type QualSegment, type QualState, type QualHistoryEntry, type TranscriptFormat, type QualCodebook, type QualExcerpt,
} from "@rescript/analytics";

/**
 * THE QUALITATIVE WORKSPACE, SHAPED (2026-10-18) — the pure half of the
 * `/api/surveys/[id]/qual/**` routes: rows in, the workspace a member may see
 * out; request bodies in, validated row fields out. No database, no Next, so
 * every rule here is unit-tested (`qualWorkspace.test.ts`).
 *
 * Segments are stored without their source id or role (the transcript row is
 * the source; the speaker map decides who is the moderator and which
 * participant segment a speaker belongs to), so correcting the speaker map
 * re-reads every segment without rewriting one.
 */

export interface SessionRow { id: string; kind: string; title: string; scheduled_at: string | null; moderator: string | null; participants: unknown; consent: unknown; notes: string | null; observations: unknown; status: string; recording_media_id: string | null; created_at?: string; updated_at?: string }
export interface TranscriptRow { id: string; session_id: string | null; title: string; source: string; format: string | null; language: string | null; segments: unknown; speakers: unknown; status: string; error: string | null; char_count: number; media_id: string | null; meta: unknown; created_at?: string }
export interface CodingRow { codebook: unknown; excerpts: unknown; version: number; settings?: unknown }
export interface EventRow { id?: number; actor: string | null; actor_label: string | null; action: string; detail: string; ids: unknown; created_at: string }

export interface Participant { id: string; label: string; segment?: string }
export interface SpeakerInfo { role?: "moderator" | "participant"; group?: string }
export interface StoredSegment { id: string; index: number; speaker?: string; start?: number; end?: number; responseId?: string; questionId?: string; group?: string; text: string }

export interface QualSessionView {
  id: string; kind: "interview" | "focus_group"; title: string; scheduledAt: string | null; moderator: string | null;
  participants: Participant[]; consent: { captured?: boolean; recording?: boolean; method?: string; at?: string; note?: string };
  notes: string | null; observations: { at?: string; text: string }[]; status: string; recordingMediaId: string | null;
}
export interface QualTranscriptView {
  id: string; sessionId: string | null; title: string; source: "import" | "stt" | "open_ends" | "ai_interview"; format: string | null; language: string | null;
  status: string; error: string | null; charCount: number; mediaId: string | null; createdAt?: string;
  speakers: Record<string, SpeakerInfo>; segments: QualSegment[]; warnings: string[];
}
export interface QualSettings { redactNames: string[] }
export interface QualWorkspace {
  sessions: QualSessionView[]; transcripts: QualTranscriptView[]; state: QualState; version: number; history: QualHistoryEntry[];
  /** only for a member with contact details: the names list is itself personal data */
  settings: QualSettings | null;
  /** true when the text is shown as stored; false when e-mails, phones and the names list are replaced */
  pii: boolean;
  /** the coders' names by user id, from the history ("ai" is the model) — for the comparison picker */
  people: Record<string, string>;
}

const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function readSettings(v: unknown): QualSettings {
  const o = obj(v);
  return { redactNames: arr(o.redactNames).map((x) => str(x, 120)).filter((x): x is string => !!x).slice(0, 500) };
}

/** the speaker map: what the row says, else the role suggested from the label and the group from the session's participants */
export function speakerMap(row: Pick<TranscriptRow, "speakers" | "segments">, participants: Participant[] = []): Record<string, SpeakerInfo> {
  const stored = obj(row.speakers);
  const out: Record<string, SpeakerInfo> = {};
  const labels = [...new Set(arr<StoredSegment>(row.segments).map((s) => s.speaker).filter((s): s is string => !!s))];
  for (const label of labels) {
    const s = obj(stored[label]);
    const p = participants.find((x) => x.label.toLowerCase() === label.toLowerCase() || x.id.toLowerCase() === label.toLowerCase());
    const role = s.role === "moderator" || s.role === "participant" ? s.role : suggestRole(label);
    const group = str(s.group, 120) ?? p?.segment;
    out[label] = { ...(role ? { role } : {}), ...(group ? { group } : {}) };
  }
  return out;
}

/** a transcript row's segments as the analysis reads them */
export function segmentsOf(row: TranscriptRow, participants: Participant[] = []): QualSegment[] {
  const map = speakerMap(row, participants);
  const kind = row.source === "open_ends" ? "response" : "transcript";
  return arr<StoredSegment>(row.segments).map((s, i) => {
    const info = s.speaker ? map[s.speaker] : undefined;
    const role = kind === "response" ? "participant" : info?.role;
    const group = s.group ?? info?.group;
    return { id: String(s.id), sourceKind: kind, sourceId: row.id, index: Number.isInteger(s.index) ? s.index : i, ...(s.speaker ? { speaker: s.speaker } : {}), ...(typeof s.start === "number" ? { start: s.start } : {}), ...(typeof s.end === "number" ? { end: s.end } : {}), ...(s.responseId ? { responseId: s.responseId } : {}), ...(s.questionId ? { questionId: s.questionId } : {}), ...(role ? { role } : {}), ...(group ? { group } : {}), text: String(s.text ?? "") };
  });
}

export function sessionView(r: SessionRow): QualSessionView {
  const c = obj(r.consent);
  return {
    id: r.id, kind: r.kind === "focus_group" ? "focus_group" : "interview", title: r.title, scheduledAt: r.scheduled_at, moderator: r.moderator,
    participants: arr<Record<string, unknown>>(r.participants).map((p, i) => ({ id: str(p.id, 40) ?? `p${i + 1}`, label: str(p.label, 120) ?? `P${i + 1}`, ...(str(p.segment, 120) ? { segment: str(p.segment, 120) } : {}) })),
    consent: { ...(typeof c.captured === "boolean" ? { captured: c.captured } : {}), ...(typeof c.recording === "boolean" ? { recording: c.recording } : {}), ...(str(c.method, 200) ? { method: str(c.method, 200) } : {}), ...(str(c.at, 40) ? { at: str(c.at, 40) } : {}), ...(str(c.note) ? { note: str(c.note) } : {}) },
    notes: r.notes, observations: arr<Record<string, unknown>>(r.observations).map((o) => ({ ...(str(o.at, 20) ? { at: str(o.at, 20) } : {}), text: str(o.text) ?? "" })).filter((o) => o.text),
    status: r.status, recordingMediaId: r.recording_media_id,
  };
}

export function codingState(row: CodingRow | null): { state: QualState; version: number } {
  if (!row) return { state: { codebook: emptyCodebook(), excerpts: [] }, version: 0 };
  const cb = obj(row.codebook) as unknown as QualCodebook;
  return { state: { codebook: { ...emptyCodebook(), ...cb, codes: arr(cb.codes), themes: arr(cb.themes), relationships: arr(cb.relationships) }, excerpts: arr<QualExcerpt>(row.excerpts) }, version: row.version ?? 0 };
}

export const historyOf = (rows: EventRow[]): QualHistoryEntry[] => rows.map((e) => ({ at: e.created_at, actor: e.actor_label ?? e.actor ?? "", action: e.action, detail: e.detail, ids: arr<string>(e.ids) }));

/**
 * The workspace for one member. Without contact details, every text a person typed or said passes
 * through the redaction (e-mails, phones, the names list), and a speaker or participant label on the
 * names list becomes "Participant n" — stable across the workspace, so who-said-what still reads.
 */
export function toWorkspace(rows: { sessions: SessionRow[]; transcripts: TranscriptRow[]; coding: CodingRow | null; events: EventRow[] }, opts: { pii: boolean }): QualWorkspace {
  const settings = readSettings(rows.coding?.settings);
  const sessions = rows.sessions.map(sessionView);
  const participantsOf = (sessionId: string | null) => sessions.find((s) => s.id === sessionId)?.participants ?? [];
  const transcripts: QualTranscriptView[] = rows.transcripts.map((t) => ({
    id: t.id, sessionId: t.session_id, title: t.title, source: (t.source === "stt" || t.source === "open_ends" || t.source === "ai_interview" ? t.source : "import") as QualTranscriptView["source"], format: t.format, language: t.language,
    status: t.status, error: t.error, charCount: t.char_count, mediaId: t.media_id, ...(t.created_at ? { createdAt: t.created_at } : {}),
    speakers: speakerMap(t, participantsOf(t.session_id)), segments: segmentsOf(t, participantsOf(t.session_id)), warnings: arr<string>(obj(t.meta).warnings).filter((w) => typeof w === "string"),
  }));
  const { state, version } = codingState(rows.coding);
  const history = historyOf(rows.events);
  const people: Record<string, string> = { ai: "AI (suggested)" };
  for (const e of rows.events) if (e.actor && e.actor_label) people[e.actor] = e.actor_label;
  const ws: QualWorkspace = { sessions, transcripts, state, version, history, settings: opts.pii ? settings : null, pii: opts.pii, people };
  return opts.pii ? ws : redactWorkspace(ws, settings.redactNames);
}

/** the workspace as a member without contact details reads it */
export function redactWorkspace(ws: QualWorkspace, names: string[]): QualWorkspace {
  const nameSet = new Set(names.map((n) => n.toLowerCase()));
  const alias = new Map<string, string>();
  const label = (s: string | undefined) => { if (!s || !nameSet.has(s.toLowerCase())) return s; if (!alias.has(s.toLowerCase())) alias.set(s.toLowerCase(), `Participant ${alias.size + 1}`); return alias.get(s.toLowerCase())!; };
  const red = (t: string) => redactText(t, { names }).text;
  const segs = (list: QualSegment[]) => list.map((s) => ({ ...s, ...(s.speaker ? { speaker: label(s.speaker) } : {}), text: red(s.text) }));
  return {
    ...ws,
    settings: null,
    pii: false,
    sessions: ws.sessions.map((s) => ({ ...s, participants: s.participants.map((p) => ({ ...p, label: label(p.label)! })), notes: s.notes ? red(s.notes) : s.notes, observations: s.observations.map((o) => ({ ...o, text: red(o.text) })), consent: { ...s.consent, ...(s.consent.note ? { note: red(s.consent.note) } : {}) } })),
    transcripts: ws.transcripts.map((t) => ({ ...t, title: red(t.title), speakers: Object.fromEntries(Object.entries(t.speakers).map(([k, v]) => [label(k)!, v])), segments: segs(t.segments) })),
    /* a redacted quote is no longer the exact span of the stored text — the member reads it as redacted, and cannot write excerpts (the routes refuse a span on redacted text) */
    state: { ...ws.state, excerpts: ws.state.excerpts.map((e) => ({ ...e, ...(e.speaker ? { speaker: label(e.speaker) } : {}), quote: red(e.quote) })) },
    history: ws.history.map((h) => ({ ...h, detail: red(h.detail) })),
  };
}

/** every segment of the workspace */
export const allSegments = (ws: Pick<QualWorkspace, "transcripts">): QualSegment[] => ws.transcripts.flatMap((t) => t.segments);

/* ------------------------------------------------------------ request bodies */

export type Fields<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SessionFields { kind?: "interview" | "focus_group"; title?: string; scheduled_at?: string | null; moderator?: string | null; participants?: Participant[]; consent?: Record<string, unknown>; notes?: string | null; observations?: { at?: string; text: string }[]; status?: "planned" | "completed" | "cancelled" }

/** a session from the browser: everything optional on an update; a title on a create */
export function parseSessionInput(body: unknown, create: boolean): Fields<SessionFields> {
  const o = obj(body);
  const out: SessionFields = {};
  if (o.kind !== undefined) { if (o.kind !== "interview" && o.kind !== "focus_group") return { ok: false, error: "kind is interview or focus_group" }; out.kind = o.kind; }
  if (o.title !== undefined) { const t = str(o.title, 200); if (!t) return { ok: false, error: "a session needs a title" }; out.title = t; }
  else if (create) return { ok: false, error: "a session needs a title" };
  if (o.scheduledAt !== undefined) { if (o.scheduledAt === null || o.scheduledAt === "") out.scheduled_at = null; else { const d = Date.parse(String(o.scheduledAt)); if (!Number.isFinite(d)) return { ok: false, error: "scheduledAt is a date" }; out.scheduled_at = new Date(d).toISOString(); } }
  if (o.moderator !== undefined) out.moderator = str(o.moderator, 120) ?? null;
  if (o.participants !== undefined) {
    if (!Array.isArray(o.participants)) return { ok: false, error: "participants is a list" };
    out.participants = o.participants.slice(0, 50).map((p, i) => { const x = typeof p === "string" ? { label: p } : obj(p); const lab = str(x.label, 120) ?? `P${i + 1}`; return { id: str(x.id, 40) ?? `p${i + 1}`, label: lab, ...(str(x.segment, 120) ? { segment: str(x.segment, 120) } : {}) }; });
  }
  if (o.consent !== undefined) { const c = obj(o.consent); out.consent = { ...(typeof c.captured === "boolean" ? { captured: c.captured } : {}), ...(typeof c.recording === "boolean" ? { recording: c.recording } : {}), ...(str(c.method, 200) ? { method: str(c.method, 200) } : {}), ...(str(c.at, 40) ? { at: str(c.at, 40) } : {}), ...(str(c.note) ? { note: str(c.note) } : {}) }; }
  if (o.notes !== undefined) out.notes = str(o.notes, 20_000) ?? null;
  if (o.observations !== undefined) { if (!Array.isArray(o.observations)) return { ok: false, error: "observations is a list" }; out.observations = o.observations.slice(0, 500).map((x) => { const y = typeof x === "string" ? { text: x } : obj(x); return { ...(str(y.at, 20) ? { at: str(y.at, 20) } : {}), text: str(y.text) ?? "" }; }).filter((x) => x.text); }
  if (o.status !== undefined) { if (!["planned", "completed", "cancelled"].includes(String(o.status))) return { ok: false, error: "status is planned, completed or cancelled" }; out.status = o.status as SessionFields["status"]; }
  if (!create && !Object.keys(out).length) return { ok: false, error: "nothing to change" };
  /* consent to record must be captured before a session is marked completed with a recording — a warning the UI shows; not a refusal (consent may be on paper) */
  return { ok: true, value: out };
}

export interface TranscriptFields { title: string; source: "import" | "stt" | "open_ends"; format: string; language?: string | null; segments: StoredSegment[]; speakers: Record<string, SpeakerInfo>; char_count: number; meta: { warnings: string[]; [k: string]: unknown }; session_id?: string | null }

const FORMATS = new Set<string>(["vtt", "srt", "speaker", "text"]);

/** an imported transcript: parsed, segmented, the speaker map suggested (moderator from the label, group from the session's participants) */
export function importTranscript(input: { text: string; title?: string; fileName?: string; format?: string; fromDocx?: boolean; sessionId?: string | null; participants?: Participant[] }): Fields<TranscriptFields> {
  const text = String(input.text ?? "");
  if (!text.trim()) return { ok: false, error: "the transcript is empty" };
  const fmt = input.format && FORMATS.has(input.format) ? (input.format as TranscriptFormat) : "auto";
  const p = parseTranscript(text, { format: fmt, fileName: input.fileName });
  if (!p.turns.length) return { ok: false, error: p.warnings[0] ?? "no text was found" };
  const segments: StoredSegment[] = p.turns.map((t, i) => ({ id: `t${i + 1}`, index: i, ...(t.speaker ? { speaker: t.speaker } : {}), ...(t.start !== undefined ? { start: t.start } : {}), ...(t.end !== undefined ? { end: t.end } : {}), text: t.text }));
  const speakers = speakerMap({ speakers: {}, segments }, input.participants ?? []);
  const title = str(input.title, 200) ?? str(input.fileName?.replace(/\.[^.]+$/, ""), 200) ?? "Transcript";
  return { ok: true, value: { title, source: "import", format: input.fromDocx ? "docx" : p.format, segments, speakers, char_count: segments.reduce((n, s) => n + s.text.length, 0), meta: { warnings: p.warnings, detected: p.format, speakers: p.speakers.length }, ...(input.sessionId ? { session_id: input.sessionId } : {}) } };
}

/** a speech-to-text result as a transcript: the provider's timed (and, when it could, diarized) segments, else one segment */
export function sttTranscript(t: { text: string; language?: string; model: string; segments?: { start: number; end: number; text: string; speaker?: string }[]; diarized?: boolean; speakerCount?: number; durationSeconds?: number }, title: string, participants: Participant[] = []): TranscriptFields {
  const segs: StoredSegment[] = t.segments?.length
    ? t.segments.filter((s) => s.text?.trim()).map((s, i) => ({ id: `t${i + 1}`, index: i, ...(s.speaker ? { speaker: s.speaker } : {}), start: s.start, end: s.end, text: s.text.trim() }))
    : [{ id: "t1", index: 0, text: t.text.trim() }];
  const warnings = [
    ...(t.diarized ? [] : ["The transcription service did not separate speakers: every turn is unattributed. Assign speakers, or import a transcript with speaker names."]),
    "Speech-to-text can mishear words and names — check the transcript against the recording before coding.",
  ];
  return { title, source: "stt", format: "stt", language: t.language ?? null, segments: segs, speakers: speakerMap({ speakers: {}, segments: segs }, participants), char_count: segs.reduce((n, s) => n + s.text.length, 0), meta: { warnings, model: t.model, diarized: !!t.diarized, speakerCount: t.speakerCount ?? null, durationSeconds: t.durationSeconds ?? null } };
}

/** open-ended answers as a source: one segment per answered response × question */
export function openEndsTranscript(rows: { id: string; answers: unknown }[], questions: { id: string; code?: string; text?: string }[], title?: string): Fields<TranscriptFields> {
  if (!questions.length) return { ok: false, error: "choose at least one open-ended question" };
  const segs = openEndSegments("_", rows.map((r) => ({ responseId: r.id, answers: obj(r.answers) })), questions);
  if (!segs.length) return { ok: false, error: "no one has answered those questions yet" };
  const segments: StoredSegment[] = segs.map((s, i) => ({ id: s.id, index: i, speaker: s.speaker, responseId: s.responseId, questionId: s.questionId, text: s.text }));
  return { ok: true, value: { title: str(title, 200) ?? `Open-ended answers: ${questions.map((q) => q.code ?? q.id).join(", ")}`, source: "open_ends", format: "open_ends", segments, speakers: {}, char_count: segments.reduce((n, s) => n + s.text.length, 0), meta: { warnings: [], questionIds: questions.map((q) => q.id), responses: new Set(segs.map((s) => s.responseId)).size } } };
}

/** a speaker-map edit: roles and groups by label, only labels the transcript has */
export function parseSpeakerEdit(body: unknown, current: Record<string, SpeakerInfo>): Fields<Record<string, SpeakerInfo>> {
  const o = obj(body);
  const next: Record<string, SpeakerInfo> = JSON.parse(JSON.stringify(current));
  for (const [label, v] of Object.entries(o)) {
    if (!(label in next)) return { ok: false, error: `the transcript has no speaker “${label}”` };
    const x = obj(v);
    if (x.role !== undefined) { if (x.role !== "moderator" && x.role !== "participant") return { ok: false, error: "a speaker's role is moderator or participant" }; next[label].role = x.role; }
    if (x.group !== undefined) { const g = str(x.group, 120); if (g) next[label].group = g; else delete next[label].group; }
  }
  return { ok: true, value: next };
}

/** an error from a database without migration 0065 */
export const missingQualMigration = (message: string | undefined): boolean => /qual_(?:sessions|transcripts|codings|events)|relation .* does not exist|column .* does not exist/i.test(message ?? "") && /does not exist|schema cache/i.test(message ?? "");
export const QUAL_MIGRATION_MESSAGE = "The qualitative workspace needs database migration 0065 (sessions, transcripts and coding). Ask an administrator to apply it; the interview guide still works.";

/** what the AI-coding route may read: everything, one source, or chosen segments */
export function parseCodingRequest(body: unknown): Fields<{ mode: "inductive" | "deductive"; framework?: string; sourceIds?: string[]; segmentKeys?: string[]; version: number }> {
  const o = obj(body);
  const mode = o.mode === "deductive" ? "deductive" : o.mode === undefined || o.mode === "inductive" ? "inductive" : null;
  if (!mode) return { ok: false, error: "mode is inductive or deductive" };
  const version = Number(o.version);
  if (!Number.isInteger(version) || version < 0) return { ok: false, error: "send the version of the codebook you are looking at (version)" };
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 120)).filter((x): x is string => !!x).slice(0, 2000) : undefined);
  return { ok: true, value: { mode, ...(str(o.framework, 8000) ? { framework: str(o.framework, 8000) } : {}), ...(list(o.sourceIds)?.length ? { sourceIds: list(o.sourceIds) } : {}), ...(list(o.segmentKeys)?.length ? { segmentKeys: list(o.segmentKeys) } : {}), version } };
}
