/**
 * R7 END-TO-END — THE TEST THE PLAN ASKED FOR.
 *
 *   "a test that collects responses under v1, cuts v2 with a changed option
 *    set and a deleted row, and asserts every v1 answer still appears under
 *    its v1 meaning. That is the assertion nothing currently makes."
 *
 * The unit tests prove the union and the per-row flatten in isolation. This
 * proves the whole chain on the real schema and real stored rows: two
 * versions, four responses, and a delivered file read back column by column.
 *
 *   PG=postgres://... node scripts/version-scoped-export-test.mjs
 *   (defaults to the local scratch cluster used by the other SQL tests)
 *
 * It creates its own survey inside a transaction and rolls back, so it can be
 * run against any database with the migrations applied.
 */
import pg from "/home/claude/.npm-global/lib/node_modules/pg/lib/index.js";
/*
 * By built path, not by package name: `scripts/` is outside the workspace's
 * module resolution — every other script here hard-paths its dependencies
 * the same way. Run `pnpm -r build` first.
 */
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { buildUnionDictionary, flattenVersioned } from "../packages/engine/dist/index.js";
import { responsesToCSV } from "../packages/exporters/dist/index.js";

const CONN = process.env.PG ?? "postgres:///t43?host=/var/run/postgresql&user=postgres";
let bad = 0;
const ok = (c, m) => { console.log(`${c ? "  ok  " : "  FAIL"} ${m}`); if (!c) bad++; };

/* ---------------------------------------------------------- the two versions */

const survey = (questions) =>
  SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-0000000000e2", code: "VER", title: "Version scoping" },
    questions,
    flow: [
      { type: "page", id: "p1", questionIds: questions.map((q) => q.id) },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

/*
 * v1: a frequency scale where 3 = "Sometimes", plus a brand question that is
 * about to be deleted, plus a matrix whose second row is about to go.
 */
const V1 = survey([
  { id: "q1", code: "Q1", variableName: "FREQ", type: "single_select", text: "How often?",
    options: [{ code: 1, label: "Never" }, { code: 2, label: "Rarely" }, { code: 3, label: "Sometimes" }] },
  { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand?",
    options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }] },
  /* a matrix takes `rows` plus `options` (the scale); `columns` is for composites */
  { id: "q3", code: "Q3", variableName: "GRID", type: "matrix_single", text: "Rate these",
    rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Service" }],
    options: [{ code: 1, label: "Poor" }, { code: 2, label: "Good" }] },
]);

/*
 * v2: code 3 relabelled to "Often" — the same code, a different meaning;
 * Q2 deleted outright; the matrix's "Service" row removed.
 */
const V2 = survey([
  { id: "q1", code: "Q1", variableName: "FREQ", type: "single_select", text: "How often?",
    options: [{ code: 1, label: "Never" }, { code: 2, label: "Rarely" }, { code: 3, label: "Often" }] },
  { id: "q3", code: "Q3", variableName: "GRID", type: "matrix_single", text: "Rate these",
    rows: [{ code: "r1", label: "Price" }],
    options: [{ code: 1, label: "Poor" }, { code: 2, label: "Good" }] },
]);

const client = new pg.Client({ connectionString: CONN });
await client.connect();
await client.query("begin");

