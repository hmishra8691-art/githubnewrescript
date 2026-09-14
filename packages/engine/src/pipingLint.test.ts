import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { lintPipingTokens, lintSurveyLogic } from "./index.js";

/**
 * `lintPipingTokens` is what the Studio's Properties panel runs while someone
 * is typing question text, and it used to know only about questions. Every
 * calculation, embedded field and `LISTFILL_*` variable — all of which pipe
 * correctly at runtime — came back as "Unknown piping reference", and a lint
 * that cries wolf on working configuration is a lint people learn to ignore.
 *
 * `lintSurveyLogic` always knew better. These tests pin the two together.
 */

const def = () =>
  SurveyDefinition.parse({
    meta: { id: "s1", title: "T" },
    embeddedData: [{ name: "PANEL_ID", label: "Panel id", source: "url", dataType: "string" }],
    calculations: [{ id: "c1", targetVariable: "TOTAL", expression: "1 + 1" }],
    listFills: [
      {
        id: "lf1",
        name: "BRANDS",
        source: { kind: "question", questionId: "q1", take: "selected" },
        selection: { count: { kind: "fixed", value: 2 } },
        options: [
          { code: "a", label: "Alpha" },
          { code: "b", label: "Beta" },
        ],
      },
    ],
    questions: [
      {
        id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which?",
        options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }],
      },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

test("a calculation, an embedded field and a List Fill variable are not unknown references", () => {
  const d = def();
  for (const token of [
    "{{TOTAL}}",
    "{{PANEL_ID}}",
    "{{LISTFILL_BRANDS_COUNT}}",
    "{{LISTFILL_BRANDS_LABELS}}",
    "{{LISTFILL_BRANDS_1}}",
    "{{LISTFILL_BRANDS_1_CODE}}",
  ]) {
    assert.deepEqual(lintPipingTokens(d, `Text ${token} more.`), [], `${token} should resolve`);
  }
});

test("a name that reaches nothing is still reported", () => {
  const d = def();
  const problems = lintPipingTokens(d, "Hello {{NOT_A_THING}}.");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NOT_A_THING/);
});

test("the prefixed forms are checked against their own namespace", () => {
  const d = def();
  assert.deepEqual(lintPipingTokens(d, "{{calc.TOTAL}} {{ed.PANEL_ID}}"), []);
  assert.equal(lintPipingTokens(d, "{{calc.NOPE}}").length, 1);
  assert.equal(lintPipingTokens(d, "{{ed.NOPE}}").length, 1);
});

test("a question code still resolves, and a question's own text lints the same way both linters do", () => {
  const d = def();
  assert.deepEqual(lintPipingTokens(d, "You said {{Q1}}."), []);
  d.questions[1].text = "You said {{Q1}}, and your panel is {{PANEL_ID}} ({{LISTFILL_BRANDS_COUNT}}).";
  const issues = lintSurveyLogic(d).filter((i) => i.path === "text" && i.questionId === "q2");
  assert.deepEqual(issues, [], "the survey linter is clean");
  assert.deepEqual(lintPipingTokens(d, d.questions[1].text, d.questions[1]), [], "and so is the typing-time linter");
});

test("a malformed token is still malformed", () => {
  assert.match(lintPipingTokens(def(), "{{ }}")[0] ?? "", /Malformed|Unknown/);
});

/* ------------------------------------------------- "other, specify" tokens */

const withOthers = () =>
  SurveyDefinition.parse({
    meta: { id: "s2", title: "T" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "BRAND", type: "multi_select", text: "Which?",
        options: [
          { code: 1, label: "Acme" },
          { code: 97, label: "Other phone", flags: ["other_specify"] },
          { code: 98, label: "Other tablet", flags: ["other_specify"] },
        ],
      },
      { id: "q2", code: "Q2", variableName: "PLAIN", type: "open_text", text: "Why?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

test("an Other token naming a real box is accepted by both linters", () => {
  const d = withOthers();
  for (const token of ["{{Q1.other}}", "{{Q1[97].other}}", "{{Q1[98].other}}"]) {
    assert.deepEqual(lintPipingTokens(d, `You said ${token}.`), [], token);
  }
  d.questions[1].text = "You said {{Q1[98].other}}. Why?";
  assert.deepEqual(
    lintSurveyLogic(d).filter((i) => i.questionId === "q2" && i.path === "text"),
    [],
    "and the survey linter agrees",
  );
});

test("an Other token naming a box that does not exist is reported", () => {
  const d = withOthers();
  d.questions[1].text = "You said {{Q1[55].other}}.";
  const issues = lintSurveyLogic(d).filter((i) => i.questionId === "q2");
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.match(issues[0]!.message, /no “Other, specify” option “55”/);
  assert.match(issues[0]!.message, /97, 98/, "and it says which ones there are");
});

test("an Other token on a question with no Other option is reported", () => {
  const d = withOthers();
  d.questions[0].text = "You said {{Q2.other}}.";
  const issues = lintSurveyLogic(d).filter((i) => i.questionId === "q1" && /Other/.test(i.message));
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.match(issues[0]!.message, /has no “Other, specify” option to pipe/);
});

test("the option code in the bracket is not checked against the row list", () => {
  // the same slot means "which part of the answer"; for `.other` the parts are
  // boxes, and checking them against rows would fail every correct token
  const d = withOthers();
  d.questions[1].text = "{{Q1[97].other}}";
  const rowWarnings = lintSurveyLogic(d).filter((i) => /has no row/.test(i.message));
  assert.deepEqual(rowWarnings, []);
});
