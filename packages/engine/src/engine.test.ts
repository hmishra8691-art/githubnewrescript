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

test("exclusive options: one shared implementation (req §2)", async () => {
  const { toggleMultiValue, isExclusiveOption } = await import("./answers.js");
  const opts = [
    { code: 1, flags: [] }, { code: 2, flags: [] },
    { code: 98, flags: ["none_of_above"] }, { code: 99, flags: ["exclusive"] },
  ] as any[];
  // selecting an exclusive clears others
  assert.deepEqual(toggleMultiValue([1, 2], 98, opts), [98]);
  assert.deepEqual(toggleMultiValue([1], 99, opts), [99]);
  // selecting a normal option removes the exclusive
  assert.deepEqual(toggleMultiValue([98], 1, opts), [1]);
  // plain toggle on/off
  assert.deepEqual(toggleMultiValue([1], 2, opts), [1, 2]);
  assert.deepEqual(toggleMultiValue([1, 2], 2, opts), [1]);
  // max selections blocks additions but never deselections
  assert.deepEqual(toggleMultiValue([1, 2], 3, [...opts, { code: 3, flags: [] }] as any, 2), [1, 2]);
  assert.deepEqual(toggleMultiValue([1, 2], 2, opts, 2), [1]);
  assert.equal(isExclusiveOption(opts[2] as any), true);
  assert.equal(isExclusiveOption(opts[0] as any), false);
});

test("field validation by type (req §4–5)", async () => {
  const { validateFieldValue } = await import("./fields.js");
  assert.equal(validateFieldValue("email", "a@b.co"), null);
  assert.ok(validateFieldValue("email", "not-an-email"));
  assert.equal(validateFieldValue("integer", "42"), null);
  assert.ok(validateFieldValue("integer", "4.2"));
  assert.equal(validateFieldValue("decimal", "4.2"), null);
  assert.equal(validateFieldValue("phone", "+1 (555) 123-4567"), null);
  assert.ok(validateFieldValue("phone", "abc"));
  assert.equal(validateFieldValue("url", "example.com/x"), null);
  assert.ok(validateFieldValue("url", "not a url"));
  assert.equal(validateFieldValue("zip", "94103"), null);
  assert.equal(validateFieldValue("date", "2026-01-05"), null);
  assert.ok(validateFieldValue("time", "27:99"));
  assert.equal(validateFieldValue("time", "14:30"), null);
  // empty is never a type error (required is separate)
  assert.equal(validateFieldValue("email", ""), null);
});

function listLogicSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "T", version: "1.0" },
    questions: [
      {
        id: "q_src", code: "Q1", variableName: "SRC", type: "multi_select", text: "src",
        options: [
          { code: "a", label: "Alpha" }, { code: "b", label: "Bravo" },
          { code: "c", label: "Charlie" }, { code: "d", label: "Delta" },
        ],
      },
      {
        id: "q_t", code: "Q2", variableName: "T", type: "multi_select", text: "t",
        options: [
          { code: "a", label: "Alpha" }, { code: "b", label: "Bravo" },
          { code: "c", label: "Charlie" }, { code: "d", label: "Delta" },
        ],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_src"] },
      { type: "page", id: "p2", questionIds: ["q_t"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("list logic: include / exclude / prioritize / deprioritize / remaining (req §12–13)", () => {
  const def = listLogicSurvey();
  const state = createResponseState(def, { seed: 5 });
  state.answers["q_src"] = ["a", "c"];
  const q2 = () => def.questions.find((q) => q.id === "q_t")!;
  const codes = () => effectiveQuestion(q2(), { def, state }).options.map((o) => o.code);

  q2().listLogic = [{ id: "r1", sourceQuestionId: "q_src", action: "include", which: "selected" }] as any;
  assert.deepEqual(codes(), ["a", "c"]);

  q2().listLogic = [{ id: "r1", sourceQuestionId: "q_src", action: "exclude", which: "selected" }] as any;
  assert.deepEqual(codes(), ["b", "d"]);

  q2().listLogic = [{ id: "r1", sourceQuestionId: "q_src", action: "prioritize", which: "selected" }] as any;
  assert.deepEqual(codes(), ["a", "c", "b", "d"]);

  q2().listLogic = [{ id: "r1", sourceQuestionId: "q_src", action: "deprioritize", which: "selected" }] as any;
  assert.deepEqual(codes(), ["b", "d", "a", "c"]);

  // remaining / not-yet-seen: exclude everything the source DISPLAYED
  q2().listLogic = [{ id: "r1", sourceQuestionId: "q_src", action: "exclude", which: "displayed" }] as any;
  assert.deepEqual(codes(), []);

  // not_selected sourcing
  q2().listLogic = [{ id: "r1", sourceQuestionId: "q_src", action: "include", which: "not_selected" }] as any;
  assert.deepEqual(codes(), ["b", "d"]);

  // conditional rule only applies when its condition holds
  q2().listLogic = [{
    id: "r1", sourceQuestionId: "q_src", action: "exclude", which: "selected",
    when: cond.rule("q_src", "selected", "d"),
  }] as any;
  assert.deepEqual(codes(), ["a", "b", "c", "d"]);
});

test("option sorting is presentation-only (req §11)", () => {
  const def = listLogicSurvey();
  const state = createResponseState(def, { seed: 5 });
  const q = def.questions[1];
  q.options = [
    { code: 3, label: "Charlie", flags: [] }, { code: 1, label: "alpha", flags: [] },
    { code: 2, label: "Bravo", flags: [] },
  ] as any;
  (q.settings as any).optionOrder = "az";
  let view = effectiveQuestion(q, { def, state });
  assert.deepEqual(view.options.map((o) => o.label), ["alpha", "Bravo", "Charlie"]);
  (q.settings as any).optionOrder = "numeric_desc";
  view = effectiveQuestion(q, { def, state });
  assert.deepEqual(view.options.map((o) => o.code), [3, 2, 1]);
  // programmed order untouched
  assert.deepEqual(q.options.map((o) => o.code), [3, 1, 2]);
});

test("conditional randomization + pick N (req §7–8)", () => {
  const def = listLogicSurvey();
  const q = def.questions[1];
  q.randomization = {
    enabled: true, scope: "options", method: "none",
    rules: [{ id: "rr", when: cond.rule("q_src", "selected", "a"), method: "shuffle" }],
  } as any;

  // condition false -> method none -> original order
  const s1 = createResponseState(def, { seed: 777 });
  s1.answers["q_src"] = ["b"];
  assert.deepEqual(
    effectiveQuestion(q, { def, state: s1 }).options.map((o) => o.code),
    ["a", "b", "c", "d"],
  );

  // condition true -> shuffled (deterministic per seed)
  const s2 = createResponseState(def, { seed: 777 });
  s2.answers["q_src"] = ["a"];
  const shuffled = effectiveQuestion(q, { def, state: s2 }).options.map((o) => o.code);
  assert.notDeepEqual(shuffled, ["a", "b", "c", "d"]);
  const s2b = createResponseState(def, { seed: 777 });
  s2b.answers["q_src"] = ["a"];
  assert.deepEqual(effectiveQuestion(q, { def, state: s2b }).options.map((o) => o.code), shuffled);

  // pick 2 of 4 without shuffling keeps original relative order
  q.randomization = { enabled: true, scope: "options", method: "none", pick: 2 } as any;
  const s3 = createResponseState(def, { seed: 42 });
  const picked = effectiveQuestion(q, { def, state: s3 }).options.map((o) => String(o.code));
  assert.equal(picked.length, 2);
  assert.deepEqual(picked, [...picked].sort()); // a<b<c<d, original order == sorted

  // anchors survive pick
  q.options.push({ code: "z", label: "None", flags: ["none_of_above"] } as any);
  q.randomization = { enabled: true, scope: "options", method: "shuffle", pick: 2 } as any;
  const s4 = createResponseState(def, { seed: 9 });
  const withAnchor = effectiveQuestion(q, { def, state: s4 }).options.map((o) => String(o.code));
  assert.equal(withAnchor.length, 3); // 2 picked + anchored None
  assert.equal(withAnchor[withAnchor.length - 1], "z");
});

test("form-style lists: labeled typed fields end to end (req §3–5)", () => {
  const def = listLogicSurvey();
  const q = def.questions[1];
  q.type = "text_list";
  q.options = [];
  q.rows = [
    { code: "name", label: "Full Name", flags: [], fieldType: "text", validation: [], required: true },
    { code: "email", label: "Email Address", flags: [], fieldType: "email", validation: [], required: true },
    { code: "age", label: "Age", flags: [], fieldType: "integer", validation: [{ kind: "min_value", value: 18 }], required: false },
  ] as any;
  const state = createResponseState(def, { seed: 1 });

  // missing required + bad email + under-age
  let errs = validateQuestion(def, q, { name: "", email: "nope", age: 15 }, { def, state });
  assert.ok(errs.some((e) => e.rowCode === "name"));
  assert.ok(errs.some((e) => e.rowCode === "email" && /email/i.test(e.message)));
  assert.ok(errs.some((e) => e.rowCode === "age" && /18/.test(e.message)));

  errs = validateQuestion(def, q, { name: "Ada", email: "ada@lovelace.io", age: 36 }, { def, state });
  assert.deepEqual(errs, []);

  // variables typed per field
  const dict = buildVariableDictionary(def);
  const emailVar = dict.find((v) => v.name === "T_email")!;
  const ageVar = dict.find((v) => v.name === "T_age")!;
  assert.equal(emailVar.dataType, "text");
  assert.equal(ageVar.dataType, "numeric");

  // flatten keyed by row code
  state.answers["q_t"] = { name: "Ada", email: "ada@lovelace.io", age: 36 };
  const flat = flattenVariables(def, state);
  assert.equal(flat["T_email"], "ada@lovelace.io");
  assert.equal(flat["T_age"], 36);
});
