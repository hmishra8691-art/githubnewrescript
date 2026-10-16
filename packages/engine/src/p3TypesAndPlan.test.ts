import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, BUILTIN_QUESTION_TYPES, variantRegistry, isSelectableVariant, resolveVariant, questionTypeRegistry, type Question } from "@rescript/schema";
import {
  ACTION_TYPES, variantForActionType, applySurveyActions, coerceSurveyActions, reviewAnalysisPlan,
  validateQuestion, blockingErrors, createResponseState, migrateQuestionType,
  parseDuration, formatDuration, splitDuration, joinDuration, parseLocalDateTime, formatDateTimeAs,
} from "./index.js";

/*
 * P3 batch, engineer Q (audit 2026-10-16): QT-08 (validation kinds on the AI
 * path), QT-10 (a name for every type), QT-12 (Date & Time, Duration), AI-09
 * (a grid planned as one score).
 */

let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const byRef = (d: SurveyDefinition, v: string) => d.questions.find((q) => q.variableName === v)!;
const errorsOf = (def: SurveyDefinition, q: Question, v: unknown) =>
  blockingErrors(validateQuestion(def, q, v, { def, state: createResponseState(def) })).map((e) => e.message);
const run = (def: SurveyDefinition, raw: unknown[]) => applySurveyActions(def, coerceSurveyActions(raw).actions, { ids });

/* ------------------------------------------------------------------ QT-10 */

/* matrix_numeric / matrix_text / matrix_dropdown name the composite grid of typed cells, as they always have */
const COMPOSITE_NAMES = new Set(["matrix_numeric", "matrix_text", "matrix_dropdown"]);

test("QT-10: every registered question type has a name create_question accepts", () => {
  for (const type of BUILTIN_QUESTION_TYPES) {
    if (type === "custom_component") continue; // no stable variant — a registered plugin renders it
    assert.ok(questionTypeRegistry.has(type), `${type} registered`);
    const id = variantForActionType(type);
    assert.ok(id, `“${type}” has a friendly name`);
    const v = variantRegistry.get(id!)!;
    assert.equal(v.baseType, COMPOSITE_NAMES.has(type) ? "composite" : type, `${type} → ${id}`);
  }
});

test("QT-10: every friendly name points at a variant a programmer could pick (or one retired into it)", () => {
  for (const [name, id] of Object.entries(ACTION_TYPES)) {
    assert.ok(variantRegistry.get(id), `${name} → ${id} is registered`);
    assert.ok(isSelectableVariant(resolveVariant(id)!), `${name} → ${id} is selectable`);
  }
});

test("QT-10: the model can create a geo, repeating, signature, composite and image question by name", () => {
  const r = run(empty(), [
    { op: "create_block", title: "B" },
    { op: "create_question", ref: "WHERE", type: "geo", text: "Where do you live?" },
    { op: "create_question", ref: "KIDS", type: "repeating_group", text: "Tell us about each child" },
    { op: "create_question", ref: "SIGN", type: "signature", text: "Sign here" },
    { op: "create_question", ref: "GRID", type: "composite", text: "Rate and price", rows: ["A", "B"] },
    { op: "create_question", ref: "PICK", type: "image_select", text: "Pick one", options: ["Red", "Blue"] },
    { op: "create_question", ref: "MULTI", type: "multi dropdown", text: "Brands?", options: ["A", "B"] },
  ]);
  assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => x.error), []);
  assert.equal(byRef(r.def, "WHERE").type, "geo");
  assert.equal(byRef(r.def, "KIDS").type, "repeating_group");
  assert.equal(byRef(r.def, "SIGN").variant, "upload.signature");
  assert.equal(byRef(r.def, "GRID").type, "composite");
  assert.equal(byRef(r.def, "PICK").type, "image_select");
  assert.equal(byRef(r.def, "MULTI").type, "multi_dropdown");
});

/* ------------------------------------------------------------------ QT-08 */

const withScript = () => {
  const d = empty();
  d.scripts = [{ id: "sc1", name: "evenOnly", scope: "survey", event: "on_validate", code: "if (Number(value) % 2) ctx.error('Even numbers only.');", enabled: true }] as never;
  return d;
};

