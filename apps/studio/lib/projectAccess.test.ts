import test from "node:test";
import assert from "node:assert/strict";
import { BASELINE_ROLES, presetById, type Capability } from "@rescript/access";
import {
  accessHistory, decideProjectGate, grantRefusal, losesEditing, memberAccessView, parseAccessRequest, sameGrant,
} from "./projectAccess.ts";

/**
 * THE GATE, AS DECIDED (2026-10-17). `guard.ts` asks the database two things —
 * `rescript_project_access` and, for a member, the membership's permissions
 * and expiry — and hands both to `decideProjectGate`. These tests are the
 * route-level contract: the status code and body every guarded route returns.
 */

const T0 = Date.parse("2026-10-17T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const user = { userId: "u1", customerId: "c1", isPlatformAdmin: false };
const admin = { ...user, isPlatformAdmin: true };
const member = (project_role: string) => ({ project_role, role_source: "member" });
const gate = (access: { project_role: string | null; role_source: string } | null, member: { permissions?: unknown; expires_at?: string | null } | null, capability: Capability, who = user) =>
  decideProjectGate({ user: who, access, member, capability, now: T0 });

test("every existing role is decided exactly as the old guard decided it", () => {
  const cases: [string, Capability, boolean][] = [
    ["owner", "project.delete", true], ["editor", "survey.edit", true], ["editor", "project.manage_members", false],
    ["programmer", "deploy.manage", false], ["reviewer", "responses.export", true], ["viewer", "responses.export", false],
    ["viewer", "responses.read", true], ["test_user", "responses.read", false], ["deployment_manager", "deploy.manage", true],
  ];
  for (const [role, cap, allowed] of cases) {
    const g = gate({ project_role: role, role_source: role === "owner" ? "owner" : "member" }, { permissions: null, expires_at: null }, cap);
    assert.equal(g.ok, allowed, `${role} / ${cap}`);
    if (!g.ok) {
      assert.equal(g.status, 403);
      assert.equal(g.body.code, "insufficient_role");
      assert.match(String(g.body.error), /Your role on this project/);
    }
  }
  /* a database without 0062: no member row at all — decided on the role, as before */
  assert.equal(gate(member("editor"), null, "survey.edit").ok, true);
  /* not a member: 404, indistinguishable from a project that does not exist */
  const out = gate({ project_role: null, role_source: "none" }, null, "project.read");
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.status, 404);
  /* revoked (0034): still 404 */
  const rev = gate({ project_role: null, role_source: "revoked" }, null, "project.read");
  assert.equal(!rev.ok && rev.status, 404);
  /* the workspace baseline still blames the setting */
  const ws = gate({ project_role: "viewer", role_source: "workspace" }, null, "survey.edit");
  assert.equal(!ws.ok && ws.status, 403);
  assert.match(String(!ws.ok && ws.body.error), /Your workspace grants viewer access/);
  for (const r of BASELINE_ROLES) assert.equal(gate({ project_role: r, role_source: "workspace" }, null, "project.read").ok, true);
});

test("Data: None → 403 from the data and export routes, not a hidden button", () => {
  const m = { permissions: { v: 1, modules: { data: "none", analytics: "manage", programming: "manage" } }, expires_at: null };
  for (const cap of ["responses.read", "responses.export", "responses.manage", "responses.read_pii"] as Capability[]) {
    const g = gate(member("custom"), m, cap);
    assert.equal(g.ok, false, cap);
    if (!g.ok) {
      assert.equal(g.status, 403);
      assert.equal(g.body.code, "insufficient_role");
      assert.equal(g.body.capability, cap);
      assert.match(String(g.body.error), /Your access to this project does not include this/);
    }
  }
  assert.equal(gate(member("custom"), m, "analytics.read").ok, true, "reports are their own module");
  assert.equal(gate(member("custom"), m, "project.read").ok, true);
});

test("View-only programming cannot save the survey (the save route asks survey.edit, the lock route lock.acquire)", () => {
  const m = { permissions: { v: 1, modules: { programming: "view", data: "manage" } }, expires_at: null };
  assert.equal(gate(member("custom"), m, "survey.edit").ok, false);
  assert.equal(gate(member("custom"), m, "lock.acquire").ok, false);
  assert.equal(gate(member("custom"), m, "survey.save_version").ok, false);
  assert.equal(gate(member("custom"), m, "lock.request").ok, true, "asking is allowed");
  const ok = gate(member("custom"), { permissions: { v: 1, modules: { programming: "edit" } } }, "survey.edit");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.grant, { role: "custom", permissions: { v: 1, modules: { programming: "edit" } }, expiresAt: null }, "the grant travels on the context");
});

