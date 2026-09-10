import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, flattenVariables, createResponseState, setAnswer, validatePage } from "./index.js";

/**
 * DESIGN-TASK ANSWERS REACH THE EXPORT — per-task columns for CBC, MaxDiff
 * and Menu-Based Conjoint, declared from the design and filled by flatten.
 *
 * Before this, `_TASKS` was declared with a note saying "expanded at export"
 * and nothing expanded it: a conjoint respondent's choices reached no CSV.
 */

const menuRows = (tasks: number, version = 1) => {
  const items = [["1", "Base plan", 1], ["2", "Extra storage", 0], ["3", "Support", 0]] as const;
  const prices: Record<string, string[]> = { "1": ["$10", "$15"], "2": ["$2", "$4"], "3": ["$3", "$5"] };
  const rows: Record<string, unknown>[] = [];
  for (let t = 1; t <= tasks; t++) for (const [item, label, req] of items) {
    const price = prices[item][(t + Number(item)) % 2];
    rows.push({ version, task: t, item: Number(item), item_label: label, price, price_index: prices[item].indexOf(price) + 1, price_value: Number(price.slice(1)), required: req });
  }
  return rows;
};

const def = (kind: "conjoint" | "maxdiff" | "menu", extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "t", code: "T", title: "Tasks", version: "1.0" },
  designs: [
    kind === "menu"
      ? { id: "d1", kind: "menu", name: "Menu", version: 1, config: { noneOption: true, minSelections: 0, maxSelections: 2, currency: "$", ...extra }, file: { columns: ["version", "task", "item", "item_label", "price", "price_index", "price_value", "required"], rows: menuRows(3) } }
      : kind === "conjoint"
        ? { id: "d1", kind: "conjoint", name: "CBC", version: 1, config: { alternativesPerTask: 3, noneOption: true }, file: { columns: ["version", "task", "alt", "is_holdout", "Brand", "Price", "none_option"], rows: [1, 2].flatMap((t) => [1, 2, 3].map((alt) => ({ version: 1, task: t, alt, is_holdout: 0, Brand: `B${alt}`, Price: `$${alt}`, none_option: 0 }))) } }
        : { id: "d1", kind: "maxdiff", name: "MD", version: 1, config: {}, file: { columns: ["version", "task", "position", "item_index", "item_label"], rows: [1, 2].flatMap((t) => [1, 2, 3, 4].map((pos) => ({ version: 1, task: t, position: pos, item_index: pos + t, item_label: `Item ${pos + t}` }))) } },
  ],
  questions: [
    { id: "q1", code: "Q1", variableName: "TASKS", type: kind === "maxdiff" ? "maxdiff_task" : "conjoint_task", text: "Choose", required: true, settings: { designRef: "d1" } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});

test("CBC: one column per task, declared from the design, filled with the alternative chosen", () => {
  const d = def("conjoint");
  const names = buildVariableDictionary(d).filter((v) => v.questionId === "q1").map((v) => v.name);
  assert.deepEqual(names, ["TASKS_TASKS", "TASKS_VERSION", "TASKS_T1", "TASKS_T2"]);
  const state = createResponseState(d, { seed: 3 });
  setAnswer(d, state, "q1", { "1": "2", "2": "4" });
  const flat = flattenVariables(d, state);
  assert.equal(flat.TASKS_T1, 2);
  assert.equal(flat.TASKS_T2, 4, "the None option is alternatives + 1");
  assert.equal(flat.TASKS_VERSION, "1");
});

test("MaxDiff: best and worst per task", () => {
  const d = def("maxdiff");
  const names = buildVariableDictionary(d).filter((v) => v.questionId === "q1").map((v) => v.name);
  assert.deepEqual(names, ["TASKS_TASKS", "TASKS_VERSION", "TASKS_T1_BEST", "TASKS_T1_WORST", "TASKS_T2_BEST", "TASKS_T2_WORST"]);
  const state = createResponseState(d, { seed: 3 });
  setAnswer(d, state, "q1", { "1": { best: "2", worst: "5" }, "2": { best: "3" } });
  const flat = flattenVariables(d, state);
  assert.equal(flat.TASKS_T1_BEST, 2);
  assert.equal(flat.TASKS_T1_WORST, 5);
  assert.equal(flat.TASKS_T2_BEST, 3);
  assert.equal("TASKS_T2_WORST" in flat, false, "unanswered half stays absent");
});

