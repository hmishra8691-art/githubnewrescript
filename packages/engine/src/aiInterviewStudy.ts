import type { AiModeration, AiScreenerQuestion, AiStimulus, QualStudy } from "@rescript/schema";
import { buildModeratorPlan, moderationOf, type DecisionRecord, type ModeratorFlag, type ModeratorPlan } from "./aiModerator.js";

/**
 * AI-MODERATED INTERVIEWS — THE STUDY AROUND THE INTERVIEW (2026-10-22). Pure helpers
 * shared by the Studio (launch, live view, sandbox simulator) and the runtime (the
 * public link):
 *
 *   launchProblems     what stops a launch (no consent statement, not an interview guide,
 *                      no questions, unsafe URLs) and what only warns
 *   publicStudyView    what the participant's page may see BEFORE the interview: consent,
 *                      screener questions (never which answers qualify), modes, languages
 *   screenParticipant  the screener's verdict and the quota segment, on the server
 *   quotaVerdict       is the segment's quota (and the study's target) still open
 *   transcriptForQual  the finished interview as a qualitative source (migration 0065
 *                      `qual_transcripts` shape): one segment per turn, speakers with
 *                      roles and the participant's segment, timestamps from the start
 *   safeHttpsUrl / redirectFor   the external-URL rules (https only, no credentials, no
 *                      script schemes; only the {{pid}} placeholder is filled, encoded)
 */

export interface LaunchCheck { blocking: string[]; warnings: string[] }

/** https only, no user:password@, no script; null when unsafe */
export function safeHttpsUrl(url: string | undefined | null): string | null {
  const s = String(url ?? "").trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s.replace(/\{\{\s*pid\s*\}\}/gi, "PIDPLACEHOLDER")); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/i.test(u.hostname)) return null;
  return s;
}

/** the redirect after the thank-you: {{pid}} (the panel's participant id, from the link) is the only placeholder, URL-encoded */
export function redirectFor(url: string | undefined | null, vars: { pid?: string | null }): string | null {
  const safe = safeHttpsUrl(url);
  if (!safe) return null;
  return safe.replace(/\{\{\s*pid\s*\}\}/gi, encodeURIComponent(String(vars.pid ?? "").slice(0, 120)));
}

export function launchProblems(study: QualStudy | undefined | null, opts: { guideLanguage?: string } = {}): LaunchCheck {
  const blocking: string[] = [], warnings: string[] = [];
  if (!study) return { blocking: ["There is no interview guide — create one first."], warnings };
  if (study.kind !== "interview") blocking.push("AI-moderated interviews run one participant at a time: the guide must be an interview guide, not a focus-group discussion guide.");
  const cfg = moderationOf(study);
  if (!study.aiModeration) blocking.push("The guide is not configured for AI-moderated interviews yet.");
  else if (!cfg.enabled) blocking.push("AI-moderated interviews are switched off for this guide.");
  if (!study.consent.statement?.trim()) blocking.push("A consent statement is required before launch (the guide's consent: what taking part means, that it is voluntary, that they can stop at any time).");
  const usesRecording = cfg.modes.some((m) => m === "voice" || m === "video");
  if (usesRecording && !study.consent.recordingDisclosure?.trim()) blocking.push("Voice and video interviews need a recording disclosure (what is recorded, who sees it, how long it is kept).");
  const plan = buildModeratorPlan(study);
  if (!plan.steps.length) blocking.push("The guide has no questions for the moderator to ask.");
  if (cfg.redirectUrl && !safeHttpsUrl(cfg.redirectUrl)) blocking.push(`The redirect URL must be an https address (got “${cfg.redirectUrl.slice(0, 80)}”).`);
  for (const s of cfg.stimuli) if (s.url && !safeHttpsUrl(s.url)) blocking.push(`Stimulus “${s.name}”: its URL must be https.`);
  for (const sec of study.sections) for (const n of sec.stimuli) if (!cfg.stimuli.some((s) => s.name.trim().toLowerCase() === n.trim().toLowerCase())) warnings.push(`Stimulus “${n}” (section “${sec.title}”) has no image, video or text attached — the participant will only see its name.`);
  if (!plan.objectives.length) warnings.push("No objectives: the moderator cannot track coverage.");
  const segments = new Set(cfg.screener.flatMap((q) => q.options.map((o) => o.segment).filter(Boolean)));
  for (const q of cfg.quotas) if (!segments.has(q.segment) && !study.segments.some((s) => s.name === q.segment)) warnings.push(`Quota “${q.segment}”: no screener answer puts a participant in that segment.`);
  if (cfg.targetCompletes && cfg.quotas.length && cfg.quotas.reduce((n, q) => n + q.target, 0) < cfg.targetCompletes) warnings.push(`The quotas add up to ${cfg.quotas.reduce((n, q) => n + q.target, 0)}, fewer than the ${cfg.targetCompletes} completes wanted.`);
  /* G1: the scripted fallback speaks each study language from its language pack (made at launch) */
  const packless = cfg.languages.map((l) => l.toLowerCase().split(/[-_]/)[0]).filter((l, i, a) => l && a.indexOf(l) === i && !cfg.translations?.[l] && l !== String(opts.guideLanguage ?? "en").toLowerCase().split(/[-_]/)[0]);
  if (packless.length) warnings.push(`At launch the guide is translated into ${packless.join(", ")} for the scripted fallback (used when the AI is unavailable) — review the wording under Languages.`);
  const est = estimateInterviewCostUsd(plan);
  if (est > cfg.costCapUsd) warnings.push(`An interview is estimated at about $${est.toFixed(2)} of AI, above the $${cfg.costCapUsd} cap per interview: long interviews will finish on scripted questions.`);
  return { blocking, warnings };
}

