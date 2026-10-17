import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCESS_MODULES, ACCESS_OPTIONS, ACCESS_PRESETS, BASELINE_ROLES, CAPABILITIES, EDITING_ROLES, GRANTABLE_ROLES,
  OWNER_ONLY, PROJECT_ROLES, ROLE_DESCRIPTION, ROLE_LABEL,
  accessLabel, can, capabilitiesOf, capabilitySet, copyAccess, customCapabilities, decideAccess, describeEvent,
  describeExpiry, diffAccess, escalation, isAuditEvent, isExpired, levelsOf, moduleCapabilities, normalizePermissions,
  permissionsFromGrant, presetById, previewAccess, resolveExpiry, searchPermissions, setModuleLevel, toggleCapability,
  validateExpiry, workspaceAccessPolicy,
  type AccessLevel, type AccessModuleId, type Capability, type MemberGrant, type ProjectRole,
} from "./index.js";

/**
 * COLLABORATORS & ADVANCED ACCESS (2026-10-17).
 *
 * The first test is the one that matters most: it was written from a
 * snapshot taken BEFORE any of this was changed, and it proves every role a
 * member can hold today answers every question it could be asked yesterday
 * exactly as it did. A stored role means what it meant.
 */

const T0 = Date.parse("2026-10-17T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const custom = (permissions: unknown, expiresAt: string | null = null): MemberGrant => ({ role: "custom", permissions, expiresAt });

/* ============================================================ backward compatibility */

/* `capabilitiesOf(role).sort()` for every role, captured from the build of 2026-10-17 before this change */
const BEFORE: Record<string, Capability[]> = {
  owner: ["analytics.edit","analytics.export","analytics.publish","analytics.read","billing.read","billing.request_credits","billing.set_budget","billing.transfer","comment.create","comment.resolve","deploy.manage","lock.acquire","lock.force_release","lock.request","project.clone","project.delete","project.lock_settings","project.manage_members","project.read","project.read_activity","project.read_members","project.share","project.transfer","responses.export","responses.manage","responses.read","survey.edit","survey.save_version"] as Capability[],
  editor: ["analytics.edit","analytics.export","analytics.publish","analytics.read","billing.read","billing.request_credits","comment.create","comment.resolve","deploy.manage","lock.acquire","lock.request","project.clone","project.read","project.read_activity","project.read_members","project.share","responses.export","responses.manage","responses.read","survey.edit","survey.save_version"] as Capability[],
  programmer: ["analytics.edit","analytics.export","analytics.read","billing.read","comment.create","comment.resolve","lock.acquire","lock.request","project.clone","project.read","project.read_activity","project.read_members","responses.export","responses.read","survey.edit","survey.save_version"] as Capability[],
  reviewer: ["analytics.export","analytics.read","billing.read","comment.create","comment.resolve","lock.request","project.read","project.read_activity","project.read_members","responses.export","responses.read"] as Capability[],
  viewer: ["analytics.read","project.read","project.read_members","responses.read"] as Capability[],
  test_user: ["comment.create","lock.request","project.read","project.read_members"] as Capability[],
  deployment_manager: ["analytics.export","analytics.read","billing.read","comment.create","deploy.manage","lock.request","project.read","project.read_activity","project.read_members","responses.export","responses.read"] as Capability[],
};
const CAPABILITIES_BEFORE = ["project.read","project.read_activity","project.read_members","responses.read","responses.export","survey.edit","survey.save_version","responses.manage","deploy.manage","comment.create","comment.resolve","lock.acquire","lock.force_release","lock.request","project.share","project.manage_members","project.transfer","project.delete","project.lock_settings","analytics.read","analytics.edit","analytics.publish","analytics.export","billing.read","billing.request_credits","billing.transfer","billing.set_budget","project.clone"];
const NEW_CAPABILITIES: Capability[] = ["responses.read_pii", "fieldwork.read"];
const LEGACY_ROLES = Object.keys(BEFORE) as ProjectRole[];

test("backward compatibility: every existing role answers every existing capability exactly as before", () => {
  assert.deepEqual(CAPABILITIES.slice(0, CAPABILITIES_BEFORE.length), CAPABILITIES_BEFORE, "the old capabilities keep their names and order");
  assert.deepEqual(PROJECT_ROLES.slice(0, LEGACY_ROLES.length), LEGACY_ROLES, "the old roles keep their names and order");
  for (const role of LEGACY_ROLES) {
    for (const cap of CAPABILITIES_BEFORE as Capability[]) {
      assert.equal(can(role, cap), BEFORE[role].includes(cap), `${role} / ${cap} must be unchanged`);
    }
    assert.deepEqual(capabilitiesOf(role).filter((c) => CAPABILITIES_BEFORE.includes(c)).sort(), BEFORE[role], `${role}'s old capability set`);
  }
});

test("backward compatibility: the two new capabilities go to exactly the roles that held responses.read", () => {
  for (const role of LEGACY_ROLES) {
    const newOnes = capabilitiesOf(role).filter((c) => !CAPABILITIES_BEFORE.includes(c));
    assert.deepEqual(newOnes.sort(), BEFORE[role].includes("responses.read") ? [...NEW_CAPABILITIES].sort() : [],
      `${role} gains only the split of a power it already had`);
  }
  assert.deepEqual(BASELINE_ROLES, ["editor", "programmer", "reviewer", "viewer", "test_user", "deployment_manager"]);
  assert.deepEqual(GRANTABLE_ROLES.slice(0, 6), BASELINE_ROLES, "the old share dialog's roles, in the old order");
  assert.deepEqual(EDITING_ROLES, ["owner", "editor", "programmer", "project_admin"]);
});

test("backward compatibility: the workspace baseline list is the one the SQL accepts", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/0009_session_persistence_fixes.sql", import.meta.url), "utf8");
  const m = /if val not in \(([^)]*)\)/.exec(sql);
  assert.ok(m, "rescript_workspace_default_role's list is where it was");
  assert.deepEqual(m![1].split(",").map((s) => s.trim().replace(/'/g, "")), BASELINE_ROLES);
  assert.equal(workspaceAccessPolicy({ defaultRole: "custom" }).defaultRole, null, "custom needs permissions; it cannot be a baseline");
  assert.equal(workspaceAccessPolicy({ defaultRole: "project_admin" }).defaultRole, null, "nor can a new role the SQL does not know");
  assert.equal(workspaceAccessPolicy({ defaultRole: "viewer" }).defaultRole, "viewer");
});

test("a bare role, a role with stray permissions and a non-expiring membership all answer the same", () => {
  for (const role of PROJECT_ROLES.filter((r) => r !== "custom")) {
    for (const cap of CAPABILITIES) {
      const bare = can(role, cap);
      assert.equal(can({ role }, cap), bare);
      assert.equal(can({ role, permissions: { modules: { data: "manage", admin: "view" }, add: ["project.share"] }, expiresAt: null }, cap), bare,
        `permissions are read only for custom; ${role}/${cap}`);
    }
  }
});

/* ============================================================ every role */

const PINNED: Partial<Record<ProjectRole, Capability[]>> = {
  project_admin: ["project.read","project.read_activity","project.read_members","responses.read","responses.export","survey.edit","survey.save_version","responses.manage","deploy.manage","comment.create","comment.resolve","lock.acquire","lock.force_release","lock.request","project.share","project.manage_members","project.lock_settings","analytics.read","analytics.edit","analytics.publish","analytics.export","billing.read","billing.request_credits","project.clone","responses.read_pii","fieldwork.read"],
  viewer_data: ["project.read","project.read_members","responses.read","responses.export","analytics.read","analytics.export","responses.read_pii","fieldwork.read"],
  vendor: ["project.read","fieldwork.read"],
  interviewer: ["project.read","comment.create","fieldwork.read"],
  custom: ["project.read"],
};

test("every new role's capability set is pinned", () => {
  for (const [role, caps] of Object.entries(PINNED)) {
    assert.deepEqual(capabilitiesOf(role as ProjectRole), caps, role);
  }
  for (const r of PROJECT_ROLES) {
    assert.ok(ROLE_LABEL[r] && ROLE_DESCRIPTION[r], `${r} is labelled and described`);
  }
});

test("Project Admin manages people and settings but holds none of ownership's four powers", () => {
  for (const c of ["project.share", "project.manage_members", "project.lock_settings", "lock.force_release", "survey.edit", "deploy.manage"] as const) {
    assert.equal(can("project_admin", c), true, c);
  }
  for (const c of OWNER_ONLY) assert.equal(can("project_admin", c), false, `${c} stays with the owner`);
});

test("vendor and interviewer never see a response, a respondent or the team", () => {
  for (const r of ["vendor", "interviewer"] as const) {
    for (const c of ["responses.read", "responses.export", "responses.read_pii", "analytics.read", "survey.edit", "deploy.manage", "project.share"] as const) {
      assert.equal(can(r, c), false, `${r} must not ${c}`);
    }
    assert.equal(can(r, "fieldwork.read"), true);
  }
  assert.equal(can("vendor", "project.read_members"), false, "an outside vendor is not shown the team");
});

test("the access options map onto stored roles, and every grantable role is offered", () => {
  const byLabel = Object.fromEntries(ACCESS_OPTIONS.map((o) => [o.label, o.role]));
  assert.deepEqual(byLabel, {
    "Project Admin": "project_admin", "Full Access": "editor", "Edit Access": "programmer", "View Only": "viewer",
    "View Only with Data": "viewer_data", "Vendor Access": "vendor", "Interview Only": "interviewer", "Custom": "custom",
    "Reviewer": "reviewer", "Test user": "test_user", "Deployment manager": "deployment_manager",
  });
  assert.deepEqual([...new Set(ACCESS_OPTIONS.map((o) => o.role))].sort(), [...GRANTABLE_ROLES].sort());
  assert.ok(!ACCESS_OPTIONS.some((o) => o.role === "owner"), "ownership is transferred, never offered");
  assert.equal(accessLabel("editor"), "Full Access");
  assert.equal(accessLabel("owner"), "Owner");
  assert.equal(accessLabel(null), "No access");
});

/* ============================================================ custom permissions */

test("module levels are the platform's real modules, and the questionnaire can never be hidden", () => {
  assert.deepEqual(ACCESS_MODULES.map((m) => m.id), ["programming", "deployment", "fieldwork", "data", "analytics", "collaboration", "usage", "admin"]);
  assert.deepEqual(levelsOf("programming"), ["view", "edit", "manage"]);
  assert.deepEqual(levelsOf("data"), ["none", "view", "edit", "manage"]);
  assert.deepEqual(levelsOf("admin"), ["none", "view"], "administration has no Manage level");
  assert.deepEqual(levelsOf("fieldwork"), ["none", "view"]);
  const floor = customCapabilities(normalizePermissions({ modules: { programming: "none" } }));
  assert.ok(floor.has("project.read"), "programming: none is not a level; it reads as the default (view)");
});

test("Data: None means no response data at all — and the guard's decision says so", () => {
  const g = custom({ modules: { data: "none", analytics: "manage", programming: "manage" } });
  for (const c of ["responses.read", "responses.export", "responses.manage", "responses.read_pii"] as const) {
    assert.equal(can(g, c), false, c);
  }
  const d = decideAccess({ userId: "u", customerId: "c", isPlatformAdmin: false }, g, "responses.export", "member");
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "insufficient_role", "a member without it: 403, not 404");
});

test("View-only programming cannot save the survey, take the edit lock or cut a version", () => {
  const g = custom({ modules: { programming: "view", data: "manage" } });
  assert.equal(can(g, "project.read"), true);
  for (const c of ["survey.edit", "lock.acquire", "survey.save_version", "project.clone"] as const) assert.equal(can(g, c), false, c);
  const e = custom({ modules: { programming: "edit" } });
  assert.equal(can(e, "survey.edit"), true);
  assert.equal(can(e, "lock.acquire"), true, "editing needs the lock, so it comes with it");
  assert.equal(can(e, "survey.save_version"), false, "versions are Manage");
  const noEdit = custom({ modules: { programming: "manage" }, remove: ["survey.edit"] });
  assert.equal(can(noEdit, "lock.acquire"), false, "no edit, no lock");
  assert.equal(can(noEdit, "survey.save_version"), false, "a version needs the lock, so it needs edit");
});

test("Manage never implies inviting, access changes, settings, lock release, transfer or deletion", () => {
  const all: Partial<Record<AccessModuleId, AccessLevel>> = {};
  for (const m of ACCESS_MODULES) all[m.id] = levelsOf(m.id).at(-1)!;
  const g = custom({ modules: all });
  for (const c of ["project.share", "project.manage_members", "project.lock_settings", "lock.force_release", ...OWNER_ONLY] as Capability[]) {
    assert.equal(can(g, c), false, `every module at its highest level still must not ${c}`);
  }
  const admin = custom({ modules: { admin: "view" }, add: ["project.share", "project.manage_members"] });
  assert.equal(can(admin, "project.share"), true, "administration is ticked explicitly");
  assert.equal(can(admin, "project.manage_members"), true);
  const sneaky = custom({ modules: all, add: [...OWNER_ONLY, "project.share"] });
  for (const c of OWNER_ONLY) assert.equal(can(sneaky, c), false, `${c} can never be ticked onto anyone`);
  assert.equal(can(custom({ modules: { admin: "none" }, add: ["project.share"] }), "project.share"), false,
    "a tick on a module at None is ignored by the model (the UI raises the level first)");
});

test("viewing reports never grants raw data, contact details or the dataset", () => {
  const g = custom({ modules: { analytics: "manage", data: "none" } });
  assert.equal(can(g, "analytics.read"), true);
  assert.equal(can(g, "analytics.export"), true, "a report download is a report");
  for (const c of ["responses.read", "responses.export", "responses.read_pii"] as const) assert.equal(can(g, c), false, c);
  for (const m of ACCESS_MODULES.filter((x) => x.id !== "data")) {
    for (const l of levelsOf(m.id)) {
      for (const c of moduleCapabilities(m.id, l)) assert.ok(!c.startsWith("responses."), `${m.id}/${l} must not carry ${c}`);
    }
  }
  const viewData = custom({ modules: { data: "view" }, add: ["responses.export"] });
  assert.equal(can(viewData, "responses.export"), true, "data view + export: the custom form of View Only with Data");
  assert.equal(can(viewData, "responses.read_pii"), false, "and contact details are their own tick");
});

test("stored permissions are read defensively: unknown things are dropped, never passed through", () => {
  const p = normalizePermissions({ v: 9, modules: { data: "godmode", nope: "manage", analytics: "view" }, add: ["project.transfer", "x.y", "responses.export"], remove: [42] });
  assert.equal(p.modules.data, "none", "an unknown level is the module's default");
  assert.equal(p.modules.analytics, "view");
  assert.ok(!("nope" in p.modules));
  assert.deepEqual(p.add ?? [], [], "owner-only and unknown capabilities are not advanced; export on Data: None is ignored");
  assert.equal(p.remove, undefined);
  for (const junk of [null, undefined, "x", 3, [], { modules: [] }]) {
    assert.deepEqual([...customCapabilities(junk)].sort(), ["lock.request", "project.read"], `junk ${JSON.stringify(junk)} is the floor`);
  }
  assert.deepEqual(capabilitiesOf({ role: "custom" }), ["project.read", "lock.request"], "custom with no permissions: open the project, nothing more");
});

test("every fixed role can be expressed as custom (the cards' starting point), give or take asking for the lock", () => {
  for (const role of PROJECT_ROLES.filter((r) => r !== "custom")) {
    const fixed = new Set(capabilitySet(role));
    for (const c of OWNER_ONLY) fixed.delete(c);
    const back = customCapabilities(permissionsFromGrant(role));
    const strip = (s: Iterable<Capability>) => [...s].filter((c) => c !== "lock.request").sort();
    assert.deepEqual(strip(back), strip(fixed), `${role} → custom → capabilities`);
  }
});

test("the segmented control and the advanced ticks", () => {
  let p = normalizePermissions({});
  p = setModuleLevel(p, "data", "view");
  p = toggleCapability(p, "responses.export", true);
  assert.equal(can(custom(p), "responses.export"), true);
  p = setModuleLevel(p, "data", "edit");
  assert.equal(can(custom(p), "responses.export"), false, "a new level is a new starting point for that module");
  p = toggleCapability(p, "project.share", true);
  assert.equal(p.modules.admin, "view", "ticking on a module at None raises it to its first level");
  assert.equal(can(custom(p), "project.share"), true);
  p = toggleCapability(p, "responses.manage", false);
  assert.equal(can(custom(p), "responses.manage"), false);
  assert.equal(can(custom(p), "responses.read"), true);
  assert.equal(setModuleLevel(p, "admin", "manage").modules.admin, "view", "a level the module does not offer is refused");
});

/* ============================================================ presets */

test("presets are editable starting points with the access their names promise", () => {
  assert.deepEqual(ACCESS_PRESETS.map((p) => p.label), ["Survey Programmer", "Data Analyst", "External Vendor", "Client / Stakeholder"]);
  const g = (id: string) => custom(presetById(id)!.permissions);
  const prog = g("survey_programmer");
  assert.equal(can(prog, "survey.edit"), true);
  assert.equal(can(prog, "survey.save_version"), true);
  assert.equal(can(prog, "deploy.manage"), false);
  assert.equal(can(prog, "responses.export"), false);
  const analyst = g("data_analyst");
  assert.equal(can(analyst, "responses.export"), true);
  assert.equal(can(analyst, "analytics.publish"), true);
  assert.equal(can(analyst, "responses.read_pii"), false, "an analyst does not need to know who answered");
  assert.equal(can(analyst, "survey.edit"), false);
  const vendor = g("external_vendor");
  assert.deepEqual(capabilitiesOf(vendor), ["project.read", "lock.request", "fieldwork.read"]);
  const client = g("client_stakeholder");
  assert.equal(can(client, "analytics.read"), true);
  assert.equal(can(client, "comment.create"), true);
  for (const c of ["responses.read", "responses.export", "responses.read_pii", "project.read_members"] as const) assert.equal(can(client, c), false, c);
  for (const p of ACCESS_PRESETS) {
    for (const c of ["project.share", "project.manage_members", ...OWNER_ONLY] as Capability[]) assert.equal(can(custom(p.permissions), c), false, `${p.id} / ${c}`);
    assert.deepEqual(normalizePermissions(p.permissions), p.permissions, `${p.id} is already normal`);
  }
  assert.equal(presetById("nope"), null);
});

/* ============================================================ expiry */

test("expired access is denied everything, and says it expired", () => {
  const past = { role: "editor" as const, expiresAt: iso(T0 - 1000) };
  const future = { role: "editor" as const, expiresAt: iso(T0 + DAY) };
  assert.equal(isExpired(past, T0), true);
  assert.equal(can(past, "project.read", T0), false);
  assert.deepEqual(capabilitiesOf(past, T0), []);
  assert.equal(can(future, "survey.edit", T0), true);
  assert.equal(can(future, "survey.edit", T0 + 2 * DAY), false, "and it ends by itself, with no job to run");
  const d = decideAccess({ userId: "u", customerId: "c", isPlatformAdmin: false }, past, "project.read", "member", T0);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "access_expired");
  assert.equal(can({ role: "owner", expiresAt: iso(T0 - DAY) }, "project.delete", T0), true, "ownership never expires");
  assert.equal(can({ role: "viewer", expiresAt: "not a date" }, "project.read", T0), false, "an unreadable end date closes the door");
  assert.equal(can(custom({ modules: { data: "view" } }, iso(T0 - 1)), "responses.read", T0), false);
  const admin = decideAccess({ userId: "u", customerId: "c", isPlatformAdmin: true }, past, "lock.force_release", "member", T0);
  assert.equal(admin.allowed, true, "a platform admin's operational duties do not depend on a membership");
});

