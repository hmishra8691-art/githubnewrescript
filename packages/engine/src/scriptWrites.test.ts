import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applyScriptWrite, sanitizeScriptWrites, SCRIPT_WRITE_LIMITS, type ScriptWriteContext } from "./scriptWrites.js";
import { createResponseState } from "./state.js";
import { start } from "./flow.js";

/*
 * S1a item 1: the engine-checked write channel. Every type family accepts a valid value and refuses an invalid one;
 * the scope rule; punches and calculations recompute after a script write exactly as after a respondent change;
 * each accepted write is recorded as paradata without its value.
 */

const opts = [{ code: "1", label: "One" }, { code: "2", label: "Two" }, { code: "3", label: "Three" }];
const rows = [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }];
const Q = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: id, ...extra });
const segRule = { id: "p_seg", source: { kind: "codes", codes: ["Y"] }, action: "select", mapping: [], ignoreUnmatched: true,
  when: { type: "rule", source: { kind: "question", ref: "h_src" }, operator: "eq", value: "1" } };

const def = SurveyDefinition.parse({
  meta: { id: "sw", code: "SW", title: "Script writes", version: "1" },
  questions: [
    Q("q_single", "single_select", { options: opts }),
    Q("q_multi", "multi_select", { options: opts }),
    Q("q_num", "numeric"),
    Q("q_text", "open_text"),
    Q("q_grid", "matrix_single", { options: opts, rows }),
    Q("q_gridm", "matrix_multi", { options: opts, rows }),
    Q("q_cells", "composite", { rows, columns: [{ id: "c1", label: "C1", responseType: "text", variableStem: "C1" }] }),
    Q("q_rank", "ranking", { options: opts }),
    Q("q_alloc", "allocation", { options: opts }),
    Q("q_list", "numeric_list", { rows }),
    Q("q_geo", "geo"),
    Q("h_src", "hidden", { options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }] }),
    Q("h_seg", "hidden", { options: [{ code: "Y", label: "Young" }, { code: "O", label: "Old" }], punches: [segRule] }),
    Q("h_free", "hidden"),
    Q("q_calc", "calculated", { settings: { expression: "1 + 1" } }),
    Q("q_owned", "hidden", { options: [{ code: "Y", label: "Y" }], punches: [{ ...segRule, id: "p_own", recompute: "always" }] }),
    Q("q_loop", "numeric"),
    Q("q_later", "single_select", { options: opts }),
  ],
  flow: [
    { type: "embedded_data", id: "ed", fields: [{ name: "SOURCE", source: "static", value: "web", dataType: "string" }, { name: "SCORE", source: "static", value: "0", dataType: "integer" }] },
    { type: "block", id: "b1", title: "One", children: [
      { type: "page", id: "p1", questionIds: ["q_single", "q_multi", "q_num", "q_text", "q_grid", "q_gridm", "q_cells", "q_rank", "q_alloc", "q_list", "q_geo"] },
      { type: "page", id: "p1b", questionIds: ["q_later"] },
    ] },
    { type: "loop", id: "lp", loopVar: "brand", source: { kind: "static", items: [{ code: "a", label: "Apple" }, { code: "g", label: "Google" }] },
      children: [{ type: "page", id: "pl", questionIds: ["q_loop"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
  calculations: [
    { id: "c_twice", targetVariable: "SRC_TWICE", expression: "SCORE * 2", trigger: "on_change" },
    { id: "c_submit", targetVariable: "PAGE_SCORE", expression: "1", trigger: "on_page_submit", dataType: "numeric" },
  ],
});

const fresh = () => { const s = createResponseState(def, { seed: 5, sessionId: "s-sw" }); start(def, s); return s; };
const survey = (shown: string[] = []): ScriptWriteContext => ({ scriptId: "b_survey", scope: { kind: "survey" }, shown, at: "2026-10-30T00:00:00.000Z" });
const own = (qid: string, shown: string[] = [qid]): ScriptWriteContext => ({ scriptId: `b_${qid}`, scope: { kind: "question", questionId: qid }, shown, at: "2026-10-30T00:00:00.000Z" });
const answer = (ref: string, value: unknown, ctx = own(ref.toLowerCase())) => { const s = fresh(); return { s, r: applyScriptWrite(def, s, { kind: "answer", ref, value }, ctx) }; };

test("every type family accepts a valid value and refuses an invalid one", () => {
  const cases: [string, unknown, unknown, RegExp][] = [
    ["Q_SINGLE", "2", "9", /not an option code/],
    ["Q_MULTI", ["1", "3"], ["1", "7"], /not an option code/],
    ["Q_NUM", 42, "forty", /not a number/],
    ["Q_TEXT", "hello", { a: 1 }, /takes text/],
    ["Q_GRID", { r1: "1", r2: "3" }, { r9: "1" }, /not a row code/],
    ["Q_GRIDM", { r1: ["1", "2"] }, { r1: "1" }, /send an array/],
    ["Q_CELLS", { r1: { c1: "x" } }, { r1: { c9: "x" } }, /not a column/],
    ["Q_RANK", ["3", "1", "2"], ["1", "1"], /listed twice/],
    ["Q_ALLOC", { "1": 60, "2": 40 }, { "1": "lots" }, /not a number/],
    ["Q_LIST", { r1: 3, r2: "4" }, { r1: "x" }, /not a number/],
  ];
  for (const [ref, good, bad, why] of cases) {
    const ok = answer(ref, good);
    assert.equal(ok.r.ok, true, `${ref} accepts ${JSON.stringify(good)}: ${ok.r.reason}`);
    const no = answer(ref, bad);
    assert.equal(no.r.ok, false, `${ref} refuses ${JSON.stringify(bad)}`);
    assert.match(no.r.reason!, why, `${ref}: ${no.r.reason}`);
    assert.equal(no.s.answers[ref.toLowerCase()], undefined, `${ref}: a refused write changes nothing`);
  }
  // normalised as the renderer stores it: numbers as numbers, option codes as the definition spells them
  assert.equal(answer("Q_NUM", "7").s.answers.q_num, 7);
  assert.deepEqual(answer("Q_LIST", { r1: "4" }).s.answers.q_list, { r1: 4 });
  // respondent-only shapes are never written by a script
  const geo = answer("Q_GEO", { lat: 1, lng: 2 });
  assert.equal(geo.r.ok, false);
  assert.match(geo.r.reason!, /only the respondent can answer it/);
  // hidden variable: its own codes; a free hidden variable: any scalar
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "H_SRC", value: "3" }, survey()).ok, false);
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "H_FREE", value: "anything" }, survey()).ok, true);
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "H_FREE", value: { deep: { x: 1 } } }, survey()).ok, false);
  // size limits
  const long = answer("Q_TEXT", "x".repeat(SCRIPT_WRITE_LIMITS.text + 1));
  assert.equal(long.r.ok, false);
  assert.match(long.r.reason!, /longer than/);
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "NOPE", value: 1 }, survey()).ok, false);
});

