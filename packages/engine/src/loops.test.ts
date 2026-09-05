import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  answerKey, buildVariableDictionary, compileFlow, createResponseState, createScriptCtx, evaluateCondition,
  flattenVariables, loopContexts, loopVariables, loopVariableNames, parseLogicExpression, parsePipeBody,
  lintLoops, resolveLoopItems, resolvePiping, runCalculations, runScript, serializePipeToken, simulateLoop,
} from "./index.js";
import type { LoopFlowNode } from "./loops.js";

/**
 * THE LOOP ENGINE'S CONTRACT.
 *
 * The rule under test everywhere here is the requirement's central one: a
 * loop's reference columns belong to THAT loop. Two loops over the same
 * question carry different tables, the source question never learns about
 * either, and every reader — piping, conditions, calculations, scripts, the
 * export — reaches a reference only through the iteration's own context.
 *
 * The second rule is that nothing existing moved: a loop written before any of
 * this behaves byte-for-byte as it did, which the first test pins.
 */

const BRANDS = [
  { code: 1, label: "Apple" },
  { code: 2, label: "Samsung" },
  { code: 3, label: "Google" },
  { code: 4, label: "OnePlus" },
  { code: 5, label: "Xiaomi" },
];

/** Q2 brands, Q6/Q7 inside the loop body, Q9 a plain follow-up. */
function survey(loop: Partial<LoopFlowNode> & { source?: LoopFlowNode["source"] } = {}, extraFlow: unknown[] = []) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Loops", version: "1.0" },
    questions: [
      { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Brands?", options: BRANDS },
      { id: "q6", code: "Q6", variableName: "Q6", type: "single_select", text: "Satisfied with {{loop.label}}?",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q7", code: "Q7", variableName: "Q7", type: "numeric", text: "Product {{loop.Product_ID}} rating for {{CURRENT_ITEM.Brand_Nickname}} in {{CURRENT_ITEM.Category}}" },
      { id: "q9", code: "Q9", variableName: "Q9", type: "text", text: "Anything else?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q2"] },
      {
        type: "loop", id: "loop1", loopVar: "brand",
        source: { kind: "question", questionId: "q2", filter: "selected" },
        children: [{ type: "block", id: "b2", title: "Block 2", children: [{ type: "page", id: "p6", questionIds: ["q6", "q7"] }] }],
        ...loop,
      },
      ...extraFlow,
      { type: "page", id: "p9", questionIds: ["q9"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

/** The reference table the requirement uses as its running example (§4, §15). */
const REFS = {
  columns: [
    { name: "Brand_Nickname", dataType: "text" as const },
    { name: "Product_ID", dataType: "text" as const },
    { name: "Client_Code", dataType: "text" as const },
    { name: "Category", dataType: "text" as const },
    { name: "Priority", dataType: "number" as const },
  ],
  values: {
    "1": { Brand_Nickname: "APPLE", Product_ID: "PROD_001", Client_Code: "C001", Category: "Smartphone", Priority: 2 },
    "2": { Brand_Nickname: "SAMSUNG", Product_ID: "PROD_002", Client_Code: "C002", Category: "Smartphone", Priority: 3 },
    "3": { Brand_Nickname: "GOOGLE", Product_ID: "PROD_003", Client_Code: "C003", Category: "Smartphone", Priority: 1 },
    "4": { Brand_Nickname: "ONEPLUS", Product_ID: "PROD_004", Client_Code: "C004", Category: "Phone", Priority: "5" },
    "5": { Brand_Nickname: "XIAOMI", Product_ID: "PROD_005", Client_Code: "C005", Category: "Accessory", Priority: 4 },
  },
};

const loopNode = (def: SurveyDefinition, id = "loop1") =>
  def.flow.find((n) => n.type === "loop" && n.id === id) as LoopFlowNode;

const pagesOf = (def: SurveyDefinition, state: ReturnType<typeof createResponseState>) =>
  compileFlow(def, state).filter((s) => s.kind === "page") as any[];

/* ============================================================ nothing moved */

test("a loop written before references existed behaves exactly as it did", () => {
  const def = survey();
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3, 5];
  const pages = pagesOf(def, state);
  assert.equal(pages.length, 5, "Q2, three iterations, Q9");
  assert.deepEqual(pages.slice(1, 4).map((p) => p.loop.label), ["Apple", "Google", "Xiaomi"]);
  assert.deepEqual(pages.slice(1, 4).map((p) => p.pageId), ["p6@1", "p6@3", "p6@5"], "single-loop keys are unchanged");
  assert.equal(answerKey("q6", pages[1].loop), "q6@1");
  assert.equal(pages[1].loop.index, 1);
  assert.equal(pages[1].loop.count, 3, "and the context now also knows the count");
  assert.deepEqual(pages[1].loop.references, {}, "a loop with no reference table has an empty row, not a missing one");
});

test("legacy randomizeIterations / maxIterations still mean what they meant", () => {
  const def = survey({ randomizeIterations: true, maxIterations: 2 } as any);
  const state = createResponseState(def, { seed: 7 });
  state.answers.q2 = [1, 2, 3, 4, 5];
  const a = pagesOf(def, state).filter((p) => p.loop).map((p) => p.loop.code);
  assert.equal(a.length, 2, "maxIterations caps");
  const again = pagesOf(def, createResponseState(def, { seed: 7, }) ).length; // no answers → no iterations
  assert.equal(again, 2);
  const b = pagesOf(def, Object.assign(createResponseState(def, { seed: 7 }), { answers: { q2: [1, 2, 3, 4, 5] } })).filter((p) => p.loop).map((p) => p.loop.code);
  assert.deepEqual(a, b, "the same seed gives the same order — the seed key did not change");
});

/* ============================================================ references */

test("§2/§40: the source question is not touched by a loop's reference table", () => {
  const withRefs = survey({ references: REFS }).questions.find((q) => q.id === "q2")!;
  const without = survey().questions.find((q) => q.id === "q2")!;
  assert.deepEqual(withRefs, without, "Q2 is byte-for-byte the same whether or not a loop over it carries a table");
  assert.equal((withRefs as any).references, undefined);
});

test("§19/§21/§22: the current item's references pipe into a question, several at once", () => {
  const def = survey({ references: REFS });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  const [, apple, google] = pagesOf(def, state);
  const q7 = def.questions.find((q) => q.id === "q7")!;
  assert.equal(resolvePiping(q7.text, { def, state, loop: apple.loop }),
    "Product PROD_001 rating for APPLE in Smartphone");
  assert.equal(resolvePiping(q7.text, { def, state, loop: google.loop }),
    "Product PROD_003 rating for GOOGLE in Smartphone");
  assert.equal(resolvePiping("{{CURRENT_ITEM}} #{{LOOP_INDEX}} of {{LOOP_COUNT}} ({{CURRENT_ITEM_CODE}})", { def, state, loop: google.loop }),
    "Google #2 of 2 (3)");
});

test("an unknown reference pipes empty — never the label", () => {
  const def = survey({ references: REFS });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1];
  const [, apple] = pagesOf(def, state);
  assert.equal(resolvePiping("[{{loop.Nope}}]", { def, state, loop: apple.loop }), "[]",
    "a {{loop.Category}} on a loop with no such column used to pipe the brand name into the sentence");
  assert.equal(resolvePiping("[{{loop.label}}]", { def, state, loop: apple.loop }), "[Apple]");
});

test("reference values are HTML-escaped like every other pipe", () => {
  const def = survey({ references: { columns: [{ name: "Note" }], values: { "1": { Note: "<b>x</b> & y" } } } });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1];
  const [, apple] = pagesOf(def, state);
  assert.equal(resolvePiping("{{loop.Note}}", { def, state, loop: apple.loop }), "&lt;b&gt;x&lt;/b&gt; &amp; y");
});

test("§6/§41: two loops over the same question carry different tables and never meet", () => {
  const def = survey({ references: REFS }, [{
    type: "loop", id: "loop2", loopVar: "client",
    source: { kind: "question", questionId: "q2", filter: "selected" },
    references: { columns: [{ name: "Region" }, { name: "Store_ID" }], values: { "1": { Region: "West", Store_ID: "S-9" } } },
    children: [{ type: "page", id: "p8", questionIds: ["q9"] }],
  }]);
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1];
  const pages = pagesOf(def, state);
  const inLoop1 = pages.find((p) => p.pageId === "p6@1")!;
  const inLoop2 = pages.find((p) => p.pageId === "p8@1")!;
  assert.deepEqual(Object.keys(inLoop1.loop.references), ["Brand_Nickname", "Product_ID", "Client_Code", "Category", "Priority"]);
  assert.deepEqual(Object.keys(inLoop2.loop.references), ["Region", "Store_ID"]);
  assert.equal(resolvePiping("{{loop.Region}}", { def, state, loop: inLoop1.loop }), "", "loop1 cannot see loop2's column");
  assert.equal(resolvePiping("{{loop.Region}}", { def, state, loop: inLoop2.loop }), "West");
  assert.equal(resolvePiping("{{loop.Product_ID}}", { def, state, loop: inLoop2.loop }), "", "and loop2 cannot see loop1's");
});

