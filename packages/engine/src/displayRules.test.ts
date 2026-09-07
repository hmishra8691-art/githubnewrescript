import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  compileFlow,
  createResponseState,
  effectiveQuestion,
  explainOptions,
  setAnswer,
  visibleQuestions,
  validateQuestion,
  buildVariableDictionary,
  visibleByRules,
  ruleVerdict,
  hasDisplayRulesFor,
  unresolvableDisplayRules,
} from "./index.js";

/**
 * NAMED DISPLAY RULES ON EVERY TARGET THEY OFFER (§6).
 *
 * `DisplayRule.target.kind` has allowed seven kinds since the first release
 * and the flow interpreter acted on one. These tests pin each of the other
 * six, and — more importantly — pin the PRECEDENCE, which is the part that
 * cannot be inferred from the schema: which layer wins when a page's own
 * `visibleIf` and a named rule disagree, and whether a pinned option can be
 * taken away.
 */

/* The gate question every rule below is written against. */
const GATE = {
  id: "q_gate", code: "Q1", variableName: "GATE", type: "single_select",
  text: "Do you shop here?",
  options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
};

const saysNo = cond.rule("q_gate", "eq", 2);
const saysYes = cond.rule("q_gate", "eq", 1);

function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Display rules", version: "1.0" },
    questions: [
      GATE,
      {
        id: "q_price", code: "Q2", variableName: "PRICE", type: "numeric",
        text: "What would you pay?",
      },
      {
        id: "q_brands", code: "Q3", variableName: "BRANDS", type: "multi_select",
        text: "Which brands?",
        options: [
          { code: 1, label: "Alpha" },
          { code: 2, label: "Beta" },
          { code: 3, label: "Gamma", logic: { visibility: "always_show" } },
        ],
      },
      {
        id: "q_grid", code: "Q4", variableName: "GRID", type: "grid_single",
        text: "Rate each",
        rows: [{ code: "r1", label: "Taste" }, { code: "r2", label: "Price" }],
        options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }],
      },
      {
        id: "q_comp", code: "Q5", variableName: "COMP", type: "composite",
        text: "Split the points",
        rows: [{ code: "r1", label: "Jan" }],
        columns: [
          { id: "c_a", label: "Brand A", responseType: "numeric", variableStem: "A" },
          { id: "c_b", label: "Brand B", responseType: "numeric", variableStem: "B" },
        ],
      },
    ],
    flow: [
      { type: "page", id: "p_gate", questionIds: ["q_gate"] },
      {
        type: "block", id: "b_pricing", title: "Pricing", children: [
          { type: "page", id: "p_price", questionIds: ["q_price"] },
          { type: "page", id: "p_brands", questionIds: ["q_brands"] },
        ],
      },
      {
        type: "section", id: "s_grids", title: "Grids", children: [
          { type: "page", id: "p_grid", questionIds: ["q_grid", "q_comp"] },
        ],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
    ...extra,
  });
}

type Def = ReturnType<typeof survey>;

function stateWith(def: Def, gate?: number) {
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  if (gate !== undefined) setAnswer(def, state, "q_gate", gate);
  return state;
}

const pageIds = (def: Def, gate?: number) =>
  compileFlow(def, stateWith(def, gate))
    .filter((s) => s.kind === "page")
    .map((s) => (s as { pageId: string }).pageId);

const rule = (
  target: { kind: string; ref: string; subRef?: string },
  action: "show" | "hide",
  when: unknown,
) => ({ id: `dr_${target.kind}_${target.ref}_${target.subRef ?? ""}`, action, target, when });

/* ============================================================ nothing set */

test("a survey with no display rules is completely unaffected", () => {
  const def = survey();
  assert.equal(hasDisplayRulesFor(def, "page"), false);
  assert.deepEqual(pageIds(def), ["p_gate", "p_price", "p_brands", "p_grid"]);
  assert.equal(visibleByRules(def, "page", "p_price", { def, state: stateWith(def), loop: null }), true);
});

/* ================================================================== pages */

test("a HIDE rule on a PAGE removes it — the target that was silently ignored", () => {
  const def = survey({ displayRules: [rule({ kind: "page", ref: "p_price" }, "hide", saysNo)] });
  assert.deepEqual(pageIds(def, 2), ["p_gate", "p_brands", "p_grid"], "hidden when the rule holds");
  assert.deepEqual(pageIds(def, 1), ["p_gate", "p_price", "p_brands", "p_grid"], "kept when it does not");
});

