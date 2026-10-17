import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { validateQuestion } from "./validate.js";
import { designVersionFor, shuffleAlternatives } from "./designVersion.js";
import { stackedChoiceData } from "./choiceData.js";
import { normalizeAcbc, emptyAcbcAnswer, submitByo, nearConcepts, acbcProhibited } from "./acbc.js";

/**
 * CONJOINT AUDIT 2026-10-17 — what a CBC answer means in the data.
 *
 * The stored answer names the DESIGN alternative, whatever position it was
 * shown in; the wide export records the shown order; the stacked export joins
 * every shown alternative's levels to the choice, by version, task, design
 * alternative and screen position; a response without a seed is never given a
 * guessed version; a value that is not an alternative of the respondent's own
 * task is refused.
 */

const LEVELS = { Brand: ["Alpha", "Beta", "Gamma"], Price: ["$10", "$20", "$30"] };
function cbcRows() {
  const rows: Record<string, unknown>[] = [];
  for (const version of [1, 2]) for (const task of [1, 2]) {
    for (const alt of [1, 2, 3]) {
      rows.push({ version, task, alt, is_holdout: task === 2 ? 1 : 0, Brand: LEVELS.Brand[(alt + task + version) % 3], Price: LEVELS.Price[(alt * 2 + version) % 3], none_option: 0 });
    }
    rows.push({ version, task, alt: 4, is_holdout: task === 2 ? 1 : 0, Brand: "", Price: "", none_option: 1 });
  }
  return rows;
}
const ROWS = cbcRows();
const def = SurveyDefinition.parse({
  meta: { id: "cj", code: "CJ", title: "CBC", version: "1.0" },
  designs: [{
    id: "d1", kind: "conjoint", name: "CBC", version: 1,
    config: { attributes: [{ name: "Brand", levels: LEVELS.Brand }, { name: "Price", levels: LEVELS.Price }], alternativesPerTask: 3, noneOption: true, versions: 2 },
    file: { columns: ["version", "task", "alt", "is_holdout", "Brand", "Price", "none_option"], rows: ROWS },
  }],
  questions: [{ id: "q1", code: "Q1", variableName: "CJ", type: "conjoint_task", text: "Choose", required: true, settings: { designRef: "d1" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});
const q = def.questions[0];

test("stacked export: one row per shown alternative, the choice joined to the levels of the DESIGN alternative, at the position this respondent saw it", () => {
  for (const seed of [1, 2, 3, 17, 99, 31337]) {
    const state = createResponseState(def, { sessionId: `s${seed}`, seed });
    state.answers.q1 = { "1": "2", "2": "4" };
    const out = stackedChoiceData(def, [{ sessionId: state.sessionId, respondentId: `R${seed}`, seed, answers: state.answers }]);
    assert.equal(out.rows.length, 8, "2 tasks × (3 alternatives + None)");
    const version = designVersionFor(q, ROWS, seed);
    for (const task of ["1", "2"]) {
      const mine = out.rows.filter((r) => String(r.task) === task);
      const shown = shuffleAlternatives(ROWS.filter((r) => String(r.version) === version && String(r.task) === task), seed, `q1:${task}`);
      assert.deepEqual(mine.map((r) => r.alt), shown.map((r) => r.alt), "rows follow the screen order");
      assert.deepEqual(mine.map((r) => r.position), [1, 2, 3, 4]);
      assert.equal(mine.filter((r) => r.chosen === 1).length, 1, "exactly one choice per task");
      for (const r of mine) {
        const d = ROWS.find((x) => String(x.version) === version && String(x.task) === task && x.alt === r.alt)!;
        assert.equal(r.Brand, d.Brand, "the levels belong to the design alternative, not to the position");
        assert.equal(r.Price, d.Price);
        assert.equal(r.concept_id, `${version}-${task}-${r.alt}`);
        assert.equal(r.version, version);
        assert.equal(r.respondent, `R${seed}`);
        if (r.none === 1) { assert.equal(r.Brand_code, 0); assert.equal(r.position, 4, "None is last"); }
        else assert.equal(r.Brand_code, LEVELS.Brand.indexOf(String(d.Brand)) + 1, "codes follow the configured level order");
      }
    }
    assert.equal(out.rows.find((r) => r.task === 1 && r.chosen === 1)!.alt, 2);
    const none = out.rows.find((r) => r.task === 2 && r.chosen === 1)!;
    assert.equal(none.none, 1, "the None choice is a row with none = 1");
    assert.equal(out.rows.find((r) => r.task === 2)!.is_holdout, 1);
  }
  assert.deepEqual(stackedChoiceData(def, []).columns.slice(0, 11), ["respondent", "session_id", "question", "version", "task", "is_holdout", "alt", "concept_id", "position", "none", "chosen"]);
});

test("stacked export: unanswered tasks are not written, and a response without a seed is skipped and counted, never guessed", () => {
  const out = stackedChoiceData(def, [
    { sessionId: "a", seed: 5, answers: { q1: { "1": "3" } } },
    { sessionId: "b", seed: null, answers: { q1: { "1": "1" } } },
    { sessionId: "c", seed: 6, answers: {} },
  ]);
  assert.equal(out.rows.length, 4);
  assert.equal(out.skippedNoSeed, 1);
  assert.deepEqual(out.questions, ["CJ"]);
});

test("wide export: the shown order per task, and no version is invented for a response without a seed", () => {
  const state = createResponseState(def, { sessionId: "t", seed: 4242 });
  state.answers.q1 = { "1": "3", "2": "1" };
  const flat = flattenVariables(def, state);
  const version = designVersionFor(q, ROWS, 4242);
  assert.equal(flat.CJ_VERSION, version);
  for (const t of ["1", "2"]) {
    const shown = shuffleAlternatives(ROWS.filter((r) => String(r.version) === version && String(r.task) === t), 4242, `q1:${t}`);
    assert.equal(flat[`CJ_T${t}_ORDER`], shown.map((r) => String(r.alt)).join("|"));
    assert.ok(String(flat[`CJ_T${t}_ORDER`]).endsWith("|4"), "None last");
  }
  assert.equal(flat.CJ_T1, 3, "the stored choice is the design alternative, unchanged by the order");
  const noSeed = flattenVariables(def, { ...state, seed: undefined } as never);
  assert.equal(noSeed.CJ_VERSION, undefined, "no seed → no version (it used to be the same made-up version for everybody)");
  assert.equal(noSeed.CJ_T1_ORDER, undefined);
  assert.equal(noSeed.CJ_T1, 3);
});

test("validation: a choice must be an alternative of that task in the respondent's own version", () => {
  const state = createResponseState(def, { sessionId: "v", seed: 7 });
  const ctx = { def, state, loop: null } as never;
  assert.deepEqual(validateQuestion(def, q, { "1": "2", "2": "4" }, ctx), [], "a real alternative and the None alternative");
  assert.match(validateQuestion(def, q, { "1": "9", "2": "1" }, ctx).map((e) => e.message).join(" "), /Task 1: that choice is not one of the options shown/);
  const optional = { ...q, required: false };
  assert.match(validateQuestion(def, optional, { "1": "7" }, ctx).map((e) => e.message).join(" "), /not one of the options/, "also when the question is optional");
  assert.deepEqual(validateQuestion(def, optional, {}, ctx), []);
});

test("ACBC honours combination prohibitions exactly — neither ignoring the extra levels nor crashing on a `when` rule", () => {
  const combo = { a: { attribute: "Brand", level: "Zen" }, b: { attribute: "Price", level: "$399" }, also: [{ attribute: "Battery", level: "20 h" }] };
  const when = { a: undefined, b: undefined, when: { op: "and" as const, children: [{ attribute: "Brand", level: "Apex" }, { attribute: "Colour", level: "Silver" }] } };
  assert.equal(acbcProhibited({ Brand: "Zen", Price: "$399", Battery: "20 h" }, combo), true);
  assert.equal(acbcProhibited({ Brand: "Zen", Price: "$399", Battery: "8 h" }, combo), false, "the pair alone is not what was prohibited");
  assert.equal(acbcProhibited({ Brand: "Apex", Colour: "Silver" }, when as never), true);
  const cfg = normalizeAcbc({
    attributes: [
      { name: "Brand", levels: ["Apex", "Nova", "Zen"] }, { name: "Price", levels: ["$199", "$299", "$399"] },
      { name: "Battery", levels: ["8 h", "12 h", "20 h"] }, { name: "Colour", levels: ["Black", "Silver"] },
    ],
    prohibitions: [combo, when as never],
    screeningTasks: 4, conceptsPerScreen: 4, maxAttributesVaried: 3,
  });
  let pairOnly = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const a = submitByo(cfg, emptyAcbcAnswer(), seed, { Brand: "Zen", Price: "$399", Battery: "12 h", Colour: "Black" });
    for (let s = 0; s < 3; s++) {
      for (const c of nearConcepts(cfg, a, seed, s, 4, new Set())) {
        assert.equal(acbcProhibited(c.profile, combo) || acbcProhibited(c.profile, when as never), false, JSON.stringify(c.profile));
        if (c.profile.Brand === "Zen" && c.profile.Price === "$399") pairOnly++;
      }
    }
  }
  assert.ok(pairOnly > 0, "Zen at $399 without a 20 h battery is allowed and does appear");
});
