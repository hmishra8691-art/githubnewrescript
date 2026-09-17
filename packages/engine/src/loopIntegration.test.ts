import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  MAX_LOOP_PRODUCT, blockDependencies, calcOptionsFor, compileFlow, createResponseState, createScriptCtx,
  describeLoop, evaluateCondition, evaluateExpression, lintLoops, loopValue, parseLogicExpression, parsePipeBody,
  resolveLoopItems, resolvePiping, runCalculations, runScript, runScripts,
} from "./index.js";
import type { LoopFlowNode } from "./loops.js";

/**
 * THE LOOP ENGINE MEETS THE REST OF THE ENGINE.
 *
 * `loops.test.ts` pins the loop's own contract; `loopControlFlow.test.ts` its
 * control flow. This file is about everything the loop has to work WITH — the
 * context variables every body eventually asks for (first / last), the calc
 * language and the scripts seeing the iteration they run in, randomization
 * that is independent per iteration and stable per respondent, masks that
 * report per iteration, the nest that cannot hang a tab, a snapshot that
 * does not outlive its definition, and the lints that say plainly which
 * per-respondent mechanisms are not per-iteration.
 */

const BRANDS = [
  { code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" },
  { code: 4, label: "OnePlus" }, { code: 5, label: "Xiaomi" },
];

function survey(loop: Partial<LoopFlowNode> = {}, extra: { questions?: unknown[]; flow?: unknown[]; body?: unknown[]; listFills?: unknown[]; scripts?: unknown[] } = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Loops", version: "1.0" },
    questions: [
      { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Brands?", options: BRANDS },
      { id: "q6", code: "Q6", variableName: "Q6", type: "single_select", text: "Satisfied with {{loop.label}}?",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q7", code: "Q7", variableName: "Q7", type: "numeric", text: "Rating for {{CURRENT_ITEM}}" },
      { id: "q9", code: "Q9", variableName: "Q9", type: "text", text: "Anything else?" },
      ...(extra.questions ?? []),
    ],
    listFills: extra.listFills ?? [],
    scripts: extra.scripts ?? [],
    flow: [
      { type: "page", id: "p1", questionIds: ["q2"] },
      {
        type: "loop", id: "loop1", loopVar: "brand",
        source: { kind: "question", questionId: "q2", filter: "selected" },
        children: extra.body ?? [{ type: "page", id: "p6", questionIds: ["q6", "q7"] }],
        ...loop,
      },
      ...(extra.flow ?? []),
      { type: "page", id: "p9", questionIds: ["q9"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

const pagesOf = (def: SurveyDefinition, state: ReturnType<typeof createResponseState>) =>
  compileFlow(def, state).filter((s) => s.kind === "page") as any[];

/* ============================================================ first / last */

test("loop.first, loop.last, loop.item and loop.depth exist in every surface", () => {
  const def = survey();
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3, 5];
  const [, apple, google, xiaomi] = pagesOf(def, state);

  // the one definition
  assert.equal(loopValue(apple.loop, "first"), true);
  assert.equal(loopValue(apple.loop, "last"), false);
  assert.equal(loopValue(xiaomi.loop, "last"), true);
  assert.equal(loopValue(google.loop, "first"), false);
  assert.equal(loopValue(google.loop, "item"), "Google");
  assert.equal(loopValue(google.loop, "depth"), 1);
  // unknown count → last is unknown, not "no"
  assert.equal(loopValue({ loopVar: "x", code: "1", label: "One", index: 1 }, "last"), null);

  // piping, both spellings
  assert.equal(resolvePiping("{{loop.first}}/{{LOOP_LAST}}/{{loop.item}}", { def, state, loop: apple.loop }), "true/false/Apple");
  assert.equal(parsePipeBody("LOOP_FIRST")?.kind, "loop");
  assert.equal((parsePipeBody("LOOP_LAST") as any).ref, "last");

  // the expression language → a condition
  for (const text of ["loop.first = true", "LOOP_FIRST = true"]) {
    const r = parseLogicExpression(def, text);
    assert.equal(r.errors.length, 0, `${text}: ${JSON.stringify(r.errors)}`);
    assert.equal(evaluateCondition(r.condition!, { def, state, loop: apple.loop }), true);
    assert.equal(evaluateCondition(r.condition!, { def, state, loop: google.loop }), false);
  }
  const last = parseLogicExpression(def, "loop.last = true");
  assert.equal(evaluateCondition(last.condition!, { def, state, loop: xiaomi.loop }), true);
  assert.equal(evaluateCondition(last.condition!, { def, state, loop: google.loop }), false);

  // the lint accepts the new builtins as reference names
  const withRule = survey({ eligibleIf: last.condition! });
  assert.equal(lintLoops(withRule).filter((i) => i.level === "error").length, 0);

  // scripts
  const result = { logs: [], errors: [] } as any;
  const r = runScript(`log(getCurrentLoopItem().first, getCurrentLoopItem().last, getCurrentLoopItem().item, getCurrentLoopItem().depth);`, createScriptCtx(def, state, xiaomi.loop, result));
  assert.equal(r.failed, undefined, r.failed);
  assert.deepEqual(result.logs, ["false true Xiaomi 1"]);
});

/* ============================================================ the calc language inside an iteration */

test("an expression evaluated inside an iteration sees that iteration's answers and the loop's properties", () => {
  const def = survey();
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  state.answers["q7@1"] = 9;
  state.answers["q7@3"] = 4;
  const [, apple, google] = pagesOf(def, state);

  const at = (loop: any, expr: string) => evaluateExpression(expr, calcOptionsFor(def, state, loop));
  assert.equal(at(apple.loop, "Q7"), 9);
  assert.equal(at(google.loop, "Q7"), 4);
  assert.equal(at(apple.loop, "Q7 * 10 + loop.index"), 91);
  assert.equal(at(google.loop, "LOOP_COUNT"), 2);
  assert.equal(at(google.loop, "loop.last"), true);
  assert.equal(at(apple.loop, "CURRENT_ITEM"), "Apple");
  // a survey-level answer still resolves the ordinary way
  state.answers.q9 = "hello";
  assert.equal(at(apple.loop, "Q9"), "hello");

  // …and so does an `expr` condition source inside the loop body
  const rule = parseLogicExpression(def, "Q7 >= 5");
  assert.equal(rule.errors.length, 0);
  // the condition builder produces an expr-source rule for arithmetic; emulate it directly
  const exprRule = { type: "rule", source: { kind: "expr", ref: "Q7 >= 5" }, operator: "eq", value: true } as any;
  assert.equal(evaluateCondition(exprRule, { def, state, loop: apple.loop }), true);
  assert.equal(evaluateCondition(exprRule, { def, state, loop: google.loop }), false);
});

test("a calculated question inside the loop body is one value per iteration", () => {
  const def = survey({}, {
    questions: [{ id: "qc", code: "QC", variableName: "QC", type: "calculated", text: "", settings: { expression: "Q7 * 2 + loop.index" } }],
    body: [{ type: "page", id: "p6", questionIds: ["q6", "q7", "qc"] }],
  });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  state.answers["q7@1"] = 10;
  state.answers["q7@3"] = 20;
  runCalculations(def, state, "on_page_submit");
  assert.equal(state.answers["qc@1"], 21);
  assert.equal(state.answers["qc@3"], 42);
  assert.equal(state.answers.qc, undefined, "no bare key that no iteration reads");
});

/* ============================================================ scripts */

test("page-scoped on_load scripts run per iteration with the iteration as `loop`; survey-wide ones are left alone", () => {
  const def = survey({}, {
    scripts: [
      { id: "s1", name: "page default", scope: "page", ref: "p6", event: "on_load", code: `if (get("Q7") == null) set("Q7", 5 + getCurrentLoopIndex()); log("page", getCurrentLoopItem().label);` },
      { id: "s2", name: "survey", scope: "survey", event: "on_load", code: `log("survey");` },
    ],
  });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  const [, apple, google] = pagesOf(def, state);
  const r1 = runScripts(def, state, "on_load", { scopeRef: "p6", loop: apple.loop, only: "scoped" });
  const r2 = runScripts(def, state, "on_load", { scopeRef: "p6", loop: google.loop, only: "scoped" });
  assert.equal(r1.ran, 1);
  assert.equal(r2.ran, 1);
  assert.deepEqual(r1.logs, ["[page default] page Apple"]);
  assert.equal(state.answers["q7@1"], 6);
  assert.equal(state.answers["q7@3"], 7);
  assert.equal(state.answers.q7, undefined);
  // the session-open call still runs only the survey-wide one
  const open = runScripts(def, state, "on_load");
  assert.deepEqual(open.logs, ["[survey] survey"]);
});

test("ctx.expr inside an iteration reads the iteration", () => {
  const def = survey();
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  state.answers["q7@3"] = 7;
  const [, , google] = pagesOf(def, state);
  const result = { logs: [], errors: [] } as any;
  runScript(`log(expr("Q7 + 1"));`, createScriptCtx(def, state, google.loop, result));
  assert.deepEqual(result.logs, ["8"]);
});

/* ============================================================ randomization */

test("a randomizer node inside a loop body draws per iteration, stably", () => {
  const body = [{
    type: "randomizer", id: "r1", children: [
      { type: "page", id: "pa", questionIds: ["q6"] },
      { type: "page", id: "pb", questionIds: ["q7"] },
      { type: "page", id: "pc", questionIds: ["qx"] },
    ],
  }];
  const def = survey({}, { body, questions: [{ id: "qx", code: "QX", variableName: "QX", type: "numeric", text: "x" }] });
  const orders = (seed: number) => {
    const state = createResponseState(def, { seed });
    state.answers.q2 = [1, 2, 3, 4, 5];
    const pages = pagesOf(def, state);
    const byIter = new Map<string, string[]>();
    for (const p of pages) if (p.loop) byIter.set(p.loop.code, [...(byIter.get(p.loop.code) ?? []), p.pageId.split("@")[0]]);
    return [...byIter.values()].map((v) => v.join(","));
  };
  const a = orders(7);
  assert.equal(a.length, 5);
  assert.ok(new Set(a).size > 1, `five iterations, one order for all: ${a.join(" | ")}`);
  assert.deepEqual(orders(7), a, "stable for the respondent");
});

test("a nested loop's random order is drawn per outer iteration", () => {
  const def = survey({}, {
    questions: [
      { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Products?", options: [{ code: "a", label: "A" }, { code: "b", label: "B" }, { code: "c", label: "C" }, { code: "d", label: "D" }, { code: "e", label: "E" }, { code: "f", label: "F" }] },
      { id: "q8", code: "Q8", variableName: "Q8", type: "numeric", text: "{{brand.label}} {{loop.label}}" },
    ],
    body: [{
      type: "loop", id: "loop2", loopVar: "product", order: { kind: "random" },
      source: { kind: "question", questionId: "q3", filter: "selected" },
      children: [{ type: "page", id: "p8", questionIds: ["q8"] }],
    }],
  });
  const state = createResponseState(def, { seed: 11 });
  state.answers.q2 = [1, 2, 3, 4, 5];
  state.answers.q3 = ["a", "b", "c", "d", "e", "f"];
  const pages = pagesOf(def, state);
  const byOuter = new Map<string, string[]>();
  for (const p of pages) if (p.loop?.parent) byOuter.set(p.loop.parent.code, [...(byOuter.get(p.loop.parent.code) ?? []), p.loop.code]);
  const orders = [...byOuter.values()].map((v) => v.join(""));
  assert.equal(orders.length, 5);
  assert.ok(new Set(orders).size > 1, `every outer item got the same inner order: ${orders.join(" ")}`);
  // and each one is the same on the next compile
  const again = new Map<string, string[]>();
  for (const p of pagesOf(def, state)) if (p.loop?.parent) again.set(p.loop.parent.code, [...(again.get(p.loop.parent.code) ?? []), p.loop.code]);
  assert.deepEqual([...again.values()].map((v) => v.join("")), orders);
});

/* ============================================================ safeguards */

test("the nest as a whole is capped, and depth beyond the limit yields nothing at runtime", () => {
  const big = { kind: "count" as const, count: 50 };
  const q = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "numeric", text: id });
  const def = survey({ source: big, loopVar: "a" }, {
    questions: [q("qa"), q("qb"), q("qc")],
    body: [{
      type: "loop", id: "lb", loopVar: "b", source: big,
      children: [{
        type: "loop", id: "lc", loopVar: "c", source: big,
        children: [{ type: "page", id: "pc", questionIds: ["qc"] }],
      }],
    }],
  });
  const state = createResponseState(def, { seed: 1 });
  const pages = pagesOf(def, state);
  assert.ok(pages.length <= MAX_LOOP_PRODUCT + 2, `${pages.length} pages compiled`);
  assert.ok(pages.length > 100, "the nest still runs, trimmed");
  const warns = lintLoops(def).filter((i) => i.path.endsWith(".nesting") && i.level === "warning");
  assert.ok(warns.length >= 1, "the author is told the nest exceeds the cap");
  assert.ok(warns.some((w) => /125,000|125000/.test(w.message)), warns.map((w) => w.message).join("\n"));

  // depth 6: the innermost loop resolves to nothing rather than compiling
  const inner = def.flow.find((n) => n.type === "loop") as LoopFlowNode;
  const deep = { loopVar: "z", code: "1", label: "1", index: 1, count: 1, parent: { loopVar: "y", code: "1", label: "1", index: 1, count: 1, parent: { loopVar: "x", code: "1", label: "1", index: 1, count: 1, parent: { loopVar: "w", code: "1", label: "1", index: 1, count: 1, parent: { loopVar: "v", code: "1", label: "1", index: 1, count: 1 } } } } };
  assert.equal(resolveLoopItems(def, state, inner, deep as any).length, 0);
});

test("a resolve-once snapshot is retaken when the loop's definition changes, and a pre-stamp snapshot is honoured", () => {
  const def = survey({ resolveSource: "once" });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  assert.deepEqual(resolveLoopItems(def, state, def.flow[1] as LoopFlowNode).map((i) => i.code), ["1", "3"]);
  state.answers.q2 = [1, 3, 5];
  assert.deepEqual(resolveLoopItems(def, state, def.flow[1] as LoopFlowNode).map((i) => i.code), ["1", "3"], "frozen for this definition");

  // the programmer changes the filter: the frozen list is no longer the loop's
  const changed = survey({ resolveSource: "once", source: { kind: "question", questionId: "q2", filter: "notSelected" } });
  assert.deepEqual(resolveLoopItems(changed, state, changed.flow[1] as LoopFlowNode).map((i) => i.code), ["2", "4"]);

  // a snapshot written before the stamp existed (a bare array) still counts
  const legacy = createResponseState(def, { seed: 1 });
  legacy.answers.q2 = [1, 3, 5];
  legacy.calculated.__LOOP_SNAPSHOT_loop1 = JSON.stringify([{ code: "2", label: "Samsung", sourceIndex: 1 }]);
  assert.deepEqual(resolveLoopItems(def, legacy, def.flow[1] as LoopFlowNode).map((i) => i.code), ["2"]);
});

/* ============================================================ masking */

test("a masked question inside a loop reports MASK_* variables per iteration", () => {
  const def = survey({}, {
    questions: [{
      id: "qm", code: "QM", variableName: "QM", type: "single_select", text: "Which of your brands?",
      options: BRANDS,
      mask: { expr: { kind: "ref", questionId: "q2", selection: "selected" }, action: "display" },
    }],
    body: [{ type: "page", id: "p6", questionIds: ["q6", "qm"] }],
  });
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [1, 3];
  runCalculations(def, state, "on_page_submit");
  assert.equal(state.calculated.MASK_QM_1_COUNT, 2);
  assert.equal(state.calculated.MASK_QM_2_COUNT, 2);
  assert.equal(state.calculated.MASK_QM_1_LIST, "1,3");
  assert.equal(state.calculated.MASK_QM_COUNT, undefined, "no un-iterated variable for a looped question");
});

/* ============================================================ dependencies */

test("a loop counted from a question depends on that question", () => {
  const def = survey({ source: { kind: "count", count: { kind: "question", ref: "Q9" } } }, {
    body: [{ type: "block", id: "blk", children: [{ type: "page", id: "p6", questionIds: ["q6", "q7"] }] }],
  });
  const deps = blockDependencies(def, "blk");
  assert.ok(deps.dependsOn.some((q) => q.code === "Q9"), deps.dependsOn.map((q) => q.code).join(","));
});

/* ============================================================ lints */

test("the lint names the per-respondent mechanisms that do not run per iteration, and checks aggregates", () => {
  const def = survey({
    aggregates: [
      { name: "AVG", questionRef: "Q7", op: "avg" },
      { name: "AVG", questionRef: "Q7", op: "max" },
      { name: "OUT", questionRef: "Q9", op: "sum" },
    ],
  }, {
    questions: [{ id: "qp", code: "QP", variableName: "QP", type: "long_text", text: "Why?", probe: { maxProbes: 2, minWords: 0 } }],
    body: [{ type: "page", id: "p6", questionIds: ["q6", "q7", "qp"] }],
    listFills: [{
      id: "lf1", name: "Concepts", source: { kind: "question", questionId: "q7" },
      selection: { count: { kind: "fixed", n: 1 } }, destinations: [{ questionId: "q6", write: "answer" }], runAfter: ["q7"],
    }],
  });
  const issues = lintLoops(def);
  const msgs = issues.map((i) => `${i.level}:${i.path.split(".").pop()}:${i.message}`);
  assert.ok(msgs.some((m) => m.startsWith("error:aggregates:") && m.includes('two aggregates are named "AVG"')), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.startsWith("warning:aggregates:") && m.includes("Q9")), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.startsWith("warning:listFill:") && m.includes("source")), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.startsWith("warning:listFill:") && m.includes("destination")), msgs.join("\n"));
  assert.ok(issues.some((i) => i.path.endsWith("QP.probe") && i.level === "warning"), msgs.join("\n"));
});

/* ============================================================ the statement */

test("describeLoop reads the configuration back as one statement", () => {
  const def = survey({
    eligibleIf: parseLogicExpression(survey(), "loop.index > 0").condition!,
    order: { kind: "random" },
    count: { mode: "max", value: 3 },
    resolveSource: "once",
    aggregates: [{ name: "AVG_SAT", questionRef: "Q7", op: "avg" }],
  });
  const text = describeLoop(def, def.flow[1] as LoopFlowNode);
  assert.equal(text.split("\n")[0], "FOR EACH brand IN Q2.selected");
  assert.match(text, /WHERE .*index.*> 0/);
  assert.match(text, /ORDER BY random/);
  assert.match(text, /AT MOST 3/);
  assert.match(text, /RESOLVE ONCE/);
  assert.match(text, /LOOP_BRAND_AVG_SAT = avg\(Q7\)/);
});
