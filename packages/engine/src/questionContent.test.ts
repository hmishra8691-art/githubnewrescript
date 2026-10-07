import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, Question, normalizeQuestionContent } from "@rescript/schema";
import { staleFields } from "./questionShape.js";

/*
 * ONE PLACE FOR WHAT A QUESTION SAYS (October 2026 review): the text. The
 * old `customHtml` ("HTML Content", "Custom HTML above the input") is moved
 * on every parse, so a saved survey renders as it did.
 */
const q = (x: Record<string, unknown>) => Question.parse({ id: "q", code: "Q1", variableName: "Q1", text: "", ...x });

test("a Text / HTML block: its HTML content becomes its text; a label it did not repeat is kept in notes", () => {
  const html = "<style>.b{display:grid}</style><div class=\"b\">board</div>";
  const a = q({ type: "html", text: "chess board in the content hidden html content", customHtml: html });
  assert.equal(a.text, html, "what the respondent saw is the text");
  assert.equal((a as { customHtml?: string }).customHtml, undefined, "no rival copy remains");
  assert.match(String(a.notes), /Label before the HTML content was merged.*chess board in the content hidden/);
  const same = q({ type: "html", text: "Welcome", customHtml: "<h2>Welcome</h2>" });
  assert.equal(same.text, "<h2>Welcome</h2>");
  assert.equal(same.notes, undefined, "a label the HTML already says is not noted");
  const plain = q({ type: "html", text: "<p>Just text</p>" });
  assert.equal(plain.text, "<p>Just text</p>", "a block written in the text editor is untouched");
});

test("any other question: Custom HTML above the input joins the instruction (after it)", () => {
  const a = q({ type: "single_select", text: "Pick", instruction: "Select one.", customHtml: "<p class=\"note\">Note</p>" });
  assert.equal(a.instruction, "Select one.<p class=\"note\">Note</p>");
  assert.equal((a as { customHtml?: string }).customHtml, undefined);
  const b = q({ type: "numeric", text: "Age", customHtml: "<b>in years</b>" });
  assert.equal(b.instruction, "<b>in years</b>");
  const empty = q({ type: "numeric", text: "Age", customHtml: "   " });
  assert.equal(empty.instruction, undefined, "an empty leftover is simply dropped");
});

test("a Custom Component keeps its template; normalisation is idempotent and never mutates", () => {
  const c = q({ type: "custom_component", text: "Widget", customHtml: "<div id=w></div>" });
  assert.equal(c.customHtml, "<div id=w></div>");
  const raw = { id: "q", code: "Q1", variableName: "Q1", type: "html", text: "x", customHtml: "<p>y</p>" };
  const once = normalizeQuestionContent(raw) as Record<string, unknown>;
  assert.equal(raw.customHtml, "<p>y</p>", "the input object is not changed");
  assert.deepEqual(normalizeQuestionContent(once), once, "running it again changes nothing");
});

test("the whole survey: save → JSON → reload keeps one canonical content", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "h", code: "H1", variableName: "H1", type: "html", text: "label", customHtml: "<p>Body</p>" },
      { id: "q", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick", customHtml: "<i>hint</i>", options: [{ code: 1, label: "A" }] },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["h", "q"] }, { type: "end", id: "e", status: "complete" }],
  });
  const json = JSON.parse(JSON.stringify(def));
  assert.ok(!JSON.stringify(json).includes("customHtml"), "saved JSON carries no customHtml");
  const back = SurveyDefinition.parse(json);
  assert.deepEqual(back.questions.map((x) => [x.text, x.instruction]), [["<p>Body</p>", undefined], ["Pick", "<i>hint</i>"]]);
});

test("leftover-field check: a setting the shape table does not own is never 'left over' (the Currency screenshot)", () => {
  const cur = q({ type: "numeric", variant: "numeric.currency", settings: { currencyCode: "USD", symbolSide: "left", decimalPlaces: 2, numberSign: "positive", affixText: "per month", affixSide: "right" } });
  assert.deepEqual(staleFields(cur).map((c) => c.field), [], "Currency's own currency is not left over");
  const radio = q({ type: "single_select", variant: "single_select.radio", settings: { optionSearch: "auto", validationPosition: "above", columnsLayout: 2 } });
  assert.deepEqual(staleFields(radio).map((c) => c.field), [], "presentation settings the table does not list are kept");
  const truly = q({ type: "single_select", variant: "single_select.radio", settings: { minValue: 1, maxValue: 9, currencyCode: "USD" } });
  assert.deepEqual(staleFields(truly).map((c) => c.field).sort(), ["settings.currencyCode", "settings.maxValue", "settings.minValue"], "a number's own settings on a choice question still are");
});
