import {
  PORTAL_POLICY, accountVerdict, enrolmentAccess, failuresAfterWrong, hashPassword, hashToken, lockoutVerdict, mintToken, normaliseLogin,
  passwordProblems, sessionVerdict, verifyPassword, TOKEN, type EnrolmentAccess, type PortalPolicy,
} from "@rescript/access/respondent";
import { buildBenchmark, compare, onePerPerson, type BenchmarkSnapshot, type Comparison } from "@rescript/analytics/benchmark";
import { buildInsights, buildProjections, buildTrends, checkSubmission, editDecision, editWindow, isAssessment, minChanges, nextDue, portalAnswerLines, portalDefinition, portalPresentation, portalSettings, NOTE_NOT_ADVICE, PROJECTION_NOTE, respondentScorecard, scorecardOf, seriesOf, OVERALL_ID, type DimensionTrend, type HistoryPoint, type Insight, type Projection, type PortalAnswerLine, type PortalPresentation, type PortalWords, type ScorecardResult } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { scoreInterview, type ScoredInterview } from "./scorecardRow.ts";
import type { AccountRec, AttemptRec, EnrolmentRec, PortalStore, SessionRec } from "./types.ts";

/**
 * THE RESPONDENT PORTAL'S SERVICE (Respondent Intelligence Engine, phase 1, 2026-11-20).
 *
 * Every rule a signed-in respondent is subject to, in one place and with no HTTP or database in it:
 *
 *   - sign-in by respondent id or email + password; the same answer for "no such account" and "wrong password";
 *     five wrong passwords pause the account for fifteen minutes; a session ends after thirty idle minutes;
 *   - an invitation or reset link works once, for a limited time, and signs every other session out;
 *   - a respondent reaches ONLY the enrolments linked to their own account — an id from somebody else's is "not
 *     found", never "forbidden";
 *   - what they may start, resume, see and change is decided by @rescript/access (`enrolmentAccess`) and
 *     @rescript/engine (`editDecision`), from the researcher's settings;
 *   - a changed answer is replayed through the survey's own logic before it is stored, and written with a
 *     revision check and an edit-history row, so two tabs cannot overwrite each other silently.
 *
 * Everything worth knowing later is logged through `store.log` (the access log).
 */
export class PortalError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

export interface SummaryRequest { customerId: string; surveyId: string; sessionId: string; noun: string; sentences: string[] }
export interface PortalDeps {
  store: PortalStore; now: () => number; policy?: PortalPolicy;
  /** phase 5: the AI re-wording of rule-written sentences (metered, guarded); absent or null = the sentences as they are */
  summarise?: (req: SummaryRequest) => Promise<string | null>;
}
export interface PortalContext { account: AccountRec; session: SessionRec }
export interface RequestMeta { device?: string | null; ipHash?: string | null }

const iso = (ms: number) => new Date(ms).toISOString();
const policyOf = (d: PortalDeps) => d.policy ?? PORTAL_POLICY;
const NO_MATCH = "The details you entered do not match an account. Check your Respondent ID or email, and your password.";

export const accountView = (a: AccountRec) => ({ respondentId: a.respondentId, name: a.name, email: a.email, scope: a.scope });

/* ------------------------------------------------------------------ sign-in and sessions */

async function openSession(d: PortalDeps, account: AccountRec, meta: RequestMeta, how: string): Promise<{ sessionToken: string; session: SessionRec }> {
  const sessionToken = mintToken();
  const now = iso(d.now());
  const session = await d.store.createSession({ accountId: account.id, tokenHash: hashToken(sessionToken), deviceLabel: (meta.device ?? "").slice(0, 120) || null, ipHash: meta.ipHash ?? null, now });
  await d.store.saveAccount(account.id, { lastLoginAt: now });
  await d.store.log({ accountId: account.id, event: how, ipHash: meta.ipHash ?? null });
  return { sessionToken, session };
}

