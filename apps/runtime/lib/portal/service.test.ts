import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { hashPassword, hashToken, mintToken } from "@rescript/access/respondent";
import { memoryPortal, type MemoryPortal } from "./memoryStore.ts";
import {
  PortalError, acceptInvitation, assessmentDetail, authenticate, changePassword, confirmReset, editAnswer, endSession, invitationInfo,
  listSessions, overview, requestReset, signIn, signOut, startLink, updateProfile, type PortalDeps,
} from "./service.ts";
import type { AccountRec, AttemptData, EnrolmentRec } from "./types.ts";

/* THE RESPONDENT LIFECYCLE, END TO END, AGAINST MEMORY (phase 1 acceptance — brief §20). */

const T0 = Date.parse("2026-11-20T09:00:00Z");
const PASSWORD = "correct horse battery";

const survey = (portal: Record<string, unknown> | null, access: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Wellbeing check", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "How was your week?", options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }], required: true },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Anything to add?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { access: { mode: "unique_links", ...access } },
  ...(portal ? { portal } : {}),
});

interface Rig { m: MemoryPortal; d: PortalDeps; clock: { now: number }; ana: AccountRec; ben: AccountRec }

async function rig(): Promise<Rig> {
  const m = memoryPortal();
  const clock = { now: T0 };
  const d: PortalDeps = { store: m.store, now: () => clock.now };
  const account = (id: string, rid: string, email: string | null, over: Partial<AccountRec> = {}): AccountRec => ({ id, respondentId: rid, email, name: null, scope: "persistent", status: "active", expiresAt: null, lastLoginAt: null, ...over });
  const ana = account("a1", "RSP-ANA00001", "ana@example.org");
  const ben = account("a2", "RSP-BEN00002", "ben@example.org");
  m.accounts.push(ana, ben);
  const hash = await hashPassword(PASSWORD);
  for (const a of [ana, ben]) m.credentials.set(a.id, { accountId: a.id, passwordHash: hash, mustChange: false, failedAttempts: 0, lastFailedAt: null, inviteTokenHash: null, inviteExpiresAt: null, resetTokenHash: null, resetExpiresAt: null });
  return { m, d, clock, ana, ben };
}

const enrol = (r: Rig, id: string, accountId: string, over: Partial<EnrolmentRec> = {}): EnrolmentRec => {
  const e: EnrolmentRec = { id, accountId, surveyId: `survey-${id}`, customerId: "cust-1", title: `Assessment ${id}`, surveyStatus: "live", token: `tok-${id}`, accessFrom: null, accessUntil: null, maxAttempts: null, suspended: false, lockedAt: null, reopenedUntil: null, link: { clientSlug: "acme", studySlug: id, versionId: "v1" }, ...over };
  r.m.enrolments.push(e);
  return e;
};
const attempt = (r: Rig, e: EnrolmentRec, id: string, over: Partial<AttemptData> = {}): AttemptData => {
  const a: AttemptData = { id, sessionId: `sess${id}0000000000000000`, status: "complete", startedAt: new Date(T0 - 3_600_000).toISOString(), completedAt: new Date(T0 - 1_800_000).toISOString(), revision: 0, versionId: "v1", answers: { q1: 1, q2: "fine" }, calculated: {}, embedded: {}, flags: [], stepIndex: 1, seed: 7, ...over };
  r.m.attempts.set(e.id, [...(r.m.attempts.get(e.id) ?? []), a]);
  return a;
};
const fails = async (p: Promise<unknown>, status: number, code?: string) => {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof PortalError, String(e)); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); return true; });
};
const signedIn = async (r: Rig, who: AccountRec) => { const s = await signIn(r.d, { login: who.respondentId, password: PASSWORD }); return authenticate(r.d, s.sessionToken); };

test("invitation: the link shows only the id, sets a password once, signs in, and is then dead; an expired link is refused", async () => {
  const r = await rig();
  const token = mintToken();
  r.m.accounts.push({ id: "a3", respondentId: "RSP-NEW00003", email: null, name: "Cara", scope: "assessment", status: "invited", expiresAt: null, lastLoginAt: null });
  r.m.credentials.set("a3", { accountId: "a3", passwordHash: null, mustChange: false, failedAttempts: 0, lastFailedAt: null, inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(T0 + 86_400_000).toISOString(), resetTokenHash: null, resetExpiresAt: null });

  const info = await invitationInfo(r.d, token);
  assert.deepEqual([info.respondentId, info.name], ["RSP-NEW00003", "Cara"]);
  assert.deepEqual(Object.keys(info).sort(), ["name", "notice", "respondentId"], "the id, the name and the notice to agree to — nothing else");
  await fails(signIn(r.d, { login: "RSP-NEW00003", password: "anything-at-all" }), 401, "no_match");
  await fails(acceptInvitation(r.d, { token, password: "short" , consent: true }), 400, "weak_password");
  const s = await acceptInvitation(r.d, { token, password: "a long new password" , consent: true });
  assert.equal((await authenticate(r.d, s.sessionToken)).account.respondentId, "RSP-NEW00003");
  assert.equal(r.m.accounts.find((a) => a.id === "a3")!.status, "active");
  assert.ok(!JSON.stringify([...r.m.credentials.values()]).includes("a long new password"), "the password is never stored readable");
  await fails(acceptInvitation(r.d, { token, password: "another long password" , consent: true }), 410, "link_invalid");
  await fails(invitationInfo(r.d, mintToken()), 410);

  const late = mintToken();
  r.m.credentials.get("a3")!.inviteTokenHash = hashToken(late); r.m.credentials.get("a3")!.inviteExpiresAt = new Date(T0 - 1).toISOString();
  await fails(invitationInfo(r.d, late), 410, "link_invalid");
});

test("sign-in: by id or email; an unknown login and a wrong password get the same answer; five wrong passwords pause the account", async () => {
  const r = await rig();
  assert.equal((await signIn(r.d, { login: "rsp-ana00001", password: PASSWORD })).account.respondentId, "RSP-ANA00001");
  assert.equal((await signIn(r.d, { login: " ANA@example.org", password: PASSWORD })).account.respondentId, "RSP-ANA00001");
  const caught = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal"); }, (e) => e as PortalError);
  const wrong = await caught(signIn(r.d, { login: "ana@example.org", password: "nope" }));
  const unknown = await caught(signIn(r.d, { login: "nobody@example.org", password: "nope" }));
  assert.equal(wrong.message, unknown.message); assert.equal(wrong.status, unknown.status);

  for (let i = 0; i < 4; i++) await fails(signIn(r.d, { login: "ana@example.org", password: "nope" }), 401);
  await fails(signIn(r.d, { login: "ana@example.org", password: PASSWORD }), 429, "locked");
  r.clock.now += 16 * 60_000;
  assert.ok((await signIn(r.d, { login: "ana@example.org", password: PASSWORD })).sessionToken, "the pause runs out");
  assert.equal(r.m.credentials.get("a1")!.failedAttempts, 0);
  assert.ok(r.m.events.some((e) => e.event === "sign_in_failed" && e.accountId === "a1"));
});

