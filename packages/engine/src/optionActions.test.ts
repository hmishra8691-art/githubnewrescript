import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type FlowNode } from "@rescript/schema";
import { applyOptionAction, coerceOptionAction, describeOptionAction, isOptionOp, resolveOption, OPTION_ACTION_OPS, type OptionAction, type OptionEnv } from "./optionActions.js";
import { parseLogicExpression } from "./logicExpression.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { listPages } from "./blocks.js";
import { embeddedFieldNames } from "./structureOps.js";

/*
 * THE OPTION, ORDER AND HOUSEKEEPING ACTIONS (Intelligent Mode Phase 2):
 * every op's happy path and every refusal, applied directly through the
 * module's own gate and apply — the way surveyActions will call them once
 * the module is wired in.
 */

const rule = (ref: string, operator: string, value: unknown): Condition => ({ type: "rule", source: { kind: "question", ref }, operator, value } as Condition);
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Brand tracker", description: "Wave 3" },
    questions: [
      { id: "q1", code: "S1", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other"), analysis: { hypotheses: ["H1", "H3"] } },
      { id: "q2", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Brands used", options: [...opts("Brand A", "Brand B", "Brand C"), { code: 99, label: "None of these", flags: ["exclusive", "anchor_bottom"] }] },
      { id: "q3", code: "Q7", variableName: "COUNTRY", type: "single_select", text: "Country", options: [...opts("Canada", "United States", "Mexico"), { code: 4, label: "Other (please specify)", flags: ["other_specify", "anchor_bottom"] }], displayLogic: { type: "rule", source: { kind: "embedded", ref: "country" }, operator: "eq", value: "NA" } },
      { id: "q4", code: "Q8", variableName: "FAV", type: "single_select", text: "In {{country}}, which brand do you prefer?", options: opts("Brand A", "Brand B", "Brand C"), displayLogic: rule("q3", "eq", 2), customJs: "console.log(1)" },
      { id: "q5", code: "Q9", variableName: "LATER", type: "single_select", text: "Later", options: opts("Yes", "No") },
    ],
    flow: [
      { type: "embedded_data", id: "ed", fields: [{ name: "country", source: "url" }, { name: "source", source: "static", value: "panel" }] },
      { type: "block", id: "b1", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", questionIds: ["q3", "q4"] }] },
      { type: "block", id: "b3", title: "Later", children: [{ type: "page", id: "p3", questionIds: ["q5"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    quotas: [{ id: "qt1", name: "Country", cells: [{ id: "c1", label: "US + MX", when: rule("Q7", "in", [2, 3]), limit: 100 }, { id: "c2", label: "Canada", when: rule("COUNTRY", "eq", 1), limit: 50 }] }],
    research: {
      hypotheses: ["Women use more brands", "Americans prefer Brand A", "Canadians prefer Brand C"],
      analysisPlan: { crosstabs: [{ id: "x1", rows: ["BRANDS"], columns: ["GENDER"], hypotheses: ["H1"] }, { id: "x2", rows: ["FAV"], columns: ["COUNTRY"], hypotheses: ["H2", "H3"] }], tests: [{ id: "t1", method: "chi_square", variables: ["FAV", "COUNTRY"], hypotheses: ["H2"] }] },
    },
    deployment: { clientSlug: "c", studySlug: "s" },
  });
}

let n = 0;
const env = (def: SurveyDefinition): OptionEnv => ({
  question: (r) => getQuestionByCodeOrVar(def, r),
  condition: (c) => { if (typeof c !== "string") return c; const r = parseLogicExpression(def, c); if (r.errors.length || !r.condition) throw new Error(`the condition “${c}” does not parse: ${r.errors[0]?.message ?? "empty"}`); return r.condition; },
  ids: (p) => `${p}_${++n}`,
  now: "2026-10-05T00:00:00Z",
});
const gate = (raw: Record<string, unknown>): OptionAction => { const a = coerceOptionAction(String(raw.op), raw); if (typeof a === "string" || a === null) throw new Error(`refused at the gate: ${a}`); return a; };
const run = (def: SurveyDefinition, raw: Record<string, unknown>) => applyOptionAction(def, gate(raw), env(def));
const refuse = (def: SurveyDefinition, raw: Record<string, unknown>): string => { try { run(def, raw); } catch (e) { return (e as Error).message; } throw new Error(`expected a refusal of ${raw.op}`); };
const q = (def: SurveyDefinition, code: string) => def.questions.find((x) => x.code === code)!;
const codes = (def: SurveyDefinition, code: string) => q(def, code).options.map((o) => o.code);
const page = (def: SurveyDefinition, id: string) => listPages(def.flow as unknown[]).find((p) => p.node.id === id)!.node.questionIds;

test("the vocabulary: every op is one of ours, nothing else is, and the gate reads known fields only", () => {
  for (const op of OPTION_ACTION_OPS) assert.ok(isOptionOp(op));
  assert.equal(isOptionOp("update_question"), false);
  assert.equal(coerceOptionAction("update_question", {}), null, "not ours → null, so the caller tries the next module");
  assert.equal(coerceOptionAction("update_option", { target: "Q7" }), "update_option needs target and option");
  assert.equal(coerceOptionAction("update_option", { target: "Q7", option: 2 }), "update_option changes nothing");
  assert.equal(coerceOptionAction("update_option", { target: "Q7", option: 2, anchor: "middle" }), "anchor is top, bottom or none — not “middle”");
  assert.equal(coerceOptionAction("reorder_options", { target: "Q7" }), "reorder_options needs order (the options, first to last) or sort (alphabetical, alphabetical_desc, numeric, reverse)");
  assert.equal(coerceOptionAction("reorder_options", { target: "Q7", sort: "random" }), "“random” is not an order the options can take (alphabetical, alphabetical_desc, numeric, reverse)");
  assert.equal(coerceOptionAction("set_mask", { target: "Q8" }), "set_mask needs target and expression (a SET expression such as “Q5.Selected” or “Q5.Selected EXCEPT Q6.Selected”)");
  assert.equal(coerceOptionAction("set_survey_settings", { title: "   " }), "the survey title cannot be empty");
  assert.equal(coerceOptionAction("set_survey_settings", {}), "set_survey_settings changes nothing (title, description, code)");
  assert.equal(coerceOptionAction("set_custom_code", { target: "Q8" }), "set_custom_code needs js or css (null removes it)");
  assert.equal(coerceOptionAction("remove_hypothesis", {}), "remove_hypothesis needs the hypothesis (its text, its label such as H2, or its number)");
  const a = coerceOptionAction("update_option", { target: " Q7 ", option: "United States", label: " USA ", exclusive: true, bogus: 1, position: { after: 3 } }) as OptionAction;
  assert.deepEqual(a, { op: "update_option", target: "Q7", option: "United States", label: "USA", exclusive: true, position: { after: 3 } }, "trimmed, bounded, nothing extra carried");
  assert.equal(describeOptionAction(a), "Change option United States of Q7");
  assert.equal(describeOptionAction({ op: "update_embedded", name: "country", newName: "cc" }), "Rename embedded variable country to cc");
});

test("the gate's edges: a boolean anchor is bottom or none, a position below 1 or fractional is refused, a pick below 1 or fractional is refused", () => {
  assert.deepEqual(coerceOptionAction("update_option", { target: "Q7", option: 2, anchored: true }), { op: "update_option", target: "Q7", option: 2, anchor: "bottom" }, "anchored: true means the bottom — where a None goes");
  assert.deepEqual(coerceOptionAction("update_option", { target: "Q7", option: 2, anchored: false }), { op: "update_option", target: "Q7", option: 2, anchor: "none" });
  assert.deepEqual(coerceOptionAction("update_option", { target: "Q7", option: 2, anchor: "last" }), { op: "update_option", target: "Q7", option: 2, anchor: "bottom" });
  assert.equal(coerceOptionAction("update_option", { target: "Q7", option: 2, position: 0 }), "position is a 1-based option number");
  assert.equal(coerceOptionAction("update_option", { target: "Q7", option: 2, position: -1 }), "position is a 1-based option number");
  assert.equal(coerceOptionAction("update_option", { target: "Q7", option: 2, position: 1.5 }), "position is a 1-based option number");
  assert.deepEqual(coerceOptionAction("update_option", { target: "Q7", option: 2, position: "3" }), { op: "update_option", target: "Q7", option: 2, position: 3 }, "a numeric string is a position");
  assert.equal(coerceOptionAction("set_option_randomization", { target: "Q5", pick: 0 }), "pick is a whole number of options to show");
  assert.equal(coerceOptionAction("set_option_randomization", { target: "Q5", pick: 2.5 }), "pick is a whole number of options to show");
  assert.deepEqual(coerceOptionAction("set_option_randomization", { target: "Q5", pick: 2 }), { op: "set_option_randomization", target: "Q5", enabled: true, pick: 2 });
});

test("an option by code, by label, by “option 3” / “#3” and by bare position — or a reason that lists the options", () => {
  const def = survey();
  const q7 = q(def, "Q7");
  assert.equal((resolveOption(q7, 2) as { label: string }).label, "United States", "by code");
  assert.equal((resolveOption(q7, "united states") as { label: string }).label, "United States", "by label, case ignored");
  assert.equal((resolveOption(q7, "option 3") as { label: string }).label, "Mexico");
  assert.equal((resolveOption(q7, "#1") as { label: string }).label, "Canada");
  assert.equal((resolveOption(q7, "other") as { label: string }).label, "Other (please specify)", "“other” finds the specify option");
  assert.equal((resolveOption(q7, "United") as { label: string }).label, "United States", "a unique part of a label");
  const q5 = q(def, "Q5");
  q5.options.push({ code: 7, label: "Seventh", flags: [] } as never);
  assert.equal((resolveOption(q5, 5) as { label: string }).label, "Seventh", "a bare number nothing has as a code is the Nth option");
  assert.equal(resolveOption(q7, "France"), "Q7: there is no option “France” — the options are 1 = Canada, 2 = United States, 3 = Mexico, 4 = Other (please specify)");
  assert.equal(resolveOption(q7, "a"), "Q7: there is no option “a” — the options are 1 = Canada, 2 = United States, 3 = Mexico, 4 = Other (please specify)", "too short to be a part of a label");
});

test("update_option: label, exclusive, anchor and a display condition in one action — each change named", () => {
  const def = survey();
  const r = run(def, { op: "update_option", target: "Q7", option: 2, label: "USA", exclusive: true, anchor: "top", visibleIf: "GENDER = 1" });
  assert.equal(r.description, "Q7 option 2 “United States”: label → “USA”, exclusive, anchored at the top, shown only when S1 = 1");
  assert.equal(r.destructive, undefined, "nothing was replaced");
  const o = q(def, "Q7").options[1];
  assert.equal(o.label, "USA");
  assert.deepEqual(o.flags, ["exclusive", "anchor_top"]);
  assert.deepEqual(o.visibleIf, rule("q1", "eq", 1));
  assert.deepEqual(r.touched, ["q3"]);
  /* replacing the condition is destructive; removing it too; nothing to change is refused */
  const r2 = run(def, { op: "update_option", target: "Q7", option: "USA", visibleIf: null });
  assert.equal(r2.destructive, "removes the display condition of Q7 option 2 “USA” (S1 = 1)");
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: "USA", label: "USA" }), "nothing to change on Q7 option 2 “USA”");
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: "France", label: "X" }), "Q7: there is no option “France” — the options are 1 = Canada, 2 = USA, 3 = Mexico, 4 = Other (please specify)");
  assert.equal(refuse(def, { op: "update_option", target: "Q99", option: 1, label: "X" }), "there is no question “Q99”");
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: 1, visibleIf: "NOPE = 1" }).startsWith("the condition “NOPE = 1” does not parse"), true);
});