test("expired access is denied with 403 access_expired — by the database's answer or by the clock", () => {
  const bySql = gate({ project_role: null, role_source: "expired" }, { expires_at: iso(T0 - DAY) }, "project.read");
  assert.equal(bySql.ok, false);
  if (!bySql.ok) {
    assert.equal(bySql.status, 403);
    assert.equal(bySql.body.code, "access_expired");
    assert.match(String(bySql.body.error), /expired on 2026-10-16/);
  }
  /* the code checks too, so expiry holds on a database without 0062's function */
  const byClock = gate(member("editor"), { expires_at: iso(T0 - 1) }, "project.read");
  assert.equal(!byClock.ok && byClock.body.code, "access_expired");
  const live = gate(member("editor"), { expires_at: iso(T0 + DAY) }, "survey.edit");
  assert.equal(live.ok, true);
  if (live.ok) assert.equal(live.expiresAt, iso(T0 + DAY));
  /* the owner and the baseline never carry an expiry */
  assert.equal(gate({ project_role: "owner", role_source: "owner" }, { expires_at: iso(T0 - DAY) }, "project.read").ok, true);
  /* a platform admin's operational duties survive their own membership ending */
  assert.equal(gate({ project_role: null, role_source: "expired" }, null, "lock.force_release", admin).ok, true);
  assert.equal(gate({ project_role: null, role_source: "expired" }, null, "survey.edit", admin).ok, false);
});

test("a share request: old clients unchanged, new fields validated", () => {
  const old = parseAccessRequest({ identifier: "a@b.co", role: "programmer" }, T0);
  assert.deepEqual(old, { ok: true, value: { role: "programmer", permissions: null, expiresAt: undefined } }, "expiry not mentioned ≠ cleared");
  assert.equal(parseAccessRequest({ role: "owner" }, T0).ok, false, "ownership is transferred, never granted");
  assert.equal(parseAccessRequest({ role: "superuser" }, T0).ok, false);
  const c = parseAccessRequest({ role: "custom", permissions: { modules: { data: "view", bogus: "manage" }, add: ["project.delete"] }, expiry: { option: "7d" } }, T0);
  assert.equal(c.ok, true);
  if (c.ok) {
    assert.equal(c.value.permissions!.modules.data, "view");
    assert.ok(!("bogus" in c.value.permissions!.modules));
    assert.equal(c.value.permissions!.add, undefined, "an owner-only capability is dropped, never stored");
    assert.equal(c.value.expiresAt, iso(T0 + 7 * DAY));
  }
  assert.equal(parseAccessRequest({ role: "viewer", permissions: { modules: { data: "manage" } } }, T0).ok && (parseAccessRequest({ role: "viewer", permissions: { modules: { data: "manage" } } }, T0) as { value: { permissions: unknown } }).value.permissions, null, "permissions are stored only for custom");
  assert.equal(parseAccessRequest({ role: "viewer", expiry: { option: "custom", date: "2026-01-01" } }, T0).ok, false, "a past date is refused");
  assert.deepEqual(parseAccessRequest({ role: "viewer", expiresAt: null }, T0), { ok: true, value: { role: "viewer", permissions: null, expiresAt: null } }, "null clears");
  assert.equal(parseAccessRequest({ role: "viewer", expiresAt: "2026-12-01" }, T0).ok, true);
  assert.deepEqual(parseAccessRequest({}, T0, "reviewer"), { ok: true, value: { role: "reviewer", permissions: null, expiresAt: undefined } }, "PATCH without a role keeps the current one");
});

