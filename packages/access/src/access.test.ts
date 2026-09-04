import test from "node:test";
import assert from "node:assert/strict";
import {
  can, capabilitiesOf, decideAccess, isProjectRole, PROJECT_ROLES, GRANTABLE_ROLES, EDITING_ROLES,
  resolveProjectRole, roleSourceNote, workspaceAccessPolicy, DEFAULT_WORKSPACE_ACCESS,
  sessionStatus, sessionAuthorizes, sessionBlocksLogin, decideLogin, requestedTakeover,
  sessionPolicy, DEFAULT_SESSION_POLICY,
  decideThrottle, throttlePolicy, formatUserCode, isUserCode, parseIdentifier, deviceLabelFrom,
  lockStatus, lockIsLive, lockAvailableTo, decideEdit, lockBanner, lockPolicy,
  activePresence, activityFor, presencePolicy, initialsOf, avatarHue,
  describeEvent, auditCategory, isAuditEvent, isNotifiable,
  type SessionRecord, type LockRecord, type PresenceEntry,
} from "./index.js";

/**
 * The access model's contract.
 *
 * Two things are being protected here, and both are the kind of bug that is
 * invisible in a happy-path click-through:
 *
 *   1. a role can never gain a capability by accident — the tests assert the
 *      NEGATIVES, because "reviewer cannot save" is the requirement and
 *      "reviewer can read" is the easy half
 *   2. a session or a lock is never simultaneously "gone" and "blocking" —
 *      the two predicates that decide those must agree, or an account locks
 *      itself out and a project becomes permanently uneditable
 */

