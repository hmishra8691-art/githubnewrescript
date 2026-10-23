"use client";
import type { SurveyDefinition } from "@rescript/schema";
import {
  editThemeSynthesis, editInsights, themeSynthesisState, insightsState, guideTextOf, applyReelOp, reelItemStates, selectForReel,
  newAssignment, applyCoderOp, coderView, assignmentAgreement, disagreements, resolve, mergeResolved, bothSubmitted,
  checkCorrection, editSegmentExcerpts, liveEvidence,
  type ThemeSynthesis, type StudyInsights, type SynthesisEdit, type AskAnswer, type HighlightReel, type ReelOp, type ItemState, type CodingAssignment, type CoderSet, type QualExcerpt, type QualOp,
  type AssignmentAgreement, type Disagreement, type QualJob, type AutoCodeSettings, type GroupSession, type PromptResults, type QualState, type StudyContext,
} from "@rescript/analytics";
import { allSegments, correctedSegment, type StoredSegment } from "@/lib/qual/qualWorkspace";
import { QualApiError, type QualApi, type SandboxHandle, type WorkspaceView } from "./qualApi";

/**
 * THE CLIENT FOR SYNTHESIS, DOUBLE-CODING, HIGHLIGHTS, CORRECTIONS, AUTO-CODING AND GROUP SESSIONS (2026-10-22).
 * Like `qualApi.ts`: a saved project talks to the routes; the sandbox keeps its records in the page and runs the
 * same pure functions, calling the routes' sandbox branches for the model (fake provider only) and the documents.
 */

export interface SynthesisView<T> { record: T & { state: "current" | "stale" }; version: number; versions: { version: number; status: string; at?: string }[] }
export interface SynthesisState { themes: Record<string, SynthesisView<ThemeSynthesis>>; insights: SynthesisView<StudyInsights> | null }
export interface AskResult extends AskAnswer { quotes: { id: string; quote: string; source: string; speaker?: string; start?: number }[] }
export interface ReelView extends HighlightReel { states: Record<string, ItemState> }
export interface AssignmentView extends CodingAssignment { role: "A" | "B" | "lead"; blind: boolean; progress: Record<string, number>; mine: QualExcerpt[]; other: QualExcerpt[] | null; agreement?: AssignmentAgreement; disagreements?: Disagreement[] }
export interface GroupListItem { id: string; title: string; status: string; mode: string; phase: string; joinCode: string; transcriptId?: string | null }
export interface GroupLive { id: string; joinCode: string; version: number; state: GroupSession; participants: { id: string; handle: string; group: string | null; joinedAt: string; lastSeenAt: string | null }[]; answers: { id: string; promptId: string; handle: string; text: string; at: string }[]; results: Record<string, PromptResults>; current: { id: string; text: string; answered: number } | null; votes: number }

