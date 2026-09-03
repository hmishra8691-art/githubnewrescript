import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry, resolveVariant } from "@rescript/schema";
import {
  createResponseState,
  validateQuestion,
  htmlToText,
  sanitizeHtml,
  questionVariables,
  type EvalContext,
} from "./index.js";

/**
 * Engine behaviour behind the sliders / numbers / rich-text variant batch:
 * the from–to pair rules, the numeric-matrix "answer every row" rule, the
 * allocation sum, and rich text measuring TEXT rather than markup.
 */

function defWith(q: Record<string, unknown>) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", text: "",
      options: [], rows: [], columns: [], validation: [], required: false,
      settings: {}, skipLogic: [],
      ...q,
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
}
function ctxFor(def: any, answers: Record<string, unknown> = {}): EvalContext {
  const state = createResponseState(def, { seed: 7 });
  Object.assign(state.answers, answers);
  return { def, state };
}
const messages = (def: any, value: unknown) =>
  validateQuestion(def, def.questions[0], value, ctxFor(def, { q1: value })).map((e) => e.message);

const RANGE_ROWS = [
  { code: "from", label: "From", fieldType: "number" },
  { code: "to", label: "To", fieldType: "number" },
];

/* ------------------------------------------------- from–to pair (rangePair) */

test("a from–to pair refuses from > to and accepts from <= to", () => {
  const def = defWith({ type: "numeric_list", rows: RANGE_ROWS, settings: { rangePair: true } });
  assert.match(
    messages(def, { from: 40, to: 10 }).join(" | "),
    /must not be greater/,
    "40–10 is not a range",
  );
  assert.deepEqual(messages(def, { from: 10, to: 40 }), []);
  assert.deepEqual(messages(def, { from: 25, to: 25 }), [], "a single-point range is legal");
});

test("a half-filled from–to pair is not judged on order, only on required", () => {
  const open = defWith({ type: "numeric_list", rows: RANGE_ROWS, settings: { rangePair: true } });
  assert.deepEqual(messages(open, { from: 40 }), [], "no partner yet, nothing to compare");

  const required = defWith({
    type: "numeric_list", rows: RANGE_ROWS, required: true, settings: { rangePair: true },
  });
  assert.match(messages(required, { from: 40 }).join(" | "), /To: this field is required/);
  assert.deepEqual(messages(required, { from: 40, to: 60 }), []);
});

test("settings bounds apply to BOTH sides of a from–to pair", () => {
  // the pair's answer is an object, so the scalar min/max check never saw it
  const def = defWith({
    type: "numeric_list", rows: RANGE_ROWS,
    settings: { rangePair: true, minValue: 0, maxValue: 100 },
  });
  assert.match(messages(def, { from: -5, to: 50 }).join(" | "), /From: must be at least 0/);
  assert.match(messages(def, { from: 5, to: 500 }).join(" | "), /To: must be at most 100/);
  assert.deepEqual(messages(def, { from: 0, to: 100 }), []);
});

test("the from–to pair exports as two ordinary numeric variables", () => {
  const def = defWith({ type: "numeric_list", rows: RANGE_ROWS, settings: { rangePair: true } });
  const names = questionVariables(def.questions[0]).map((v) => v.name);
  assert.deepEqual(names, ["Q1_from", "Q1_to"]);
});

/* --------------------------------------------- multi-attribute (matrix_numeric) */

test("a required numeric matrix asks for every row — one slider left untouched blocks", () => {
  const def = defWith({
    type: "matrix_numeric", required: true,
    rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Quality" }, { code: "r3", label: "Service" }],
    settings: { minValue: 0, maxValue: 100 },
  });
  const partial = messages(def, { r1: 40, r2: 0 });
  assert.equal(partial.length, 1, "only the untouched row is complained about");
  assert.match(partial[0], /Service/);
  assert.deepEqual(messages(def, { r1: 40, r2: 0, r3: 90 }), [], "0 is an answer, not an absence");
});

/* ---------------------------------------------------- allocation sliders */

test("allocation sliders are held to the sum target, under or over", () => {
  const def = defWith({
    type: "allocation",
    options: [{ code: "1", label: "A" }, { code: "2", label: "B" }],
    settings: { sumTarget: 100, sumUnit: " %" },
  });
  assert.match(messages(def, { 1: 30, 2: 30 }).join(" | "), /Total must equal 100/, "under-allocation is refused on Next");
  assert.deepEqual(messages(def, { 1: 30, 2: 70 }), []);
});