test("references are typed per column", () => {
  const def = survey({ references: REFS });
  const items = resolveLoopItems(def, Object.assign(createResponseState(def, { seed: 1 }), { answers: { q2: [4] } }), loopNode(def));
  assert.equal(items[0].references.Priority, 5, "a numeric column stored as \"5\" reads as the number 5");
  assert.equal(items[0].references.Category, "Phone");
});

/* ============================================================ conditions */

test("§27: display logic on a reference is evaluated per iteration", () => {
  const def = survey({ references: REFS });
  const showQ7 = { type: "rule", source: { kind: "loop", ref: "Category" }, operator: "eq", value: "Smartphone" } as any;
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 4, 5];
  const [, apple, oneplus, xiaomi] = pagesOf(def, state);
  assert.equal(evaluateCondition(showQ7, { def, state, loop: apple.loop }), true);
  assert.equal(evaluateCondition(showQ7, { def, state, loop: oneplus.loop }), false);
  assert.equal(evaluateCondition(showQ7, { def, state, loop: xiaomi.loop }), false);
  // a numeric column compares numerically
  const highPriority = { type: "rule", source: { kind: "loop", ref: "Priority" }, operator: "gte", value: 4 } as any;
  assert.equal(evaluateCondition(highPriority, { def, state, loop: apple.loop }), false);
  assert.equal(evaluateCondition(highPriority, { def, state, loop: xiaomi.loop }), true);
});