test("QT-08: custom_expression and custom_script survive the gate and are stored", () => {
  const c = coerceSurveyActions([{ op: "set_validation", target: "Q1", rules: [{ kind: "custom_expression", value: "value > 2" }, { kind: "custom_script", value: "evenOnly" }] }]);
  assert.deepEqual((c.actions[0] as { rules: { kind: string }[] }).rules.map((x) => x.kind), ["custom_expression", "custom_script"]);
  const r = run(withScript(), [
    { op: "create_block", title: "B" },
    { op: "create_question", ref: "N", type: "numeric", text: "A number?" },
    { op: "set_validation", target: "N", rules: [{ kind: "custom_expression", value: "value > 2" }, { kind: "custom_script", value: "evenOnly" }] },
  ]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
  const q = byRef(r.def, "N");
  assert.deepEqual(q.validation.map((v) => v.kind).sort(), ["custom_expression", "custom_script"]);
  assert.deepEqual(errorsOf(r.def, q, 1), ["Invalid answer.", "Even numbers only."]);
  assert.deepEqual(errorsOf(r.def, q, 3), ["Even numbers only."]);
  assert.deepEqual(errorsOf(r.def, q, 4), []);
});

test("QT-08: a rule the engine could not run is refused with its reason, not stored", () => {
  const base = run(empty(), [{ op: "create_block", title: "B" }, { op: "create_question", ref: "T", type: "text", text: "Code?" }]).def;
  const one = (rules: unknown[]) => run(base, [{ op: "set_validation", target: "T", rules }]).results[0];
  assert.match(one([{ kind: "pattern", value: "^[A-Z" }]).error ?? "", /not a valid regular expression/);
  assert.match(one([{ kind: "custom_script", value: "nope" }]).error ?? "", /no script named “nope”/);
  assert.match(one([{ kind: "custom_expression", value: "value >" }]).error ?? "", /does not parse/);
  const ok = run(base, [{ op: "set_validation", target: "T", rules: [{ kind: "pattern", value: "^[A-Z]{2}\\d{2}$", message: "Two letters, two digits" }] }]);
  assert.equal(ok.results[0].ok, true);
  assert.deepEqual(errorsOf(ok.def, byRef(ok.def, "T"), "ab12"), ["Two letters, two digits"]);
  // the same check on create_question
  const made = run(base, [{ op: "create_question", ref: "U", type: "text", text: "U?", validation: [{ kind: "pattern", value: "(" }] }]);
  assert.match(made.results[0].error ?? "", /not a valid regular expression/);
});

test("QT-08: the condition kind is settable from the action path", () => {
  const r = run(empty(), [
    { op: "create_block", title: "B" },
    { op: "create_question", ref: "HH", type: "numeric", text: "Household size?" },
    { op: "create_question", ref: "KIDS", type: "numeric", text: "Children?", validation: [{ kind: "condition", check: "KIDS < HH", message: "Fewer children than people" }] },
  ]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
  const q = byRef(r.def, "KIDS");
  assert.equal(q.validation.find((v) => v.kind === "condition")?.message, "Fewer children than people");
});

test("QT-08: otherSpecifyFormat is settable by create_question and update_question, only where there is a box", () => {
  const r = run(empty(), [
    { op: "create_block", title: "B" },
    { op: "create_question", ref: "PETS", type: "single", text: "How many pets?", options: ["None", { label: "Other number", other: true }], otherFormat: "numeric" },
    { op: "create_question", ref: "PLAIN", type: "single", text: "Yes?", options: ["Yes", "No"] },
  ]);
  assert.equal(r.results[1].ok, true);
  assert.match(r.results[1].description, /Other box accepts a number only/);
  const pets = byRef(r.def, "PETS");
  assert.equal(pets.settings.otherSpecifyFormat, "numeric");
  const u = run(r.def, [{ op: "update_question", target: "PETS", otherSpecifyFormat: "letters only" }, { op: "update_question", target: "PLAIN", otherFormat: "numeric" }]);
  assert.equal(byRef(u.def, "PETS").settings.otherSpecifyFormat, "text");
  assert.match(u.results[1].error ?? "", /no “Other \(specify\)” option/);
  const cleared = run(u.def, [{ op: "update_question", target: "PETS", otherFormat: "none" }]);
  assert.equal(byRef(cleared.def, "PETS").settings.otherSpecifyFormat, undefined);
});

/* ------------------------------------------------------------------ QT-12 */

test("QT-12: Date & Time and Duration are registered variants of date and numeric", () => {
  const dt = variantRegistry.get("datetime.datetime")!;
  assert.equal(dt.baseType, "date"); assert.equal(dt.renderer, "datetime"); assert.equal(dt.responseModel, "text");
  const du = variantRegistry.get("numeric.duration")!;
  assert.equal(du.baseType, "numeric"); assert.equal(du.renderer, "duration"); assert.equal(du.responseModel, "numeric");
  assert.ok(isSelectableVariant(dt) && isSelectableVariant(du));
  assert.equal(variantForActionType("datetime"), "datetime.datetime");
  assert.equal(variantForActionType("date time"), "datetime.datetime");
  assert.equal(variantForActionType("duration"), "numeric.duration");
});

test("QT-12: duration text and parts", () => {
  assert.equal(parseDuration("5400"), 5400);
  assert.equal(parseDuration("1:30:00"), 5400);
  assert.equal(parseDuration("90:15"), 5415);
  assert.equal(parseDuration("1h 30m"), 5400);
  assert.equal(parseDuration("1h30m15s"), 5415);
  assert.equal(parseDuration("2 hours, 5 minutes"), 7500);
  assert.equal(parseDuration("45 s"), 45);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("1:75"), null);
  assert.equal(parseDuration(""), null);
  assert.deepEqual(splitDuration(5415), { h: 1, m: 30, s: 15 });
  assert.deepEqual(splitDuration(5415, "ms"), { h: 0, m: 90, s: 15 });
  assert.deepEqual(splitDuration(5430, "hm"), { h: 1, m: 31, s: 0 });
  assert.equal(splitDuration(-1), null);
  assert.equal(joinDuration(1, 30, 15), 5415);
  assert.equal(joinDuration(null, null, null), null);
  assert.equal(formatDuration(5400), "1 h 30 min");
  assert.equal(formatDuration(45), "45 s");
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(0, "hm"), "0 min");
});

