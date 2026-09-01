import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  createResponseState,
  effectiveQuestion,
  explainOptions,
  evaluateCondition,
  resolvePiping,
  lintSurveyLogic,
  detectLogicCycles,
  dependentsOf,
  conditionSummary,
  optionLogicSummary,
  parsePipeBody,
  serializePipeToken,
  type EvalContext,
} from "./index.js";

/* ------------------------------------------------------------------ fixture */

const BRANDS = [
  { code: "apple", label: "Apple" },
  { code: "nike", label: "Nike" },
  { code: "adidas", label: "Adidas" },
  { code: "samsung", label: "Samsung" },
];

/**
 * The acceptance scenario from the specification (§26, §35):
 *   Q1 which brands have you used
 *   Q2 which have you NOT used
 *   Q3 which do you currently use
 *   Q4 shows only brands selected in Q1 AND Q3 but NOT selected in Q2
 *   Q5 pipes the Q4 list into its text
 */
function acceptanceSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Option logic", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "USED", type: "multi_select", text: "Used?", options: BRANDS },
      { id: "q2", code: "Q2", variableName: "NOTUSED", type: "multi_select", text: "Not used?", options: BRANDS },
      { id: "q3", code: "Q3", variableName: "CURRENT", type: "multi_select", text: "Current?", options: BRANDS },
      {
        id: "q4",
        code: "Q4",
        variableName: "ELIGIBLE",
        type: "multi_select",
        text: "Which of these?",
        options: BRANDS,
        optionPipeline: [
          {
            id: "op1",
            kind: "intersect",
            sources: [
              { questionId: "q1", which: "selected" },
              { questionId: "q3", which: "selected" },
            ],
          },
          { id: "op2", kind: "exclude", sources: [{ questionId: "q2", which: "selected" }] },
        ],
      },
      {
        id: "q5",
        code: "Q5",
        variableName: "PREF",
        type: "single_select",
        text: "You selected {{Q4.labels|and}}. Which do you prefer?",
        options: BRANDS,
      },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }],
  });
}

function ctxFor(def: any, answers: Record<string, unknown>): EvalContext {
  const state = createResponseState(def, { seed: 7 });
  Object.assign(state.answers, answers);
  return { def, state };
}

/* ------------------------------------------------------- acceptance criteria */

test("§35 acceptance — intersection minus exclusion produces the eligible list", () => {
  const def = acceptanceSurvey();
  const ctx = ctxFor(def, {
    q1: ["apple", "nike", "adidas", "samsung"],
    q2: ["apple", "samsung"],
    q3: ["apple", "nike"],
  });
  const q4 = def.questions.find((q) => q.id === "q4")!;
  const codes = effectiveQuestion(q4, ctx).options.map((o) => String(o.code));
  // Q1∩Q3 = apple, nike ; minus Q2 (apple, samsung) → nike
  assert.deepEqual(codes, ["nike"]);
});

test("§26/§35 — the eligible list pipes into the next question's text", () => {
  const def = acceptanceSurvey();
  const ctx = ctxFor(def, {
    q1: ["apple", "nike", "adidas"],
    q2: ["adidas"],
    q3: ["apple", "nike", "adidas"],
    q4: ["apple", "nike"],
  });
  const q5 = def.questions.find((q) => q.id === "q5")!;
  assert.equal(
    resolvePiping(q5.text, ctx),
    "You selected Apple and Nike. Which do you prefer?",
  );
});

/* --------------------------------------------------------- option visibility */

test("§2 Always Show survives filtering that would otherwise remove it", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "",
        options: [
          ...BRANDS,
          { code: "other", label: "Other", logic: { visibility: "always_show" } },
        ],
        listLogic: [{ id: "l1", sourceQuestionId: "q1", action: "include", which: "selected" }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  const ctx = ctxFor(def, { q1: ["apple"] });
  const codes = effectiveQuestion(def.questions[1], ctx).options.map((o) => String(o.code));
  assert.deepEqual(codes, ["apple", "other"]);
});