try {
  const SURVEY = "00000000-0000-4000-8000-0000000000e2";
  const VER1 = "00000000-0000-4000-8000-00000000e201";
  const VER2 = "00000000-0000-4000-8000-00000000e202";
  const CUST = "00000000-0000-4000-8000-00000000e2c0";
  const USER = "00000000-0000-4000-8000-00000000e2u0".replace(/u/g, "a");

  await client.query(`insert into public.customers (id, slug, name) values ($1,'verscope','Version Scoping') on conflict do nothing`, [CUST]);
  await client.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'v@scope.test','{"full_name":"V"}'::jsonb) on conflict do nothing`, [USER]);
  await client.query(`update public.profiles set customer_id = $1 where id = $2`, [CUST, USER]);
  await client.query(
    `insert into public.surveys (id, customer_id, owner_id, code, title, status, created_by)
     values ($1,$2,$3,'VER','Version scoping','live',$3) on conflict do nothing`, [SURVEY, CUST, USER]);

  await client.query(
    `insert into public.survey_versions (id, survey_id, version, definition, created_by)
     values ($1,$2,'1.0',$3,$4), ($5,$2,'2.0',$6,$4)`,
    [VER1, SURVEY, JSON.stringify(V1), USER, VER2, JSON.stringify(V2)]);
  await client.query(`update public.surveys set current_version_id = $1 where id = $2`, [VER2, SURVEY]);

  /*
   * Two interviews under v1 and two under v2. The v1 pair answer the brand
   * question and the "Service" grid row — both of which no longer exist in
   * the current questionnaire. Under the old behaviour their answers are in
   * the database and in no delivered file.
   */
  const rows = [
    [VER1, "ver-s1", { q1: 3, q2: 1, q3: { r1: 2, r2: 1 } }],
    [VER1, "ver-s2", { q1: 3, q2: 2, q3: { r1: 1, r2: 2 } }],
    [VER2, "ver-s3", { q1: 3, q3: { r1: 2 } }],
    [VER2, "ver-s4", { q1: 1, q3: { r1: 1 } }],
  ];
  for (const [versionId, session, answers] of rows) {
    await client.query(
      `insert into public.responses (survey_id, version_id, session_id, status, is_test, answers, started_at)
       values ($1,$2,$3,'complete',false,$4,now())`,
      [SURVEY, versionId, session, JSON.stringify(answers)]);
  }

  /* --------------- read them back exactly as the export route does --------- */

  const { rows: stored } = await client.query(
    `select session_id, version_id, answers, status, started_at
       from public.responses where survey_id = $1 and deleted_at is null
      order by session_id`, [SURVEY]);
  ok(stored.length === 4, `all four interviews are stored (${stored.length})`);

  const { rows: vrows } = await client.query(
    `select id, version, definition from public.survey_versions where survey_id = $1 order by version`, [SURVEY]);
  const versions = vrows.map((v) => ({
    versionId: v.id, version: String(v.version), def: SurveyDefinition.parse(v.definition),
  }));
  ok(versions.length === 2, "both versions load and parse from storage");

  const union = buildUnionDictionary(versions);
  const names = union.variables.map((v) => v.name);

  /* ---------------------------------------------- 1. the deleted question */

  ok(names.includes("BRAND"),
    `a question deleted after fieldwork keeps its column — got ${names.filter((n) => !n.startsWith("SESSION")).join(", ")}`);

  /* ------------------------------------------------ 2. the deleted row */

  const gridCols = names.filter((n) => n.startsWith("GRID"));
  ok(gridCols.length >= 2,
    `the matrix row deleted after fieldwork keeps its column — GRID columns: ${gridCols.join(", ")}`);

  /* -------------------------------------- 3. the code that changed meaning */

  const freq = union.variables.find((v) => v.name === "FREQ");
  ok(freq?.valueLabels["3"] === "Often (v2.0) / Sometimes (v1.0)",
    `code 3 names both meanings, newest first — got ${JSON.stringify(freq?.valueLabels["3"])}`);
  ok(union.conflicts.codes.length === 1,
    `exactly one code conflict is reported (${union.conflicts.codes.length})`);

  /* ------------------------------------------- 4. the values are untouched */

  const flat = flattenVersioned(union, versions, stored.map((r) => ({
    versionId: r.version_id,
    state: {
      sessionId: r.session_id, respondentId: null, surveyVersion: 1,
      startedAt: r.started_at, status: r.status,
      answers: r.answers ?? {}, calculated: {}, embedded: {}, flags: [],
    },
  })));

  const s1 = flat[0], s3 = flat[2];
  ok(s1.version === "1.0" && s3.version === "2.0",
    `each row reports the version it was read through (${s1.version}, ${s3.version})`);
  ok(s1.values.FREQ === 3 && s3.values.FREQ === 3,
    "both respondents' code 3 is still a 3 — no value was rewritten");
  ok(s1.values.BRAND === 1,
    `the v1 respondent's answer to the DELETED question is in the file (${JSON.stringify(s1.values.BRAND)})`);
  ok(!("BRAND" in s3.values),
    "the v2 respondent has no such column, rather than a fabricated empty string");

  /* ----------------------------------- 5. and the same through a real CSV */

  const csv = responsesToCSV(
    versions.find((v) => v.version === "2.0").def,
    stored.map((r) => ({
      sessionId: r.session_id, respondentId: null, surveyVersion: 1,
      startedAt: r.started_at, status: r.status,
      answers: r.answers ?? {}, embedded: {}, calculated: {},
    })),
    undefined,
    {
      versioned: {
        dictionary: union.variables,
        defFor: (i) => versions.find((v) => v.versionId === stored[i].version_id)?.def
          ?? versions.find((v) => v.version === "2.0").def,
      },
    },
  );
  const lines = csv.trimEnd().split("\n");
  const header = lines[0].split(",");
  const brandAt = header.indexOf("BRAND");
  ok(brandAt >= 0, `BRAND is a column in the delivered CSV — header: ${lines[0].slice(0, 160)}`);
  if (brandAt >= 0) {
    const v1row = lines[1].split(",");
    const v2row = lines[3].split(",");
    ok(v1row[brandAt] === "1", `the v1 respondent's brand answer is delivered (got "${v1row[brandAt]}")`);
    ok(v2row[brandAt] === "", `the v2 respondent's brand cell is empty, not invented (got "${v2row[brandAt]}")`);
  }

  console.log(bad === 0 ? "\nALL VERSION-SCOPED EXPORT CHECKS PASSED" : `\n${bad} CHECK(S) FAILED`);
} finally {
  await client.query("rollback");
  await client.end();
}
process.exit(bad === 0 ? 0 : 1);