test("MENU: one 0/1 column per item per task, a NONE flag and the bundle total from the prices shown", () => {
  const d = def("menu");
  const names = buildVariableDictionary(d).filter((v) => v.questionId === "q1").map((v) => v.name);
  assert.deepEqual(names.slice(0, 7), ["TASKS_TASKS", "TASKS_VERSION", "TASKS_T1_1", "TASKS_T1_2", "TASKS_T1_3", "TASKS_T1_NONE", "TASKS_T1_TOTAL"]);
  assert.equal(names.length, 1 + 3 * 5 + 1);
  const state = createResponseState(d, { seed: 3 });
  // task 1: Base (required) $15, storage $2, support $3 — per menuRows' price pattern
  setAnswer(d, state, "q1", { "1": ["2"], "2": ["none"], "3": ["2", "3"] });
  const flat = flattenVariables(d, state);
  assert.equal(flat.TASKS_T1_1, 1, "required base counts as chosen");
  assert.equal(flat.TASKS_T1_2, 1);
  assert.equal(flat.TASKS_T1_3, 0);
  assert.equal(flat.TASKS_T1_NONE, 0);
  const t1 = menuRows(3).filter((r) => r.task === 1);
  const expected1 = Number(t1[0].price_value) + Number(t1[1].price_value);
  assert.equal(flat.TASKS_T1_TOTAL, expected1, "base + storage at the prices task 1 showed");
  assert.equal(flat.TASKS_T2_NONE, 1);
  assert.equal(flat.TASKS_T2_1, 0, "nothing bought → even the base is 0");
  assert.equal(flat.TASKS_T2_TOTAL, 0);
  const t3 = menuRows(3).filter((r) => r.task === 3);
  assert.equal(flat.TASKS_T3_TOTAL, t3.reduce((s, r) => s + Number(r.price_value), 0), "everything ticked → whole menu");
});

test("MENU validation: every task decided; min/max from the design; 'none' satisfies a task", () => {
  const d = def("menu", { minSelections: 1, maxSelections: 2 });
  const state = createResponseState(d, { seed: 1 });
  const ctx = { def: d, state, loop: null };
  const q = d.questions[0];
  const msgs = () => validatePage(d, [q], ctx).map((e) => e.message);
  assert.deepEqual(msgs(), ["This question is required."], "nothing at all");
  state.answers.q1 = { "1": ["2"] };
  assert.deepEqual(msgs(), ["Please answer every task (2 left)."]);
  state.answers.q1 = { "1": ["2"], "2": ["none"] };
  assert.deepEqual(msgs(), ["Please answer task 3."]);
  state.answers.q1 = { "1": ["2"], "2": ["none"], "3": [] };
  assert.deepEqual(msgs(), [], "an empty tick-list on a menu with a required base is 'just the base' — a decision");
  state.answers.q1 = { "1": ["2"], "2": ["none"], "3": ["2", "3"] };
  assert.deepEqual(msgs(), ["Task 3: please pick at most 2 items."], "base + two add-ons = 3 > max 2");
  state.answers.q1 = { "1": ["2"], "2": ["none"], "3": ["3"] };
  assert.deepEqual(msgs(), []);
  // min counts the required base too: an empty pick on a base-included menu still has 1
  const d2 = def("menu", { minSelections: 2 });
  const s2 = createResponseState(d2, { seed: 1 });
  s2.answers.q1 = { "1": ["2"], "2": ["2"], "3": ["2"] };
  assert.deepEqual(validatePage(d2, [d2.questions[0]], { def: d2, state: s2, loop: null }), []);
});

test("CBC validation: required means every task has a choice", () => {
  const d = def("conjoint");
  const state = createResponseState(d, { seed: 1 });
  const ctx = { def: d, state, loop: null };
  state.answers.q1 = { "1": "2" };
  assert.deepEqual(validatePage(d, [d.questions[0]], ctx).map((e) => e.message), ["Please answer task 2."]);
  state.answers.q1 = { "1": "2", "2": "1" };
  assert.deepEqual(validatePage(d, [d.questions[0]], ctx), []);
});
