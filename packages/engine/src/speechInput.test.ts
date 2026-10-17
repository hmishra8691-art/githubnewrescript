import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  speechInputFor, speechInputSurveyOn, speechInputQuestionOn, speechFieldIsProse, questionOffersSpeechInput, speechInputLang, appendSpoken,
  createResponseState, setAnswer, setOtherTextFor, otherKeyFor, validateQuestion,
} from "./index.js";

/**
 * Dictation on every open text field (October 2026): on by default, off per
 * question or per survey, never on a formatted / read-only / hidden field —
 * and the transcript is the ordinary answer under the ordinary key.
 */
const make = (questions: Record<string, unknown>[], deployment: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "sp", code: "SP", title: "Speech", version: "1.0" },
  deployment,
  questions,
  flow: [{ type: "page", id: "p1", questionIds: questions.map((q) => q.id) }, { type: "end", id: "e1", status: "complete" }],
});
const Q = (id: string, type: string, over: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: id, ...over });

test("on by default for single- and multi-line text; the legacy opt-in still means on", () => {
  const def = make([Q("t1", "open_text"), Q("t2", "long_text"), Q("t3", "open_text", { settings: { speechInput: true } })]);
  for (const q of def.questions) assert.equal(speechInputFor(def, q, { kind: "answer" }), true, q.id);
  assert.equal(speechInputSurveyOn(def), true);
  assert.equal(def.deployment.speechInput, undefined, "nothing is written by default — additive");
});

test("opt-out: per question (settings.speechInput === false) and per survey (deployment.speechInput === false)", () => {
  const def = make([Q("t1", "open_text", { settings: { speechInput: false } }), Q("t2", "open_text")]);
  assert.equal(speechInputFor(def, def.questions[0], { kind: "answer" }), false, "question opt-out");
  assert.equal(speechInputFor(def, def.questions[1], { kind: "answer" }), true, "…only that question");
  const off = make([Q("t1", "open_text", { settings: { speechInput: true } }), Q("s1", "single_select", { options: [{ code: 1, label: "Other", flags: ["other_specify"] }] })], { speechInput: false });
  assert.equal(speechInputSurveyOn(off), false);
  assert.equal(speechInputFor(off, off.questions[0], { kind: "answer" }), false, "the survey switch wins over a question's legacy opt-in");
  assert.equal(speechInputFor(off, off.questions[1], { kind: "other" }), false);
});

test("never on read-only or hidden questions", () => {
  const def = make([Q("t1", "open_text", { settings: { readOnly: true } }), Q("t2", "long_text", { settings: { hidden: true } })]);
  assert.equal(speechInputQuestionOn(def, def.questions[0]), false);
  assert.equal(speechInputQuestionOn(def, def.questions[1]), false);
});

test("never on formatted text: email, phone, URL, ZIP, regex mask, numeric bounds, dates — by rule or by preset", () => {
  for (const kind of ["email", "phone", "url", "zip", "pattern", "integer", "min_value", "max_value", "date_min", "date_max"]) {
    const def = make([Q("t1", "open_text", { validation: [{ kind, value: kind === "pattern" ? "^A" : 1 }] })]);
    assert.equal(speechInputFor(def, def.questions[0], { kind: "answer" }), false, kind);
  }
  for (const variant of ["text.email", "text.phone", "text.url", "text.zip", "text.regex"]) {
    const def = make([Q("t1", "open_text", { variant })]);
    assert.equal(speechInputFor(def, def.questions[0], { kind: "answer" }), false, variant);
  }
  // length bounds and required are prose rules — dictation stays
  const def = make([Q("t1", "open_text", { validation: [{ kind: "required" }, { kind: "min_length", value: 5 }, { kind: "max_length", value: 50 }] })]);
  assert.equal(speechInputFor(def, def.questions[0], { kind: "answer" }), true);
  // and a non-text question has no text answer to dictate
  for (const type of ["numeric", "date", "time", "single_select"]) {
    const d = make([Q("x", type, type === "single_select" ? { options: [{ code: 1, label: "A" }] } : {})]);
    assert.equal(speechFieldIsProse(d.questions[0], { kind: "answer" }), false, type);
  }
});

test("Other boxes: on, except a box the author made numeric", () => {
  const opts = [{ code: 1, label: "A" }, { code: 9, label: "Other", flags: ["other_specify"] }];
  const def = make([Q("s1", "single_select", { options: opts }), Q("m1", "multi_select", { options: opts, settings: { otherSpecifyFormat: "numeric" } }), Q("m2", "multi_select", { options: opts, settings: { otherSpecifyFormat: "alphanumeric" } })]);
  assert.equal(speechInputFor(def, def.questions[0], { kind: "other" }), true);
  assert.equal(speechInputFor(def, def.questions[1], { kind: "other" }), false);
  assert.equal(speechInputFor(def, def.questions[2], { kind: "other" }), true);
});