export async function signIn(d: PortalDeps, body: { login: unknown; password: unknown }, meta: RequestMeta = {}) {
  const login = normaliseLogin(body.login);
  const password = typeof body.password === "string" ? body.password : "";
  const account = login ? await d.store.accountByLogin(login) : null;
  const cred = account ? await d.store.credential(account.id) : null;
  const now = d.now();

  if (account && cred) {
    const lock = lockoutVerdict(cred, now, policyOf(d));
    if (lock.locked) throw new PortalError(429, "locked", "Too many wrong passwords. Please wait a few minutes and try again, or reset your password.", { until: lock.until });
  }
  /* always spends the hashing work, so an unknown login takes as long as a wrong password */
  const ok = await verifyPassword(password, cred?.passwordHash ?? null);
  if (!account || !cred || !ok) {
    if (account && cred) {
      await d.store.saveCredential(account.id, { failedAttempts: failuresAfterWrong(cred, now, policyOf(d)), lastFailedAt: iso(now) });
      await d.store.log({ accountId: account.id, event: "sign_in_failed", ipHash: meta.ipHash ?? null });
    }
    throw new PortalError(401, "no_match", NO_MATCH);
  }

  /* the password was right: now, and only now, say what is wrong with the account */
  let acct = account;
  const verdict = accountVerdict(acct, now);
  if (!verdict.ok) {
    if (verdict.reason === "not_activated") { await d.store.saveAccount(acct.id, { status: "active" }); acct = { ...acct, status: "active" }; }
    else throw new PortalError(403, `account_${verdict.reason}`, verdict.reason === "suspended" ? "Your access has been paused. Please contact the organiser of your assessment." : "This account is no longer active.");
  }
  await d.store.saveCredential(acct.id, { failedAttempts: 0, lastFailedAt: null });
  const s = await openSession(d, acct, meta, "sign_in");
  return { ...s, account: accountView(acct), mustChangePassword: cred.mustChange };
}

/** who is this request — or a refusal; an idle or expired session is closed as it is found */
export async function authenticate(d: PortalDeps, sessionToken: string | null | undefined): Promise<PortalContext> {
  const refuse = (code = "signed_out") => new PortalError(401, code, "Please sign in again.");
  if (!sessionToken || !TOKEN.test(sessionToken)) throw refuse();
  const session = await d.store.sessionByHash(hashToken(sessionToken));
  if (!session) throw refuse();
  const now = d.now();
  const v = sessionVerdict(session, now, policyOf(d));
  if (!v.ok) {
    if (v.reason !== "revoked") await d.store.revokeSession(session.id, v.reason, iso(now));
    throw refuse(v.reason === "idle" ? "session_idle" : "signed_out");
  }
  const account = await d.store.accountById(session.accountId);
  if (!account || !accountVerdict(account, now).ok) {
    await d.store.revokeSession(session.id, "account", iso(now));
    throw refuse();
  }
  if (now - Date.parse(session.lastSeenAt) > 60_000) await d.store.touchSession(session.id, iso(now));
  return { account, session };
}

export async function signOut(d: PortalDeps, ctx: PortalContext): Promise<void> {
  await d.store.revokeSession(ctx.session.id, "signed_out", iso(d.now()));
  await d.store.log({ accountId: ctx.account.id, event: "sign_out" });
}

export async function listSessions(d: PortalDeps, ctx: PortalContext) {
  const now = d.now();
  return (await d.store.sessions(ctx.account.id))
    .filter((s) => sessionVerdict(s, now, policyOf(d)).ok)
    .map((s) => ({ id: s.id, device: s.deviceLabel, signedInAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === ctx.session.id }));
}

export async function endSession(d: PortalDeps, ctx: PortalContext, sessionId: unknown): Promise<void> {
  const mine = (await d.store.sessions(ctx.account.id)).find((s) => s.id === sessionId);
  if (!mine) throw new PortalError(404, "not_found", "That session was not found.");
  await d.store.revokeSession(mine.id, "ended_by_respondent", iso(d.now()));
}

/* ------------------------------------------------------------------ invitation, password, reset */

function checkNewPassword(pw: unknown, a: AccountRec): string {
  const problems = passwordProblems(pw, { email: a.email, respondentId: a.respondentId });
  if (problems.length) throw new PortalError(400, "weak_password", problems[0]!, { problems });
  return pw as string;
}

const badLink = () => new PortalError(410, "link_invalid", "This link is not valid any more. Ask the organiser for a new invitation, or reset your password.");

/** what the "set your password" page shows for an invitation link — nothing about the account beyond the id and name */
export async function invitationInfo(d: PortalDeps, token: unknown) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw badLink();
  const account = await d.store.accountByInviteHash(hashToken(token));
  const cred = account ? await d.store.credential(account.id) : null;
  if (!account || !cred?.inviteExpiresAt || Date.parse(cred.inviteExpiresAt) <= d.now()) throw badLink();
  if (account.status === "suspended" || account.status === "closed") throw badLink();
  return { respondentId: account.respondentId, name: account.name };
}

export async function acceptInvitation(d: PortalDeps, body: { token: unknown; password: unknown }, meta: RequestMeta = {}) {
  await invitationInfo(d, body.token);
  const account = (await d.store.accountByInviteHash(hashToken(body.token as string)))!;
  const password = checkNewPassword(body.password, account);
  const now = iso(d.now());
  await d.store.saveCredential(account.id, { passwordHash: await hashPassword(password), mustChange: false, inviteTokenHash: null, inviteExpiresAt: null, resetTokenHash: null, resetExpiresAt: null, failedAttempts: 0, lastFailedAt: null });
  await d.store.saveAccount(account.id, { status: "active" });
  await d.store.revokeAllSessions(account.id, "password_set", now);
  const s = await openSession(d, { ...account, status: "active" }, meta, "invitation_accepted");
  return { ...s, account: accountView(account), mustChangePassword: false };
}

