import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesOf, customCapabilities } from "@rescript/access";
import { analyticsPermissions } from "./analyticsAccess.ts";

/*
 * THE APPLY AUDIT (2026-10-17): a custom member with Data Analytics: Edit must
 * see the workspace and its Apply. The page used to ask `can("custom", …)`,
 * which answers from the custom floor only.
 */
const custom = (analytics: string, programming = "view") => [...customCapabilities({ v: 1, modules: { analytics, programming } })];

test("a custom member with Data Analytics: Edit may read and apply, but not change the survey's plan", () => {
  const p = analyticsPermissions("custom", custom("edit"));
  assert.deepEqual(p, { waiting: false, canRead: true, canEdit: true, canEditPlan: false, canPublish: false, canExport: false });
});

test("Data Analytics: Manage adds publish and export; View reads only; None is refused", () => {
  assert.equal(analyticsPermissions("custom", custom("manage")).canExport, true);
  assert.equal(analyticsPermissions("custom", custom("manage")).canPublish, true);
  const v = analyticsPermissions("custom", custom("view"));
  assert.equal(v.canRead, true); assert.equal(v.canEdit, false);
  assert.equal(analyticsPermissions("custom", custom("none")).canRead, false);
});

test("before the membership's capabilities arrive, a custom member waits instead of being told 'no access'", () => {
  const p = analyticsPermissions("custom", null);
  assert.equal(p.waiting, true); assert.equal(p.canRead, false); assert.equal(p.canEdit, false);
});

test("fixed roles answer from the role alone and agree with the membership's set", () => {
  for (const role of ["owner", "editor", "viewer"] as const) {
    const alone = analyticsPermissions(role, null);
    assert.equal(alone.waiting, false);
    assert.deepEqual(alone, analyticsPermissions(role, capabilitiesOf(role)), role);
  }
  assert.equal(analyticsPermissions("owner", null).canEdit, true);
  assert.equal(analyticsPermissions("viewer", null).canEdit, false);
  assert.equal(analyticsPermissions(null, null).canRead, false);
});

test("the access check never hangs: once the request settles without capabilities, the role answers", () => {
  const p = analyticsPermissions("custom", null, { settled: true });
  assert.equal(p.waiting, false);
  assert.equal(p.canRead, false, "the custom floor, as before — the server still enforces");
  assert.equal(analyticsPermissions("owner", null, { settled: true }).canEdit, true);
});