test("§2 an explicit Exclude When still overrides Always Show", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "", options: [{ code: 1, label: "Yes" }] },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "",
        options: [
          {
            code: "other",
            label: "Other",
            logic: { visibility: "always_show", excludeWhen: cond.rule("q1", "eq", 1) },
          },
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  assert.equal(effectiveQuestion(def.questions[1], ctxFor(def, { q1: 1 })).options.length, 0);
  assert.equal(effectiveQuestion(def.questions[1], ctxFor(def, {})).options.length, 1);
});

test("§3 Always Hide keeps the option in the definition but never displays it", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1",
        code: "Q1",
        variableName: "A",
        type: "multi_select",
        text: "",
        options: [
          { code: 1, label: "Product X", logic: { visibility: "always_hide" } },
          { code: 2, label: "Product Y" },
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  const q = def.questions[0];
  assert.equal(q.options.length, 2, "definition keeps the option");
  assert.deepEqual(
    effectiveQuestion(q, ctxFor(def, {})).options.map((o) => o.code),
    [2],
  );
});

test("§5 an option can depend on three earlier questions at once", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: [{ code: "apple", label: "Apple" }] },
      { id: "q2", code: "Q2", variableName: "B", type: "multi_select", text: "", options: [{ code: "banana", label: "Banana" }] },
      { id: "q3", code: "Q3", variableName: "C", type: "multi_select", text: "", options: [{ code: "orange", label: "Orange" }] },
      {
        id: "q4",
        code: "Q4",
        variableName: "D",
        type: "multi_select",
        text: "",
        options: [
          {
            code: "x",
            label: "Option X",
            logic: {
              visibility: "show_when",
              when: cond.and(
                cond.rule("q1", "contains", "apple"),
                cond.rule("q2", "notContains", "banana"),
                cond.rule("q3", "contains", "orange"),
              ),
            },
          },
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3", "q4"] }],
  });
  const q4 = def.questions[3];
  const shows = (answers: Record<string, unknown>) =>
    effectiveQuestion(q4, ctxFor(def, answers)).options.length === 1;

  assert.ok(shows({ q1: ["apple"], q2: [], q3: ["orange"] }));
  assert.ok(!shows({ q1: ["apple"], q2: ["banana"], q3: ["orange"] }));
  assert.ok(!shows({ q1: [], q2: [], q3: ["orange"] }));
  assert.ok(!shows({ q1: ["apple"], q2: [], q3: [] }));
});

test("§8 option-to-option matching works from one reusable rule", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "",
        // ONE rule, applied to every option: "show me if my own code was selected in Q1"
        options: BRANDS.map((o) => ({
          ...o,
          logic: {
            visibility: "show_when",
            when: cond.rule("q1", "selected", cond.option("code")),
          },
        })),
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  const ctx = ctxFor(def, { q1: ["apple", "adidas"] });
  assert.deepEqual(
    effectiveQuestion(def.questions[1], ctx).options.map((o) => String(o.code)),
    ["apple", "adidas"],
  );
});

test("§1 option carry forward / carry back gate on the source question", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "",
        options: BRANDS.map((o) => ({
          ...o,
          logic: { carryForward: { sourceQuestionId: "q1", which: "selected" } },
        })),
      },
      {
        id: "q3",
        code: "Q3",
        variableName: "C",
        type: "multi_select",
        text: "",
        options: BRANDS.map((o) => ({
          ...o,
          logic: { carryBack: { direction: "back", sourceQuestionId: "q4", which: "selected" } },
        })),
      },
      { id: "q4", code: "Q4", variableName: "D", type: "multi_select", text: "", options: BRANDS },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3", "q4"] }],
  });
  const ctx = ctxFor(def, { q1: ["nike"] });
  assert.deepEqual(
    effectiveQuestion(def.questions[1], ctx).options.map((o) => String(o.code)),
    ["nike"],
  );
  // Q4 unanswered → the back reference is skipped, nothing is filtered
  assert.equal(effectiveQuestion(def.questions[2], ctx).options.length, 4);
  // once Q4 has an answer the rule applies
  const ctx2 = ctxFor(def, { q1: ["nike"], q4: ["apple", "nike"] });
  assert.deepEqual(
    effectiveQuestion(def.questions[2], ctx2).options.map((o) => String(o.code)),
    ["apple", "nike"],
  );
});

