import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, describeAction, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { decideListFill, listFillVariables, applyListFillDestinations, pendingListFills, listFillIsStale } from "./listFill.js";
import { compileFlow, visibleQuestions } from "./flow.js";
import { effectiveQuestion } from "./carryforward.js";
import { createResponseState, type ResponseState } from "./state.js";
import { resolvePiping } from "./piping.js";
import "./listFillSettled.js";

/*
 * INTELLIGENT MODE LIST FILL (P0, 2026-10-16). The production case, from the
 * operations log (translated from Hindi): Q37 rates 10 smartphone brands
 * 1 Never heard of … 5 Very familiar; the brands rated 3–5 go to Q38 (a
 * ranking); more than 5 → 4 at random; Apple first when it qualifies. The
 * model wrote a mask with an invented expression. These tests drive the whole
 * path: model-shaped JSON → coerce → apply → the engine's allocation against
 * respondents → what Q38 actually shows.
 */

const BRANDS = ["Apple", "Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme", "Motorola", "Nokia", "Google"];
const SCALE = ["Never heard of", "Heard of", "Somewhat familiar", "Familiar", "Very familiar"];
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Brands", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });

let seq = 0;
const ids = (p: string) => `${p}_${++seq}`;

function apply(def: SurveyDefinition, raw: unknown[]) {
  const c = coerceSurveyActions(raw);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(def, c.actions, { ids, now: "2026-10-16T00:00:00Z" });
}

const QUESTIONS = [
  { op: "create_question", type: "grid", code: "Q37", text: "How familiar are you with each of these brands?", rows: BRANDS, scale: { points: 5, labels: SCALE } },
  { op: "create_question", type: "ranking", code: "Q38", text: "Rank these brands", options: BRANDS, newPage: true },
];
const REAL_CASE = { op: "create_list_fill", name: "BRANDS", source: "Q37", eligible: { minValue: 3 }, count: 4, allIfAtMost: 5, method: "priority_random", priority: { Apple: 1 }, destinations: [{ question: "Q38" }], whenUnused: "hide" };

function realCase() {
  const out = apply(empty(), [...QUESTIONS, REAL_CASE]);
  assert.deepEqual(out.errors, []);
  assert.ok(out.valid);
  const def = out.def;
  const q37 = def.questions.find((q) => q.code === "Q37")!;
  const q38 = def.questions.find((q) => q.code === "Q38")!;
  return { out, def, q37, q38, lf: def.listFills[0] };
}

/** one respondent: rate the grid, submit the page (the List Fills due run, exactly as the runtime does), read Q38 */
function respondent(env: ReturnType<typeof realCase>, ratings: number[], seed = 11, state?: ResponseState) {
  const { def, q37, q38 } = env;
  const st = state ?? createResponseState(def, { sessionId: `r${seed}`, seed });
  st.answers[q37.id] = Object.fromEntries(q37.rows.map((r, i) => [String(r.code), ratings[i]])) as never;
  const due = pendingListFills(def, st, { assumeSourcesSettled: true });
  for (const lf of due) {
    const res = decideListFill({ def, listFill: lf, state: st });
    Object.assign(st.calculated, listFillVariables(lf, res));
    applyListFillDestinations(lf, res, st);
  }
  const shown = effectiveQuestion(q38, { def, state: st }).options.map((o) => o.label);
  const visible = compileFlow(def, st).filter((s) => s.kind === "page").flatMap((s) => visibleQuestions(def, s as never, st).map((q) => q.code));
  const codes = String(st.calculated.LISTFILL_BRANDS_CODES ?? "").split(",").filter(Boolean);
  return { st, due: due.length, shown, visible, codes, first: st.calculated.LISTFILL_BRANDS_1 };
}
const rated = (...on: string[]) => BRANDS.map((b) => (on.includes(b) ? 4 : 1));

/* ------------------------------------------------------------ the action */

