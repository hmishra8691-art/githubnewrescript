import { test } from "node:test";
import assert from "node:assert/strict";
import { exportEnvironmentOf } from "./exportEnvironment.ts";

/*
 * R12. The audit that produced this test found 22 EXPORT_GENERATION events
 * stamped LIVE in production, every one of them against a survey with zero
 * live responses, three written after R12 was marked done.
 */

test("a file containing a real response is LIVE", () => {
  assert.equal(exportEnvironmentOf([{ is_test: true }, { is_test: false }]), "LIVE");
});

test("a file of nothing but test responses is TEST", () => {
  /*
   * The exact production case. `include=all` on a survey that has only ever
   * been piloted used to record production usage because the PARAMETER said
   * "all", not because anything live was in the file.
   */
  assert.equal(exportEnvironmentOf([{ is_test: true }, { is_test: true }]), "TEST");
});

test("an EMPTY export is TEST, not LIVE", () => {
  /*
   * Nothing production left the platform. Calling it LIVE would put a
   * production usage event on the project's record for a file with no data
   * in it — the same shape as the bug being replaced.
   */
  assert.equal(exportEnvironmentOf([]), "TEST");
});

test("a row whose is_test cannot be read does NOT count as live", () => {
  /*
   * An older database missing the column. Under-reporting production usage
   * is the safe direction: it is visible against the response counts, where
   * an over-report is indistinguishable from real fieldwork.
   */
  assert.equal(exportEnvironmentOf([{}, { is_test: null }, { is_test: undefined }]), "TEST");
});

test("one real response among many test ones is enough", () => {
  const rows = [...Array(99).fill({ is_test: true }), { is_test: false }];
  assert.equal(exportEnvironmentOf(rows), "LIVE", "a single live row makes this a production export");
});