test("update_option: the specify box, the export value (set and cleared), a replaced display condition is destructive", () => {
  const def = survey();
  const r = run(def, { op: "update_option", target: "Q7", option: "Mexico", other: true, value: 10 });
  assert.equal(r.description, "Q7 option 3 “Mexico”: export value → 10, with a specify box");
  const o = q(def, "Q7").options[2];
  assert.deepEqual(o.flags, ["other_specify"], "the flag is written, not only described");
  assert.equal(o.value, 10);
  const r2 = run(def, { op: "update_option", target: "Q7", option: "Mexico", other: false, value: null });
  assert.equal(r2.description, "Q7 option 3 “Mexico”: export value cleared, no specify box");
  assert.deepEqual(o.flags, []);
  assert.equal(o.value, undefined, "the export value is removed from the option");
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: "Mexico", other: false, value: null }), "nothing to change on Q7 option 3 “Mexico”", "clearing what is not there changes nothing");
  /* replacing a display condition says what it replaced */
  run(def, { op: "update_option", target: "Q7", option: 2, visibleIf: "GENDER = 1" });
  const r3 = run(def, { op: "update_option", target: "Q7", option: 2, visibleIf: "GENDER = 2" });
  assert.equal(r3.description, "Q7 option 2 “United States”: shown only when S1 = 2");
  assert.equal(r3.destructive, "replaces the display condition of Q7 option 2 “United States” (was S1 = 1)");
  assert.deepEqual(q(def, "Q7").options[1].visibleIf, rule("q1", "eq", 2));
});

