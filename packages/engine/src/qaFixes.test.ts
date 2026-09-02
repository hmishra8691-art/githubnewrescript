import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond, variantRegistry, resolveVariant, isSelectableVariant, QUESTION_VARIANTS } from "@rescript/schema";
import {
  createResponseState,
  effectiveQuestion,
  validateQuestion,
  nextCode,
  sequentialCodeMap,
  codesAreSequenceable,
  resequenceQuestionCodes,
  renumberQuestionCodes,
  resolvePiping,
  type EvalContext,
} from "./index.js";

/**
 * Regression tests for the QA batch reported from the Studio (three testers,
 * ~30 issues). Each test names the behaviour that was wrong.
 */

function ctxFor(def: any, answers: Record<string, unknown> = {}): EvalContext {
  const state = createResponseState(def, { seed: 11 });
  Object.assign(state.answers, answers);
  return { def, state };
}

/* --------------------------------------------------- codes (prince 1, oweas 3) */

test("new option codes are max+1, so they never collide after a delete", () => {
  // the old generator used list LENGTH: delete #2 of 5 and the next add
  // duplicated code 5
  assert.equal(nextCode([]), "1");
  assert.equal(nextCode([{ code: "1" }, { code: "2" }, { code: "3" }]), "4");
  assert.equal(nextCode([{ code: "1" }, { code: "3" }, { code: "4" }, { code: "5" }]), "6");
  assert.equal(nextCode([{ code: "a" }, { code: "7" }]), "8");
});

test("re-sequencing rewrites every reference to the codes it moves", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
        // 2 has been deleted, leaving a gap
        options: [{ code: "1", label: "One" }, { code: "3", label: "Three" }, { code: "4", label: "Four" }],
        randomization: { enabled: true, scope: "options", method: "shuffle", groups: [["3", "4"]] },
      },
      {
        id: "q2", code: "Q2", variableName: "B", type: "single_select", text: "",
        options: [{ code: "y", label: "Yes" }],
        displayLogic: cond.rule("q1", "selected", "3"),
        optionPipeline: [],
      },
    ],
    quotas: [
      { id: "qt", name: "Q", cells: [{ id: "c", label: "picked 4", when: cond.rule("q1", "selected", "4"), limit: 10 }] },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });

  assert.deepEqual(sequentialCodeMap(def.questions[0].options), { "3": "2", "4": "3" });
  const r = resequenceQuestionCodes(def, "q1", "options");

  assert.deepEqual(r.def.questions[0].options.map((o) => String(o.code)), ["1", "2", "3"]);
  // the display-logic rule followed its option
  const dl: any = r.def.questions[1].displayLogic;
  assert.equal(String(dl.value), "2");
  // so did the randomization group and the quota cell
  assert.deepEqual(r.def.questions[0].randomization!.groups, [["2", "3"]]);
  assert.equal(String((r.def.quotas[0].cells[0].when as any).value), "3");
  assert.ok(r.referencesUpdated >= 3, `references updated: ${r.referencesUpdated}`);
});

test("re-sequencing refuses lists whose codes carry meaning", () => {
  assert.ok(codesAreSequenceable([{ code: "1" }, { code: "2" }]));
  assert.ok(!codesAreSequenceable([{ code: "apple" }, { code: "2" }]));
  assert.ok(!codesAreSequenceable([{ code: "1" }, { code: "98" }, { code: "99" }]) === false);
});

test("matrix row codes re-sequence and their piped references follow", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "qm", code: "QM", variableName: "M", type: "matrix_single", text: "",
        options: [{ code: 1, label: "Yes" }],
        rows: [{ code: "1", label: "R1" }, { code: "3", label: "R3" }],
      },
      {
        id: "q2", code: "Q2", variableName: "B", type: "open_text",
        text: "You said {{QM[3].label}} about row three.",
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["qm", "q2"] }],
  });
  const r = resequenceQuestionCodes(def, "qm", "rows");
  assert.deepEqual(r.def.questions[0].rows.map((x) => String(x.code)), ["1", "2"]);
  assert.match(r.def.questions[1].text, /\{\{QM\[2\]\.label\}\}/);
});

test("renumbering is a no-op when nothing moves", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [{ id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
      options: [{ code: "1", label: "a" }, { code: "2", label: "b" }] }],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  const r = resequenceQuestionCodes(def, "q1", "options");
  assert.equal(r.referencesUpdated, 0);
  assert.equal(r.def, def);
  assert.equal(renumberQuestionCodes(def, "q1", "options", {}).def, def);
});

/* ------------------------------------------------ duplicates (suraj 3, 13–15) */

