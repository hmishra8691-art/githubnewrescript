import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSummary, credentialRoute, invitationMail, planAccounts, readPortalRequest, resetMail } from "./portalAdminCore.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a request is read strictly: known action, real ids, sane dates and attempts", () => {
  assert.deepEqual(readPortalRequest({ action: "nope", ids: [ID(1)] }, NOW), { error: "Unknown action." });
  assert.match((readPortalRequest({ action: "suspend", ids: ["x", 3] }, NOW) as { error: string }).error, /at least one/);
  assert.match((readPortalRequest({ action: "initial_password", ids: [ID(1), ID(2)] }, NOW) as { error: string }).error, /one respondent/);
  const ok = readPortalRequest({ action: "suspend", ids: [ID(1), ID(1), ID(2), "junk"] }, NOW);
  assert.ok(!("error" in ok) && ok.ids.length === 2);
  assert.match((readPortalRequest({ action: "reopen", ids: [ID(1)], until: "2026-11-19T00:00:00Z" }, NOW) as { error: string }).error, /future/);
  assert.match((readPortalRequest({ action: "reopen", ids: [ID(1)], until: "2029-01-01T00:00:00Z" }, NOW) as { error: string }).error, /a year/);
  const re = readPortalRequest({ action: "reopen", ids: [ID(1)], until: "2026-11-21T10:00:00+01:00" }, NOW);
  assert.ok(!("error" in re) && re.until === "2026-11-21T09:00:00.000Z");
  assert.match((readPortalRequest({ action: "access", ids: [ID(1)] }, NOW) as { error: string }).error, /Nothing to change/);
  assert.match((readPortalRequest({ action: "access", ids: [ID(1)], from: "2026-12-02", until: "2026-12-01" }, NOW) as { error: string }).error, /after the opening/);
  assert.match((readPortalRequest({ action: "access", ids: [ID(1)], maxAttempts: 0 }, NOW) as { error: string }).error, /1 to 1000/);
  const acc = readPortalRequest({ action: "access", ids: [ID(1)], from: null, until: "2026-12-01T00:00:00Z", maxAttempts: null }, NOW);
  assert.ok(!("error" in acc) && acc.setWindow && acc.setAttempts && acc.maxAttempts === null && acc.from === null);
});

test("one account per person: an address that has an account joins it; duplicates in a list are skipped and said so", () => {
  const existing = new Map([["ana@example.org", "acc-ana"], ["dan@example.org", "acc-dan"]]);
  const plan = planAccounts([
    { id: "r1", email: " Ana@Example.org ", name: "Ana", accountId: null },
    { id: "r2", email: "ben@example.org", name: "Ben", accountId: null },
    { id: "r3", email: "ben@example.org", name: "Ben again", accountId: null },
    { id: "r4", email: null, name: "No address", accountId: null },
    { id: "r5", email: "not-an-email", name: null, accountId: null },
    { id: "r6", email: "cara@example.org", name: "Cara", accountId: "acc-cara" },
    { id: "r7", email: "dan@example.org", name: "Dan", accountId: null },
  ], existing, new Set(["acc-dan"]), "persistent");
  assert.deepEqual(plan, [
    { row: "r1", do: "link", accountId: "acc-ana" },
    { row: "r2", do: "create", email: "ben@example.org", name: "Ben", scope: "persistent" },
    { row: "r3", do: "skip", why: "another respondent in this list has the same email address" },
    { row: "r4", do: "create", email: null, name: "No address", scope: "persistent" },
    { row: "r5", do: "create", email: null, name: null, scope: "persistent" },
    { row: "r6", do: "already" },
    { row: "r7", do: "skip", why: "this person is already on this survey's list" },
  ]);
});

test("an assessment-only identity never joins an existing account, even for a known address", () => {
  const plan = planAccounts([{ id: "r1", email: "ana@example.org", name: "Ana", accountId: null }], new Map([["ana@example.org", "acc-ana"]]), new Set(), "assessment");
  assert.deepEqual(plan, [{ row: "r1", do: "create", email: "ana@example.org", name: "Ana", scope: "assessment" }]);
});

test("the emails carry the link, the Respondent ID and how long the link lasts — and nothing else about the person", () => {
  const inv = invitationMail({ name: "Ana", respondentId: "RSP-7K2M9QXA", link: "https://take.example/portal/invitation#token=T", surveyTitle: "Wellbeing check", days: 14, from: "North Clinic" });
  assert.match(inv.subject, /Wellbeing check/);
  for (const part of ["Hello Ana,", "North Clinic has invited you", "https://take.example/portal/invitation#token=T", "RSP-7K2M9QXA", "14 days"]) assert.ok(inv.text.includes(part), part);
  const rst = resetMail({ name: null, respondentId: "RSP-7K2M9QXA", link: "https://take.example/portal/reset#token=T", minutes: 60 });
  assert.ok(rst.text.startsWith("Hello,")); assert.ok(rst.text.includes("60 minutes")); assert.ok(rst.text.includes("has not been changed"));
  assert.equal(actionSummary({ action: "access", until: null, maxAttempts: 3, setAttempts: true, setWindow: true }), "changed respondents' access (window, attempts: 3)");
});

test("a credential is never shown to a researcher for an account that has an email address; only the creating workspace is shown one otherwise", () => {
  const shared = { email: "ana@example.org", createdCustomerId: "ws-a" };
  assert.deepEqual(credentialRoute(shared, "ws-a", true, "link"), { how: "email" });
  assert.deepEqual(credentialRoute(shared, "ws-b", true, "link"), { how: "email" }, "another workspace's invitation still goes only to the person");
  assert.equal(credentialRoute(shared, "ws-a", false, "link").how, "refuse");
  assert.equal(credentialRoute(shared, "ws-a", true, "password").how, "refuse", "no researcher can set a password on a shareable account");
  const local = { email: null, createdCustomerId: "ws-a" };
  assert.deepEqual(credentialRoute(local, "ws-a", false, "link"), { how: "show" });
  assert.deepEqual(credentialRoute(local, "ws-a", false, "password"), { how: "show" });
  assert.equal(credentialRoute(local, "ws-b", true, "link").how, "refuse");
  assert.equal(credentialRoute(local, null, true, "password").how, "refuse");
});