test("a SHOW rule on a page means the page IS the condition, so a false one hides it", () => {
  const def = survey({ displayRules: [rule({ kind: "page", ref: "p_price" }, "show", saysYes)] });
  assert.ok(pageIds(def, 1).includes("p_price"));
  assert.ok(!pageIds(def, 2).includes("p_price"), "a SHOW rule that does not hold is a hide");
});

test("with no answer at all a SHOW rule hides — the rule has not been satisfied yet", () => {
  // the safe reading: an unanswered gate has not said yes
  const def = survey({ displayRules: [rule({ kind: "page", ref: "p_price" }, "show", saysYes)] });
  assert.ok(!pageIds(def).includes("p_price"));
});

/* ====================================================== blocks & sections */

test("hiding a BLOCK takes every page inside it, including ones with their own rules", () => {
  const def = survey({
    displayRules: [
      rule({ kind: "block", ref: "b_pricing" }, "hide", saysNo),
      /* this page would pass on its own — the container still wins */
      rule({ kind: "page", ref: "p_brands" }, "show", saysNo),
    ],
  });
  assert.deepEqual(pageIds(def, 2), ["p_gate", "p_grid"]);
});

test("hiding a SECTION takes its pages too", () => {
  const def = survey({ displayRules: [rule({ kind: "section", ref: "s_grids" }, "hide", saysNo)] });
  assert.deepEqual(pageIds(def, 2), ["p_gate", "p_price", "p_brands"]);
});

test("a rule naming a block that is really a section is reported, not silently ignored", () => {
  const def = survey({ displayRules: [rule({ kind: "block", ref: "s_grids" }, "hide", saysNo)] });
  const dead = unresolvableDisplayRules(def);
  assert.equal(dead.length, 1);
  assert.match(dead[0].reason, /is a section, not a block/);
  /* and it does nothing, rather than guessing at the programmer's intent */
  assert.ok(pageIds(def, 2).includes("p_grid"));
});

/* ================================================================ options */

test("a HIDE rule on one OPTION removes exactly that option", () => {
  const def = survey({
    displayRules: [rule({ kind: "option", ref: "q_brands", subRef: "2" }, "hide", saysNo)],
  });
  const q = def.questions.find((x) => x.id === "q_brands")!;
  const shown = (gate: number) =>
    effectiveQuestion(q, { def, state: stateWith(def, gate), loop: null }).options.map((o) => String(o.code));
  assert.deepEqual(shown(2), ["1", "3"]);
  assert.deepEqual(shown(1), ["1", "2", "3"]);
});

test("a HIDE rule beats “always show” — an explicit exclusion is explicit", () => {
  // matches eligibilityVerdict, where excludeWhen already overrides a pin
  const def = survey({
    displayRules: [rule({ kind: "option", ref: "q_brands", subRef: "3" }, "hide", saysNo)],
  });
  const q = def.questions.find((x) => x.id === "q_brands")!;
  const shown = effectiveQuestion(q, { def, state: stateWith(def, 2), loop: null }).options.map((o) => String(o.code));
  assert.deepEqual(shown, ["1", "2"]);
});

test("a pinned option SURVIVES a SHOW rule that does not hold", () => {
  const def = survey({
    displayRules: [
      rule({ kind: "option", ref: "q_brands", subRef: "3" }, "show", saysYes),
      rule({ kind: "option", ref: "q_brands", subRef: "1" }, "show", saysYes),
    ],
  });
  const q = def.questions.find((x) => x.id === "q_brands")!;
  const shown = effectiveQuestion(q, { def, state: stateWith(def, 2), loop: null }).options.map((o) => String(o.code));
  assert.deepEqual(shown, ["2", "3"], "Gamma is pinned and stays; Alpha is not and goes");
});

test("an option rule with no option named does nothing, and says so", () => {
  const def = survey({ displayRules: [rule({ kind: "option", ref: "q_brands" }, "hide", saysNo)] });
  const q = def.questions.find((x) => x.id === "q_brands")!;
  const shown = effectiveQuestion(q, { def, state: stateWith(def, 2), loop: null }).options.map((o) => String(o.code));
  assert.deepEqual(shown, ["1", "2", "3"], "one unfinished rule must not empty a live question");
  assert.match(unresolvableDisplayRules(def)[0].reason, /names no option/);
});

test("numeric option codes match a rule written as a string", () => {
  const def = survey({ displayRules: [rule({ kind: "option", ref: "q_brands", subRef: "1" }, "hide", saysNo)] });
  const v = ruleVerdict(def, "option", "q_brands", { def, state: stateWith(def, 2), loop: null }, 1);
  assert.deepEqual(v, { visible: false, by: "hide" });
});