/* ---------------------------------------------------------- ordering + pins */

test("§1 prioritize / deprioritize conditions reorder without dropping", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "",
        options: [
          BRANDS[0],
          { ...BRANDS[1], logic: { prioritizeWhen: cond.rule("q1", "contains", "nike") } },
          { ...BRANDS[2], logic: { deprioritizeWhen: cond.rule("q1", "contains", "nike") } },
          BRANDS[3],
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  const ctx = ctxFor(def, { q1: ["nike"] });
  assert.deepEqual(
    effectiveQuestion(def.questions[1], ctx).options.map((o) => String(o.code)),
    ["nike", "apple", "samsung", "adidas"],
  );
});

test("§1 randomizeWhen pins an option to its programmed slot", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ code: `o${i}`, label: `Option ${i}` }));
  many[3] = { ...many[3], logic: { randomizeWhen: cond.rule("q0", "eq", "never") } } as any;
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q0", code: "Q0", variableName: "Z", type: "open_text", text: "" },
      {
        id: "q1",
        code: "Q1",
        variableName: "A",
        type: "multi_select",
        text: "",
        options: many,
        randomization: { enabled: true, scope: "options", method: "shuffle" },
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q0", "q1"] }],
  });
  for (const seed of [1, 2, 3, 4, 5]) {
    const state = createResponseState(def, { seed });
    const view = effectiveQuestion(def.questions[1], { def, state });
    assert.equal(String(view.options[3].code), "o3", `seed ${seed} keeps the pinned option in place`);
    assert.equal(view.options.length, 8);
  }
});

/* -------------------------------------------------------------- list ops */

