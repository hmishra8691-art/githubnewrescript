import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  lintStructure, runQualityCheck, describeQualityCheck,
  buildVariableDictionary, buildDerivedVariables, unknownVariableOverrides,
} from "./index.js";

/**
 * WAVE 2 — the checks a survey should not be able to deploy without.
 *
 * Every case here is a survey that would previously have gone live in exactly
 * this state, with nothing objecting: a question on no page, a select with no
 * options, a quota that is full before fielding starts, a conjoint question
 * pointing at a design that is not in the survey.
 */

const base = {
  meta: { id: "s1", code: "S1", title: "QA", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "Pick",
      options: [{ code: 1, label: "One" }, { code: 2, label: "Two" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
};

const make = (patch: Record<string, unknown> = {}) =>
  SurveyDefinition.parse({ ...base, ...patch });

test("a clean survey passes every area, and says what it checked", () => {
  const r = runQualityCheck(make());
  assert.equal(r.status, "pass", JSON.stringify(r.areas.filter((a) => a.status !== "pass"), null, 1));
  assert.equal(r.deployable, true);
  assert.equal(r.areas.length, 10);
  assert.ok(r.areas.every((a) => a.note), "a passing area explains what it checked");
  assert.match(describeQualityCheck(r), /All 10 checks passed/);
});

test("a question on no page is unreachable, and is reported as an error", () => {
  const def = make({
    questions: [
      ...base.questions,
      { id: "q2", code: "Q2", variableName: "B", type: "open_text", text: "Stranded" },
    ],
  });
  const issues = lintStructure(def);
  const hit = issues.find((i) => i.questionCode === "Q2");
  assert.ok(hit, "a stranded question was not reported");
  assert.equal(hit.level, "error");
  assert.match(hit.message, /not on any page/);

  const r = runQualityCheck(def);
  assert.equal(r.deployable, false);
  assert.equal(r.areas.find((a) => a.key === "structure")?.status, "fail");
});

test("a hidden or calculated question needs no page, and is not reported", () => {
  const def = make({
    questions: [
      ...base.questions,
      { id: "q3", code: "Q3", variableName: "C", type: "hidden", text: "" },
      { id: "q4", code: "Q4", variableName: "D", type: "calculated", text: "", settings: { expression: "1" } },
    ],
  });
  assert.equal(lintStructure(def).filter((i) => i.path === "flow").length, 0);
});

test("a select with no options is an error; one that carries options forward is not", () => {
  const empty = make({
    questions: [{ id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "Pick", options: [] }],
  });
  const hit = lintStructure(empty).find((i) => i.path === "options" && i.level === "error");
  assert.ok(hit);
  assert.match(hit.message, /no options/);

  const carried = make({
    questions: [
      { id: "q0", code: "Q0", variableName: "Z", type: "multi_select", text: "Which?",
        options: [{ code: 1, label: "One" }] },
      { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "Pick", options: [],
        carryForward: { sourceQuestionId: "q0", filter: "selected", into: "options" } },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q0", "q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  assert.equal(lintStructure(carried).filter((i) => i.path === "options" && i.level === "error").length, 0);
});

test("an unlabelled option warns without blocking a release", () => {
  const def = make({
    questions: [{ id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "Pick",
      options: [{ code: 1, label: "One" }, { code: 2, label: "  " }] }],
  });
  const hit = lintStructure(def).find((i) => i.path === "options");
  assert.equal(hit?.level, "warning");
  assert.equal(runQualityCheck(def).deployable, true, "a warning must not block a deployment");
});

test("a quota that cannot fill, or is full before fielding, is reported", () => {
  const zero = make({
    quotas: [{
      id: "qa1", name: "Gender", mode: "hard",
      cells: [{ id: "c1", label: "Male", when: cond.rule("q1", "selected", 1), limit: 0 }],
    }],
  });
  const hit = lintStructure(zero).find((i) => i.path.startsWith("quotas"));
  assert.equal(hit?.level, "error");
  assert.match(hit.message, /full before fielding/);

  const empty = make({ quotas: [{ id: "qa2", name: "Empty", mode: "hard", cells: [] }] });
  const none = lintStructure(empty).find((i) => i.path.startsWith("quotas"));
  assert.match(none?.message ?? "", /no cells/);
});

test("two quota cells with the same condition are reported — both count every respondent", () => {
  const def = make({
    quotas: [{
      id: "qa1", name: "Region", mode: "hard",
      cells: [
        { id: "c1", label: "North", when: cond.rule("q1", "selected", 1), limit: 100 },
        { id: "c2", label: "North again", when: cond.rule("q1", "selected", 1), limit: 100 },
      ],
    }],
  });
  const hit = lintStructure(def).find((i) => /identical conditions/.test(i.message));
  assert.ok(hit, "duplicate quota cells were not reported");
  assert.equal(hit.level, "warning");
});

test("percentage limits need a total to be a percentage of", () => {
  const def = make({
    quotas: [{
      id: "qa1", name: "Split", mode: "hard",
      cells: [
        { id: "c1", label: "A", when: cond.rule("q1", "selected", 1), limit: 60, limitType: "percent" },
        { id: "c2", label: "B", when: cond.rule("q1", "selected", 2), limit: 60, limitType: "percent" },
      ],
    }],
  });
  const issues = lintStructure(def).filter((i) => i.path.startsWith("quotas"));
  assert.ok(issues.some((i) => /no total sample size/.test(i.message)));
  assert.ok(issues.some((i) => /120%/.test(i.message)));
});

test("a choice question pointing at a design the survey does not hold is an error", () => {
  const def = make({
    questions: [{
      id: "q1", code: "Q1", variableName: "CJ", type: "conjoint_task", text: "Choose",
      settings: { designRef: "missing_design" },
    }],
  });
  const hit = lintStructure(def).find((i) => i.path === "settings.designRef");
  assert.equal(hit?.level, "error");
  assert.match(hit.message, /not in this survey/);
  assert.equal(runQualityCheck(def).areas.find((a) => a.key === "designs")?.status, "fail");
});

test("deployment readiness: no end node warns, no slug blocks", () => {
  const noEnd = make({ flow: [{ type: "page", id: "p1", questionIds: ["q1"] }] });
  const r1 = runQualityCheck(noEnd);
  assert.equal(r1.areas.find((a) => a.key === "deployment")?.warnings, 1);
  assert.equal(r1.deployable, true, "a missing End is a warning, not a blocker");

  const noSlug = make({ deployment: { clientSlug: "", studySlug: "" } });
  const r2 = runQualityCheck(noSlug);
  assert.equal(r2.deployable, false);
  const dep = r2.areas.find((a) => a.key === "deployment");
  assert.match((dep?.issues ?? []).map((i) => i.message).join(" "), /no client or study slug/);
});

test("the verdict counts every area and never claims more than it found", () => {
  const def = make({
    questions: [
      ...base.questions,
      { id: "q2", code: "Q2", variableName: "B", type: "open_text", text: "Stranded" },
    ],
    quotas: [{ id: "qa1", name: "Empty", mode: "hard", cells: [] }],
  });
  const r = runQualityCheck(def);
  assert.equal(r.errors, r.areas.reduce((a, x) => a + x.errors, 0));
  assert.equal(r.warnings, r.areas.reduce((a, x) => a + x.warnings, 0));
  assert.equal(r.status, "fail");
  assert.match(describeQualityCheck(r), /problem/);
});

test("an End reached by a terminate skip is not reported as unreachable", () => {
  /*
   * A survey keeps its screen-out and quota-full Ends at the bottom on
   * purpose: nothing walks into them, a skip rule jumps to them by STATUS.
   * Reporting those is how a check earns being ignored.
   */
  const def = make({
    questions: [{
      id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "Age?",
      options: [{ code: 1, label: "Under 18" }, { code: 2, label: "18+" }],
      skipLogic: [{
        id: "sk1", when: cond.rule("q1", "selected", 1),
        target: { kind: "terminate", status: "screened" },
      }],
    }],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "end_complete", status: "complete" },
      { type: "end", id: "end_screened", status: "screened" },
    ],
  });
  const r = runQualityCheck(def);
  const structure = r.areas.find((a) => a.key === "structure");
  assert.equal(structure?.issues.length, 0, JSON.stringify(structure?.issues));
  assert.equal(r.status, "pass");
});

test("an End nothing reaches at all is still reported", () => {
  const def = make({
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "end_complete", status: "complete" },
      { type: "end", id: "end_orphan", status: "screened" },
    ],
  });
  const structure = runQualityCheck(def).areas.find((a) => a.key === "structure");
  assert.equal(structure?.warnings, 1, "no skip rule jumps to it, so it is genuinely stranded");
});

/* ------------------------------------------- §29 variable dictionary overrides */

test("a programmer's variable label wins over the derived one, and only where given", () => {
  const def = make({
    variables: [{
      name: "A", label: "Preferred pack (recoded)", dataType: "text", responseType: "single",
      valueCodes: [], valueLabels: { "1": "Blue pack", "2": "Red pack" },
    }],
  });
  const derived = buildDerivedVariables(def).find((v) => v.name === "A");
  const shown = buildVariableDictionary(def).find((v) => v.name === "A");
  assert.ok(derived && shown);
  assert.notEqual(derived.label, "Preferred pack (recoded)", "the derived label is untouched");
  assert.equal(shown.label, "Preferred pack (recoded)");
  assert.equal(shown.valueLabels["1"], "Blue pack");
  assert.equal(shown.dataType, derived.dataType, "an override cannot change what the answers are");
  assert.equal(shown.questionCode, derived.questionCode, "nor where they come from");
});

test("an override with nothing to say changes nothing", () => {
  const def = make({
    variables: [{ name: "A", label: "", dataType: "text", responseType: "single", valueCodes: [], valueLabels: {} }],
  });
  assert.deepEqual(
    buildVariableDictionary(def).find((v) => v.name === "A"),
    buildDerivedVariables(def).find((v) => v.name === "A"),
  );
});

test("an override for a variable the survey no longer produces is reported, not conjured", () => {
  const def = make({
    variables: [{ name: "GONE", label: "Old name", dataType: "text", responseType: "single", valueCodes: [], valueLabels: {} }],
  });
  assert.equal(buildVariableDictionary(def).some((v) => v.name === "GONE"), false,
    "an override must never invent a column");
  assert.deepEqual(unknownVariableOverrides(def), ["GONE"]);
  const vars = runQualityCheck(def).areas.find((a) => a.key === "variables");
  assert.equal(vars?.status, "fail");
  assert.match(vars.issues[0].message, /does not match anything this survey produces/);
});
