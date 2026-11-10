import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { resolveExportVersions } from "./exportVersions.ts";

/*
 * R7, the route's half. What is under test is the decision about WHICH
 * questionnaire describes each row — the thing that, when it is wrong,
 * produces a delivered file that looks entirely normal and is not.
 */

const defn = (questions: unknown[]) => {
  const ids = (questions as { id: string }[]).map((q) => q.id);
  return SurveyDefinition.parse({
    meta: { id: "svy", code: "S", title: "Study" },
    questions,
    flow: [{ type: "page", id: "p1", questionIds: ids }, { type: "end", id: "e", status: "complete" }],
  });
};

const q = (id: string, code: string, name: string, labels: string[]) => ({
  id, code, variableName: name, type: "single_select", text: `${code}?`,
  options: labels.map((label, i) => ({ code: i + 1, label })),
});

const V1 = defn([q("q1", "Q1", "A", ["Yes", "No"]), q("q2", "Q2", "GONE", ["Yes", "No"])]);
const V2 = defn([q("q1", "Q1", "A", ["Yes", "No"])]);

/** A Supabase-shaped stub: only `survey_versions.select(...).in(...)` is used. */
const stubDb = (numbers: Record<string, string>) => ({
  from: () => ({
    select: () => ({
      in: async (_col: string, ids: string[]) => ({
        data: ids.filter((id) => numbers[id]).map((id) => ({ id, version: numbers[id] })),
      }),
    }),
  }),
});

const loader = (defs: Record<string, SurveyDefinition>) =>
  async (_db: unknown, id: string) => defs[id] ?? null;

const CURRENT = { versionId: "v2", version: "2.0", def: V2 };

test("each response is matched to the version it was collected under", async () => {
  const rows = [
    { session_id: "s1", version_id: "v1" },
    { session_id: "s2", version_id: "v2" },
  ];
  const r = await resolveExportVersions(
    stubDb({ v1: "1.0", v2: "2.0" }), rows, CURRENT, loader({ v1: V1, v2: V2 }),
  );
  assert.equal(r.forSession("s1").version, "1.0");
  assert.equal(r.forSession("s2").version, "2.0");
  assert.equal(r.union.mixed, true);
  assert.deepEqual(r.union.versions, ["2.0", "1.0"], "newest first");
});

test("a question deleted after fieldwork keeps its column", async () => {
  const r = await resolveExportVersions(
    stubDb({ v1: "1.0", v2: "2.0" }),
    [{ session_id: "s1", version_id: "v1" }, { session_id: "s2", version_id: "v2" }],
    CURRENT, loader({ v1: V1, v2: V2 }),
  );
  const names = r.union.variables.map((v) => v.name);
  assert.ok(names.includes("GONE"), `GONE was dropped: ${names.join(", ")}`);
});

test("THE FILTER BUG: sourceFor indexes into the list it is given", async () => {
  /*
   * The export applies a dataset filter and rebuilds its row list from the
   * survivors. A source built from the ORIGINAL list and indexed
   * positionally would, after the first excluded row, hand every subsequent
   * response its neighbour's questionnaire — and the file would look
   * completely ordinary.
   */
  const all = [
    { session_id: "s1", version_id: "v1" },
    { session_id: "s2", version_id: "v1" },
    { session_id: "s3", version_id: "v2" },
  ];
  const r = await resolveExportVersions(
    stubDb({ v1: "1.0", v2: "2.0" }), all, CURRENT, loader({ v1: V1, v2: V2 }),
  );

  /* s1 and s2 are filtered out; only s3 survives */
  const src = r.sourceFor([{ session_id: "s3" }]);
  assert.equal(src.defFor(0), V2, "the surviving row must still get ITS OWN definition");

  /* and a differently-filtered list is independently correct */
  const src2 = r.sourceFor([{ session_id: "s2" }, { session_id: "s3" }]);
  assert.equal(src2.defFor(0), V1);
  assert.equal(src2.defFor(1), V2);
});

test("a response naming a version that cannot be read still exports, and is reported", async () => {
  const r = await resolveExportVersions(
    stubDb({ v2: "2.0" }),
    [{ session_id: "s1", version_id: "v-deleted" }, { session_id: "s2", version_id: "v2" }],
    CURRENT, loader({ v2: V2 }),
  );
  assert.equal(r.forSession("s1").def, V2, "it must fall back, not vanish");
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].sessionId, "s1");
  assert.match(r.warnings.join(" "), /could not be matched/);
});

test("a response with no version at all is handled the same way", async () => {
  const r = await resolveExportVersions(
    stubDb({ v2: "2.0" }), [{ session_id: "s1", version_id: null }], CURRENT, loader({ v2: V2 }),
  );
  assert.equal(r.unplaced.length, 1);
  assert.match(r.unplaced[0].reason, /no version recorded/);
});