export async function changePassword(d: PortalDeps, ctx: PortalContext, body: { current: unknown; next: unknown }): Promise<void> {
  const cred = await d.store.credential(ctx.account.id);
  if (!cred || !(await verifyPassword(typeof body.current === "string" ? body.current : "", cred.passwordHash))) throw new PortalError(403, "wrong_password", "Your current password is not correct.");
  const next = checkNewPassword(body.next, ctx.account);
  if (next === body.current) throw new PortalError(400, "same_password", "Choose a password you have not just used.");
  const now = iso(d.now());
  await d.store.saveCredential(ctx.account.id, { passwordHash: await hashPassword(next), mustChange: false });
  await d.store.revokeAllSessions(ctx.account.id, "password_changed", now, ctx.session.id);
  await d.store.log({ accountId: ctx.account.id, event: "password_changed" });
}

/**
 * Start a reset. Returns what to email, or null — the caller answers the same either way, so the form cannot be used
 * to find out whether an address has an account. One link per two minutes per account.
 */
export async function requestReset(d: PortalDeps, loginRaw: unknown): Promise<{ to: string; name: string | null; respondentId: string; token: string; minutes: number } | null> {
  const login = normaliseLogin(loginRaw);
  const account = login ? await d.store.accountByLogin(login) : null;
  if (!account?.email || account.status === "suspended" || account.status === "closed") return null;
  if (account.expiresAt && Date.parse(account.expiresAt) <= d.now()) return null;
  const cred = await d.store.credential(account.id);
  if (!cred) return null;
  const p = policyOf(d);
  if (cred.resetExpiresAt && Date.parse(cred.resetExpiresAt) - p.resetMinutes * 60_000 > d.now() - 120_000) return null;
  const token = mintToken();
  await d.store.saveCredential(account.id, { resetTokenHash: hashToken(token), resetExpiresAt: iso(d.now() + p.resetMinutes * 60_000) });
  await d.store.log({ accountId: account.id, event: "reset_requested" });
  return { to: account.email, name: account.name, respondentId: account.respondentId, token, minutes: p.resetMinutes };
}

export async function confirmReset(d: PortalDeps, body: { token: unknown; password: unknown }): Promise<void> {
  if (typeof body.token !== "string" || !TOKEN.test(body.token)) throw badLink();
  const account = await d.store.accountByResetHash(hashToken(body.token));
  const cred = account ? await d.store.credential(account.id) : null;
  if (!account || !cred?.resetExpiresAt || Date.parse(cred.resetExpiresAt) <= d.now()) throw badLink();
  if (account.status === "suspended" || account.status === "closed") throw badLink();
  const password = checkNewPassword(body.password, account);
  const now = iso(d.now());
  await d.store.saveCredential(account.id, { passwordHash: await hashPassword(password), mustChange: false, resetTokenHash: null, resetExpiresAt: null, inviteTokenHash: null, inviteExpiresAt: null, failedAttempts: 0, lastFailedAt: null });
  if (account.status === "invited") await d.store.saveAccount(account.id, { status: "active" });
  await d.store.revokeAllSessions(account.id, "password_reset", now);
  await d.store.log({ accountId: account.id, event: "password_reset" });
}

export async function updateProfile(d: PortalDeps, ctx: PortalContext, body: { name?: unknown }) {
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!name) throw new PortalError(400, "name_required", "Please enter your name.");
  await d.store.saveAccount(ctx.account.id, { name });
  return accountView({ ...ctx.account, name });
}

/* ------------------------------------------------------------------ assessments */

const FINISHED = new Set(["complete", "screened", "quota_full", "terminated"]);

async function facts(d: PortalDeps, e: EnrolmentRec) {
  const attempts = await d.store.attempts(e);
  const live = e.link ? await d.store.definition(e, e.link.versionId) : null;
  const access = enrolmentAccess({
    surveyStatus: e.link ? e.surveyStatus : "closed",
    accessFrom: e.accessFrom, accessUntil: e.accessUntil, suspended: e.suspended,
    maxAttempts: e.maxAttempts ?? live?.portal?.maxAttempts ?? null,
    allowRetake: live?.deployment?.access?.allowRetake === true,
    finished: attempts.filter((a) => FINISHED.has(a.status)).length,
    inProgress: attempts.some((a) => a.status === "in_progress"),
  }, d.now());
  return { attempts, live, access, at: new Date(d.now()).toISOString() };
}

