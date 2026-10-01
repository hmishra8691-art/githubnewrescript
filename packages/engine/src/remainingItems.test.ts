import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition } from "@rescript/schema";
import {
  createResponseState, effectiveQuestion, normalizeExpression, safeExpression, resolvePiping,
  questionMediaList, resolveQuestionMedia, displayedListCanVary, compileUxCss, uxGuardHolds,
  coerceSurveyActions, applySurveyActions, randomizedAxes, axisRandomization, staleFields,
  parseLogicExpression, type EvalContext,
} from "./index.js";

/*
 * THE REMAINING ITEMS (2026-10-01, second pass): the 29-09 / 30-09 review rows
 * that were UI-shaped, and the leftovers of the 09-28 nested-logic audit.
 */

const opts = (n: number, l = "Opt") => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `${l} ${i + 1}` }));
const rule = (ref: string, operator: string, value?: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator, ...(value !== undefined ? { value } : {}) }) as Condition;
function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "remaining", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Q1", options: opts(3) },
      { id: "g", code: "G", variableName: "G", type: "matrix_single", text: "Grid",
        rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }, { code: "r3", label: "Row 3" }, { code: "r4", label: "Row 4" }],
        options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }] },
      { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Q3", options: opts(4) },
      { id: "q4", code: "Q4", variableName: "Q4", type: "html", text: "Concept" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "g", "q3", "q4"] }, { type: "end", id: "e", status: "complete" }],
    ...extra,
  });
}
const ctxOf = (def: SurveyDefinition, answers: Record<string, unknown> = {}, seed = 1): EvalContext => {
  const state = createResponseState(def, { seed });
  Object.assign(state.answers, answers);
  return { def, state, loop: null };
};

test("29-09 #1: a grid can shuffle its rows AND its columns; show-only-N stays with the primary axis", () => {
  const def = survey();
  const g = def.questions.find((q) => q.id === "g")!;
  g.randomization = { enabled: true, scope: "rows", scopes: ["rows", "options"], method: "shuffle", pick: 2 } as never;
  assert.deepEqual(randomizedAxes(g.randomization), ["rows", "options"]);
  let rowsMoved = false, colsMoved = false;
  for (let seed = 1; seed <= 40; seed++) {
    const v = effectiveQuestion(g, ctxOf(def, {}, seed));
    assert.equal(v.rows.length, 2, "show only 2 applies to the rows (primary)");
    assert.equal(v.options.length, 4, "…not to the columns");
    if (v.options.map((o) => o.code).join() !== "1,2,3,4") colsMoved = true;
    if (v.rows.map((r) => r.code).join() !== "r1,r2") rowsMoved = true;
  }
  assert.ok(rowsMoved && colsMoved, "both axes are shuffled");
  assert.equal(axisRandomization(g.randomization, "options", ctxOf(def))?.pick, undefined);
  /* backward compatible: scope alone still means one axis */
  g.randomization = { enabled: true, scope: "rows", method: "shuffle" } as never;
  assert.deepEqual(randomizedAxes(g.randomization), ["rows"]);
  for (let seed = 1; seed <= 10; seed++) assert.equal(effectiveQuestion(g, ctxOf(def, {}, seed)).options.map((o) => o.code).join(), "1,2,3,4");
});

test("Oweas 1–3, 6: “Displayed” is only a distinct choice when the source can change its own list", () => {
  const def = survey();
  const q1 = def.questions.find((q) => q.id === "q1")!;
  const g = def.questions.find((q) => q.id === "g")!;
  assert.equal(displayedListCanVary(def, q1), false, "a plain list: displayed = all");
  q1.options[2].logic = { visibility: "hide_when", when: rule("q3", "eq", 1) } as never;
  assert.equal(displayedListCanVary(def, q1), true);
  q1.options[2].logic = { visibility: "hide_when", when: { type: "group", op: "and", children: [] } } as never;
  assert.equal(displayedListCanVary(def, q1), false, "an unfinished rule changes nothing");
  assert.equal(displayedListCanVary(def, g, "rows"), false);
  g.rows[1].visibleIf = rule("q1", "eq", 2);
  assert.equal(displayedListCanVary(def, g, "rows"), true);
  q1.options[2].logic = undefined;
  q1.randomization = { enabled: true, scope: "options", method: "shuffle", pick: 2 } as never;
  assert.equal(displayedListCanVary(def, q1), true, "show only N");
});

