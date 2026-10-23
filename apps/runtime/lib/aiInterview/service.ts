import {
  buildModeratorPlan, displayableStimulus, fakeModeratorReply, finishTurn, interviewStatus, moderationOf, prepareTurn, publicStudyView, redirectFor, screenParticipant, startInterview, transcriptForQual,
  type InterviewTurnRecord, type ModelRequest, type ModeratorPlan, type ModeratorReply, type ModeratorState, type ParticipantInput, type PreparedTurn, type PublicStudyView,
} from "@rescript/engine";
import type { AiStimulus, PanelOutcome } from "@rescript/schema";
import { outcomeForInterview, type FlagKind, type NotifyEmitInput } from "@rescript/engine";
import type { AiInterviewStore, SessionRec, StudyRec } from "./types.ts";
import { realtimeReplyFrom, realtimeTurnInstructions, realtimeVerbatimInstructions, spokeVerbatim } from "@rescript/engine";
import { lastModeratorTurn, localizedPlan, modeAndStyle, offeredStyles, replySpeaker, setVoice, studyI18n, type SpeakSink, type StudyI18n, type VoiceStyle } from "./voice.ts";

/**
 * AI-MODERATED INTERVIEWS — THE RESPONDENT LINK'S LOGIC (2026-10-22), framework-free so it is tested
 * without Next or a database (`service.test.ts`). The routes under `app/api/ai-interview/*` parse the
 * request, build the dependencies (`runtimeDeps.ts`: the store, the metered model call, the clock) and
 * call these:
 *
 *   studyInfo   the public view of a study by its link token (+ the test token for "test as respondent")
 *   begin       consent (refused without it) → screener (screened-out participants are recorded) → mode,
 *               language → admission (quotas, target, budget — atomic in the database) → the opening turn
 *   resume      the transcript so far, by the resume token the browser keeps (a reloaded tab carries on)
 *   turn        one participant input (an answer, silence, stop) → the moderator's next turn: the engine
 *               decides; the model is called (metered, streamed) only when the engine asks; the exchange is
 *               written atomically with a version check (a double submit replays the stored answer); a
 *               finished interview is written to the qualitative tables for coding
 *
 * The resume token is 32 random bytes; only its SHA-256 is stored.
 */

export type ModelResult = { value: unknown; costUsd: number } | { failed: string };
/** `onSay` receives the reply's "say" as the model writes it (the caller extracts it from the streamed JSON) */
export type ModelCaller = (req: ModelRequest, o: { session: SessionRec | null; study: StudyRec; onSay?: (delta: string) => void; /** G1: the reply's intent as it streams (written before the words) */ onIntent?: (delta: string) => void; fake: () => Record<string, unknown>; script?: unknown }) => Promise<ModelResult>;
/** what the page is told while a turn is written: pieces of the moderator's words, or (replace) the whole text when the rules' text replaced the model's */
export type SayStream = (text: string, replace?: boolean) => void;

export interface Deps {
  store: AiInterviewStore;
  model: ModelCaller | null;
  now: () => number;
  newToken: () => string;
  hash: (token: string) => Promise<string>;
  /** G3 2026-10-22: panel recruitment (entry, dedupe, signed end links) — absent: only the legacy `pid` in and the guide's redirect out */
  panels?: PanelHooks | null;
  /** G3 2026-10-22: alert events (distress, abuse, injection, completion, quota / target / budget) — absent: none */
  notify?: ((e: NotifyEmitInput) => Promise<void>) | null;
  /** G1 2026-10-22: a realtime voice provider is configured and can be gated (lib/aiInterview/realtime.ts) */
  realtimeAvailable?: boolean;
}

/** the panel half of the link (apps/runtime/lib/panels.ts), kept abstract so the service stays framework-free */
export interface PanelExitView { url: string | null; code: string | null; showCode: boolean; signed: boolean; problems: string[]; pid?: string; panel?: string }
export type PanelEnterView =
  | { kind: "none"; pid: string | null }
  | { kind: "admitted"; entryId: string; pid: string }
  | { kind: "refused" | "duplicate"; message: string }
  | { kind: "over_quota"; message: string; redirect: PanelExitView | null };