/** a rough AI cost per interview (USD): one call per answer, the guide prefix cached after the first */
export function estimateInterviewCostUsd(plan: ModeratorPlan, rates = { inputPerM: 3, cachedPerM: 0.3, outputPerM: 15 }): number {
  const turns = Math.min(plan.maxTurns, plan.steps.reduce((n, s) => n + 1 + s.maxFollowUps * 0.6, 0) + 2);
  const prefix = 1100 + plan.steps.length * 60;
  const perTurn = 450;
  const out = 120;
  return (prefix * rates.inputPerM + (turns - 1) * prefix * rates.cachedPerM + turns * perTurn * rates.inputPerM + turns * out * rates.outputPerM) / 1_000_000;
}

export interface PublicScreenerQuestion { id: string; text: string; kind: AiScreenerQuestion["kind"]; options: string[] }
export interface PublicStudyView {
  title: string;
  persona: string;
  modes: AiModeration["modes"];
  languages: string[];
  targetMinutes: number;
  consent: { statement: string; recordingDisclosure?: string; dataUse?: string };
  recordingConsent: "optional" | "required";
  screener: PublicScreenerQuestion[];
  incentive?: string;
  silenceSeconds: number;
  /** G1: the voice styles the participant may choose (realtime only when the runtime has a provider) */
  voiceStyles?: ("turn_based" | "conversation" | "realtime")[];
}

/** what the participant's page is told before the interview — no qualifying rules, no moderator notes, no objectives */
export function publicStudyView(study: QualStudy, opts: { title?: string } = {}): PublicStudyView {
  const cfg = moderationOf(study);
  const plan = buildModeratorPlan(study, { title: opts.title });
  return {
    title: plan.title,
    persona: plan.persona.name,
    modes: cfg.modes,
    languages: plan.languages,
    targetMinutes: plan.targetMinutes,
    consent: { statement: study.consent.statement ?? "", ...(study.consent.recordingDisclosure ? { recordingDisclosure: study.consent.recordingDisclosure } : {}), ...(study.consent.dataUse ? { dataUse: study.consent.dataUse } : {}) },
    recordingConsent: cfg.recordingConsent,
    screener: cfg.screener.map((q) => ({ id: q.id, text: q.text, kind: q.kind, options: q.options.map((o) => o.label) })),
    ...(cfg.incentive ? { incentive: cfg.incentive } : {}),
    silenceSeconds: cfg.silenceSeconds,
    voiceStyles: voiceStylesOf(cfg),
  };
}

/** G1: the voice styles a study offers (absent = turn_based and conversation) */
export function voiceStylesOf(cfg: AiModeration): ("turn_based" | "conversation" | "realtime")[] {
  return cfg.voiceStyles?.length ? [...cfg.voiceStyles] : ["turn_based", "conversation"];
}

