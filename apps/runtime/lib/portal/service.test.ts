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

  assert.deepEqual(await invitationInfo(r.d, token), { respondentId: "RSP-NEW00003", name: "Cara" });
  await fails(signIn(r.d, { login: "RSP-NEW00003", password: "anything-at-all" }), 401, "no_match");
  await fails(acceptInvitation(r.d, { token, password: "short" }), 400, "weak_password");
  const s = await acceptInvitation(r.d, { token, password: "a long new password" });
  assert.equal((await authenticate(r.d, s.sessionToken)).account.respondentId, "RSP-NEW00003");
  assert.equal(r.m.accounts.find((a) => a.id === "a3")!.status, "active");
  assert.ok(!JSON.stringify([...r.m.credentials.values()]).includes("a long new password"), "the password is never stored readable");
  await fails(acceptInvitation(r.d, { token, password: "another long password" }), 410, "link_invalid");
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
