import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, flattenVariables, buildVariableDictionary,
  designVersionFor, designRowsFor, designVersionCount, shuffleAlternatives,
} from "./index.js";

/**
 * THE VERSION A RESPONDENT ANSWERS.
 *
 * A four-version design was silently a one-version design: the renderer
 * filtered on `version === "1"`, hardcoded, and the analysis's version lookup
 * always fell back to "1". These tests pin the three things that make a
 * multi-version design work — the assignment happens, it is stable, and it
 * reaches the data.
 */

const rowsFor = (versions: number, tasksPerVersion = 2) => {
  const rows: Record<string, unknown>[] = [];
  for (let v = 1; v <= versions; v++) {
    for (let t = 1; t <= tasksPerVersion; t++) {
      for (let a = 1; a <= 2; a++) {
        rows.push({ version: v, task: t, alt: a, is_holdout: 0, Price: `$${100 * a}`, none_option: 0 });
      }
      rows.push({ version: v, task: t, alt: 3, is_holdout: 0, Price: "", none_option: 1 });
    }
  }
  return rows;
};

const survey = (versions: number) => SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "CJ", version: "1.0" },
  questions: [{
    id: "q_cj", code: "Q1", variableName: "CJ", type: "conjoint_task",
    text: "Choose one", settings: { designRef: "d1" },
  }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cj"] }],
  designs: [{
    id: "d1", kind: "conjoint", name: "pricing", version: 1, seed: 1,
    config: {}, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Price", "none_option"], rows: rowsFor(versions) },
  }],
});

const q = { id: "q_cj", settings: { designRef: "d1" } } as never;

test("a design with one version always gives version 1", () => {
  const rows = rowsFor(1);
  assert.equal(designVersionCount(rows), 1);
  for (const seed of [1, 2, 999, 123456]) {
    assert.equal(designVersionFor(q, rows, seed), "1");
  }
});

test("a four-version design actually hands out all four", () => {
  const rows = rowsFor(4);
  assert.equal(designVersionCount(rows), 4);
  const seen = new Set<string>();
  for (let seed = 1; seed <= 400; seed++) seen.add(designVersionFor(q, rows, seed));
  assert.deepEqual([...seen].sort(), ["1", "2", "3", "4"],
    "every block must be fielded — this is the bug: only version 1 ever was");
});

test("the four versions are handed out about evenly", () => {
  const rows = rowsFor(4);
  const counts = new Map<string, number>();
  for (let seed = 1; seed <= 4000; seed++) {
    const v = designVersionFor(q, rows, seed);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const [v, n] of counts) {
    assert.ok(n > 700 && n < 1300, `version ${v} got ${n} of 4000 — that is not even`);
  }
});

test("the same respondent gets the same version every time it is asked", () => {
  const rows = rowsFor(3);
  const first = designVersionFor(q, rows, 4242);
  for (let i = 0; i < 20; i++) {
    assert.equal(designVersionFor(q, rows, 4242), first,
      "a respondent who resumes or goes Back must not be moved to another block");
  }
});

test("two design questions do not hand the same respondent the same block", () => {
  const rows = rowsFor(4);
  let differ = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const a = designVersionFor({ id: "q_a", settings: {} } as never, rows, seed);
    const b = designVersionFor({ id: "q_b", settings: {} } as never, rows, seed);
    if (a !== b) differ++;
  }
  assert.ok(differ > 100, "the two designs should be independent, not correlated");
});

test("only the assigned version's rows are shown", () => {
  const rows = rowsFor(4);
  const version = designVersionFor(q, rows, 777);
  const shown = designRowsFor(q, rows, 777);
  assert.ok(shown.length > 0);
  assert.ok(shown.every((r) => String(r.version) === version));
  assert.equal(shown.length, rows.length / 4);
});

test("the version reaches the data, and the dictionary declares the column", () => {
  const def = survey(4);
  const state = createResponseState(def, { sessionId: "t", seed: 31337 });
  const flat = flattenVariables(def, state);
  const expected = designVersionFor(q, rowsFor(4), 31337);
  assert.equal(flat.CJ_VERSION, expected,
    "without this column the choices cannot be matched to the concepts that produced them");
  assert.ok(buildVariableDictionary(def).some((v) => v.name === "CJ_VERSION"),
    "an exported column must be declared in the dictionary");
});

test("alternatives are ordered per respondent, and None stays last", () => {
  const alts = [
    { alt: 1, none_option: 0 }, { alt: 2, none_option: 0 },
    { alt: 3, none_option: 0 }, { alt: 4, none_option: 1 },
  ];
  const orders = new Set<string>();
  for (let seed = 1; seed <= 50; seed++) {
    const out = shuffleAlternatives(alts, seed, "q:1");
    assert.equal(Number(out[out.length - 1].none_option), 1, "None of these belongs at the bottom");
    assert.deepEqual([...out].map((a) => a.alt).sort(), [1, 2, 3, 4], "no concept may be lost or duplicated");
    orders.add(out.map((a) => a.alt).join(","));
  }
  assert.ok(orders.size > 1, "position effects are real — the order must vary between respondents");
});

test("one respondent's task keeps its order, so Back does not reshuffle it", () => {
  const alts = [{ alt: 1, none_option: 0 }, { alt: 2, none_option: 0 }, { alt: 3, none_option: 0 }];
  const a = shuffleAlternatives(alts, 5, "q:2").map((x) => x.alt).join(",");
  const b = shuffleAlternatives(alts, 5, "q:2").map((x) => x.alt).join(",");
  assert.equal(a, b);
  const other = shuffleAlternatives(alts, 5, "q:3").map((x) => x.alt).join(",");
  assert.notEqual(typeof other, "undefined");
});