const T0 = Date.parse("2026-09-04T10:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

/* ============================================================ roles */

test("every role is read-only except the ones meant to write", () => {
  const writers = PROJECT_ROLES.filter((r) => can(r, "survey.edit"));
  assert.deepEqual(writers, ["owner", "editor", "programmer"], "only these three may change a survey");
  for (const r of ["reviewer", "viewer", "test_user", "deployment_manager"] as const) {
    assert.equal(can(r, "survey.edit"), false, `${r} must not be able to edit`);
    assert.equal(can(r, "survey.save_version"), false, `${r} must not be able to cut a version`);
    assert.equal(can(r, "responses.manage"), false, `${r} must not be able to change response data`);
  }
});

test("a programmer edits the survey but does not ship it — that is why the role exists", () => {
  assert.equal(can("programmer", "survey.edit"), true);
  assert.equal(can("programmer", "deploy.manage"), false, "deployment is the deployment manager's job");
  assert.equal(can("deployment_manager", "deploy.manage"), true);
  assert.equal(can("deployment_manager", "survey.edit"), false, "and shipping is not editing");
});

test("only the owner administers the project", () => {
  for (const cap of ["project.manage_members", "project.transfer", "project.delete", "lock.force_release"] as const) {
    assert.equal(can("owner", cap), true, `owner can ${cap}`);
    for (const r of ["editor", "programmer", "reviewer", "viewer", "test_user", "deployment_manager"] as const) {
      assert.equal(can(r, cap), false, `${r} must not ${cap}`);
    }
  }
  assert.equal(can("editor", "project.share"), true, "but an editor may invite a colleague");
});

test("a viewer and a test user can read but not comment their way into editing", () => {
  assert.equal(can("viewer", "project.read"), true);
  assert.equal(can("viewer", "comment.create"), false, "a plain viewer is silent by design");
  assert.equal(can("test_user", "comment.create"), true, "a tester needs to report what they found");
  assert.equal(can("test_user", "responses.read"), false, "but not to read the collected data");
  assert.equal(can("test_user", "survey.edit"), false);
});

test("no membership is not a weak role — it is no access", () => {
  assert.equal(can(null, "project.read"), false);
  assert.equal(can(undefined, "project.read"), false);
  assert.equal(can("nonsense" as never, "project.read"), false, "an unknown role grants nothing");
  assert.deepEqual(capabilitiesOf(null), []);
  assert.equal(isProjectRole("owner"), true);
  assert.equal(isProjectRole("OWNER"), false, "role names are exact");
});

test("owner is transferred, never granted in a share dialog", () => {
  assert.ok(!GRANTABLE_ROLES.includes("owner"), "the share dialog cannot mint a second owner");
  assert.equal(GRANTABLE_ROLES.length, PROJECT_ROLES.length - 1);
});

test("a platform admin can unstick a project but not rewrite it", () => {
  const admin = { userId: "u1", customerId: "c1", isPlatformAdmin: true };
  const user = { userId: "u2", customerId: "c1", isPlatformAdmin: false };

  const forced = decideAccess(admin, null, "lock.force_release");
  assert.equal(forced.allowed, true, "an admin may release a stuck lock — that is an operational duty");
  assert.equal(forced.viaAdmin, true);
  assert.equal(forced.reason, "platform_admin");

  const edit = decideAccess(admin, null, "survey.edit");
  assert.equal(edit.allowed, false, "editing someone's survey is not an operational duty");

  const nobody = decideAccess(user, null, "project.read");
  assert.equal(nobody.allowed, false);
  assert.equal(nobody.reason, "not_a_member", "and the UI can say so precisely");

  const member = decideAccess(user, "viewer", "survey.edit");
  assert.equal(member.allowed, false);
  assert.equal(member.reason, "insufficient_role", "which reads very differently to the user");
});

test("membership wins over admin, so the log records the real reason", () => {
  const admin = { userId: "u1", customerId: "c1", isPlatformAdmin: true };
  const d = decideAccess(admin, "owner", "project.share");
  assert.equal(d.viaAdmin, false, "they are the owner here; the admin power was not needed");
  assert.equal(d.reason, "owner");
});

test("EDITING_ROLES is derived, so a new writing role cannot be forgotten", () => {
  assert.deepEqual(EDITING_ROLES, PROJECT_ROLES.filter((r) => can(r, "survey.edit")));
});

/* ============================================================ workspace access */

/*
 * P0-1 and P0-5. Access used to mean "own it, or be added to it", and nothing
 * else. `project_members` was empty in production, so a workspace of three
 * programmers each saw only what they personally owned and the guard answered
 * 404 for the rest — which looks exactly like deleted data. These tests pin
 * both halves: colleagues can see their team's work again, AND none of the
 * boundaries that were doing real work got relaxed to achieve it.
 */

const ws = (defaultRole: Parameters<typeof workspaceAccessPolicy>[0]) => workspaceAccessPolicy(defaultRole);

test("P0-1: a workspace colleague gets a baseline role on a project nobody shared", () => {
  const r = resolveProjectRole({
    isOwner: false, memberRole: null, sameWorkspace: true, workspace: DEFAULT_WORKSPACE_ACCESS,
  });
  assert.equal(r.role, "editor", "the closest honest reconstruction of what they had before accounts existed");
  assert.equal(r.source, "workspace", "and the UI can say why, which is the difference between a rule and a mystery");
});

test("P0-1: a colleague in ANOTHER workspace still gets nothing", () => {
  const r = resolveProjectRole({
    isOwner: false, memberRole: null, sameWorkspace: false, workspace: DEFAULT_WORKSPACE_ACCESS,
  });
  assert.equal(r.role, null, "cross-organization isolation was never the bug and must not be relaxed");
  assert.equal(r.source, "none");
});

test("an explicit share beats the baseline — in BOTH directions", () => {
  // downwards: an owner who deliberately restricts a colleague to viewer has
  // made a decision, and a baseline that promoted them back to editor would
  // make the sharing dialog a lie
  const down = resolveProjectRole({
    isOwner: false, memberRole: "viewer", sameWorkspace: true, workspace: DEFAULT_WORKSPACE_ACCESS,
  });
  assert.equal(down.role, "viewer");
  assert.equal(down.source, "member");

  // upwards: a share of `editor` still reads as a share where the baseline is
  // only `reviewer`, so revoking it actually revokes something
  const up = resolveProjectRole({
    isOwner: false, memberRole: "editor", sameWorkspace: true, workspace: ws({ defaultRole: "reviewer" }),
  });
  assert.equal(up.role, "editor");
  assert.equal(up.source, "member");
});

test("ownership outranks everything", () => {
  const r = resolveProjectRole({
    isOwner: true, memberRole: "viewer", sameWorkspace: true, workspace: ws({ defaultRole: null }),
  });
  assert.equal(r.role, "owner");
  assert.equal(r.source, "owner");
});

test("a workspace can switch the baseline off entirely", () => {
  const off = ws({ defaultRole: null });
  assert.equal(off.defaultRole, null);
  const r = resolveProjectRole({ isOwner: false, memberRole: null, sameWorkspace: true, workspace: off });
  assert.equal(r.role, null, "strict explicit-share-only is still available");
  assert.equal(r.source, "none");
});

test("a nonsense or dangerous baseline closes the door rather than opening it", () => {
  assert.equal(ws({ defaultRole: "superuser" as never }).defaultRole, null, "an unknown role grants nothing");
  assert.equal(ws({ defaultRole: "owner" }).defaultRole, null, "a workspace cannot grant itself ownership");
  assert.equal(ws({ defaultRole: "" as never }).defaultRole, null);
  assert.equal(ws(null).defaultRole, "editor", "absent settings mean the default, not nothing");
  assert.equal(ws({}).defaultRole, "editor", "and neither does an empty object turn it off");
});

test("the baseline is a role, so the capability table still decides what it can do", () => {
  // the point of a capability model: lowering the baseline to reviewer removes
  // editing without anybody writing `role === "reviewer"` anywhere
  const r = resolveProjectRole({
    isOwner: false, memberRole: null, sameWorkspace: true, workspace: ws({ defaultRole: "reviewer" }),
  });
  assert.equal(can(r.role, "project.read"), true);
  assert.equal(can(r.role, "survey.edit"), false);
  assert.equal(can(r.role, "project.transfer"), false);
});

test("a workspace baseline never carries the owner-only powers", () => {
  const r = resolveProjectRole({
    isOwner: false, memberRole: null, sameWorkspace: true, workspace: DEFAULT_WORKSPACE_ACCESS,
  });
  for (const c of ["project.transfer", "project.delete", "project.manage_members", "lock.force_release"] as const) {
    assert.equal(can(r.role, c), false, `${c} stays with the owner`);
  }
});

test("a refusal knows whether to blame a share or a workspace setting", () => {
  const actor = { userId: "u1", customerId: "c1", isPlatformAdmin: false };
  const d = decideAccess(actor, "viewer", "survey.edit", "workspace");
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "insufficient_role");
  assert.equal(d.source, "workspace", "so the message can point at a setting an administrator can change");

  const granted = decideAccess(actor, "editor", "survey.edit", "workspace");
  assert.equal(granted.allowed, true);
  assert.equal(granted.reason, "workspace");

  // and a caller that does not know the source still behaves exactly as before
  const legacy = decideAccess(actor, "editor", "survey.edit");
  assert.equal(legacy.allowed, true);
  assert.equal(legacy.reason, "member");
  assert.equal(decideAccess(actor, "owner", "project.delete").reason, "owner");
  assert.equal(decideAccess(actor, null, "project.read").reason, "not_a_member");
});