test("the expression language reads loop.<Column>, CURRENT_ITEM.<Column> and the aliases", () => {
  const def = survey({ references: REFS });
  for (const text of ['loop.Category = "Smartphone"', 'CURRENT_ITEM.Category = "Smartphone"']) {
    const r = parseLogicExpression(def, text);
    assert.equal(r.errors.length, 0, `${text}: ${JSON.stringify(r.errors)}`);
    const rule = r.condition as any;
    assert.equal(rule.source.kind, "loop");
    assert.equal(rule.source.ref, "Category");
  }
  const idx = parseLogicExpression(def, "LOOP_INDEX > 1");
  assert.equal(idx.errors.length, 0);
  assert.equal((idx.condition as any).source.ref, "index");
  const cnt = parseLogicExpression(def, "LOOP_COUNT = 3");
  assert.equal(cnt.errors.length, 0);
  assert.equal((cnt.condition as any).source.ref, "count");
});

/* ============================================================ filters */

const withAnswers = (def: SurveyDefinition, answers: Record<string, unknown>, seed = 1) =>
  Object.assign(createResponseState(def, { seed }), { answers });

test("§9/§10: selected and not-selected", () => {
  const sel = survey({ source: { kind: "question", questionId: "q2", filter: "selected" } });
  assert.deepEqual(resolveLoopItems(sel, withAnswers(sel, { q2: [1, 3, 5] }), loopNode(sel)).map((i) => i.code), ["1", "3", "5"]);
  const not = survey({ source: { kind: "question", questionId: "q2", filter: "notSelected" } });
  assert.deepEqual(resolveLoopItems(not, withAnswers(not, { q2: [1, 3, 5] }), loopNode(not)).map((i) => i.code), ["2", "4"],
    "3 of 5 selected leaves 2 iterations");
});

