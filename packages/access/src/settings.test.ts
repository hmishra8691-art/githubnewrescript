import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAccessPolicy, describeAccessPolicy, ACCESS_FIELDS,
  DEFAULT_SESSION_POLICY, DEFAULT_THROTTLE,
} from "./index.js";

/**
 * THE STORED ACCESS POLICY (§7).
 *
 * `access_settings` was read on every sign-in since 0008 and written by
 * nothing. The rules being pinned here are both about what NOT to store,
 * because that is where this goes wrong quietly: a row that restates the
 * defaults pins them for ever, and a row that stores a number the engine will
 * not honour makes the screen lie about what is in force.
 */

test("nothing in, nothing stored — an empty form does not pin the defaults", () => {
  const d = buildAccessPolicy({});
  assert.deepEqual(d.policy, {});
  assert.deepEqual(d.rejected, []);
  assert.match(describeAccessPolicy(d.policy), /back to the platform default/);
});

test("A VALUE EQUAL TO THE DEFAULT IS NOT STORED", () => {
  // the rule that keeps a workspace inheriting future improvements
  const d = buildAccessPolicy({
    session: { heartbeatSeconds: DEFAULT_SESSION_POLICY.heartbeatSeconds },
    throttle: { lockoutSeconds: DEFAULT_THROTTLE.lockoutSeconds },
  });
  assert.deepEqual(d.policy, {});
});

test("only the fields that differ are stored, and nothing else comes along", () => {
  const d = buildAccessPolicy({
    session: { heartbeatSeconds: DEFAULT_SESSION_POLICY.heartbeatSeconds, absoluteLifetimeSeconds: 7200 },
    throttle: { maxAttemptsPerAccount: 5 },
  });
  assert.deepEqual(d.policy, {
    session: { absoluteLifetimeSeconds: 7200 },
    throttle: { maxAttemptsPerAccount: 5 },
  });
});

test("empty string, null and undefined all mean INHERIT", () => {
  // "" is what an emptied number input sends; reading it as 0 would store a
  // zero-second timeout for somebody who was clearing the field
  const d = buildAccessPolicy({
    session: { heartbeatSeconds: "", idleAfterSeconds: null, staleAfterSeconds: undefined },
    throttle: { windowSeconds: "" },
  });
  assert.deepEqual(d.policy, {});
  assert.deepEqual(d.rejected, []);
});

/* ============================================== what is refused, and why */

test("a value outside the field's range is refused, naming the range", () => {
  const d = buildAccessPolicy({ session: { absoluteLifetimeSeconds: 10 } });
  assert.deepEqual(d.policy, {});
  assert.equal(d.rejected.length, 1);
  assert.match(d.rejected[0], /Signed out after must be between 300 and 2592000/);
});

test("a value that is not a number is refused rather than coerced", () => {
  const d = buildAccessPolicy({ throttle: { maxAttemptsPerAccount: "lots" } });
  assert.match(d.rejected[0], /Attempts per account must be a number/);
  assert.deepEqual(d.policy, {});
});

test("one bad field does not discard the good ones — the report names both", () => {
  const d = buildAccessPolicy({
    session: { absoluteLifetimeSeconds: 7200, heartbeatSeconds: 99999 },
  });
  assert.deepEqual(d.policy.session, { absoluteLifetimeSeconds: 7200 });
  assert.equal(d.rejected.length, 1);
  assert.match(d.rejected[0], /Heartbeat/);
});

/* ================================== the value stored is the value in force */

test("THE ORDERING RULE IS APPLIED BEFORE STORING, and reported", () => {
  /*
   * `sessionPolicy` raises a stale timeout that would precede the idle one,
   * because a session would otherwise skip IDLE entirely. If that happened
   * AFTER storing, the screen would show 120 and the platform would run 600.
   */
  const d = buildAccessPolicy({ session: { idleAfterSeconds: 600, staleAfterSeconds: 120 } });
  assert.equal(d.policy.session.staleAfterSeconds, 600, "stored as what will actually happen");
  const note = d.adjusted.find((a) => a.field === "staleAfterSeconds");
  assert.ok(note, "and the change is reported rather than silent");
  assert.equal(note.asked, 120);
  assert.equal(note.stored, 600);
  assert.match(note.why, /must not go stale before it goes idle/);
});