test("update_option position: a number, before, after — and never relative to itself", () => {
  const def = survey();
  assert.equal(run(def, { op: "update_option", target: "Q7", option: "Mexico", position: 1 }).description, "Q7 option 3 “Mexico”: moved to position 1");
  assert.deepEqual(codes(def, "Q7"), [3, 1, 2, 4]);
  assert.equal(run(def, { op: "update_option", target: "Q7", option: "Mexico", position: { after: "United States" } }).description, "Q7 option 3 “Mexico”: moved to position 3");
  assert.deepEqual(codes(def, "Q7"), [1, 2, 3, 4]);
  run(def, { op: "update_option", target: "Q7", option: 1, position: { before: 3 } });
  assert.deepEqual(codes(def, "Q7"), [2, 1, 3, 4]);
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: 1, position: { after: 1 } }), "an option cannot be placed before or after itself");
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: 1, position: 2 }), "nothing to change on Q7 option 1 “Canada”", "already there");
  // a position past the end is the end — said as the real position, not the one asked for
  assert.equal(run(def, { op: "update_option", target: "Q7", option: 2, position: 99 }).description, "Q7 option 2 “United States”: moved to position 4");
  assert.deepEqual(codes(def, "Q7"), [1, 3, 4, 2]);
  assert.equal(q(def, "Q7").options.length, 4, "no hole, no duplicate");
});

