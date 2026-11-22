import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { fromSource, sourceDiff, toSource } from "./surveySource.js";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";

const survey = () => SurveyDefinition.parse({
  meta: { id: "src", code: "SRC", title: "Source \"format\" test", version: "1.0" },
  questions: [
    { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?\nPlease answer honestly.", required: true, options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }], skipLogic: [{ id: "sk1", when: { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "n" }, target: { kind: "terminate", status: "screened" } }] },
    { id: "brand", code: "Q1", variableName: "BRAND", type: "multi_select", text: "Which brands?", options: [{ code: 1, label: "Alpha" }, { code: "2", label: "Beta, \"the\" brand" }, { code: 98, label: "None", flags: ["exclusive"] }], displayLogic: { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "y" } },
    { id: "rate", code: "Q2", variableName: "Q2", type: "matrix_single", text: "Rate each", rows: [{ code: "r1", label: "Alpha" }, { code: "r2", label: "Beta" }], options: [1, 2, 3].map((c) => ({ code: c, label: String(c) })) },
    { id: "why", code: "Q3", variableName: "Q3", type: "long_text", text: "Why?", settings: { minLength: 20 } },
  ],
  flow: [
    { type: "page", id: "p1", title: "Screener", questionIds: ["own"] },
    { type: "block", id: "b1", title: "Brands", children: [{ type: "page", id: "p2", questionIds: ["brand"] }, { type: "loop", id: "l1", loopVar: "b", source: { kind: "question", questionId: "brand", filter: "selected" }, children: [{ type: "page", id: "p3", questionIds: ["rate"] }] }] },
    { type: "page", id: "p4", questionIds: ["why"] },
    { type: "end", id: "e", status: "complete" },
  ],
  quotas: [{ id: "qo", name: "Owners", targetTotal: 100, cells: [{ id: "c1", label: "Alpha buyers", when: { type: "rule", source: { kind: "question", ref: "brand" }, operator: "selected", value: 1 }, limit: 60, target: 50 }] }],
});
const same = (a: SurveyDefinition, b: SurveyDefinition | null) => assert.equal(JSON.stringify(b), JSON.stringify(SurveyDefinition.parse(a)));

test("round trip without loss: quotes and newlines in text, number and string codes, extras, loops, blocks, quotas", () => {
  const src = toSource(survey());
  const back = fromSource(src);
  assert.deepEqual(back.problems, []);
  same(survey(), back.def);
  /* the readable parts are readable */
  assert.match(src, /^question S1 single_select "Do you own a car\?\\nPlease answer honestly\."$/m);
  assert.match(src, /^  show if S1 = y$/m);
  assert.match(src, /^  skip sk1 to \{"kind":"terminate","status":"screened"\} if S1 = n$/m);
  assert.match(src, /^  option "2" "Beta, \\"the\\" brand"$/m, "a string code that looks like a number is quoted, so it reads back as a string");
  assert.match(src, /^  option 98 "None" \{"flags":\["exclusive"\]\}$/m);
  assert.match(src, /^    loop l1$/m);
  assert.match(src, /^      page p3: Q2$/m);
  assert.match(src, /^  cell c1 "Alpha buyers" limit 60 \{"target":50\} if /m);
  /* a number code and a string code that looks like a number stay what they were */
  const brand = back.def!.questions.find((q) => q.id === "brand") as unknown as { options: { code: unknown }[] };
  assert.deepEqual(brand.options.map((o) => o.code), [1, "2", 98]);
});

test("the source is the place to review a change: one edit, a few lines of diff", () => {
  const before = survey();
  const after = applySurveyActions(before, [{ op: "update_question", target: "Q3", text: "Why do you say that?" }, { op: "set_display_logic", target: "Q1", expression: "S1 = n" }] as unknown as SurveyAction[]).def;
  const d = sourceDiff(toSource(before), toSource(after));
  assert.match(d, /^- question Q3 long_text "Why\?"$/m);
  assert.match(d, /^\+ question Q3 long_text "Why do you say that\?"$/m);
  assert.match(d, /^- {3}show if S1 = y$/m);
  assert.match(d, /^\+ {3}show if S1 = n$/m);
  assert.ok(d.split("\n").filter((l) => /^[+-] /.test(l)).length <= 6, d);
  assert.equal(sourceDiff(toSource(before), toSource(before)), "");
});

test("an edited source reads back as the edited survey, and mistakes are named by line", () => {
  const src = toSource(survey()).replace('"Why?"', '"Why exactly?"').replace("show if S1 = y", "show if S1 = n");
  const r = fromSource(src);
  assert.equal(r.def!.questions.find((q) => q.id === "why")!.text, "Why exactly?");
  assert.equal(JSON.stringify((r.def!.questions.find((q) => q.id === "brand") as { displayLogic?: unknown }).displayLogic), JSON.stringify({ type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "n" }));
  const bad = fromSource(toSource(survey()).replace("show if S1 = y", "show if S9 = y"));
  assert.equal(bad.def, null);
  assert.ok(bad.problems.some((p) => p.line > 0 && /condition does not read/.test(p.message)), JSON.stringify(bad.problems));
  const junk = fromSource("survey \"x\"\nbanana split\n");
  assert.ok(junk.problems.some((p) => p.line === 2 && /does not start anything/.test(p.message)));
});

test("a condition that would not come back the same from text is written as JSON instead", () => {
  const def = survey();
  /* a group of one: the text "S1 = y" would read back as the bare rule, losing the group */
  (def.questions[3] as { displayLogic?: unknown }).displayLogic = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "y" }] };
  const src = toSource(SurveyDefinition.parse(def));
  assert.match(src, /^  show if json \{"type":"group"/m);
  same(def, fromSource(src).def);
});
