import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  createResponseState,
  evaluateCondition,
  evaluateExpression,
  resolvePiping,
  effectiveQuestion,
  compileFlow,
  advance,
  start,
  setAnswer,
  buildVariableDictionary,
  validateQuestion,
  checkQuotas,
  flattenVariables,
  runScript,
  createScriptCtx,
} from "./index.js";

function demoSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Test", version: "1.0" },
    questions: [
      {
        id: "q_brands",
        code: "Q1",
        variableName: "BRANDS",
        type: "multi_select",
        text: "Which brands do you know?",
        options: [
          { code: 1, label: "Apple" },
          { code: 2, label: "Samsung" },
          { code: 3, label: "Google" },
          { code: 4, label: "OnePlus" },
        ],
      },
      {
        id: "q_fav",
        code: "Q2",
        variableName: "FAV",
        type: "single_select",
        text: "Earlier you selected {{Q1}}. Which is your favorite?",
        carryForward: { sourceQuestionId: "q_brands", filter: "selected", into: "options" },
        displayLogic: cond.rule("q_brands", "answered"),
      },
      {
        id: "q_age",
        code: "Q3",
        variableName: "AGE",
        type: "numeric",
        text: "Your age?",
        required: true,
        settings: { minValue: 16, maxValue: 99 },
      },
      {
        id: "q_grid",
        code: "Q4",
        variableName: "GRID",
        type: "composite",
        text: "Tell us about each brand",
        carryForward: { sourceQuestionId: "q_brands", filter: "selected", into: "rows" },
        columns: [
          { id: "c_rating", label: "Rating", responseType: "numeric", variableStem: "RATING", min: 1, max: 10 },
          { id: "c_comment", label: "Comment", responseType: "text", variableStem: "COMMENT" },
          {
            id: "c_rec", label: "Recommend?", responseType: "single", variableStem: "REC",
            options: [ { code: 1, label: "Yes" }, { code: 0, label: "No" } ],
          },
        ],
      },
    ],
    calculations: [
      { id: "c1", targetVariable: "AGE_X2", expression: "AGE * 2", trigger: "on_page_submit" },
      { id: "c2", targetVariable: "N_BRANDS", expression: "count(BRANDS)", trigger: "on_page_submit" },
    ],
    quotas: [
      {
        id: "quota_young",
        name: "Young",
        mode: "hard",
        cells: [
          { id: "cell_young", label: "16-30", when: cond.rule("q_age", "lte", 30), limit: 2, limitType: "count" },
        ],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_brands"] },
      { type: "page", id: "p2", questionIds: ["q_fav", "q_age"] },
      {
        type: "branch",
        id: "b1",
        branches: [
          {
            id: "b1a",
            when: cond.rule("q_age", "gte", 18),
            children: [{ type: "page", id: "p3", questionIds: ["q_grid"] }],
          },
        ],
        otherwise: [{ type: "end", id: "end_screen", status: "screened" }],
      },
      { type: "end", id: "end_ok", status: "complete" },
    ],
  });
}

test("condition evaluation with nesting", () => {
  const def = demoSurvey();
  const state = createResponseState(def, { seed: 42 });
  state.answers["q_brands"] = [1, 2];
  state.answers["q_age"] = 25;
  const c = cond.and(
    cond.rule("q_brands", "contains", 1),
    cond.or(cond.rule("q_age", "gt", 30), cond.rule("q_age", "between", 20, 30)),
  );
  assert.equal(evaluateCondition(c, { def, state }), true);
  const c2 = cond.not(cond.rule("q_brands", "selected", 3));
  assert.equal(evaluateCondition(c2, { def, state }), true);
});

test("carry-forward filters options to selection", () => {
  const def = demoSurvey();
  const state = createResponseState(def, { seed: 42 });
  state.answers["q_brands"] = [1, 2];
  const q2 = def.questions.find((q) => q.id === "q_fav")!;
  const view = effectiveQuestion(q2, { def, state });
  assert.deepEqual(view.options.map((o) => o.label), ["Apple", "Samsung"]);
  // composite rows carried too
  const q4 = def.questions.find((q) => q.id === "q_grid")!;
  const view4 = effectiveQuestion(q4, { def, state });
  assert.deepEqual(view4.rows.map((r) => r.label), ["Apple", "Samsung"]);
  assert.equal(view4.columns.length, 3);
});

