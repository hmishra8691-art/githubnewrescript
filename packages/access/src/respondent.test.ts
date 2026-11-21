import test from "node:test";
import assert from "node:assert/strict";
import {
  RESPONDENT_ID, TOKEN, PORTAL_POLICY, accountVerdict, enrolmentAccess, failuresAfterWrong, hashPassword, hashToken, lockoutVerdict,
  mintToken, newInitialPassword, newRespondentId, normaliseLogin, passwordNeedsRehash, passwordProblems, sessionVerdict, verifyPassword,
  type EnrolmentFacts,
} from "./respondent.js";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

test("respondent ids are unique, unambiguous and say nothing about the person; tokens are stored only as hashes", () => {
  const ids = new Set(Array.from({ length: 2000 }, () => newRespondentId()));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, RESPONDENT_ID);
  assert.ok(![...ids].some((id) => /[ILOU]/.test(id.slice(4))), "no letters that are misread");
  const t = mintToken();
  assert.match(t, TOKEN);
  assert.equal(hashToken(t).length, 64);
  assert.notEqual(hashToken(t), hashToken(mintToken()));
});

test("sign-in accepts the respondent id as people type it, or an email; anything else is refused", () => {
  assert.deepEqual(normaliseLogin(" rsp-7k2m 9qxa "), { kind: "respondent_id", value: "RSP-7K2M9QXA" });
  assert.deepEqual(normaliseLogin("RSP7K2M9QXA"), { kind: "respondent_id", value: "RSP-7K2M9QXA" });
  assert.deepEqual(normaliseLogin("rsp-7k2m9qxo"), { kind: "respondent_id", value: "RSP-7K2M9QX0" }, "a typed O is the digit 0");
  assert.deepEqual(normaliseLogin("  Ana.Silva@Example.org "), { kind: "email", value: "ana.silva@example.org" });
  for (const bad of ["", "ana", "rsp-123", "a@b", null, "x".repeat(300) + "@a.co"]) assert.equal(normaliseLogin(bad), null, String(bad));
});

test("passwords: length over symbols; hashed with scrypt; a wrong one and a missing hash both fail", async () => {
  assert.deepEqual(passwordProblems("correct horse battery"), []);
  assert.match(passwordProblems("short")[0]!, /at least 10/);
  assert.ok(passwordProblems("aaaaaaaaaaaa").length >= 1);
  assert.ok(passwordProblems("1234567890").some((p) => /easy to guess/.test(p)));
  assert.ok(passwordProblems("anasilva-2026!", { email: "anasilva@example.org" }).some((p) => /email/.test(p)));
  assert.ok(passwordProblems("my7k2m9qxa-pass", { respondentId: "RSP-7K2M9QXA" }).some((p) => /Respondent ID/.test(p)));

  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$16384\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!h.includes("correct"));
  assert.notEqual(h, await hashPassword("correct horse battery"), "salted");
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("anything", null), false);
  assert.equal(await verifyPassword("anything", "plain-text"), false);
  assert.equal(passwordNeedsRehash(h), false);
  assert.match(newInitialPassword(), /^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
  assert.deepEqual(passwordProblems(newInitialPassword()), []);
});

test("five wrong passwords pause the account for 15 minutes; afterwards the count starts again", () => {
  assert.equal(lockoutVerdict({ failedAttempts: 4, lastFailedAt: ago(1) }, NOW).locked, false);
  const locked = lockoutVerdict({ failedAttempts: 5, lastFailedAt: ago(1) }, NOW);
  assert.equal(locked.locked, true);
  assert.equal(locked.until, new Date(NOW + 14 * 60_000).toISOString());
  assert.equal(lockoutVerdict({ failedAttempts: 5, lastFailedAt: ago(16) }, NOW).locked, false);
  assert.equal(failuresAfterWrong({ failedAttempts: 2, lastFailedAt: ago(1) }, NOW), 3);
  assert.equal(failuresAfterWrong({ failedAttempts: 5, lastFailedAt: ago(16) }, NOW), 1);
});

