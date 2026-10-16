import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideCut, isMissingFunction, isVersionCollision } from "./versionCut.ts";

/*
 * ARCH-13 — the version cut is one transaction (`rescript_cut_version`,
 * migration 0059). The route's reading of the RPC's answer, and the rule that
 * the two-step path runs only when the function is missing.
 */

test("a cut row becomes the new version and revision (array or single-row shape)", () => {
  const row = { outcome: "cut", version_id: "v-1", cut_version: "1.3", revision: 8 };
  assert.deepEqual(decideCut({ data: [row], error: null }), { kind: "cut", versionId: "v-1", version: "1.3", revision: 8 });
  assert.deepEqual(decideCut({ data: row, error: null }), { kind: "cut", versionId: "v-1", version: "1.3", revision: 8 });
  // bigint revisions may arrive as strings
  assert.deepEqual(decideCut({ data: [{ ...row, revision: "9" }], error: null }), { kind: "cut", versionId: "v-1", version: "1.3", revision: 9 });
});

test("a stale base revision is a conflict carrying the server's revision; nothing to clean up", () => {
  assert.deepEqual(decideCut({ data: [{ outcome: "conflict", version_id: null, cut_version: null, revision: 12 }], error: null }), { kind: "conflict", revision: 12 });
});

test("a taken version number asks for the next number; a missing survey is not_found", () => {
  assert.deepEqual(decideCut({ data: [{ outcome: "version_taken", version_id: null, cut_version: "1.3", revision: 4 }], error: null }), { kind: "version_taken" });
  assert.deepEqual(decideCut({ data: [{ outcome: "not_found" }], error: null }), { kind: "not_found" });
});

test("only a MISSING function falls back to the two-step path; any other error is an error", () => {
  for (const error of [
    { code: "PGRST202", message: "Could not find the function public.rescript_cut_version(p_base_revision, p_created_by, ...) in the schema cache" },
    { message: "Could not find the function public.rescript_cut_version(p_survey_id) in the schema cache" },
    { code: "42883", message: "function public.rescript_cut_version(uuid, text) does not exist" },
    { message: "function rescript_cut_version(uuid, text, jsonb) does not exist" },
  ]) assert.deepEqual(decideCut({ data: null, error }), { kind: "legacy" }, error.message);

  assert.deepEqual(decideCut({ data: null, error: { message: "permission denied for table surveys", code: "42501" } }), { kind: "error", message: "permission denied for table surveys" });
  // a different missing function is not ours
  assert.equal(isMissingFunction({ message: "Could not find the function public.rescript_finalize_version(...)" }), false);
  assert.equal(isMissingFunction(null), false);
});

test("an empty or unknown answer is an error, never a silent success", () => {
  assert.equal(decideCut({ data: [], error: null }).kind, "error");
  assert.equal(decideCut({ data: null, error: null }).kind, "error");
  assert.equal(decideCut({ data: [{ outcome: "cut", version_id: null }], error: null }).kind, "error");
  assert.equal(decideCut({ data: [{ outcome: "maybe" }], error: null }).kind, "error");
});

test("the two-step path's collision check matches the constraint name and SQLSTATE", () => {
  assert.equal(isVersionCollision('duplicate key value violates unique constraint "survey_versions_survey_id_version_key"'), true);
  assert.equal(isVersionCollision("23505"), true);
  assert.equal(isVersionCollision("permission denied"), false);
  assert.equal(isVersionCollision(undefined), false);
});

test("the route calls the atomic RPC first, keeps the two-step path behind `legacy`, and has no pre-0003 retry", () => {
  const route = readFileSync(new URL("../app/api/surveys/[id]/versions/route.ts", import.meta.url), "utf8");
  const atomic = route.indexOf('db.rpc("rescript_cut_version"');
  const insert = route.indexOf('.from("survey_versions")\n      .insert(');
  assert.ok(atomic > 0 && insert > atomic, "rescript_cut_version is tried before the plain insert");
  assert.match(route, /for \(let attempt = 0; legacy && attempt < 5/);
  assert.doesNotMatch(route, /Retry without the draft columns/);
  assert.doesNotMatch(route, /update\(\{ current_version_id: ver\.id, title: def\.meta\.title \}\)/);
});

test("migration 0059 defines rescript_cut_version with the parameters the route sends", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/0059_cut_version_atomic.sql", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/surveys/[id]/versions/route.ts", import.meta.url), "utf8");
  const call = /db\.rpc\("rescript_cut_version", \{([\s\S]*?)\}\)\);/.exec(route);
  assert.ok(call);
  const sent = [...call[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]).sort();
  const sig = /create function public\.rescript_cut_version\(([\s\S]*?)\)\s*returns/.exec(sql);
  assert.ok(sig);
  const declared = [...sig[1].matchAll(/(p_[a-z_]+)\s/g)].map((m) => m[1]).sort();
  assert.deepEqual(sent, declared);
  assert.match(sql, /for update/);
  assert.match(sql, /exception when unique_violation/);
  assert.match(sql, /revoke all on function public\.rescript_cut_version/);
});
