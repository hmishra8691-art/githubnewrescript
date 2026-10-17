import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, flattenVariables, createResponseState, validatePage, designVersionFor, shuffleAlternatives } from "./index.js";

/**
 * MD-P1 (2026-10-17): MaxDiff in the engine.
 *
 *   validation   best-only needs a best only; best == worst is refused on an
 *                OPTIONAL question too; the practice task is named as such
 *   dictionary   best-only declares no _WORST; the practice task is labelled;
 *                _BEST / _WORST carry the item labels
 *   flatten      per task: version, best, worst, anchor, shown order — and the
 *                practice task's columns are T0
 */

const ITEMS = ["Battery", "Camera", "Screen", "Price", "Weight", "Design"];

function survey(opts: { config?: Record<string, unknown>; practice?: boolean; required?: boolean; versions?: number } = {}) {
  const rows: Record<string, unknown>[] = [];
  const versions = opts.versions ?? 1;
  for (let v = 1; v <= versions; v++) {
    if (opts.practice) [1, 2, 3].forEach((i, p) => rows.push({ version: v, task: 0, position: p + 1, item_index: i, item_label: ITEMS[i - 1], practice: 1 }));
    for (let t = 1; t <= 2; t++) {
      [0, 1, 2].map((k) => ((v + t + k) % 6) + 1)
        .forEach((i, p) => rows.push({ version: v, task: t, position: p + 1, item_index: i, item_label: ITEMS[i - 1], ...(opts.practice ? { practice: 0 } : {}) }));
    }
  }
  return SurveyDefinition.parse({
    meta: { id: "mp1", code: "MP1", title: "MaxDiff P1", version: "1.0" },
    designs: [{ id: "d1", kind: "maxdiff", name: "MD", version: 1, config: { items: ITEMS, ...(opts.config ?? {}) }, file: { columns: Object.keys(rows[0]), rows } }],
    questions: [{ id: "q1", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Pick", required: opts.required ?? true, settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
}

const itemsOf = (def: SurveyDefinition, seed: number, task: string) => {
  const rows = def.designs[0].file!.rows as Record<string, unknown>[];
  const v = designVersionFor(def.questions[0], rows, seed);
  return rows.filter((r) => String(r.version) === v && String(r.task) === task).map((r) => String(r.item_index));
};

function messages(def: SurveyDefinition, answer: unknown, seed = 1) {
  const state = createResponseState(def, { seed });
  state.answers.q1 = answer as never;
  return validatePage(def, [def.questions[0]], { def, state, loop: null }).map((e) => e.message);
}

/* ============================================================== validation */

test("best-only: a best per task is a complete answer; a missing best is named", () => {
  const def = survey({ config: { responseMode: "best_only" } });
  const [a] = itemsOf(def, 1, "1"), [b] = itemsOf(def, 1, "2");
  assert.deepEqual(messages(def, { "1": { best: a }, "2": { best: b } }), []);
  assert.deepEqual(messages(def, { "1": { best: a } }), ["Please choose a best for task 2."]);
});

test("best-worst (the default) still needs both, worded exactly as before", () => {
  const def = survey();
  const [a, x] = itemsOf(def, 1, "1");
  assert.deepEqual(messages(def, { "1": { best: a } }), ["Please choose a best and a worst for every task."]);
  assert.deepEqual(messages(def, { "1": { best: a, worst: x } }), ["Please choose a best and a worst for task 2."]);
});

test("an OPTIONAL MaxDiff refuses best == worst too (it used to accept it)", () => {
  const def = survey({ required: false });
  const [a] = itemsOf(def, 1, "1");
  assert.deepEqual(messages(def, { "1": { best: a, worst: a } }), ["Task 1: best and worst cannot be the same item."]);
  assert.deepEqual(messages(def, {}), [], "skipping an optional question is still fine");
  assert.deepEqual(messages(def, { "1": { best: a } }), [], "and a partial optional answer is not nagged");
});

test("the practice task is named as the practice task", () => {
  const def = survey({ practice: true });
  const [p] = itemsOf(def, 1, "0");
  const [a, x] = itemsOf(def, 1, "1"), [b, y] = itemsOf(def, 1, "2");
  assert.deepEqual(messages(def, { "0": { best: p }, "1": { best: a, worst: x }, "2": { best: b, worst: y } }), ["Please choose a best and a worst for the practice task."]);
  assert.deepEqual(messages(def, { "0": { best: p, worst: p }, "1": { best: a, worst: x }, "2": { best: b, worst: y } }), ["The practice task: best and worst cannot be the same item."]);
});

/* ============================================================== dictionary */

test("dictionary: best-only declares no WORST; anchor/order stay per task", () => {
  const names = buildVariableDictionary(survey({ config: { responseMode: "best_only", anchored: true } })).map((v) => v.name);
  assert.ok(names.includes("MD_T1_BEST") && names.includes("MD_T2_BEST"));
  assert.ok(!names.some((n) => n.endsWith("_WORST")));
  assert.ok(names.includes("MD_T1_ANCHOR") && names.includes("MD_T1_ORDER") && names.includes("MD_VERSION"));
});

test("dictionary: BEST / WORST carry item labels; the practice task is labelled as not analysed", () => {
  const dict = buildVariableDictionary(survey({ practice: true }));
  const best = dict.find((v) => v.name === "MD_T1_BEST")!;
  assert.deepEqual(best.valueCodes, [1, 2, 3, 4, 5, 6]);
  assert.equal(best.valueLabels["4"], "Price");
  assert.equal(dict.find((v) => v.name === "MD_T1_WORST")!.valueLabels["6"], "Design");
  assert.match(dict.find((v) => v.name === "MD_T0_BEST")!.label, /practice task \(not analysed\)/);
  assert.match(dict.find((v) => v.name === "MD_T1_BEST")!.label, /task 1 best/);
});

/* ================================================================= flatten */

test("flatten: version, task, shown items with positions, best, worst, anchor — per task", () => {
  const def = survey({ versions: 3, config: { anchored: true } });
  const versions = new Set<string>();
  for (const seed of [2, 3, 5, 7, 11, 13]) {
    const rows = def.designs[0].file!.rows as Record<string, unknown>[];
    const version = designVersionFor(def.questions[0], rows, seed);
    versions.add(version);
    const state = createResponseState(def, { seed });
    const ans: Record<string, unknown> = {};
    const order: Record<string, string> = {};
    for (const t of ["1", "2"]) {
      const shown = shuffleAlternatives(rows.filter((r) => String(r.version) === version && String(r.task) === t), seed, `q1:${t}`);
      ans[t] = { best: String(shown[0].item_index), worst: String(shown[2].item_index), anchor: "some" };
      order[t] = shown.map((r) => String(r.item_index)).join("|");
    }
    state.answers.q1 = ans;
    const flat = flattenVariables(def, state);
    assert.equal(flat.MD_VERSION, version);
    for (const t of ["1", "2"]) {
      assert.equal(flat[`MD_T${t}_ORDER`], order[t], "the shown items, top to bottom = positions 1..k");
      assert.equal(String(flat[`MD_T${t}_BEST`]), order[t].split("|")[0]);
      assert.equal(String(flat[`MD_T${t}_WORST`]), order[t].split("|")[2]);
      assert.equal(flat[`MD_T${t}_ANCHOR`], "some");
    }
  }
  assert.ok(versions.size > 1, "the seeds spread over versions");
});

test("flatten: best-only writes no WORST; the practice task flattens to T0", () => {
  const bo = survey({ config: { responseMode: "best_only" } });
  const s1 = createResponseState(bo, { seed: 1 });
  s1.answers.q1 = { "1": { best: itemsOf(bo, 1, "1")[0] } };
  const f1 = flattenVariables(bo, s1);
  assert.ok("MD_T1_BEST" in f1 && !("MD_T1_WORST" in f1));

  const pr = survey({ practice: true });
  const s2 = createResponseState(pr, { seed: 1 });
  const [p, q] = itemsOf(pr, 1, "0");
  s2.answers.q1 = { "0": { best: p, worst: q } };
  const f2 = flattenVariables(pr, s2);
  assert.equal(String(f2.MD_T0_BEST), p);
  assert.equal(String(f2.MD_T0_WORST), q);
  assert.equal(String(f2.MD_T0_ORDER).split("|").length, 3);
});

test("flatten: a response with no seed (null) gets no invented shown order — the answers are kept", () => {
  const def = survey({});
  const state = createResponseState(def, { seed: 1 });
  const [a, b] = itemsOf(def, 1, "1");
  state.answers.q1 = { "1": { best: a, worst: b } };
  (state as { seed: unknown }).seed = null;
  const flat = flattenVariables(def, state);
  assert.equal(String(flat.MD_T1_BEST), a);
  assert.equal(String(flat.MD_T1_WORST), b);
  assert.equal("MD_T1_ORDER" in flat, false, "no seed → no order column value");
});