test("piping labels, values, counts, expressions", () => {
  const def = demoSurvey();
  const state = createResponseState(def, { seed: 1 });
  state.answers["q_brands"] = [1, 2];
  state.answers["q_age"] = 40;
  const ctx = { def, state };
  assert.equal(resolvePiping("You picked {{Q1}}.", ctx), "You picked Apple, Samsung.");
  assert.equal(resolvePiping("{{Q1.count}} brands", ctx), "2 brands");
  assert.equal(resolvePiping("{{Q1.value|join:+}}", ctx), "1+2");
  assert.equal(resolvePiping("{{expr: AGE * 2}}", ctx), "80");
});

test("calc DSL: functions, wildcards, conditionals", () => {
  const vars: Record<string, unknown> = { A: 10, B: 20, C: 3, R_1: 5, R_2: 8, R_3: 2 };
  const o = { resolver: (n: string) => vars[n], names: () => Object.keys(vars) };
  assert.equal(evaluateExpression("A + B * 2", o), 50);
  assert.equal(evaluateExpression("sum(R_*)", o), 15);
  assert.equal(evaluateExpression("countif(R_*, '>', 4)", o), 2);
  assert.equal(evaluateExpression("pct(A, B)", o), 50);
  assert.equal(evaluateExpression("if(A > 5, 'high', 'low')", o), "high");
  assert.equal(evaluateExpression("round(avg(R_1, R_2, R_3), 1)", o), 5);
  assert.equal(evaluateExpression("weighted(A, 0.5, B, 0.25)", o), 10);
  assert.equal(evaluateExpression("min(R_*) + max(R_*)", o), 10);
});

test("flow: branch + skip + calculations + quota", () => {
  const def = demoSurvey();
  const state = createResponseState(def, { seed: 7 });
  let nav = start(def, state);
  assert.equal(nav.done, false);
  assert.equal((nav.steps[nav.stepIndex] as any).pageId, "p1");

  setAnswer(def, state, "q_brands", [1, 3]);
  nav = advance(def, state);
  assert.equal((nav.steps[nav.stepIndex] as any).pageId, "p2");

  setAnswer(def, state, "q_fav", 1);
  setAnswer(def, state, "q_age", 17); // under 18 -> screened via branch otherwise
  nav = advance(def, state);
  assert.equal(nav.done, true);
  assert.equal(nav.endStatus, "screened");

  // adult path
  const s2 = createResponseState(def, { seed: 8 });
  start(def, s2);
  setAnswer(def, s2, "q_brands", [2]);
  advance(def, s2);
  setAnswer(def, s2, "q_fav", 2);
  setAnswer(def, s2, "q_age", 33);
  let nav2 = advance(def, s2);
  assert.equal(nav2.done, false);
  assert.equal((nav2.steps[nav2.stepIndex] as any).pageId, "p3");
  assert.equal(s2.calculated["AGE_X2"], 66);
  assert.equal(s2.calculated["N_BRANDS"], 1);
  setAnswer(def, s2, "q_grid", { "2": { c_rating: 9, c_comment: "great", c_rec: 1 } });
  nav2 = advance(def, s2);
  assert.equal(nav2.endStatus, "complete");

  const flat = flattenVariables(def, s2);
  assert.equal(flat["RATING_2"], 9);
  assert.equal(flat["COMMENT_2"], "great");
  assert.equal(flat["BRANDS_2"], 1);
  assert.equal(flat["BRANDS_1"], 0);
});

test("quota blocks when full", () => {
  const def = demoSurvey();
  def.flow.splice(2, 0, {
    type: "quota_check",
    id: "qc1",
    quotaIds: ["quota_young"],
    onFull: { kind: "terminate" },
  } as any);
  const state = createResponseState(def, { seed: 3 });
  start(def, state);
  setAnswer(def, state, "q_brands", [1]);
  advance(def, state);
  setAnswer(def, state, "q_fav", 1);
  setAnswer(def, state, "q_age", 22);
  const nav = advance(def, state, { quota_young: { cell_young: 2 } });
  assert.equal(nav.endStatus, "quota_full");
  const full = checkQuotas(def, state, { quota_young: { cell_young: 2 } });
  assert.deepEqual(full, ["quota_young"]);
});

test("validation: bounds, required, composite columns, allocation", () => {
  const def = demoSurvey();
  const state = createResponseState(def, { seed: 5 });
  const qAge = def.questions.find((q) => q.id === "q_age")!;
  let errs = validateQuestion(def, qAge, 12, { def, state });
  assert.equal(errs.length, 1);
  errs = validateQuestion(def, qAge, 30, { def, state });
  assert.equal(errs.length, 0);

  state.answers["q_brands"] = [1];
  const qGrid = def.questions.find((q) => q.id === "q_grid")!;
  errs = validateQuestion(def, qGrid, { "1": { c_rating: 15 } }, { def, state });
  assert.ok(errs.some((e) => e.columnId === "c_rating"));
});