test("the provenance is explained in words, because a role name is not a reason", () => {
  assert.match(roleSourceNote("workspace", "Acme Research") ?? "", /member of Acme Research/);
  assert.match(roleSourceNote("workspace") ?? "", /member of this workspace/);
  assert.match(roleSourceNote("member") ?? "", /shared with you/);
  assert.match(roleSourceNote("owner") ?? "", /own this project/);
  assert.equal(roleSourceNote("none"), null, "no access needs no explanation of access");
});

/* ============================================================ sessions */

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s1", userId: "u1", status: "active",
  createdAt: at(0), lastSeenAt: at(0), expiresAt: null, ...over,
});

test("a session is active while it keeps checking in", () => {
  const p = DEFAULT_SESSION_POLICY;
  const s = session({ lastSeenAt: at(1) });
  assert.equal(sessionStatus(s, p, T0 + 90_000), "active");
  assert.equal(sessionAuthorizes(s, p, T0 + 90_000), true);
});

test("quiet becomes IDLE, and idle still blocks a second login", () => {
  const p = DEFAULT_SESSION_POLICY;      // idle after 5 min, stale after 15
  const s = session({ lastSeenAt: at(0) });
  const t = T0 + 6 * 60_000;
  assert.equal(sessionStatus(s, p, t), "idle", "six minutes quiet is idle, not gone");
  assert.equal(sessionAuthorizes(s, p, t), true, "an idle user has not been logged out");
  assert.equal(sessionBlocksLogin(s, p, t), true, "they are probably reading — do not let a second login in");
});

