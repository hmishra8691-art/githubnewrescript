/**
 * A SETTING THAT CANNOT TAKE EFFECT IS A LINT FINDING.
 *
 * Read as a whole, the September 2026 review is largely one complaint told
 * twenty different ways: a control exists, the programmer sets it, and
 * nothing happens. Each instance was fixed in this pass. This is what stops
 * the class coming back the next time a variant is added — the author is told
 * while they are authoring, instead of a reviewer finding it in a screenshot
 * three weeks later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { lintQuestionLogic } from "./lintLogic.js";

function survey(q: Record<string, unknown>) {
  const def = SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Lint", version: "1.0" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", text: "?", ...q }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  return { def, q: def.questions[0] as Question };
}
const paths = (def: Parameters<typeof lintQuestionLogic>[0], q: Question) =>
  lintQuestionLogic(def, q).map((i) => i.path);

test("a column layout on a renderer that draws no columns is reported", () => {
  const { def, q } = survey({
    type: "multi_dropdown", variant: "multi_select.dropdown",
    options: [{ code: 1, label: "A" }, { code: 2, label: "B" }],
    settings: { columnsLayout: 3 },
  });
  assert.ok(paths(def, q).includes("settings.columnsLayout"));

  /* and the same setting on a renderer that does draw columns is not */
  const ok = survey({
    type: "single_select", variant: "single_select.cards",
    options: [{ code: 1, label: "A" }], settings: { columnsLayout: 3 },
  });
  assert.ok(!paths(ok.def, ok.q).includes("settings.columnsLayout"));
});

test("a scale beyond what the variant allows is reported", () => {
  const { def, q } = survey({
    type: "numeric", variant: "single_select.heart_rating",
    settings: { minValue: 1, maxValue: 50 },
  });
  const issue = lintQuestionLogic(def, q).find((i) => i.path === "settings.maxValue");
  assert.ok(issue, "a 1–50 heart rating draws ten hearts and should say so");
  assert.match(issue!.message, /1–10/);
});

test("more selections demanded than there are options is reported", () => {
  const { def, q } = survey({
    type: "multi_select", variant: "multi_select.checkbox",
    options: [1, 2, 3, 4, 5, 6].map((n) => ({ code: n, label: `O${n}` })),
    settings: { minSelections: 3, maxSelections: 40 },
  });
  assert.ok(paths(def, q).includes("settings.maxSelections"),
    "the review's screenshot: min 3 / max 40 against six options");
});

test("an option image no renderer will draw is reported", () => {
  /* the review's "image not displayed in preview", caught at authoring time */
  const { def, q } = survey({
    type: "single_select", variant: "single_select.radio",
    options: [{ code: 1, label: "A", imageUrl: "https://example.com/a.png" }],
  });
  assert.ok(paths(def, q).includes("options[].imageUrl"));
});

test("an option with no text is reported", () => {
  const { def, q } = survey({
    type: "single_select", variant: "single_select.radio",
    options: [{ code: 1, label: "A" }, { code: 2, label: "  " }],
  });
  const issue = lintQuestionLogic(def, q).find((i) => i.path === "options[].label");
  assert.ok(issue, "a blank option renders as an empty row the respondent can still choose");
  assert.match(issue!.message, /\b2\b/);
});

test("a regular expression that cannot be compiled is an error, not a silent pass", () => {
  const { def, q } = survey({
    type: "open_text", variant: "text.regex",
    validation: [{ kind: "pattern", value: "^[a-z" }],
  });
  const issue = lintQuestionLogic(def, q).find((i) => i.path === "validation[0].value");
  assert.ok(issue);
  assert.equal(issue!.level, "error");
});

test("a correctly configured question raises none of these", () => {
  const { def, q } = survey({
    type: "multi_select", variant: "multi_select.cards",
    options: [1, 2, 3].map((n) => ({ code: n, label: `O${n}`, imageUrl: "https://example.com/a.png" })),
    settings: { columnsLayout: 2, minSelections: 1, maxSelections: 3 },
  });
  assert.deepEqual(lintQuestionLogic(def, q), []);
});