test("variable dictionary generation", () => {
  const def = demoSurvey();
  const dict = buildVariableDictionary(def);
  const names = dict.map((d) => d.name);
  assert.ok(names.includes("BRANDS_1"));
  assert.ok(names.includes("FAV"));
  assert.ok(names.includes("RATING_1"));
  assert.ok(names.includes("REC_1"));
  assert.ok(names.includes("AGE_X2"));
  const fav = dict.find((d) => d.name === "FAV")!;
  assert.equal(fav.dataType, "numeric");
});

test("custom scripts: ctx API", () => {
  const def = demoSurvey();
  const state = createResponseState(def, { seed: 5 });
  state.answers["q_age"] = 50;
  const result = { logs: [], errors: [] } as any;
  const ctx = createScriptCtx(def, state, null, result);
  const r = runScript(
    `
    const age = get('Q3');
    setCalc('AGE_GROUP', age >= 45 ? '45+' : 'under 45');
    set('q_fav', 2);
    log('age is', age);
  `,
    ctx,
  );
  assert.equal(r.failed, undefined);
  assert.equal(state.calculated["AGE_GROUP"], "45+");
  assert.equal(state.answers["q_fav"], 2);
  assert.equal(result.logs[0], "age is 50");
});

test("randomization is seeded and anchors respected", () => {
  const def = demoSurvey();
  const q = def.questions[0];
  q.randomization = { enabled: true, scope: "options", method: "shuffle" } as any;
  q.options.push({ code: 99, label: "None of these", flags: ["none_of_above"], } as any);
  const s1 = createResponseState(def, { seed: 123 });
  const s2 = createResponseState(def, { seed: 123 });
  const v1 = effectiveQuestion(q, { def, state: s1 });
  const v2 = effectiveQuestion(q, { def, state: s2 });
  assert.deepEqual(v1.options.map((o) => o.code), v2.options.map((o) => o.code));
  assert.equal(v1.options[v1.options.length - 1].code, 99);
});

test("compileFlow: loop over selected options", () => {
  const def = demoSurvey();
  def.flow = [
    { type: "page", id: "p1", questionIds: ["q_brands"] },
    {
      type: "loop",
      id: "loop1",
      source: { kind: "question", questionId: "q_brands", filter: "selected" },
      loopVar: "brand",
      children: [{ type: "page", id: "pl", questionIds: ["q_age"] }],
    },
    { type: "end", id: "e", status: "complete" },
  ] as any;
  const state = createResponseState(def, { seed: 1 });
  state.answers["q_brands"] = [1, 3];
  const steps = compileFlow(def, state);
  const pages = steps.filter((s) => s.kind === "page");
  assert.equal(pages.length, 3); // p1 + 2 loop iterations
  assert.equal((pages[1] as any).loop.label, "Apple");
  assert.equal((pages[2] as any).loop.label, "Google");
});

test("nextVersion never collides and honours explicit requests", async () => {
  const { nextVersion, compareVersions } = await import("./versioning.js");

  // fresh survey
  assert.equal(nextVersion([]), "1.0");
  // normal progression
  assert.equal(nextVersion(["1.0"]), "1.1");
  assert.equal(nextVersion(["1.0", "1.1", "1.2"]), "1.3");
  // the real bug: editor restored to 1.0 while 1.1/1.2 already exist
  assert.equal(nextVersion(["1.0", "1.1", "1.2"], "1.1"), "1.3");
  // highest wins even when unordered, and minor 10 > minor 9
  assert.equal(nextVersion(["1.9", "1.10", "1.2"]), "1.11");
  // major versions respected
  assert.equal(nextVersion(["1.0", "2.0", "1.5"]), "2.1");
  // an explicit, free version is honoured
  assert.equal(nextVersion(["1.0", "1.1"], "2.0"), "2.0");
  // a non-numeric request falls back to the computed next
  assert.equal(nextVersion(["1.0"], "banana"), "1.1");
  // odd stored strings do not break it
  assert.equal(nextVersion(["draft", "1.0"]), "1.1");
  assert.equal(nextVersion(["draft"]), "1.0");
  assert.equal(nextVersion(["1.0", "draft"], undefined), "1.1");

  assert.ok(compareVersions("1.2", "1.10") < 0);
  assert.ok(compareVersions("2.0", "1.99") > 0);
});