test("a crashed browser eventually releases the account", () => {
  const p = DEFAULT_SESSION_POLICY;
  const s = session({ lastSeenAt: at(0) });
  const t = T0 + 16 * 60_000;
  assert.equal(sessionStatus(s, p, t), "expired", "nothing has checked in for over the stale threshold");
  assert.equal(sessionAuthorizes(s, p, t), false);
  assert.equal(sessionBlocksLogin(s, p, t), false, "and the user can sign in again — no permanent lockout");
});

test("authorizing and blocking are the SAME predicate, at every age", () => {
  // if these ever disagree, the platform either locks an account out of
  // itself or runs two live sessions. Checked across the whole timeline.
  const p = DEFAULT_SESSION_POLICY;
  for (let m = 0; m <= 60; m++) {
    const s = session({ lastSeenAt: at(0) });
    const t = T0 + m * 60_000;
    assert.equal(
      sessionAuthorizes(s, p, t), sessionBlocksLogin(s, p, t),
      `at ${m} minutes the two predicates diverged`,
    );
  }
});

test("the absolute lifetime ends a session however busy it is", () => {
  const p = sessionPolicy({ absoluteLifetimeSeconds: 60 * 60 });
  const s = session({ createdAt: at(0), lastSeenAt: at(61) });
  assert.equal(sessionStatus(s, p, T0 + 61 * 60_000), "expired");
});

test("logout and revocation are recorded states, not inferred ones", () => {
  const p = DEFAULT_SESSION_POLICY;
  assert.equal(sessionStatus(session({ status: "logged_out" }), p, T0), "logged_out");
  assert.equal(sessionStatus(session({ status: "revoked" }), p, T0), "revoked");
  assert.equal(sessionAuthorizes(session({ status: "revoked" }), p, T0), false, "a revoked session dies instantly");
  assert.equal(sessionBlocksLogin(session({ status: "logged_out" }), p, T0), false, "and logout frees the account at once");
});

/*
 * §12 REPLACED §4's ANSWER HERE, and this test replaced the one that pinned
 * the old one.
 *
 * The original test asserted that a second device is refused. That WAS the
 * requirement, and it was the P0: a researcher moving from a desktop to a
 * laptop was told to go and sign out on the machine they had walked away
 * from, or wait fifteen minutes. §12 now says "the user must be able to move
 * from System A to System B and continue working with the same account", and
 * this is what that means at the level of one decision.
 *
 * The exclusivity has NOT been dropped. One session per account still holds —
 * enforced by a unique partial index, not by this function. What changed is
 * which session loses.
 */
test("§12: moving to a second device gets you in, and displaces the old session", () => {
  const existing = session({ lastSeenAt: at(0), deviceLabel: "Chrome on Windows" });
  const d = decideLogin(existing, DEFAULT_SESSION_POLICY, T0 + 60_000);
  assert.equal(d.kind, "takeover", "the person at the keyboard wins, not the abandoned browser");
  if (d.kind !== "takeover") return;
  assert.equal(d.existing.sessionId, existing.sessionId, "and the caller is told which session to end");
});

test("strict mode still refuses — but never dead-ends (§12)", () => {
  const p = sessionPolicy({ allowForceTakeover: false });
  const existing = session({ lastSeenAt: at(0), deviceLabel: "Chrome on Windows" });
  const d = decideLogin(existing, p, T0 + 60_000);
  assert.equal(d.kind, "blocked");
  if (d.kind !== "blocked") return;
  assert.equal(d.canConfirmTakeover, true, "§12: the new session must still be able to work");
  assert.match(d.message, /already signed in/);
  assert.match(d.message, /Chrome on Windows/, "it names the device so the user knows what they are ending");
  assert.match(d.message, /unsaved work there will not be saved/, "and what it costs");
});

test("consent to displace the other session is read from one place", () => {
  assert.equal(requestedTakeover({ force: true }), true);
  assert.equal(requestedTakeover({ endOtherSession: true }), true, "either spelling");
  assert.equal(requestedTakeover({ force: "true" }), true, "a form post sends strings");
  assert.equal(requestedTakeover({}), false);
  assert.equal(requestedTakeover(null), false);
  assert.equal(requestedTakeover({ force: "yes please" }), false, "only an explicit truth counts");
});

test("§5: after logout the next login is allowed", () => {
  const d = decideLogin(session({ status: "logged_out" }), DEFAULT_SESSION_POLICY, T0 + 1000);
  assert.equal(d.kind, "allowed");
});

