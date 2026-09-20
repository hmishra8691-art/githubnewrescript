import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  buildUnionDictionary, flattenVersioned, describeConflicts, conflictCount,
  type VersionedDefinition,
} from "./versionedDictionary.js";

/*
 * R7 — every response read through the version it was collected under.
 *
 * The scenario behind every test here is the one the platform could not do
 * correctly and could not detect: a study goes into field, some interviews
 * are collected, the questionnaire is changed, more interviews are collected,
 * and then somebody exports the lot. Today every row is flattened against
 * `current_version_id`, so the first batch is read through a questionnaire
 * that was not the one those people answered.
 */

const survey = (over: Record<string, unknown>) =>
  SurveyDefinition.parse({
    meta: { id: "svy", code: "S", title: "Study" },
    flow: [{ type: "page", id: "p1", questionIds: [] }],
    ...over,
  });

const single = (id: string, code: string, name: string, text: string, options: unknown[]) =>
  ({ id, code, variableName: name, type: "single_select", text, options });

const ver = (versionId: string, version: string, questions: unknown[]): VersionedDefinition => {
  const ids = (questions as { id: string }[]).map((q) => q.id);
  return {
    versionId,
    version,
    def: survey({ questions, flow: [{ type: "page", id: "p1", questionIds: ids }, { type: "end", id: "e", status: "complete" }] }),
  };
};

const OPTS = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }];

/** A complete ResponseState — `flattenVariables` reads more than `answers`. */
const state = (answers: Record<string, unknown>) => ({
  sessionId: "sess", respondentId: "r1", surveyVersion: 1,
  startedAt: "2026-01-01T00:00:00Z", status: "complete",
  answers, calculated: {}, embedded: {}, flags: [],
});

/* ------------------------------------------------------- the ordinary case */

test("one version behaves exactly as it does today", () => {
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "DRINKS", "Do you drink coffee?", OPTS)]);
  const u = buildUnionDictionary([v1]);
  assert.equal(u.mixed, false, "a single-version study must not be treated as mixed");
  assert.equal(conflictCount(u.conflicts), 0);
  assert.ok(u.variables.some((v) => v.name === "DRINKS"));
  for (const v of u.variables) assert.equal(v.partial, false, `${v.name} was marked partial in a single-version study`);
});

/* ---------------------------------------------- R8(a): a deleted question */

test("a question DELETED after fieldwork keeps its column — the answers still export", () => {
  /*
   * The headline case. Three hundred people answered Q2; the researcher then
   * removed it from the questionnaire. Today the column comes from the
   * current version, so Q2 is not in the file at all and those answers are
   * collected, stored, and never delivered.
   */
  const v1 = ver("id1", "1.0", [
    single("q1", "Q1", "DRINKS", "Do you drink coffee?", OPTS),
    single("q2", "Q2", "BRAND", "Which brand?", OPTS),
  ]);
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "DRINKS", "Do you drink coffee?", OPTS)]);

  const u = buildUnionDictionary([v1, v2]);
  const brand = u.variables.find((v) => v.name === "BRAND");
  assert.ok(brand, `BRAND was dropped from the union: ${u.variables.map((v) => v.name).join(", ")}`);
  assert.deepEqual(brand!.versions, ["1.0"], "the dictionary must say which versions had it");
  assert.equal(brand!.partial, true, "a column not every version had is partial");

  const rows = flattenVersioned(u, [v1, v2], [
    { versionId: "id1", state: state({ q1: 1, q2: 2 }) },
    { versionId: "id2", state: state({ q1: 1 }) },
  ]);
  assert.equal(rows[0].values.BRAND, 2, "the v1 respondent's answer must reach the file");
  assert.ok(!("BRAND" in rows[1].values), "the v2 respondent has no such column — it must be absent, not empty-string");
});

test("a question ADDED mid-field exports for the people who saw it", () => {
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "DRINKS", "Do you drink coffee?", OPTS)]);
  const v2 = ver("id2", "2.0", [
    single("q1", "Q1", "DRINKS", "Do you drink coffee?", OPTS),
    single("q9", "Q9", "NEWQ", "A new question", OPTS),
  ]);
  const u = buildUnionDictionary([v1, v2]);
  const rows = flattenVersioned(u, [v1, v2], [
    { versionId: "id1", state: state({ q1: 1 }) },
    { versionId: "id2", state: state({ q1: 1, q9: 2 }) },
  ]);
  assert.ok(!("NEWQ" in rows[0].values), "the v1 respondent was never asked it");
  assert.equal(rows[1].values.NEWQ, 2);
});