export interface PanelHooks {
  enter(a: { surveyId: string; target: "ai_interview"; targetRef: string; params: Record<string, string>; isTest: boolean }): Promise<PanelEnterView>;
  attach(entryId: string, sessionRef: string): Promise<void>;
  exit(a: { entryId?: string | null; sessionRef?: string | null; outcome: PanelOutcome; status?: string | null }): Promise<PanelExitView | null>;
}

/* G3: the moderator's flags that are alerts, and the event each raises */
const FLAG_EVENT: Partial<Record<FlagKind, NotifyEmitInput["type"]>> = { distress: "ai_interview.distress", abuse: "ai_interview.abuse", manipulation: "ai_interview.injection", provider_fallback: "ai.provider_fallback" };
const aiLink = (study: StudyRec, sessionId: string) => { const q = `tab=qualitative&qual=ai${sessionId ? `&interview=${encodeURIComponent(sessionId)}` : ""}`; return study.surveyId === "sandbox" ? `/sandbox?mode=studio&${q}` : `/studio/${encodeURIComponent(study.surveyId)}?${q}`; };
async function notifyAll(deps: Deps, events: NotifyEmitInput[]): Promise<void> {
  if (!deps.notify || !events.length) return;
  await Promise.all(events.map((e) => deps.notify!(e).catch(() => {})));
}

export class AiInterviewError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

const planCache = new Map<string, { at: string; plan: ModeratorPlan }>();
export function planFor(study: StudyRec, language?: string | null): ModeratorPlan {
  const key = JSON.stringify(study.guide).length + ":" + study.id + ":" + (study.guide.updatedAt ?? "");
  const hit = planCache.get(study.id);
  if (hit && hit.at === key) return localizedPlan(hit.plan, study, language);
  const plan = buildModeratorPlan(study.guide, { guideLanguage: study.guideLanguage, title: study.title });
  planCache.set(study.id, { at: key, plan });
  /* G1: in a study language with a language pack, the rules speak the pack's wording */
  return localizedPlan(plan, study, language);
}

export interface TurnView { seq: number; speaker: "moderator" | "participant"; text: string; stimuli?: AiStimulus[]; at: number }
export interface InterviewView { participant: string; mode: SessionRec["mode"]; language: string; status: SessionRec["status"]; done: boolean; turns: TurnView[]; redirect: string | null; lastSeq: number; silenceSeconds: number; recording: boolean; note?: string; /** G1: the voice style (turn_based / conversation / realtime) */ voice?: VoiceStyle; /** G3: the panel's completion code to show (MTurk / Prolific / Connect style) */ code?: string | null }
export const ENDED_NOTE = "The research team has ended this interview. Thank you very much for your time.";

const shown = (plan: ModeratorPlan, names: unknown): AiStimulus[] => (Array.isArray(names) ? names : []).map((n) => plan.steps.flatMap((s) => s.stimuli).find((s) => s.name === n)).filter((s): s is AiStimulus => !!s).map(displayableStimulus).filter((s): s is AiStimulus => !!s);
function turnView(plan: ModeratorPlan, t: InterviewTurnRecord): TurnView {
  const stim = t.speaker === "moderator" ? shown(plan, (t.decision as unknown as { stimuli?: unknown } | null)?.stimuli) : [];
  return { seq: t.seq, speaker: t.speaker, text: t.text, ...(stim.length ? { stimuli: stim } : {}), at: t.offsetMs };
}

/* ------------------------------------------------------------ the study's public face */

export async function studyInfo(deps: Deps, linkToken: string, testToken?: string | null): Promise<{ view: PublicStudyView; open: boolean; test: boolean; closedReason?: string; /** G1 */ i18n?: StudyI18n }> {
  const study = await deps.store.studyByLink(String(linkToken ?? "").slice(0, 80));
  if (!study) throw new AiInterviewError("This interview link is not active.", 404, "unknown_link");
  const test = !!testToken && testToken === study.testToken;
  const open = study.status === "live" || (test && study.status === "paused");
  const pv = { ...publicStudyView(study.guide, { title: study.title }), voiceStyles: offeredStyles(study, !!deps.realtimeAvailable) };
  return { view: pv, open, test, i18n: studyI18n(study, pv), ...(open ? {} : { closedReason: study.status === "paused" ? "This study is paused. Please try again later." : "This study is closed. Thank you for your interest." }) };
}

/* ------------------------------------------------------------ beginning */

