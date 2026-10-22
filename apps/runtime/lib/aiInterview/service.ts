import {
  buildModeratorPlan, displayableStimulus, fakeModeratorReply, finishTurn, interviewStatus, moderationOf, prepareTurn, publicStudyView, redirectFor, screenParticipant, startInterview, transcriptForQual,
  type InterviewTurnRecord, type ModelRequest, type ModeratorPlan, type ModeratorReply, type ModeratorState, type ParticipantInput, type PreparedTurn, type PublicStudyView,
} from "@rescript/engine";
import type { AiStimulus } from "@rescript/schema";
import type { AiInterviewStore, SessionRec, StudyRec } from "./types.ts";

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
export type ModelCaller = (req: ModelRequest, o: { session: SessionRec | null; study: StudyRec; onSay?: (delta: string) => void; fake: () => Record<string, unknown>; script?: unknown }) => Promise<ModelResult>;
/** what the page is told while a turn is written: pieces of the moderator's words, or (replace) the whole text when the rules' text replaced the model's */
export type SayStream = (text: string, replace?: boolean) => void;

export interface Deps {
  store: AiInterviewStore;
  model: ModelCaller | null;
  now: () => number;
  newToken: () => string;
  hash: (token: string) => Promise<string>;
}

export class AiInterviewError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

const planCache = new Map<string, { at: string; plan: ModeratorPlan }>();
export function planFor(study: StudyRec): ModeratorPlan {
  const key = JSON.stringify(study.guide).length + ":" + study.id + ":" + (study.guide.updatedAt ?? "");
  const hit = planCache.get(study.id);
  if (hit && hit.at === key) return hit.plan;
  const plan = buildModeratorPlan(study.guide, { guideLanguage: study.guideLanguage, title: study.title });
  planCache.set(study.id, { at: key, plan });
  return plan;
}

export interface TurnView { seq: number; speaker: "moderator" | "participant"; text: string; stimuli?: AiStimulus[]; at: number }
export interface InterviewView { participant: string; mode: SessionRec["mode"]; language: string; status: SessionRec["status"]; done: boolean; turns: TurnView[]; redirect: string | null; lastSeq: number; silenceSeconds: number; recording: boolean; note?: string }
export const ENDED_NOTE = "The research team has ended this interview. Thank you very much for your time.";

const shown = (plan: ModeratorPlan, names: unknown): AiStimulus[] => (Array.isArray(names) ? names : []).map((n) => plan.steps.flatMap((s) => s.stimuli).find((s) => s.name === n)).filter((s): s is AiStimulus => !!s).map(displayableStimulus).filter((s): s is AiStimulus => !!s);
function turnView(plan: ModeratorPlan, t: InterviewTurnRecord): TurnView {
  const stim = t.speaker === "moderator" ? shown(plan, (t.decision as unknown as { stimuli?: unknown } | null)?.stimuli) : [];
  return { seq: t.seq, speaker: t.speaker, text: t.text, ...(stim.length ? { stimuli: stim } : {}), at: t.offsetMs };
}

/* ------------------------------------------------------------ the study's public face */

export async function studyInfo(deps: Deps, linkToken: string, testToken?: string | null): Promise<{ view: PublicStudyView; open: boolean; test: boolean; closedReason?: string }> {
  const study = await deps.store.studyByLink(String(linkToken ?? "").slice(0, 80));
  if (!study) throw new AiInterviewError("This interview link is not active.", 404, "unknown_link");
  const test = !!testToken && testToken === study.testToken;
  const open = study.status === "live" || (test && study.status === "paused");
  return { view: publicStudyView(study.guide, { title: study.title }), open, test, ...(open ? {} : { closedReason: study.status === "paused" ? "This study is paused. Please try again later." : "This study is closed. Thank you for your interest." }) };
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
  script?: unknown;
}

export type BeginOutcome =
  | { kind: "started"; sessionToken: string; interview: InterviewView }
  | { kind: "screened_out"; message: string }
  | { kind: "full"; message: string };

const cleanLang = (l: unknown): string => String(l ?? "").toLowerCase().split(/[-_]/)[0].replace(/[^a-z]/g, "").slice(0, 8);