test("a suspended or expired account cannot sign in — and says so only to someone who knows the password", async () => {
  const r = await rig();
  r.ana.status = "suspended";
  await fails(signIn(r.d, { login: r.ana.respondentId, password: "nope" }), 401, "no_match");
  await fails(signIn(r.d, { login: r.ana.respondentId, password: PASSWORD }), 403, "account_suspended");
  r.ben.expiresAt = new Date(T0 - 1).toISOString();
  await fails(signIn(r.d, { login: r.ben.respondentId, password: PASSWORD }), 403, "account_expired");
});

test("sessions: idle for 30 minutes ends it; signing out ends it; suspending the account ends every session; a respondent can end another device", async () => {
  const r = await rig();
  const a = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD }, { device: "Phone" });
  const b = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD }, { device: "Laptop" });
  const ctx = await authenticate(r.d, a.sessionToken);
  assert.deepEqual((await listSessions(r.d, ctx)).map((s) => [s.device, s.current]), [["Phone", true], ["Laptop", false]]);
  await endSession(r.d, ctx, b.session.id);
  await fails(authenticate(r.d, b.sessionToken), 401);
  await fails(endSession(r.d, ctx, "someone-elses"), 404);

  r.clock.now += 31 * 60_000;
  await fails(authenticate(r.d, a.sessionToken), 401, "session_idle");
  const c = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD });
  await signOut(r.d, await authenticate(r.d, c.sessionToken));
  await fails(authenticate(r.d, c.sessionToken), 401);
  const e = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD });
  r.ana.status = "suspended";
  await fails(authenticate(r.d, e.sessionToken), 401);
  await fails(authenticate(r.d, "not-a-token"), 401);
});

test("changing the password needs the current one, refuses a weak or unchanged one, and signs other devices out", async () => {
  const r = await rig();
  const a = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD });
  const b = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD });
  const ctx = await authenticate(r.d, a.sessionToken);
  await fails(changePassword(r.d, ctx, { current: "wrong", next: "a brand new password" }), 403, "wrong_password");
  await fails(changePassword(r.d, ctx, { current: PASSWORD, next: "short" }), 400, "weak_password");
  await fails(changePassword(r.d, ctx, { current: PASSWORD, next: PASSWORD }), 400, "same_password");
  await changePassword(r.d, ctx, { current: PASSWORD, next: "a brand new password" });
  assert.ok(await authenticate(r.d, a.sessionToken));
  await fails(authenticate(r.d, b.sessionToken), 401);
  await fails(signIn(r.d, { login: r.ana.respondentId, password: PASSWORD }), 401);
  assert.ok(await signIn(r.d, { login: r.ana.respondentId, password: "a brand new password" }));
});

test("password reset: nothing is revealed about unknown addresses; one link per two minutes; the link works once and ends every session", async () => {
  const r = await rig();
  assert.equal(await requestReset(r.d, "nobody@example.org"), null);
  const mail = (await requestReset(r.d, "ana@example.org"))!;
  assert.equal(mail.to, "ana@example.org"); assert.equal(mail.respondentId, "RSP-ANA00001");
  assert.equal(await requestReset(r.d, "ana@example.org"), null, "a second request straight away sends nothing");
  const live = await signIn(r.d, { login: r.ana.respondentId, password: PASSWORD });
  await fails(confirmReset(r.d, { token: mail.token, password: "short" }), 400, "weak_password");
  await confirmReset(r.d, { token: mail.token, password: "my new long password" });
  await fails(authenticate(r.d, live.sessionToken), 401);
  await fails(confirmReset(r.d, { token: mail.token, password: "yet another password" }), 410, "link_invalid");
  await fails(signIn(r.d, { login: r.ana.respondentId, password: PASSWORD }), 401);
  assert.ok(await signIn(r.d, { login: r.ana.respondentId, password: "my new long password" }));

  r.clock.now += 3 * 60_000;
  const second = (await requestReset(r.d, r.ana.respondentId))!;
  r.clock.now += 61 * 60_000;
  await fails(confirmReset(r.d, { token: second.token, password: "too late password" }), 410, "link_invalid");
  r.ben.status = "suspended";
  assert.equal(await requestReset(r.d, "ben@example.org"), null);
});

test("the dashboard lists only the respondent's own assessments; someone else's is 'not found' everywhere", async () => {
  const r = await rig();
  r.m.definitions.set("v1", survey({ enabled: true, show: { answers: true }, editing: { mode: "until_locked" } }));
  const mine = enrol(r, "e1", "a1"); const mine2 = enrol(r, "e2", "a1"); const theirs = enrol(r, "e3", "a2", { customerId: "cust-2" });
  attempt(r, mine2, "r2"); const theirAttempt = attempt(r, theirs, "r3");
  const ana = await signedIn(r, r.ana);
  const o = await overview(r.d, ana);
  assert.deepEqual(o.assessments.map((c) => [c.id, c.state]), [["e1", "open"], ["e2", "completed"]]);
  assert.ok(!JSON.stringify(o).includes("tok-"), "the personal link token is not in the dashboard");
  await fails(assessmentDetail(r.d, ana, theirs.id), 404, "not_found");
  await fails(startLink(r.d, ana, theirs.id), 404, "not_found");
  await fails(editAnswer(r.d, ana, { enrolmentId: theirs.id, responseId: theirAttempt.id, questionId: "q2", value: "x", revision: 0 }), 404, "not_found");
  await fails(editAnswer(r.d, ana, { enrolmentId: mine2.id, responseId: theirAttempt.id, questionId: "q2", value: "x", revision: 0 }), 404, "not_found");
  assert.equal(theirAttempt.answers.q2, "fine");
  void mine;
});

test("starting and resuming: a link with the token; an unfinished attempt resumes on any device; expired, suspended and used-up are refused", async () => {
  const r = await rig();
  r.m.definitions.set("v1", survey(null));
  const open = enrol(r, "e1", "a1");
  const running = enrol(r, "e2", "a1"); attempt(r, running, "r2", { status: "in_progress", completedAt: null });
  const expired = enrol(r, "e3", "a1", { accessUntil: new Date(T0 - 1).toISOString() });
  const paused = enrol(r, "e4", "a1", { suspended: true });
  const used = enrol(r, "e5", "a1"); attempt(r, used, "r5");
  const three = enrol(r, "e6", "a1", { maxAttempts: 3 }); attempt(r, three, "r6");
  const closed = enrol(r, "e7", "a1", { link: null });
  const ana = await signedIn(r, r.ana);

  assert.deepEqual(await startLink(r.d, ana, open.id), { url: "/s/acme/e1?token=tok-e1", resumed: false });
  const res = await startLink(r.d, ana, running.id);
  assert.equal(res.resumed, true); assert.match(res.url, /^\/s\/acme\/e2\?token=tok-e2&r=sessr20000000000000000$/);
  await fails(startLink(r.d, ana, expired.id), 409, "assessment_closed");
  await fails(startLink(r.d, ana, paused.id), 409, "assessment_suspended");
  await fails(startLink(r.d, ana, used.id), 409, "assessment_completed");
  assert.equal((await startLink(r.d, ana, three.id)).resumed, false, "two attempts left of three");
  await fails(startLink(r.d, ana, closed.id), 409);
  const cards = Object.fromEntries((await overview(r.d, ana)).assessments.map((c) => [c.id, c]));
  assert.equal(cards.e6!.attemptsLeft, 2); assert.equal(cards.e2!.canResume, true); assert.equal(cards.e3!.state, "closed");
  assert.ok(r.m.events.some((e) => e.event === "assessment_resumed" && e.surveyId === "survey-e2"));
});