export interface BeginBody {
  token: string;
  test?: string | null;
  consent?: { agreed?: unknown; recording?: unknown };
  screener?: Record<string, unknown>;
  mode?: string;
  language?: string;
  pid?: string | null;
  /** G3: every URL parameter the link carried (a panel's id and its kept values) */
  params?: Record<string, string> | null;
  script?: unknown;
}

export type BeginOutcome =
  | { kind: "started"; sessionToken: string; interview: InterviewView }
  | { kind: "screened_out"; message: string; panel?: PanelExitView | null }
  | { kind: "full"; message: string; panel?: PanelExitView | null }
  /* G3: a panel refused the entry (no id, a duplicate, the panel's completes target met) */
  | { kind: "refused"; message: string; panel?: PanelExitView | null };

const cleanLang = (l: unknown): string => String(l ?? "").toLowerCase().split(/[-_]/)[0].replace(/[^a-z]/g, "").slice(0, 8);

export async function begin(deps: Deps, body: BeginBody, opts: { onSay?: SayStream; onSpeak?: SpeakSink } = {}): Promise<BeginOutcome> {
  const info = await studyInfo(deps, body.token, body.test);
  if (!info.open) throw new AiInterviewError(info.closedReason ?? "closed", 410, "closed");
  const study = (await deps.store.studyByLink(body.token))!;
  const cfg = moderationOf(study.guide);
  let plan = planFor(study);
  if (body.consent?.agreed !== true) throw new AiInterviewError("Please read the consent statement and agree before starting.", 400, "consent_required");
  /* G1: "conversation" and "realtime" are voice interviews in another style (the session's mode stays voice) */
  const picked = modeAndStyle(body.mode);
  const mode = picked.mode ?? cfg.modes[0];
  if (!cfg.modes.includes(mode)) throw new AiInterviewError(`This study runs in ${cfg.modes.join(" or ")}.`, 400, "mode");
  const style: VoiceStyle | null = mode === "text" ? null : picked.style ?? "turn_based";
  if (mode === "voice" && style && !offeredStyles(study, !!deps.realtimeAvailable).includes(style)) throw new AiInterviewError(style === "realtime" ? "The low-latency voice is not available for this study." : "That way of answering is not available for this study.", 400, "mode");
  const recording = body.consent?.recording === true;
  if ((mode === "voice" || mode === "video") && cfg.recordingConsent === "required" && !recording) throw new AiInterviewError(cfg.modes.includes("text") ? "This study needs your agreement to record voice or video answers — or choose text instead." : "This study needs your agreement to record your answers.", 400, "recording_consent");
  if (mode === "video" && !recording) throw new AiInterviewError("Camera interviews record each answer — agree to recording, or choose voice or text.", 400, "recording_consent");
  const language = cleanLang(body.language) || plan.guideLanguage;
  if (plan.languages.length && !plan.languages.includes(language)) throw new AiInterviewError(`This interview is available in: ${plan.languages.join(", ")}.`, 400, "language");
  plan = planFor(study, language);
  const verdict = screenParticipant(cfg, body.screener ?? {});
  const consent = { statement: true, recording, at: new Date(deps.now()).toISOString() };
  /* G3: a panel's arrival — refused / duplicate / over quota end here; the panel's id is the participant's external ref */
  const entry: PanelEnterView = deps.panels ? await deps.panels.enter({ surveyId: study.surveyId, target: "ai_interview", targetRef: study.id, params: { ...(body.params ?? {}), ...(body.pid && !body.params?.pid ? { pid: String(body.pid) } : {}) }, isTest: info.test }) : { kind: "none", pid: null };
  if (entry.kind === "refused" || entry.kind === "duplicate") return { kind: "refused", message: entry.message, panel: null };
  if (entry.kind === "over_quota") return { kind: "refused", message: entry.message, panel: entry.redirect };
  const panelId = entry.kind === "admitted" ? entry.pid : null;
  const externalRef = panelId ? panelId.slice(0, 120) : body.pid ? String(body.pid).replace(/[^\w.:@-]/g, "").slice(0, 120) || null : null;
  const panelExit = async (outcome: PanelOutcome, status: string) => (entry.kind === "admitted" && deps.panels ? deps.panels.exit({ entryId: entry.entryId, outcome, status }) : null);
  const token = deps.newToken();
  const tokenHash = await deps.hash(token);
  if (!verdict.qualified) {
    await deps.store.begin({ study, segment: verdict.segment, isTest: info.test, screener: { ...verdict.answers, _reason: verdict.reason ?? "" }, consent, language, externalRef, mode, tokenHash, state: {}, flags: [], screenedOut: true }).catch(() => null);
    /* G3: the screened-out row carries its panel entry too, so the live view shows the panel id and the outcome */
    if (entry.kind === "admitted" && deps.panels) { const row = await deps.store.sessionByHash(tokenHash).catch(() => null); if (row) await deps.panels.attach(entry.entryId, row.id).catch(() => undefined); }
    return { kind: "screened_out", message: "Thank you for your interest. Unfortunately you don't match the people we need for this study, so we won't continue — we appreciate your time.", panel: await panelExit("screenout", "screened_out") };
  }
  /* the opening first (in memory), so the session row is created with its state */
  const prepared = startInterview(plan, { now: deps.now(), language, modelAvailable: !!deps.model });
  if (style) { setVoice(prepared.state, { style }); if (prepared.kind === "model") setVoice(prepared.fallbackState, { style }); }
  const admitted = await deps.store.begin({ study, segment: verdict.segment, isTest: info.test, screener: verdict.answers, consent, language, externalRef, mode, tokenHash, state: prepared.state, flags: [] });
  if (!admitted.admitted) {
    if (/quota|target|full/.test(admitted.reason)) await deps.store.begin({ study, segment: verdict.segment, isTest: info.test, screener: { ...verdict.answers, _reason: admitted.reason }, consent, language, externalRef, mode, tokenHash: await deps.hash(deps.newToken()), state: {}, flags: [], screenedOut: true }).catch(() => null);
    /* G3: the study's own limits are alerts (once each: the idempotency key is the study's) */
    const limit = admitted.reason === "budget reached" ? { type: "study.cost_cap" as const, ref: `budget:${study.id}` } : admitted.reason === "target reached" ? { type: "study.target_reached" as const, ref: `target:${study.id}` } : admitted.reason === "quota full" ? { type: "ai_interview.quota_full" as const, ref: `quota:${study.id}:${verdict.segment ?? ""}` } : null;
    if (limit && !info.test) await notifyAll(deps, [{ type: limit.type, surveyId: study.surveyId, customerId: study.customerId, studyTitle: study.title, ref: limit.ref, idempotencyKey: `${limit.type}:${limit.ref}`, link: aiLink(study, ""), detail: { segment: verdict.segment ?? null, spent_usd: Math.round(study.spentUsd * 100) / 100 } }]);
    if (admitted.reason === "closed" || admitted.reason === "budget reached") { await panelExit("quota_full", admitted.reason); throw new AiInterviewError("This study is not taking new participants right now. Thank you for your interest.", 410, "closed"); }
    return { kind: "full", message: "Thank you for your interest — we already have all the people we need for this group, so we won't continue.", panel: await panelExit("quota_full", "quota_full") };
  }
  const session = (await deps.store.sessionByHash(tokenHash))!;
  if (entry.kind === "admitted" && deps.panels) await deps.panels.attach(entry.entryId, session.id);
  const { state, reply } = await resolve(deps, plan, study, session, prepared, opts.onSay, body.script, opts.onSpeak);
  if (style) setVoice(state, { style });
  const turn: InterviewTurnRecord = { seq: state.seq, speaker: "moderator", text: reply.say, language, decision: { ...reply.decision, stimuli: reply.stimuli.map((s) => s.name) } as never, offsetMs: 0 };
  const v = await deps.store.recordTurn({ sessionId: session.id, expected: 0, turns: [turn], state, status: interviewStatus(state), flags: state.flags, turnsCount: 1, costDelta: state.costUsd, completed: state.phase === "done" });
  if (v === null) throw new AiInterviewError("The interview could not be started — please reload the page.", 409, "conflict");
  return { kind: "started", sessionToken: token, interview: await withPanel(deps, { ...session, state, status: interviewStatus(state) }, view(plan, study, { ...session, state, status: interviewStatus(state) }, [turn], cfg.silenceSeconds)) };
}