export async function begin(deps: Deps, body: BeginBody, opts: { onSay?: SayStream } = {}): Promise<BeginOutcome> {
  const info = await studyInfo(deps, body.token, body.test);
  if (!info.open) throw new AiInterviewError(info.closedReason ?? "closed", 410, "closed");
  const study = (await deps.store.studyByLink(body.token))!;
  const cfg = moderationOf(study.guide);
  const plan = planFor(study);
  if (body.consent?.agreed !== true) throw new AiInterviewError("Please read the consent statement and agree before starting.", 400, "consent_required");
  const mode = (["text", "voice", "video"] as const).find((m) => m === body.mode) ?? cfg.modes[0];
  if (!cfg.modes.includes(mode)) throw new AiInterviewError(`This study runs in ${cfg.modes.join(" or ")}.`, 400, "mode");
  const recording = body.consent?.recording === true;
  if ((mode === "voice" || mode === "video") && cfg.recordingConsent === "required" && !recording) throw new AiInterviewError(cfg.modes.includes("text") ? "This study needs your agreement to record voice or video answers — or choose text instead." : "This study needs your agreement to record your answers.", 400, "recording_consent");
  if (mode === "video" && !recording) throw new AiInterviewError("Camera interviews record each answer — agree to recording, or choose voice or text.", 400, "recording_consent");
  const language = cleanLang(body.language) || plan.guideLanguage;
  if (plan.languages.length && !plan.languages.includes(language)) throw new AiInterviewError(`This interview is available in: ${plan.languages.join(", ")}.`, 400, "language");
  const verdict = screenParticipant(cfg, body.screener ?? {});
  const consent = { statement: true, recording, at: new Date(deps.now()).toISOString() };
  const externalRef = body.pid ? String(body.pid).replace(/[^\w.:@-]/g, "").slice(0, 120) || null : null;
  const token = deps.newToken();
  const tokenHash = await deps.hash(token);
  if (!verdict.qualified) {
    await deps.store.begin({ study, segment: verdict.segment, isTest: info.test, screener: { ...verdict.answers, _reason: verdict.reason ?? "" }, consent, language, externalRef, mode, tokenHash, state: {}, flags: [], screenedOut: true }).catch(() => null);
    return { kind: "screened_out", message: "Thank you for your interest. Unfortunately you don't match the people we need for this study, so we won't continue — we appreciate your time." };
  }
  /* the opening first (in memory), so the session row is created with its state */
  const prepared = startInterview(plan, { now: deps.now(), language, modelAvailable: !!deps.model });
  const admitted = await deps.store.begin({ study, segment: verdict.segment, isTest: info.test, screener: verdict.answers, consent, language, externalRef, mode, tokenHash, state: prepared.state, flags: [] });
  if (!admitted.admitted) {
    if (/quota|target|full/.test(admitted.reason)) await deps.store.begin({ study, segment: verdict.segment, isTest: info.test, screener: { ...verdict.answers, _reason: admitted.reason }, consent, language, externalRef, mode, tokenHash: await deps.hash(deps.newToken()), state: {}, flags: [], screenedOut: true }).catch(() => null);
    if (admitted.reason === "closed" || admitted.reason === "budget reached") throw new AiInterviewError("This study is not taking new participants right now. Thank you for your interest.", 410, "closed");
    return { kind: "full", message: "Thank you for your interest — we already have all the people we need for this group, so we won't continue." };
  }
  const session = (await deps.store.sessionByHash(tokenHash))!;
  const { state, reply } = await resolve(deps, plan, study, session, prepared, opts.onSay, body.script);
  const turn: InterviewTurnRecord = { seq: state.seq, speaker: "moderator", text: reply.say, language, decision: { ...reply.decision, stimuli: reply.stimuli.map((s) => s.name) } as never, offsetMs: 0 };
  const v = await deps.store.recordTurn({ sessionId: session.id, expected: 0, turns: [turn], state, status: interviewStatus(state), flags: state.flags, turnsCount: 1, costDelta: state.costUsd, completed: state.phase === "done" });
  if (v === null) throw new AiInterviewError("The interview could not be started — please reload the page.", 409, "conflict");
  return { kind: "started", sessionToken: token, interview: view(plan, study, { ...session, state, status: interviewStatus(state) }, [turn], cfg.silenceSeconds) };
}

/* ------------------------------------------------------------ resuming */

export async function resume(deps: Deps, sessionToken: string): Promise<{ interview: InterviewView; info: PublicStudyView }> {
  const { session, study } = await sessionOf(deps, sessionToken);
  const plan = planFor(study);
  const turns = await deps.store.turns(session.id);
  return { interview: view(plan, study, session, turns, moderationOf(study.guide).silenceSeconds), info: publicStudyView(study.guide, { title: study.title }) };
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
  };
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
}