test("the three List Fill ops are engine actions the model is told about", () => {
  for (const op of ["create_list_fill", "update_list_fill", "remove_list_fill"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  const c = coerceSurveyActions([REAL_CASE]);
  assert.equal(c.actions.length, 1);
  assert.equal(describeAction(c.actions[0]), "Create List Fill BRANDS");
});

test("real case: create_list_fill resolves Q37's rows, the 3–5 rule, the count, Apple's priority and Q38 — in words", () => {
  const { out, lf, q37, q38 } = realCase();
  const r = out.results[2];
  assert.ok(r.ok, r.error);
  assert.match(r.description, /List Fill BRANDS: from Q37 rows rated 3–5 \(Somewhat familiar … Very familiar\), 4 items \(all of them when 5 or fewer qualify\), Apple first when eligible, random among the rest, into Q38/);
  assert.match(r.description, /hidden when nothing qualifies/);
  // the grid's rows are the items, by their real codes and labels — not the scale
  assert.deepEqual(lf.options.map((o) => o.label), BRANDS);
  assert.deepEqual(lf.options.map((o) => o.code), q37.rows.map((x) => String(x.code)));
  assert.deepEqual(lf.source, { kind: "question", questionId: q37.id, take: "all" });
  assert.deepEqual(lf.options[0].eligibleWhen, { type: "rule", source: { kind: "question", ref: q37.id, rowCode: String(q37.rows[0].code) }, operator: "gte", value: 3 });
  assert.equal(lf.options[0].priority, 1);
  assert.ok(lf.options.slice(1).every((o) => o.priority == null));
  assert.deepEqual(lf.selection.count, { kind: "fixed", n: 4, allUpTo: 5 });
  assert.equal(lf.selection.method, "priority_random");
  assert.equal(lf.tracking.sampleLevel, false, "a per-respondent selector needs no sample counters");
  // Q38 shows the list: its options masked to LISTFILL(BRANDS), recoded to Q37's codes (said, as destructive)
  assert.deepEqual(q38.mask?.expr, { kind: "listFill", listFillId: lf.id });
  assert.deepEqual(q38.options.map((o) => String(o.code)), q37.rows.map((x) => String(x.code)));
  assert.deepEqual(q38.options.map((o) => o.label), BRANDS);
  assert.match(r.destructive ?? "", /Recodes Q38's options to Q37's codes \(Apple → r/);
  assert.deepEqual(lf.destinations, [{ questionId: q38.id, position: 1, write: "piping_only", whenUnused: "hide" }]);
});

test("real case: 2 brands rated 3–5 → both, Apple first; Q38 shows exactly those two", () => {
  const env = realCase();
  const a = respondent(env, rated("Apple", "Nokia"));
  assert.deepEqual(a.codes.length, 2);
  assert.equal(a.first, "Apple");
  assert.deepEqual(a.shown, ["Apple", "Nokia"]);
  assert.ok(a.visible.includes("Q38"));
});

test("real case: 7 qualify → exactly 4, Apple included and on top, deterministic per seed, no duplicates", () => {
  const env = realCase();
  const seven = ["Apple", "Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme"];
  const sets = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const a = respondent(env, rated(...seven), seed);
    assert.equal(a.codes.length, 4);
    assert.equal(new Set(a.codes).size, 4, "no duplicates");
    assert.equal(a.first, "Apple");
    assert.equal(a.shown.length, 4);
    assert.equal(a.shown[0], "Apple", "Apple on top of Q38");
    assert.ok(a.shown.every((l) => seven.includes(l)), "only brands rated 3–5");
    // labels and codes travel together
    assert.deepEqual(a.shown, BRANDS.filter((b) => a.shown.includes(b)), "Q38's own order is kept");
    const again = respondent(env, rated(...seven), seed);
    assert.deepEqual(again.codes, a.codes, "same respondent seed → same list");
    sets.add([...a.codes].sort().join());
  }
  assert.ok(sets.size > 3, "the other three are drawn at random");
});

test("real case: exactly 5 qualify → all 5 (more than 5 → 4)", () => {
  const env = realCase();
  const a = respondent(env, rated("Apple", "Samsung", "Vivo", "Oppo", "Google"));
  assert.equal(a.codes.length, 5);
  assert.deepEqual(a.shown, ["Apple", "Samsung", "Vivo", "Oppo", "Google"]);
});

test("real case: Apple not rated 3–5 → not forced in; any 4 of the others", () => {
  const env = realCase();
  const six = ["Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme"];
  const a = respondent(env, rated(...six));
  assert.equal(a.codes.length, 4);
  assert.ok(!a.shown.includes("Apple"));
  assert.ok(a.shown.every((l) => six.includes(l)));
});

test("real case: nothing rated 3–5 → empty list, Q38 hidden (whenUnused hide), no unresolved piping", () => {
  const env = realCase();
  const a = respondent(env, rated());
  assert.equal(a.st.calculated.LISTFILL_BRANDS_COUNT, 0);
  assert.deepEqual(a.codes, []);
  assert.ok(!a.visible.includes("Q38"));
});

test("real case: the respondent goes Back and re-rates → the list is decided again, nothing stale left", () => {
  const env = realCase();
  const first = respondent(env, rated("Apple", "Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo"));
  assert.equal(first.codes.length, 4);
  // plain Back / Next with the same answers: nothing re-runs (same seed → same list)
  assert.equal(pendingListFills(env.def, first.st, { assumeSourcesSettled: true }).length, 0);
  // now only Oppo and Realme qualify
  const second = respondent(env, rated("Oppo", "Realme"), 11, first.st);
  assert.equal(second.due, 1, "the changed source re-runs the list");
  assert.deepEqual(second.shown, ["Oppo", "Realme"]);
  assert.equal(second.st.calculated.LISTFILL_BRANDS_COUNT, 2);
  for (const k of ["LISTFILL_BRANDS_3", "LISTFILL_BRANDS_3_CODE", "LISTFILL_BRANDS_4", "LISTFILL_BRANDS_4_CODE"]) assert.ok(!(k in second.st.calculated), `${k} cleared`);
  assert.equal(resolvePiping("{{LISTFILL_BRANDS_3}}", { def: env.def, state: second.st }).trim(), "");
  // and down to nothing: Q38 disappears
  const third = respondent(env, rated(), 11, second.st);
  assert.deepEqual(third.shown.length, 0);
  assert.ok(!third.visible.includes("Q38"));
});

test("a sample-level list follows a changed answer (keep_valid, 2026-10-17); onChange freeze keeps the old allocate-once", () => {
  const env = realCase();
  const lf = { ...env.lf, tracking: { ...env.lf.tracking, sampleLevel: true } };
  const st = respondent(env, rated("Apple", "Samsung")).st;
  st.answers[env.q37.id] = Object.fromEntries(env.q37.rows.map((r) => [String(r.code), 1])) as never;
  // before 2026-10-17 this was false: the respondent kept Apple and Samsung after un-rating both
  assert.equal(listFillIsStale(env.def, lf, st), true);
  assert.equal(listFillIsStale(env.def, { ...lf, selection: { ...lf.selection, onChange: "freeze" } }, st), false);
  assert.equal(listFillIsStale(env.def, env.lf, st), true);
});

test("always: Apple is in the list whatever it was rated, and first", () => {
  const out = apply(empty(), [...QUESTIONS, { ...REAL_CASE, priority: undefined, always: ["Apple"] }]);
  assert.deepEqual(out.errors, []);
  assert.match(out.results[2].description, /Apple always included and first/);
  const env = { out, def: out.def, q37: out.def.questions[0], q38: out.def.questions[1], lf: out.def.listFills[0] };
  const a = respondent(env, rated("Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme"));
  assert.equal(a.codes.length, 4);
  assert.equal(a.first, "Apple");
  assert.equal(a.shown[0], "Apple");
});

/* ------------------------------------------------------------ other sources */

test("multi-select source: the selected brands, 2 at random with Samsung first, into a multi-select that shows them", () => {
  const out = apply(empty(), [
    { op: "create_question", type: "multi", code: "Q5", text: "Which brands do you own?", options: BRANDS },
    { op: "create_question", type: "multi", code: "Q6", text: "Which would you buy again?", options: BRANDS, newPage: true },
    { op: "create_list_fill", name: "OWNED", source: "Q5", count: 2, priority: { "Samsung": 1 }, destinations: ["Q6"] },
  ]);
  assert.deepEqual(out.errors, []);
  const [q5, q6] = out.def.questions;
  const lf = out.def.listFills[0];
  assert.deepEqual(lf.source, { kind: "question", questionId: q5.id, take: "selected" });
  assert.equal(lf.selection.method, "priority_random");
  assert.equal(out.results[2].destructive, undefined, "same codes: nothing recoded");
  const st = createResponseState(out.def, { sessionId: "m", seed: 3 });
  st.answers[q5.id] = ["3", "2", "6"] as never;
  const res = decideListFill({ def: out.def, listFill: lf, state: st });
  assert.deepEqual(res.items.map((i) => i.label)[0], "Samsung");
  assert.equal(res.items.length, 2);
  Object.assign(st.calculated, listFillVariables(lf, res));
  const shown = effectiveQuestion(q6, { def: out.def, state: st }).options.map((o) => o.label);
  assert.equal(shown.length, 2);
  assert.ok(shown.includes("Samsung"));
});

test("single-select source: the one brand chosen is piped into a later open end", () => {
  const out = apply(empty(), [
    { op: "create_question", type: "single", code: "Q1", text: "Your main brand?", options: BRANDS },
    { op: "create_question", type: "long_text", code: "Q2", text: "Why {{LISTFILL_MAIN_1}}?", newPage: true },
    { op: "create_list_fill", name: "MAIN", source: "Q1", count: 1, destinations: ["Q2"] },
  ]);
  assert.deepEqual(out.errors, []);
  const lf = out.def.listFills[0];
  assert.deepEqual(lf.destinations, [{ questionId: out.def.questions[1].id, position: 1, write: "piping_only" }]);
  const st = createResponseState(out.def, { sessionId: "s1", seed: 1 });
  st.answers[out.def.questions[0].id] = "4" as never;
  const res = decideListFill({ def: out.def, listFill: lf, state: st });
  Object.assign(st.calculated, listFillVariables(lf, res));
  assert.equal(resolvePiping("Why {{LISTFILL_MAIN_1}}?", { def: out.def, state: st }), "Why OnePlus?");
});

test("a static list source and a grid rule given as answers (labels)", () => {
  const out = apply(empty(), [...QUESTIONS, { ...REAL_CASE, eligible: { answers: ["Familiar", "Very familiar"] }, allIfAtMost: undefined }]);
  assert.deepEqual(out.errors, []);
  assert.match(out.results[2].description, /rated Familiar \/ Very familiar/);
  assert.equal(out.def.listFills[0].options[1].eligibleWhen && (out.def.listFills[0].options[1].eligibleWhen as { operator: string }).operator, "in");
  const st = apply(empty(), [{ op: "create_question", type: "text", code: "Q1", text: "Name" }, { op: "create_list_fill", name: "ADS", source: { items: ["Ad A", "Ad B", "Ad C"] }, count: 2 }]);
  assert.deepEqual(st.errors, []);
  assert.deepEqual(st.def.listFills[0].source, { kind: "static", items: [{ code: "1", label: "Ad A" }, { code: "2", label: "Ad B" }, { code: "3", label: "Ad C" }] });
});

/* ------------------------------------------------------------ refusals */

const refused = (raw: Record<string, unknown>, re: RegExp, questions: unknown[] = QUESTIONS) => {
  const c = coerceSurveyActions([...questions, raw]);
  const coerceErr = c.rejected.find((x) => x.index === questions.length);
  if (coerceErr) { assert.match(coerceErr.reason, re); return; }
  const out = applySurveyActions(empty(), c.actions, { ids });
  const r = out.results[questions.length];
  assert.equal(r.ok, false, `expected a refusal matching ${re}`);
  assert.match(r.error ?? "", re);
  assert.equal(out.def.listFills.length, 0, "nothing half-written");
};

test("refused, with the reason: what cannot be resolved", () => {
  refused({ ...REAL_CASE, source: "Q99" }, /there is no question “Q99”/);
  refused({ ...REAL_CASE, priority: { Blackberry: 1 } }, /priority: “Blackberry” is not an item of Q37 — the items are r1=Apple/);
  refused({ ...REAL_CASE, destinations: ["Q77"] }, /there is no question “Q77”/);
  refused({ ...REAL_CASE, eligible: { minValue: 6 } }, /no point of Q37's scale .* is ≥ 6/);
  refused({ ...REAL_CASE, eligible: { answers: ["Loves it"] } }, /Q37's scale has no point “Loves it”/);
});

test("refused, with the reason: what the engine cannot do", () => {
  refused({ ...REAL_CASE, method: "random" }, /method random ignores priority/);
  refused({ ...REAL_CASE, allowDuplicates: true }, /allowDuplicates is not supported/);
  refused({ ...REAL_CASE, fillToCount: false }, /fillToCount: false has no effect/);
  refused({ ...REAL_CASE, eligible: { when: "Q37.row(code) >= 3" } }, /eligible.when is not a per-item rule/);
  refused({ ...REAL_CASE, count: "min(4, Q37_COUNT)" }, /an expression count is not evaluated/);
  refused({ ...REAL_CASE, allIfAtMost: 3 }, /allIfAtMost 3 is below the count 4/);
  refused({ ...REAL_CASE, method: "custom" }, /method custom needs a script/);
  refused({ ...REAL_CASE, repeatBlock: "B2" }, /loop over the List Fill/);
  refused({ ...REAL_CASE, maximum: { Apple: 150 }, trackSample: false }, /need trackSample: true/);
  // a cap on its own turns the sample-level counters on, and says so
  const capped = apply(empty(), [...QUESTIONS, { ...REAL_CASE, maximum: { Apple: 150 } }]);
  assert.deepEqual(capped.errors, []);
  assert.equal(capped.def.listFills[0].tracking.sampleLevel, true);
  assert.equal(capped.def.listFills[0].options[0].maximum, 150);
  assert.match(capped.results[2].description, /counted across the sample/);
});

test("refused, with the reason: a destination that cannot receive the list", () => {
  // before the source / on the source's page
  refused({ ...REAL_CASE, source: "Q38", eligible: undefined, destinations: ["Q37"] }, /Q37 is asked before Q38/);
  refused(REAL_CASE, /Q38 is on the same page as Q37/, [QUESTIONS[0], { ...QUESTIONS[1], newPage: false }]);
  // a destination without the source's items
  refused(REAL_CASE, /Q38 has no option for “Google”/, [QUESTIONS[0], { ...QUESTIONS[1], options: BRANDS.slice(0, 9) }]);
  // a minValue rule on a multi-select
  refused({ op: "create_list_fill", name: "X", source: "Q5", eligible: { minValue: 3 }, count: 2 }, /qualify the ROWS of a grid/, [{ op: "create_question", type: "multi", code: "Q5", text: "Own?", options: BRANDS }]);
  // always on a multi-select's selection
  refused({ op: "create_list_fill", name: "X", source: "Q5", always: ["Apple"], count: 2 }, /an unselected Apple is not on it/, [{ op: "create_question", type: "multi", code: "Q5", text: "Own?", options: BRANDS }]);
});

test("a destination already read by other logic is not recoded behind its back", () => {
  const base = apply(empty(), [...QUESTIONS, { op: "create_question", type: "text", code: "Q39", text: "Why?", newPage: true }, { op: "set_display_logic", target: "Q39", expression: "Q38 contains 1" }]).def;
  const c = coerceSurveyActions([REAL_CASE]);
  const out = applySurveyActions(base, c.actions, { ids });
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error ?? "", /Q38 is already read by other logic, so it is not recoded here/);
});

/* ------------------------------------------------------------ update / remove */

test("update_list_fill: a new count and whenUnused; a rename carries the variables with it", () => {
  const { def } = realCase();
  const piped = apply(def, [{ op: "create_question", type: "text", code: "Q40", text: "Tell us about {{LISTFILL_BRANDS_1}}", newPage: true }]).def;
  const out = apply(piped, [{ op: "update_list_fill", listFill: "BRANDS", count: 3, allIfAtMost: null, whenUnused: "disable", newName: "TOPBRANDS" }]);
  assert.deepEqual(out.errors, []);
  const lf = out.def.listFills[0];
  assert.equal(lf.name, "TOPBRANDS");
  assert.deepEqual(lf.selection.count, { kind: "fixed", n: 3 });
  // "disable" is acted on by nothing at runtime (no renderer reads it): stored as hide, and said so (2026-10-17)
  assert.equal(lf.destinations[0].whenUnused, "hide");
  assert.ok(out.warnings.some((w) => /disable.*not supported at runtime/.test(w)), JSON.stringify(out.warnings));
  assert.equal(lf.options[0].priority, 1, "untouched settings stay");
  assert.equal(out.def.questions.find((q) => q.code === "Q40")!.text, "Tell us about {{LISTFILL_TOPBRANDS_1}}");
  assert.match(out.results[0].description, /^List Fill now TOPBRANDS: .*3 items/);
});

test("update_list_fill refuses an unknown list and a change of nothing", () => {
  const { def } = realCase();
  const c = coerceSurveyActions([{ op: "update_list_fill", listFill: "NOPE", count: 2 }, { op: "update_list_fill", listFill: "BRANDS" }]);
  assert.match(c.rejected[0]?.reason ?? "", /changes nothing/);
  const out = applySurveyActions(def, c.actions, { ids });
  assert.match(out.results[0].error ?? "", /there is no List Fill “NOPE” — the List Fills are BRANDS/);
});

test("remove_list_fill removes the list and Q38's mask; refused while a loop still reads it", () => {
  const { def, q38 } = realCase();
  const out = apply(def, [{ op: "remove_list_fill", listFill: "BRANDS" }]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.def.listFills.length, 0);
  assert.equal(out.def.questions.find((q) => q.id === q38.id)!.mask, undefined);
  assert.match(out.results[0].destructive ?? "", /Removes List Fill BRANDS and what it showed in Q38/);
  const piped = apply(def, [{ op: "create_question", type: "text", code: "Q40", text: "About {{LISTFILL_BRANDS_1}}", newPage: true }]).def;
  const blocked = apply(piped, [{ op: "remove_list_fill", listFill: "BRANDS" }]);
  assert.match(blocked.results[0].error ?? "", /still read by Q40/);
});

test("Apple not first in the destination's own order: a move-to-top rule puts it on top when it is allocated first", () => {
  const reversed = [...BRANDS].reverse();
  const out = apply(empty(), [QUESTIONS[0], { ...QUESTIONS[1], options: reversed }, REAL_CASE]);
  assert.deepEqual(out.errors, []);
  const env = { out, def: out.def, q37: out.def.questions[0], q38: out.def.questions[1], lf: out.def.listFills[0] };
  const apple = env.q38.options.find((o) => o.label === "Apple")!;
  assert.deepEqual((apple.logic as { prioritizeWhen?: unknown }).prioritizeWhen, { type: "rule", source: { kind: "variable", ref: "LISTFILL_BRANDS_1_CODE" }, operator: "eq", value: String(apple.code) });
  const a = respondent(env, rated("Apple", "Samsung", "Nokia"));
  assert.deepEqual(a.shown, ["Apple", "Nokia", "Samsung"], "Apple on top, the rest in Q38's own order");
  const b = respondent(env, rated("Samsung", "Nokia"));
  assert.deepEqual(b.shown, ["Nokia", "Samsung"]);
  // removing the list removes the rule it set up
  const removed = apply(out.def, [{ op: "remove_list_fill", listFill: "BRANDS" }]);
  assert.equal((removed.def.questions[1].options.find((o) => o.label === "Apple")!.logic as { prioritizeWhen?: unknown } | undefined)?.prioritizeWhen, undefined);
});