/** results over time are shown only with BOTH permissions (scores, and their history) and a scorecard to score by */
const mayTrend = (live: SurveyDefinition | null): boolean => { const p = live ? portalSettings(live) : null; return !!p?.show.scores && !!p.show.trends && !!live && !!scorecardOf(live); };

export interface AssessmentCard {
  id: string; title: string; state: EnrolmentAccess["state"]; canStart: boolean; canResume: boolean; attemptsLeft: number | null;
  reason: string | null; opensAt: string | null; closesAt: string | null; attempts: number; lastCompletedAt: string | null; canViewAnswers: boolean; canViewScores: boolean;
  /** phase 3: results over time may be seen; when a repeated assessment is next due */
  canViewTrends: boolean; nextDue: { at: string; overdue: boolean } | null;
  /** phase 4: how this assessment presents itself — its template's words, note and colour (the standard ones without a template) */
  look: PortalPresentation;
}

/** the survey's presentation; a portal that is off presents as standard */
const lookOf = (live: SurveyDefinition | null): PortalPresentation => portalPresentation(live ? portalSettings(live) : null);

/**
 * The engine words its reasons for a standard portal ("the organiser", "this assessment"). A template names those
 * two things differently, so a sentence is re-worded on its way out — the rule that produced it is untouched.
 */
export function inWords(text: string, w: PortalWords): string;
export function inWords(text: string | null, w: PortalWords): string | null;
export function inWords(text: string | null, w: PortalWords): string | null {
  if (!text) return text;
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  return text.replace(/\bthe organiser\b/g, w.organiser).replace(/\bThe organiser\b/g, cap(w.organiser)).replace(/\b([Tt]his|[Tt]he) assessment\b/g, (_m, a: string) => `${a} ${w.one}`);
}

function card(e: EnrolmentRec, f: Awaited<ReturnType<typeof facts>>): AssessmentCard {
  const done = f.attempts.filter((a) => a.status === "complete" && a.completedAt).map((a) => a.completedAt!).sort();
  const portal = f.live ? portalSettings(f.live) : null;
  const look = lookOf(f.live);
  return {
    look,
    id: e.id, title: e.title, state: f.access.state, canStart: f.access.canStart, canResume: f.access.canResume, attemptsLeft: f.access.attemptsLeft,
    reason: inWords(f.access.reason, look.words), opensAt: e.accessFrom, closesAt: e.accessUntil, attempts: f.attempts.filter((a) => FINISHED.has(a.status)).length,
    lastCompletedAt: done.at(-1) ?? null, canViewAnswers: !!portal?.show.answers && done.length > 0,
    canViewScores: !!portal?.show.scores && !!f.live && !!scorecardOf(f.live) && done.length > 0,
    canViewTrends: mayTrend(f.live) && done.length > 0,
    nextDue: f.access.state === "suspended" || f.access.state === "closed" ? null : nextDue(f.live, done.at(-1) ?? null, Date.parse(f.at)),
  };
}

/** the dashboard: every assessment linked to this account, and nothing else */
export async function overview(d: PortalDeps, ctx: PortalContext) {
  const cards: AssessmentCard[] = [];
  for (const e of await d.store.enrolments(ctx.account.id)) cards.push(card(e, await facts(d, e)));
  const order: Record<string, number> = { in_progress: 0, open: 1, upcoming: 2, completed: 3, closed: 4, suspended: 5 };
  cards.sort((a, b) => (order[a.state]! - order[b.state]!) || a.title.localeCompare(b.title));
  return { account: accountView(ctx.account), assessments: cards };
}

/** the enrolment, only when it belongs to this account — otherwise "not found" */
async function own(d: PortalDeps, ctx: PortalContext, enrolmentId: unknown): Promise<EnrolmentRec> {
  const e = typeof enrolmentId === "string" ? (await d.store.enrolments(ctx.account.id)).find((x) => x.id === enrolmentId) : null;
  if (!e) throw new PortalError(404, "not_found", "That assessment was not found.");
  return e;
}

const policyDef = portalDefinition;

export interface AttemptView {
  id: string; status: string; startedAt: string | null; completedAt: string | null; revision: number; answers: PortalAnswerLine[] | null; editableUntil: string | null; editable: boolean; editNote: string | null;
  /** phase 2: this attempt's scores, when the researcher shows them */
  scores: ScorecardResult | null;
  /** how the latest attempt's scores sit among everyone's and the person's own group's — groups only, never a person */
  comparison: Comparison[] | null;
  /** phase 5: a few rule-written sentences about the latest results (their strongest score, the one with most room, their standing) */
  insights: Insight[] | null;
}

/** a snapshot is rebuilt when it is older than this, or was made for another scoring, grouping or minimum */
export const BENCHMARK_MAX_AGE_MS = 15 * 60_000;

