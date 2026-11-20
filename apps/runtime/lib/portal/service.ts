import {
  PORTAL_POLICY, accountVerdict, enrolmentAccess, failuresAfterWrong, hashPassword, hashToken, lockoutVerdict, mintToken, normaliseLogin,
  passwordProblems, sessionVerdict, verifyPassword, TOKEN, type EnrolmentAccess, type PortalPolicy,
} from "@rescript/access/respondent";
import { buildBenchmark, compare, onePerPerson, type BenchmarkSnapshot, type Comparison } from "@rescript/analytics/benchmark";
import { checkSubmission, editDecision, editWindow, isAssessment, portalAnswerLines, portalDefinition, portalSettings, respondentScorecard, scorecardOf, type PortalAnswerLine, type ScorecardResult } from "@rescript/engine";
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

export interface PortalDeps { store: PortalStore; now: () => number; policy?: PortalPolicy }
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
  return { attempts, live, access };
}

export interface AssessmentCard {
  id: string; title: string; state: EnrolmentAccess["state"]; canStart: boolean; canResume: boolean; attemptsLeft: number | null;
  reason: string | null; opensAt: string | null; closesAt: string | null; attempts: number; lastCompletedAt: string | null; canViewAnswers: boolean; canViewScores: boolean;
}

function card(e: EnrolmentRec, f: Awaited<ReturnType<typeof facts>>): AssessmentCard {
  const done = f.attempts.filter((a) => a.status === "complete" && a.completedAt).map((a) => a.completedAt!).sort();
  const portal = f.live ? portalSettings(f.live) : null;
  return {
    id: e.id, title: e.title, state: f.access.state, canStart: f.access.canStart, canResume: f.access.canResume, attemptsLeft: f.access.attemptsLeft,
    reason: f.access.reason, opensAt: e.accessFrom, closesAt: e.accessUntil, attempts: f.attempts.filter((a) => FINISHED.has(a.status)).length,
    lastCompletedAt: done.at(-1) ?? null, canViewAnswers: !!portal?.show.answers && done.length > 0,
    canViewScores: !!portal?.show.scores && !!f.live && !!scorecardOf(f.live) && done.length > 0,
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
    if ((may || mayScore) && a.versionId) {
      const data = await d.store.attempt(e, a.id);
      const def = await d.store.definition(e, a.versionId);
      if (data && def) {
        const pd = policyDef(def, f.live);
        if (may) {
          const enrol = { lockedAt: e.lockedAt, reopenedUntil: e.reopenedUntil };
          /* only the latest completed attempt can be changed: an earlier one is history */
          const window = a.id === latestComplete?.id ? editWindow(pd, a, enrol, now) : { allowed: false as const, code: "not_completed" as const, reason: "An earlier attempt cannot be changed." };
          answers = portalAnswerLines(pd, data.answers, a, enrol, now).map((l) => (window.allowed ? l : { ...l, edit: window }));
          editable = window.allowed && answers.some((l) => l.edit.allowed);
          editableUntil = window.allowed ? window.until : null;
          editNote = window.allowed ? null : window.code === "editing_off" || window.code === "no_portal" ? null : window.reason;
        }
        if (mayScore) {
          /* a person's own scores are always worked out from their answers, never read from a stored row */
          const scored = scoreInterview(pd, data);
          scores = scored ? respondentScorecard(pd, scored.result) : null;
          if (scored && scores && a.id === latestComplete?.id && portal!.show.comparison && portal!.benchmark.enabled) comparison = comparisonView(pd, scored, await benchmarkFor(d, e, pd, scored.key));
        }
      }
    }
    views.push({ id: a.id, status: a.status, startedAt: a.startedAt, completedAt: a.completedAt, revision: a.revision, answers, editableUntil, editable, editNote, scores, comparison });
  }
  await d.store.log({ accountId: ctx.account.id, event: "assessment_viewed", surveyId: e.surveyId, customerId: e.customerId });
  return { assessment: { ...card(e, f), scoredTest: !!f.live && isAssessment(f.live) }, attempts: views };
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
    generatedAt: new Date(d.now()).toISOString(), scoredTest: detail.assessment.scoredTest, scores: a.scores, comparison: a.comparison,
    answers: a.answers?.length ? a.answers.map((l) => ({ code: l.code, text: l.text, answer: l.answer })) : null,
  };
}

/** where to send the browser to take (or continue) the assessment */
export async function startLink(d: PortalDeps, ctx: PortalContext, enrolmentId: unknown): Promise<{ url: string; resumed: boolean }> {
  const e = await own(d, ctx, enrolmentId);
  const f = await facts(d, e);
  if (!f.access.canStart && !f.access.canResume) throw new PortalError(409, `assessment_${f.access.state}`, f.access.reason ?? "This assessment cannot be taken at the moment.");
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
    throw new PortalError(403, decision.code, decision.reason);
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
