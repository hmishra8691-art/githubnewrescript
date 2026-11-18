import { test } from "node:test";
import assert from "node:assert/strict";
import { readCondition, readSkipRules } from "../lib/logic.ts";
import { can, capabilitiesOf, INTERVIEW_ROLES, INTERVIEW_CAPABILITIES } from "../lib/auth.ts";
import { hashToken, mintInterviewToken, readSelection } from "../lib/candidate.ts";
import { drawOf } from "../lib/pools.ts";
import { readClaimedParts } from "../lib/recordings.ts";

/* The Interviews app had 12.6k lines and no tests (audit 2026-11-17, P1-10). These cover the pure rules every route
   leans on: who may do what, what a candidate's token is, and what is accepted from the browser. */

test("roles: a viewer can follow progress but cannot play a recording or read an email address", () => {
  assert.equal(can("viewer", "project.read"), true);
  assert.equal(can("viewer", "media.read"), false, "watching a candidate's video is its own capability");
  assert.equal(can("viewer", "identity.read"), false);
  assert.equal(can("reviewer", "media.read"), true);
  assert.equal(can("reviewer", "identity.read"), false, "a reviewer assesses answers without the address");
  assert.equal(can("reviewer", "project.edit"), false);
  assert.equal(can(null, "project.read"), false);
  assert.deepEqual(capabilitiesOf("manager").sort(), [...INTERVIEW_CAPABILITIES].sort(), "a manager has everything");
  for (const r of INTERVIEW_ROLES) for (const c of capabilitiesOf(r)) assert.ok(capabilitiesOf("manager").includes(c), `${r}: ${c} is a known capability`);
  assert.equal(can("interviewer", "project.delete"), false);
  assert.equal(can("interviewer", "billing.set_budget"), false);
});

test("candidate tokens: random, hashed one way, the prefix is the token's start", () => {
  const a = mintInterviewToken(), b = mintInterviewToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashToken(a.token));
  assert.notEqual(a.hash, a.token);
  assert.ok(a.token.startsWith(a.prefix));
  assert.ok(a.token.length >= 24);
});

test("logic from the browser: undefined = untouched, null = clear, malformed refused with the schema's reason", () => {
  assert.deepEqual(readCondition(undefined), { ok: true, value: undefined });
  assert.deepEqual(readCondition(null), { ok: true, value: null });
  assert.equal(readCondition({ nonsense: true }).ok, false);
  assert.deepEqual(readSkipRules(null), { ok: true, value: [] });
  assert.equal(readSkipRules({}).ok, false);
  assert.equal(readSkipRules([{ bad: 1 }]).ok, false);
});

test("selection, draw counts and upload parts accept only well-formed values", () => {
  assert.deepEqual(readSelection({ pools: [{ id: "p1", draw: 2, randomize: true }, { id: 3 }, { id: "p2", draw: -1 }], randomizePools: "yes" }),
    { pools: [{ id: "p1", draw: 2, randomize: true }, { id: "p2", draw: null, randomize: false }], randomizePools: false });
  assert.equal(drawOf(""), null); assert.equal(drawOf("3"), 3); assert.equal(drawOf(2.5), null); assert.equal(drawOf(-1), null);
  assert.deepEqual(readClaimedParts([{ partNumber: 1, etag: "\"abc\"" }, { partNumber: 0, etag: "x" }, { partNumber: 2 }, "junk"]), [{ partNumber: 1, etag: "abc" }]);
  assert.deepEqual(readClaimedParts("nope"), []);
});