/* ------------------------------------------------------------- rich text */

test("htmlToText measures what the respondent wrote, not the markup", () => {
  assert.equal(htmlToText("<b>Hi</b>"), "Hi");
  assert.equal(htmlToText("<p>one</p><p>two</p>"), "one two", "block ends are word breaks");
  assert.equal(htmlToText("a<br>b"), "a b");
  assert.equal(htmlToText("5 &lt; 6 &amp; 7 &gt; 6"), "5 < 6 & 7 > 6");
  assert.equal(htmlToText("plain text"), "plain text");
});

test("min_length / max_length on a rich-text answer count text, not tags", () => {
  const def = defWith({
    type: "long_text", variant: "text.rich_text",
    validation: [{ kind: "min_length", value: 10 }, { kind: "max_length", value: 20 }],
  });
  // 21 characters of markup, 4 of text — the respondent has written "Hiya"
  assert.match(messages(def, "<strong>Hiya</strong>").join(" | "), /at least 10/,
    "markup must not buy the respondent length");
  const long = "<b>" + "a".repeat(15) + "</b>";
  assert.deepEqual(messages(def, long), [], "15 characters of text inside tags passes both rules");
  assert.match(messages(def, "<b>" + "a".repeat(30) + "</b>").join(" | "), /at most 20/,
    "over-long text is still refused");
});

test("plain long_text is measured exactly as before — no rich-text behaviour leaks", () => {
  const def = defWith({
    type: "long_text",
    validation: [{ kind: "min_length", value: 10 }, { kind: "max_length", value: 20 }],
  });
  assert.deepEqual(messages(def, "a".repeat(15)), []);
  assert.match(messages(def, "short").join(" | "), /at least 10/);
  assert.match(messages(def, "a".repeat(25)).join(" | "), /at most 20/);
  // a lone "<" or a stray ">" is text, not markup
  assert.deepEqual(messages(def, "5 < 6 and 7 > 6!!"), []);
});

test("an empty rich-text answer is still required-blocked", () => {
  const def = defWith({ type: "long_text", variant: "text.rich_text", required: true });
  assert.match(messages(def, "").join(" | "), /required/);
  assert.deepEqual(messages(def, "<b>something</b>"), []);
});

test("what the rich-text surface stores is sanitized", () => {
  // the renderer runs every keystroke through sanitizeHtml; formatting stays
  assert.equal(sanitizeHtml("<b>hi</b>"), "<b>hi</b>");
  assert.equal(sanitizeHtml('<b onclick="x()">hi</b>'), "<b>hi</b>");
  assert.equal(sanitizeHtml("<script>bad()</script>ok"), "bad()ok");
});

/* ------------------------------------------------------ registry contract */

test("all seven G1 variants are stable and point at their renderer + base type", () => {
  const expect: [string, string, string, string][] = [
    ["numeric.numeric_range", "numeric_list", "numrange", "fields"],
    ["slider.dual", "numeric_list", "rangeslider", "fields"],
    ["slider.vertical", "slider", "vslider", "numeric"],
    ["slider.multi_attribute", "matrix_numeric", "slidermatrix", "per_row"],
    ["slider.allocation_slider", "allocation", "sliderallocation", "allocation"],
    ["allocation.slider_allocation", "allocation", "sliderallocation", "allocation"],
    ["text.rich_text", "long_text", "richtext", "text"],
  ];
  for (const [id, baseType, renderer, model] of expect) {
    const v = variantRegistry.get(id);
    assert.ok(v, `${id} is registered`);
    assert.equal(v!.status, "stable", `${id} is stable`);
    assert.equal(v!.baseType, baseType);
    assert.equal(v!.renderer, renderer);
    assert.equal(v!.responseModel, model);
    assert.equal(resolveVariant(id)!.id, id, `${id} is not retired`);
  }
  // the from–to pair is the SAME data in two presentations
  assert.deepEqual(
    variantRegistry.get("slider.dual")!.defaults!.rows!.map((r) => r.code),
    variantRegistry.get("numeric.numeric_range")!.defaults!.rows!.map((r) => r.code),
  );
  assert.equal(variantRegistry.get("allocation.drag_allocation")!.status, "planned",
    "Drag Allocation stays planned — another batch owns it");
});