test("the current version is in the union even when nothing was collected under it", async () => {
  /*
   * Otherwise a study re-versioned but not yet re-fielded exports one set of
   * columns today and a different set the moment the first new interview
   * lands — the client's script breaks mid-fieldwork, on a day when nothing
   * they can see has changed.
   */
  const r = await resolveExportVersions(
    stubDb({ v1: "1.0" }), [{ session_id: "s1", version_id: "v1" }], CURRENT, loader({ v1: V1, v2: V2 }),
  );
  assert.deepEqual(r.union.versions, ["2.0", "1.0"]);
});

test("a single-version study produces no warnings and is not mixed", async () => {
  const r = await resolveExportVersions(
    stubDb({ v2: "2.0" }),
    [{ session_id: "s1", version_id: "v2" }, { session_id: "s2", version_id: "v2" }],
    CURRENT, loader({ v2: V2 }),
  );
  assert.equal(r.union.mixed, false);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.unplaced, []);
});

test("a code that changed meaning between versions reaches the warnings", async () => {
  const early = defn([q("q1", "Q1", "FREQ", ["Never", "Sometimes"])]);
  const late = defn([q("q1", "Q1", "FREQ", ["Never", "Often"])]);
  const r = await resolveExportVersions(
    stubDb({ v1: "1.0", v2: "2.0" }),
    [{ session_id: "s1", version_id: "v1" }, { session_id: "s2", version_id: "v2" }],
    { versionId: "v2", version: "2.0", def: late },
    loader({ v1: early, v2: late }),
  );
  assert.equal(r.union.conflicts.codes.length, 1);
  assert.match(r.warnings.join(" "), /does not mean the same thing/);
  assert.match(r.warnings.join(" "), /as collected/);
});

test("only the versions actually present are looked up", async () => {
  /*
   * A study with 40,000 responses across three versions must issue three
   * definition loads, not 40,000. The memoising loader upstream guarantees
   * the second and third are free; this guarantees we do not ask per row.
   */
  const asked: string[] = [];
  const counting = async (_db: unknown, id: string) => {
    asked.push(id);
    return ({ v1: V1, v2: V2 } as Record<string, SurveyDefinition>)[id] ?? null;
  };
  const many = Array.from({ length: 500 }, (_, i) => ({
    session_id: `s${i}`, version_id: i % 2 ? "v1" : "v2",
  }));
  await resolveExportVersions(stubDb({ v1: "1.0", v2: "2.0" }), many, CURRENT, counting);
  assert.deepEqual([...new Set(asked)].sort(), ["v1", "v2"]);
  assert.equal(asked.length, 2, `asked ${asked.length} times for 2 versions across 500 rows`);
});

/* ------------------------------------------------------------------ the eight-column download (2026-11-10) */

const EMPTY = defn([]);
const DRAFT = defn([q("q1", "Q1", "A", ["Yes", "No"]), q("q9", "Q9", "NEW", ["Yes", "No"])]);

test("THE EIGHT-COLUMN EXPORT: rows stored from the draft are read through the draft, and the file says so", async () => {
  /* a questionnaire built in the draft and never saved as a version: the saved version has no questions */
  const rows = [
    { session_id: "imp_1", version_id: "v1", answers: { q1: 1, q9: 2 } },
    { session_id: "imp_2", version_id: "v1", answers: { q1: 2, "q9@3": 1, q9__other__97: "text" } },
  ];
  const before = await resolveExportVersions(stubDb({ v1: "1.0" }), rows, { versionId: "v1", version: "1.0", def: EMPTY }, loader({ v1: EMPTY }));
  assert.equal(before.union.variables.filter((v) => v.responseType !== "system").length, 0, "this is the defect: no question columns");
  assert.equal(before.undefinedKeys.join(), "q1,q9", "and even without a draft it is reported, not silent");
  assert.match(before.warnings.join(" "), /no saved version defines/);

  const r = await resolveExportVersions(stubDb({ v1: "1.0" }), rows, { versionId: "v1", version: "1.0", def: EMPTY }, loader({ v1: EMPTY }), DRAFT);
  const names = r.union.variables.filter((v) => v.responseType !== "system").map((v) => v.name);
  assert.ok(names.includes("A") && names.includes("NEW"), names.join());
  assert.equal(r.forSession("imp_1").def, DRAFT);
  assert.equal(r.forSession("imp_2").version, "1.0 + draft");
  assert.equal(r.draftRead, 2);
  assert.deepEqual(r.undefinedKeys, []);
  assert.match(r.warnings.join(" "), /2 responses hold answers to questions that are in the working draft/);
});