test("a value the helper accepts unchanged is not reported as adjusted", () => {
  const d = buildAccessPolicy({ session: { idleAfterSeconds: 120, staleAfterSeconds: 600 } });
  assert.deepEqual(d.adjusted, []);
  assert.deepEqual(d.policy.session, { idleAfterSeconds: 120, staleAfterSeconds: 600 });
});

test("fractional input is rounded, not rejected", () => {
  const d = buildAccessPolicy({ throttle: { windowSeconds: 610.7 } });
  assert.equal(d.policy.throttle.windowSeconds, 611);
});

/* ==================================================== the takeover switch */

test("the takeover switch is stored only when it differs from the default", () => {
  assert.deepEqual(buildAccessPolicy({ session: { allowForceTakeover: true } }).policy, {},
    "true is the default, so it stays inheritable");
  assert.deepEqual(buildAccessPolicy({ session: { allowForceTakeover: false } }).policy,
    { session: { allowForceTakeover: false } });
});

test("a non-boolean takeover value is ignored rather than stored as truthy", () => {
  const d = buildAccessPolicy({ session: { allowForceTakeover: "yes" } });
  assert.deepEqual(d.policy, {});
});

/* =================================================== the baseline role */

test("a grantable role is stored in its own namespace", () => {
  // `loadPolicies` reads `workspace.defaultRole`; a flat key would be missed
  const d = buildAccessPolicy({ workspace: { defaultRole: "reviewer" } });
  assert.deepEqual(d.policy, { workspace: { defaultRole: "reviewer" } });
});

test('"none" is an EXPLICIT null, not an omission', () => {
  /*
   * Omitting the key means inherit, and a platform default could later grant
   * a baseline this workspace deliberately refused. Storing null says no.
   */
  const d = buildAccessPolicy({ workspace: { defaultRole: "none" } });
  assert.deepEqual(d.policy, { workspace: { defaultRole: null } });
});

test("an empty choice means inherit and stores nothing", () => {
  assert.deepEqual(buildAccessPolicy({ workspace: { defaultRole: "" } }).policy, {});
  assert.deepEqual(buildAccessPolicy({ workspace: {} }).policy, {});
});

test("owner cannot be a workspace baseline, and neither can nonsense", () => {
  // every project has exactly one owner; a baseline owner would mean everyone
  for (const bad of ["owner", "admin", "platform_admin", "Reviewer"]) {
    const d = buildAccessPolicy({ workspace: { defaultRole: bad } });
    assert.deepEqual(d.policy, {}, `${bad} was stored`);
    assert.match(d.rejected[0], /is not a role that can be granted/);
  }
});

/* ============================================================== the words */

test("the summary names the sections that were overridden", () => {
  const d = buildAccessPolicy({
    session: { absoluteLifetimeSeconds: 7200 },
    workspace: { defaultRole: "viewer" },
  });
  const words = describeAccessPolicy(d.policy);
  assert.match(words, /session: absoluteLifetimeSeconds/);
  assert.match(words, /workspace: defaultRole/);
});

test("every field the UI can render is one this module accepts", () => {
  // the two lists drifting apart is how a control appears that saves nothing
  const asked: Record<string, number> = {};
  for (const [key, spec] of Object.entries(ACCESS_FIELDS.session)) asked[key] = spec.min;
  const d = buildAccessPolicy({ session: asked });
  assert.deepEqual(d.rejected, [], d.rejected.join(" | "));
  for (const [key, spec] of Object.entries(ACCESS_FIELDS.throttle)) {
    const one = buildAccessPolicy({ throttle: { [key]: spec.max } });
    assert.deepEqual(one.rejected, [], `${key}: ${one.rejected.join(" | ")}`);
    assert.ok(one.policy.throttle, `${key} at its maximum stores nothing`);
  }
});