/** G1: what the live view shows about a voice interview — its style, interruptions, latency (median, worst) */
export interface VoiceSummary { style: string; interruptions: number; medianLatencyMs: number | null; maxLatencyMs: number | null; turnsMeasured: number; fallback?: string }
export function voiceSummaryOf(state: unknown): VoiceSummary | null {
  const v = (state && typeof state === "object" ? (state as { voice?: { style?: string; interruptions?: number; latenciesMs?: number[]; fallback?: string } }).voice : null) ?? null;
  if (!v) return null;
  const l = (Array.isArray(v.latenciesMs) ? v.latenciesMs : []).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  return { style: v.style ?? "turn_based", interruptions: Number(v.interruptions ?? 0), medianLatencyMs: l.length ? l[Math.floor((l.length - 1) / 2)] : null, maxLatencyMs: l.length ? l[l.length - 1] : null, turnsMeasured: l.length, ...(v.fallback ? { fallback: v.fallback } : {}) };
}

export interface ScreenVerdict { qualified: boolean; segment: string | null; reason?: string; answers: Record<string, string | string[] | number> }

/** the screener's verdict: every question answered, no disqualifying answer; the segment is the last answer that names one */
export function screenParticipant(cfg: AiModeration, raw: Record<string, unknown>): ScreenVerdict {
  const answers: ScreenVerdict["answers"] = {};
  let segment: string | null = null;
  for (const q of cfg.screener) {
    const v = raw?.[q.id];
    if (q.kind === "number") {
      const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
      if (v === undefined || v === null || String(v).trim() === "" || !Number.isFinite(n)) return { qualified: false, segment: null, reason: `unanswered: ${q.id}`, answers };
      answers[q.id] = n;
      if ((q.min !== undefined && n < q.min) || (q.max !== undefined && n > q.max)) return { qualified: false, segment: null, reason: `${q.id} out of range`, answers };
      continue;
    }
    const picked = (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map(String);
    const opts = picked.map((p) => q.options.find((o) => o.label === p)).filter((o): o is NonNullable<typeof o> => !!o);
    if (!opts.length || opts.length !== picked.length) return { qualified: false, segment: null, reason: `unanswered or unknown answer: ${q.id}`, answers };
    if (q.kind === "single" && opts.length > 1) return { qualified: false, segment: null, reason: `${q.id} takes one answer`, answers };
    answers[q.id] = q.kind === "multi" ? opts.map((o) => o.label) : opts[0].label;
    if (opts.some((o) => !o.qualifies)) return { qualified: false, segment: null, reason: `${q.id}: a disqualifying answer`, answers };
    for (const o of opts) if (o.segment) segment = o.segment;
  }
  return { qualified: true, segment, answers };
}

export interface AiQuotaCounts { completed: Record<string, number>; open: Record<string, number>; totalCompleted: number; totalOpen: number }

/**
 * May one more participant in `segment` start? Completed + in-progress interviews count against the
 * target (so a burst of starts cannot overfill a cell); an in-progress interview stops counting when it is
 * abandoned. No quota on the segment = open.
 */
export function quotaVerdict(cfg: AiModeration, counts: AiQuotaCounts, segment: string | null): { open: boolean; reason?: string } {
  if (cfg.targetCompletes && counts.totalCompleted >= cfg.targetCompletes) return { open: false, reason: "the study has all the interviews it needs" };
  if (cfg.targetCompletes && counts.totalCompleted + counts.totalOpen >= Math.ceil(cfg.targetCompletes * 1.2)) return { open: false, reason: "the study is full for now" };
  if (!segment) return cfg.quotas.length && cfg.screener.some((q) => q.options.some((o) => o.segment)) ? { open: false, reason: "no quota group" } : { open: true };
  const q = cfg.quotas.find((x) => x.segment === segment);
  if (!q) return { open: true };
  const used = (counts.completed[segment] ?? 0) + (counts.open[segment] ?? 0);
  return used < q.target ? { open: true } : { open: false, reason: `the “${segment}” group is full` };
}

/* ------------------------------------------------------------ the transcript as a qualitative source */

/** one stored turn of an AI interview (migration 0069 `ai_interview_turns`) */
export interface InterviewTurnRecord {
  seq: number;
  speaker: "moderator" | "participant";
  /** what was said (the participant's words as they gave them — after their own correction of a transcript) */
  text: string;
  /** the speech-to-text output before the participant corrected it, when they did */
  originalText?: string | null;
  language?: string | null;
  /** the participant's words translated into the guide's language, when they answered in another */
  translation?: string | null;
  audioMediaId?: string | null;
  videoMediaId?: string | null;
  decision?: DecisionRecord | null;
  /** ms from the interview's start */
  offsetMs: number;
  durationMs?: number | null;
}

export interface QualTranscriptShape {
  title: string;
  source: "ai_interview";
  format: "ai_interview";
  language: string | null;
  segments: { id: string; index: number; speaker: string; start: number; end?: number; text: string }[];
  speakers: Record<string, { role: "moderator" | "participant"; group?: string }>;
  char_count: number;
  meta: { warnings: string[]; origin: "ai_interview"; studyId: string; interviewId: string; mode: string; participant: string; segment: string | null; translations: Record<string, string>; media: Record<string, { audio?: string; video?: string }>; flags: ModeratorFlag[]; turns: number; durationSeconds: number; moderator: string; covered: string[] };
}

/**
 * The finished interview as a `qual_transcripts` row (0065): the existing coding, quotes, kappa and
 * report read it unchanged — moderator turns carry role "moderator" (evidence of what was asked,
 * never coded as a participant's view), the participant's carry their segment as the group.
 */
export function transcriptForQual(turns: readonly InterviewTurnRecord[], o: { studyId: string; interviewId: string; title: string; participantLabel: string; segment: string | null; mode: string; language: string | null; moderatorName: string; flags: ModeratorFlag[]; covered: string[] }): QualTranscriptShape {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq).filter((t) => t.text.trim());
  const MOD = "Moderator";
  const translations: Record<string, string> = {};
  const media: Record<string, { audio?: string; video?: string }> = {};
  const segments = ordered.map((t, i) => {
    const id = `t${i + 1}`;
    if (t.translation) translations[id] = t.translation;
    if (t.audioMediaId || t.videoMediaId) media[id] = { ...(t.audioMediaId ? { audio: t.audioMediaId } : {}), ...(t.videoMediaId ? { video: t.videoMediaId } : {}) };
    const start = Math.round(t.offsetMs / 100) / 10;
    return { id, index: i, speaker: t.speaker === "moderator" ? MOD : o.participantLabel, start, ...(t.durationMs ? { end: Math.round((t.offsetMs + t.durationMs) / 100) / 10 } : {}), text: t.text.trim() };
  });
  const last = ordered[ordered.length - 1];
  const warnings = [
    "AI-moderated interview: the moderator's turns were written by an AI following the guide.",
    ...(Object.keys(translations).length ? ["The participant answered in another language: their own words are the segments; translations are kept beside them."] : []),
    ...(o.flags.filter((f) => f.severity !== "info").map((f) => `Flag — ${f.kind.replace("_", " ")}: ${f.note}`)),
  ];
  return {
    title: o.title.slice(0, 200),
    source: "ai_interview",
    format: "ai_interview",
    language: o.language,
    segments,
    speakers: { [MOD]: { role: "moderator" }, [o.participantLabel]: { role: "participant", ...(o.segment ? { group: o.segment } : {}) } },
    char_count: segments.reduce((n, s) => n + s.text.length, 0),
    meta: { warnings, origin: "ai_interview", studyId: o.studyId, interviewId: o.interviewId, mode: o.mode, participant: o.participantLabel, segment: o.segment, translations, media, flags: o.flags, turns: ordered.length, durationSeconds: last ? Math.round((last.offsetMs + (last.durationMs ?? 0)) / 1000) : 0, moderator: o.moderatorName, covered: o.covered },
  };
}

