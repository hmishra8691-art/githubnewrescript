import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, runAnalysis, whyThisNumber, whyLines, type CellExplanation } from "./index.js";
import { kdef, krows } from "./analyses/knownFixture.js";

/** the known fixture, repeated so the region columns reach a testable base (12 respondents × copies) */
function crosstab(copies = 8) {
  const def = kdef;
  const base = krows;
  const rows = Array.from({ length: copies }, (_, k) => base.map((r) => ({ ...r, id: `${r.id}-${k}`, session_id: `${r.session_id}-${k}` }))).flat();
  const ds = buildDataset(def, rows, { spec: { environment: "LIVE", dataset: "all" } as never });
  return { def, r: runAnalysis({ name: "xt", kind: "crosstab", dataset: { environment: "LIVE", dataset: "all" }, variables: [], rows: ["SAT"], columns: ["REGION"], options: {} } as never, ds) };
}

test("a cell is explained from the result itself: count, base, letters, test and provenance", () => {
  const { def, r } = crosstab();
  const t = r.tables[0]!;
  const row = (t.rows as Record<string, unknown>[])[1]!;
  const x = whyThisNumber(r, { row: 1, column: "1" }, { survey: def }) as CellExplanation;
  assert.equal(x.value, row["1"]);
  assert.equal(x.fromCount, row["1__n"]);
  assert.equal(x.ofBase, (t as { columnBases?: Record<string, number> }).columnBases?.["1"]);
  assert.ok(Math.abs((x.fromCount! / x.ofBase!) * 100 - x.value!) < 0.05, "the figure is the count over the base");
  assert.match(x.sentence, new RegExp(`^${x.fromCount} of the ${x.ofBase} respondents`));
  const letters = String(row["1__sig"] ?? "");
  assert.ok(letters.length > 0, "the fixture cell carries letters");
  assert.equal(x.significance!.higherThan.length, letters.length);
  assert.match(x.significance!.correction ?? "", /Holm/);
  assert.equal(x.computedBy.engineVersion, r.provenance!.engineVersion);
  assert.equal(x.computedBy.inputHash, r.provenance!.inputHash);
  assert.ok(whyLines(x).length >= 4);
});

test("a small column says it was not tested rather than 'not significant'", () => {
  const { r } = crosstab(1);
  const x = whyThisNumber(r, { row: 1, column: "1" }) as CellExplanation;
  assert.match(x.significance!.note, /Not tested: only 4 respondents/);
  assert.ok(x.caution.some((c) => /Do not report/.test(c)), "a base of 4 is not reportable");
});

test("base rows and totals read correctly and are not tested", () => {
  const { r } = crosstab();
  const rows = r.tables[0]!.rows as Record<string, unknown>[];
  const bi = rows.findIndex((x) => x.__kind === "base");
  if (bi >= 0) {
    const b = whyThisNumber(r, { row: bi, column: "1" }) as CellExplanation;
    assert.doesNotMatch(b.shown, /%/);
    assert.equal(b.significance, undefined);
  }
  const tot = whyThisNumber(r, { row: 0, column: "__total" }) as CellExplanation;
  assert.match(tot.significance!.note, /total is not tested/);
});

test("bad references return an error, never a guess", () => {
  const { r } = crosstab();
  assert.ok("error" in whyThisNumber(r, { row: 0, column: "nope" }));
  assert.ok("error" in whyThisNumber(r, { row: 999, column: "1" }));
  assert.ok("error" in whyThisNumber(r, { table: "missing", row: 0, column: "1" }));
});