test("the pipeline trace names the stage, so a missing option is diagnosable", () => {
  const def = survey({
    displayRules: [rule({ kind: "option", ref: "q_brands", subRef: "2" }, "hide", saysNo)],
  });
  const q = def.questions.find((x) => x.id === "q_brands")!;
  const trace = explainOptions(q, { def, state: stateWith(def, 2), loop: null });
  const stage = trace.stages.find((s) => s.key === "named_rules");
  assert.ok(stage, "the stage appears in the trace");
  assert.deepEqual(stage!.removed.map((r) => r.code), ["2"]);
  assert.match(stage!.removed[0].reason, /named display rule/i);
});

/* =========================================================== rows & columns */

test("a HIDE rule on a grid ROW removes it", () => {
  const def = survey({ displayRules: [rule({ kind: "row", ref: "q_grid", subRef: "r2" }, "hide", saysNo)] });
  const q = def.questions.find((x) => x.id === "q_grid")!;
  const rows = (gate: number) =>
    effectiveQuestion(q, { def, state: stateWith(def, gate), loop: null }).rows.map((r) => String(r.code));
  assert.deepEqual(rows(2), ["r1"]);
  assert.deepEqual(rows(1), ["r1", "r2"]);
});

test("a HIDE rule on a COLUMN is addressed by the column id", () => {
  const def = survey({ displayRules: [rule({ kind: "column", ref: "q_comp", subRef: "c_b" }, "hide", saysNo)] });
  const q = def.questions.find((x) => x.id === "q_comp")!;
  const cols = (gate: number) =>
    effectiveQuestion(q, { def, state: stateWith(def, gate), loop: null }).columns.map((c) => c.id);
  assert.deepEqual(cols(2), ["c_a"]);
  assert.deepEqual(cols(1), ["c_a", "c_b"]);
});

/* ============================================= questions: unchanged behaviour */

test("question targets behave exactly as they did before the refactor", () => {
  const def = survey({ displayRules: [rule({ kind: "question", ref: "q_price" }, "hide", saysNo)] });
  const step = compileFlow(def, stateWith(def, 2)).find(
    (s) => s.kind === "page" && (s as { pageId: string }).pageId === "p_price",
  )!;
  const vis = visibleQuestions(def, step as never, stateWith(def, 2));
  assert.deepEqual(vis.map((q) => q.id), []);
});

test("HIDE beats SHOW on the same question, so a blanket hide is safe to add", () => {
  const def = survey({
    displayRules: [
      rule({ kind: "question", ref: "q_price" }, "show", saysNo),
      { id: "dr_x", action: "hide" as const, target: { kind: "question" as const, ref: "q_price" }, when: saysNo },
    ],
  });
  const step = compileFlow(def, stateWith(def, 2)).find(
    (s) => s.kind === "page" && (s as { pageId: string }).pageId === "p_price",
  )!;
  assert.deepEqual(visibleQuestions(def, step as never, stateWith(def, 2)).map((q) => q.id), []);
});

test("the LAST show rule decides when several name the same thing", () => {
  const def = survey({
    displayRules: [
      { id: "a", action: "show" as const, target: { kind: "page" as const, ref: "p_price" }, when: saysNo },
      { id: "b", action: "show" as const, target: { kind: "page" as const, ref: "p_price" }, when: saysYes },
    ],
  });
  assert.ok(pageIds(def, 1).includes("p_price"));
  assert.ok(!pageIds(def, 2).includes("p_price"));
});

/* ============================================================ dead rules */

test("a rule pointing at a deleted question is reported", () => {
  const def = survey({ displayRules: [rule({ kind: "question", ref: "q_gone" }, "hide", saysNo)] });
  assert.match(unresolvableDisplayRules(def)[0].reason, /no longer exists/);
});

test("a rule pointing at a page that is not in the flow is reported", () => {
  const def = survey({ displayRules: [rule({ kind: "page", ref: "p_gone" }, "hide", saysNo)] });
  assert.match(unresolvableDisplayRules(def)[0].reason, /not in the flow/);
});

test("an option code that is not declared is reported as doubt, not certainty", () => {
  // carry-forward can introduce codes the question never declares
  const def = survey({ displayRules: [rule({ kind: "option", ref: "q_brands", subRef: "99" }, "hide", saysNo)] });
  assert.match(unresolvableDisplayRules(def)[0].reason, /may be carried in/);
});

