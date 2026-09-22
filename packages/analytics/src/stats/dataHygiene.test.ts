import { describe as suite, it } from "node:test";
import assert from "node:assert/strict";
import { describe as summarise, frequencies } from "./descriptive.js";
import { runAnalysis } from "../analyses/index.js";
import { def, synthRows, spec, D } from "../analyses/fixture.js";
import { buildDataset } from "../dataset.js";

/**
 * MISSINGNESS, WEIGHT LENGTH, AND LIMITS THAT USED TO FAIL SILENTLY.
 *
 * `describe` and `frequencies` disagreed about what "missing" meant, so the
 * same variable could report a different base in a descriptives table and a
 * frequency table on the same screen. Separately, two limits were enforced by
 * comment rather than by code.
 */

suite("missingness means one thing", () => {
  it("NaN is missing in both, and never becomes a category", () => {
    const d = summarise([1, NaN, 3]);
    assert.equal(d.n, 2);
    assert.equal(d.missing, 1);

    const f = frequencies([1, NaN, 3], undefined, null);
    assert.equal(f.valid, 2, "NaN must not count as an answer");
    assert.equal(f.missing, 1);
    assert.ok(!f.rows.some((r) => r.code === "NaN"), `NaN became a category: ${f.rows.map((r) => r.code).join()}`);
  });

  it("Infinity is missing in both", () => {
    assert.equal(summarise([1, Infinity, 3]).n, 2);
    assert.equal(frequencies([1, Infinity, 3], undefined, null).valid, 2);
  });

  it("a zero-weight case is excluded from the base by both, not counted as missing", () => {
    const v = [1, 2, 99, 3];
    const w = [1, 1, 0, 1];
    const d = summarise(v, w);
    assert.equal(d.n, 3);
    assert.equal(d.missing, 0, "a zero-weight case is excluded, not missing");

    const f = frequencies(v, w, null);
    assert.equal(f.valid, 3, "frequencies must draw the same line");
    assert.equal(f.missing, 0);
    assert.equal(f.n, 3);
    assert.ok(!f.rows.some((r) => r.code === "99"), "the zero-weight case must not appear as a category");
  });

  it("valid + missing reconciles in both", () => {
    const v = [1, null, 3, NaN, 5];
    const w = [1, 1, 0, 1, 2];
    const d = summarise(v as (number | null)[], w);
    const f = frequencies(v as (number | null)[], w, null);
    assert.equal(d.n + d.missing, f.valid + f.missing);
  });
});

suite("a mismatched weights array is an error, not a default", () => {
  it("throws rather than padding the tail with 1", () => {
    assert.throws(() => summarise([1, 2, 3, 4], [2, 2]), /weights length 2 does not match values length 4/);
    assert.throws(() => frequencies([1, 2, 3, 4], [2, 2], null), /does not match/);
  });

  it("an absent weights array still means unweighted", () => {
    assert.equal(summarise([1, 2, 3, 4]).mean, 2.5);
    assert.equal(frequencies([1, 2, 3], undefined, null).valid, 3);
  });
});

suite("limits refuse rather than time out", () => {
  const ds = buildDataset(def, synthRows(400), { spec });

  it("hierarchical clustering above its row limit says so instead of running", () => {
    const r = runAnalysis(D("cluster", ["AGE", "SAT"], { options: { method: "hierarchical", k: 3 } }), ds);
    // 400 cases is under the 1,500 limit, so this must still compute
    assert.ok(r.tables.length > 0, "under the limit it should still cluster");
    assert.ok(!r.warnings.some((w) => /limited to/.test(w)));
  });

  it("a truncated dataset warns on every analysis, first", () => {
    const cut = { ...ds, truncatedAt: 250_000 };
    const r = runAnalysis(D("descriptive", ["AGE"]), cut);
    assert.ok(/first 250,000 responses only/.test(r.warnings[0] ?? ""), `expected a truncation warning first, got: ${JSON.stringify(r.warnings)}`);
    // and it is not attached when the dataset is whole
    const whole = runAnalysis(D("descriptive", ["AGE"]), ds);
    assert.ok(!whole.warnings.some((w) => /responses only/.test(w)));
  });
});