/* ------------------------------------------------- R8(c): relabelled codes */

test("relabelling an option does NOT rewrite what earlier respondents said", () => {
  /*
   * The subtlest of the three, and the one that produces a wrong number in a
   * client report rather than a missing column. Code 3 meant "Sometimes" when
   * 340 people chose it. It now says "Often". Reading those rows through the
   * current version reports all 340 as having said "Often".
   */
  const scale = (three: string) => [
    { code: 1, label: "Never" }, { code: 2, label: "Rarely" }, { code: 3, label: three },
  ];
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "FREQ", "How often?", scale("Sometimes"))]);
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "FREQ", "How often?", scale("Often"))]);

  const u = buildUnionDictionary([v1, v2]);
  assert.equal(u.conflicts.codes.length, 1, "the disagreement must be reported");
  const c = u.conflicts.codes[0];
  assert.equal(c.variable, "FREQ");
  assert.equal(c.code, "3");
  assert.deepEqual(c.byVersion, { "1.0": "Sometimes", "2.0": "Often" });

  /* the label in the file names both meanings, newest first */
  const freq = u.variables.find((v) => v.name === "FREQ")!;
  assert.equal(freq.valueLabels["3"], "Often (v2.0) / Sometimes (v1.0)");
  assert.equal(freq.valueLabels["1"], "Never", "a code that did NOT change must keep its plain label");

  /* and the VALUES are untouched — that is the promise */
  const rows = flattenVersioned(u, [v1, v2], [
    { versionId: "id1", state: state({ q1: 3 }) },
    { versionId: "id2", state: state({ q1: 3 }) },
  ]);
  assert.equal(rows[0].values.FREQ, 3);
  assert.equal(rows[1].values.FREQ, 3);

  const said = describeConflicts(u.conflicts);
  assert.equal(said.length, 1);
  assert.match(said[0], /does not mean the same thing/);
  assert.match(said[0], /as collected/, "the warning must say the values were not altered");
});

test("a code added in a later version joins the frame without being a conflict", () => {
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "FREQ", "How often?", [{ code: 1, label: "Never" }])]);
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "FREQ", "How often?", [
    { code: 1, label: "Never" }, { code: 2, label: "Sometimes" },
  ])]);
  const u = buildUnionDictionary([v1, v2]);
  assert.equal(u.conflicts.codes.length, 0, "adding an option is not a conflict");
  const freq = u.variables.find((v) => v.name === "FREQ")!;
  assert.deepEqual(freq.valueCodes.map(String), ["1", "2"], "the frame is the union of codes");
});

/* ----------------------------------------------------- the storage type */

test("a variable whose TYPE changed is widened to text, never narrowed", () => {
  /*
   * .sav, .xpt and .dta each declare one type per column, so this has to be
   * resolved rather than reported alone. Widening keeps every value; the
   * other direction would blank every answer that did not parse as a number,
   * which is data loss chosen by a tie-break.
   */
  /*
   * The NEWEST version is the numeric one on purpose. With it the other way
   * round this test passed against a `widen` that simply returned its first
   * argument — the newest version's type was already "text", so the right
   * answer came out for the wrong reason and a narrowing bug would have
   * shipped. Mutation testing found that; the fixture is ordered so the
   * naive implementation gives "numeric" and fails.
   */
  const v1 = ver("id1", "1.0", [{ id: "q1", code: "Q1", variableName: "AGE", type: "open_text", text: "Age?" }]);
  const v2 = ver("id2", "2.0", [{ id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" }]);
  const u = buildUnionDictionary([v1, v2]);
  const age = u.variables.find((v) => v.name === "AGE")!;
  assert.equal(age.dataType, "text", "a mixed-type column must be the wider type");
  assert.equal(u.conflicts.types.length, 1);
  assert.equal(u.conflicts.types[0].resolved, "text");
  assert.match(describeConflicts(u.conflicts)[0], /holds every value collected/);
});

/* --------------------------------------------------------- column order */

test("a deleted question stays where it was, not shunted to the end", () => {
  /*
   * Column order is how a researcher navigates a file with 400 of them. A
   * question removed from the middle of the questionnaire belongs in the
   * middle of the file; appending it would put it after the last section,
   * where it reads as belonging to something it never belonged to.
   */
  const v1 = ver("id1", "1.0", [
    single("q1", "Q1", "A", "one", OPTS),
    single("q2", "Q2", "GONE", "two", OPTS),
    single("q3", "Q3", "C", "three", OPTS),
  ]);
  const v2 = ver("id2", "2.0", [
    single("q1", "Q1", "A", "one", OPTS),
    single("q3", "Q3", "C", "three", OPTS),
  ]);
  const names = buildUnionDictionary([v1, v2]).variables.map((v) => v.name).filter((n) => ["A", "GONE", "C"].includes(n));
  assert.deepEqual(names, ["A", "GONE", "C"], `GONE must sit between A and C, got ${names.join(", ")}`);
});

/* ------------------------------------------------------- version ordering */

test("v10 is newer than v2 — versions are numbers, not strings", () => {
  /*
   * Sorted as text, "10.0" < "2.0", so the NEWEST version would lose every
   * tie-break: its labels, its column order, its delivery properties. A study
   * only reaches v10 by being long-running and important.
   */
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "FREQ", "t", [{ code: 1, label: "Old" }])]);
  const v10 = ver("id10", "10.0", [single("q1", "Q1", "FREQ", "t", [{ code: 1, label: "New" }])]);
  const u = buildUnionDictionary([v2, v10]);
  assert.deepEqual(u.versions, ["10.0", "2.0"], "newest first");
  assert.equal(u.variables.find((v) => v.name === "FREQ")!.valueLabels["1"], "New (v10.0) / Old (v2.0)");
});