test("the expiry picker: 1 day, 7, 30, a custom date, or none — enforced bounds", () => {
  assert.deepEqual(resolveExpiry("none", null, T0), { ok: true, expiresAt: null });
  assert.deepEqual(resolveExpiry("1d", null, T0), { ok: true, expiresAt: iso(T0 + DAY) });
  assert.deepEqual(resolveExpiry("7d", null, T0), { ok: true, expiresAt: iso(T0 + 7 * DAY) });
  assert.deepEqual(resolveExpiry("30d", null, T0), { ok: true, expiresAt: iso(T0 + 30 * DAY) });
  assert.deepEqual(resolveExpiry("custom", "2026-11-01", T0), { ok: true, expiresAt: "2026-11-01T23:59:59.000Z" });
  assert.equal(resolveExpiry("custom", "2026-10-01", T0).ok, false, "the past is refused");
  assert.equal(resolveExpiry("custom", "2040-01-01", T0).ok, false, "a decade is a typo");
  assert.equal(resolveExpiry("custom", "soon", T0).ok, false);
  assert.equal(resolveExpiry("bogus", null, T0).ok, false);
  assert.equal(validateExpiry("", T0).ok, true);
  assert.match(describeExpiry(iso(T0 + 6.5 * DAY), T0), /^Expires in 7 days \(2026-10-24\)$/);
  assert.match(describeExpiry(iso(T0 - 2 * DAY), T0), /^Expired 2 days ago/);
  assert.match(describeExpiry(iso(T0 + 3 * 3_600_000), T0), /^Expires in 3 hours/);
  assert.equal(describeExpiry(null, T0), "No expiry");
});