/* ------------------------------------------------------------ resuming */

export async function resume(deps: Deps, sessionToken: string): Promise<{ interview: InterviewView; info: PublicStudyView; /** G1 */ i18n?: StudyI18n }> {
  const { session, study } = await sessionOf(deps, sessionToken);
  const plan = planFor(study, session.language);
  const turns = await deps.store.turns(session.id);
  return { interview: await withPanel(deps, session, view(plan, study, session, turns, moderationOf(study.guide).silenceSeconds)), info: publicStudyView(study.guide, { title: study.title }), i18n: studyI18n(study, publicStudyView(study.guide, { title: study.title })) };
}

async function sessionOf(deps: Deps, sessionToken: string): Promise<{ session: SessionRec; study: StudyRec }> {
  const t = String(sessionToken ?? "");
  if (!/^[0-9a-f]{64}$/.test(t)) throw new AiInterviewError("invalid session", 400, "invalid_session");
  const session = await deps.store.sessionByHash(await deps.hash(t));
  if (!session) throw new AiInterviewError("This interview could not be found.", 404, "unknown_session");
  const study = await deps.store.studyById(session.studyId);
  if (!study) throw new AiInterviewError("This interview's study is gone.", 410, "unknown_study");
  return { session, study };
}

function view(plan: ModeratorPlan, study: StudyRec, session: SessionRec, turns: InterviewTurnRecord[], silenceSeconds: number): InterviewView {
  const done = session.status !== "in_progress";
  const cfg = moderationOf(study.guide);
  return {
    participant: `P${session.participantNumber}`, mode: session.mode, language: session.language, status: session.status, done,
    turns: [...turns].sort((a, b) => a.seq - b.seq).map((t) => turnView(plan, t)),
    redirect: done && (session.status === "completed") ? redirectFor(cfg.redirectUrl, { pid: session.externalRef }) : null,
    lastSeq: turns.reduce((n, t) => Math.max(n, t.seq), 0), silenceSeconds, recording: !!session.consent.recording,
    ...(session.status === "ended" ? { note: ENDED_NOTE } : {}),
    ...(session.state?.voice?.style ? { voice: session.state.voice.style } : {}),
  };
}

