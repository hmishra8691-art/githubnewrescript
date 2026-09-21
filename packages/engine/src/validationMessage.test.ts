import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type ValidationRule } from "@rescript/schema";
import { validateQuestion } from "./validate.js";
import { createResponseState } from "./state.js";
import { setAnswer, start } from "./flow.js";

/*
 * A VALIDATION MESSAGE THE AUTHOR FORMATTED — AND EVERY ONE THEY DID NOT.
 *
 * The rich editor makes `message` able to hold markup. The whole risk of
 * that is not the new messages, it is the old ones: every validation message
 * written before this existed is plain text, and a good number of them will
 * contain a character that means something in HTML. "Please enter a value
 * < 100" is not an unusual message; rendered as markup it loses everything
 * from the `<` onwards, silently, in field, to a respondent who is already
 * stuck.
 *
 * So the format is an explicit opt-in — `messageFormat: "html"`, set by the
 * editor when it writes markup — and never inferred from the content. These
 * tests hold both halves: markup arrives as markup and is sanitised, and
 * anything without the flag is untouched, whatever is in it.
 */

const state0 = (def: SurveyDefinition) => {
  const s = createResponseState(def);
  start(def, s);
  return s;
};

/** One numeric question with one rule on it, plus a Q1 to pipe from. */
function survey(rule: ValidationRule): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-00000000vm01", code: "VM", title: "Validation messages" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "BRAND", type: "single_select", text: "Which brand?",
        options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }],
      },
      {
        id: "q2", code: "Q2", variableName: "SPEND", type: "numeric", text: "How much?",
        validation: [rule],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
}

const failing = (def: SurveyDefinition, value: unknown = 5) => {
  const state = state0(def);
  return validateQuestion(def, def.questions.find((q) => q.id === "q2")!, value, { def, state });
};

/* ================================================== the messages nobody touched */

test("a plain message is delivered exactly as written, `<` and all", () => {
  /*
   * THE REGRESSION THIS WHOLE DESIGN EXISTS TO PREVENT. Under a
   * sniff-for-a-tag rule this message would be treated as markup, the
   * browser would read `< 100.` as an unclosed tag, and the respondent
   * would be told "Please enter a value" with no number in it.
   */
  const def = survey({ kind: "min_value", value: 100, message: "Please enter a value < 100." });
  const errs = failing(def);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, "Please enter a value < 100.");
  assert.equal(errs[0].html, undefined, "a message with no format flag must not be marked as markup");
});

test("the engine's own default wording is never markup", () => {
  const def = survey({ kind: "min_value", value: 100 });
  const errs = failing(def);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /at least 100/);
  assert.equal(errs[0].html, undefined);
});

test("an ampersand in a plain message survives", () => {
  const def = survey({ kind: "min_value", value: 100, message: "Enter your profit & loss figure." });
  assert.equal(failing(def)[0].message, "Enter your profit & loss figure.");
});

/* ============================================================ the formatted ones */

test("a message marked as html arrives as markup, and says so", () => {
  const def = survey({
    kind: "min_value", value: 100,
    message: "<strong>Too low.</strong> Please enter at least <em>100</em>.",
    messageFormat: "html",
  });
  const errs = failing(def);
  assert.equal(errs[0].html, true);
  assert.equal(errs[0].message, "<strong>Too low.</strong> Please enter at least <em>100</em>.");
});

test("what the author wrote is sanitised where the error is raised, not where it is drawn", () => {
  /*
   * The engine is the chokepoint because a message is read in more places
   * than the runtime: the Studio canvas, a test-mode report, an export. A
   * sanitiser that only runs in the renderer protects one of those.
   */
  const def = survey({
    kind: "min_value", value: 100,
    message: '<strong>Careful</strong><script>steal()</script><a href="javascript:go()">link</a>',
    messageFormat: "html",
  });
  const m = failing(def)[0].message;
  assert.doesNotMatch(m, /<script/i, `the script survived: ${m}`);
  assert.doesNotMatch(m, /javascript:/i, `the javascript: url survived: ${m}`);
  assert.match(m, /<strong>Careful<\/strong>/, "and the formatting the author wanted is still there");
});

test("an event handler attribute does not survive either", () => {
  const def = survey({
    kind: "min_value", value: 100,
    message: '<span onclick="steal()">Too low</span>',
    messageFormat: "html",
  });
  const m = failing(def)[0].message;
  assert.doesNotMatch(m, /onclick/i, m);
  assert.match(m, /Too low/);
});

/* ==================================================================== piping */

test("piping resolves inside the markup, not only around it", () => {
  const def = survey({
    kind: "min_value", value: 100,
    message: "You chose <strong>{{Q1.label}}</strong> — please enter more than 100.",
    messageFormat: "html",
  });
  const state = state0(def);
  setAnswer(def, state, "q1", "1");
  const errs = validateQuestion(def, def.questions[1], 5, { def, state });
  assert.equal(errs[0].message, "You chose <strong>Alpha</strong> — please enter more than 100.");
  assert.equal(errs[0].html, true);
});