test("no session at all is simply allowed", () => {
  assert.equal(decideLogin(null, DEFAULT_SESSION_POLICY).kind, "allowed");
});

test("the takeover default is a setting, both ways", () => {
  const existing = session({ lastSeenAt: at(0) });
  assert.equal(
    decideLogin(existing, DEFAULT_SESSION_POLICY, T0 + 60_000).kind, "takeover",
    "the platform default lets a person move machines",
  );
  assert.equal(
    decideLogin(existing, sessionPolicy({ allowForceTakeover: false }), T0 + 60_000).kind, "blocked",
    "a workspace that wants confirmation can have it",
  );
});

test("a session already past the clock needs no takeover at all", () => {
  // 16 minutes of silence with a 15-minute stale threshold: nobody is there,
  // so this is an ordinary login and nothing is displaced
  const existing = session({ lastSeenAt: at(0) });
  assert.equal(decideLogin(existing, DEFAULT_SESSION_POLICY, T0 + 16 * 60_000).kind, "allowed");
  assert.equal(
    decideLogin(existing, sessionPolicy({ allowForceTakeover: false }), T0 + 16 * 60_000).kind, "allowed",
    "and strict mode does not invent a conflict either",
  );
});

test("a nonsensical policy cannot make the state machine incoherent", () => {
  const p = sessionPolicy({ idleAfterSeconds: 600, staleAfterSeconds: 60 });
  assert.ok(p.staleAfterSeconds >= p.idleAfterSeconds, "stale can never precede idle");
  const junk = sessionPolicy({ heartbeatSeconds: -5, idleAfterSeconds: 0 } as never);
  assert.equal(junk.heartbeatSeconds, DEFAULT_SESSION_POLICY.heartbeatSeconds, "junk falls back to the default");
});

/* ============================================================ throttle */

test("login throttling locks temporarily, per account and per source", () => {
  const p = throttlePolicy();
  assert.equal(decideThrottle({ accountFailures: 3, sourceFailures: 3 }, p).kind, "allow");
  const acct = decideThrottle({ accountFailures: 8, sourceFailures: 3 }, p);
  assert.equal(acct.kind, "locked");
  if (acct.kind === "locked") assert.match(acct.message, /this account/);
  const src = decideThrottle({ accountFailures: 0, sourceFailures: 25 }, p);
  assert.equal(src.kind, "locked");
  if (src.kind === "locked") assert.match(src.message, /this network/, "many accounts, one attacker");
});

test("a lockout expires by itself — it is never a permanent denial of service", () => {
  const p = throttlePolicy();
  const locked = { accountFailures: 0, sourceFailures: 0, lockedUntil: at(5) };
  assert.equal(decideThrottle(locked, p, T0).kind, "locked");
  assert.equal(decideThrottle(locked, p, T0 + 6 * 60_000).kind, "allow", "and clears on its own");
});

/* ============================================================ user code */

test("the user code is fixed-width, readable and never derived from the person", () => {
  assert.equal(formatUserCode(10482), "USR-10482");
  assert.equal(formatUserCode(1), "USR-10000", "the counter floor keeps every code the same length");
  assert.equal(isUserCode("USR-10482"), true);
  assert.equal(isUserCode("usr-10482"), true);
  assert.equal(isUserCode("USR-1"), false);
  assert.equal(isUserCode("john@company.com"), false);
});

test("one field accepts an email or a user code, however it is typed", () => {
  assert.deepEqual(parseIdentifier("john@company.com"), { kind: "email", value: "john@company.com" });
  assert.deepEqual(parseIdentifier("  John@Company.COM "), { kind: "email", value: "john@company.com" });
  for (const typed of ["USR-10482", "usr10482", "usr 10482", "10482", "USR_10482"]) {
    assert.deepEqual(parseIdentifier(typed), { kind: "user_code", value: "USR-10482" }, `"${typed}" is one person`);
  }
  assert.equal(parseIdentifier("john smith").kind, "unknown", "a name is not a credential");
  assert.equal(parseIdentifier("").kind, "unknown");
});

test("the device label is coarse on purpose", () => {
  assert.equal(deviceLabelFrom("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120 Safari/537"), "Chrome on macOS");
  assert.equal(deviceLabelFrom("Mozilla/5.0 (Windows NT 10.0) Firefox/121"), "Firefox on Windows");
  assert.equal(deviceLabelFrom("Mozilla/5.0 (iPhone) Safari/604"), "Safari on iOS");
  assert.equal(deviceLabelFrom(null), "Unknown device");
});