/**
 * G3: a finished interview of a panel participant goes back to the PANEL's end link for its outcome (signed when
 * the panel signs; the first outcome recorded stands), with the panel's code to show; without a panel entry the
 * guide's own redirect (only {{pid}}) stays as it was.
 */
async function withPanel(deps: Deps, session: SessionRec, v: InterviewView): Promise<InterviewView> {
  if (!deps.panels || !v.done || !session.externalRef) return v;
  const outcome = outcomeForInterview(session.status);
  if (!outcome) return v;
  const r = await deps.panels.exit({ sessionRef: session.id, outcome, status: session.status }).catch(() => null);
  if (!r) return v;
  return { ...v, redirect: r.url ?? (outcome === "complete" ? v.redirect : null), code: r.showCode ? r.code : null };
}

/* ------------------------------------------------------------ one turn */

export interface TurnBody {
  sessionToken: string;
  /** the last seq the browser has — a resend after a dropped answer replays instead of answering twice */
  afterSeq: number;
  input: { kind: "answer" | "silence" | "stop"; text?: string; meta?: { typingMs?: number; pasted?: boolean; spoken?: boolean } };
  /** voice: the speech-to-text output before the participant corrected it */
  original?: string | null;
  audioMediaId?: string | null;
  videoMediaId?: string | null;
  durationMs?: number | null;
  /** TEST SEAM (fake provider only): the stand-in model's reply for this turn, or "fail" */
  script?: unknown;
  /**
   * G1 — the hands-free conversation: `interrupted` = this answer cut the moderator's last turn short after
   * `heardChars` characters were played; `latencyMs` = end of speech → first audio of the PREVIOUS reply;
   * `style` / `fallback` = the page fell back to turn-based voice (and why)
   */
  voice?: { interrupted?: { heardChars?: unknown } | null; latencyMs?: unknown; style?: unknown; fallback?: unknown } | null;
  /**
   * G1 — a REALTIME interview's turn, in two calls with the same input (the participant's transcribed words):
   * `prepare` → the rules decide; a rules turn is recorded and comes back to be spoken verbatim, a model turn
   * comes back as the provider's instructions (nothing recorded); then `transcript` + `call` (what the
   * provider said and its tool call) → checked like a written reply and recorded. `lastVerbatim` = what the
   * provider said for the previous verbatim turn, compared with it.
   */
  realtime?: { prepare?: boolean; transcript?: unknown; call?: { name?: unknown; arguments?: unknown } | null; lastVerbatim?: unknown } | null;
}
export interface RealtimeTurnOut { action: "say" | "respond" | "none"; text?: string; instructions?: string; correction?: boolean }