test("answers are shown only when the researcher allows it; earlier attempts only with history on", async () => {
  const r = await rig();
  const e = enrol(r, "e1", "a1");
  attempt(r, e, "old", { completedAt: new Date(T0 - 86_400_000).toISOString(), startedAt: new Date(T0 - 90_000_000).toISOString(), answers: { q1: 2 } });
  attempt(r, e, "new");
  const ana = await signedIn(r, r.ana);
  r.m.definitions.set("v1", survey({ enabled: true }));
  assert.deepEqual((await assessmentDetail(r.d, ana, e.id)).attempts.map((a) => a.answers), [null, null]);
  r.m.definitions.set("v1", survey({ enabled: true, show: { answers: true } }));
  const d1 = await assessmentDetail(r.d, ana, e.id);
  assert.deepEqual(d1.attempts.map((a) => [a.id, a.answers?.map((l) => l.answer) ?? null, a.editable]), [["new", ["Good", "fine"], false], ["old", null, false]]);
  r.m.definitions.set("v1", survey({ enabled: true, show: { answers: true, history: true }, editing: { mode: "until_locked" } }));
  const d2 = await assessmentDetail(r.d, ana, e.id);
  assert.deepEqual(d2.attempts.map((a) => [a.id, a.answers?.map((l) => l.answer) ?? null, a.editable]), [["new", ["Good", "fine"], true], ["old", ["Bad"], false]]);
});

test("editing: allowed answers change with history; locked ones do not; a researcher can lock and reopen; two windows cannot overwrite each other", async () => {
  const r = await rig();
  r.m.definitions.set("v1", survey({ enabled: true, show: { answers: true }, editing: { mode: "until_locked", lockedQuestions: ["q1"] } }));
  const e = enrol(r, "e1", "a1"); const a = attempt(r, e, "r1");
  const ana = await signedIn(r, r.ana);
  const edit = (questionId: string, value: unknown, revision: number) => editAnswer(r.d, ana, { enrolmentId: e.id, responseId: a.id, questionId, value, revision });

  assert.deepEqual(await edit("q2", "much better now", 0), { revision: 1, changed: true });
  assert.equal(r.m.attempts.get("e1")![0]!.answers.q2, "much better now");
  assert.deepEqual(r.m.edits, [{ responseId: "r1", changes: { q2: { from: "fine", to: "much better now" } }, by: "respondent:RSP-ANA00001" }]);
  assert.deepEqual(await edit("q2", "much better now", 1), { revision: 1, changed: false }, "the same answer is not a change");
  await fails(edit("q2", "from a stale window", 0), 409, "revision_conflict");
  await fails(edit("q1", 2, 1), 403, "question_locked");
  await fails(edit("q2", "x".repeat(30_000), 1), 413);

  r.m.enrolments[0]!.lockedAt = new Date(T0).toISOString();
  await fails(edit("q2", "after the lock", 1), 403, "locked_by_researcher");
  r.m.enrolments[0]!.reopenedUntil = new Date(T0 + 3_600_000).toISOString();
  assert.equal((await edit("q2", "after reopening", 1)).revision, 2);
  r.clock.now += 2 * 3_600_000;
  await fails(edit("q2", "too late", 2), 403, "locked_by_researcher");
  assert.ok(r.m.events.some((ev) => ev.event === "answer_edit_refused" && ev.detail?.code === "question_locked"));
});

test("an edited answer must still be a valid answer to the question; a required answer cannot be emptied", async () => {
  const r = await rig();
  r.m.definitions.set("v1", survey({ enabled: true, show: { answers: true }, editing: { mode: "until_locked" } }));
  const e = enrol(r, "e1", "a1"); const a = attempt(r, e, "r1");
  const ana = await signedIn(r, r.ana);
  const edit = (questionId: string, value: unknown) => editAnswer(r.d, ana, { enrolmentId: e.id, responseId: a.id, questionId, value, revision: r.m.attempts.get("e1")![0]!.revision });
  await fails(edit("q1", 99), 422, "invalid_answer");
  await fails(edit("q1", ""), 422, "invalid_answer");
  assert.equal((await edit("q1", 2)).changed, true);
  assert.equal((await edit("q2", "")).changed, true, "an optional answer can be removed");
  assert.deepEqual(r.m.attempts.get("e1")![0]!.answers, { q1: 2 });
});

test("a scored test and an unfinished attempt are never editable; an earlier attempt is history", async () => {
  const r = await rig();
  const scored = SurveyDefinition.parse({ ...survey({ enabled: true, show: { answers: true, history: true }, editing: { mode: "until_locked" } }), assessment: { enabled: true } });
  r.m.definitions.set("v1", scored);
  const e = enrol(r, "e1", "a1"); const a = attempt(r, e, "r1");
  const ana = await signedIn(r, r.ana);
  await fails(editAnswer(r.d, ana, { enrolmentId: e.id, responseId: a.id, questionId: "q2", value: "x", revision: 0 }), 403, "scored_test");

  r.m.definitions.set("v1", survey({ enabled: true, show: { answers: true, history: true }, editing: { mode: "until_locked" } }));
  const old = attempt(r, e, "r0", { completedAt: new Date(T0 - 86_400_000).toISOString() });
  await fails(editAnswer(r.d, ana, { enrolmentId: e.id, responseId: old.id, questionId: "q2", value: "x", revision: 0 }), 409, "not_latest");
});

test("profile: the name can be corrected; an empty one is refused", async () => {
  const r = await rig();
  const ana = await signedIn(r, r.ana);
  assert.equal((await updateProfile(r.d, ana, { name: "  Ana   Silva " })).name, "Ana Silva");
  await fails(updateProfile(r.d, ana, { name: " " }), 400);
});

/* ------------------------------------------------------------------ phase 2: scores and comparisons */