/* --------------------------------------------------- rows we cannot place */

test("a response naming a version that no longer exists is read anyway, and SAYS so", () => {
  /*
   * Dropping the row would be the worst possible answer — it is real
   * fieldwork — and reading it silently through the wrong definition is the
   * bug this module exists to remove. So it is read through the fallback and
   * the row carries the reason, for the caller to surface.
   */
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "A", "one", OPTS)]);
  const u = buildUnionDictionary([v1]);
  const rows = flattenVersioned(u, [v1], [
    { versionId: "id-that-was-deleted", state: state({ q1: 1 }) },
    { versionId: null, state: state({ q1: 2 }) },
  ], { fallbackVersionId: "id1" });

  assert.equal(rows[0].values.A, 1, "the row must still export");
  assert.match(rows[0].fallback ?? "", /no longer exists/);
  assert.equal(rows[1].values.A, 2);
  assert.match(rows[1].fallback ?? "", /records no version/);
});

test("a row read through its own version reports no fallback", () => {
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "A", "one", OPTS)]);
  const u = buildUnionDictionary([v1]);
  const [row] = flattenVersioned(u, [v1], [{ versionId: "id1", state: state({ q1: 1 }) }]);
  assert.equal(row.fallback, undefined, "a correctly-placed row must not carry a warning");
  assert.equal(row.version, "1.0", "the row is stamped with the version it was READ through");
});

/* ------------------------------------------------------ the whole point */

test("the row is stamped with its OWN version, not the survey's current one", () => {
  /*
   * `surveyVersion` on every exported row was the current version number for
   * every row, which is why two exports of the same interviews either side of
   * a cut differ while both claiming the same version.
   */
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "A", "one", OPTS)]);
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "A", "one", OPTS)]);
  const u = buildUnionDictionary([v1, v2]);
  const rows = flattenVersioned(u, [v1, v2], [
    { versionId: "id1", state: state({ q1: 1 }) },
    { versionId: "id2", state: state({ q1: 1 }) },
  ]);
  assert.deepEqual(rows.map((r) => r.version), ["1.0", "2.0"]);
});

test("no conflicts means nothing to warn about", () => {
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "A", "one", OPTS)]);
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "A", "one", OPTS)]);
  const u = buildUnionDictionary([v1, v2]);
  assert.equal(conflictCount(u.conflicts), 0);
  assert.deepEqual(describeConflicts(u.conflicts), []);
});

test("a reworded question is recorded but does NOT raise a warning", () => {
  /*
   * Rewording mid-field is a normal thing a researcher does deliberately. It
   * belongs in the dictionary. Putting it in the warning list would mean the
   * warnings fire on most multi-version studies, and the code conflicts —
   * which are not normal — would be skipped past with them.
   */
  const v1 = ver("id1", "1.0", [single("q1", "Q1", "A", "How old are you?", OPTS)]);
  const v2 = ver("id2", "2.0", [single("q1", "Q1", "A", "What is your age?", OPTS)]);
  const u = buildUnionDictionary([v1, v2]);
  assert.equal(u.conflicts.text.length, 1, "the change is recorded");
  assert.equal(conflictCount(u.conflicts), 0, "but it is not counted as a problem");
  assert.deepEqual(describeConflicts(u.conflicts), [], "and it does not appear in the warnings");
});