/* ============================================================ copy, escalation, preview, search, history */

test("copying a collaborator copies the access, not the expiry", () => {
  const from = { role: "custom", permissions: { modules: { data: "view" } }, expiresAt: iso(T0 + DAY) };
  const c = copyAccess(from)!;
  assert.equal(c.role, "custom");
  assert.equal(c.permissions!.modules.data, "view");
  assert.ok(!("expiresAt" in c));
  assert.deepEqual(copyAccess({ role: "editor" }), { role: "editor", permissions: null });
  assert.deepEqual(copyAccess({ role: "owner" }), { role: "project_admin", permissions: null }, "the owner's access copies as the closest grantable one");
  assert.equal(copyAccess({ role: "nonsense" }), null);
});

test("nobody grants what they do not hold", () => {
  assert.deepEqual(escalation("owner", { role: "project_admin" }), []);
  assert.deepEqual(escalation("editor", { role: "programmer" }), [], "an editor may invite a programmer, as before");
  for (const r of BASELINE_ROLES) assert.deepEqual(escalation("editor", { role: r }), [], `editor → ${r} keeps working`);
  assert.deepEqual(escalation("editor", { role: "project_admin" }), ["lock.force_release", "project.manage_members", "project.lock_settings"]);
  assert.deepEqual(escalation("editor", { role: "custom", permissions: { modules: { admin: "view" }, add: ["project.manage_members"] } }), ["project.manage_members"]);
  assert.deepEqual(escalation("project_admin", { role: "project_admin" }), []);
  assert.ok(escalation({ role: "editor", expiresAt: iso(T0 - 1) }, { role: "viewer" }, T0).length > 0, "an expired granter holds nothing");
});