test("the never-implemented `displayed` filter now runs the option pipeline", () => {
  const def = survey({ source: { kind: "question", questionId: "q2", filter: "displayed" } });
  // no display rules on Q2, so displayed = all five; the point is that it is
  // not the answer (which would be []) any more
  assert.equal(resolveLoopItems(def, withAnswers(def, {}), loopNode(def)).length, 5);
});

test("§11: invalid = codes that match no option, plus whatever invalidIf says", () => {
  const def = survey({
    source: { kind: "question", questionId: "q2", filter: "invalid" },
    references: REFS,
    invalidIf: { type: "rule", source: { kind: "loop", ref: "Category" }, operator: "eq", value: "Accessory" } as any,
  });
  const items = resolveLoopItems(def, withAnswers(def, { q2: [1, 99] }), loopNode(def)).map((i) => i.code);
  assert.deepEqual(items.sort(), ["5", "99"].sort(), "99 is not an option; Xiaomi is an Accessory");
});

test("§12: eligibility is a per-loop rule that can read the item's references", () => {
  const def = survey({
    source: { kind: "question", questionId: "q2", filter: "eligible" },
    references: REFS,
    eligibleIf: { type: "rule", source: { kind: "loop", ref: "Category" }, operator: "eq", value: "Smartphone" } as any,
  });
  assert.deepEqual(resolveLoopItems(def, withAnswers(def, {}), loopNode(def)).map((i) => i.code), ["1", "2", "3"]);
  // and it narrows a selected filter too
  const sel = survey({ source: { kind: "question", questionId: "q2", filter: "selected" }, references: REFS,
    eligibleIf: { type: "rule", source: { kind: "loop", ref: "Category" }, operator: "eq", value: "Smartphone" } as any });
  assert.deepEqual(resolveLoopItems(sel, withAnswers(sel, { q2: [1, 4, 5] }), loopNode(sel)).map((i) => i.code), ["1"]);
});

/* ============================================================ count */

test("§13: count — all, exact, max, min, and from a question", () => {
  const base = { source: { kind: "question", questionId: "q2", filter: "selected" } } as const;
  const all = survey({ ...base, count: { mode: "all" } });
  assert.equal(resolveLoopItems(all, withAnswers(all, { q2: [1, 2, 3, 4] }), loopNode(all)).length, 4);
  const max2 = survey({ ...base, count: { mode: "max", value: 2 } });
  assert.equal(resolveLoopItems(max2, withAnswers(max2, { q2: [1, 2, 3, 4] }), loopNode(max2)).length, 2);
  const exact3 = survey({ ...base, count: { mode: "exact", value: 3 } });
  assert.equal(resolveLoopItems(exact3, withAnswers(exact3, { q2: [1, 2] }), loopNode(exact3)).length, 2, "exact never invents items");
  const min3 = survey({ ...base, count: { mode: "min", value: 3 } });
  assert.equal(resolveLoopItems(min3, withAnswers(min3, { q2: [1, 2] }), loopNode(min3)).length, 0, "min is a gate");
  assert.equal(resolveLoopItems(min3, withAnswers(min3, { q2: [1, 2, 3] }), loopNode(min3)).length, 3);
  // Loop Count = Q2_SELECTED_COUNT → a count read from the question itself
  const fromQ = survey({ source: { kind: "count", count: { kind: "question", ref: "Q2" } } });
  assert.deepEqual(resolveLoopItems(fromQ, withAnswers(fromQ, { q2: [1, 3, 5] }), loopNode(fromQ)).map((i) => i.code), ["1", "2", "3"]);
});

/* ============================================================ order */