test("§10 union, difference, remaining and dedupe", () => {
  const build = (ops: any[]) =>
    SurveyDefinition.parse({
      meta: { id: "s", code: "S", title: "t", version: "1" },
      questions: [
        { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
        { id: "q2", code: "Q2", variableName: "B", type: "multi_select", text: "", options: BRANDS },
        {
          id: "q3",
          code: "Q3",
          variableName: "C",
          type: "multi_select",
          text: "",
          options: BRANDS,
          optionPipeline: ops,
        },
      ],
      flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3"] }],
    });

  const answers = { q1: ["apple", "nike"], q2: ["nike", "samsung"] };

  const diff = build([
    {
      id: "o",
      kind: "difference",
      sources: [
        { questionId: "q1", which: "selected" },
        { questionId: "q2", which: "selected" },
      ],
    },
  ]);
  assert.deepEqual(
    effectiveQuestion(diff.questions[2], ctxFor(diff, answers)).options.map((o) => String(o.code)),
    ["apple"],
  );

  const remaining = build([
    { id: "o", kind: "remaining", sources: [{ questionId: "q1", which: "selected" }] },
  ]);
  assert.deepEqual(
    effectiveQuestion(remaining.questions[2], ctxFor(remaining, answers)).options.map((o) =>
      String(o.code),
    ),
    ["adidas", "samsung"],
  );

  const carried = build([
    { id: "o1", kind: "carry_forward", sources: [{ questionId: "q1", which: "selected" }] },
    { id: "o2", kind: "union", sources: [{ questionId: "q2", which: "selected" }] },
    { id: "o3", kind: "dedupe" },
    { id: "o4", kind: "sort", order: "az" },
  ]);
  assert.deepEqual(
    effectiveQuestion(carried.questions[2], ctxFor(carried, answers)).options.map((o) =>
      String(o.code),
    ),
    ["apple", "nike", "samsung"],
  );
});

test("§10 filter operation evaluates per option", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "",
        options: BRANDS,
        optionPipeline: [
          {
            id: "f",
            kind: "filter",
            where: {
              type: "rule",
              source: { kind: "option", ref: "label" },
              operator: "startsWith",
              value: "A",
            },
          },
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  assert.deepEqual(
    effectiveQuestion(def.questions[1], ctxFor(def, {})).options.map((o) => String(o.code)),
    ["apple", "adidas"],
  );
});

/* ------------------------------------------------------------- operators */

test("§7 the extended operator set evaluates correctly", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q_multi", code: "QM", variableName: "M", type: "multi_select", text: "", options: BRANDS },
      { id: "q_text", code: "QT", variableName: "T", type: "open_text", text: "" },
      { id: "q_num", code: "QN", variableName: "N", type: "numeric", text: "" },
      { id: "q_rank", code: "QR", variableName: "R", type: "ranking", text: "", options: BRANDS },
      { id: "q_date", code: "QD", variableName: "D", type: "date", text: "" },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q_multi", "q_text", "q_num", "q_rank", "q_date"] }],
  });
  const ctx = ctxFor(def, {
    q_multi: ["apple", "nike"],
    q_text: "Hello world",
    q_num: 42,
    q_rank: ["nike", "apple", "adidas"],
    q_date: "2026-06-15",
  });
  const ok = (c: any) => evaluateCondition(c, ctx);

  assert.ok(ok(cond.rule("q_multi", "containsAll", ["apple", "nike"])));
  assert.ok(!ok(cond.rule("q_multi", "containsAll", ["apple", "samsung"])));
  assert.ok(ok(cond.rule("q_multi", "containsAny", ["samsung", "nike"])));
  assert.ok(ok(cond.rule("q_multi", "containsNone", ["samsung", "adidas"])));

  assert.ok(ok(cond.rule("q_text", "startsWith", "hello")));
  assert.ok(ok(cond.rule("q_text", "endsWith", "WORLD")));
  assert.ok(ok(cond.rule("q_text", "isNotEmpty")));
  assert.ok(!ok(cond.rule("q_text", "isEmpty")));

  assert.ok(ok(cond.rule("q_num", "notBetween", 1, 10)));
  assert.ok(!ok(cond.rule("q_num", "notBetween", 1, 100)));

  assert.ok(ok(cond.rule("q_rank", "rankedFirst", "nike")));
  assert.ok(ok(cond.rule("q_rank", "rankedLast", "adidas")));
  assert.ok(ok(cond.rule("q_rank", "rankedTopN", "apple", 2)));
  assert.ok(!ok(cond.rule("q_rank", "rankedTopN", "adidas", 2)));
  assert.ok(ok(cond.rule("q_rank", "rankEquals", "apple", 2)));
  assert.ok(ok(cond.rule("q_rank", "notRanked", "samsung")));

  assert.ok(ok(cond.rule("q_date", "dateBefore", "2026-07-01")));
  assert.ok(ok(cond.rule("q_date", "dateAfter", "2026-01-01")));
  assert.ok(ok(cond.rule("q_date", "dateBetween", "2026-01-01", "2026-12-31")));
});

/* ---------------------------------------------------------------- piping */

test("§25 piping formats", () => {
  const def = acceptanceSurvey();
  const ctx = ctxFor(def, { q1: ["apple", "nike", "adidas"] });
  assert.equal(resolvePiping("{{Q1.labels|and}}", ctx), "Apple, Nike and Adidas");
  assert.equal(resolvePiping("{{Q1.labels|or}}", ctx), "Apple, Nike or Adidas");
  assert.equal(resolvePiping("{{Q1.count}}", ctx), "3");
  assert.equal(resolvePiping("{{Q1.first}}", ctx), "Apple");
  assert.equal(resolvePiping("{{Q1.last}}", ctx), "Adidas");
  assert.equal(resolvePiping("{{Q1.value}}", ctx), "apple, nike, adidas");
  assert.equal(
    resolvePiping("{{Q1.labels|bullets}}", ctx),
    "<ul><li>Apple</li><li>Nike</li><li>Adidas</li></ul>",
  );
  assert.equal(resolvePiping("{{Q1.labels|upper}}", ctx), "APPLE, NIKE, ADIDAS");
  assert.equal(resolvePiping("{{Q1.remaining}}", ctx), "Samsung");
  // token whitespace is trimmed, exactly as it always has been
  assert.equal(resolvePiping("{{Q1.displayed|join:;}}", ctx), "Apple;Nike;Adidas;Samsung");
  assert.equal(resolvePiping("{{ Q1.labels | and }}", ctx), "Apple, Nike and Adidas");
});