/* ============================================================ locks */

const lock = (over: Partial<LockRecord> = {}): LockRecord => ({
  surveyId: "p1", lockedByUserId: "u1", lockedBySessionId: "s1", status: "held",
  createdAt: at(0), lastHeartbeatAt: at(0), lockedByName: "John Smith", ...over,
});

test("a lock is held while its heartbeat is fresh, and stale once it stops", () => {
  const p = lockPolicy();                  // stale after 3 minutes
  const l = lock({ lastHeartbeatAt: at(0) });
  assert.equal(lockStatus(l, p, T0 + 60_000), "held");
  assert.equal(lockIsLive(l, p, T0 + 60_000), true);
  assert.equal(lockStatus(l, p, T0 + 4 * 60_000), "stale", "a crashed editor does not hold a project forever");
  assert.equal(lockIsLive(l, p, T0 + 4 * 60_000), false);
});

/*
 * P0-8. The old rule judged a lock by its heartbeat alone, which cannot see
 * that the person holding it signed out ninety seconds ago. A fresh heartbeat
 * from a session that no longer exists is not evidence of anybody working.
 */
test("P0-8: a lock whose session has ended is orphaned, however fresh its heartbeat", () => {
  const p = lockPolicy();
  const justBeat = lock({ lastHeartbeatAt: at(0), holderSessionLive: false });
  assert.equal(lockStatus(justBeat, p, T0 + 1000), "orphaned");
  assert.equal(lockIsLive(justBeat, p, T0 + 1000), false, "so it blocks nobody");
  assert.equal(lockAvailableTo(justBeat, "someoneElse", p, T0 + 1000), true, "and anyone may take it");
});

test("P0-8: an unchecked holder session is assumed live, so nothing is released by ignorance", () => {
  const p = lockPolicy();
  // `holderSessionLive` absent = the caller could not answer the question.
  // Defaulting to "dead" would let a caller that forgot to join release
  // everybody's locks, which is a far worse failure than the one being fixed.
  const unknown = lock({ lastHeartbeatAt: at(0) });
  assert.equal(unknown.holderSessionLive, undefined);
  assert.equal(lockStatus(unknown, p, T0 + 1000), "held");
  assert.equal(lockAvailableTo(unknown, "someoneElse", p, T0 + 1000), false);
});

test("P0-8: an orphaned lock is explained as a sign-out, not as idling", () => {
  const p = lockPolicy();
  const orphan = lock({ lastHeartbeatAt: at(0), holderSessionLive: false, lockedByName: "John Smith" });
  const b = lockBanner(orphan, "someoneElse", p, T0 + 1000);
  assert.equal(b.tone, "stale", "the UI treats it as takeable");
  assert.match(b.title, /John Smith is no longer signed in/);
  assert.match(b.detail ?? "", /available for editing/);
  // and it must NOT accuse them of wandering off
  assert.doesNotMatch(b.title, /left this project open/);

  const idled = lock({ lastHeartbeatAt: at(0), holderSessionLive: true });
  assert.match(lockBanner(idled, "someoneElse", p, T0 + 5 * 60_000).title, /left this project open/,
    "an actually-idle editor still reads as idle");
});

test("P0-8: a save is refused without discarding anything, and says which", () => {
  const p = lockPolicy();
  const orphan = lock({ lockedBySessionId: "sOther", lockedByUserId: "uOther", holderSessionLive: false });
  const v = decideEdit({ canEdit: true, lock: orphan, sessionId: "sMine", userId: "uMine", policy: p, nowMs: T0 + 1000 });
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  assert.equal(v.reason, "lock_not_held", "an orphaned lock is nobody's, so this is not 'locked_by_other'");
});

test("no lock, a released lock and an expired lock are all free", () => {
  const p = lockPolicy();
  assert.equal(lockStatus(null, p, T0), "free");
  assert.equal(lockStatus(lock({ status: "released" }), p, T0), "released");
  assert.equal(lockIsLive(lock({ status: "released" }), p, T0), false);
  assert.equal(lockStatus(lock({ createdAt: at(0), lastHeartbeatAt: at(0), expiresAt: at(1) }), p, T0 + 2 * 60_000), "expired");
});