test("recoding follows the question's own code lists and every shape of rule: punch codes, randomization groups, a ranking's code (not its rank), a between's second value, a COUNT where over its options, a rule naming it by variable", () => {
  const def = survey();
  const q7 = q(def, "Q7");
  (q7 as { punches?: unknown[] }).punches = [{ id: "p1", source: { kind: "codes", codes: [2, 3] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always" }];
  q7.randomization = { enabled: true, scope: "options", method: "shuffle", groups: [[1, 2], [3, 4]] } as never;
  q(def, "Q9").displayLogic = { type: "group", op: "and", children: [
    { type: "rule", source: { kind: "question", ref: "q3" }, operator: "rankEquals", value: 2, value2: 2 },
    { type: "rule", source: { kind: "question", ref: "q3" }, operator: "between", value: 1, value2: 2 },
    { type: "rule", source: { kind: "question", ref: "q3", count: { of: "matching", scope: "options", where: { type: "rule", source: { kind: "option", ref: "code" }, operator: "in", value: [2, 3] } } }, operator: "gte", value: 1 },
  ] } as never;
  const r = run(def, { op: "update_option", target: "Q7", option: "United States", code: 5 });
  assert.equal(r.destructive, "recodes option “United States” of Q7 from 2 to 5 — 3 conditions updated", "Q8's display logic, Q9's (one root, three rules) and the quota cell");
  assert.deepEqual((q7 as { punches: { source: { codes: number[] } }[] }).punches[0].source.codes, [5, 3], "the punch rule codes the new code");
  assert.deepEqual((q7.randomization as { groups?: unknown }).groups, [[1, 5], [3, 4]], "the randomization group holds the new code");
  const [rank, between, count] = (q(def, "Q9").displayLogic as { children: { value: unknown; value2?: unknown; source: { count?: { where: { value: unknown } } } }[] }).children;
  assert.deepEqual([rank.value, rank.value2], [5, 2], "a ranking compares a code and a rank: only the code moves");
  assert.deepEqual([between.value, between.value2], [1, 5], "a between's second bound is a code too");
  assert.deepEqual(count.source.count!.where.value, [5, 3], "the COUNT's where compares this question's option codes");
  // a rule naming the question by its variable follows too
  run(def, { op: "update_option", target: "Q7", option: "Canada", code: 7 });
  assert.deepEqual(def.quotas[0].cells[1].when, rule("COUNTRY", "eq", 7));
});

test("recoding an option rewrites every condition that compared the question with the old code — a display condition elsewhere and a quota cell — and says so as destructive", () => {
  const def = survey();
  const r = run(def, { op: "update_option", target: "Q7", option: "United States", code: 5 });
  assert.equal(r.description, "Q7 option 2 “United States”: code 2 → 5");
  assert.equal(r.destructive, "recodes option “United States” of Q7 from 2 to 5 — 2 conditions updated");
  assert.deepEqual(codes(def, "Q7"), [1, 5, 3, 4]);
  assert.deepEqual(q(def, "Q8").displayLogic, rule("q3", "eq", 5), "the display condition that named the question by id");
  assert.deepEqual(def.quotas[0].cells[0].when, rule("Q7", "in", [5, 3]), "the quota cell that named it by code, inside a list");
  assert.deepEqual(def.quotas[0].cells[1].when, rule("COUNTRY", "eq", 1), "a cell comparing another code is untouched");
  /* a code another option has is refused; a string code on a numeric list is stored as a number */
  assert.equal(refuse(def, { op: "update_option", target: "Q7", option: 1, code: 3 }), "Q7 already has an option with code 3 (“Mexico”)");
  run(def, { op: "update_option", target: "Q7", option: "Mexico", code: "6" });
  assert.deepEqual(codes(def, "Q7"), [1, 5, 6, 4]);
  assert.deepEqual(def.quotas[0].cells[0].when, rule("Q7", "in", [5, 6]));
});

test("reorder_options: an explicit order (partial — the rest keep their order), a sort — and the anchored “None” stays at the bottom either way", () => {
  const def = survey();
  const r = run(def, { op: "reorder_options", target: "Q5", order: ["Brand C", 1] });
  assert.equal(r.description, "Q5 options reordered: “Brand C”, “Brand A”, “Brand B”; “None of these” stays at the bottom");
  assert.deepEqual(codes(def, "Q5"), [3, 1, 2, 99]);
  const r2 = run(def, { op: "reorder_options", target: "Q5", sort: "alphabetical" });
  assert.equal(r2.description, "Q5 options A→Z: “Brand A”, “Brand B”, “Brand C”; “None of these” stays at the bottom");
  assert.deepEqual(codes(def, "Q5"), [1, 2, 3, 99]);
  assert.equal(refuse(def, { op: "reorder_options", target: "Q5", sort: "alphabetical" }), "the options of Q5 are already in that order");
  run(def, { op: "reorder_options", target: "Q5", sort: "reverse" });
  assert.deepEqual(codes(def, "Q5"), [3, 2, 1, 99], "reversed, None still last");
  const r3 = run(def, { op: "reorder_options", target: "Q5", order: [99, "Brand A"] });
  assert.deepEqual(codes(def, "Q5"), [1, 3, 2, 99], "asking to put None first does not move it…");
  assert.deepEqual(r3.warnings, ["“None of these” is anchored and keeps its place — change the anchor first to move it."], "…and says why");
  assert.equal(refuse(def, { op: "reorder_options", target: "Q5", order: ["Brand Z"] }), "Q5: there is no option “Brand Z” — the options are 1 = Brand A, 3 = Brand C, 2 = Brand B, 99 = None of these");
  assert.equal(refuse(def, { op: "reorder_options", target: "S1", sort: "numeric" }), "the options of S1 are already in that order");
});

test("reorder_options: Z→A, a numeric sort that falls back to the label for codes that are not numbers, an order naming an option twice, and an option anchored at both ends", () => {
  const def = survey();
  const r = run(def, { op: "reorder_options", target: "Q5", sort: "alphabetical_desc" });
  assert.equal(r.description, "Q5 options Z→A: “Brand C”, “Brand B”, “Brand A”; “None of these” stays at the bottom");
  assert.deepEqual(codes(def, "Q5"), [3, 2, 1, 99]);
  // the same option twice in the order is placed once
  run(def, { op: "reorder_options", target: "Q5", order: ["Brand A", 1, "Brand C", "Brand A"] });
  assert.deepEqual(codes(def, "Q5"), [1, 3, 2, 99]);
  assert.equal(q(def, "Q5").options.length, 4, "no option is duplicated");
  // numeric: codes that are numbers first, in order; the rest alphabetically
  q(def, "Q9").options = [{ code: "x", label: "Zeta", flags: [] }, { code: "y", label: "Alpha", flags: [] }, { code: 5, label: "Mid", flags: [] }] as never;
  assert.equal(run(def, { op: "reorder_options", target: "Q9", sort: "numeric" }).description, "Q9 options by code: “Mid”, “Alpha”, “Zeta”");
  assert.deepEqual(codes(def, "Q9"), [5, "y", "x"]);
  // an option flagged at both ends (a stored survey can hold that) counts as top — and appears once
  const def2 = survey();
  q(def2, "Q5").options[3].flags = ["exclusive", "anchor_bottom", "anchor_top"] as never;
  const r2 = run(def2, { op: "reorder_options", target: "Q5", sort: "reverse" });
  assert.deepEqual(codes(def2, "Q5"), [99, 3, 2, 1]);
  assert.equal(r2.description, "Q5 options reversed: “Brand C”, “Brand B”, “Brand A”; “None of these” stays at the top");
});

test("set_option_randomization on a matrix randomizes its rows unless told otherwise", () => {
  const def = survey();
  def.questions.push({ id: "q6", code: "M1", variableName: "GRID", type: "matrix_single", text: "Grid", rows: [{ code: "r1", label: "Row 1", flags: [] }, { code: "r2", label: "Row 2", flags: [] }], options: opts("A", "B"), columns: [], validation: [], required: false, settings: {}, skipLogic: [], listLogic: [], optionPipeline: [], punches: [] } as never);
  const r = run(def, { op: "set_option_randomization", target: "M1", enabled: true, keepLast: ["Row 1"] });
  assert.equal(r.description, "M1 rows randomized; “Row 1” stays last");
  assert.equal(q(def, "M1").randomization!.scope, "rows");
  assert.deepEqual(q(def, "M1").rows.map((x) => x.code), ["r2", "r1"]);
  const r2 = run(def, { op: "set_option_randomization", target: "M1", enabled: true, scope: "options" });
  assert.equal(r2.description, "M1 options randomized");
  assert.equal(q(def, "M1").randomization!.scope, "options");
});

test("set_option_randomization: keepLast flags the option and moves it to the end; anchors at an edge are kept there; one in the middle is refused; pick must leave something out", () => {
  const def = survey();
  const r = run(def, { op: "set_option_randomization", target: "Q7", enabled: true, keepLast: ["Canada"], pick: 3 });
  assert.equal(r.description, "Q7 options randomized — each respondent sees 3 of 4; “Canada” stays last");
  assert.deepEqual(codes(def, "Q7"), [2, 3, 4, 1], "Canada moved to the end, after the already-anchored Other");
  assert.deepEqual(q(def, "Q7").options[3].flags, ["anchor_bottom"]);
  assert.deepEqual(q(def, "Q7").randomization, { enabled: true, scope: "options", method: "shuffle", pick: 3 });
  /* anchors without a side: last → bottom, first → top, middle → refused */
  const def2 = survey();
  const r2 = run(def2, { op: "set_option_randomization", target: "Q5", anchors: ["Brand A", "None of these"] });
  assert.equal(r2.description, "Q5 options randomized; “Brand A” stays first, “None of these” stays last");
  assert.deepEqual(q(def2, "Q5").options.map((o) => [o.code, ...o.flags]), [[1, "anchor_top"], [2], [3], [99, "exclusive", "anchor_bottom"]]);
  assert.equal(refuse(def2, { op: "set_option_randomization", target: "Q5", anchors: ["Brand B"] }), "“Brand B” is in the middle of Q5's options — say whether it should stay at the top (keepFirst) or the bottom (keepLast)");
  assert.equal(refuse(def2, { op: "set_option_randomization", target: "Q5", pick: 4 }), "pick 4 is not fewer than the 4 options of Q5 — there would be nothing to leave out");
  assert.equal(refuse(def2, { op: "set_option_randomization", target: "Q5", keepFirst: ["Brand B"], keepLast: ["Brand B"] }), "“Brand B” cannot stay both first and last");
  const off = run(def2, { op: "set_option_randomization", target: "Q5", enabled: false });
  assert.equal(off.description, "Q5 options not randomized");
  assert.equal(q(def2, "Q5").randomization?.enabled, false);
});

test("set_mask: a SET expression on an earlier question becomes the mask; a source asked at or after the target is refused; clear_mask is destructive", () => {
  const def = survey();
  const r = run(def, { op: "set_mask", target: "Q8", expression: "Q5.Selected" });
  assert.equal(r.description, "Show at Q8 only the options Q5.Selected");
  const mask = q(def, "Q8").mask!;
  assert.equal(mask.action, "display"); assert.equal(mask.keepAlwaysShow, true);
  assert.deepEqual(mask.expr, { kind: "ref", questionId: "q2", selection: "selected" });
  const r2 = run(def, { op: "set_mask", target: "Q8", expression: "Q5.Selected EXCEPT Q7.Selected", action: "preselect" });
  assert.equal(r2.destructive, "Replaces the mask of Q8 (was Q5.Selected)");
  assert.equal(q(def, "Q8").mask!.action, "preselect");
  assert.equal(refuse(def, { op: "set_mask", target: "Q8", expression: "Q9.Selected" }), "Q9 is asked after Q8, so its answer is not known when Q8's options are chosen — move Q8 after Q9, or mask it by an earlier question");
  assert.equal(refuse(def, { op: "set_mask", target: "Q8", expression: "Q8.Selected" }), "Q8 cannot be masked by its own answer");
  assert.ok(refuse(def, { op: "set_mask", target: "Q8", expression: "Q5 +++ Q7" }).startsWith("the set expression “Q5 +++ Q7” does not parse"));
  assert.equal(refuse(def, { op: "set_mask", target: "Q8", expression: "Q5.Selected", dimension: "rows" }), "Q8 has no rows to mask");
  const c = run(def, { op: "clear_mask", target: "Q8" });
  assert.equal(c.description, "Removed the mask of Q8");
  assert.equal(c.destructive, "Removes the mask of Q8 (Preselect at Q8 the options Q5.Selected DIFFERENCE Q7.Selected)");
  assert.equal(q(def, "Q8").mask, undefined);
  assert.equal(refuse(def, { op: "clear_mask", target: "Q8" }), "Q8 has no mask to remove");
});

test("duplicate_question: the copy right after the original, or after a named question — new code, new ids", () => {
  const def = survey();
  const r = run(def, { op: "duplicate_question", target: "Q7" });
  assert.equal(r.description, "Duplicated Q7 as Q7_COPY");
  assert.deepEqual(page(def, "p2"), ["q3", r.touched[1], "q4"]);
  const copy = def.questions.find((x) => x.id === r.touched[1])!;
  assert.equal(copy.variableName, "COUNTRY_COPY");
  assert.equal(copy.options.length, 4);
  const r2 = run(def, { op: "duplicate_question", target: "Q5", after: "Q8" });
  assert.equal(r2.description, "Duplicated Q5 as Q5_COPY after Q8");
  assert.deepEqual(page(def, "p1"), ["q1", "q2"]);
  assert.deepEqual(page(def, "p2"), ["q3", r.touched[1], "q4", r2.touched[1]]);
  assert.equal(refuse(def, { op: "duplicate_question", target: "Q77" }), "there is no question “Q77”");
});

test("set_survey_settings writes meta; an empty title is refused; nothing changed is refused", () => {
  const def = survey();
  const r = run(def, { op: "set_survey_settings", title: "Brand tracker W4", description: null, code: "BT_W4" });
  assert.equal(r.description, "Survey settings: title “Brand tracker W4”, no description, code BT_W4");
  assert.equal(def.meta.title, "Brand tracker W4"); assert.equal(def.meta.description, undefined); assert.equal(def.meta.code, "BT_W4");
  assert.equal(refuse(def, { op: "set_survey_settings", code: "BT_W4" }), "the survey settings are already as asked");
  assert.equal(refuse(def, { op: "set_survey_settings", code: "bad code!" }), "“bad code!” is not a survey code — letters, digits, underscores and dashes");
  assert.throws(() => applyOptionAction(def, { op: "set_survey_settings", title: "  " }, env(def)), /the survey title cannot be empty/, "refused in the apply too, for an action built without the gate");
});

test("update_embedded: renaming rewrites the condition and the pipe that read it (destructive), refuses a taken name; source, value and type change in place", () => {
  const def = survey();
  const r = run(def, { op: "update_embedded", name: "country", newName: "cc", dataType: "string" });
  assert.equal(r.description, "Embedded variable cc: renamed country → cc, type string");
  assert.equal(r.destructive, "renames embedded variable country to cc — 1 condition and 1 pipe rewritten; exports and anything outside the survey that read country by name do not follow");
  assert.deepEqual(embeddedFieldNames(def), ["cc", "source"]);
  assert.deepEqual(q(def, "Q7").displayLogic, { type: "rule", source: { kind: "embedded", ref: "cc" }, operator: "eq", value: "NA" });
  assert.equal(q(def, "Q8").text, "In {{cc}}, which brand do you prefer?");
  assert.equal(refuse(def, { op: "update_embedded", name: "cc", newName: "GENDER" }), "GENDER is already used by a question, a calculation or another embedded variable");
  assert.equal(refuse(def, { op: "update_embedded", name: "cc", newName: "source" }), "source is already used by a question, a calculation or another embedded variable");
  assert.equal(refuse(def, { op: "update_embedded", name: "cc", newName: "1bad" }), "1bad is not a valid variable name — letters, digits and underscores, not starting with a digit");
  assert.equal(refuse(def, { op: "update_embedded", name: "nope", newName: "x" }), "there is no embedded variable “nope” — the embedded variables are cc, source");
  const r2 = run(def, { op: "update_embedded", name: "source", source: "url", value: null });
  assert.equal(r2.description, "Embedded variable source: source url, no value");
  const node = (def.flow as FlowNode[])[0] as Extract<FlowNode, { type: "embedded_data" }>;
  assert.deepEqual(node.fields[1], { name: "source", source: "url" });
});

test("remove_embedded: refused while a condition or a pipe still reads it, naming where; force removes it and says what stops resolving", () => {
  const def = survey();
  assert.equal(refuse(def, { op: "remove_embedded", name: "country" }), "country is still read by 1 condition (Q7 display logic) and 1 text piping it — change those first, or say force to remove it anyway");
  const r = run(def, { op: "remove_embedded", name: "country", force: true });
  assert.equal(r.description, "Removed embedded variable country");
  assert.equal(r.destructive, "Removes embedded variable country (url) — 1 condition (Q7 display logic) and 1 text piping it will no longer resolve");
  assert.deepEqual(embeddedFieldNames(def), ["source"]);
  const r2 = run(def, { op: "remove_embedded", name: "source" });
  assert.equal(r2.destructive, "Removes embedded variable source (static = panel)");
  assert.equal(refuse(def, { op: "remove_embedded", name: "source" }), "there is no embedded variable “source”");
});

test("add_hypothesis appends (creating the research design when there is none); a duplicate is refused", () => {
  const def = survey();
  assert.equal(run(def, { op: "add_hypothesis", text: "Men prefer Brand B" }).description, "Hypothesis H4: Men prefer Brand B");
  assert.equal(def.research!.hypotheses.length, 4);
  assert.equal(def.research!.updatedAt, "2026-10-05T00:00:00Z");
  assert.equal(refuse(def, { op: "add_hypothesis", text: "men prefer brand b" }), "that is already hypothesis H4");
  const bare = survey(); delete (bare as { research?: unknown }).research;
  assert.equal(run(bare, { op: "add_hypothesis", text: "First" }).description, "Hypothesis H1: First");
  assert.deepEqual(bare.research!.hypotheses, ["First"]);
});

test("remove_hypothesis by label, number or text: the label is dropped from the questions' analysis and the plan, and later labels move down (H3 → H2)", () => {
  const def = survey();
  const r = run(def, { op: "remove_hypothesis", hypothesis: "H2" });
  assert.equal(r.description, "Removed hypothesis H2: Americans prefer Brand A — H3 becomes H2");
  assert.equal(r.destructive, "Removes hypothesis H2 “Americans prefer Brand A” — 2 references to it (the crosstab FAV by COUNTRY, the chi square) dropped; H3 becomes H2 everywhere");
  assert.deepEqual(def.research!.hypotheses, ["Women use more brands", "Canadians prefer Brand C"]);
  assert.deepEqual(q(def, "S1").analysis!.hypotheses, ["H1", "H2"], "H3 → H2 on the question");
  const plan = def.research!.analysisPlan!;
  assert.deepEqual(plan.crosstabs.map((x) => x.hypotheses), [["H1"], ["H2"]], "H2 dropped, H3 → H2");
  assert.deepEqual(plan.tests[0].hypotheses, []);
  assert.equal(run(def, { op: "remove_hypothesis", hypothesis: 2 }).description, "Removed hypothesis H2: Canadians prefer Brand C");
  assert.equal(refuse(def, { op: "remove_hypothesis", hypothesis: "H5" }), "there is no hypothesis H5 — the hypotheses are H1 “Women use more brands”");
  assert.equal(run(def, { op: "remove_hypothesis", hypothesis: "women use more brands" }).description, "Removed hypothesis H1: Women use more brands");
  assert.equal(refuse(def, { op: "remove_hypothesis", hypothesis: 1 }), "the research design has no hypotheses");
});

test("set_custom_code: new code is plain; replacing or removing existing code is destructive; nothing to change is refused", () => {
  const def = survey();
  const r = run(def, { op: "set_custom_code", target: "Q7", css: ".q7 { color: red }" });
  assert.equal(r.description, "Q7: custom CSS (18 characters)");
  assert.equal(r.destructive, undefined);
  assert.equal(q(def, "Q7").customCss, ".q7 { color: red }");
  const r2 = run(def, { op: "set_custom_code", target: "Q8", js: "console.log(2)", css: "" });
  assert.equal(r2.description, "Q8: custom JS (14 characters)", "an empty css string means remove — and there was none, so nothing is said about it");
  assert.equal(r2.destructive, "replaces the custom JS of Q8 (14 characters)");
  const r3 = run(def, { op: "set_custom_code", target: "Q8", js: null });
  assert.equal(r3.description, "Q8: custom JS removed");
  assert.equal(r3.destructive, "removes the custom JS of Q8 (14 characters)");
  assert.equal(q(def, "Q8").customJs, undefined);
  assert.equal(refuse(def, { op: "set_custom_code", target: "Q8", js: null }), "the custom code of Q8 is already as asked");
});