const five = () => [1, 2, 3, 4, 5].map((n) => ({ code: n, label: `Point ${n}` }));
const indexDef = (portal: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Index", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "e1", code: "E1", variableName: "E1", type: "single_select", text: "Energy one", options: five() },
    { id: "e2", code: "E2", variableName: "E2", type: "single_select", text: "Energy two", options: five() },
    { id: "team", code: "TEAM", variableName: "TEAM", type: "single_select", text: "Team", options: [{ code: "n", label: "North" }, { code: "s", label: "South" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["e1", "e2", "team"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { access: { mode: "unique_links", allowRetake: true } },
  portal: {
    enabled: true,
    scorecard: { dimensions: [{ id: "energy", label: "Energy", source: { kind: "items", items: [{ question: "e1" }, { question: "e2" }] }, bands: [{ upTo: 5, label: "Low" }, { upTo: 10, label: "High" }] }] },
    benchmark: { enabled: true, groups: [{ id: "team", label: "Team", source: { kind: "question", ref: "TEAM" } }] },
    ...portal,
  },
});
const { scoreInterview } = await import("./scorecardRow.ts");
const peers = (r: Rig, e: EnrolmentRec, def: SurveyDefinition, n: number, team: string, from = 0) => {
  for (let i = 0; i < n; i++) {
    const sc = scoreInterview(def, { answers: { e1: 1 + (i % 5), e2: 1 + ((i * 2) % 5), team } })!;
    r.m.scorecards.set(e.surveyId, [...(r.m.scorecards.get(e.surveyId) ?? []), { responseId: `p${from + i}`, key: sc.key, person: `peer-${from + i}`, at: null, values: sc.scores, cohort: sc.cohort }]);
  }
};

test("scores are shown only with the permission; the band only when bands are on; never for an unfinished attempt", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = enrol(r, "e1", r.ana.id);
  attempt(r, e, "r1", { answers: { e1: 4, e2: 5, team: "n" } });
  r.m.definitions.set("v1", indexDef({}));
  let d = await assessmentDetail(r.d, ctx, "e1");
  assert.equal(d.attempts[0]!.scores, null); assert.equal(d.assessment.canViewScores, false); assert.equal(d.attempts[0]!.answers, null);

  r.m.definitions.set("v1", indexDef({ show: { scores: true } }));
  d = await assessmentDetail(r.d, ctx, "e1");
  assert.deepEqual([d.attempts[0]!.scores!.dimensions[0]!.score, d.attempts[0]!.scores!.dimensions[0]!.band?.label], [9, "High"]);
  assert.equal(d.attempts[0]!.comparison, null, "comparison needs its own permission");
  assert.equal(d.attempts[0]!.answers, null, "scores do not open the answers");
  assert.equal(d.assessment.canViewScores, true);

  r.m.definitions.set("v1", indexDef({ show: { scores: true, bands: false } }));
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.scores!.dimensions[0]!.band, null);

  r.m.attempts.get("e1")![0]!.status = "in_progress";
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.scores, null);
});

test("comparison: with everyone and the person's own group; nothing below ten people; the snapshot is kept and names nobody", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const def = indexDef({ show: { scores: true, comparison: true } });
  r.m.definitions.set("v1", def);
  const e = enrol(r, "e1", r.ana.id);
  attempt(r, e, "r1", { answers: { e1: 4, e2: 5, team: "n" } });

  peers(r, e, def, 8, "n");
  let c = (await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.comparison!;
  assert.equal(c[0]!.everyone, null); assert.match(c[0]!.note!, /at least 10 people/);

  peers(r, e, def, 4, "n", 8); peers(r, e, def, 11, "s", 12);
  r.clock.now += 16 * 60_000; // the kept snapshot has aged out
  c = (await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.comparison!;
  assert.equal(c[0]!.everyone!.n, 23);
  assert.deepEqual(c[0]!.groups.map((g) => [g.grouping, g.group, g.n]), [["Team", "North", 12]], "her own team, by its label — not South");
  assert.ok(c[0]!.everyone!.below > 50, "9 of 10 is above most");
  const kept = r.m.benchmarks.get(e.surveyId)!;
  assert.ok(!JSON.stringify(kept.snapshot).includes("peer-"), "the snapshot names no person");

  /* within fifteen minutes the kept snapshot is used: new scores do not change the figure yet */
  peers(r, e, def, 5, "n", 30);
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.comparison![0]!.everyone!.n, 23);

  /* the researcher switches comparison off: it is gone at once */
  r.m.definitions.set("v1", indexDef({ show: { scores: true, comparison: true }, benchmark: { enabled: false } }));
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.comparison, null);
});

test("a small group next to a large one: neither group is shown, so the few cannot be worked out by subtraction", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const def = indexDef({ show: { scores: true, comparison: true } });
  r.m.definitions.set("v1", def);
  const e = enrol(r, "e1", r.ana.id);
  attempt(r, e, "r1", { answers: { e1: 4, e2: 5, team: "n" } });
  peers(r, e, def, 20, "n"); peers(r, e, def, 3, "s", 20);
  const c = (await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.comparison!;
  assert.equal(c[0]!.everyone!.n, 23); assert.deepEqual(c[0]!.groups, []);
});

test("scores made with another scoring are not compared; a failing store means no comparison, never an error", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const def = indexDef({ show: { scores: true, comparison: true } });
  r.m.definitions.set("v1", def);
  const e = enrol(r, "e1", r.ana.id);
  attempt(r, e, "r1", { answers: { e1: 4, e2: 5, team: "n" } });
  peers(r, e, def, 15, "n");
  for (const row of r.m.scorecards.get(e.surveyId)!) row.key = "an-older-scoring";
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.comparison![0]!.everyone, null);
  r.m.store.scoreRows = async () => { throw new Error("relation portal_scorecards does not exist"); };
  r.m.store.benchmark = async () => { throw new Error("relation portal_benchmarks does not exist"); };
  const d = await assessmentDetail(r.d, ctx, "e1");
  assert.equal(d.attempts[0]!.scores!.dimensions[0]!.score, 9, "her own score is still shown");
  assert.match(d.attempts[0]!.comparison![0]!.note!, /not available/);
});

test("changing an answer updates the stored scores; an earlier attempt's scores need history on and are never compared", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const def = indexDef({ show: { scores: true, answers: true, comparison: true }, editing: { mode: "until_locked" } });
  r.m.definitions.set("v1", def);
  const e = enrol(r, "e1", r.ana.id);
  attempt(r, e, "r0", { answers: { e1: 1, e2: 1, team: "n" }, startedAt: new Date(T0 - 90_000_000).toISOString(), completedAt: new Date(T0 - 86_400_000).toISOString() });
  attempt(r, e, "r1", { answers: { e1: 4, e2: 5, team: "n" } });
  let d = await assessmentDetail(r.d, ctx, "e1");
  assert.deepEqual(d.attempts.map((a) => a.scores?.dimensions[0]!.score ?? null), [9, null]);

  await editAnswer(r.d, ctx, { enrolmentId: "e1", responseId: "r1", questionId: "e1", value: 2, revision: 0 });
  const stored = r.m.scorecards.get(e.surveyId)!.find((x) => x.responseId === "r1")!;
  assert.deepEqual([stored.values.energy, stored.cohort.team, stored.person], [7, "North", "e1"]);

  r.m.definitions.set("v1", indexDef({ show: { scores: true, history: true, comparison: true } }));
  d = await assessmentDetail(r.d, ctx, "e1");
  assert.deepEqual(d.attempts.map((a) => a.scores?.dimensions[0]!.score ?? null), [7, 2]);
  assert.equal(d.attempts[1]!.comparison, null);
});