test("duplicate rating / carousel variants are retired but still resolve", () => {
  for (const [retired, survivor] of [
    ["single_select.stars", "slider.stars"],
    ["single_select.emoji", "slider.emoji"],
    ["single_select.slider", "slider.single"],
    ["single_select.carousel", "carousel.single"],
    ["numeric.slider", "slider.single"],
  ] as const) {
    const old = variantRegistry.get(retired);
    assert.ok(old, `${retired} stays registered for existing surveys`);
    assert.ok(!isSelectableVariant(old!), `${retired} is hidden from the picker`);
    assert.equal(resolveVariant(retired)?.id, survivor, `${retired} resolves to ${survivor}`);
    assert.ok(isSelectableVariant(variantRegistry.get(survivor)!), `${survivor} is selectable`);
  }
});

test("exactly one selectable variant carries each duplicated name", () => {
  const selectable = QUESTION_VARIANTS.filter(isSelectableVariant);
  for (const name of ["Star Rating", "Emoji / Smiley Rating", "Single-Item Carousel"]) {
    const hits = selectable.filter((v) => v.name === name);
    assert.equal(hits.length, 1, `${name}: ${hits.map((h) => h.id).join(", ")}`);
  }
});

/* ------------------------------------------- row-driven types (suraj 1–2, prince) */

test("matrix and swipe variants are born with cards/rows to show", () => {
  for (const id of ["matrix.single", "matrix.likert", "swipe.tinder", "swipe.statement"]) {
    const v = variantRegistry.get(id)!;
    assert.ok((v.defaults?.rows?.length ?? 0) > 0, `${id} seeds rows`);
  }
  // and the swipe deck still gets its two verdict options
  assert.equal(variantRegistry.get("swipe.tinder")!.defaults!.options!.length, 2);
});

/* ---------------------------------------------------------- ranking (suraj 11) */

function rankingSurvey(rankMode: string, maxSelections?: number) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [{
      id: "q1", code: "Q1", variableName: "R", type: "ranking", text: "", required: true,
      options: [1, 2, 3, 4, 5].map((n) => ({ code: String(n), label: `Item ${n}` })),
      settings: { rankMode, maxSelections },
    }],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
}

test("required ranking asks for the right amount per mode", () => {
  const check = (mode: string, max: number | undefined, answer: string[]) => {
    const def = rankingSurvey(mode, max);
    const ctx = ctxFor(def);
    return validateQuestion(def, def.questions[0], answer, ctx).map((e) => e.message);
  };
  // rank all: every item
  assert.deepEqual(check("all", undefined, ["1", "2", "3"]), ["Please rank all items."]);
  assert.deepEqual(check("all", undefined, ["1", "2", "3", "4", "5"]), []);
  // top N: exactly the top N — this previously demanded all five and could
  // never be satisfied
  assert.deepEqual(check("top_n", 3, ["1", "2", "3"]), []);
  assert.deepEqual(check("top_n", 3, ["1", "2"]), ["Please rank your top 3."]);
  // click: at least one
  assert.deepEqual(check("click", undefined, ["1"]), []);
});

test("the three ranking variants carry distinguishable settings", () => {
  const modes = ["ranking.click", "ranking.rank_all", "ranking.top_n"].map(
    (id) => (variantRegistry.get(id)!.defaults!.settings as any).rankMode,
  );
  assert.deepEqual(modes, ["click", "all", "top_n"]);
});

/* ------------------------------------------------------------- essay (oweas 11) */

test("the essay minimum states its threshold", () => {
  const v = variantRegistry.get("text.essay")!;
  const rule = v.defaults!.validation![0];
  assert.equal(rule.kind, "min_length");
  assert.match(String(rule.message), new RegExp(String(rule.value)));
});

/* ------------------------------------------------------- other-specify (oweas 8) */

test("an other-specify option at the end of a list is still reachable", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [{
      id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
      options: [
        { code: "1", label: "One" },
        { code: "2", label: "Two" },
        { code: "9", label: "Other", flags: ["other_specify"] },
      ],
    }],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  const view = effectiveQuestion(def.questions[0], ctxFor(def));
  assert.equal(String(view.options[view.options.length - 1].code), "9");
  assert.ok(view.options[view.options.length - 1].flags?.includes("other_specify"));
});

/* ------------------------------------------------------ matrix row flags (prince) */

test("matrix rows keep their anchor flags through the engine", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [{
      id: "q1", code: "Q1", variableName: "A", type: "matrix_single", text: "",
      options: [{ code: 1, label: "Yes" }],
      rows: [
        { code: "r1", label: "R1" },
        { code: "r2", label: "R2" },
        { code: "r3", label: "R3" },
        { code: "rn", label: "None of these", flags: ["anchor_bottom"] },
      ],
      randomization: { enabled: true, scope: "rows", method: "shuffle" },
    }],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  for (const seed of [1, 2, 3, 4, 5]) {
    const state = createResponseState(def, { seed });
    const rows = effectiveQuestion(def.questions[0], { def, state }).rows;
    assert.equal(String(rows[rows.length - 1].code), "rn", `seed ${seed} keeps the anchored row last`);
  }
});
