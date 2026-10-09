import { test } from "node:test";
import assert from "node:assert/strict";
import { insertRun, runFromRow, missingColumn, type CompactRun, type RunInsertDb } from "./analyticsRunStore.ts";

/*
 * STORING A RUN WITH ITS PHASE 4 FIELDS: the corrections, the data advice
 * and the discoveries go to the columns migration 0048 adds; a database
 * without them says so and the run is stored once more without them —
 * and the Studio still shows what it just computed.
 */
const compact = (): CompactRun => ({
  computedAt: "2026-10-09T09:00:00Z", trigger: "halfway", environment: "LIVE", n: 400, items: [], findings: [], verdicts: [], warnings: ["w"],
  corrections: { method: "holm", families: [{ family: "H1", tests: 2, before: 2, after: 2, lost: [] }], summary: "Holm correction over 2 tests for H1: every significant finding holds." },
  advice: [{ name: "t1", kind: "test", planned: "t1", checks: [{ code: "small_group", severity: "note", message: "m" }], recommended: { test: "mann_whitney", label: "Mann–Whitney", reason: "r" }, ok: false, summary: "s" }],
  discoveries: { segments: [], anomalies: [], trends: [], looked: { outcomes: [], cuts: [], waves: null, pairs: 0 }, method: "holm", summary: "Beyond the plan: nothing." },
} as unknown as CompactRun);

/** a stub table: records every insert; the first answers as told */
function stub(answers: ({ data: Record<string, unknown> } | { error: { message: string } })[]) {
  const inserts: Record<string, unknown>[] = [];
  const db: RunInsertDb = { from: () => ({ insert: (row) => { inserts.push(row); const a = answers.shift() ?? { error: { message: "no answer" } }; return { select: () => ({ single: async () => ("data" in a ? { data: { id: "r1", ...row }, error: null } : { data: null, error: a.error }) }) }; } }) };
  return { db, inserts };
}

test("the run is inserted with its corrections, advice and discoveries; the stored run carries them", async () => {
  const { db, inserts } = stub([{ data: {} }]);
  const r = await insertRun(db, "s1", compact(), { environment: "LIVE", dataset: "clean" }, { surveyVersion: "1.0", userId: "u1" });
  assert.equal(inserts.length, 1);
  assert.equal((inserts[0].corrections as { method: string }).method, "holm");
  assert.equal((inserts[0].advice as unknown[]).length, 1);
  assert.ok(inserts[0].discoveries);
  assert.equal(inserts[0].survey_id, "s1"); assert.equal(inserts[0].created_by, "u1"); assert.equal(inserts[0].survey_version, "1.0");
  assert.ok(r.stored);
  assert.equal(r.stored!.id, "r1");
  assert.equal(r.stored!.corrections?.summary, "Holm correction over 2 tests for H1: every significant finding holds.");
  assert.equal(r.stored!.advice?.[0].recommended?.test, "mann_whitney");
  assert.equal(r.withoutExtras, undefined);
});

test("a database without the Phase 4 columns: the insert is retried without them, and the run still carries what was computed", async () => {
  const { db, inserts } = stub([{ error: { message: "Could not find the 'corrections' column of 'analytics_runs' in the schema cache" } }, { data: {} }]);
  const r = await insertRun(db, "s1", compact(), { environment: "LIVE", dataset: "clean" }, { surveyVersion: null, userId: null });
  assert.equal(inserts.length, 2, "tried twice");
  assert.ok("corrections" in inserts[0] && !("corrections" in inserts[1]), "the second insert has no Phase 4 columns");
  assert.ok(r.stored);
  assert.equal(r.withoutExtras, true);
  assert.equal(r.stored!.corrections?.method, "holm", "the Studio still shows what it computed");
  assert.equal(r.stored!.discoveries?.summary, "Beyond the plan: nothing.");
  // any other error is the error, once
  const bad = stub([{ error: { message: "permission denied for table analytics_runs" } }]);
  const e = await insertRun(bad.db, "s1", compact(), { environment: "LIVE", dataset: "clean" }, { surveyVersion: null, userId: null });
  assert.equal(bad.inserts.length, 1);
  assert.equal(e.stored, null); assert.equal(e.error, "permission denied for table analytics_runs");
  assert.equal(missingColumn("column \"advice\" of relation \"analytics_runs\" does not exist"), true);
  assert.equal(missingColumn("permission denied"), false);
});

test("a stored row is read back with the Phase 4 columns when it has them, and without them when it does not", () => {
  const base = { id: "r2", computed_at: "2026-10-09T09:00:00Z", trigger: "manual", environment: "LIVE", n: 12, items: [], findings: [], verdicts: [], warnings: [] };
  const old = runFromRow(base);
  assert.equal(old.corrections, undefined); assert.equal(old.advice, undefined); assert.equal(old.discoveries, undefined);
  assert.equal(old.n, 12); assert.equal(old.surveyVersion, null);
  const fresh = runFromRow({ ...base, corrections: { method: "bh", families: [], summary: "" }, discoveries: { segments: [], anomalies: [], trends: [], looked: { outcomes: [], cuts: [], waves: null, pairs: 0 }, method: "bh", summary: "x" } });
  assert.equal(fresh.corrections?.method, "bh");
  assert.equal(fresh.discoveries?.summary, "x");
  assert.equal(fresh.advice, undefined, "null stays absent");
});
