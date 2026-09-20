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