test("§14: order — source, selection, priority, custom, random, weighted", () => {
  const sel = (order: any) => survey({ source: { kind: "question", questionId: "q2", filter: "selected" }, references: REFS, order });
  const answers = { q2: [5, 1, 3] }; // chosen Xiaomi first
  const codes = (def: SurveyDefinition, seed = 1) => resolveLoopItems(def, withAnswers(def, answers, seed), loopNode(def)).map((i) => i.code);

  assert.deepEqual(codes(sel({ kind: "source" })), ["1", "3", "5"], "the order of the options");
  assert.deepEqual(codes(sel({ kind: "selection" })), ["5", "1", "3"], "the order the respondent chose");
  assert.deepEqual(codes(sel({ kind: "priority", column: "Priority" })), ["3", "1", "5"], "Google=1, Apple=2, Xiaomi=4");
  assert.deepEqual(codes(sel({ kind: "priority", column: "Priority", direction: "desc" })), ["5", "1", "3"]);
  assert.deepEqual(codes(sel({ kind: "custom", custom: ["3", "5"] })), ["3", "5", "1"], "unlisted follow in source order");

  const r1 = codes(sel({ kind: "random" }), 42);
  const r2 = codes(sel({ kind: "random" }), 42);
  assert.deepEqual(r1, r2, "random is deterministic per respondent");
  assert.deepEqual([...r1].sort(), ["1", "3", "5"]);

  const w1 = codes(sel({ kind: "weightedRandom", column: "Priority" }), 42);
  assert.deepEqual([...w1].sort(), ["1", "3", "5"], "weighted random is a permutation");
  assert.deepEqual(w1, codes(sel({ kind: "weightedRandom", column: "Priority" }), 42), "and stable");
});

/* ============================================================ other sources */

test("§8: static, count, and variable sources", () => {
  const stat = survey({ source: { kind: "static", items: [{ code: "a", label: "A" }, { code: "b", label: "B" }] } });
  assert.deepEqual(resolveLoopItems(stat, withAnswers(stat, {}), loopNode(stat)).map((i) => i.label), ["A", "B"]);

  const n = survey({ source: { kind: "count", count: 3 } });
  assert.deepEqual(resolveLoopItems(n, withAnswers(n, {}), loopNode(n)).map((i) => i.code), ["1", "2", "3"]);

  // a list a script or calculation left in a variable — JSON with labels, or delimited codes
  const v = survey({ source: { kind: "variable", ref: "MY_LIST" } });
  const st = withAnswers(v, {});
  st.calculated.MY_LIST = '[{"code":"x","label":"Ex"},{"code":"y","label":"Why"}]';
  assert.deepEqual(resolveLoopItems(v, st, loopNode(v)).map((i) => `${i.code}:${i.label}`), ["x:Ex", "y:Why"]);
  st.calculated.MY_LIST = "p, q ;r";
  assert.deepEqual(resolveLoopItems(v, st, loopNode(v)).map((i) => i.code), ["p", "q", "r"]);
});

/* ============================================================ nesting */

