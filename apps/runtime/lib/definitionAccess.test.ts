import { test } from "node:test";
import assert from "node:assert/strict";
import { definitionAccess, DENY_CACHE_CONTROL, SERVE_CACHE_CONTROL } from "./definitionAccess.ts";

/* RUNTIME-11: a definition is served only while an active LIVE deployment pins it and the survey is open. */
const V = "0b7d6c1e-3f7a-4c2e-9a51-1d2e3f4a5b6c";
const OTHER = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

test("an active live deployment of an open survey is served with a bounded public cache", () => {
  const r = definitionAccess({ versionId: V, deployments: [{ version_id: V, mode: "live", active: true }], surveyStatus: "live" });
  assert.equal(r.serve, true);
  assert.equal(r.cacheControl, SERVE_CACHE_CONTROL);
  assert.doesNotMatch(r.cacheControl, /immutable/);
  assert.match(r.cacheControl, /s-maxage=\d+/);
});

test("a version no deployment points at is refused, privately", () => {
  const r = definitionAccess({ versionId: V, deployments: [], surveyStatus: "live" });
  assert.deepEqual(r, { serve: false, reason: "no_active_deployment", cacheControl: DENY_CACHE_CONTROL });
});

test("a superseded (inactive) deployment is refused", () => {
  const r = definitionAccess({ versionId: V, deployments: [{ version_id: V, mode: "live", active: false }], surveyStatus: "live" });
  assert.equal(r.serve, false);
});

test("a TEST deployment does not open the route — test links embed their build inline", () => {
  const r = definitionAccess({ versionId: V, deployments: [{ version_id: V, mode: "test", active: true }], surveyStatus: "testing" });
  assert.equal(r.serve, false);
});

test("another version's deployment does not count", () => {
  const r = definitionAccess({ versionId: V, deployments: [{ version_id: OTHER, mode: "live", active: true }], surveyStatus: "live" });
  assert.equal(r.serve, false);
});

test("closed, archived and paused surveys are refused even with an active deployment", () => {
  for (const s of ["closed", "archived", "paused"]) {
    const r = definitionAccess({ versionId: V, deployments: [{ version_id: V, mode: "live", active: true }], surveyStatus: s });
    assert.equal(r.serve, false, s);
    if (!r.serve) assert.equal(r.reason, "survey_blocked");
    assert.equal(r.cacheControl, DENY_CACHE_CONTROL);
  }
});

test("a malformed id is refused before any lookup", () => {
  for (const bad of ["", "not-a-uuid", "------------------------------------", `${V}x`]) {
    const r = definitionAccess({ versionId: bad, deployments: [{ version_id: bad, mode: "live", active: true }], surveyStatus: "live" });
    assert.equal(r.serve, false, bad);
    if (!r.serve) assert.equal(r.reason, "bad_id");
  }
});

test("id comparison is case-insensitive", () => {
  const r = definitionAccess({ versionId: V.toUpperCase(), deployments: [{ version_id: V, mode: "live", active: true }], surveyStatus: "live" });
  assert.equal(r.serve, true);
});