test("Prince 11 / 14 / 16: several media under a question, in order, each piped; one URL stays one URL", () => {
  const def = survey({ embeddedData: [{ name: "PACK", source: "url" }] });
  const q4 = def.questions.find((q) => q.id === "q4")!;
  q4.settings.mediaUrl = "/api/media/a.jpg";
  assert.deepEqual(questionMediaList(q4).map((m) => m.url), ["/api/media/a.jpg"]);
  q4.settings.mediaItems = [
    { id: "1", url: "/api/media/a.jpg", alt: "Pack A" },
    { id: "2", url: "" },
    { id: "3", url: "{{ed.PACK}}" },
  ];
  q4.settings.mediaLayout = "horizontal";
  assert.deepEqual(questionMediaList(q4).map((m) => m.url), ["/api/media/a.jpg", "{{ed.PACK}}"], "an empty slot is not drawn");
  const ctx = ctxOf(def);
  ctx.state.embedded.PACK = "/api/media/b.png";
  const piped = resolveQuestionMedia(q4, ctx);
  assert.deepEqual(piped.mediaItems?.map((m) => m.url), ["/api/media/a.jpg", "", "/api/media/b.png"]);
  /* the media fields are not "left over" on a content block */
  assert.ok(!staleFields(q4).some((f) => /media/.test(f.field ?? String(f))), JSON.stringify(staleFields(q4)));
  assert.ok(SurveyDefinition.safeParse(JSON.parse(JSON.stringify(def))).success, "saves and reloads");
});

