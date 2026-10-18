import test from "node:test";
import assert from "node:assert/strict";
import { presetById } from "@rescript/access";
import { decideProjectGate } from "../projectAccess.ts";
import { qualAbilities, qualGuardCapability, qualRefusal, QUAL_CAPS, type QualOperation } from "./qualAccess.ts";

/*
 * QUALITATIVE DATA = THE DATA MODULE (2026-10-18). The route's guard asks for the operation's first
 * capability through the same `decideProjectGate` every data route uses, then `qualRefusal` checks
 * the rest. These are the status codes a member gets from /api/surveys/[id]/qual/**.
 */

const user = { userId: "u1", customerId: "c1", isPlatformAdmin: false };
const member = (role: string, permissions: unknown = null) => ({ access: { project_role: role, role_source: "member" }, member: { permissions, expires_at: null } });
const status = (role: string, op: QualOperation, permissions: unknown = null): number => {
  const m = member(role, permissions);
  const g = decideProjectGate({ user, access: m.access, member: m.member, capability: qualGuardCapability(op), now: Date.parse("2026-10-18T12:00:00Z") });
  if (!g.ok) return g.status;
  return qualRefusal(g.grant, op) ? 403 : 200;
};
const custom = (modules: Record<string, string>, add: string[] = []) => ({ v: 1, modules, add, remove: [] });

test("a member without Data access gets 403 on transcripts — every qualitative operation but the guide", () => {
  const noData = custom({ data: "none", analytics: "manage", programming: "manage" });
  for (const op of ["read", "manage", "code", "report", "playback", "settings"] as QualOperation[]) assert.equal(status("custom", op, noData), 403, op);
  assert.equal(status("custom", "guide", noData), 200, "the guide is the design, not data");
  for (const role of ["vendor", "interviewer", "test_user"]) assert.equal(status(role, "read"), 403, role);
});

test("Data view reads (redacted without contact details); Data edit manages; coding needs Analytics edit; playback needs contact details", () => {
  const view = custom({ data: "view", analytics: "none" });
  assert.equal(status("custom", "read", view), 200);
  assert.equal(status("custom", "manage", view), 403);
  assert.equal(status("custom", "code", view), 403);
  assert.equal(status("custom", "playback", view), 403, "a voice cannot be redacted");
  const ab = qualAbilities({ role: "custom", permissions: view, expiresAt: null });
  assert.deepEqual([ab.read, ab.pii, ab.manage], [true, false, false]);
  const analyst = custom({ data: "view", analytics: "edit" });
  assert.equal(status("custom", "code", analyst), 200);
  assert.equal(status("custom", "report", analyst), 403, "report downloads are Analytics manage");
  const edit = custom({ data: "edit", analytics: "none" });
  assert.equal(status("custom", "manage", edit), 200);
  assert.equal(status("custom", "settings", edit), 403, "the names list needs contact details");
  const full = custom({ data: "manage", analytics: "manage" });
  for (const op of Object.keys(QUAL_CAPS) as QualOperation[]) assert.equal(status("custom", op, full), 200, op);
  /* the shipped preset: Data Analyst (no PII) */
  const preset = presetById("data_analyst");
  assert.ok(preset);
  const ab2 = qualAbilities({ role: "custom", permissions: preset!.permissions, expiresAt: null });
  assert.deepEqual([ab2.read, ab2.pii], [true, false], "the Data Analyst preset reads redacted text");
});

test("the fixed roles: owner and editor do everything; programmer codes but does not import; viewer reads; refusals name what is missing", () => {
  for (const op of Object.keys(QUAL_CAPS) as QualOperation[]) { assert.equal(status("owner", op), 200, op); assert.equal(status("editor", op), 200, op); }
  assert.equal(status("programmer", "code"), 200);
  assert.equal(status("programmer", "manage"), 403);
  assert.equal(status("viewer", "read"), 200);
  assert.equal(status("viewer", "code"), 403);
  assert.equal(status("reviewer", "report"), 200);
  const r = qualRefusal("viewer", "code");
  assert.deepEqual(r?.missing, ["analytics.edit"]);
  assert.match(r?.error ?? "", /Data Analytics: Edit/);
  assert.equal(qualRefusal("owner", "playback"), null);
});