test("form / list fields: text and long text only, and not when the field carries a format rule", () => {
  const def = make([Q("f1", "text_list", { rows: [
    { code: "name", label: "Name", fieldType: "text" },
    { code: "bio", label: "Bio", fieldType: "longtext" },
    { code: "mail", label: "Email", fieldType: "email" },
    { code: "zip", label: "ZIP", fieldType: "zip" },
    { code: "age", label: "Age", fieldType: "integer" },
    { code: "ref", label: "Ref", fieldType: "text", validation: [{ kind: "pattern", value: "^R" }] },
  ] })]);
  const q = def.questions[0];
  const on = (q.rows ?? []).filter((r) => speechInputFor(def, q, { kind: "field", fieldType: r.fieldType, row: r })).map((r) => r.code);
  assert.deepEqual(on, ["name", "bio"]);
  assert.equal(speechInputFor(def, q, { kind: "field" }), true, "a field with no type is a text field");
});

test("the Studio offers the switch exactly where some field would take dictation", () => {
  const def = make([
    Q("t1", "open_text"), Q("e1", "open_text", { variant: "text.email", validation: [{ kind: "email" }] }),
    Q("n1", "numeric"), Q("s1", "single_select", { options: [{ code: 1, label: "A" }] }),
    Q("s2", "single_select", { options: [{ code: 1, label: "Other", flags: ["other_specify"] }] }),
    Q("f1", "text_list", { rows: [{ code: "a", label: "A", fieldType: "email" }] }),
    Q("f2", "text_list", { rows: [{ code: "a", label: "A", fieldType: "email" }, { code: "b", label: "B" }] }),
    Q("l1", "numeric_list", { rows: [{ code: "a", label: "A" }] }),
  ]);
  const offered = def.questions.filter((q) => questionOffersSpeechInput(q)).map((q) => q.id);
  assert.deepEqual(offered, ["t1", "s2", "f2"]);
});

test("speechLang wins, then the voice mode's, then the survey's language", () => {
  const def = make([Q("t1", "open_text", { settings: { speechLang: "hi-IN" } }), Q("t2", "open_text")], { languages: ["de"] });
  assert.equal(speechInputLang(def, def.questions[0]), "hi-IN");
  assert.equal(speechInputLang(def, def.questions[1]), "de");
});

test("persistence: the dictated text is the ordinary answer under the ordinary key — validated as typed text, no extra keys", () => {
  const def = make([
    Q("t1", "long_text", { validation: [{ kind: "required" }, { kind: "min_length", value: 20 }, { kind: "max_length", value: 60 }] }),
    Q("s1", "single_select", { options: [{ code: 1, label: "A" }, { code: 9, label: "Other", flags: ["other_specify"] }] }),
    Q("f1", "text_list", { rows: [{ code: "name", label: "Name", fieldType: "text" }] }),
  ]);
  const [t1, s1, f1] = def.questions;
  const state = createResponseState(def);
  const ctx = { def, state, loop: null };
  // typed, then dictated (appended), then edited by hand
  let v = appendSpoken("I liked the", "  packaging but not the price ");
  assert.equal(v, "I liked the packaging but not the price");
  v = v.replace("price", "delivery");
  setAnswer(def, state, t1.id, v);
  assert.deepEqual(validateQuestion(def, t1, state.answers[t1.id], ctx), [], "the edited final text passes required + length");
  setAnswer(def, state, t1.id, appendSpoken("", "too short"));
  assert.ok(validateQuestion(def, t1, state.answers[t1.id], ctx).some((e) => /20/.test(e.message)), "min_length still applies to a dictated answer");
  setAnswer(def, state, t1.id, appendSpoken("x".repeat(55), "and much more than sixty"));
  assert.ok(validateQuestion(def, t1, state.answers[t1.id], ctx).length > 0, "max_length still applies");
  setAnswer(def, state, t1.id, "");
  assert.ok(validateQuestion(def, t1, state.answers[t1.id], ctx).length > 0, "required still applies");
  setAnswer(def, state, t1.id, v);
  // the Other box: its own per-option key
  setAnswer(def, state, s1.id, 9);
  setOtherTextFor(state, s1, 9, appendSpoken("A local", "brand from Pune"));
  assert.equal(state.answers[otherKeyFor(s1.id, 9, null)], "A local brand from Pune");
  // a form field: the row key inside the question's answer object
  setAnswer(def, state, f1.id, { name: appendSpoken("", "Asha Rao") });
  assert.deepEqual(state.answers[f1.id], { name: "Asha Rao" });
  const keys = Object.keys(state.answers).sort();
  assert.deepEqual(keys, [f1.id, s1.id, otherKeyFor(s1.id, 9, null), t1.id].sort(), "no __voice or any other extra key");
  assert.ok(!keys.some((k) => /voice|speech|dictat/i.test(k)));
});

test("appendSpoken never replaces what was typed", () => {
  assert.equal(appendSpoken("", "hello"), "hello");
  assert.equal(appendSpoken("Hi ", "there"), "Hi there");
  assert.equal(appendSpoken("Hi", "  "), "Hi");
  assert.equal(appendSpoken("  keep my spaces", "ok"), "  keep my spaces ok");
});