export async function turn(deps: Deps, body: TurnBody, opts: { onSay?: SayStream; onSpeak?: SpeakSink } = {}): Promise<{ interview: InterviewView; added: TurnView[]; replayed: boolean; realtime?: RealtimeTurnOut }> {
  const { session, study } = await sessionOf(deps, body.sessionToken);
  const plan = planFor(study, session.language);
  const silence = moderationOf(study.guide).silenceSeconds;
  const after = Number.isInteger(body.afterSeq) && body.afterSeq >= 0 ? body.afterSeq : -1;
  const existing = await deps.store.turns(session.id);
  const replay = async () => { const added = existing.filter((t) => t.seq > after).sort((a, b) => a.seq - b.seq).map((t) => turnView(plan, t)); return { interview: await withPanel(deps, session, view(plan, study, session, existing, silence)), added, replayed: true }; };
  /* finished (or ended by the research team: the view carries the note), or a resend of an answer already taken */
  if (session.status !== "in_progress" || after < session.state.seq) return replay();
  const kind = body.input?.kind === "silence" || body.input?.kind === "stop" ? body.input.kind : "answer";
  const text = kind === "answer" ? String(body.input?.text ?? "").slice(0, 8000).trim() : "";
  if (kind === "answer" && !text) throw new AiInterviewError("Please type or say an answer — or press Stop to end the interview.", 400, "empty_answer");
  /* G1: an interruption is measured against the STORED last moderator turn */
  const cutHeard = session.mode !== "text" && body.voice?.interrupted && Number.isFinite(Number(body.voice.interrupted.heardChars)) ? Math.max(0, Number(body.voice.interrupted.heardChars)) : null;
  const cutTurn = cutHeard !== null ? lastModeratorTurn(existing) : null;
  const interrupted = cutTurn && cutHeard !== null && cutHeard < cutTurn.text.length ? { said: cutTurn.text, heardChars: Math.min(cutHeard, cutTurn.text.length) } : undefined;
  const input: ParticipantInput = kind === "answer" ? { kind, text, meta: { ...(body.input?.meta ?? {}), ...(session.mode !== "text" && body.original != null ? { spoken: true } : {}) }, ...(interrupted ? { interrupted } : {}) } : { kind };
  const now = deps.now();
  const prepared = prepareTurn(plan, session.state, input, { now, modelAvailable: !!deps.model });
  /* G1 realtime: a model turn is spoken by the provider — hand it the turn's instructions, record nothing yet */
  const rt = session.mode === "voice" && session.state.voice?.style === "realtime" && body.realtime ? body.realtime : null;
  if (rt?.prepare && prepared.kind === "model") return { interview: await withPanel(deps, session, view(plan, study, session, existing, silence)), added: [], replayed: false, realtime: { action: "respond", instructions: realtimeTurnInstructions(plan, prepared) } };
  const rtRaw = rt && !rt.prepare && prepared.kind === "model" ? realtimeReplyFrom(String(rt.transcript ?? "").slice(0, 4000), rt.call ? { name: String(rt.call.name ?? ""), arguments: rt.call.arguments } : null) : null;
  const { state, reply, translation, spoken } = rtRaw ? { ...finishTurn(plan, prepared as Extract<typeof prepared, { kind: "model" }>, rtRaw, { now }), spoken: undefined as string | undefined } : await resolve(deps, plan, study, session, prepared, opts.onSay, body.script, opts.onSpeak);
  let rtOut: RealtimeTurnOut | undefined;
  if (rt) {
    const prev = lastModeratorTurn(existing);
    if (typeof rt.lastVerbatim === "string" && prev && rt.lastVerbatim.trim() && !spokeVerbatim(prev.text, rt.lastVerbatim)) state.flags.push({ kind: "realtime_unchecked", severity: "warning", at: state.seq, note: `The realtime voice said something other than the checked words: “${rt.lastVerbatim.slice(0, 160)}”` });
    if (rtRaw && reply.decision.source !== "model") {
      state.flags.push({ kind: "realtime_unchecked", severity: "warning", at: state.seq, note: `The realtime voice's words failed a check after they were spoken (${(reply.decision.problems ?? []).join("; ").slice(0, 120)}); the scripted turn followed` });
      rtOut = { action: "say", text: reply.say, instructions: realtimeVerbatimInstructions(reply.say), correction: true };
    } else if (rtRaw) rtOut = { action: "none" };
    else rtOut = { action: "say", text: reply.say, instructions: realtimeVerbatimInstructions(reply.say) };
  }
  const spokenFirst = rtRaw && reply.decision.source !== "model" ? String(rtRaw.say ?? "") : spoken;
  const latency = Number(body.voice?.latencyMs);
  if (session.mode !== "text" && (Number.isFinite(latency) && latency >= 0 || body.voice?.fallback || body.voice?.style)) {
    const v = state.voice ?? session.state.voice ?? { interruptions: 0, latenciesMs: [] };
    setVoice(state, {
      ...(Number.isFinite(latency) && latency >= 0 && latency < 120_000 ? { latenciesMs: [...(v.latenciesMs ?? []), Math.round(latency)].slice(-200) } : {}),
      ...((body.voice?.style === "turn_based" || body.voice?.style === "conversation") && body.voice?.fallback ? { style: body.voice.style, fallback: String(body.voice.fallback).slice(0, 120) } : {}),
    });
  }
  const offset = Math.max(0, now - session.startedAt);
  const newTurns: InterviewTurnRecord[] = [];
  if (kind === "answer") {
    const media = await Promise.all([body.audioMediaId, body.videoMediaId].map(async (m) => (m && session.consent.recording && await deps.store.mediaOwned(m, session.id) ? m : null)));
    newTurns.push({
      /* the engine numbers the answer and then the reply: the answer is the reply's seq - 1 */
      seq: state.seq - 1,
      speaker: "participant", text, language: session.language,
      ...(body.original != null && String(body.original).trim() !== text ? { originalText: String(body.original).slice(0, 8000) } : {}),
      ...(translation ? { translation } : {}),
      ...(media[0] ? { audioMediaId: media[0] } : {}), ...(media[1] ? { videoMediaId: media[1] } : {}),
      offsetMs: Math.max(0, offset - Math.max(0, Number(body.durationMs) || 0)), ...(Number(body.durationMs) > 0 ? { durationMs: Math.round(Number(body.durationMs)) } : {}),
      /* G1: the participant's voice turn — what they cut short, the previous reply's latency */
      ...(interrupted || (Number.isFinite(latency) && latency >= 0) ? { decision: { voice: { ...(interrupted && cutTurn ? { interrupted: { seq: cutTurn.seq, heardChars: interrupted.heardChars, of: cutTurn.text.length } } : {}), ...(Number.isFinite(latency) && latency >= 0 ? { previousReplyLatencyMs: Math.round(latency) } : {}) } } as never } : {}),
    });
  }
  const mod: InterviewTurnRecord = { seq: state.seq, speaker: "moderator", text: spokenFirst ? `${spokenFirst} ${reply.say}` : reply.say, language: session.language, decision: { ...reply.decision, stimuli: reply.stimuli.map((s) => s.name) } as never, offsetMs: offset };
  newTurns.push(mod);
  const status = interviewStatus(state);
  const all = [...existing, ...newTurns];
  const v = await deps.store.recordTurn({ sessionId: session.id, expected: session.version, turns: newTurns, state, status, flags: state.flags, turnsCount: all.length, costDelta: Math.max(0, state.costUsd - session.state.costUsd), completed: state.phase === "done" });
  if (v === null) {
    const fresh = await deps.store.sessionByHash(await deps.hash(body.sessionToken));
    const turns = await deps.store.turns(session.id);
    return { interview: view(plan, study, fresh ?? session, turns, silence), added: turns.filter((t) => t.seq > after).map((t) => turnView(plan, t)), replayed: true };
  }
  const after2: SessionRec = { ...session, state, status, version: v, flags: state.flags };
  if (state.phase === "done" && !session.isTest && state.answers > 0) await toQual(deps, plan, study, after2, all).catch((e) => console.warn("[rescript:ai-interview] transcript not written to the qualitative tables", JSON.stringify({ session: session.id.slice(0, 8), error: (e as Error).message })));
  /* G3: the moderator's NEW alert flags (and a completion) become events — the participant's words of this turn as the excerpt (redacted before anything stores or sends it) */
  const seen = new Set(session.flags.map((f) => f.kind));
  const fresh = state.flags.filter((f) => !seen.has(f.kind) && FLAG_EVENT[f.kind]);
  const base = { surveyId: study.surveyId, customerId: study.customerId, studyTitle: study.title, participant: `P${session.participantNumber}`, link: aiLink(study, session.id), isTest: session.isTest };
  await notifyAll(deps, [
    ...fresh.map((f) => ({ ...base, type: FLAG_EVENT[f.kind]!, ref: session.id, idempotencyKey: `${FLAG_EVENT[f.kind]}:${session.id}`, excerpt: f.kind === "provider_fallback" ? null : text || null, detail: { segment: session.segment, mode: session.mode, language: session.language, note: f.note.slice(0, 120) } })),
    ...(status === "completed" ? [{ ...base, type: "ai_interview.completed" as const, ref: session.id, idempotencyKey: `ai_interview.completed:${session.id}`, detail: { segment: session.segment, turns: all.length } }] : []),
  ]);
  return { interview: await withPanel(deps, after2, view(plan, study, after2, all, silence)), added: newTurns.map((t) => turnView(plan, t)), replayed: false, ...(rtOut ? { realtime: rtOut } : {}) };
}