function nested() {
  return SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "Nested", version: "1.0" },
    questions: [
      { id: "qb", code: "QB", variableName: "QB", type: "multi_select", text: "Brands", options: [{ code: "a", label: "Apple" }, { code: "g", label: "Google" }] },
      { id: "qp", code: "QP", variableName: "QP", type: "multi_select", text: "Products of {{brand.label}}", options: [{ code: "x", label: "Phone" }, { code: "y", label: "Watch" }] },
      { id: "qr", code: "QR", variableName: "QR", type: "numeric", text: "{{brand.label}} {{loop.label}}: {{brand.Region}} / {{loop.Sku}}" },
      { id: "qo", code: "QO", variableName: "QO", type: "text", text: "Overall for {{loop.label}}" },
    ],
    flow: [
      { type: "page", id: "p0", questionIds: ["qb"] },
      {
        type: "loop", id: "outer", loopVar: "brand",
        source: { kind: "question", questionId: "qb", filter: "selected" },
        references: { columns: [{ name: "Region" }], values: { a: { Region: "US" }, g: { Region: "EU" } } },
        children: [
          { type: "page", id: "pp", questionIds: ["qp"] },
          {
            type: "loop", id: "inner", loopVar: "product",
            source: { kind: "question", questionId: "qp", filter: "selected" },
            references: { columns: [{ name: "Sku" }], values: { x: { Sku: "SKU-X" }, y: { Sku: "SKU-Y" } } },
            children: [{ type: "page", id: "pr", questionIds: ["qr"] }],
          },
          { type: "page", id: "po", questionIds: ["qo"] },
        ],
      },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("§32: nested loops — keys stack, contexts stack, and each loop keeps its own namespace", () => {
  const def = nested();
  const state = createResponseState(def, { seed: 1 });
  state.answers.qb = ["a", "g"];
  state.answers["qp@a"] = ["x", "y"];   // Apple: phone and watch
  state.answers["qp@g"] = ["y"];        // Google: watch
  const pages = pagesOf(def, state);
  assert.deepEqual(pages.map((p) => p.pageId), [
    "p0", "pp@a", "pr@a@x", "pr@a@y", "po@a", "pp@g", "pr@g@y", "po@g",
  ], "the inner page id carries BOTH codes — before this it was pr@x for every outer iteration");

  const appleWatch = pages.find((p) => p.pageId === "pr@a@y")!;
  assert.equal(appleWatch.loop.loopVar, "product");
  assert.equal(appleWatch.loop.parent.loopVar, "brand");
  assert.equal(appleWatch.loop.parent.code, "a");
  assert.equal(answerKey("qr", appleWatch.loop), "qr@a@y", "so two outer iterations can never overwrite each other's inner answers");

  const qr = def.questions.find((q) => q.id === "qr")!;
  assert.equal(resolvePiping(qr.text, { def, state, loop: appleWatch.loop }), "Apple Watch: US / SKU-Y",
    "{{brand.x}} reaches the outer loop by name, {{loop.x}} is the innermost");
  const googleWatch = pages.find((p) => p.pageId === "pr@g@y")!;
  assert.equal(resolvePiping(qr.text, { def, state, loop: googleWatch.loop }), "Google Watch: EU / SKU-Y");

  // the inner loop's source (qp) is read loop-scoped through the OUTER context
  assert.equal(pages.filter((p) => p.pageId.startsWith("pr@g")).length, 1, "Google's inner loop has one product, not Apple's two");

  // a condition can name the outer loop
  const rule = { type: "rule", source: { kind: "loop", ref: "Region", scope: "brand" }, operator: "eq", value: "EU" } as any;
  assert.equal(evaluateCondition(rule, { def, state, loop: appleWatch.loop }), false);
  assert.equal(evaluateCondition(rule, { def, state, loop: googleWatch.loop }), true);
  const parsed = parseLogicExpression(def, 'brand.Region = "EU"');
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.deepEqual((parsed.condition as any).source, { kind: "loop", ref: "Region", scope: "brand" });
});

/* ============================================================ variables & export */

test("§24: LOOP_* variables — count, item, code, and one per reference column", () => {
  const def = survey({ references: REFS });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [3, 1];
  runCalculations(def, state, "on_change");
  assert.equal(state.calculated.LOOP_BRAND_COUNT, 2);
  assert.equal(state.calculated.LOOP_BRAND_ITEM_1, "Apple", "source order by default");
  assert.equal(state.calculated.LOOP_BRAND_ITEM_1_CODE, "1");
  assert.equal(state.calculated.LOOP_BRAND_ITEM_1_BRAND_NICKNAME, "APPLE");
  assert.equal(state.calculated.LOOP_BRAND_ITEM_1_PRODUCT_ID, "PROD_001");
  assert.equal(state.calculated.LOOP_BRAND_ITEM_2_CODE, "3");
  assert.equal(state.calculated.LOOP_BRAND_ITEM_2_PRIORITY, 1);
  // the pure function agrees with what runCalculations wrote
  assert.deepEqual(loopVariables(def, state).LOOP_BRAND_ITEM_2_CLIENT_CODE, "C003");
});

test("§29/§37: the dictionary declares Q7_1..Q7_N and the LOOP_* variables, scoped to the loop", () => {
  const def = survey({ references: REFS });
  const dict = buildVariableDictionary(def);
  const q7 = dict.filter((v) => v.name.startsWith("Q7"));
  assert.deepEqual(q7.map((v) => v.name), ["Q7_1", "Q7_2", "Q7_3", "Q7_4", "Q7_5"], "five options → five positional columns, declared up front");
  assert.ok(q7.every((v) => v.loopId === "loop1" && v.loopVar === "brand"));
  assert.deepEqual(q7.map((v) => v.iteration), [1, 2, 3, 4, 5]);
  assert.equal(dict.some((v) => v.name === "Q7"), false, "and no dead unsuffixed column");

  const q6 = dict.filter((v) => v.name.startsWith("Q6"));
  assert.equal(q6.length, 5);

  const loopVars = dict.filter((v) => v.responseType === "loop");
  assert.ok(loopVars.some((v) => v.name === "LOOP_BRAND_COUNT"));
  const ref = loopVars.find((v) => v.name === "LOOP_BRAND_ITEM_1_CATEGORY")!;
  assert.equal(ref.referenceColumn, "Category");
  assert.equal(ref.loopId, "loop1");
  assert.match(ref.notes ?? "", /belongs to this loop only/);
  assert.equal(loopVars.filter((v) => v.iteration === 1).length, 2 + REFS.columns.length, "item, code, and one per column");
  assert.equal(dict.some((v) => v.name === "Q9_1"), false, "a question outside the loop is not iterated");
  assert.equal(dict.some((v) => v.name === "Q9"), true);
});

test("flatten places each iteration's answer in its positional column, by the item that ran there", () => {
  const def = survey({ references: REFS, order: { kind: "custom", custom: ["5", "1"] } });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 5];
  runCalculations(def, state, "on_change");
  const pages = pagesOf(def, state).filter((p) => p.loop);
  assert.deepEqual(pages.map((p) => p.loop.code), ["5", "1"], "Xiaomi runs first by custom order");
  state.answers[answerKey("q7", pages[0].loop)] = 9;  // q7@5
  state.answers[answerKey("q7", pages[1].loop)] = 4;  // q7@1
  state.answers[answerKey("q6", pages[0].loop)] = 2;
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q7_1, 9, "position 1 held Xiaomi");
  assert.equal(flat.Q7_2, 4);
  assert.equal(flat.Q6_1, 2);
  assert.equal(flat.LOOP_BRAND_ITEM_1_CODE, "5", "and the code column says which item position 1 was");
  assert.equal(flat.Q7_5, undefined, "no phantom code-suffixed column");
  assert.equal(flat.Q7_1_CODE, undefined);
});