/** a stimulus the participant's page may show: https media or text only */
export function displayableStimulus(s: AiStimulus): AiStimulus | null {
  if (s.kind === "text") return { name: s.name, kind: "text", text: (s.text ?? s.name).slice(0, 2000) };
  const url = safeHttpsUrl(s.url);
  return url ? { name: s.name, kind: s.kind, url, ...(s.alt ? { alt: s.alt.slice(0, 300) } : {}) } : { name: s.name, kind: "text", text: s.name };
}

/* ------------------------------------------------------------ the researcher's live view */

export interface InterviewSummary {
  id: string;
  participant: string;
  segment: string | null;
  mode: string;
  language: string;
  status: "in_progress" | "completed" | "screened_out" | "abandoned" | "flagged" | "ended";
  excluded: boolean;
  isTest: boolean;
  flags: ModeratorFlag[];
  turns: number;
  costUsd: number;
  startedAt: string;
  lastActivityAt: string;
  minutes: number;
  covered: string[];
  qualTranscriptId: string | null;
  /** G1: voice style, interruptions and latency (voice interviews) */
  voice?: VoiceSummary | null;
}
export interface InterviewCounts { started: number; inProgress: number; completed: number; screenedOut: number; abandoned: number; flagged: number; ended: number; excluded: number; tests: number; alerts: number }
export interface QuotaProgress { segment: string; target: number; completed: number; inProgress: number }