test("Prince 36: a piped URL is shown as the picture it names with |image — and only a URL that can only be a picture", () => {
  const def = survey();
  const ctx = ctxOf(def);
  ctx.state.embedded.Concept_1 = "/api/media/97/Picture16.jpg";
  ctx.state.embedded.Bad = "javascript:alert(1)";
  ctx.state.embedded.Quote = 'https://x.test/a.png" onerror="x';
  assert.equal(resolvePiping("{{Concept_1}}", ctx), "/api/media/97/Picture16.jpg", "plain piping is still text");
  assert.equal(resolvePiping("{{Concept_1|image}}", ctx), '<img class="rs-piped-image" src="/api/media/97/Picture16.jpg" alt="">');
  assert.equal(resolvePiping("{{ed.Concept_1|image}}", ctx), '<img class="rs-piped-image" src="/api/media/97/Picture16.jpg" alt="">');
  assert.equal(resolvePiping("{{Bad|image}}", ctx), "javascript:alert(1)");
  assert.doesNotMatch(resolvePiping("{{Quote|image}}", ctx), /" onerror=/, "an attribute cannot be broken out of");
});

test("embedded IF … THEN … ELSE nests inside THEN as well as ELSE (before: an IF inside THEN was mangled)", () => {
  assert.equal(normalizeExpression("IF a THEN IF b THEN 1 ELSE 2 ELSE 3"), "if(a, if(b, 1, 2), 3)");
  assert.equal(normalizeExpression("IF a THEN 1 ELSE IF b THEN 2 ELSE 3"), "if(a, 1, if(b, 2, 3))");
  assert.equal(normalizeExpression("IF (a AND b) THEN (IF c THEN 1 ELSE 2) ELSE 3"), "if((a AND b), (if(c, 1, 2)), 3)");
  assert.equal(normalizeExpression('x + (IF a > 1 THEN "IF THEN" ELSE 0)'), 'x + (if(a > 1, "IF THEN", 0))');
  assert.equal(normalizeExpression("if(a, 1, 2)"), "if(a, 1, 2)", "the function form is left alone");
  const def = survey();
  const ctx = ctxOf(def, { q1: 2, q3: 1 });
  const ev = (src: string) => safeExpression(normalizeExpression(src), def, ctx.state);
  assert.equal(ev("IF Q1 = 2 THEN IF Q3 = 1 THEN 10 ELSE 20 ELSE 30"), 10);
  assert.equal(safeExpression(normalizeExpression("IF Q1 = 2 THEN IF Q3 = 4 THEN 10 ELSE 20 ELSE 30"), def, ctx.state), 20);
});

test("calculations read named expressions — nested logic defined once, used as 1 / 0", () => {
  const def = survey({ namedExpressions: [{ id: "ne1", name: "TARGET", when: { type: "group", op: "and", children: [rule("q1", "eq", 2), { type: "group", op: "or", children: [rule("q3", "eq", 1), rule("q3", "eq", 2)] }] } }] });
  assert.equal(safeExpression("TARGET * 10", def, ctxOf(def, { q1: 2, q3: 2 }).state), 10);
  assert.equal(safeExpression("TARGET * 10", def, ctxOf(def, { q1: 2, q3: 4 }).state), 0);
  assert.equal(safeExpression("if(rule.TARGET, 5, 7)", def, ctxOf(def, { q1: 2, q3: 1 }).state), 5);
});

test("UX: a style or animation with a `when` is in the stylesheet only while it holds; authoring shows everything", () => {
  const def = survey({ ux: { styles: [
    { id: "s1", label: "Heavy users", target: { kind: "question", questionId: "q3" }, rules: [{ declarations: { "background-color": "#fef3c7" } }], when: { type: "group", op: "and", children: [rule("q1", "eq", 1), { type: "group", op: "not", children: [rule("q3", "eq", 4)] }] } },
  ], animations: [], behaviors: [] } });
  const style = def.ux!.styles[0];
  assert.match(compileUxCss(def), /#fef3c7/, "the Studio sees it");
  assert.match(compileUxCss(def, { state: ctxOf(def, { q1: 1 }).state }), /#fef3c7/);
  assert.doesNotMatch(compileUxCss(def, { state: ctxOf(def, { q1: 2 }).state }), /#fef3c7/);
  assert.equal(uxGuardHolds(def, style, ctxOf(def, { q1: 1, q3: 4 }).state), false, "the nested NOT");
  /* the Copilot can write the same */
  const acts = coerceSurveyActions([{ op: "create_style", label: "x", target: "Q3", rules: [{ declarations: { color: "red" } }], when: "Q1 = 1 AND NOT Q3 = 4" }]);
  assert.equal(acts.actions.length, 1, JSON.stringify(acts.rejected));
  const out = applySurveyActions(survey(), acts.actions);
  assert.deepEqual(out.errors, []);
  assert.equal(out.def.ux!.styles[0].when?.type, "group");
});

test("logic text keeps reading after these changes (regression guard)", () => {
  const def = survey();
  assert.deepEqual(parseLogicExpression(def, "Q1 = 1 BUT NOT Q3 = 2").errors, []);
});

test("a derived question's programmed default value is never taken back by a punch that stops holding", async () => {
  const { optionRule, recomputePunchesAfterChange, setAnswer } = await import("./index.js");
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "d", version: "1.0" },
    questions: [
      { id: "n", code: "N", variableName: "N", type: "numeric", text: "n" },
      { id: "h", code: "H", variableName: "H", type: "hidden", text: "h", options: opts(2), settings: { defaultValue: 1 } },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["n", "h"] }, { type: "end", id: "e", status: "complete" }],
  });
  const h = def.questions[1];
  h.punches = [optionRule({ sourceQuestionId: "n", sourceCode: "", test: "gt", value: 5, action: "select", targetCodes: [1] }, "p1")];
  const state = createResponseState(def, { seed: 1 });
  state.answers.h = 1;
  const ctx = { def, state, loop: null };
  setAnswer(def, state, "n", 2);
  recomputePunchesAfterChange(def, state, "n", def.questions, ctx);
  assert.equal(state.answers.h, 1, "the default stays");
});
