import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  renderNamingTemplate,
  templateContexts,
  planTemplateRename,
  applyTemplateRename,
  orderRenames,
  type RenameStep,
} from "./namingTemplates.js";
import { buildVariableDictionary } from "./variables.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";

/**
 * A bulk rename touches every variable in the study at once, so a mistake
 * here is not one broken rule — it is the whole questionnaire. The tests
 * therefore end where the single-rename tests do: apply the template, then
 * re-evaluate the survey and assert it answers identically.
 */

function makeSurvey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "svy_tpl", code: "TPL01", title: "Templates", version: "1.0", status: "draft" },
    questions: [
      { id: "q1", code: "S1", variableName: "SCREEN_OUT", type: "single_select", text: "Do you drink coffee?",
        options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }], settings: {} },
      { id: "q2", code: "S2", variableName: "AGE_GROUP", type: "single_select", text: "Which age group?",
        options: [{ code: "1", label: "18-34" }, { code: "2", label: "35+" }], settings: {} },
      { id: "q3", code: "Q1", variableName: "BRAND_AWARE", type: "multi_select", text: "Which brands have you heard of?",
        options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }], settings: {} },
      { id: "q4", code: "Q2", variableName: "WHY_BRAND", type: "text",
        text: "You know {{BRAND_AWARE}} — why that one?",
        displayLogic: { type: "group", op: "and", children: [
          { type: "rule", source: { kind: "question", ref: "SCREEN_OUT" }, operator: "eq", value: "1" },
        ] },
        settings: {} },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "page", id: "p2", questionIds: ["q3", "q4"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

/* ---------------------------------------------------------- the tokens */

test("the documented tokens render", () => {
  const def = makeSurvey();
  const ctxs = templateContexts(def);
  const q3 = ctxs.get("q3")!;

  assert.equal(renderNamingTemplate("Q{number}", q3), "Q3");
  assert.equal(renderNamingTemplate("Q{number:2}", q3), "Q03", "padding is what makes a spreadsheet sort correctly");
  assert.equal(renderNamingTemplate("SEC{section}_Q{n_in_section}", q3), "SEC2_Q1");
  assert.equal(renderNamingTemplate("{code}", q3), "Q1");
  assert.equal(renderNamingTemplate("{variable}", q3), "BRAND_AWARE");
  assert.equal(renderNamingTemplate("DEM_{shortname}", q3), "DEM_WHICH_BRANDS");
  assert.match(renderNamingTemplate("{type}", q3), /MULTI_SELECT/);
});

test("numbering follows the flow, not the definition order", () => {
  /*
   * A researcher counts questions the way a respondent meets them. If the
   * template numbered by array position, moving a question on the flow would
   * silently renumber nothing while the survey renumbered everything.
   */
  const def = makeSurvey();
  const ctxs = templateContexts(def);
  assert.equal(ctxs.get("q1")!.number, 1);
  assert.equal(ctxs.get("q3")!.number, 3);
  assert.equal(ctxs.get("q3")!.section, 2, "q3 is on the second page");
  assert.equal(ctxs.get("q3")!.numberInSection, 1);
});

test("an unknown token is left visible rather than silently blanked", () => {
  /*
   * A typo must fail loudly. Blanking would turn `Q{numbr}` into `Q` for
   * every question and then fail as a duplicate-name error that says nothing
   * about the real cause.
   */
  const def = makeSurvey();
  const ctx = templateContexts(def).get("q1")!;
  assert.equal(renderNamingTemplate("Q{numbr}", ctx), "Q{numbr}");

  const plan = planTemplateRename(def, "Q{numbr}");
  assert.ok(plan.blockers.length > 0);
  assert.ok(plan.blockers.some((b) => /not a usable variable name|token the template does not know/.test(b)),
    plan.blockers.join(" | "));
});

/* ------------------------------------------------------- the ordering */

test("a chain is ordered so nothing is renamed onto a live name", () => {
  // A→B while B→C: only one order works.
  const steps: RenameStep[] = [
    { questionId: "a", code: "A", from: "A", to: "B", changed: true },
    { questionId: "b", code: "B", from: "B", to: "C", changed: true },
  ];
  const ordered = orderRenames(steps);
  assert.equal(ordered[0].from, "B", "B must vacate its name before A takes it");
  assert.equal(ordered[1].from, "A");
  assert.equal(ordered.length, 2, "a chain needs no temporary name");
});

test("a straight swap is broken with a temporary name", () => {
  /*
   * A→B and B→A has no safe order at all. Without cycle-breaking this either
   * refuses a reasonable template or produces two variables with one name.
   */
  const steps: RenameStep[] = [
    { questionId: "a", code: "A", from: "A", to: "B", changed: true },
    { questionId: "b", code: "B", from: "B", to: "A", changed: true },
  ];
  const ordered = orderRenames(steps);
  assert.equal(ordered.length, 3, "one extra hop through a temporary");

  // replay it and check nothing is ever renamed onto an occupied name
  const live = new Set(["A", "B"]);
  for (const s of ordered) {
    assert.equal(live.has(s.to), false, `${s.from} → ${s.to} collides; order was ${JSON.stringify(ordered)}`);
    live.delete(s.from);
    live.add(s.to);
  }
  assert.deepEqual([...live].sort(), ["A", "B"], "and the end state is the swap that was asked for");
});

test("a three-way rotation also resolves", () => {
  const steps: RenameStep[] = [
    { questionId: "a", code: "A", from: "A", to: "B", changed: true },
    { questionId: "b", code: "B", from: "B", to: "C", changed: true },
    { questionId: "c", code: "C", from: "C", to: "A", changed: true },
  ];
  const ordered = orderRenames(steps);
  const live = new Set(["A", "B", "C"]);
  for (const s of ordered) {
    assert.equal(live.has(s.to), false, `${s.from} → ${s.to} collides`);
    live.delete(s.from);
    live.add(s.to);
  }
  assert.deepEqual([...live].sort(), ["A", "B", "C"]);
});

/* ------------------------------------------------- planning and refusal */

test("a template that would give two questions one name is refused", () => {
  const def = makeSurvey();
  const plan = planTemplateRename(def, "VAR");
  assert.ok(plan.blockers.some((b) => /would belong to/.test(b)), plan.blockers.join(" | "));
  assert.equal(plan.ordered.length, 0, "a refused plan must have nothing to execute");
});

test("a valid template is checked against the FINAL state, not step by step", () => {
  /*
   * The whole reason bulk rename needs its own planner: `Q{number}` renames
   * BRAND_AWARE to Q3 while the question already CALLED Q1 becomes Q3's
   * neighbour. Any per-step "is that name taken" check — which is exactly
   * what the single rename applies — would reject this.
   */
  const def = makeSurvey();
  const plan = planTemplateRename(def, "V{number}");
  assert.deepEqual(plan.blockers, [], plan.blockers.join(" | "));
  assert.equal(plan.ordered.length, 4);
});

test("a template colliding with a calculation target is refused", () => {
  const def = makeSurvey();
  (def as any).calculations = [
    { id: "c1", targetVariable: "V2", expression: "1", trigger: "on_complete", dataType: "numeric" },
  ];
  const plan = planTemplateRename(def, "V{number}");
  assert.ok(plan.blockers.some((b) => /V2.*calculation/.test(b)), plan.blockers.join(" | "));
});

test("a template producing a calc function name is refused", () => {
  const def = makeSurvey();
  const plan = planTemplateRename(def, "COUNT");
  assert.ok(plan.blockers.some((b) => /calculation function/.test(b)), plan.blockers.join(" | "));
});

test("only the chosen questions are renamed when a subset is given", () => {
  const def = makeSurvey();
  const plan = planTemplateRename(def, "X{number}", { questionIds: ["q1"] });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].from, "SCREEN_OUT");
  assert.equal(plan.steps[0].to, "X1");
});