test("piping still works in a plain message, as it always has", () => {
  const def = survey({ kind: "min_value", value: 100, message: "You chose {{Q1.label}}." });
  const state = state0(def);
  setAnswer(def, state, "q1", "2");
  const errs = validateQuestion(def, def.questions[1], 5, { def, state });
  assert.equal(errs[0].message, "You chose Beta.");
  assert.equal(errs[0].html, undefined);
});

test("PIPE FIRST, THEN SANITISE — a respondent cannot supply the target of an author's link", () => {
  /*
   * THE ORDER IS THE SAFETY ARGUMENT, AND THIS IS THE CASE THAT SHOWS IT.
   *
   * An author may legitimately write `<a href="{{Q1}}">your site</a>`.
   * Piping escapes the value it substitutes, so the tag-shaped answer in the
   * test below is inert either way — which is why my first attempt at this
   * test passed with the two steps in EITHER order and proved nothing. A
   * mutant that sanitised before piping survived it.
   *
   * A URL needs no angle brackets. `javascript:steal()` passes through
   * `escapeHtml` completely unchanged, so:
   *
   *   sanitise → pipe :  the sanitiser inspects `href="{{Q1}}"`, finds
   *                      nothing wrong, and the javascript: URL is dropped
   *                      into the attribute afterwards. Live.
   *   pipe → sanitise :  the sanitiser inspects the finished attribute and
   *                      neutralises it.
   *
   * Escaping protects the text; only the ordering protects the attributes.
   */
  const linky = SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-00000000vm04", code: "VM4", title: "Piped href" },
    questions: [
      { id: "q1", code: "Q1", variableName: "SITE", type: "text", text: "Your website?" },
      {
        id: "q2", code: "Q2", variableName: "SPEND", type: "numeric", text: "How much?",
        validation: [{
          kind: "min_value", value: 100,
          message: '<a href="{{Q1}}">Check your figure</a>',
          messageFormat: "html",
        }],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const st = state0(linky);
  setAnswer(linky, st, "q1", "javascript:steal()");
  const m = validateQuestion(linky, linky.questions[1], 5, { def: linky, state: st })[0].message;
  assert.doesNotMatch(
    m, /href\s*=\s*["']?javascript:/i,
    `a respondent's javascript: URL reached the author's href — the sanitiser ran before the value did: ${m}`,
  );
});

test("a piped value cannot bring markup of its own into a formatted message", () => {
  /*
   * The text half of the same property: an answer containing a tag arrives
   * as visible text rather than as markup, because `resolvePiping` escapes
   * every respondent-derived value it substitutes.
   */
  const def = SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-00000000vm02", code: "VM2", title: "Piped markup" },
    questions: [
      { id: "q1", code: "Q1", variableName: "NAME", type: "text", text: "Your name?" },
      {
        id: "q2", code: "Q2", variableName: "SPEND", type: "numeric", text: "How much?",
        validation: [{
          kind: "min_value", value: 100,
          message: "<strong>{{Q1}}</strong>, please enter at least 100.",
          messageFormat: "html",
        }],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const state = state0(def);
  setAnswer(def, state, "q1", "<img src=x onerror=steal()>");
  const m = validateQuestion(def, def.questions[1], 5, { def, state })[0].message;
  assert.doesNotMatch(m, /<img/i, `the respondent's tag became markup: ${m}`);
  assert.match(m, /&lt;img/, `the respondent's text should still be readable: ${m}`);
  assert.match(m, /<strong>/, "and the author's own formatting is untouched");
});

/* ============================================ per-row and per-cell prefixes */

test("a per-row message keeps its label prefix, and the label is escaped only for markup", () => {
  /*
   * The engine puts `"<row label>: "` on the front of a per-row failure. When
   * the message is markup the two are being joined into one HTML string, so
   * a label containing `&` or `<` has to be escaped on the way in — and when
   * it is NOT markup it must not be, or an ordinary row called "Coffee & tea"
   * would start reading "Coffee &amp; tea" in the error.
   */
  const build = (rule: ValidationRule) => SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-00000000vm03", code: "VM3", title: "Rows" },
    questions: [{
      id: "q1", code: "Q1", variableName: "SPEND", type: "numeric_list", text: "Spend",
      rows: [{ code: "r1", label: "Coffee & tea", fieldType: "number", validation: [rule] }],
    }],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

  const plain = build({ kind: "min_value", value: 10, message: "too little" });
  const a = validateQuestion(plain, plain.questions[0], { r1: 1 }, { def: plain, state: state0(plain) })[0];
  assert.equal(a.message, "Coffee & tea: too little");
  assert.equal(a.rowCode, "r1", "the row is named structurally, not only in the prose");
  assert.equal(a.html, undefined);

  const rich = build({ kind: "min_value", value: 10, message: "<em>too little</em>", messageFormat: "html" });
  const b = validateQuestion(rich, rich.questions[0], { r1: 1 }, { def: rich, state: state0(rich) })[0];
  assert.equal(b.message, "Coffee &amp; tea: <em>too little</em>");
  assert.equal(b.html, true);
  assert.equal(b.rowCode, "r1");
});