test("nobody reads another person's scores: someone else's assessment is 'not found'", async () => {
  const r = await rig();
  const ben = await signedIn(r, r.ben);
  r.m.definitions.set("v1", indexDef({ show: { scores: true, comparison: true } }));
  const e = enrol(r, "e1", r.ana.id);
  attempt(r, e, "r1", { answers: { e1: 4, e2: 5, team: "n" } });
  await fails(assessmentDetail(r.d, ben, "e1"), 404, "not_found");
});

/* ------------------------------------------------------------------ phase 3: results over time */

const { progress, personalReport, HISTORY_ATTEMPTS } = await import("./service.ts");
const at = (days: number) => new Date(T0 - days * 86_400_000).toISOString();
const trendDef = (portal: Record<string, unknown> = {}) => indexDef({ show: { scores: true, trends: true }, ...portal });
/** an enrolment on its own version of the definition */
const wave = (r: Rig, id: string, accountId: string, def: SurveyDefinition, over: Partial<EnrolmentRec> = {}) => {
  r.m.definitions.set(`v-${id}`, def);
  return enrol(r, id, accountId, { link: { clientSlug: "c", studySlug: id, versionId: `v-${id}` }, ...over });
};
const took = (r: Rig, e: EnrolmentRec, id: string, daysAgo: number, e1: number, e2: number, over: Partial<AttemptData> = {}) =>
  attempt(r, e, id, { versionId: e.link!.versionId, answers: { e1, e2, team: "n" }, startedAt: at(daysAgo + 0.01), completedAt: at(daysAgo), ...over });

test("progress needs both permissions — scores and their history; without them there is no track and no hint of one", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, indexDef({ show: { scores: true } }));
  took(r, e, "r1", 60, 1, 2); took(r, e, "r2", 5, 4, 5);
  assert.deepEqual((await progress(r.d, ctx)).tracks, []);
  assert.equal((await overview(r.d, ctx)).assessments[0]!.canViewTrends, false);
  r.m.definitions.set("v-e1", indexDef({ show: { trends: true } }));
  assert.deepEqual((await progress(r.d, ctx)).tracks, [], "history without scores shows nothing");
  r.m.definitions.set("v-e1", trendDef());
  assert.equal((await overview(r.d, ctx)).assessments[0]!.canViewTrends, true);
  assert.equal((await progress(r.d, ctx)).tracks.length, 1);
});

test("one assessment taken again: a track of its own, oldest first, with the change; unfinished attempts are not results", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, trendDef());
  took(r, e, "r2", 30, 3, 4); took(r, e, "r1", 90, 1, 2); took(r, e, "r3", 2, 4, 5);
  took(r, e, "r4", 1, 5, 5, { status: "in_progress", completedAt: null });
  const { tracks } = await progress(r.d, ctx);
  assert.equal(tracks.length, 1);
  const [t] = tracks;
  assert.deepEqual([t!.title, t!.series, t!.results], ["Assessment e1", false, 3]);
  const energy = t!.trends.find((x) => x.id === "energy")!;
  assert.deepEqual(energy.points.map((p) => [p.score, p.band, p.comparable]), [[3, "Low", true], [7, "High", true], [9, "High", true]]);
  assert.equal(energy.change!.text, "Up 2 (from 7 to 9)"); assert.equal(energy.sinceFirst!.text, "Up 6 (from 3 to 9)");
  assert.equal(r.m.events.at(-1)!.event, "progress_viewed");
});

test("a series joins the assessments of ONE workspace; the same series id in another workspace is another track", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const series = (period: string) => ({ series: { id: "wellbeing", label: "Wellbeing check", period } });
  const y1 = wave(r, "y25", r.ana.id, trendDef(series("2025")), { title: "Wellbeing 2025" });
  const y2 = wave(r, "y26", r.ana.id, trendDef(series("2026")), { title: "Wellbeing 2026" });
  const other = wave(r, "x26", r.ana.id, trendDef(series("2026")), { title: "Somebody else's wellbeing", customerId: "cust-2" });
  took(r, y1, "a", 370, 2, 2); took(r, y2, "b", 3, 4, 5); took(r, other, "c", 10, 1, 1);
  const { tracks } = await progress(r.d, ctx);
  assert.equal(tracks.length, 2);
  const mine = tracks.find((t) => t.assessments.length === 2)!;
  assert.deepEqual([mine.title, mine.series], ["Wellbeing check", true]);
  assert.deepEqual(mine.assessments.map((a) => [a.title, a.period]), [["Wellbeing 2025", "2025"], ["Wellbeing 2026", "2026"]]);
  const energy = mine.trends.find((x) => x.id === "energy")!;
  assert.deepEqual(energy.points.map((p) => [p.wave, p.score]), [["2025", 4], ["2026", 9]]);
  assert.equal(energy.change!.text, "Up 5 (from 4 to 9)");
  assert.deepEqual(tracks.find((t) => t.assessments.length === 1)!.trends.find((x) => x.id === "energy")!.points.map((p) => p.score), [2], "the other workspace's result is not joined in");
});

test("a year's survey scored differently is shown apart and not compared", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const series = { series: { id: "w", label: "Wellbeing" } };
  const changed = SurveyDefinition.parse({ ...trendDef(series), portal: { ...trendDef(series).portal, scorecard: { dimensions: [{ id: "energy", label: "Energy", source: { kind: "items", items: [{ question: "e1" }] } }] } } });
  const y1 = wave(r, "y25", r.ana.id, changed), y2 = wave(r, "y26", r.ana.id, trendDef(series));
  took(r, y1, "a", 370, 2, 2); took(r, y2, "b", 3, 4, 5);
  const energy = (await progress(r.d, ctx)).tracks[0]!.trends.find((x) => x.id === "energy")!;
  assert.deepEqual(energy.points.map((p) => [p.score, p.comparable]), [[2, false], [9, true]]);
  assert.equal(energy.change, null); assert.match(energy.note!, /scored differently/);
});

test("the group's average: only with the comparison permitted and ten people, and only beside the latest result", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const def = trendDef({ show: { scores: true, trends: true, comparison: true } });
  const e = wave(r, "e1", r.ana.id, def);
  took(r, e, "r1", 40, 1, 2); took(r, e, "r2", 2, 4, 5);
  const energyOf = async () => (await progress(r.d, ctx)).tracks[0]!.trends.find((x) => x.id === "energy")!;
  assert.deepEqual((await energyOf()).points.map((p) => p.groupMean), [null, null], "nobody to compare with yet");
  peers(r, e, def, 12, "n"); r.clock.now += 16 * 60_000;
  const pts = (await energyOf()).points;
  assert.equal(pts[0]!.groupMean, null); assert.ok(typeof pts[1]!.groupMean === "number"); assert.equal(pts[1]!.groupN, 12);
  r.m.definitions.set("v-e1", trendDef());
  assert.deepEqual((await energyOf()).points.map((p) => p.groupMean), [null, null], "comparison switched off");
});