export interface SynthesisApi {
  sandbox: boolean;
  load(): Promise<SynthesisState>;
  writeThemes(themeIds?: string[]): Promise<{ state: SynthesisState; dropped: { text: string; reason: string; section?: string }[]; calls: number }>;
  writeInsights(compare?: [string, string] | null): Promise<{ state: SynthesisState; dropped: { text: string; reason: string; section?: string }[]; calls: number }>;
  editTheme(themeId: string, version: number, edit: SynthesisEdit): Promise<SynthesisState>;
  editInsights(version: number, edit: Parameters<typeof editInsights>[1]): Promise<SynthesisState>;
  ask(question: string): Promise<AskResult>;
  reels(): Promise<{ reels: ReelView[]; can: { playback: boolean; edit: boolean; export: boolean } }>;
  createReel(name: string, excerptIds: string[], description?: string): Promise<ReelView[]>;
  reelOp(reel: ReelView, op: ReelOp): Promise<ReelView[]>;
  deleteReel(reel: ReelView): Promise<ReelView[]>;
  exportReel(reel: ReelView, format: "docx" | "pptx"): Promise<{ blob: Blob; name: string }>;
  clip(excerptId: string): Promise<{ url: string; start: number; end: number; approximate: boolean; byWords?: boolean }>;
  assignments(): Promise<{ me: string; assignments: AssignmentView[] }>;
  createAssignment(input: { coderA?: string; coderB: string; overlapPct: number; name?: string }): Promise<void>;
  coderOp(assignmentId: string, op: QualOp): Promise<void>;
  aiCode(assignmentId: string): Promise<void>;
  submit(assignmentId: string): Promise<void>;
  resolveDisagreement(assignmentId: string, r: { unit: string; codeId: string; decision: "apply" | "not_apply"; note?: string }): Promise<void>;
  merge(assignmentId: string): Promise<{ added: number; ws?: WorkspaceView }>;
  correct(transcriptId: string, segmentId: string, text: string): Promise<{ ws: WorkspaceView; summary: string }>;
  jobs(): Promise<{ settings: AutoCodeSettings; jobs: QualJob[] }>;
  setAutoCode(s: AutoCodeSettings): Promise<AutoCodeSettings>;
  continueJobs(): Promise<{ jobs: QualJob[]; idle?: boolean; ws?: WorkspaceView }>;
  groups(): Promise<GroupListItem[]>;
  group(id: string): Promise<GroupLive>;
  createGroup(input: { title: string; mode: "moderated" | "autonomous"; prompts?: string[]; settings?: Record<string, unknown> }): Promise<string>;
  groupOp(g: GroupLive, op: Record<string, unknown>): Promise<void>;
  groupAi(id: string, step: "cluster" | "followup"): Promise<{ note?: string }>;
  groupSegment(id: string, participantId: string, segment: string): Promise<void>;
  closeGroup(id: string): Promise<{ ws?: WorkspaceView }>;
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new QualApiError((j as { error?: string }).error ?? `The request failed (${r.status}).`, r.status, (j as { code?: string }).code);
  return j as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function download(url: string, body: unknown, fallback: string): Promise<{ blob: Blob; name: string }> {
  const r = await fetch(url, post(body));
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new QualApiError((j as { error?: string }).error ?? `The file could not be made (${r.status}).`, r.status); }
  return { blob: await r.blob(), name: /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? fallback };
}

/* ------------------------------------------------------------ a saved project */

