import { test } from "node:test";
import assert from "node:assert/strict";
import {
  partialExpiryDays, partialExpiryCutoff, shouldAbandon, planPartialExpiry, inactiveSinceFilter, lastActivity,
  DEFAULT_PARTIAL_EXPIRY_DAYS,
} from "./partialExpiry.ts";

/* RUNTIME-07: which in-progress responses the expire-partials cron marks abandoned */
const NOW = new Date("2026-10-16T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

test("the window defaults to 30 days when the survey says nothing", () => {
  assert.equal(partialExpiryDays({}), DEFAULT_PARTIAL_EXPIRY_DAYS);
  assert.equal(partialExpiryDays(null), 30);
  assert.equal(partialExpiryDays({ deployment: { clientSlug: "x" } }), 30);
});

test("the setting is read from deployment, then settings, then meta_extensions", () => {
  assert.equal(partialExpiryDays({ deployment: { partialExpiryDays: 7 } }), 7);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: 14 } }), 14);
  assert.equal(partialExpiryDays({ meta_extensions: { partialExpiryDays: 60 } }), 60);
  assert.equal(partialExpiryDays({ deployment: { partialExpiryDays: 7 }, settings: { partialExpiryDays: 14 } }), 7);
});

test("0 or false means never; out-of-range values are clamped; junk falls back to the default", () => {
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: 0 } }), null);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: false } }), null);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: 0.25 } }), 1);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: 99999 } }), 3650);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: -5 } }), 30);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: "7" } }), 30);
  assert.equal(partialExpiryDays({ settings: { partialExpiryDays: Number.NaN } }), 30);
});

test("the cutoff is now minus the window", () => {
  assert.equal(partialExpiryCutoff({}, NOW)?.toISOString(), daysAgo(30));
  assert.equal(partialExpiryCutoff({ settings: { partialExpiryDays: 0 } }, NOW), null);
});

test("an in-progress row idle past the window is abandoned; one inside it is not", () => {
  const cutoff = partialExpiryCutoff({}, NOW);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: daysAgo(40), last_saved_at: daysAgo(31) }, cutoff), true);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: daysAgo(40), last_saved_at: daysAgo(29) }, cutoff), false,
    "a recent save keeps an old session alive");
});

test("without a save, the start time decides", () => {
  const cutoff = partialExpiryCutoff({}, NOW);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: daysAgo(31), last_saved_at: null }, cutoff), true);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: daysAgo(2), last_saved_at: null }, cutoff), false);
});

test("finished, deleted, undatable rows and never-expiring surveys are left alone", () => {
  const cutoff = partialExpiryCutoff({}, NOW);
  for (const status of ["complete", "screened", "quota_full", "terminated", "abandoned"]) {
    assert.equal(shouldAbandon({ status, started_at: daysAgo(90), last_saved_at: daysAgo(90) }, cutoff), false, status);
  }
  assert.equal(shouldAbandon({ status: "in_progress", started_at: daysAgo(90), last_saved_at: null, deleted_at: daysAgo(1) }, cutoff), false);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: null, last_saved_at: null }, cutoff), false);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: "garbage", last_saved_at: null }, cutoff), false);
  assert.equal(shouldAbandon({ status: "in_progress", started_at: daysAgo(900), last_saved_at: null }, null), false);
  assert.equal(lastActivity({ started_at: daysAgo(5), last_saved_at: "nope" }), Date.parse(daysAgo(5)));
});

test("the plan drops never-expiring surveys and gives each survey its own cutoff", () => {
  const plan = planPartialExpiry([
    { id: "a", definition: {} },
    { id: "b", definition: { settings: { partialExpiryDays: 0 } } },
    { id: "c", definition: { meta_extensions: { partialExpiryDays: 7 } } },
  ], NOW);
  assert.deepEqual(plan, [
    { surveyId: "a", days: 30, cutoff: daysAgo(30) },
    { surveyId: "c", days: 7, cutoff: daysAgo(7) },
  ]);
});

test("the PostgREST filter mirrors shouldAbandon: last save before the cutoff, or no save and a start before it", () => {
  const f = inactiveSinceFilter("2026-09-16T12:00:00.000Z");
  assert.equal(f, 'last_saved_at.lt."2026-09-16T12:00:00.000Z",and(last_saved_at.is.null,started_at.lt."2026-09-16T12:00:00.000Z")');
});