test("QT-12: a local date-time is parsed as a wall clock and only when it is real", () => {
  assert.deepEqual(parseLocalDateTime("2026-10-16T09:30"), { date: "2026-10-16", time: "09:30", ms: Date.UTC(2026, 9, 16, 9, 30) });
  assert.equal(parseLocalDateTime("2026-10-16T09:30:15")?.time, "09:30:15");
  for (const bad of ["2026-10-16", "09:30", "2026-02-30T10:00", "2026-10-16T25:00", "2026-10-16 09:30", null]) assert.equal(parseLocalDateTime(bad), null, String(bad));
  assert.equal(formatDateTimeAs("2026-10-16T21:05", "DD/MM/YYYY", { hour12: true }), "16/10/2026 09:05 PM");
});

test("QT-12: a Date & Time answer is checked whole, against bounds that may carry a time", () => {
  const r = run(empty(), [{ op: "create_block", title: "B" }, { op: "create_question", ref: "WHEN", type: "datetime", text: "When did it happen?" }]);
  assert.equal(r.results[1].ok, true);
  const q = byRef(r.def, "WHEN");
  assert.equal(q.type, "date"); assert.equal(q.variant, "datetime.datetime");
  assert.deepEqual(errorsOf(r.def, q, "2026-10-16"), ["Please enter a date and a time."]);
  assert.deepEqual(errorsOf(r.def, q, "2026-10-16T09:30"), []);
  q.settings.minDate = "2026-10-16T10:00";
  q.settings.maxDate = "2026-10-20";
  assert.equal(errorsOf(r.def, q, "2026-10-16T09:30").length, 1);
  assert.match(errorsOf(r.def, q, "2026-10-16T09:30")[0], /2026-10-16 10:00/);
  assert.deepEqual(errorsOf(r.def, q, "2026-10-16T10:00"), []);
  // a bare-day upper bound covers the whole day
  assert.deepEqual(errorsOf(r.def, q, "2026-10-20T23:59"), []);
  assert.equal(errorsOf(r.def, q, "2026-10-21T00:00").length, 1);
  assert.match(errorsOf(r.def, q, "2026-10-21T00:00")[0], /2026-10-20/);
  // the rule kinds too
  q.settings.minDate = undefined; q.settings.maxDate = undefined;
  q.validation = [{ id: "v1", kind: "date_min", value: "2026-10-16T12:00" }, { id: "v2", kind: "date_max", value: "2026-10-31" }] as never;
  assert.deepEqual(errorsOf(r.def, q, "2026-10-16T11:59"), ["Please choose a date on or after 2026-10-16 12:00."]);
  assert.deepEqual(errorsOf(r.def, q, "2026-10-31T18:00"), []);
  assert.deepEqual(errorsOf(r.def, q, "2026-11-01T00:00"), ["Please choose a date on or before 2026-10-31."]);
});