test("a session ends when revoked, after 30 idle minutes, or 12 hours after sign-in", () => {
  assert.deepEqual(sessionVerdict({ createdAt: ago(60), lastSeenAt: ago(5), revokedAt: null }, NOW), { ok: true });
  assert.deepEqual(sessionVerdict({ createdAt: ago(60), lastSeenAt: ago(31), revokedAt: null }, NOW), { ok: false, reason: "idle" });
  assert.deepEqual(sessionVerdict({ createdAt: ago(13 * 60), lastSeenAt: ago(1), revokedAt: null }, NOW), { ok: false, reason: "expired" });
  assert.deepEqual(sessionVerdict({ createdAt: ago(5), lastSeenAt: ago(1), revokedAt: ago(1) }, NOW), { ok: false, reason: "revoked" });
  assert.equal(PORTAL_POLICY.idleMinutes, 30);
});

test("an account that is suspended, closed, expired or not yet activated cannot sign in", () => {
  assert.deepEqual(accountVerdict({ status: "active", expiresAt: null }, NOW), { ok: true });
  assert.deepEqual(accountVerdict({ status: "suspended", expiresAt: null }, NOW), { ok: false, reason: "suspended" });
  assert.deepEqual(accountVerdict({ status: "active", expiresAt: ago(1) }, NOW), { ok: false, reason: "expired" });
  assert.deepEqual(accountVerdict({ status: "invited", expiresAt: null }, NOW), { ok: false, reason: "not_activated" });
  assert.deepEqual(accountVerdict({ status: "closed", expiresAt: null }, NOW), { ok: false, reason: "closed" });
});

test("an enrolment: upcoming, open, in progress, completed, closed, suspended — and attempts", () => {
  const base: EnrolmentFacts = { surveyStatus: "live", accessFrom: null, accessUntil: null, suspended: false, maxAttempts: null, allowRetake: false, finished: 0, inProgress: false };
  const at = (f: Partial<EnrolmentFacts>) => enrolmentAccess({ ...base, ...f }, NOW);
  assert.deepEqual(at({}), { state: "open", canStart: true, canResume: false, attemptsLeft: 1, reason: null });
  assert.equal(at({ accessFrom: new Date(NOW + 60_000).toISOString() }).state, "upcoming");
  assert.equal(at({ inProgress: true }).canResume, true);
  assert.equal(at({ inProgress: true }).canStart, false);
  const done = at({ finished: 1 });
  assert.equal(done.state, "completed"); assert.equal(done.canStart, false); assert.equal(done.attemptsLeft, 0);
  assert.equal(at({ finished: 1, allowRetake: true }).canStart, true, "a survey that allows retakes has no limit");
  assert.equal(at({ finished: 1, maxAttempts: 3 }).attemptsLeft, 2);
  assert.match(at({ finished: 3, maxAttempts: 3 }).reason!, /all your attempts/);
  const expired = at({ accessUntil: ago(1) });
  assert.equal(expired.state, "closed"); assert.equal(expired.canStart, false); assert.match(expired.reason!, /has ended/);
  assert.equal(at({ accessUntil: ago(1), inProgress: true }).canResume, false, "an expired assessment cannot be resumed");
  assert.equal(at({ surveyStatus: "closed", finished: 1 }).state, "completed");
  assert.equal(at({ surveyStatus: "closed" }).canStart, false);
  assert.equal(at({ suspended: true, inProgress: true }).state, "suspended");
});

test("the portal notice is versioned; a privacy request is one of three kinds, and a correction says what to correct", async () => {
  const { PORTAL_CONSENT, readPrivacyRequest } = await import("./respondent.js");
  assert.match(PORTAL_CONSENT.version, /^\d{4}-\d{2}-\d{2}$/); assert.ok(PORTAL_CONSENT.paragraphs.length >= 3);
  assert.ok(PORTAL_CONSENT.paragraphs.join(" ").includes("withdraw"));
  assert.deepEqual(readPrivacyRequest({ kind: "access" }), { kind: "access", message: null });
  assert.deepEqual(readPrivacyRequest({ kind: "deletion", message: "  Please delete my answers.  " }), { kind: "deletion", message: "Please delete my answers." });
  assert.deepEqual(readPrivacyRequest({ kind: "correction", message: "My year of birth is 1984." }), { kind: "correction", message: "My year of birth is 1984." });
  for (const bad of [{ kind: "export_all" }, { kind: "correction" }, { kind: "correction", message: "x" }, { kind: "access", message: "x".repeat(2001) }, {}]) assert.ok("error" in readPrivacyRequest(bad), JSON.stringify(bad).slice(0, 60));
});