test("range names follow their own switch; a repeated assessment says when it is next due, unless it is paused", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, trendDef({ show: { scores: true, trends: true, bands: false }, series: { id: "m", label: "Monthly check", repeatEveryDays: 30 } }));
  took(r, e, "r1", 10, 4, 5);
  let [t] = (await progress(r.d, ctx)).tracks;
  assert.equal(t!.trends[0]!.points[0]!.band, null);
  assert.deepEqual(t!.nextDue, { at: at(-20), overdue: false, assessmentId: "e1" });
  assert.deepEqual((await overview(r.d, ctx)).assessments[0]!.nextDue, { at: at(-20), overdue: false });
  r.clock.now += 25 * 86_400_000;
  assert.equal((await progress(r.d, await signedIn(r, r.ana))).tracks[0]!.nextDue!.overdue, true);
  r.m.enrolments[0]!.suspended = true;
  [t] = (await progress(r.d, await signedIn(r, r.ana))).tracks;
  assert.equal(t!.nextDue, null);
});

test("nobody's progress but one's own; and a very long history reads the most recent results only", async () => {
  const r = await rig();
  const e = wave(r, "e1", r.ana.id, trendDef());
  for (let i = 0; i < HISTORY_ATTEMPTS + 6; i++) took(r, e, `r${i}`, 200 - i, 1 + (i % 5), 3);
  assert.deepEqual((await progress(r.d, await signedIn(r, r.ben))).tracks, []);
  const [t] = (await progress(r.d, await signedIn(r, r.ana))).tracks;
  assert.equal(t!.results, HISTORY_ATTEMPTS);
  assert.equal(t!.trends[0]!.points.at(-1)!.responseId, `r${HISTORY_ATTEMPTS + 5}`, "the newest is kept");
});

/* ------------------------------------------------------------------ phase 4: templates */

const { inWords } = await import("./service.ts");

test("a template gives an assessment its words, note and colour; without one it is the standard portal", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const plain = wave(r, "plain", r.ana.id, indexDef({ show: { scores: true } }));
  const care = wave(r, "care", r.ana.id, indexDef({ template: "patient_outcomes", show: { scores: true } }), { suspended: true });
  took(r, plain, "r1", 3, 4, 5); took(r, care, "r2", 3, 4, 5);
  const cards = (await overview(r.d, ctx)).assessments;
  const a = cards.find((c) => c.id === "plain")!, b = cards.find((c) => c.id === "care")!;
  assert.deepEqual([a.look.template, a.look.words.one, a.look.words.start, a.look.accent], [null, "assessment", "Start", "#1f4fd8"]);
  assert.deepEqual([b.look.template, b.look.words.one, b.look.words.results, b.look.accent], ["patient_outcomes", "questionnaire", "My scores", "#0f766e"]);
  assert.equal(b.reason, "Your access to this questionnaire has been paused. Please contact your care team.", "the engine's reason, in the template's words");
  assert.equal(a.reason, null);
  assert.match((await assessmentDetail(r.d, ctx, "plain")).assessment.resultNote!, /not a diagnosis or professional advice/);
  assert.match((await assessmentDetail(r.d, ctx, "care")).assessment.resultNote!, /speak to a health professional/);
  const report = await personalReport(r.d, ctx, "care");
  assert.equal(report.resultsTitle, "My scores"); assert.match(report.note!, /health professional/);
});

test("a marked test has no note of its own; a template's note still shows", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const paper = (template?: string) => SurveyDefinition.parse({ ...indexDef({ show: { scores: true }, ...(template ? { template } : {}) }), assessment: { defaultMarks: 1 } });
  const t1 = wave(r, "t1", r.ana.id, paper()), t2 = wave(r, "t2", r.ana.id, paper("skills_assessment"));
  took(r, t1, "r1", 3, 4, 5); took(r, t2, "r2", 3, 4, 5);
  assert.equal((await assessmentDetail(r.d, ctx, "t1")).assessment.resultNote, null);
  assert.match((await assessmentDetail(r.d, ctx, "t2")).assessment.resultNote!, /guide for development/);
});

test("a template's fixed rules reach the respondent: a candidate assessment shows no answers and no comparison whatever was saved", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const def = indexDef({ template: "candidate_assessment", show: { answers: true, history: true, scores: true, comparison: true }, editing: { mode: "until_locked" } });
  const e = wave(r, "e1", r.ana.id, def);
  took(r, e, "r1", 3, 4, 5); peers(r, e, def, 15, "n");
  const d = await assessmentDetail(r.d, ctx, "e1");
  assert.equal(d.attempts[0]!.answers, null); assert.equal(d.attempts[0]!.comparison, null);
  assert.equal(d.attempts[0]!.scores!.dimensions[0]!.score, 9, "scores are the researcher's choice and stay");
  assert.equal(d.assessment.canViewAnswers, false);
  await fails(editAnswer(r.d, ctx, { enrolmentId: "e1", responseId: "r1", questionId: "e1", value: 2, revision: 0 }), 403, "editing_off");

  /* a health template lifts the group minimum to twenty: fifteen colleagues are not enough */
  const health = indexDef({ template: "wellbeing_checkin", show: { scores: true, comparison: true }, benchmark: { enabled: true, minCohort: 10, groups: [] } });
  const h = wave(r, "h1", r.ana.id, health);
  took(r, h, "r2", 3, 4, 5); peers(r, h, health, 15, "n");
  const c = (await assessmentDetail(r.d, ctx, "h1")).attempts[0]!.comparison!;
  assert.equal(c[0]!.everyone, null); assert.match(c[0]!.note!, /at least 20 people/);
});

test("re-wording touches only the two names, and only whole words", () => {
  const w = { one: "check-in", many: "check-ins", organiser: "your coach", results: "R", start: "S", again: "A" };
  assert.equal(inWords("The time to take this assessment has ended.", w), "The time to take this check-in has ended.");
  assert.equal(inWords("Your answers have been locked by the organiser.", w), "Your answers have been locked by your coach.");
  assert.equal(inWords("The organiser has paused the assessment.", w), "Your coach has paused the check-in.");
  assert.equal(inWords("Reassessment of the organisers", w), "Reassessment of the organisers");
  assert.equal(inWords(null, w), null);
});

/* ------------------------------------------------------------------ phase 5: insights, projection, the AI summary */

const { explainResults } = await import("./service.ts");
const twoScores = { dimensions: [{ id: "energy", label: "Energy", source: { kind: "items", items: [{ question: "e1" }] } }, { id: "drive", label: "Drive", source: { kind: "items", items: [{ question: "e2" }] } }] };
const insightDef = (portal: Record<string, unknown> = {}) => indexDef({ scorecard: twoScores, show: { scores: true, insights: true }, ...portal });
/* e1 → Energy, e2 → Drive */
const took2 = (r: Rig, e: EnrolmentRec, id: string, daysAgo: number, energy: number, drive: number) => took(r, e, id, daysAgo, energy, drive);

