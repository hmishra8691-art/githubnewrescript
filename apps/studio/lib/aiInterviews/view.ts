import { AiLanguagePack, type SurveyDefinition } from "@rescript/schema";
import { estimateInterviewCostUsd, buildModeratorPlan, launchProblems, moderationOf, interviewCounts, voiceSummaryOf, SERVICES, type InterviewSummary, type ModeratorFlag } from "@rescript/engine";
import { redactText } from "@rescript/analytics";

/**
 * AI-MODERATED INTERVIEWS IN THE STUDIO — the pure half of `/api/surveys/[id]/ai-interviews/**`
 * (rows in, what a member may see out; a launch row from the definition). No database, no Next, so
 * every rule is unit-tested (`view.test.ts`).
 *
 * Access is the qualitative workspace's (`qualAccess.ts`, the Data module): reading interviews and
 * live transcripts = Data view (redacted without contact details); launching, pausing, ending and
 * excluding = Data edit. A member without Data access gets 403.
 */

export interface StudyRow { id: string; survey_id: string; title: string; status: "live" | "paused" | "closed"; link_token: string; test_token: string; guide: unknown; guide_language: string; spent_usd: number | string; launched_at: string; closed_at: string | null }
export interface SessionRow {
  id: string; status: InterviewSummary["status"]; mode: string; language: string | null; excluded: boolean; exclusion_reason?: string | null; is_test: boolean; flags: unknown; state: unknown;
  turns_count: number; cost_usd: number | string; started_at: string; last_activity_at: string; completed_at: string | null; qual_transcript_id: string | null;
  ai_interview_participants?: { number: number; segment: string | null } | { number: number; segment: string | null }[] | null;
}
export interface TurnRow { seq: number; speaker: "moderator" | "participant"; text: string; original_text: string | null; translation: string | null; language: string | null; offset_ms: number; duration_ms: number | null; decision: unknown; audio_media_id: string | null; video_media_id: string | null }

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function summaryOf(r: SessionRow): InterviewSummary {
  const p = one(r.ai_interview_participants);
  const end = Date.parse(r.completed_at ?? r.last_activity_at);
  const st = (r.state && typeof r.state === "object" ? r.state : {}) as { covered?: unknown };
  return {
    id: r.id, participant: `P${p?.number ?? "?"}`, segment: p?.segment ?? null, mode: r.mode, language: r.language ?? "", status: r.status, excluded: !!r.excluded, isTest: !!r.is_test,
    flags: arr<ModeratorFlag>(r.flags), turns: r.turns_count ?? 0, costUsd: Number(r.cost_usd ?? 0), startedAt: r.started_at, lastActivityAt: r.last_activity_at,
    minutes: Math.max(0, Math.round((end - Date.parse(r.started_at)) / 6000) / 10), covered: arr<string>(st.covered).filter((x) => typeof x === "string"), qualTranscriptId: r.qual_transcript_id ?? null,
    /* G1: the voice style, interruptions and latency of a voice interview */
    ...(r.mode !== "text" ? { voice: voiceSummaryOf(r.state) } : {}),
  };
}

export interface LiveView {
  study: { id: string; title: string; status: StudyRow["status"]; link: string; testLink: string; spentUsd: number; launchedAt: string; objectives: { id: string; text: string }[]; modes: string[]; languages: string[]; budgetUsd: number | null } | null;
  counts: ReturnType<typeof interviewCounts>["counts"] | null;
  quotas: ReturnType<typeof interviewCounts>["quotas"];
  target: number | null;
  interviews: InterviewSummary[];
  available: boolean;
  note?: string;
  /** G1: can this installation offer realtime voice interviews (AI_REALTIME_*), and if not why */
  realtime?: { available: boolean; reason?: string };
}

/** G1: the realtime voice provider's readiness from this environment (the runtime reads the same variables) */
export function realtimeReadiness(env: Record<string, string | undefined> = process.env): { available: boolean; reason?: string } {
  const r = SERVICES.realtime_voice?.readiness(env);
  if (!r) return { available: false, reason: "no realtime voice provider in this build" };
  return r.ready ? { available: true } : { available: false, reason: r.reason ?? `not configured: ${r.missing.join(", ")}` };
}

export function liveView(study: StudyRow | null, sessions: SessionRow[], runtimeBase: string): LiveView {
  if (!study) return { study: null, counts: null, quotas: [], target: null, interviews: [], available: true, realtime: realtimeReadiness() };
  const guide = study.guide as SurveyDefinition["qualStudy"];
  const cfg = moderationOf(guide!);
  const plan = buildModeratorPlan(guide!, { guideLanguage: study.guide_language, title: study.title });
  const interviews = sessions.map(summaryOf);
  const base = runtimeBase.replace(/\/+$/, "");
  return {
    study: { id: study.id, title: study.title, status: study.status, link: `${base}/i/${study.link_token}`, testLink: `${base}/i/${study.link_token}?test=${study.test_token}`, spentUsd: Number(study.spent_usd ?? 0), launchedAt: study.launched_at, objectives: plan.objectives, modes: cfg.modes, languages: plan.languages, budgetUsd: cfg.studyBudgetUsd ?? null },
    ...interviewCounts(interviews, cfg),
    interviews,
    available: true,
    realtime: realtimeReadiness(),
  };
}