test("QT-12: a plain date question keeps its exact behaviour", () => {
  const r = run(empty(), [{ op: "create_block", title: "B" }, { op: "create_question", ref: "D", type: "date", text: "Date?" }]);
  const q = byRef(r.def, "D");
  q.settings.minDate = "2026-01-01"; q.settings.maxDate = "2026-12-31";
  assert.deepEqual(errorsOf(r.def, q, "2026-12-31"), []);
  assert.deepEqual(errorsOf(r.def, q, "2026-01-01"), []);
  assert.equal(errorsOf(r.def, q, "2027-01-01").length, 1);
  assert.equal(errorsOf(r.def, q, "2025-12-31").length, 1);
});

test("QT-12: switching a date to Date & Time keeps its date bounds", () => {
  const r = run(empty(), [{ op: "create_block", title: "B" }, { op: "create_question", ref: "D", type: "date", text: "Date?" }]);
  const q = byRef(r.def, "D");
  q.validation = [{ id: "v1", kind: "date_min", value: "2026-01-01" }] as never;
  const m = migrateQuestionType(q, variantRegistry.get("datetime.datetime")!);
  assert.deepEqual(m.q.validation.map((v) => v.kind), ["date_min"]);
});

test("QT-12: a Duration stores seconds and says its bounds in hours and minutes", () => {
  const r = run(empty(), [
    { op: "create_block", title: "B" },
    { op: "create_question", ref: "TV", type: "duration", text: "How long did you watch yesterday?", validation: [{ kind: "max_value", value: 43200 }] },
  ]);
  assert.equal(r.results[1].ok, true);
  const q = byRef(r.def, "TV");
  assert.equal(q.type, "numeric"); assert.equal(q.variant, "numeric.duration");
  assert.equal(q.settings.minValue, 0);
  assert.equal(q.settings.durationParts, "hms");
  assert.deepEqual(errorsOf(r.def, q, 5400), []);
  const over = errorsOf(r.def, q, 50000);
  assert.ok(over.includes("Value must be at most 12 h."), over.join(" | "));
  assert.ok(over.some((m) => /12 h/.test(m) && !/43200/.test(m)), "the settings bound is in hours too");
  q.validation = [{ id: "v1", kind: "min_value", value: 5400 }] as never;
  assert.deepEqual(errorsOf(r.def, q, 600), ["Value must be at least 1 h 30 min."]);
  assert.ok(errorsOf(r.def, q, -5).length >= 1, "never negative");
});

/* ------------------------------------------------------------------- AI-09 */

test("AI-09: a 4-row grid planned as one score is a warning that says what to do", () => {
  const r = run(empty(), [
    { op: "set_research", hypotheses: ["H1: Ad recall increases consideration"] },
    { op: "create_block", title: "B" },
    { op: "create_question", ref: "AD_RECALL", type: "yes_no", text: "Seen ads?" },
    { op: "create_question", ref: "CONSIDER", type: "matrix", text: "Consider?", rows: ["Brand A", "Brand B", "Brand C", "Brand D"], scale: { points: 5 } },
    { op: "create_question", ref: "ONE", type: "matrix", text: "One row", rows: ["Only"], scale: { points: 5 } },
    { op: "add_analysis_test", method: "t_test", outcome: "CONSIDER", groupBy: "AD_RECALL" },
    { op: "add_analysis_test", method: "chi_square", outcome: "CONSIDER", variables: ["AD_RECALL"] },
    { op: "add_analysis_test", method: "t_test", outcome: "ONE", groupBy: "AD_RECALL" },
    { op: "add_analysis_test", method: "reliability", variables: ["CONSIDER"] },
  ]);
  const code = byRef(r.def, "CONSIDER").code;
  const grid = reviewAnalysisPlan(r.def).filter((i) => /-row grid/.test(i.message));
  assert.deepEqual(grid.map((i) => i.message), [
    `${code} is a 4-row grid; a t-test needs one score — pick a row or build an index.`,
    `${code} is a 4-row grid; a chi-square needs one variable — pick a row or build an index.`,
  ]);
  assert.ok(grid.every((i) => i.level === "warning" && i.questionIds[0] === byRef(r.def, "CONSIDER").id));
});
