import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { unionVariableMetadata, definitionResolver } from "./versionedMetadata.js";
import { buildDataset } from "./dataset.js";

/*
 * R7, analytics. Fixing the export alone left the platform disagreeing with
 * itself — the delivered CSV read each response through its own
 * questionnaire, the crosstab beside it read every response through the
 * current one. These assert the two halves now agree.
 */

const defn = (questions: unknown[]) => {
  const ids = (questions as { id: string }[]).map((q) => q.id);
  return SurveyDefinition.parse({
    meta: { id: "svy", code: "S", title: "Study" },
    questions,
    flow: [{ type: "page", id: "p1", questionIds: ids }, { type: "end", id: "e", status: "complete" }],
  });
};
const sel = (id: string, code: string, name: string, labels: string[]) => ({
  id, code, variableName: name, type: "single_select", text: `${code}?`,
  options: labels.map((label, i) => ({ code: i + 1, label })),
});

const V1 = defn([sel("q1", "Q1", "FREQ", ["Never", "Sometimes"]), sel("q2", "Q2", "GONE", ["Yes", "No"])]);
const V2 = defn([sel("q1", "Q1", "FREQ", ["Never", "Often"])]);
const ver = (versionId: string, version: string, def: ReturnType<typeof defn>) => ({ versionId, version, def });

test("one version is left exactly as it was", () => {
  const u = unionVariableMetadata([ver("v1", "1.0", V1)]);
  assert.equal(u.mixed, false);
  assert.equal(u.partial.size, 0);
  assert.ok(u.variables.some((v) => v.name === "FREQ"));
});

test("a question deleted after fieldwork stays analysable", () => {
  /*
   * The crosstab half of R8(a). Those answers exist and a researcher must be
   * able to tabulate them, not discover they have silently left the picker.
   */
  const u = unionVariableMetadata([ver("v1", "1.0", V1), ver("v2", "2.0", V2)]);
  const names = u.variables.map((v) => v.name);
  assert.ok(names.includes("GONE"), `GONE left the variable list: ${names.join(", ")}`);
  assert.ok(u.partial.has("GONE"), "a variable not every version had must be marked partial");
  assert.ok(!u.partial.has("FREQ"), "a variable every version had is not partial");
});

test("a relabelled code reads the same in the crosstab as in the export", () => {
  /*
   * The point of taking categories from the engine's union rather than
   * recomputing them: one place decides what a 3 means, so the banner and
   * the delivered file cannot say different things about the same cell.
   */
  const u = unionVariableMetadata([ver("v1", "1.0", V1), ver("v2", "2.0", V2)]);
  const freq = u.variables.find((v) => v.name === "FREQ")!;
  const two = freq.categories?.find((c) => c.code === "2");
  assert.equal(two?.label, "Often (v2.0) / Sometimes (v1.0)", `got ${JSON.stringify(freq.categories)}`);
});

test("deleted variables keep their position in the picker", () => {
  const u = unionVariableMetadata([ver("v1", "1.0", V1), ver("v2", "2.0", V2)]);
  const names = u.variables.map((v) => v.name).filter((n) => ["FREQ", "GONE"].includes(n));
  assert.deepEqual(names, ["FREQ", "GONE"], `GONE must follow FREQ as it did in v1: ${names.join(", ")}`);
});

test("v10 outranks v2 — versions are numbers", () => {
  const early = defn([sel("q1", "Q1", "FREQ", ["Never", "Old"])]);
  const late = defn([sel("q1", "Q1", "FREQ", ["Never", "New"])]);
  const u = unionVariableMetadata([ver("v2", "2.0", early), ver("v10", "10.0", late)]);
  assert.deepEqual(u.versions, ["10.0", "2.0"]);
  const freq = u.variables.find((v) => v.name === "FREQ")!;
  assert.equal(freq.categories?.find((c) => c.code === "2")?.label, "New (v10.0) / Old (v2.0)");
});

test("definitionResolver hands each row its own questionnaire, and falls back rather than dropping", () => {
  const resolve = definitionResolver([ver("v1", "1.0", V1), ver("v2", "2.0", V2)], V2);
  assert.equal(resolve("v1"), V1);
  assert.equal(resolve("v2"), V2);
  assert.equal(resolve("v-gone"), V2, "an unreadable version falls back, it does not throw");
  assert.equal(resolve(null), V2);
  assert.equal(resolve(undefined), V2);
});

test("buildDataset reads each case through its own version", () => {
  /*
   * The assertion that matters: a v1 response and a v2 response both answer
   * code 2, and the v1 one must be flattened against v1. If the versioned
   * option is ignored, both are read through whatever `def` is passed.
   */
  const rows = [
    { id: "r1", session_id: "s1", version_id: "v1", status: "complete", answers: { q1: 2, q2: 1 }, calculated: {}, embedded: {}, flags: [], started_at: "2026-01-01T00:00:00Z" },
    { id: "r2", session_id: "s2", version_id: "v2", status: "complete", answers: { q1: 2 }, calculated: {}, embedded: {}, flags: [], started_at: "2026-01-02T00:00:00Z" },
  ] as never[];
  const versions = [ver("v1", "1.0", V1), ver("v2", "2.0", V2)];
  const u = unionVariableMetadata(versions);
  const resolve = definitionResolver(versions, V2);

  const ds = buildDataset(V2, rows, {
    spec: { environment: "ALL", statuses: ["complete"], dataset: "all" } as never,
    versioned: { variables: u.variables, defFor: (r) => resolve(r.version_id) },
  });

  assert.equal(ds.cases.length, 2, "both responses are in the dataset");
  /*
   * The VARIABLE LIST, not just the values. Mutation testing found this gap:
   * `vars` comes from flattening, so a `buildDataset` that ignored the union
   * list entirely still passed every assertion below — and the researcher
   * would have had a dataset whose cases carried GONE while the picker,
   * the banner and every analysis refused to offer it.
   */
  assert.ok(
    ds.variables.some((v) => v.name === "GONE"),
    `the dataset's variable list must come from the union: ${ds.variables.map((v) => v.name).join(", ")}`,
  );
  /* GONE only exists in v1, so only the v1 case can carry a value for it */
  assert.equal(ds.cases[0].vars.GONE, 1, "the v1 respondent's answer to the deleted question survives");
  assert.equal(ds.cases[1].vars.GONE, undefined, "the v2 respondent was never asked it");
});