test("a few sentences about the results: only with the switch, only from what the person is shown", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, indexDef({ scorecard: twoScores, show: { scores: true } }));
  took2(r, e, "r1", 2, 5, 2);
  let d = await assessmentDetail(r.d, ctx, "e1");
  assert.equal(d.attempts[0]!.insights, null); assert.equal(d.assessment.canExplain, false);
  r.m.definitions.set("v-e1", insightDef());
  d = await assessmentDetail(r.d, ctx, "e1");
  assert.deepEqual(d.attempts[0]!.insights!.map((i) => i.text), ["Of your scores, Energy is the strongest (5 of 5).", "Of your scores, Drive has the most room to move (2 of 5)."]);
  assert.equal(d.assessment.canExplain, false, "re-wording needs its own switch");
  /* scores off: no sentences either */
  r.m.definitions.set("v-e1", indexDef({ scorecard: twoScores, show: { insights: true } }));
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts[0]!.insights, null);
});

test("the AI re-wording: opt-in; the provider is sent the sentences and the noun only; anything unusable falls back to the sentences", async () => {
  const r = await rig();
  r.ana.name = "Ana Silva";
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, insightDef());
  took2(r, e, "r1", 2, 5, 2);
  await fails(explainResults(r.d, ctx, "e1"), 403, "summary_off");

  r.m.definitions.set("v-e1", insightDef({ template: "employee_engagement", show: { scores: true, insights: true, aiSummary: true } }));
  const rules = "Of your scores, Energy is the strongest (5 of 5). Of your scores, Drive has the most room to move (2 of 5).";
  assert.deepEqual(await explainResults(r.d, ctx, "e1"), { text: rules, source: "rules" }, "no provider: the sentences themselves");

  const sent: unknown[] = [];
  const withAi = { ...r.d, summarise: async (req: unknown) => { sent.push(req); return "You scored strongest on Energy, at 5 of 5, while Drive, at 2 of 5, has the most room to move."; } };
  assert.deepEqual(await explainResults(withAi, ctx, "e1"), { text: "You scored strongest on Energy, at 5 of 5, while Drive, at 2 of 5, has the most room to move.", source: "ai" });
  assert.deepEqual(Object.keys(sent[0] as object).sort(), ["customerId", "noun", "sentences", "sessionId", "surveyId"]);
  assert.equal((sent[0] as { noun: string }).noun, "survey");
  const wire = JSON.stringify((sent[0] as { sentences: string[]; noun: string }).sentences);
  for (const secret of ["Ana", "RSP-ANA", "ana@example.org", "North", "tok-"]) assert.ok(!wire.includes(secret), `the sentences carry no ${secret}`);

  assert.equal((await explainResults({ ...r.d, summarise: async () => null }, ctx, "e1")).source, "rules", "a refused or discarded reply");
  assert.equal((await explainResults({ ...r.d, summarise: async () => { throw new Error("provider down"); } }, ctx, "e1")).source, "rules");
  assert.deepEqual(r.m.events.filter((x) => x.event === "results_summarised").map((x) => x.detail!.source), ["rules", "ai", "rules", "rules"]);
  await fails(explainResults(withAi, await signedIn(r, r.ben), "e1"), 404, "not_found");
});

test("a health template never sends anything to the AI provider and never projects, whatever is switched on", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, insightDef({ template: "wellbeing_checkin", show: { scores: true, trends: true, insights: true, projection: true, aiSummary: true } }));
  for (const [i, v] of [1, 2, 3, 4, 5].entries()) took2(r, e, `r${i}`, 50 - i * 10, v, 3);
  let called = 0;
  const withAi = { ...r.d, summarise: async () => { called++; return "x"; } };
  assert.equal((await assessmentDetail(withAi, ctx, "e1")).assessment.canExplain, false);
  await fails(explainResults(withAi, ctx, "e1"), 403, "summary_off");
  assert.equal(called, 0);
  const [t] = (await progress(r.d, ctx)).tracks;
  assert.deepEqual([t!.projections, t!.projectionNote], [[], null]);
  assert.ok(t!.insights.length > 0, "the rule-written sentences are still allowed");
});

test("progress in words: a pattern and the latest change; a projection only with its switch and four like results", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, insightDef({ show: { scores: true, trends: true, insights: true } }));
  for (const [i, v] of [1, 2, 3, 4].entries()) took2(r, e, `r${i}`, 40 - i * 10, v, 3);
  let [t] = (await progress(r.d, ctx)).tracks;
  assert.deepEqual(t!.insights.map((i) => [i.kind, i.dimension, i.text]), [
    ["sustained", "energy", "Energy has moved up in each of your last 4 results."],
    ["change", "energy", "Energy is up 1 since your previous result (from 3 to 4)."],
  ]);
  assert.deepEqual(t!.projections, [], "projection is its own switch");
  r.m.definitions.set("v-e1", insightDef({ show: { scores: true, trends: true, projection: true } }));
  [t] = (await progress(r.d, ctx)).tracks;
  assert.deepEqual(t!.insights, []);
  assert.deepEqual(t!.projections.map((p) => [p.dimension, p.ok, p.text]), [
    ["energy", true, "If the pattern of your last 4 results continued, your next Energy score would be about 5."],
    ["drive", true, "If the pattern of your last 4 results continued, your next Drive score would be about 3."],
  ]);
  assert.match(t!.projectionNote!, /not a prediction/);
});

/* ------------------------------------------------------------------ phase 5: consent and privacy requests */

const { giveConsent, withdrawConsent, myPrivacy, fileRequest } = await import("./service.ts");
const { PORTAL_CONSENT } = await import("@rescript/access/respondent");

test("an invitation is accepted only with the notice agreed to, and the agreement is recorded with its version", async () => {
  const r = await rig();
  const token = mintToken();
  const cara: AccountRec = { id: "a3", respondentId: "RSP-CARA0003", email: null, name: null, scope: "persistent", status: "invited", expiresAt: null, lastLoginAt: null };
  r.m.accounts.push(cara); r.m.consentAsked.add("a3");
  r.m.credentials.set("a3", { accountId: "a3", passwordHash: null, mustChange: false, failedAttempts: 0, lastFailedAt: null, inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(T0 + 86_400_000).toISOString(), resetTokenHash: null, resetExpiresAt: null });
  await fails(acceptInvitation(r.d, { token, password: "a long new password" }), 400, "consent_required");
  await fails(acceptInvitation(r.d, { token, password: "a long new password", consent: "yes" }), 400, "consent_required");
  assert.equal(r.m.credentials.get("a3")!.passwordHash, null, "nothing was set");
  const s = await acceptInvitation(r.d, { token, password: "a long new password", consent: true });
  assert.equal(r.m.consents.get("a3")!.version, PORTAL_CONSENT.version);
  const ctx = await authenticate(r.d, s.sessionToken);
  assert.equal((await overview(r.d, ctx)).consent.needed, false);
});