test("flatten of a response stored before the loop variables existed falls back to the old naming", () => {
  const def = survey();
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1];
  state.answers["q7@1"] = 7;
  // no runCalculations — no LOOP_* in calculated, as an old stored response
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q7_1, 7, "here the code happens to be 1; the point is the value is not lost");
});

test("nested loops flatten to Q_outer_inner and place the inner variables under the outer item", () => {
  const def = nested();
  const state = createResponseState(def, { seed: 1 });
  state.answers.qb = ["a", "g"];
  state.answers["qp@a"] = ["x", "y"];
  state.answers["qp@g"] = ["y"];
  state.answers["qr@a@x"] = 1;
  state.answers["qr@a@y"] = 2;
  state.answers["qr@g@y"] = 3;
  runCalculations(def, state, "on_change");
  assert.equal(state.calculated.LOOP_BRAND_A_LOOP_PRODUCT_COUNT, 2, "the inner loop's variables are produced per outer item");
  assert.equal(state.calculated.LOOP_BRAND_G_LOOP_PRODUCT_COUNT, 1);
  assert.equal(state.calculated.LOOP_BRAND_A_LOOP_PRODUCT_ITEM_2_SKU, "SKU-Y");
  const flat = flattenVariables(def, state);
  assert.equal(flat.QR_1_1, 1);
  assert.equal(flat.QR_1_2, 2);
  assert.equal(flat.QR_2_1, 3, "Google's first (only) product");
  assert.deepEqual(flat.QP_1, ["x", "y"], "a multi-select inside the outer loop flattens per outer position");
  assert.equal(flat.QP_1_x, 1);
  assert.equal(flat.QP_2_x, 0);
  const dict = buildVariableDictionary(def);
  assert.ok(dict.some((v) => v.name === "QR_1_1"), "positional columns are declared for both depths");
  assert.ok(dict.some((v) => v.name === "QR_2_2"));
});

/* ============================================================ scripts */

test("§31: scripts read the loop through named accessors with dynamic reference names", () => {
  const def = survey({ references: REFS });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  const [, apple] = pagesOf(def, state);
  const result = { logs: [], errors: [] } as any;
  const ctx = createScriptCtx(def, state, apple.loop, result);
  const r = runScript(`
    log(getCurrentLoopItem().label, getCurrentLoopIndex(), getLoopCount());
    log(getCurrentLoopReference("Product_ID"), getCurrentLoopReference("Client_Code"), getCurrentLoopReference("Nope"));
    log(getLoopItems().map((i) => i.code).join(","));
    set("Q7", 42);
    log(getLoopAnswer("Q7", "1"), getLoopAnswer("Q7", "3"));
  `, ctx);
  assert.equal(r.failed, undefined, r.failed);
  // `log` writes to the result the ctx was created with, not runScript's own
  assert.deepEqual(result.logs, ["Apple 1 2", "PROD_001 C001 null", "1,3", "42 null"]);
  assert.equal(state.answers["q7@1"], 42, "set() stays loop-scoped");
});