test("a question the template does not change is reported as unchanged", () => {
  const def = makeSurvey();
  const plan = planTemplateRename(def, "{variable}");
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.steps.every((s) => !s.changed), true, "{variable} is a no-op by construction");
  assert.equal(plan.ordered.length, 0, "and nothing needs doing");
});

/* ------------------------------------------- applying it keeps behaviour */

test("applying a template rewrites every reference, not just the names", () => {
  const def = makeSurvey();
  const answers = { q1: "1", q2: "1", q3: ["1"], q4: "because" };
  const state = () => { const s = createResponseState(def); s.answers = answers as any; return s; };

  const before = def.questions.map((q) => evaluateCondition(q.displayLogic as any, { def, state: state() as any }));
  assert.ok(before.some((b) => b === true), "the fixture must exercise a real rule");

  const plan = planTemplateRename(def, "Q{number:2}");
  assert.deepEqual(plan.blockers, [], plan.blockers.join(" | "));
  const next = applyTemplateRename(def, plan);

  assert.deepEqual(next.questions.map((q) => q.variableName), ["Q01", "Q02", "Q03", "Q04"]);

  // the display rule followed the rename
  const q4 = next.questions.find((q) => q.id === "q4")!;
  assert.equal((q4.displayLogic as any).children[0].source.ref, "Q01");
  // and so did the pipe
  assert.match(q4.text, /\{\{Q03\}\}/, `the pipe must follow: ${q4.text}`);

  const nextState = () => { const s = createResponseState(next); s.answers = answers as any; return s; };
  const after = next.questions.map((q) => evaluateCondition(q.displayLogic as any, { def: next, state: nextState() as any }));
  assert.deepEqual(after, before, "the survey must answer exactly as it did before");
});

test("the dictionary keeps the same number of columns, renamed in place", () => {
  const def = makeSurvey();
  const before = buildVariableDictionary(def).map((v) => v.name);
  const next = applyTemplateRename(def, planTemplateRename(def, "V{number}"));
  const after = buildVariableDictionary(next).map((v) => v.name);

  assert.equal(after.length, before.length, "no column gained or lost");
  // the derived suffixes are untouched — the template names the base only
  assert.ok(after.some((n) => /^V3_1$/.test(n)), `the multi-select flags keep their suffixes: ${after.join(", ")}`);
});

test("applying a refused plan throws rather than half-renaming the survey", () => {
  const def = makeSurvey();
  const plan = planTemplateRename(def, "VAR");
  assert.throws(() => applyTemplateRename(def, plan), /cannot be applied/);
});

test("the original definition is not mutated by planning or applying", () => {
  const def = makeSurvey();
  const snapshot = JSON.stringify(def);
  const plan = planTemplateRename(def, "Q{number}");
  applyTemplateRename(def, plan);
  assert.equal(JSON.stringify(def), snapshot);
});