test("the preview says what is allowed and what is not, in words, from the enforced set", () => {
  const p = previewAccess(custom({ modules: { programming: "view", analytics: "view", data: "none" } }));
  const allowed = p.allowed.flatMap((g) => g.items);
  assert.ok(allowed.includes("Open the project and read the questionnaire"));
  assert.ok(allowed.includes("View analyses, dashboards and reports"));
  assert.ok(!allowed.some((s) => /response data/i.test(s)));
  assert.ok(p.restricted.includes("Export / download the response dataset"));
  assert.ok(p.restricted.includes("See respondent contact details (names, emails, IDs)"));
  assert.ok(p.restricted.includes("Delete the project (owner only)"));
  assert.match(p.summary, /^Custom · \d+ of \d+ permissions$/);
  assert.match(previewAccess({ role: "viewer", expiresAt: iso(T0 - 1) }, T0).summary, /expired/i);
  const full = previewAccess("editor");
  assert.equal(full.allowed.flatMap((g) => g.items).length + full.restricted.length, CAPABILITIES.length - 2, "every capability is on exactly one side (lock plumbing aside)");
});

test("searching “Export” finds the exports across modules", () => {
  const hits = searchPermissions("Export");
  assert.deepEqual(hits.map((h) => h.capability).sort(), ["analytics.export", "responses.export"]);
  assert.deepEqual([...new Set(hits.map((h) => h.module))].sort(), ["analytics", "data"]);
  assert.deepEqual(searchPermissions("pii").map((h) => h.capability), ["responses.read_pii"]);
  assert.ok(searchPermissions("invite").some((h) => h.capability === "project.share"));
  assert.deepEqual(searchPermissions("   "), []);
  assert.deepEqual(searchPermissions("export powerpoint").map((h) => h.capability), ["analytics.export"], "every word must match");
});