test("a row its own version describes completely is never moved to the draft", async () => {
  const rows = [
    { session_id: "a", version_id: "v1", answers: { q1: 1, q2: 2 } },
    { session_id: "b", version_id: "v1", answers: { q1: 1, q9: 1 } },
  ];
  const r = await resolveExportVersions(stubDb({ v1: "1" }), rows, { versionId: "v1", version: "1", def: V1 }, loader({ v1: V1 }), DRAFT);
  assert.equal(r.forSession("a").def, V1, "collected under v1 and read through v1, whatever the draft says now");
  assert.equal(r.forSession("b").def, DRAFT);
  assert.equal(r.draftRead, 1);
  const names = r.union.variables.map((v) => v.name);
  assert.ok(names.includes("GONE") && names.includes("NEW"), "the union keeps v1's columns and gains the draft's");
});

test("with every answer described, a draft changes nothing at all", async () => {
  const rows = [{ session_id: "a", version_id: "v1", answers: { q1: 1 } }];
  const r = await resolveExportVersions(stubDb({ v1: "1" }), rows, { versionId: "v1", version: "1", def: V1 }, loader({ v1: V1 }), DRAFT);
  assert.equal(r.union.mixed, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.draftRead, 0);
});

test("the workbook itself: Main Data carries every question column for draft-stored rows", async () => {
  const { exportResponsesXlsx } = await import("@rescript/exporters");
  const { createRequire } = await import("node:module");
  /* exceljs is the exporters package's dependency: resolved from there, not added to the Studio for a test */
  const ExcelJS = createRequire(import.meta.resolve("@rescript/exporters"))("exceljs");
  const full = SurveyDefinition.parse({
    meta: { id: "svy", code: "S", title: "Study" },
    questions: [
      q("q1", "Q1", "Q1", ["Yes", "No"]),
      { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 97, label: "Other", flags: ["other_specify"] }] },
      { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Why?" },
      { id: "q4", code: "Q4", variableName: "Q4", type: "matrix_single", text: "Rate", rows: [{ code: "r1", label: "Speed" }, { code: "r2", label: "Price" }], options: [{ code: 1, label: "Bad" }, { code: 2, label: "Good" }] },
      { id: "q5", code: "Q5", variableName: "Q5", type: "numeric", text: "Age?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
    embeddedData: [{ name: "SOURCE" }],
  });
  const stored = [
    { session_id: "imp_1", version_id: "v1", answers: { q1: 1, q2: [1, 97], q2__other__97: "Else", q3: "Because", q4: { r1: 2, r2: 1 }, q5: 34 }, embedded: { SOURCE: "panel" } },
    { session_id: "imp_2", version_id: "v1", answers: { q1: 2, q2: [2], q3: "", q4: { r1: 1, r2: 1 }, q5: 51 }, embedded: { SOURCE: "list" } },
  ];
  const versioned = await resolveExportVersions(stubDb({ v1: "1.0" }), stored, { versionId: "v1", version: "1.0", def: EMPTY }, loader({ v1: EMPTY }), full);
  const rows = stored.map((r) => ({ state: { sessionId: r.session_id, surveyVersion: versioned.forSession(r.session_id).version, startedAt: "2026-11-10T10:00:00Z", completedAt: "2026-11-10T10:05:00Z", status: "complete", answers: r.answers, embedded: r.embedded, calculated: {}, isTest: true }, quality: null, review: { status: null, reason: null, by: null, at: null } }));
  const buf = await exportResponsesXlsx(EMPTY, rows as never, { dataset: { kind: "all" } as never, versioned: versioned.sourceFor(stored), versionNote: { versions: versioned.union.versions, warnings: versioned.warnings } } as never);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet("Main Data")!;
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  for (const name of ["Q1", "Q3", "Q5", "SOURCE"]) assert.ok(header.includes(name), `${name} missing from ${header.join()}`);
  assert.ok(header.some((h) => /^Q2/.test(h)) && header.some((h) => /^Q4/.test(h)), header.join());
  assert.ok(header.length >= 14, `only ${header.length} columns: ${header.join()}`);
  assert.equal(String((ws.getRow(2).values as unknown[])[header.findIndex((h) => /^Q2_other/i.test(h)) + 1]), "Else", `the Other text travels with its option: ${header.join()}`);
  const first = (ws.getRow(2).values as unknown[]).slice(1).map((v) => String(v ?? ""));
  assert.equal(first[header.indexOf("Q3")], "Because");
  assert.equal(first[header.indexOf("Q5")], "34");
  assert.equal(first[header.indexOf("SOURCE")], "panel");
  assert.equal(ws.rowCount, 3, "both responses");
  const about = wb.getWorksheet("About")!;
  let said = false; about.eachRow((r: { getCell(n: number): { value: unknown } }) => { if (/working draft/.test(String(r.getCell(2).value))) said = true; });
  assert.ok(said, "the About sheet says the rows were read through the draft");
});