test("case formats never corrupt entities or markup", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
        options: [{ code: "a&b", label: "<b>Apple</b> &amp; Pear" }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  const ctx = ctxFor(def, { q1: ["a&b"] });
  assert.equal(resolvePiping("{{Q1.value|upper}}", ctx), "A&amp;B");
  assert.equal(resolvePiping("{{Q1.label|upper}}", ctx), "<b>APPLE</b> &amp; PEAR");
});

test("displayed / remaining understand matrix answers", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "qm", code: "QM", variableName: "M", type: "matrix_single", text: "",
        options: BRANDS,
        rows: [{ code: "r1", label: "Row 1" }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["qm"] }],
  });
  const ctx = ctxFor(def, { qm: { r1: "nike" } });
  assert.equal(resolvePiping("{{QM.remaining}}", ctx), "Apple, Adidas, Samsung");
});

test("§23 piping tokens round-trip through the structured model", () => {
  for (const src of ["{{Q1.label}}", "{{Q1.labels|and}}", "{{Q2[3].value}}", "{{calc.SCORE}}", "{{ed.PANEL}}"]) {
    const t = parsePipeBody(src.slice(2, -2), src)!;
    assert.equal(serializePipeToken(t), src, `round-trip ${src}`);
  }
});

/* ------------------------------------------------------- validation + cycles */

test("§31 circular option dependencies are detected", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q4",
        code: "Q4",
        variableName: "A",
        type: "multi_select",
        text: "",
        options: BRANDS,
        optionPipeline: [{ id: "a", kind: "exclude", sources: [{ questionId: "q5", which: "selected" }] }],
      },
      {
        id: "q5",
        code: "Q5",
        variableName: "B",
        type: "multi_select",
        text: "",
        options: BRANDS,
        optionPipeline: [{ id: "b", kind: "exclude", sources: [{ questionId: "q4", which: "selected" }] }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q4", "q5"] }],
  });
  const cycles = detectLogicCycles(def);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), ["q4", "q5"]);
  const issues = lintSurveyLogic(def);
  assert.ok(issues.some((i) => i.level === "error" && /Circular dependency/.test(i.message)));

  // and the runtime still terminates rather than looping forever
  const ctx = ctxFor(def, { q4: ["apple"], q5: ["nike"] });
  assert.doesNotThrow(() => effectiveQuestion(def.questions[0], ctx));
});

test("§30 the linter reports missing references, dead codes and bad operators", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS },
      { id: "q_txt", code: "QT", variableName: "T", type: "open_text", text: "" },
      {
        id: "q2",
        code: "Q2",
        variableName: "B",
        type: "multi_select",
        text: "Hello {{Q99}}",
        options: [
          { code: 1, label: "A", logic: { visibility: "show_when", when: cond.rule("nope", "eq", 1) } },
          { code: 2, label: "B", logic: { visibility: "show_when", when: cond.rule("q1", "selected", "ghost") } },
          { code: 3, label: "C", logic: { visibility: "show_when", when: cond.rule("q_txt", "rankedFirst", "x") } },
          { code: 4, label: "D", logic: { visibility: "show_when" } },
        ],
        optionPipeline: [{ id: "x", kind: "intersect", sources: [] }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q_txt", "q2"] }],
  });
  const issues = lintSurveyLogic(def);
  const msg = issues.map((i) => i.message).join("\n");
  assert.match(msg, /does not exist in this survey/);
  assert.match(msg, /no option coded “ghost”/);
  assert.match(msg, /cannot be used with QT/);
  assert.match(msg, /“Show when” has no condition/);
  assert.match(msg, /needs at least one source question/);
  assert.match(msg, /Pipes from “Q99”|does not exist/);
});