test("the activity history says what changed", () => {
  const before = { role: "custom" as const, permissions: { modules: { data: "view" } }, expiresAt: null };
  const after = { role: "custom" as const, permissions: { modules: { data: "none" } }, expiresAt: "2026-11-01T23:59:59.000Z" };
  const d = diffAccess(before, after);
  assert.ok(d.includes("Data: View → None"));
  assert.ok(d.includes("Removed: View response data and data quality"));
  assert.ok(d.includes("Expiry: none → 2026-11-01"));
  assert.deepEqual(diffAccess({ role: "viewer" }, { role: "editor" }), ["Access: View Only → Full Access"]);
  assert.deepEqual(diffAccess({ role: "viewer" }, { role: "viewer" }), []);

  for (const e of ["project.invitation_resent", "project.access_expired"]) assert.ok(isAuditEvent(e));
  const row = (action: string, detail: Record<string, unknown>) => ({ id: 1, action, entity: "survey", entityId: "s", userId: "u", actorName: "Sam", detail, createdAt: iso(T0) });
  assert.equal(describeEvent(row("project.permission_changed", { targetName: "Ana", changes: d })), "Sam changed Ana's access — Data: View → None; Removed: View response data and data quality; Expiry: none → 2026-11-01");
  assert.equal(describeEvent(row("project.permission_changed", { targetName: "Ana", role: "Editor" })), "Sam changed Ana's role to Editor", "old rows read as before");
  assert.equal(describeEvent(row("project.shared", { targetName: "Ana", role: "Custom", expiresAt: "2026-11-01T00:00:00Z" })), "Sam shared this project with Ana as Custom, until 2026-11-01");
  assert.equal(describeEvent(row("project.invitation_resent", { targetEmail: "a@x.com" })), "Sam re-sent the invitation to a@x.com");
  assert.equal(describeEvent(row("project.access_expired", { targetName: "Ana", expiresAt: "2026-10-20T00:00:00Z" })), "Ana's access expired on 2026-10-20");
});