export async function turn(deps: Deps, body: TurnBody, opts: { onSay?: SayStream } = {}): Promise<{ interview: InterviewView; added: TurnView[]; replayed: boolean }> {
  const { session, study } = await sessionOf(deps, body.sessionToken);
  const plan = planFor(study);
  const silence = moderationOf(study.guide).silenceSeconds;
  const after = Number.isInteger(body.afterSeq) && body.afterSeq >= 0 ? body.afterSeq : -1;
  const existing = await deps.store.turns(session.id);
  const replay = () => { const added = existing.filter((t) => t.seq > after).sort((a, b) => a.seq - b.seq).map((t) => turnView(plan, t)); return { interview: view(plan, study, session, existing, silence), added, replayed: true }; };
  /* finished (or ended by the research team: the view carries the note), or a resend of an answer already taken */
  if (session.status !== "in_progress" || after < session.state.seq) return replay();
  const kind = body.input?.kind === "silence" || body.input?.kind === "stop" ? body.input.kind : "answer";
  const text = kind === "answer" ? String(body.input?.text ?? "").slice(0, 8000).trim() : "";
  if (kind === "answer" && !text) throw new AiInterviewError("Please type or say an answer — or press Stop to end the interview.", 400, "empty_answer");
  const input: ParticipantInput = kind === "answer" ? { kind, text, meta: { ...(body.input?.meta ?? {}), ...(session.mode !== "text" && body.original != null ? { spoken: true } : {}) } } : { kind };
  const now = deps.now();
  const prepared = prepareTurn(plan, session.state, input, { now, modelAvailable: !!deps.model });
  const { state, reply, translation } = await resolve(deps, plan, study, session, prepared, opts.onSay, body.script);
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
    });
  }
  const mod: InterviewTurnRecord = { seq: state.seq, speaker: "moderator", text: reply.say, language: session.language, decision: { ...reply.decision, stimuli: reply.stimuli.map((s) => s.name) } as never, offsetMs: offset };
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
  return { interview: view(plan, study, after2, all, silence), added: newTurns.map((t) => turnView(plan, t)), replayed: false };
}

export async function toQual(deps: Deps, plan: ModeratorPlan, study: StudyRec, session: SessionRec, turns: InterviewTurnRecord[]) {
  const label = `P${session.participantNumber}`;
  const transcript = transcriptForQual(turns, { studyId: study.id, interviewId: session.id, title: `AI interview — ${label}${session.segment ? ` (${session.segment})` : ""}`, participantLabel: label, segment: session.segment, mode: session.mode, language: session.language, moderatorName: plan.persona.name, flags: session.state.flags, covered: session.state.covered });
  return deps.store.saveQual({ study, session, transcript });
}

/** the engine's prepared turn → the final state and reply, calling the (metered) model when it asks */
async function resolve(deps: Deps, plan: ModeratorPlan, study: StudyRec, session: SessionRec | null, prepared: PreparedTurn, onSay: SayStream | undefined, script: unknown): Promise<{ state: ModeratorState; reply: ModeratorReply; translation?: string }> {
  if (prepared.kind === "final") {
    onSay?.(prepared.reply.say, true);
    return { state: prepared.state, reply: prepared.reply };
  }
  if (!deps.model) { const out = finishTurn(plan, prepared, null, { now: deps.now() }); onSay?.(out.reply.say, true); return out; }
  let r: ModelResult;
  try { r = await deps.model(prepared.request, { session, study, onSay: onSay ? (d) => onSay(d) : undefined, fake: () => fakeModeratorReply(plan, prepared), script }); }
  catch (e) { r = { failed: (e as Error).message }; }
  const out = "failed" in r ? finishTurn(plan, prepared, null, { now: deps.now() }) : finishTurn(plan, prepared, r.value, { now: deps.now(), costUsd: r.costUsd });
  /* what the page streamed was the model's draft; when the checks replaced it (or anything was appended), the page gets the final words */
  if (onSay && ("failed" in r || out.reply.decision.source !== "model" || out.reply.say !== String((r.value as { say?: unknown })?.say ?? "").replace(/\s+/g, " ").trim())) onSay(out.reply.say, true);
  return out;
}