test("the holder can always re-acquire — a page reload is not a conflict", () => {
  const p = lockPolicy();
  const l = lock({ lockedBySessionId: "s1", lastHeartbeatAt: at(0) });
  assert.equal(lockAvailableTo(l, "s1", p, T0 + 30_000), true, "the same session gets its edit mode back");
  assert.equal(lockAvailableTo(l, "s2", p, T0 + 30_000), false, "nobody else does");
  assert.equal(lockAvailableTo(l, "s2", p, T0 + 4 * 60_000), true, "until it goes stale");
});

test("§16: a save is refused unless capability, lock and session all agree", () => {
  const p = lockPolicy();
  const held = lock({ lockedBySessionId: "s1", lockedByUserId: "u1", lastHeartbeatAt: at(0) });
  const now = T0 + 30_000;

  const mine = decideEdit({ canEdit: true, lock: held, sessionId: "s1", userId: "u1", policy: p, nowMs: now });
  assert.equal(mine.allowed, true);

  const noRole = decideEdit({ canEdit: false, lock: held, sessionId: "s1", userId: "u1", policy: p, nowMs: now });
  assert.equal(noRole.allowed, false);
  assert.equal(noRole.reason, "no_capability", "the role is checked before the lock");

  const other = decideEdit({ canEdit: true, lock: held, sessionId: "s2", userId: "u2", policy: p, nowMs: now });
  assert.equal(other.allowed, false);
  assert.equal(other.reason, "locked_by_other");
  if (other.reason === "locked_by_other") assert.match(other.message, /being edited by John Smith/);

  const noLock = decideEdit({ canEdit: true, lock: null, sessionId: "s1", userId: "u1", policy: p, nowMs: now });
  assert.equal(noLock.allowed, false);
  assert.equal(noLock.reason, "lock_not_held", "holding the capability is not being in edit mode");

  const stale = decideEdit({ canEdit: true, lock: held, sessionId: "s1", userId: "u1", policy: p, nowMs: T0 + 5 * 60_000 });
  assert.equal(stale.allowed, false, "even the holder must re-acquire after their own lock went stale");
});