test("scope: on-screen questions only for their own script; hidden targets for anyone; calculated/owned refused", () => {
  const page = ["q_single", "q_multi", "q_num"];
  // a survey script cannot overwrite what the respondent is looking at
  const r1 = applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_SINGLE", value: "1" }, survey(page));
  assert.equal(r1.ok, false);
  assert.match(r1.reason!, /on screen/);
  // …but may write a question not shown right now
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_LATER", value: "1" }, survey(page)).ok, true);
  // a question script writes its own question even on screen, and not its neighbour
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_SINGLE", value: "1" }, own("q_single", page)).ok, true);
  const r2 = applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_MULTI", value: ["1"] }, own("q_single", page));
  assert.equal(r2.ok, false);
  // a page script: not the questions on screen, yes a question of its block that is not shown; not another block's
  const pageCtx: ScriptWriteContext = { scriptId: "b_page", scope: { kind: "page", pageId: "p1" }, shown: page };
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_SINGLE", value: "1" }, pageCtx).ok, false);
  const blockCtx: ScriptWriteContext = { scriptId: "b_block", scope: { kind: "block", blockId: "b1" }, shown: page };
  assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_LATER", value: "2" }, blockCtx).ok, true);
  const r3 = applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_LOOP", value: 1, loopKey: "a" }, blockCtx);
  assert.equal(r3.ok, false);
  assert.match(r3.reason!, /not on this script's block/);
  // hidden targets: any scope
  for (const ctx of [pageCtx, blockCtx, own("q_single", page), survey(page)]) assert.equal(applyScriptWrite(def, fresh(), { kind: "answer", ref: "H_FREE", value: 1 }, ctx).ok, true);
  assert.match(applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_CALC", value: 5 }, survey()).reason!, /calculated by its expression/);
  assert.match(applyScriptWrite(def, fresh(), { kind: "answer", ref: "Q_OWNED", value: "Y" }, survey()).reason!, /owned by its punch rule/);
});

test("loops: the page's iteration by default, another one by its key, refused without one outside the loop", () => {
  const s = fresh();
  const loopCtx = { code: "g", label: "Google", index: 2, loopVar: "brand", loopId: "lp" };
  const r = applyScriptWrite(def, s, { kind: "answer", ref: "Q_LOOP", value: 5 }, { ...survey(), loop: loopCtx });
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.answers["q_loop@g"], 5);
  assert.equal(applyScriptWrite(def, s, { kind: "answer", ref: "Q_LOOP", value: 6, loopKey: "a" }, survey()).ok, true);
  assert.equal(s.answers["q_loop@a"], 6);
  assert.match(applyScriptWrite(def, s, { kind: "answer", ref: "Q_LOOP", value: 6 }, survey()).reason!, /name the iteration/);
  assert.match(applyScriptWrite(def, s, { kind: "answer", ref: "Q_LOOP", value: 6, loopKey: "zz" }, survey()).reason!, /not an iteration/);
  assert.match(applyScriptWrite(def, s, { kind: "answer", ref: "Q_LATER", value: "1", loopKey: "a" }, survey()).reason!, /not inside a loop/);
});

test("punches and calculations recompute after a script write, as after a respondent change", () => {
  const s = fresh();
  assert.equal(s.answers.h_seg, undefined);
  assert.equal(applyScriptWrite(def, s, { kind: "answer", ref: "H_SRC", value: "1" }, survey()).ok, true);
  assert.deepEqual(s.answers.h_seg, "Y", "the hidden SEG punched from the script-written H_SRC");
  // embedded: typed, then the on_change calculation reads it
  assert.equal(applyScriptWrite(def, s, { kind: "embedded", name: "SCORE", value: "21" }, survey()).ok, true);
  assert.equal(s.embedded.SCORE, 21);
  assert.equal(s.calculated.SRC_TWICE, 42);
  assert.match(applyScriptWrite(def, s, { kind: "embedded", name: "SCORE", value: "abc" }, survey()).reason!, /SCORE/);
  assert.match(applyScriptWrite(def, s, { kind: "embedded", name: "UNDECLARED", value: "x" }, survey()).reason!, /not an embedded field/);
  // calculated: a script variable, a typed declared one; refused when a calculation recomputes it on every change
  assert.equal(applyScriptWrite(def, s, { kind: "calculated", name: "MY_VAR", value: "hi" }, survey()).ok, true);
  assert.equal(s.calculated.MY_VAR, "hi");
  assert.match(applyScriptWrite(def, s, { kind: "calculated", name: "PAGE_SCORE", value: 3 }, survey()).reason!, /computed by calculation c_submit \(on_page_submit\)/);
  assert.match(applyScriptWrite(def, s, { kind: "calculated", name: "SRC_TWICE", value: 1 }, survey()).reason!, /computed by calculation c_twice/);
  assert.match(applyScriptWrite(def, s, { kind: "calculated", name: "MY_VAR", value: { a: 1 } }, survey()).reason!, /holds text, a number/);
  assert.match(applyScriptWrite(def, s, { kind: "calculated", name: "LOOP_BRAND_COUNT", value: 1 }, survey()).reason!, /computed by the engine/);
  assert.match(applyScriptWrite(def, s, { kind: "calculated", name: "Q_NUM", value: 1 }, survey()).reason!, /is a question/);
  assert.match(applyScriptWrite(def, s, { kind: "calculated", name: "bad name!", value: 1 }, survey()).reason!, /not a valid/);
  // flags: once each
  applyScriptWrite(def, s, { kind: "flag", name: "speeder" }, survey());
  applyScriptWrite(def, s, { kind: "flag", name: "speeder" }, survey());
  assert.deepEqual(s.flags.filter((f) => f === "speeder"), ["speeder"]);
});

test("paradata: each accepted write recorded with script, kind, target and time — never the value", () => {
  const s = fresh();
  applyScriptWrite(def, s, { kind: "answer", ref: "Q_TEXT", value: "my secret open end" }, own("q_text"));
  applyScriptWrite(def, s, { kind: "answer", ref: "Q_SINGLE", value: "9" }, own("q_single")); // refused: not recorded
  applyScriptWrite(def, s, { kind: "embedded", name: "SOURCE", value: "panel" }, survey());
  applyScriptWrite(def, s, { kind: "flag", name: "f1" }, survey());
  assert.deepEqual(s.scriptWrites, [
    { script: "b_q_text", kind: "answer", target: "q_text", at: "2026-10-30T00:00:00.000Z" },
    { script: "b_survey", kind: "embedded", target: "SOURCE", at: "2026-10-30T00:00:00.000Z" },
    { script: "b_survey", kind: "flag", target: "f1", at: "2026-10-30T00:00:00.000Z" },
  ]);
  assert.ok(!JSON.stringify(s.scriptWrites).includes("secret"), "the open end's text is not in the paradata");
  // the save route's sanitiser keeps only well-formed records
  assert.deepEqual(sanitizeScriptWrites([...s.scriptWrites!, { kind: "nope", target: "x" }, "junk", { kind: "answer", target: "" }]), s.scriptWrites);
});

/* ---------------------------------------------------------------- item 4: the server replay */
import { checkSubmission } from "./serverValidation.js";
import { advance, setAnswer } from "./flow.js";

test("server replay: a value a script wrote that the server cannot derive is script_written (soft); a forged claim is not believed", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "sw4", code: "SW4", title: "Replay", version: "1" },
    questions: [
      Q("q_age", "numeric"),
      Q("q_dl", "open_text", { displayLogic: { type: "rule", source: { kind: "question", ref: "q_age" }, operator: "lt", value: -1 } }),
      Q("h_seg", "hidden", { options: [{ code: "Y", label: "Young" }, { code: "O", label: "Old" }],
        punches: [{ id: "p1", source: { kind: "codes", codes: ["Y"] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always", when: { type: "rule", source: { kind: "question", ref: "q_age" }, operator: "lt", value: 40 } }] }),
      Q("q_end", "open_text"),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_age", "q_dl"] }, { type: "page", id: "p2", questionIds: ["q_end"] }, { type: "end", id: "e", status: "complete" }],
    calculations: [{ id: "c1", targetVariable: "AGE_X2", expression: "Q_AGE * 2", trigger: "on_page_submit" }],
  });
  const s = createResponseState(d, { seed: 9, sessionId: "s-sw4" });
  start(d, s);
  setAnswer(d, s, "q_age", 30);
  advance(d, s);
  const ctx: ScriptWriteContext = { scriptId: "b_p2", scope: { kind: "survey" }, shown: ["q_end"] };
  assert.equal(applyScriptWrite(d, s, { kind: "answer", ref: "Q_DL", value: "set by code" }, ctx).ok, true);
  assert.equal(applyScriptWrite(d, s, { kind: "calculated", name: "CLICKS", value: 4 }, ctx).ok, true);
  setAnswer(d, s, "q_end", "done");
  advance(d, s);
  const posted = { answers: { ...s.answers }, calculated: { ...s.calculated }, embedded: s.embedded, flags: s.flags, stepIndex: s.stepIndex, status: "complete", completed: true };
  const run = (extra: Record<string, unknown>) => checkSubmission({ def: d, prior: { seed: 9, sessionId: "s-sw4" }, posted: { ...posted, ...extra } as never });
  // without the paradata: the question the replay never showed is "not_asked"
  assert.ok(run({}).soft.some((p) => p.code === "not_asked" && p.questionId === "q_dl"));
  // with it: script_written, nothing else; the script's own variable is kept as posted (the server derives no CLICKS)
  const withW = run({ scriptWrites: s.scriptWrites });
  assert.equal(withW.ok, true);
  assert.deepEqual(withW.soft.map((p) => [p.code, p.questionId ?? p.variable]), [["script_written", "q_dl"]], JSON.stringify(withW.soft));
  assert.ok(!JSON.stringify(withW.soft).includes("set by code"), "an open end's text never reaches the problem list");
  // a FORGED claim on what the channel always refuses (a punch rule that owns h_seg, a declared calculation) is not believed
  const forged = run({ answers: { ...posted.answers, h_seg: "O" }, calculated: { ...posted.calculated, AGE_X2: 1 }, scriptWrites: [...s.scriptWrites!, { script: "x", kind: "answer", target: "h_seg", at: "" }, { script: "x", kind: "calculated", target: "AGE_X2", at: "" }] });
  const mm = forged.soft.filter((p) => p.code === "server_mismatch").map((p) => p.questionId ?? p.variable).sort();
  assert.deepEqual(mm, ["AGE_X2", "h_seg"], JSON.stringify(forged.soft));
  assert.equal(forged.recomputed?.answers.h_seg, "Y", "under store the server's value still wins");
});