async function benchmarkFor(d: PortalDeps, e: EnrolmentRec, pd: SurveyDefinition, key: string): Promise<BenchmarkSnapshot | null> {
  const b = portalSettings(pd)!.benchmark;
  try {
    const stored = await d.store.benchmark(e);
    if (stored && stored.snapshot.fingerprint === key && stored.snapshot.minCohort === b.minCohort && d.now() - Date.parse(stored.computedAt) < BENCHMARK_MAX_AGE_MS) return stored.snapshot;
    const snapshot = buildBenchmark(onePerPerson(await d.store.scoreRows(e, key)), { fingerprint: key, minCohort: b.minCohort, groupings: b.groups.map((g) => g.id) });
    await d.store.saveBenchmark(e, snapshot, new Date(d.now()).toISOString());
    return snapshot;
  } catch (err) {
    console.warn("[rescript:portal] no benchmark", JSON.stringify({ surveyId: e.surveyId, error: (err as Error).message }));
    return null;
  }
}

/** the comparison a respondent may see: only dimensions they have a score for, only their own groups, labelled */
function comparisonView(pd: SurveyDefinition, scored: ScoredInterview, snapshot: BenchmarkSnapshot | null): Comparison[] {
  const label = new Map(portalSettings(pd)!.benchmark.groups.map((g) => [g.id, g.label]));
  return compare(snapshot, scored.scores, scored.cohort, scored.key).map((c) => ({ ...c, groups: c.groups.map((g) => ({ ...g, grouping: label.get(g.grouping) ?? g.grouping })) }));
}

export async function assessmentDetail(d: PortalDeps, ctx: PortalContext, enrolmentId: unknown) {
  const e = await own(d, ctx, enrolmentId);
  const f = await facts(d, e);
  const portal = f.live ? portalSettings(f.live) : null;
  const words = lookOf(f.live).words;
  const ordered = [...f.attempts].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  const latestComplete = ordered.find((a) => a.status === "complete");
  const now = d.now();
  const views: AttemptView[] = [];
  for (const a of ordered) {
    const visible = a.status === "complete" && (a.id === latestComplete?.id || !!portal?.show.history);
    const may = !!portal?.show.answers && visible;
    const mayScore = !!portal?.show.scores && visible && !!f.live && !!scorecardOf(f.live);
    let answers: PortalAnswerLine[] | null = null, editableUntil: string | null = null, editable = false, editNote: string | null = null;
    let scores: ScorecardResult | null = null, comparison: Comparison[] | null = null;
    let insights: Insight[] | null = null;
    if ((may || mayScore) && a.versionId) {
      const data = await d.store.attempt(e, a.id);
      const def = await d.store.definition(e, a.versionId);
      if (data && def) {
        const pd = policyDef(def, f.live);
        if (may) {
          const enrol = { lockedAt: e.lockedAt, reopenedUntil: e.reopenedUntil };
          /* only the latest completed attempt can be changed: an earlier one is history */
          const window = a.id === latestComplete?.id ? editWindow(pd, a, enrol, now) : { allowed: false as const, code: "not_completed" as const, reason: "An earlier attempt cannot be changed." };
          answers = portalAnswerLines(pd, data.answers, a, enrol, now).map((l) => (window.allowed ? l : { ...l, edit: window }))
            .map((l) => (l.edit.allowed ? l : { ...l, edit: { ...l.edit, reason: inWords(l.edit.reason, words) } }));
          editable = window.allowed && answers.some((l) => l.edit.allowed);
          editableUntil = window.allowed ? window.until : null;
          editNote = window.allowed ? null : window.code === "editing_off" || window.code === "no_portal" ? null : inWords(window.reason, words);
        }
        if (mayScore) {
          /* a person's own scores are always worked out from their answers, never read from a stored row */
          const scored = scoreInterview(pd, data);
          scores = scored ? respondentScorecard(pd, scored.result) : null;
          if (scored && scores && a.id === latestComplete?.id && portal!.show.comparison && portal!.benchmark.enabled) comparison = comparisonView(pd, scored, await benchmarkFor(d, e, pd, scored.key));
          /* from what the person is shown, and nothing more: the visible scores and their own standing */
          if (scores && a.id === latestComplete?.id && portal!.show.insights) insights = buildInsights(scores, null, comparison);
        }
      }
    }
    views.push({ id: a.id, status: a.status, startedAt: a.startedAt, completedAt: a.completedAt, revision: a.revision, answers, editableUntil, editable, editNote, scores, comparison, insights });
  }
  await d.store.log({ accountId: ctx.account.id, event: "assessment_viewed", surveyId: e.surveyId, customerId: e.customerId });
  const c = card(e, f);
  /* the sentence under a person's results: the template's; without one, the standard note unless it is a marked test */
  const resultNote = c.look.note ?? (f.live && isAssessment(f.live) ? null : NOTE_NOT_ADVICE);
  /* the AI re-wording is offered only where the researcher allows it and there is something to re-word */
  const canExplain = !!portal?.show.aiSummary && views.some((v) => v.insights?.length);
  return { assessment: { ...c, resultNote, canExplain }, attempts: views };
}