test("§32 dependents are tracked for targeted recalculation", () => {
  const def = acceptanceSurvey();
  assert.deepEqual(dependentsOf(def, "q1").sort(), ["q4", "q5"]);
  assert.deepEqual(dependentsOf(def, "q2").sort(), ["q4", "q5"]);
  assert.deepEqual(dependentsOf(def, "q4"), ["q5"]);
});

/* --------------------------------------------------------------- debugging */

test("§15/§29 explainOptions reports the stage and reason for each option", () => {
  const def = acceptanceSurvey();
  const ctx = ctxFor(def, { q1: ["apple", "nike"], q2: ["apple"], q3: ["apple", "nike"] });
  const x = explainOptions(def.questions.find((q) => q.id === "q4")!, ctx);

  assert.deepEqual(x.final.map((o) => String(o.code)), ["nike"]);
  assert.equal(x.byCode["nike"].status, "visible");
  assert.equal(x.byCode["nike"].position, 1);
  assert.equal(x.byCode["apple"].status, "hidden");
  assert.match(x.byCode["apple"].reason ?? "", /Excluded by Q2/);
  assert.equal(x.byCode["adidas"].status, "hidden");
  assert.ok(x.stages.some((s) => s.key === "source"));
  assert.ok(x.stages.some((s) => s.key.startsWith("list_op:")));
});

test("§14 logic summaries read as sentences", () => {
  const def = acceptanceSurvey();
  const c = cond.and(
    cond.rule("q1", "contains", "apple"),
    cond.rule("q2", "notContains", "samsung"),
  );
  assert.equal(conditionSummary(def, c), "(Q1 includes “Apple” AND Q2 does not include “Samsung”)");
  const lines = optionLogicSummary(def, {
    visibility: "show_when",
    when: cond.rule("q1", "selected", cond.option("code")),
  } as any);
  assert.equal(lines[0], "Show when Q1 includes this option.");
});

/* ------------------------------------------------ protection & edge cases */

test("Always Show survives “show only N” randomization", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ code: `o${i}`, label: `Option ${i}` }));
  many[0] = { ...many[0], logic: { visibility: "always_show" } } as any;
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: many,
        randomization: { enabled: true, scope: "options", method: "shuffle", pick: 2 },
      },
      {
        id: "q2", code: "Q2", variableName: "B", type: "multi_select", text: "", options: many,
        optionPipeline: [{ id: "r", kind: "randomize", method: "shuffle", pick: 2 }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    const state = createResponseState(def, { seed });
    for (const q of def.questions) {
      const codes = effectiveQuestion(q, { def, state }).options.map((o) => String(o.code));
      assert.ok(codes.includes("o0"), `${q.code} seed ${seed} kept the pinned option: ${codes}`);
    }
  }
});

test("imported options still obey their own Always Hide", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
        options: [
          { code: 1, label: "One" },
          { code: 2, label: "Two", logic: { visibility: "always_hide" } },
          { code: 3, label: "Three" },
        ],
      },
      {
        id: "q2", code: "Q2", variableName: "B", type: "multi_select", text: "",
        options: [{ code: 9, label: "Nine" }],
        optionPipeline: [{ id: "u", kind: "union", sources: [{ questionId: "q1", which: "all" }] }],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  assert.deepEqual(
    effectiveQuestion(def.questions[1], ctxFor(def, {})).options.map((o) => String(o.code)),
    ["9", "1", "3"],
  );
});