export function httpSynthesisApi(surveyId: string, onWorkspace: (ws: WorkspaceView) => void, reload: () => Promise<WorkspaceView>): SynthesisApi {
  const base = `/api/surveys/${surveyId}/qual`;
  const ws = async () => { const w = await reload(); onWorkspace(w); return w; };
  return {
    sandbox: false,
    async load() { return call<SynthesisState>(`${base}/synthesis`); },
    async writeThemes(themeIds) { const r = await call<SynthesisState & { dropped: never[]; calls: number }>(`${base}/synthesis`, post({ action: "themes", ...(themeIds ? { themeIds } : {}) })); return { state: r, dropped: r.dropped ?? [], calls: r.calls }; },
    async writeInsights(compare) { const r = await call<SynthesisState & { dropped: never[]; calls: number }>(`${base}/synthesis`, post({ action: "insights", ...(compare ? { compare } : {}) })); return { state: r, dropped: r.dropped ?? [], calls: r.calls }; },
    async editTheme(themeId, version, edit) { return call<SynthesisState>(`${base}/synthesis`, post({ action: "edit_theme", themeId, version, edit })); },
    async editInsights(version, edit) { return call<SynthesisState>(`${base}/synthesis`, post({ action: "edit_insights", version, edit })); },
    async ask(question) { return (await call<{ answer: AskResult }>(`${base}/ask`, post({ question }))).answer; },
    async reels() { return call(`${base}/highlights`); },
    async createReel(name, excerptIds, description) { await call(`${base}/highlights`, post({ action: "create", name, excerptIds, description })); return (await this.reels()).reels; },
    async reelOp(reel, op) { await call(`${base}/highlights`, post({ action: "op", reelId: reel.id, version: reel.version, op })); return (await this.reels()).reels; },
    async deleteReel(reel) { await call(`${base}/highlights`, post({ action: "delete", reelId: reel.id })); return (await this.reels()).reels; },
    exportReel(reel, format) { return download(`${base}/export`, { type: "highlights", reelId: reel.id, format }, `highlights.${format}`); },
    async clip(excerptId) { return call(`${base}/highlights?clip=${encodeURIComponent(excerptId)}`); },
    async assignments() { return call(`${base}/double-coding`); },
    async createAssignment(input) { await call(`${base}/double-coding`, post({ action: "create", ...input })); },
    async coderOp(assignmentId, op) { await call(`${base}/double-coding`, post({ action: "code", assignmentId, op })); },
    async aiCode(assignmentId) { await call(`${base}/double-coding`, post({ action: "ai_code", assignmentId })); },
    async submit(assignmentId) { await call(`${base}/double-coding`, post({ action: "submit", assignmentId })); },
    async resolveDisagreement(assignmentId, r) { await call(`${base}/double-coding`, post({ action: "resolve", assignmentId, ...r })); },
    async merge(assignmentId) { const r = await call<{ added: number }>(`${base}/double-coding`, post({ action: "merge", assignmentId })); return { added: r.added, ws: await ws() }; },
    async correct(transcriptId, segmentId, text) {
      const cur = await call<{ revision: number }>(`${base}/transcripts/edit?transcriptId=${encodeURIComponent(transcriptId)}`);
      const r = await call<{ workspace: WorkspaceView; summary: string }>(`${base}/transcripts/edit`, post({ transcriptId, segmentId, text, revision: cur.revision }));
      const w = await ws();
      return { ws: w, summary: r.summary };
    },
    async jobs() { return call(`${base}/jobs`); },
    async setAutoCode(s) { return (await call<{ settings: AutoCodeSettings }>(`${base}/jobs`, post({ action: "settings", autoCode: s }))).settings; },
    async continueJobs() { const r = await call<{ jobs: QualJob[]; idle?: boolean }>(`${base}/jobs`, post({ action: "continue" })); return { ...r, ...(r.idle ? {} : { ws: await ws() }) }; },
    async groups() { return (await call<{ sessions: GroupListItem[] }>(`${base}/groups`)).sessions; },
    async group(id) { return (await call<{ session: GroupLive }>(`${base}/groups?id=${encodeURIComponent(id)}`)).session; },
    async createGroup(input) { return (await call<{ id: string }>(`${base}/groups`, post({ action: "create", ...input }))).id; },
    async groupOp(g, op) { await call(`${base}/groups`, post({ action: "op", id: g.id, version: g.version, op })); },
    async groupAi(id, step) { return call(`${base}/groups`, post({ action: "ai", id, step })); },
    async groupSegment(id, participantId, segment) { await call(`${base}/groups`, post({ action: "segment", id, participantId, segment })); },
    async closeGroup(id) { await call(`${base}/groups`, post({ action: "close", id })); return { ws: await ws() }; },
  };
}

/* ------------------------------------------------------------ the sandbox */

interface SandboxRecords { themes: Map<string, { rec: ThemeSynthesis; versions: { version: number; status: string; at?: string }[] }>; insights: { rec: StudyInsights; versions: { version: number; status: string; at?: string }[] } | null; reels: HighlightReel[]; assignments: (CodingAssignment & { version: number })[]; sets: Map<string, CoderSet[]>; autoCode: AutoCodeSettings; autoCoded: Set<string> }
const RECORDS = new WeakMap<SandboxHandle, SandboxRecords>();
const ME = "sandbox-user";

export function studyOfDef(def: SurveyDefinition): StudyContext {
  const qs = def.qualStudy;
  const objectives = qs?.objectives?.length ? qs.objectives : [def.research?.objective, ...(def.research?.researchQuestions ?? [])].filter((x): x is string => !!x);
  return { objectives, hypotheses: def.research?.hypotheses ?? [], guideText: guideTextOf(qs ?? null) };
}

