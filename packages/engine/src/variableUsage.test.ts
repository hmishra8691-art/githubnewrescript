import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  variableUsages,
  renameImpact,
  renameVariable,
  applyRename,
} from "./variableUsage.js";
import { buildVariableDictionary } from "./variables.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";
import { flattenVariables } from "./flatten.js";

/**
 * A rename that misses one reference is worse than no rename feature, so
 * these tests are mostly BEHAVIOURAL: rename, then prove the survey still
 * computes the same answers. Counting usages proves the finder found things;
 * re-evaluating proves the rewriter wrote them correctly, which is the part
 * that actually protects the researcher's data.
 */

/*
 * One question referenced every way the codebase allows: a structured
 * condition, a pipe, a calc expression, a comparison against another
 * question, a wildcard sum, and a script.
 */
function makeSurvey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "svy_rename", code: "REN01", title: "Rename", version: "1.0", status: "draft" },
    questions: [
      {
        id: "q_age", code: "Q1", variableName: "RESP_AGE", type: "numeric",
        text: "How old are you?", settings: {},
      },
      {
        id: "q_gender", code: "Q2", variableName: "GENDER", type: "single_select",
        text: "Gender?",
        options: [{ code: "1", label: "Male" }, { code: "2", label: "Female" }],
        settings: {},
      },
      {
        id: "q_follow", code: "Q3", variableName: "FOLLOW", type: "text",
        // a pipe, in the question text
        text: "You said you are {{RESP_AGE}}. Why?",
        // a structured condition naming the variable
        displayLogic: {
          type: "group", op: "and",
          children: [{ type: "rule", source: { kind: "question", ref: "RESP_AGE" }, operator: "gte", value: 18 }],
        },
        settings: {},
      },
      {
        id: "q_cmp", code: "Q4", variableName: "CMP", type: "text",
        text: "Compare",
        displayLogic: {
          type: "group", op: "and",
          children: [{
            type: "rule",
            source: { kind: "expr", ref: "RESP_AGE * 2" },
            operator: "gt",
            value: 20,
          }],
        },
        settings: {},
      },
      {
        id: "q_alloc_a", code: "Q5A", variableName: "ALLOC_A", type: "numeric", text: "A", settings: {} },
      {
        id: "q_alloc_b", code: "Q5B", variableName: "ALLOC_B", type: "numeric", text: "B", settings: {} },
    ],
    calculations: [
      { id: "c1", targetVariable: "RESP_AGE_BAND", expression: "RESP_AGE >= 35", trigger: "on_complete", dataType: "numeric" },
      // a wildcard that captures ALLOC_A by prefix without naming it
      { id: "c2", targetVariable: "ALLOC_TOTAL", expression: "sum(ALLOC_*)", trigger: "on_complete", dataType: "numeric" },
      /*
       * BOTH names in ONE expression, one a prefix of the other. This is the
       * case that separates a correct rewrite from a search-and-replace: a
       * naive substitution turns RESP_AGE_BAND into YEARS_BAND and silently
       * repoints the calculation at a variable that does not exist.
       */
      { id: "c3", targetVariable: "SCORE", expression: "RESP_AGE + RESP_AGE_BAND", trigger: "on_complete", dataType: "numeric" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age", "q_gender", "q_follow", "q_cmp", "q_alloc_a", "q_alloc_b"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

const stateWith = (def: SurveyDefinition, answers: Record<string, unknown>) => {
  const s = createResponseState(def);
  s.answers = answers as any;
  return s;
};

/* ------------------------------------------------------------ the finder */

test("every kind of reference is found", () => {
  const def = makeSurvey();
  const usages = variableUsages(def, "RESP_AGE");
  const kinds = new Set(usages.map((u) => u.kind));

  assert.ok(kinds.has("question_variable"), "the question's own variableName");
  assert.ok(kinds.has("condition_ref"), "a structured condition source");
  assert.ok(kinds.has("pipe"), "a {{AGE}} pipe in the question text");
  assert.ok(kinds.has("expression"), "a calc expression that reads it");

  // and each one knows where it lives, in words a person can act on
  for (const u of usages) {
    assert.ok(u.where.length > 0, "a usage must say where it is");
    assert.ok(u.path.length > 0, "and carry a path");
  }
});

test("a wildcard that captures the variable is reported but not rewritten", () => {
  /*
   * `sum(ALLOC_*)` never spells ALLOC_A, so there is nothing to rewrite —
   * but renaming ALLOC_A to SPEND_A silently removes it from that sum. A
   * tool that says "no references" here is lying by omission.
   */
  const def = makeSurvey();
  const usages = variableUsages(def, "ALLOC_A");
  const wild = usages.filter((u) => u.kind === "expression_wildcard");
  assert.equal(wild.length >= 1, true, "the wildcard sum must be reported");
  assert.equal(wild[0].rewrite, "review", "and must not be auto-rewritten");
  assert.match(wild[0].detail ?? "", /prefix/);

  const impact = renameImpact(def, "ALLOC_A", "SPEND_A");
  assert.ok(impact.warnings.some((w) => /prefix/.test(w)), "the impact report must surface it");
});

test("a name that only looks similar is not a usage", () => {
  const def = makeSurvey();
  // RESP_AGE_BAND contains "RESP_AGE" as a substring; it is a different variable
  const usages = variableUsages(def, "RESP_AGE");
  const badPaths = usages.filter((u) => u.detail === "RESP_AGE_BAND");
  assert.equal(badPaths.length, 0, "substring matches must not be reported as references");
});

/* ----------------------------------------------------- behaviour is kept */

test("after a rename the survey evaluates exactly as before", () => {
  /*
   * The test that matters. If the rewriter misses a reference, a rule that
   * used to read 42 now reads nothing, and this comparison fails.
   */
  const def = makeSurvey();
  const answers = { q_age: 42, q_gender: "1", q_alloc_a: 30, q_alloc_b: 70 };

  const before = def.questions.map((q) =>
    evaluateCondition(q.displayLogic as any, { def, state: stateWith(def, answers) as any }),
  );

  const renamed = applyRename(def, "RESP_AGE", "RESPONDENT_AGE", { alsoCode: true });
  const after = renamed.questions.map((q) =>
    evaluateCondition(q.displayLogic as any, { def: renamed, state: stateWith(renamed, answers) as any }),
  );

  assert.deepEqual(after, before, "display logic must give the same answers after the rename");
  assert.ok(before.some((b) => b === true), "the fixture must actually exercise a true branch");
});

test("a renamed variable still reaches the exported data, under its new name", () => {
  const def = makeSurvey();
  const answers = { q_age: 42, q_gender: "1", q_alloc_a: 30, q_alloc_b: 70 };

  const flatBefore = flattenVariables(def, stateWith(def, answers) as any, {});
  assert.equal(flatBefore.RESP_AGE, 42);

  const renamed = applyRename(def, "RESP_AGE", "RESPONDENT_AGE", { alsoCode: true });
  const flatAfter = flattenVariables(renamed, stateWith(renamed, answers) as any, {});

  assert.equal(flatAfter.RESPONDENT_AGE, 42, "the value moved to the new name");
  assert.equal("RESP_AGE" in flatAfter, false, "and nothing is left under the old one");
  assert.equal(Object.keys(flatAfter).length, Object.keys(flatBefore).length, "no column was gained or lost");
});

test("the pipe is rewritten, not merely found", () => {
  const def = makeSurvey();
  const renamed = applyRename(def, "RESP_AGE", "RESPONDENT_AGE");
  const q3 = renamed.questions.find((q) => q.id === "q_follow")!;
  assert.match(q3.text, /\{\{RESPONDENT_AGE\}\}/, "the pipe token now names the new variable");
  assert.doesNotMatch(q3.text, /\{\{AGE\}\}/);
  assert.match(q3.text, /You said you are/, "the surrounding sentence is untouched");
});

test("an expression is rewritten without touching a longer name that contains it", () => {
  const def = makeSurvey();
  const renamed = applyRename(def, "RESP_AGE", "YEARS");
  const calcs = renamed.calculations ?? [];
  const band = calcs.find((c) => c.id === "c1")!;
  assert.equal(band.expression, "YEARS >= 35");
  // RESP_AGE_BAND is a different variable and must survive intact
  assert.equal(band.targetVariable, "RESP_AGE_BAND", "a name that merely contains RESP_AGE is left alone");

  /*
   * The one that matters: both names in the same expression. Search-and-
   * replace gives "YEARS + YEARS_BAND", repointing the calculation at a
   * variable that does not exist — a break no test of the surrounding
   * behaviour would notice, because the expression still parses.
   */
  const score = calcs.find((c) => c.id === "c3")!;
  assert.equal(score.expression, "YEARS + RESP_AGE_BAND",
    "only the whole-word match is rewritten; the longer name is left alone");
});

test("the dictionary maps one-to-one across the rename", () => {
  const def = makeSurvey();
  const before = buildVariableDictionary(def).map((v) => v.name);
  const renamed = applyRename(def, "GENDER", "SEX", { alsoCode: true });
  const after = buildVariableDictionary(renamed).map((v) => v.name);

  assert.equal(after.length, before.length, "no column appears or disappears");
  const changed = before.filter((n, i) => n !== after[i]);
  for (const n of changed) assert.match(n, /^GENDER/, `only GENDER's own columns changed, not ${n}`);
});

/* --------------------------------------------------------- the alias trap */

test("the code alias is reported, because it is what makes a bad rename look fine", () => {
  /*
   * Q1's code is "Q1" and its variable is "RESP_AGE", so renaming it does NOT
   * leave an alias. Build the default case instead — code === variableName —
   * and check it is called out.
   */
  const def = makeSurvey();
  const aliased = JSON.parse(JSON.stringify(def)) as SurveyDefinition;
  const q = aliased.questions.find((x) => x.id === "q_age")!;
  q.code = "RESP_AGE";

  const impact = renameImpact(aliased, "RESP_AGE", "YEARS");
  assert.equal(impact.aliasedByCode, true, "the alias must be detected");
  assert.ok(
    impact.warnings.some((w) => /code/i.test(w) && /keep working/i.test(w)),
    `the warning must explain the delayed break, got: ${impact.warnings.join(" | ")}`,
  );

  // and renaming with alsoCode actually clears it
  const fixed = applyRename(aliased, "RESP_AGE", "YEARS", { alsoCode: true });
  assert.equal(fixed.questions.find((x) => x.id === "q_age")!.code, "YEARS");
  // without it, the code stays and the alias persists
  const left = applyRename(aliased, "RESP_AGE", "YEARS", { alsoCode: false });
  assert.equal(left.questions.find((x) => x.id === "q_age")!.code, "RESP_AGE");
});

/* -------------------------------------------------------------- refusals */

test("a rename onto an existing variable is refused", () => {
  const def = makeSurvey();
  const r = renameVariable(def, "RESP_AGE", "GENDER");
  assert.equal(r.ok, false);
  assert.ok(r.impact.blockers.some((b) => /already a variable/.test(b)), r.impact.blockers.join(" | "));
});

test("a rename onto another question's CODE is refused, because it makes rules ambiguous", () => {
  const def = makeSurvey();
  const r = renameVariable(def, "RESP_AGE", "Q2");
  assert.equal(r.ok, false);
  assert.ok(r.impact.blockers.some((b) => /ambiguous/.test(b)), r.impact.blockers.join(" | "));
});

test("a rename onto a system column is refused", () => {
  const def = makeSurvey();
  for (const reserved of ["RESP_ID", "session_id", "STATUS"]) {
    const r = renameVariable(def, "RESP_AGE", reserved);
    assert.equal(r.ok, false, `${reserved} must be refused`);
  }
});

test("an unusable name is refused with an explanation, not a stack trace", () => {
  const def = makeSurvey();
  for (const bad of ["", "2ND_CHOICE", "has space", "has-dash"]) {
    const r = renameVariable(def, "RESP_AGE", bad);
    assert.equal(r.ok, false, `"${bad}" must be refused`);
    assert.ok(r.impact.blockers.length > 0);
    assert.ok(r.impact.blockers.every((b) => b.length > 10), "a blocker must be a sentence a user can act on");
  }
});

test("renaming something the survey does not produce is refused", () => {
  const def = makeSurvey();
  const r = renameVariable(def, "NOT_A_VARIABLE", "SOMETHING");
  assert.equal(r.ok, false);
  assert.ok(r.impact.blockers.some((b) => /Nothing in this survey produces/.test(b)));
});

/* ------------------------------------------------------- what it can't do */

test("a script that mentions the variable blocks the rename rather than being guessed at", () => {
  const def = makeSurvey();
  (def as any).scripts = [{ id: "s1", name: "Scoring", code: "const a = getVar('RESP_AGE'); setCalc('X', a);" }];
  const impact = renameImpact(def, "RESP_AGE", "YEARS");
  assert.equal(impact.ok, false, "a rename that cannot be completed must not be offered");
  assert.ok(impact.blockers.some((b) => /[Ss]cript/.test(b)), impact.blockers.join(" | "));
  const usage = impact.usages.find((u) => u.kind === "script");
  assert.equal(usage?.rewrite, "frozen");
});

test("the report says when it could not see the saved analyses", () => {
  const def = makeSurvey();
  assert.equal(renameImpact(def, "RESP_AGE", "YEARS").analysesUnchecked, true);
  assert.equal(renameImpact(def, "RESP_AGE", "YEARS", { analyses: [] }).analysesUnchecked, false);
});

test("a saved analysis using the variable is surfaced for review", () => {
  const def = makeSurvey();
  const impact = renameImpact(def, "RESP_AGE", "YEARS", {
    analyses: [{ id: "an1", name: "Age by gender", definition: { variables: ["RESP_AGE"], rows: ["GENDER"] } }],
  });
  const found = impact.usages.find((u) => u.kind === "analysis");
  assert.ok(found, "the analysis must be reported");
  assert.equal(found!.rewrite, "review");
  assert.ok(impact.ok, "but it does not block — the analysis can be repointed afterwards");
});

test("a successful rename returns a definition, a refused one does not", () => {
  const def = makeSurvey();
  const good = renameVariable(def, "RESP_AGE", "YEARS");
  assert.equal(good.ok, true);
  if (good.ok) assert.ok(good.def.questions.some((q) => q.variableName === "YEARS"));

  const bad = renameVariable(def, "RESP_AGE", "GENDER");
  assert.equal(bad.ok, false);
  assert.equal("def" in bad, false, "a refused rename must not hand back a definition to save");
});

test("the original definition is never mutated", () => {
  const def = makeSurvey();
  const snapshot = JSON.stringify(def);
  applyRename(def, "RESP_AGE", "YEARS", { alsoCode: true });
  renameVariable(def, "RESP_AGE", "YEARS");
  renameImpact(def, "RESP_AGE", "YEARS");
  assert.equal(JSON.stringify(def), snapshot, "the caller's survey must be untouched until they save");
});

/* ------------------------------------- the variable that hides in plain sight */

test("a variable sharing a name with a calc function is handled honestly", () => {
  /*
   * `age()` is a built-in calc function, so `referencedNames("AGE >= 35")`
   * returns nothing — a static scan cannot tell the variable from the
   * function. Found the hard way: the first version of this suite named its
   * fixture variable AGE and the expression test failed for what looked like
   * a bug in the walk.
   *
   * The tool must not pretend it searched successfully. Renaming INTO such a
   * name is refused; renaming OUT of one is allowed, because that is the fix,
   * but it warns that expressions need checking by hand.
   */
  const def = makeSurvey();
  const shadowed = JSON.parse(JSON.stringify(def)) as SurveyDefinition;
  shadowed.questions.find((q) => q.id === "q_age")!.variableName = "AGE";

  const into = renameImpact(def, "RESP_AGE", "COUNT");
  assert.equal(into.ok, false, "renaming onto a function name must be refused");
  assert.ok(into.blockers.some((b) => /calculation function/.test(b)), into.blockers.join(" | "));

  const outOf = renameImpact(shadowed, "AGE", "RESPONDENT_AGE");
  assert.equal(outOf.ok, true, "renaming away from a function name must stay possible — it is the cure");
  assert.ok(
    outOf.warnings.some((w) => /by hand/.test(w)),
    `it must warn that the search was incomplete, got: ${outOf.warnings.join(" | ")}`,
  );
});
