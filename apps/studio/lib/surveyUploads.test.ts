import { test } from "node:test";
import assert from "node:assert/strict";
import { purgeSurveyUploads, type StorageDb } from "./surveyUploads.ts";

/**
 * Runs directly against the TypeScript source via Node's built-in type
 * stripping (`node --experimental-strip-types surveyUploads.test.ts`) —
 * this file is deliberately free of any Next.js-specific import (no
 * `@/lib/admin`, no `server-only`), so it needs no path-alias resolution,
 * bundler, or build step to exercise the real exported function.
 *
 * apps/studio has no `tsc`-to-`dist` build (it's bundled by Next, unlike
 * packages/*), so this does not run through `pnpm -r test` — it is a
 * standalone check, run explicitly as part of this fix's verification.
 */

function stubDb(overrides: Partial<{
  sessions: { session_id: string | null }[];
  sessionsError: string | null;
  buckets: { name: string }[];
  bucketsError: string | null;
  list: Record<string, { entries?: { name: string }[]; error?: string }>;
  removeError: string | null;
  removeCalls: string[][];
}>): StorageDb {
  const sessions = overrides.sessions ?? [];
  const sessionsError = overrides.sessionsError ?? null;
  const buckets = overrides.buckets ?? [{ name: "rescript-uploads" }];
  const bucketsError = overrides.bucketsError ?? null;
  const list = overrides.list ?? {};
  const removeError = overrides.removeError ?? null;
  const removeCalls = overrides.removeCalls ?? [];

  return {
    from(_table) {
      return {
        select(_columns) {
          return {
            async eq(_column, _value) {
              return { data: sessionsError ? null : sessions, error: sessionsError ? { message: sessionsError } : null };
            },
          };
        },
      };
    },
    storage: {
      async listBuckets() {
        return { data: bucketsError ? null : buckets, error: bucketsError ? { message: bucketsError } : null };
      },
      from(_bucket) {
        return {
          async list(path) {
            const entry = list[path];
            if (entry?.error) return { data: null, error: { message: entry.error } };
            return { data: entry?.entries ?? [], error: null };
          },
          async remove(paths) {
            removeCalls.push(paths);
            return { data: null, error: removeError ? { message: removeError } : null };
          },
        };
      },
    },
  };
}

test("no responses for the survey — no storage calls at all", async () => {
  const removeCalls: string[][] = [];
  const db = stubDb({ sessions: [], removeCalls });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.deepEqual(result, { removed: 0, warnings: [] });
  assert.deepEqual(removeCalls, []);
});

test("bucket never created (no survey has ever received an upload) — skips cleanly, no warning", async () => {
  const db = stubDb({
    sessions: [{ session_id: "sess-1" }],
    buckets: [], // "rescript-uploads" not in the list
  });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.deepEqual(result, { removed: 0, warnings: [] });
});

test("walks session -> question folders and removes every file found", async () => {
  const removeCalls: string[][] = [];
  const db = stubDb({
    sessions: [{ session_id: "sess-1" }, { session_id: "sess-2" }, { session_id: null }],
    list: {
      "sess-1": { entries: [{ name: "q1" }, { name: "q2" }] },
      "sess-1/q1": { entries: [{ name: "1700-photo.jpg" }] },
      "sess-1/q2": { entries: [{ name: "1701-sig.png" }] },
      "sess-2": { entries: [{ name: "q3" }] },
      "sess-2/q3": { entries: [] },
    },
    removeCalls,
  });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.equal(result.removed, 2);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(removeCalls.flat().sort(), ["sess-1/q1/1700-photo.jpg", "sess-1/q2/1701-sig.png"]);
});

test("batches remove() calls rather than sending everything in one request", async () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ name: `file-${i}.jpg` }));
  const removeCalls: string[][] = [];
  const db = stubDb({
    sessions: [{ session_id: "sess-1" }],
    list: { "sess-1": { entries: [{ name: "q1" }] }, "sess-1/q1": { entries } },
    removeCalls,
  });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.equal(result.removed, 250);
  // 250 files at a 100-per-batch cap -> 3 batches (100, 100, 50)
  assert.deepEqual(removeCalls.map((c) => c.length), [100, 100, 50]);
});

test("a storage error is collected as a warning, never thrown, and never blocks the caller", async () => {
  const db = stubDb({
    sessions: [{ session_id: "sess-1" }],
    list: { "sess-1": { error: "storage is briefly unavailable" } },
  });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.equal(result.removed, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /storage is briefly unavailable/);
});

test("a failed responses read is reported as a warning, not a thrown error", async () => {
  const db = stubDb({ sessionsError: "connection reset" });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.equal(result.removed, 0);
  assert.match(result.warnings[0], /connection reset/);
});

test("a remove() failure is a warning, not a thrown error, and does not undercount unrelated batches", async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `file-${i}.jpg` }));
  const db = stubDb({
    sessions: [{ session_id: "sess-1" }],
    list: { "sess-1": { entries: [{ name: "q1" }] }, "sess-1/q1": { entries } },
    removeError: "bucket temporarily locked",
  });
  const result = await purgeSurveyUploads(db, "survey-1");
  assert.equal(result.removed, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bucket temporarily locked/);
});