/** the counts the live view shows: real interviews only (tests counted apart), excluded ones never as completes */
export function interviewCounts(rows: readonly InterviewSummary[], cfg: AiModeration): { counts: InterviewCounts; quotas: QuotaProgress[]; target: number | null } {
  const real = rows.filter((r) => !r.isTest);
  const c: InterviewCounts = { started: 0, inProgress: 0, completed: 0, screenedOut: 0, abandoned: 0, flagged: 0, ended: 0, excluded: 0, tests: rows.length - real.length, alerts: 0 };
  for (const r of real) {
    if (r.status !== "screened_out") c.started++;
    if (r.excluded) c.excluded++;
    if (r.flags.some((f) => f.severity === "alert")) c.alerts++;
    if (r.status === "in_progress") c.inProgress++;
    else if (r.status === "completed" && !r.excluded) c.completed++;
    else if (r.status === "screened_out") c.screenedOut++;
    else if (r.status === "abandoned") c.abandoned++;
    else if (r.status === "flagged") c.flagged++;
    else if (r.status === "ended") c.ended++;
  }
  const quotas = cfg.quotas.map((q) => ({ segment: q.segment, target: q.target, completed: real.filter((r) => r.segment === q.segment && r.status === "completed" && !r.excluded).length, inProgress: real.filter((r) => r.segment === q.segment && r.status === "in_progress").length }));
  return { counts: c, quotas, target: cfg.targetCompletes ?? null };
}

/**
 * The rows a finished (or researcher-ended) interview becomes in the qualitative tables (0065) — built
 * once here so the runtime (on completion) and the Studio (when the researcher ends an interview) write
 * the same thing. `transcript.session_id` is filled by the writer with the new session's id.
 */
export function qualRowsForInterview(t: QualTranscriptShape, o: { surveyId: string; participantNumber: number; segment: string | null; startedAt: string; recording: boolean; consentAt?: string; mode: string; language: string; flags: readonly ModeratorFlag[]; endedBy?: "participant" | "researcher" }) {
  const flags = o.flags.filter((f) => f.severity !== "info").map((f) => f.kind);
  return {
    session: {
      survey_id: o.surveyId, kind: "interview", title: t.title, scheduled_at: o.startedAt, moderator: `AI moderator (${t.meta.moderator})`,
      participants: [{ id: `p${o.participantNumber}`, label: t.meta.participant, ...(o.segment ? { segment: o.segment } : {}) }],
      consent: { captured: true, recording: o.recording, method: "AI interview consent screen", ...(o.consentAt ? { at: o.consentAt } : {}) },
      notes: `AI-moderated ${o.mode} interview (${o.language}).${o.endedBy === "researcher" ? " Ended by the research team." : ""}${flags.length ? ` Flags: ${[...new Set(flags)].join(", ")}.` : ""}`,
      status: "completed",
    },
    transcript: { survey_id: o.surveyId, title: t.title, language: t.language, segments: t.segments, speakers: t.speakers, status: "ready", char_count: t.char_count, meta: t.meta, source: t.source, format: t.format },
    event: { action: "ai_interview.completed", detail: `AI interview ${t.meta.participant}${o.segment ? ` (${o.segment})` : ""} ${o.endedBy === "researcher" ? "ended by the research team" : "completed"}: transcript added (${t.segments.length} turns)` },
  };
}