test("a healthy set of rules reports nothing", () => {
  const def = survey({
    displayRules: [
      rule({ kind: "page", ref: "p_price" }, "hide", saysNo),
      rule({ kind: "block", ref: "b_pricing" }, "hide", saysNo),
      rule({ kind: "section", ref: "s_grids" }, "hide", saysNo),
      rule({ kind: "question", ref: "q_price" }, "hide", saysNo),
      rule({ kind: "option", ref: "q_brands", subRef: "1" }, "hide", saysNo),
      rule({ kind: "row", ref: "q_grid", subRef: "r1" }, "hide", saysNo),
      rule({ kind: "column", ref: "q_comp", subRef: "c_a" }, "hide", saysNo),
    ],
  });
  assert.deepEqual(unresolvableDisplayRules(def), []);
});

/* ===================================================== the container guard */

test("hasDisplayRulesFor is per-kind, so the option pipeline pays nothing for page rules", () => {
  const def = survey({ displayRules: [rule({ kind: "page", ref: "p_price" }, "hide", saysNo)] });
  assert.equal(hasDisplayRulesFor(def, "page"), true);
  assert.equal(hasDisplayRulesFor(def, "option"), false);
  assert.equal(hasDisplayRulesFor(def, "row"), false);
  assert.equal(hasDisplayRulesFor(def, "column"), false);
});

/* ================================ anchored MaxDiff validation (§17) */

test("an anchored MaxDiff set answered without its follow-up is incomplete", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "mv", code: "MV", title: "Anchor validation", version: "1.0" },
    designs: [{
      id: "d1", kind: "maxdiff", name: "MD",
      config: { items: ["A", "B", "C", "D"], itemsPerTask: 3, anchored: true },
      file: { format: "json", columns: ["version", "task", "item_index", "item_label"], rows: [
        { version: 1, task: 1, item_index: 1, item_label: "A" },
        { version: 1, task: 1, item_index: 2, item_label: "B" },
        { version: 1, task: 1, item_index: 3, item_label: "C" },
      ] },
    }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const ctx = { def, state, loop: null };
  const q = def.questions[0];

  const bare = validateQuestion(def, q, { 1: { best: "1", worst: "3" } }, ctx as never);
  assert.equal(bare.length, 1);
  assert.match(bare[0].message, /follow-up question for set 1/);

  const whole = validateQuestion(def, q, { 1: { best: "1", worst: "3", anchor: "some" } }, ctx as never);
  assert.deepEqual(whole, []);
});

test("an untouched set is not nagged about its follow-up", () => {
  // the follow-up follows the question; asking for it first is backwards
  const def = SurveyDefinition.parse({
    meta: { id: "mv2", code: "MV2", title: "Anchor validation", version: "1.0" },
    designs: [{
      id: "d1", kind: "maxdiff", name: "MD",
      config: { items: ["A", "B", "C", "D"], anchored: true },
      file: { format: "json", columns: ["version", "task", "item_index"], rows: [{ version: 1, task: 1, item_index: 1 }] },
    }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "x", settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const q = def.questions[0];
  assert.deepEqual(validateQuestion(def, q, { 1: { best: "1", worst: "2", anchor: "all" }, 2: {} }, { def, state, loop: null } as never), []);
});

test("a STANDARD MaxDiff is validated exactly as before", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "mv3", code: "MV3", title: "Standard", version: "1.0" },
    designs: [{
      id: "d1", kind: "maxdiff", name: "MD",
      config: { items: ["A", "B", "C", "D"] },
      file: { format: "json", columns: ["version", "task", "item_index"], rows: [{ version: 1, task: 1, item_index: 1 }] },
    }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "x", required: true, settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const q = def.questions[0];
  assert.deepEqual(validateQuestion(def, q, { 1: { best: "1", worst: "2" } }, { def, state, loop: null } as never), []);
});

test("the anchor variable is declared only when the design is anchored", () => {
  const build = (anchored: boolean) => SurveyDefinition.parse({
    meta: { id: "va", code: "VA", title: "Anchor variable", version: "1.0" },
    designs: [{
      id: "d1", kind: "maxdiff", name: "MD",
      config: anchored ? { items: ["A", "B"], anchored: true } : { items: ["A", "B"] },
      file: { format: "json", columns: ["version", "task", "item_index"], rows: [{ version: 1, task: 1, item_index: 1 }] },
    }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "x", settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
  const names = (anchored: boolean) => buildVariableDictionary(build(anchored)).map((v) => v.name);
  assert.ok(names(true).includes("MD_ANCHOR"), names(true).join(", "));
  assert.ok(!names(false).includes("MD_ANCHOR"));
  /* and the codes are the three the renderer offers */
  const v = buildVariableDictionary(build(true)).find((x) => x.name === "MD_ANCHOR")!;
  assert.deepEqual(v.valueCodes, ["all", "some", "none"]);
});