export interface TurnView { seq: number; speaker: "moderator" | "participant"; text: string; originalText: string | null; translation: string | null; at: number; decision: Record<string, unknown> | null; hasAudio: boolean; hasVideo: boolean }

/** the live transcript a member may read: e-mails, phones and the names list replaced unless they hold contact details */
export function turnsView(rows: TurnRow[], opts: { pii: boolean; names?: string[] }): TurnView[] {
  const red = (t: string | null) => (t == null ? null : opts.pii ? t : redactText(t, { names: opts.names ?? [] }).text);
  return [...rows].sort((a, b) => a.seq - b.seq).map((r) => ({
    seq: r.seq, speaker: r.speaker, text: red(r.text) ?? "", originalText: red(r.original_text), translation: red(r.translation), at: r.offset_ms,
    decision: r.decision && typeof r.decision === "object" ? (r.decision as Record<string, unknown>) : null, hasAudio: !!r.audio_media_id, hasVideo: !!r.video_media_id,
  }));
}

/** the study row a launch inserts — a SNAPSHOT of the guide and its AI configuration — or why it cannot launch */
export function launchRow(def: SurveyDefinition, userId: string, title?: string): { ok: true; row: Record<string, unknown>; quotas: { segment: string; target: number }[]; warnings: string[]; estimateUsd: number } | { ok: false; blocking: string[]; warnings: string[] } {
  const check = launchProblems(def.qualStudy, { guideLanguage: def.localization?.sourceLanguage });
  if (check.blocking.length) return { ok: false, blocking: check.blocking, warnings: check.warnings };
  const guide = def.qualStudy!;
  const cfg = moderationOf(guide);
  const plan = buildModeratorPlan(guide, { guideLanguage: def.localization?.sourceLanguage });
  return {
    ok: true,
    row: { survey_id: undefined, title: (title ?? guide.title ?? def.meta.title ?? "AI interviews").slice(0, 200), status: "live", guide, guide_language: def.localization?.sourceLanguage ?? "en", launched_by: userId },
    quotas: cfg.quotas.map((q) => ({ segment: q.segment.slice(0, 120), target: q.target })),
    warnings: check.warnings,
    estimateUsd: Math.round(estimateInterviewCostUsd(plan) * 1000) / 1000,
  };
}

export type InterviewAction = { action: "end" } | { action: "exclude"; reason?: string } | { action: "include" };
export function parseInterviewAction(body: unknown): InterviewAction | { error: string } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (o.action === "end") return { action: "end" };
  if (o.action === "include") return { action: "include" };
  if (o.action === "exclude") return { action: "exclude", ...(typeof o.reason === "string" && o.reason.trim() ? { reason: o.reason.trim().slice(0, 300) } : {}) };
  return { error: "action is end, exclude or include" };
}

/** a qual transcript may be removed on exclusion only if no excerpt cites it (coding would lose its evidence) */
export function excerptsCiting(excerpts: unknown, transcriptId: string): number {
  return arr<{ sourceId?: string }>(excerpts).filter((e) => e?.sourceId === transcriptId).length;
}

/** the sandbox: a finished interview's transcript as "[hh:mm:ss] Speaker: text" lines, for the in-page workspace's importer */
export function transcriptText(segments: { speaker: string; start: number; text: string }[]): string {
  const ts = (s: number) => { const t = Math.max(0, Math.round(s)); return `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
  return segments.map((g) => `[${ts(g.start)}] ${g.speaker}: ${g.text.replace(/\s*\n+\s*/g, " ")}`).join("\n");
}

/* ------------------------------------------------------------ G1: the study languages' wording (language packs) */

/** a body's `translations` → valid packs by language code (anything else dropped) */
export function parsePacks(raw: unknown): Record<string, AiLanguagePack> {
  const out: Record<string, AiLanguagePack> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 60)) {
    const lang = k.toLowerCase().split(/[-_]/)[0].replace(/[^a-z]/g, "").slice(0, 8);
    const p = AiLanguagePack.safeParse(v);
    if (!lang || !p.success) continue;
    /* bounded: a pack is short texts, never a document */
    const clip = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).slice(0, 600).map(([a, b]) => [a.slice(0, 120), String(b).slice(0, 2000)]));
    out[lang] = { ...p.data, language: lang, texts: clip(p.data.texts), words: clip(p.data.words), ui: clip(p.data.ui) };
  }
  return out;
}

/** a guide snapshot with these packs merged in (a launch, or "apply to the running study") */
export function withPacks<T extends { aiModeration?: unknown }>(guide: T, packs: Record<string, AiLanguagePack>): T {
  if (!Object.keys(packs).length) return guide;
  const cfg = (guide.aiModeration ?? {}) as { translations?: Record<string, AiLanguagePack> };
  return { ...guide, aiModeration: { ...cfg, translations: { ...(cfg.translations ?? {}), ...packs } } };
}