test("without the notice agreed to, the account works but its assessments are hidden everywhere; agreeing shows them; withdrawing hides them again", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, trendDef({ show: { scores: true, answers: true, trends: true } }));
  took(r, e, "r1", 3, 4, 5);
  r.m.consentAsked.add(r.ana.id);
  const o = await overview(r.d, ctx);
  assert.deepEqual([o.consent.needed, o.assessments.length, o.consent.version, o.consent.paragraphs.length > 2], [true, 0, PORTAL_CONSENT.version, true]);
  await fails(assessmentDetail(r.d, ctx, "e1"), 403, "consent_needed");
  await fails(startLink(r.d, ctx, "e1"), 403, "consent_needed");
  await fails(personalReport(r.d, ctx, "e1"), 403, "consent_needed");
  await fails(fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "access", message: "" }), 403, "consent_needed");
  assert.deepEqual((await progress(r.d, ctx)).tracks, []);
  assert.deepEqual((await myPrivacy(r.d, ctx)).assessments, []);
  /* the account itself still works: profile, password, sessions */
  assert.equal((await updateProfile(r.d, ctx, { name: "Ana" })).name, "Ana");

  await fails(giveConsent(r.d, ctx, { version: "an-older-notice" }), 409, "notice_changed");
  await giveConsent(r.d, ctx, { version: PORTAL_CONSENT.version });
  assert.equal((await overview(r.d, ctx)).assessments.length, 1);
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts.length, 1);
  const p = await myPrivacy(r.d, ctx);
  assert.deepEqual([p.consent.given, p.consent.available, p.assessments.length], [true, true, 1]);

  await withdrawConsent(r.d, ctx);
  assert.equal((await overview(r.d, ctx)).consent.needed, true);
  await fails(assessmentDetail(r.d, ctx, "e1"), 403, "consent_needed");
  assert.deepEqual(r.m.events.filter((x) => x.event.startsWith("consent_")).map((x) => x.event), ["consent_given", "consent_withdrawn"]);
});

test("a store that cannot tell (the tables are not there yet) changes nothing: the portal behaves as before consent existed", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const e = wave(r, "e1", r.ana.id, trendDef());
  took(r, e, "r1", 3, 4, 5);
  r.m.store.consent = async () => null;
  assert.equal((await overview(r.d, ctx)).assessments.length, 1);
  r.m.store.consent = async () => { throw new Error("relation portal_consents does not exist"); };
  r.m.store.requests = async () => { throw new Error("relation portal_requests does not exist"); };
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).attempts.length, 1);
  const p = await myPrivacy(r.d, ctx);
  assert.deepEqual([p.consent.available, p.requests, p.viewed], [false, [], []]);
});

test("privacy requests: to the organiser of one's own assessment, one open request of a kind, a limit, and the answer comes back", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  wave(r, "e1", r.ana.id, trendDef(), { title: "Wellbeing 2026" });
  wave(r, "b1", r.ben.id, trendDef());
  await fails(fileRequest(r.d, ctx, { enrolmentId: "b1", kind: "deletion", message: "" }), 404, "not_found");
  await fails(fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "everything", message: "" }), 400, "bad_request");
  await fails(fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "correction", message: "" }), 400, "bad_request");
  await fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "correction", message: "My year of birth is 1984." });
  await fails(fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "correction", message: "Again, please." }), 409, "already_asked");
  await fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "access", message: "" });
  assert.deepEqual(r.m.requests.map((x) => [x.accountId, x.surveyId, x.kind, x.status]), [["a1", "survey-e1", "correction", "open"], ["a1", "survey-e1", "access", "open"]]);
  /* the organiser answers (the Studio writes this) */
  Object.assign(r.m.requests[0]!, { status: "done", responseNote: "Corrected on 21 November.", resolvedAt: new Date(T0).toISOString() });
  const mine = (await myPrivacy(r.d, ctx)).requests;
  assert.deepEqual(mine.map((x) => [x.assessment, x.kind, x.status, x.answer]), [["Wellbeing 2026", "access", "open", null], ["Wellbeing 2026", "correction", "done", "Corrected on 21 November."]]);
  assert.deepEqual((await myPrivacy(r.d, await signedIn(r, r.ben))).requests, [], "nobody sees another person's requests");
  await fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "correction", message: "One more thing to correct." });
  for (let i = 0; i < 8; i++) r.m.requests.push({ ...r.m.requests[1]!, id: `x${i}`, enrolmentId: `other-${i}` });
  await fails(fileRequest(r.d, ctx, { enrolmentId: "e1", kind: "deletion", message: "" }), 429, "too_many_requests");
});

test("a person can see when an organiser's staff opened their results", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  wave(r, "e1", r.ana.id, trendDef(), { title: "Wellbeing 2026" });
  r.m.events.push({ accountId: r.ana.id, event: "results_viewed_by_staff", surveyId: "survey-e1", detail: { at: "2026-11-20T08:00:00.000Z" } }, { accountId: r.ben.id, event: "results_viewed_by_staff", surveyId: "survey-e1", detail: {} });
  assert.deepEqual((await myPrivacy(r.d, ctx)).viewed, [{ at: "2026-11-20T08:00:00.000Z", assessment: "Wellbeing 2026" }]);
});

/* ------------------------------------------------------------------ phase 6: achievements */

test("achievements: only with the switch; the survey's own points, level and badges, and the on-time streak", async () => {
  const r = await rig();
  const ctx = await signedIn(r, r.ana);
  const { badgeRule } = await import("@rescript/engine");
  const game = { points: { perAnswer: 10 }, levels: [{ name: "Starter", minPoints: 0 }, { name: "Regular", minPoints: 30 }], badges: [{ id: "first", title: "First steps", icon: "star", when: badgeRule("POINTS >= 10")! }] };
  const def = (show: Record<string, unknown>) => SurveyDefinition.parse({ ...trendDef({ show: { scores: true, ...show }, series: { id: "w", label: "Weekly", repeatEveryDays: 7 } }), gamification: game });
  const e = wave(r, "e1", r.ana.id, def({}));
  took(r, e, "r1", 10, 3, 3, { calculated: { POINTS: 20, LEVEL: 1, BADGES: "first" } });
  took(r, e, "r2", 3, 4, 4, { calculated: { POINTS: 30, LEVEL: 2, BADGES: "first" } });
  assert.equal((await assessmentDetail(r.d, ctx, "e1")).assessment.rewards, null);
  r.m.definitions.set("v-e1", def({ rewards: true }));
  const a = (await assessmentDetail(r.d, ctx, "e1")).assessment.rewards!;
  assert.deepEqual([a.points, a.level!.name, a.nextLevel, a.badges.map((b) => b.title), a.completions, a.streak], [30, "Regular", null, ["First steps"], 2, { current: 2, best: 2, every: 7 }]);
  await fails(assessmentDetail(r.d, await signedIn(r, r.ben), "e1"), 404, "not_found");
});