/* ============================================================ simulator & tokens */

test("§34: the simulator is the runtime's own resolution against a hypothetical state", () => {
  const def = survey({ references: REFS });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3, 5];
  const sim = simulateLoop(def, loopNode(def), state);
  assert.equal(sim.count, 3);
  assert.deepEqual(sim.columns, REFS.columns.map((c) => c.name));
  assert.deepEqual(sim.iterations.map((i) => `${i.index} ${i.label} ${i.references.Product_ID}`), ["1 Apple PROD_001", "2 Google PROD_003", "3 Xiaomi PROD_005"]);
  // and it IS the same answer the flow gives
  assert.deepEqual(loopContexts(def, state, loopNode(def)).map((c) => c.code), sim.iterations.map((i) => i.code));
});

test("piping tokens: the aliases parse to loop tokens and a scoped token round-trips", () => {
  assert.deepEqual(parsePipeBody("CURRENT_ITEM.Product_ID")?.ref, "Product_ID");
  assert.equal(parsePipeBody("CURRENT_ITEM")?.ref, "label");
  assert.equal(parsePipeBody("LOOP_COUNT")?.ref, "count");
  assert.equal(parsePipeBody("loop.Category")?.kind, "loop");
  assert.equal(serializePipeToken({ kind: "loop", ref: "Region", scope: "brand", property: "value" }), "{{brand.Region}}");
  assert.equal(serializePipeToken({ kind: "loop", ref: "Region", property: "value" }), "{{loop.Region}}");
});

test("loopVariableNames declares nothing positional for an unbounded loop, and the count always", () => {
  const def = survey({ source: { kind: "variable", ref: "MY_LIST" } });
  const names = loopVariableNames(def, loopNode(def));
  assert.deepEqual(names.map((n) => n.name), ["LOOP_BRAND_COUNT"]);
});

/* ============================================================ lint */

test("the lint names the mistakes the runtime would swallow", () => {
  const def = survey({
    references: { columns: [{ name: "Category", required: true }, { name: "Priority" }], values: { "1": { Category: "Smartphone" } } },
    order: { kind: "priority", column: "Nope" },
    count: { mode: "exact", value: 9 },
  });
  // a token spelling a column the loop does not have
  def.questions.find((q) => q.id === "q6")!.text = "How is {{loop.Nickname}}?";
  const issues = lintLoops(def);
  const msgs = issues.map((i) => i.message);
  assert.ok(msgs.some((m) => /no reference column "Nickname"/.test(m)), "an unknown column in a token is named");
  assert.ok(msgs.some((m) => /required column "Category" has no value for/.test(m)), "a required hole is named");
  assert.ok(msgs.some((m) => /orders by "Nope"/.test(m)), "an unknown order column is named");
  assert.ok(msgs.some((m) => /exactly 9 iterations but the source has 5/.test(m)), "a count the source cannot supply is named");
  assert.equal(issues.filter((i) => /Nickname/.test(i.message))[0].level, "error");

  const clean = survey({ references: REFS });
  assert.deepEqual(lintLoops(clean), [], "a well-formed loop has nothing to say");

  // a loop over a question asked after it
  const late = survey();
  late.flow = [late.flow[1], late.flow[0], ...late.flow.slice(2)];
  assert.ok(lintLoops(late).some((i) => /asked after the loop/.test(i.message)));

  // a loop token outside every loop
  const stray = survey();
  stray.questions.find((q) => q.id === "q9")!.text = "Bye {{loop.label}}";
  assert.ok(lintLoops(stray).some((i) => /not inside a loop/.test(i.message)));

  // nested loops with the same name
  const same = nested();
  (same.flow[1] as any).children[1].loopVar = "brand";
  assert.ok(lintLoops(same).some((i) => /nested inside another loop with the same name/.test(i.message)));
});