/* ------------------------------------------------------------------ phase 3: results over time */

/** the most recent completed attempts of one assessment that are read for a history */
export const HISTORY_ATTEMPTS = 24;

export interface ProgressTrack {
  /** the series, or the one assessment when it belongs to none */
  title: string;
  series: boolean;
  assessments: { id: string; title: string; period: string | null }[];
  results: number;
  trends: DimensionTrend[];
  nextDue: { at: string; overdue: boolean; assessmentId: string } | null;
  look: PortalPresentation;
  /** phase 5: patterns and changes in words; and, where allowed, the range the next result would fall in */
  insights: Insight[];
  projections: Projection[];
  projectionNote: string | null;
}

/**
 * MY PROGRESS: the person's own scores over time. One track per series (surveys of the SAME workspace that carry
 * the same series id) and one per assessment that is in no series. Only assessments whose researcher shows scores
 * and their history take part; every score is worked out again from the person's own answers; the comparability
 * rule is the engine's (history.ts). A group average accompanies the latest result of an assessment only where
 * the comparison is permitted and a group of the minimum size exists — it is the average of everyone, never a person.
 */
export async function progress(d: PortalDeps, ctx: PortalContext): Promise<{ tracks: ProgressTrack[] }> {
  const groups = new Map<string, { title: string; series: boolean; members: { e: EnrolmentRec; live: SurveyDefinition; period: string | null; last: string | null }[]; points: HistoryPoint[] }>();
  for (const e of await d.store.enrolments(ctx.account.id)) {
    const f = await facts(d, e);
    if (!f.live || !mayTrend(f.live)) continue;
    const portal = portalSettings(f.live)!;
    const series = seriesOf(f.live);
    /* a series never crosses workspaces: the key carries the customer */
    const key = series ? `series|${e.customerId ?? ""}|${series.id}` : `one|${e.id}`;
    const g = groups.get(key) ?? groups.set(key, { title: series?.label ?? e.title, series: !!series, members: [], points: [] }).get(key)!;
    const done = f.attempts.filter((a) => a.status === "complete" && a.completedAt && a.versionId).sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt))).slice(-HISTORY_ATTEMPTS);
    g.members.push({ e, live: f.live, period: series?.period ?? null, last: done.at(-1)?.completedAt ?? null });
    let latest: { point: HistoryPoint; pd: SurveyDefinition; key: string } | null = null;
    for (const a of done) {
      const data = await d.store.attempt(e, a.id);
      const def = await d.store.definition(e, a.versionId!);
      if (!data || !def) continue;
      const pd = portalDefinition(def, f.live);
      const scored = scoreInterview(pd, data);
      const shown = scored ? respondentScorecard(pd, scored.result) : null;
      if (!scored || !shown) continue;
      const point: HistoryPoint = { at: a.completedAt!, wave: series?.period ?? "", surveyId: e.surveyId, responseId: a.id, result: shown };
      g.points.push(point);
      latest = { point, pd, key: scored.key };
    }
    if (latest && portal.show.comparison && portal.benchmark.enabled) {
      const snap = await benchmarkFor(d, e, latest.pd, latest.key);
      if (snap && snap.fingerprint === latest.key) {
        const group: NonNullable<HistoryPoint["group"]> = {};
        for (const [id, dist] of Object.entries(snap.all)) group[id === "__overall" ? OVERALL_ID : id] = { mean: dist.mean, n: dist.n };
        latest.point.group = group;
      }
    }
  }
  const tracks: ProgressTrack[] = [];
  for (const g of groups.values()) {
    if (!g.points.length) continue;
    /* the settings of the assessment answered most recently decide what "about the same" means and what is due */
    const newest = [...g.members].sort((a, b) => String(b.last ?? "").localeCompare(String(a.last ?? "")))[0]!;
    const due = nextDue(newest.live, newest.last, d.now());
    tracks.push({
      title: g.title, series: g.series, results: g.points.length,
      assessments: g.members.map((m) => ({ id: m.e.id, title: m.e.title, period: m.period })),
      trends: buildTrends(g.points, minChanges(newest.live)),
      nextDue: due && !newest.e.suspended ? { ...due, assessmentId: newest.e.id } : null,
      look: lookOf(newest.live),
      insights: [], projections: [], projectionNote: null,
    });
    const t = tracks.at(-1)!;
    const show = portalSettings(newest.live)!.show;
    /* only patterns and changes here — the page of one assessment says which score is strongest */
    if (show.insights) t.insights = buildInsights({ v: 1, fingerprint: "", dimensions: [], overall: null }, t.trends, null, minChanges(newest.live));
    if (show.projection) { t.projections = buildProjections(t.trends); t.projectionNote = t.projections.length ? PROJECTION_NOTE : null; }
  }
  tracks.sort((a, b) => a.title.localeCompare(b.title));
  await d.store.log({ accountId: ctx.account.id, event: "progress_viewed" });
  return { tracks };
}