export function sandboxSynthesisApi(api: QualApi, getDef: () => SurveyDefinition, onWorkspace: (ws: WorkspaceView) => void): SynthesisApi {
  const h = api.sandboxHandle!;
  let rec = RECORDS.get(h);
  if (!rec) { rec = { themes: new Map(), insights: null, reels: [], assignments: [], sets: new Map(), autoCode: { enabled: false, mode: "auto", maxBatchesPerSource: 6, updateSummaries: false }, autoCoded: new Set() }; RECORDS.set(h, rec); }
  const R = rec;
  const now = () => new Date().toISOString();
  const ctx = () => { const ws = h.view(); return { ws, state: ws.state as QualState, segments: allSegments(ws), sources: Object.fromEntries(ws.transcripts.map((t) => [t.id, { title: t.title, sessionId: t.sessionId }])), names: ws.settings?.redactNames ?? [], study: studyOfDef(getDef()) }; };
  const fake = (k: string) => ((globalThis as Record<string, unknown>)[k] as unknown[] | undefined) ?? null;
  const state = (): SynthesisState => {
    const c = ctx();
    const themes: SynthesisState["themes"] = {};
    for (const [id, x] of R.themes) themes[id] = { record: { ...x.rec, state: themeSynthesisState(x.rec, c.state, c.segments) === "current" ? "current" : "stale" }, version: x.versions[0].version, versions: x.versions };
    return { themes, insights: R.insights ? { record: { ...R.insights.rec, state: insightsState(R.insights.rec, c.state, c.segments, c.study) === "current" ? "current" : "stale" }, version: R.insights.versions[0].version, versions: R.insights.versions } : null };
  };
  const bump = (versions: { version: number; status: string; at?: string }[], status: string) => [{ version: (versions[0]?.version ?? 0) + 1, status, at: now() }, ...versions];
  const assignment = (id: string) => R.assignments.find((a) => a.id === id) ?? (() => { throw new QualApiError("no such assignment", 404); })();
  const groupsUrl = "/api/surveys/sandbox/qual/groups";
  const api2: SynthesisApi = {
    sandbox: true,
    async load() { return state(); },
    async writeThemes(themeIds) {
      const c = ctx();
      const r = await call<{ records: ThemeSynthesis[]; calls: number }>("/api/surveys/sandbox/qual/synthesis", post({ action: "themes", ...(themeIds ? { themeIds } : {}), state: c.state, segments: c.segments, sources: c.sources, study: c.study, redactNames: c.names, fake: fake("__rescriptSynthesisFake") }));
      for (const x of r.records) { const cur = R.themes.get(x.themeId); R.themes.set(x.themeId, { rec: x, versions: bump(cur?.versions ?? [], "ai") }); }
      h.event("synthesis.themes", `AI theme summaries written for ${r.records.length} themes`, [], "ai");
      onWorkspace(h.view());
      return { state: state(), dropped: r.records.flatMap((x) => x.dropped), calls: r.calls };
    },
    async writeInsights(compare) {
      const c = ctx();
      const summaries = [...R.themes.values()].map((x) => x.rec);
      const r = await call<{ record: StudyInsights; calls: number }>("/api/surveys/sandbox/qual/synthesis", post({ action: "insights", ...(compare ? { compare } : {}), state: c.state, segments: c.segments, sources: c.sources, study: c.study, summaries, redactNames: c.names, fake: fake("__rescriptInsightsFake") }));
      R.insights = { rec: r.record, versions: bump(R.insights?.versions ?? [], "ai") };
      h.event("synthesis.insights", "AI key findings written", [], "ai");
      onWorkspace(h.view());
      return { state: state(), dropped: r.record.dropped, calls: r.calls };
    },
    async editTheme(themeId, version, edit) {
      const cur = R.themes.get(themeId);
      if (!cur) throw new QualApiError("nothing to edit — generate it first", 404);
      if (cur.versions[0].version !== version) throw new QualApiError("The write-up has changed since you loaded it — reload.", 409, "version_conflict");
      const c = ctx();
      try { R.themes.set(themeId, { rec: editThemeSynthesis(cur.rec, edit, c.state, c.segments, { actor: ME, now: now() }), versions: bump(cur.versions, "edited") }); } catch (e) { throw new QualApiError((e as Error).message, 400); }
      h.event("synthesis.edited", `Edited the summary of theme ${themeId}`, [themeId]);
      return state();
    },
    async editInsights(version, edit) {
      if (!R.insights) throw new QualApiError("nothing to edit — generate it first", 404);
      if (R.insights.versions[0].version !== version) throw new QualApiError("The write-up has changed since you loaded it — reload.", 409, "version_conflict");
      const c = ctx();
      try { R.insights = { rec: editInsights(R.insights.rec, edit, c.state, c.segments, { actor: ME, now: now() }), versions: bump(R.insights.versions, "edited") }; } catch (e) { throw new QualApiError((e as Error).message, 400); }
      return state();
    },
    async ask(question) {
      const c = ctx();
      return (await call<{ answer: AskResult }>("/api/surveys/sandbox/qual/ask", post({ question, state: c.state, segments: c.segments, sources: c.sources, redactNames: c.names, fake: fake("__rescriptAskFake") }))).answer;
    },
    async reels() { const c = ctx(); return { reels: R.reels.map((r) => ({ ...r, states: reelItemStates(r, c.state, c.segments) })), can: { playback: true, edit: true, export: true } }; },
    async createReel(name, excerptIds, description) {
      const c = ctx();
      let reel: HighlightReel = { id: `reel${R.reels.length + 1}`, name: name.trim(), ...(description ? { description } : {}), items: [], createdBy: ME, createdAt: now(), updatedAt: now(), version: 0 };
      if (!reel.name) throw new QualApiError("a reel needs a name", 400);
      if (excerptIds.length) { try { reel = applyReelOp(reel, { op: "add", excerptIds }, c.state, c.segments, now()); } catch (e) { throw new QualApiError((e as Error).message, 400); } }
      R.reels.push(reel); h.event("highlights.created", `Made the highlight reel “${reel.name}” (${reel.items.length} quotes)`, [reel.id]);
      return (await this.reels()).reels;
    },
    async reelOp(reel, op) {
      const c = ctx(); const i = R.reels.findIndex((r) => r.id === reel.id);
      if (i < 0) throw new QualApiError("no such reel", 404);
      try { R.reels[i] = applyReelOp(R.reels[i], op, c.state, c.segments, now()); } catch (e) { throw new QualApiError((e as Error).message, 400); }
      return (await this.reels()).reels;
    },
    async deleteReel(reel) { R.reels = R.reels.filter((r) => r.id !== reel.id); return (await this.reels()).reels; },
    exportReel(reel, format) { const c = ctx(); return download("/api/surveys/sandbox/qual/export", { type: "highlights", format, reel, states: reel.states, sources: Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, { title: v.title }])), definition: getDef() }, `highlights.${format}`); },
    /* #17: a recording transcribed in this page plays from the page (its object URL); the clip is the excerpt's own words */
    async clip(excerptId) { return api.clip(excerptId); },
    async assignments() {
      const c = ctx();
      return { me: ME, assignments: R.assignments.map((a) => { const sets = R.sets.get(a.id) ?? []; const v = coderView(a, sets, ME); const open = bothSubmitted(a); return { ...a, role: v.role, blind: v.blind, progress: v.progress, mine: v.mine, other: v.other, ...(open ? { agreement: assignmentAgreement(a, sets, c.state.codebook), disagreements: disagreements(a, sets, c.state.codebook) } : {}) }; }) };
    },
    async createAssignment(input) {
      const c = ctx();
      try {
        const a = newAssignment({ id: `da${R.assignments.length + 1}`, name: input.name, coderA: input.coderA ?? ME, coderB: input.coderB, segments: c.segments, overlapPct: input.overlapPct, codebook: c.state.codebook, actor: ME, now: now() });
        R.assignments.unshift({ ...a, version: 0 }); R.sets.set(a.id, [{ coder: a.coderA, excerpts: [] }, { coder: a.coderB, excerpts: [] }]);
        h.event("double_coding.created", `Set up blind double-coding “${a.name}”: ${a.units.length} segments (${a.overlapPct}%), ${a.codeIds.length} codes`, [a.id]);
      } catch (e) { throw new QualApiError((e as Error).message, 400); }
    },
    async coderOp(id, op) {
      const a = assignment(id); const c = ctx(); const sets = R.sets.get(id)!;
      const i = sets.findIndex((s) => s.coder === ME);
      if (i < 0) throw new QualApiError("only the two coders code an assignment", 403);
      try { sets[i] = applyCoderOp(a, sets[i], op, c.state.codebook, { now: now(), segment: (src, sid) => c.segments.find((s) => s.sourceId === src && s.id === sid) }); } catch (e) { throw new QualApiError((e as Error).message, 400); }
    },
    async aiCode(id) {
      const a = assignment(id); const c = ctx();
      if (a.coderA !== "ai" && a.coderB !== "ai") throw new QualApiError("the AI is not a coder of this assignment", 400);
      const codebook = { ...c.state.codebook, codes: c.state.codebook.codes.filter((x) => a.codeIds.includes(x.id)) };
      const r = await call<{ state: QualState }>("/api/surveys/sandbox/qual/coding", post({ action: "ai", mode: "deductive", segmentKeys: a.units, version: 0, state: { codebook, excerpts: [] }, segments: c.segments, settings: { redactNames: c.names }, objectives: c.study.objectives, fake: fake("__rescriptDoubleFake") }));
      const sets = R.sets.get(id)!; const i = sets.findIndex((s) => s.coder === "ai");
      sets[i] = { coder: "ai", excerpts: r.state.excerpts.filter((e) => a.codeIds.includes(e.codeId)).map((e) => ({ ...e, coder: "ai" })) };
      a.submitted = { ...a.submitted, ai: now() }; if (bothSubmitted(a)) a.status = "review";
      h.event("double_coding.ai_coded", `The AI coded “${a.name}” blind (${sets[i].excerpts.length} codings)`, [a.id], "ai");
    },
    async submit(id) { const a = assignment(id); if (a.coderA !== ME && a.coderB !== ME) throw new QualApiError("only a coder submits", 403); a.submitted = { ...a.submitted, [ME]: now() }; if (bothSubmitted(a)) a.status = "review"; h.event("double_coding.submitted", `Submitted my coding of “${a.name}”`, [a.id]); },
    async resolveDisagreement(id, r) {
      const a = assignment(id);
      try { const x = resolve(a, r, { actor: ME, now: now() }); Object.assign(a, x.assignment); h.event(x.entry.action, x.entry.detail, x.entry.ids); } catch (e) { throw new QualApiError((e as Error).message, 400); }
    },
    async merge(id) {
      const a = assignment(id); const c = ctx();
      try { const m = mergeResolved(c.state, a, R.sets.get(id)!, { actor: ME, now: now() }); h.setState(m.state); a.status = "merged"; h.event(m.entry.action, m.entry.detail, m.entry.ids); const w = h.view(); onWorkspace(w); return { added: m.added, ws: w }; }
      catch (e) { throw new QualApiError((e as Error).message, 400); }
    },
    async correct(transcriptId, segmentId, text) {
      const t = h.rows.transcripts.find((x) => x.id === transcriptId);
      if (!t) throw new QualApiError("no such transcript", 404);
      const segs = t.segments as StoredSegment[];
      const at = segs.findIndex((s) => s.id === segmentId);
      if (at < 0) throw new QualApiError("no such segment", 404);
      const before = segs[at].text;
      const bad = checkCorrection(before, text);
      if (bad) throw new QualApiError(bad, 400);
      const revision = Number((t.meta as { revision?: number }).revision ?? 0) + 1;
      t.segments = segs.map((s, i) => (i === at ? correctedSegment(s, text) : s));
      t.meta = { ...(t.meta as Record<string, unknown>), revision };
      const c = ctx();
      const r = editSegmentExcerpts(c.state.excerpts, transcriptId, segmentId, before, text, { now: now(), revision });
      if (r.outcomes.length) h.setState({ ...c.state, excerpts: r.excerpts });
      for (const sets of R.sets.values()) for (const s of sets) s.excerpts = editSegmentExcerpts(s.excerpts, transcriptId, segmentId, before, text, { now: now(), revision }).excerpts;
      h.event("transcript.corrected", `Corrected ${segmentId} of “${t.title}” (revision ${revision}): ${r.summary}`, [transcriptId]);
      const w = h.view(); onWorkspace(w);
      return { ws: w, summary: r.summary };
    },
    async jobs() { return { settings: R.autoCode, jobs: [] }; },
    async setAutoCode(s) { R.autoCode = s; if (s.enabled) for (const t of h.rows.transcripts) R.autoCoded.add(t.id); h.event("settings.autocode", s.enabled ? `Turned automatic coding on (${s.mode})` : "Turned automatic coding off"); return s; },
    /* the sandbox's pipeline: every source added since auto-coding was turned on, coded through the coding route's sandbox branch */
    async continueJobs() {
      if (!R.autoCode.enabled) return { jobs: [], idle: true };
      const todo = h.rows.transcripts.filter((t) => !R.autoCoded.has(t.id));
      if (!todo.length) return { jobs: [], idle: true };
      const jobs: QualJob[] = [];
      for (const t of todo) {
        R.autoCoded.add(t.id);
        const c = ctx();
        const mode = R.autoCode.mode === "auto" ? (c.state.codebook.codes.some((x) => x.status !== "rejected") ? "deductive" : "inductive") : R.autoCode.mode;
        let r: { state: QualState; added: { excerpts: number; codes: number }; entry: { detail: string } };
        /* a failed call leaves the source to code on the next tick (the job is resumable, like the server's) */
        try { r = await call("/api/surveys/sandbox/qual/coding", post({ action: "ai", mode, sourceIds: [t.id], version: 0, state: c.state, segments: c.segments, settings: { redactNames: c.names }, objectives: c.study.objectives, fake: fake("__rescriptAutoFake") })); }
        catch (e) { R.autoCoded.delete(t.id); throw e; }
        h.setState(r.state);
        h.event("ai_coding.auto", `Auto-coding of “${t.title}”: ${r.entry.detail}`, [t.id], "ai");
        jobs.push({ id: `job-${t.id}`, kind: "autocode", key: `autocode:${t.id}:r0`, status: "done", sourceIds: [t.id], progress: { batchesTotal: 1, batchesDone: 1, calls: 1, excerpts: r.added.excerpts, codes: r.added.codes, rejected: 0, skippedSegments: 0, mode }, cursor: {} });
      }
      const w = h.view(); onWorkspace(w);
      return { jobs, ws: w };
    },
    async groups() { return (await call<{ sessions: GroupListItem[] }>(groupsUrl)).sessions; },
    async group(id) { return (await call<{ session: GroupLive }>(`${groupsUrl}?id=${encodeURIComponent(id)}`)).session; },
    async createGroup(input) { return (await call<{ id: string }>(groupsUrl, post({ action: "create", ...input, guide: getDef().qualStudy ?? null }))).id; },
    async groupOp(g, op) { await call(groupsUrl, post({ action: "op", id: g.id, version: g.version, op })); },
    async groupAi(id, step) { return call(groupsUrl, post({ action: "ai", id, step, objectives: studyOfDef(getDef()).objectives, fake: fake("__rescriptGroupFake") })); },
    async groupSegment(id, participantId, segment) { await call(groupsUrl, post({ action: "segment", id, participantId, segment })); },
    async closeGroup(id) {
      const r = await call<{ transcript: { title: string; segments: StoredSegment[]; speakers: Record<string, { role: "moderator" | "participant"; group?: string }>; participants: { id: string; label: string; segment?: string }[]; meta: Record<string, unknown> } }>(groupsUrl, post({ action: "close", id }));
      const tr = r.transcript;
      const sid = h.addSession({ title: tr.title.replace(/ \(group session\)$/, ""), kind: "focus_group", participants: tr.participants, consent: { captured: true, recording: false, method: "accepted on the join page (text session)" }, status: "completed", notes: "Text group session run in Rescript (sandbox)." });
      h.addTranscript({ ok: true, value: { title: tr.title, source: "import", format: "speaker", segments: tr.segments, speakers: tr.speakers, char_count: tr.segments.reduce((n, s) => n + s.text.length, 0), meta: { warnings: [], ...tr.meta }, session_id: sid } });
      const w = h.view(); onWorkspace(w);
      return { ws: w };
    },
  };
  return api2;
}

/** the excerpts a picker offers: live evidence with where it is */
export function pickable(ws: WorkspaceView): { id: string; quote: string; where: string; codeId: string }[] {
  const segs = allSegments(ws);
  const title = new Map(ws.transcripts.map((t) => [t.id, t.title]));
  const code = new Map(ws.state.codebook.codes.map((c) => [c.id, c.name]));
  return liveEvidence(ws.state, segs).map((e) => ({ id: e.id, quote: e.quote, where: `${title.get(e.sourceId) ?? "source"} · ${e.speaker ?? ""} · ${code.get(e.codeId) ?? ""}`, codeId: e.codeId }));
}
export { selectForReel };

/** what the sandbox's qualitative report carries of the AI synthesis (the page's records) */
export function sandboxReportExtras(h: SandboxHandle | null): { syntheses?: ThemeSynthesis[]; insights?: StudyInsights } {
  const r = h ? RECORDS.get(h) : undefined;
  if (!r) return {};
  return { syntheses: [...r.themes.values()].map((x) => x.rec), ...(r.insights ? { insights: r.insights.rec } : {}) };
}