test("granting: an editor invites as before, but cannot mint an admin; owners and platform admins always may", () => {
  assert.equal(grantRefusal("editor", false, { role: "programmer" }), null);
  assert.equal(grantRefusal("editor", false, { role: "custom", permissions: presetById("survey_programmer")!.permissions }), null);
  assert.match(grantRefusal("editor", false, { role: "project_admin" }) ?? "", /cannot grant access you do not have/);
  assert.match(grantRefusal("editor", false, { role: "custom", permissions: { modules: { admin: "view" }, add: ["project.manage_members"] } }) ?? "", /change collaborators' access/);
  assert.equal(grantRefusal("owner", false, { role: "project_admin" }), null);
  assert.equal(grantRefusal(null, true, { role: "project_admin" }), null);
  assert.equal(grantRefusal({ role: "custom", permissions: { modules: { admin: "view", data: "view" }, add: ["project.share"] } }, false, { role: "custom", permissions: { modules: { data: "manage" } } }) !== null, true,
    "a custom inviter cannot hand out more data access than they hold");
});

test("a change that takes editing away releases the lock — the old editor/programmer rule, generalised", () => {
  for (const r of ["reviewer", "viewer", "test_user", "deployment_manager", "viewer_data", "vendor", "interviewer"]) assert.equal(losesEditing({ role: r as never }), true, r);
  for (const r of ["editor", "programmer", "project_admin"]) assert.equal(losesEditing({ role: r as never }), false, r);
  assert.equal(losesEditing({ role: "custom", permissions: { modules: { programming: "view" } } }), true);
  assert.equal(losesEditing({ role: "custom", permissions: { modules: { programming: "edit" } } }), false);
  assert.equal(sameGrant({ role: "viewer" }, { role: "viewer", expiresAt: null }), true);
  assert.equal(sameGrant({ role: "viewer" }, { role: "viewer", expiresAt: iso(T0 + DAY) }), false);
});

test("the panel shows each member's access, expiry and status", () => {
  const v = memberAccessView({ role: "editor", permissions: null, expires_at: iso(T0 + 3 * DAY) }, T0);
  assert.equal(v.accessLabel, "Full Access");
  assert.equal(v.status, "active");
  assert.match(v.expiryText ?? "", /^Expires in 3 days/);
  const e = memberAccessView({ role: "viewer", expires_at: iso(T0 - DAY) }, T0);
  assert.equal(e.status, "expired");
  assert.equal(e.expired, true);
  const o = memberAccessView({ role: "owner", is_owner: true, expires_at: iso(T0 - DAY) }, T0);
  assert.equal(o.status, "owner");
  assert.equal(o.expiresAt, null);
  const c = memberAccessView({ role: "custom", permissions: { modules: { data: "view" } } }, T0);
  assert.equal(c.accessLabel, "Custom");
  assert.equal(c.permissions!.modules.data, "view");
});

test("the history: invitations, grants, changes, removals — and expiries derived from the date", () => {
  const rows = [
    { id: 1, action: "project.invitation_sent", entity: "survey", entityId: "s", userId: "o", actorName: "Olga", detail: { targetEmail: "x@y.z", role: "Custom" }, createdAt: iso(T0 - 5 * DAY) },
    { id: 2, action: "project.shared", entity: "survey", entityId: "s", userId: "o", actorName: "Olga", detail: { targetName: "Ana", role: "View Only" }, createdAt: iso(T0 - 4 * DAY) },
    { id: 3, action: "project.permission_changed", entity: "survey", entityId: "s", userId: "o", actorName: "Olga", detail: { targetName: "Ana", changes: ["Data: View → None"] }, createdAt: iso(T0 - 3 * DAY) },
    { id: 4, action: "survey.saved", entity: "survey", entityId: "s", userId: "o", actorName: "Olga", detail: {}, createdAt: iso(T0 - 2 * DAY) },
    { id: 5, action: "project.access_removed", entity: "survey", entityId: "s", userId: "o", actorName: "Olga", detail: { targetName: "Ben" }, createdAt: iso(T0 - DAY) },
  ];
  const h = accessHistory(rows, [{ userId: "a", name: "Ana", expiresAt: iso(T0 - DAY / 2) }, { userId: "b", name: "Cy", expiresAt: iso(T0 + DAY) }], T0);
  assert.deepEqual(h.map((e) => e.action), ["project.access_expired", "project.access_removed", "project.permission_changed", "project.shared", "project.invitation_sent"]);
  assert.equal(h[0].text, "Ana's access expired on 2026-10-17");
  assert.equal(h[2].text, "Olga changed Ana's access — Data: View → None");
  assert.deepEqual(h[2].changes, ["Data: View → None"]);
  assert.equal(h[3].text, "Olga shared this project with Ana as View Only");
  assert.ok(!h.some((e) => e.action === "survey.saved"), "only membership events");
});