/**
 * THE SAME SENTENCES, RE-WORDED (phase 5). Offered only where the researcher switched it on (and the template
 * allows it). The provider is sent the rule-written sentences and the word for the assessment — no name, no id,
 * no answer. Whatever comes back is checked; if there is nothing usable, the person gets the sentences themselves
 * and is told which they are reading.
 */
export async function explainResults(d: PortalDeps, ctx: PortalContext, enrolmentId: unknown): Promise<{ text: string; source: "ai" | "rules" }> {
  const detail = await assessmentDetail(d, ctx, enrolmentId);
  if (!detail.assessment.canExplain) throw new PortalError(403, "summary_off", "A summary is not available for this assessment.");
  const a = detail.attempts.find((x) => x.insights?.length)!;
  const e = await own(d, ctx, enrolmentId);
  const sentences = a.insights!.map((i) => i.text);
  let text: string | null = null;
  if (d.summarise && e.customerId) {
    const row = (await d.store.attempts(e)).find((x) => x.id === a.id);
    try { text = await d.summarise({ customerId: e.customerId, surveyId: e.surveyId, sessionId: row?.sessionId ?? a.id, noun: detail.assessment.look.words.one, sentences }); }
    catch (err) { console.warn("[rescript:portal] summary failed", JSON.stringify({ surveyId: e.surveyId, error: (err as Error).message })); }
  }
  await d.store.log({ accountId: ctx.account.id, event: "results_summarised", surveyId: e.surveyId, customerId: e.customerId, detail: { source: text ? "ai" : "rules", sentences: sentences.length } });
  return text ? { text, source: "ai" } : { text: sentences.join(" "), source: "rules" };
}

/**
 * What a personal report may contain: the latest attempt the person may see, exactly as the results page shows it
 * (the same call decides both). Nothing to show is "not found", so a report can never say more than the page.
 */
export async function personalReport(d: PortalDeps, ctx: PortalContext, enrolmentId: unknown) {
  const detail = await assessmentDetail(d, ctx, enrolmentId);
  const a = detail.attempts.find((x) => x.scores || x.answers?.length);
  if (!a) throw new PortalError(404, "no_report", "There is nothing to put in a report yet.");
  const e = await own(d, ctx, enrolmentId);
  await d.store.log({ accountId: ctx.account.id, event: "report_downloaded", surveyId: e.surveyId, customerId: e.customerId });
  return {
    title: detail.assessment.title, person: { name: ctx.account.name, respondentId: ctx.account.respondentId }, completedAt: a.completedAt,
    generatedAt: new Date(d.now()).toISOString(), note: detail.assessment.resultNote, resultsTitle: detail.assessment.look.words.results, scores: a.scores, comparison: a.comparison,
    answers: a.answers?.length ? a.answers.map((l) => ({ code: l.code, text: l.text, answer: l.answer })) : null,
  };
}