test("my own other browser is told apart from a colleague", () => {
  const p = lockPolicy();
  const held = lock({ lockedBySessionId: "sOld", lockedByUserId: "u1", lastHeartbeatAt: at(0) });
  const v = decideEdit({ canEdit: true, lock: held, sessionId: "sNew", userId: "u1", policy: p, nowMs: T0 + 30_000 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "lock_moved", "the same person, a different session — their unsaved work is at stake");
  if (v.reason === "lock_moved") assert.match(v.message, /another of your sessions/);
});

test("the banner says the right thing to each person looking at it", () => {
  const p = lockPolicy();
  assert.equal(lockBanner(null, "s2", p, T0).tone, "free");
  const held = lock({ lastHeartbeatAt: at(0) });
  assert.equal(lockBanner(held, "s1", p, T0 + 30_000).tone, "mine");
  const theirs = lockBanner(held, "s2", p, T0 + 30_000);
  assert.equal(theirs.tone, "other");
  assert.match(theirs.title, /John Smith is currently editing/);
  assert.match(theirs.detail ?? "", /read-only access until the editing lock is released/);
  const gone = lockBanner(held, "s2", p, T0 + 4 * 60_000);
  assert.equal(gone.tone, "stale");
  assert.match(gone.detail ?? "", /can now be taken over/);
});

test("a lock policy cannot be configured to expire before its own heartbeat", () => {
  const p = lockPolicy({ heartbeatSeconds: 60, staleAfterSeconds: 30 });
  assert.ok(p.staleAfterSeconds > p.heartbeatSeconds, "otherwise every lock is stale the moment it is taken");
});

/* ============================================================ presence */

const present = (over: Partial<PresenceEntry> = {}): PresenceEntry => ({
  userId: "u1", userCode: "USR-10482", name: "John Smith", role: "editor",
  activity: "viewing", lastSeenAt: at(0), sessionId: "s1", ...over,
});

test("presence drops people who stopped reporting, and pins the editor first", () => {
  const p = presencePolicy();               // present within 60s
  const list = activePresence([
    present({ userId: "u2", name: "Sarah Lee", sessionId: "s2", lastSeenAt: at(0) }),
    present({ userId: "u1", name: "John Smith", sessionId: "s1", activity: "editing", lastSeenAt: at(0) }),
    present({ userId: "u3", name: "Gone Away", sessionId: "s3", lastSeenAt: at(-10) }),
  ], p, T0 + 20_000);
  assert.deepEqual(list.map((e) => e.name), ["John Smith", "Sarah Lee"], "the editor leads; the absent are dropped");
});

test("“Editing” is derived from the lock, never self-reported", () => {
  const p = lockPolicy();
  const held = lock({ lockedBySessionId: "s1", lastHeartbeatAt: at(0) });
  assert.equal(activityFor("editor", "s1", held, p, T0 + 10_000), "editing");
  assert.equal(activityFor("editor", "s2", held, p, T0 + 10_000), "viewing", "a second editor cannot appear");
  assert.equal(activityFor("reviewer", "s2", held, p, T0 + 10_000), "reviewing");
  assert.equal(activityFor("test_user", "s2", held, p, T0 + 10_000), "testing");
  assert.equal(activityFor("editor", "s1", held, p, T0 + 9 * 60_000), "viewing", "a stale lock is not editing");
});

test("avatars are stable and derived, so nothing has to be stored or coordinated", () => {
  assert.equal(initialsOf("John Smith"), "JS");
  assert.equal(initialsOf("Madonna"), "MA");
  assert.equal(initialsOf(""), "?");
  assert.equal(initialsOf("  Maria  del  Gomez "), "MG");
  assert.equal(avatarHue("u1"), avatarHue("u1"), "same user, same colour, every screen");
  assert.ok(avatarHue("u1") >= 0 && avatarHue("u1") < 360);
});

/* ============================================================ audit */

test("the log reads as sentences a person can reconstruct a day from", () => {
  const row = (action: string, detail: Record<string, unknown> = {}) => ({
    id: 1, action, entity: "survey", entityId: "p1", userId: "u1",
    actorName: "John Smith", detail, createdAt: at(0),
  });
  assert.equal(describeEvent(row("lock.acquired")), "John Smith started editing");
  assert.equal(describeEvent(row("lock.acquired", { section: "Survey Flow" })), "John Smith started editing (Survey Flow)");
  assert.equal(describeEvent(row("project.shared", { targetName: "Sarah Lee", role: "Editor" })),
    "John Smith shared this project with Sarah Lee as Editor");
  assert.equal(describeEvent(row("project.opened", { readOnly: true })), "John Smith opened this project (read-only)");
  assert.equal(describeEvent(row("version.created", { version: "2.1" })), "John Smith created version 2.1");
  assert.equal(describeEvent(row("lock.force_released", { targetName: "Sarah Lee" })),
    "John Smith force-released the edit lock held by Sarah Lee");
});

test("a row with no detail and no name still reads properly", () => {
  const bare = { id: 2, action: "lock.released", entity: null, entityId: null, userId: null, createdAt: at(0) };
  assert.equal(describeEvent(bare), "The system released the edit lock");
  const noDetail = { ...bare, action: "version.created", userId: "u9" };
  assert.equal(describeEvent(noDetail), "A user created version ?", "never the word undefined");
});

test("an unknown action degrades to something readable rather than crashing", () => {
  const r = { id: 3, action: "future.event", entity: null, entityId: null, userId: "u1", actorName: "John Smith", createdAt: at(0) };
  assert.equal(describeEvent(r), "John Smith — future.event");
  assert.equal(isAuditEvent("future.event"), false);
  assert.equal(isAuditEvent("lock.acquired"), true);
});

test("events are categorised for the activity filter", () => {
  assert.equal(auditCategory("user.logged_in"), "identity");
  assert.equal(auditCategory("session.revoked"), "session");
  assert.equal(auditCategory("lock.acquired"), "editing");
  assert.equal(auditCategory("survey.saved"), "survey");
  assert.equal(auditCategory("responses.deleted"), "data");
  assert.equal(auditCategory("comment.created"), "collaboration");
  assert.equal(auditCategory("project.shared"), "access");
});

test("notifiable events are a declared list, not a rule hidden in a route", () => {
  assert.equal(isNotifiable("project.shared"), true);
  assert.equal(isNotifiable("lock.released"), true, "the whole point of §39 — tell the person who is waiting");
  assert.equal(isNotifiable("project.opened"), false, "nobody needs a notification for that");
});