export async function toQual(deps: Deps, plan: ModeratorPlan, study: StudyRec, session: SessionRec, turns: InterviewTurnRecord[]) {
  const label = `P${session.participantNumber}`;
  const transcript = transcriptForQual(turns, { studyId: study.id, interviewId: session.id, title: `AI interview — ${label}${session.segment ? ` (${session.segment})` : ""}`, participantLabel: label, segment: session.segment, mode: session.mode, language: session.language, moderatorName: plan.persona.name, flags: session.state.flags, covered: session.state.covered });
  return deps.store.saveQual({ study, session, transcript });
}

/** the engine's prepared turn → the final state and reply, calling the (metered) model when it asks */
async function resolve(deps: Deps, plan: ModeratorPlan, study: StudyRec, session: SessionRec | null, prepared: PreparedTurn, onSay: SayStream | undefined, script: unknown, onSpeak?: SpeakSink): Promise<{ state: ModeratorState; reply: ModeratorReply; translation?: string; /** G1: what was spoken of a model draft the scripted turn then replaced */ spoken?: string }> {
  /* G1: the reply spoken sentence by sentence — rules replies whole, model replies through the speech gate as they stream */
  const speaker = replySpeaker(plan, prepared, onSpeak, { study, session });
  if (prepared.kind === "final") {
    onSay?.(prepared.reply.say, true);
    speaker.finish(prepared.reply.say);
    return { state: prepared.state, reply: prepared.reply };
  }
  if (!deps.model) { const out = finishTurn(plan, prepared, null, { now: deps.now() }); onSay?.(out.reply.say, true); speaker.finish(out.reply.say); return out; }
  let r: ModelResult;
  try { r = await deps.model(prepared.request, { session, study, onSay: onSay || onSpeak ? (d) => { onSay?.(d); speaker.onSay(d); } : undefined, onIntent: onSpeak ? (d) => speaker.onIntent(d) : undefined, fake: () => fakeModeratorReply(plan, prepared), script }); }
  catch (e) { r = { failed: (e as Error).message }; }
  const out = "failed" in r ? finishTurn(plan, prepared, null, { now: deps.now() }) : finishTurn(plan, prepared, r.value, { now: deps.now(), costUsd: r.costUsd, ...(speaker.problems.length ? { extraProblems: speaker.problems } : {}) });
  /* what the page streamed was the model's draft; when the checks replaced it (or anything was appended), the page gets the final words */
  if (onSay && ("failed" in r || out.reply.decision.source !== "model" || out.reply.say !== String((r.value as { say?: unknown })?.say ?? "").replace(/\s+/g, " ").trim())) onSay(out.reply.say, true);
  const heard = speaker.finish(out.reply.say);
  return { ...out, ...(heard.replaced && heard.spoken ? { spoken: heard.spoken } : {}) };
}