/** where to send the browser to take (or continue) the assessment */
export async function startLink(d: PortalDeps, ctx: PortalContext, enrolmentId: unknown): Promise<{ url: string; resumed: boolean }> {
  const e = await own(d, ctx, enrolmentId);
  const f = await facts(d, e);
  if (!f.access.canStart && !f.access.canResume) throw new PortalError(409, `assessment_${f.access.state}`, inWords(f.access.reason ?? "This assessment cannot be taken at the moment.", lookOf(f.live).words));
  if (!e.link) throw new PortalError(409, "assessment_closed", "This assessment is not open at the moment.");
  const running = f.access.canResume ? f.attempts.find((a) => a.status === "in_progress") : null;
  const q = new URLSearchParams({ token: e.token });
  if (running) q.set("r", running.sessionId);
  await d.store.log({ accountId: ctx.account.id, event: running ? "assessment_resumed" : "assessment_started", surveyId: e.surveyId, customerId: e.customerId });
  return { url: `/s/${encodeURIComponent(e.link.clientSlug)}/${encodeURIComponent(e.link.studySlug)}?${q.toString()}`, resumed: !!running };
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Change one answer of the latest completed attempt.
 *
 * Refused unless the researcher's settings allow THIS question to be changed NOW. The new answer set is replayed
 * through the survey's own logic; a change that fails a rule — or that would alter which questions were asked —
 * is refused rather than stored half-valid. Written with the revision the respondent was looking at.
 */
export async function editAnswer(d: PortalDeps, ctx: PortalContext, body: { enrolmentId: unknown; responseId: unknown; questionId: unknown; value: unknown; revision: unknown }) {
  const e = await own(d, ctx, body.enrolmentId);
  const f = await facts(d, e);
  const latest = [...f.attempts].filter((a) => a.status === "complete").sort((a, b) => String(b.completedAt ?? "").localeCompare(String(a.completedAt ?? "")))[0];
  const attemptRec: AttemptRec | undefined = f.attempts.find((a) => a.id === body.responseId);
  if (!attemptRec || typeof body.questionId !== "string") throw new PortalError(404, "not_found", "That answer was not found.");
  if (attemptRec.id !== latest?.id) throw new PortalError(409, "not_latest", "Only your most recent completed attempt can be changed.");
  const data = await d.store.attempt(e, attemptRec.id);
  const def = data?.versionId ? await d.store.definition(e, data.versionId) : null;
  if (!data || !def) throw new PortalError(404, "not_found", "That answer was not found.");
  const pd = policyDef(def, f.live);

  const decision = editDecision(pd, body.questionId, data, { lockedAt: e.lockedAt, reopenedUntil: e.reopenedUntil }, d.now());
  if (!decision.allowed) {
    await d.store.log({ accountId: ctx.account.id, event: "answer_edit_refused", surveyId: e.surveyId, customerId: e.customerId, detail: { questionId: body.questionId, code: decision.code } });
    throw new PortalError(403, decision.code, inWords(decision.reason, lookOf(f.live).words));
  }
  if (!Number.isInteger(body.revision)) throw new PortalError(400, "revision_required", "Please reload the page and try again.");
  if (JSON.stringify(body.value ?? null).length > 20_000) throw new PortalError(413, "too_large", "That answer is too long.");

  const before = data.answers[body.questionId];
  const answers = { ...data.answers };
  if (isEmpty(body.value)) delete answers[body.questionId]; else answers[body.questionId] = body.value;
  if (JSON.stringify(before ?? null) === JSON.stringify(answers[body.questionId] ?? null)) return { revision: data.revision, changed: false };

  /* replayed before and after: only a problem the CHANGE introduces refuses it (a row that already carried a
     warning from its own submission stays editable) */
  const replay = (a: Record<string, unknown>) => checkSubmission({
    def,
    prior: { seed: data.seed, sessionId: data.sessionId, startedAt: data.startedAt },
    posted: { answers: a, calculated: data.calculated, embedded: data.embedded, flags: data.flags, stepIndex: data.stepIndex, status: "complete", completed: true },
    recompute: true,
  });
  const keyOf = (p: { code?: string; questionId?: string; message: string }) => `${p.code ?? ""}|${p.questionId ?? ""}|${p.message}`;
  const already = new Set(replay(data.answers).hard.map(keyOf));
  const check = replay(answers);
  /* a derived value that now differs is expected — the server's recomputed value is what gets stored below */
  const introduced = check.hard.filter((p) => p.code !== "server_mismatch" && !already.has(keyOf(p)));
  const problem = introduced.find((p) => p.questionId === body.questionId) ?? introduced[0];
  if (problem) {
    const about = problem.questionId === body.questionId;
    throw new PortalError(422, "invalid_answer", about ? problem.message : "This change would affect other parts of your assessment, so it cannot be made here. Please contact the organiser.", { questionId: problem.questionId ?? null });
  }
  const calculated = check.recomputed?.calculated && Object.keys(check.recomputed.calculated).length ? { ...data.calculated, ...check.recomputed.calculated } : null;
  const w = await d.store.writeEdit(e, {
    responseId: data.id, expectedRevision: body.revision as number, answers, calculated,
    changes: { [body.questionId]: { from: before ?? null, to: answers[body.questionId] ?? null } }, by: `respondent:${ctx.account.respondentId}`,
  });
  if (!w.ok) {
    if (w.conflict) throw new PortalError(409, "revision_conflict", "Your answers changed in another window. Reload the page to see the latest, then try again.");
    throw new PortalError(503, "not_saved", "Your change could not be saved. Please try again.");
  }
  /* the stored scores follow the answers (the comparison reads them); never fails the edit */
  try {
    const scored = scoreInterview(pd, { answers, calculated: calculated ?? data.calculated, embedded: data.embedded });
    if (scored) await d.store.saveScorecard(e, { responseId: data.id, ...scored, completedAt: data.completedAt });
  } catch (err) {
    console.warn("[rescript:portal] scores not updated after an edit", JSON.stringify({ surveyId: e.surveyId, error: (err as Error).message }));
  }
  await d.store.log({ accountId: ctx.account.id, event: "answer_edited", surveyId: e.surveyId, customerId: e.customerId, detail: { questionId: body.questionId, revision: w.revision, reopened: decision.reopened } });
  return { revision: w.revision, changed: true };
}