test("a list operation with a missing or empty source is a no-op, not a wipe", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "", options: BRANDS,
        optionPipeline: [
          { id: "a", kind: "intersect", sources: [] },
          { id: "b", kind: "exclude", sources: [{ questionId: "ghost", which: "selected" }] },
          { id: "c", kind: "difference", sources: [{ questionId: "q2", which: "selected" }] },
        ],
      },
      { id: "q2", code: "Q2", variableName: "B", type: "multi_select", text: "", options: BRANDS },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  assert.equal(effectiveQuestion(def.questions[0], ctxFor(def, {})).options.length, 4);
});

test("$option value and index are consistent across every stage", () => {
  const opts = [
    { code: "1", label: "L1", value: "BRAND_A", logic: { visibility: "always_hide" } },
    { code: "2", label: "L2", value: "BRAND_B" },
    { code: "3", label: "L3", value: "BRAND_C" },
  ];
  const byValue = (kind: "filter" | "show") =>
    SurveyDefinition.parse({
      meta: { id: "s", code: "S", title: "t", version: "1" },
      questions: [
        {
          id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
          options: kind === "show"
            ? opts.map((o, i) => (i === 0 ? o : {
                ...o,
                logic: {
                  visibility: "show_when",
                  when: { type: "rule", source: { kind: "embedded", ref: "WANT" }, operator: "eq", value: { $option: "value" } },
                },
              }))
            : opts,
          optionPipeline: kind === "filter"
            ? [{
                id: "f", kind: "filter",
                where: { type: "rule", source: { kind: "embedded", ref: "WANT" }, operator: "eq", value: { $option: "value" } },
              }]
            : [],
        },
      ],
      flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
    });

  for (const kind of ["show", "filter"] as const) {
    const def = byValue(kind);
    const state = createResponseState(def, { seed: 1 });
    state.embedded.WANT = "BRAND_C";
    const codes = effectiveQuestion(def.questions[0], { def, state }).options.map((o) => String(o.code));
    assert.deepEqual(codes, ["3"], `${kind} resolves $option.value`);
  }

  // index is the PROGRAMMED position, unaffected by the hidden option above it
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "A", type: "multi_select", text: "",
        options: [
          { code: "1", label: "L1", logic: { visibility: "always_hide" } },
          {
            code: "2", label: "L2",
            logic: {
              visibility: "show_when",
              when: { type: "rule", source: { kind: "option", ref: "index" }, operator: "eq", value: 1 },
            },
          },
          { code: "3", label: "L3" },
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  assert.deepEqual(
    effectiveQuestion(def.questions[0], ctxFor(def, {})).options.map((o) => String(o.code)),
    ["2", "3"],
  );
});

test("per-option conditions never hijack loop-scoped answer lookup", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      { id: "qr", code: "QR", variableName: "R", type: "numeric", text: "" },
      {
        id: "qx", code: "QX", variableName: "X", type: "multi_select", text: "",
        options: [
          { code: "1", label: "One", visibleIf: cond.rule("qr", "eq", 9) },
          { code: "2", label: "Two" },
        ],
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["qr", "qx"] }],
  });
  const state = createResponseState(def, { seed: 1 });
  state.answers["qr"] = 9;
  state.answers["qr@1"] = 1; // a loop-scoped answer for a DIFFERENT iteration
  assert.deepEqual(
    effectiveQuestion(def.questions[1], { def, state }).options.map((o) => String(o.code)),
    ["1", "2"],
  );
});

/* --------------------------------------------------------- backward compat */

test("§33 a question with no option logic behaves exactly as before", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [
      {
        id: "q1",
        code: "Q1",
        variableName: "A",
        type: "multi_select",
        text: "",
        options: BRANDS,
      },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
  const q = def.questions[0];
  assert.equal(q.optionPipeline.length, 0);
  assert.equal(q.options[0].logic, undefined);
  assert.deepEqual(
    effectiveQuestion(q, ctxFor(def, {})).options.map((o) => String(o.code)),
    BRANDS.map((b) => b.code),
  );
});
