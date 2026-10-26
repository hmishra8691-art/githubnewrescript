import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeDb as FakeDbBase } from "../../../scripts/lib/fakeSupabase.mjs";
import { loadDashboardStats } from "./dashboardCore.ts";

/**
 * THE PROJECT LIST COUNTS THE DRAFT.
 *
 * `survey_dashboard_stats` and this fallback both counted questions from the
 * current version alone, while migration 0003 had made
 * `surveys.draft_definition` the Studio's source of truth for work in
 * progress. A survey whose version was cut at creation — before any question
 * existed — and whose questions have lived in the draft ever since reported
 * 0 questions on the list. Measured on the production database at the time:
 * 19 of 35 surveys undercounted, 10 of them showing 0, 454 questions missing
 * in total, the worst single survey reporting 0 for 103 questions.
 *
 * The fallback had a second fault of its own: it looked the version up
 * through the `current_version_id` the caller passed, and `/api/surveys`
 * builds every row with `current_version_id: null`, so it counted nothing at
 * all and every card showed "—".
 *
 * `FakeDb.rpc` only answers `rescript_save_draft`, so every test here takes
 * the fallback path, which is the one that lives in this file.
 */

class FakeDb extends FakeDbBase {
  as(): SupabaseClient { return this as unknown as SupabaseClient; }
}

/** a definition with n respondent-facing questions, all placed on one page */
const def = (n: number) => ({
  questions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, code: `Q${i}`, type: "single", text: `Q${i}` })),
  flow: { type: "sequence", children: [{ type: "page", id: "p1", questionIds: Array.from({ length: n }, (_, i) => `q${i}`) }] },
});

function seed(rows: { id: string; draft: number | null; version: number | null }[]) {
  const db = new FakeDb();
  (db as unknown as { tables: Record<string, unknown[]> }).tables.survey_versions = [];
  for (const r of rows) {
    const versionId = r.version == null ? null : `v-${r.id}`;
    db.tables.surveys.push({
      id: r.id,
      draft_definition: r.draft == null ? null : def(r.draft),
      current_version_id: versionId,
      created_by: null,
    });
    if (versionId) (db as unknown as { tables: Record<string, unknown[]> }).tables.survey_versions.push({ id: versionId, survey_id: r.id, definition: def(r.version!), created_by: null });
  }
  return db;
}

/** the shape `/api/surveys` actually passes: current_version_id is always null there */
const asRoutePasses = (ids: string[]) => ids.map((id) => ({ id, current_version_id: null, created_by: null }));

test("a draft built after its version was cut is counted, not reported as 0", async () => {
  const db = seed([
    { id: "s-built-in-draft", draft: 29, version: 0 },   // the reported bug: version cut empty at creation
    { id: "s-never-versioned", draft: 21, version: null },
    { id: "s-versioned-after", draft: 28, version: 28 }, // a version cut after building: unchanged
  ]);
  const r = await loadDashboardStats(db.as(), asRoutePasses(["s-built-in-draft", "s-never-versioned", "s-versioned-after"]));
  assert.equal(r.source, "fallback");
  assert.equal(r.stats["s-built-in-draft"].questionCount, 29, "29 questions in the draft were reported as 0");
  assert.equal(r.stats["s-never-versioned"].questionCount, 21);
  assert.equal(r.stats["s-versioned-after"].questionCount, 28);
  assert.ok(!r.warnings.some((w) => /question counts unavailable/.test(w)), JSON.stringify(r.warnings));
});

test("without a draft the current version is still what counts", async () => {
  // draft_definition NULL means "the draft equals the current version" (migration 0003)
  const db = seed([{ id: "s-no-draft", draft: null, version: 7 }]);
  const r = await loadDashboardStats(db.as(), asRoutePasses(["s-no-draft"]));
  assert.equal(r.stats["s-no-draft"].questionCount, 7);
});

test("a draft with questions removed counts fewer than its version, not more", async () => {
  // the one survey on the production database that moved DOWN: 5 in the version,
  // 3 in a draft saved a day later. The draft is the truth either way.
  const db = seed([{ id: "s-trimmed", draft: 3, version: 5 }]);
  const r = await loadDashboardStats(db.as(), asRoutePasses(["s-trimmed"]));
  assert.equal(r.stats["s-trimmed"].questionCount, 3);
});

test("an empty survey counts 0, and a failed lookup stays null", async () => {
  const db = seed([{ id: "s-empty", draft: null, version: null }]);
  const r = await loadDashboardStats(db.as(), asRoutePasses(["s-empty"]));
  assert.equal(r.stats["s-empty"].questionCount, 0, "no draft and no version is genuinely no questions");

  // a surveys table that errors degrades to null rather than to a misleading 0
  const broken = new Proxy(seed([{ id: "s-x", draft: 4, version: null }]), {
    get: (t, k) => (k === "from"
      ? (name: string) => (name === "surveys"
        ? { select: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) }
        : (t as unknown as { from: (n: string) => unknown }).from(name))
      : (t as never)[k]),
  }) as unknown as FakeDb;
  const r2 = await loadDashboardStats(broken.as(), asRoutePasses(["s-x"]));
  assert.equal(r2.stats["s-x"].questionCount, null, "a statistic that could not be loaded is null, never 0");
  assert.ok(r2.warnings.some((w) => /question counts unavailable/.test(w)));
});

test("response counts are unaffected by any of this", async () => {
  const db = seed([{ id: "s1", draft: 12, version: 0 }]);
  db.tables.responses.push(
    { survey_id: "s1", is_test: true, status: "complete", started_at: "2026-10-16T10:00:00Z" },
    { survey_id: "s1", is_test: false, status: "partial", started_at: "2026-10-17T10:00:00Z" },
  );
  const r = await loadDashboardStats(db.as(), asRoutePasses(["s1"]));
  assert.equal(r.stats["s1"].questionCount, 12);
  assert.equal(r.stats["s1"].responseCount, 2);
  assert.equal(r.stats["s1"].testResponseCount, 1);
  assert.equal(r.stats["s1"].liveResponseCount, 1);
  assert.equal(r.stats["s1"].completeCount, 1);
  assert.equal(r.stats["s1"].lastResponseAt, "2026-10-17T10:00:00Z");
});
