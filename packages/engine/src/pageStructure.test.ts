/**
 * 2026-11-12 — what may answer or leave a question by itself (consent.ts, singleOption modes, auto-next), the page
 * structure rules and their repair (structureLint.ts), and placing / moving blocks (blockPlacement.ts, move_block).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, type ResponseState } from "./state.js";
import { start, advance, setAnswer, visibleQuestions, type NavigationResult } from "./flow.js";
import { autoAnswered } from "./singleOption.js";
import { isConsentQuestion } from "./consent.js";
import { autoNextKind, autoNextReady } from "./autoNext.js";
import { lintPageStructure, fixPageStructure } from "./structureLint.js";
import { previewBlockMove, moveBlockTo, insertBlockAt, blockPositionChoices } from "./blockPlacement.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { runQualityCheck } from "./qualityCheck.js";
import { listBlocks } from "./blocks.js";

const sel = (ref: string, value: number) => ({ type: "rule", source: { kind: "question", ref }, operator: "selected", value });
const opt = (code: number, label: string, extra: Record<string, unknown> = {}) => ({ code, label, flags: [], ...extra });
const q = (id: string, type: string, options: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id, code: id, variableName: id, type, text: id, options, rows: [], columns: [], validation: [], required: true,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const YN = [opt(1, "Yes"), opt(2, "No")];
const BRANDS = [opt(1, "Alpha"), opt(2, "Beta"), opt(3, "Gamma")];
const page = (id: string, ids: string[], extra: Record<string, unknown> = {}) => ({ id, type: "page", questionIds: ids, ...extra });
const survey = (questions: unknown[], flow: unknown[], more: Record<string, unknown> = {}): SurveyDefinition =>
  SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Structure", version: "1.0" }, questions, flow, ...more });
const pageOf = (r: NavigationResult) => { const s = r.steps[r.stepIndex]; return r.done ? "END" : s.kind === "page" ? s.pageId : s.kind; };
const shown = (def: SurveyDefinition, r: NavigationResult, state: ResponseState) => { const s = r.steps[r.stepIndex]; return s.kind === "page" ? visibleQuestions(def, s, state).map((x) => x.id) : []; };
const pagesOf = (def: SurveyDefinition) => { const out: string[][] = []; const walk = (ns: any[]) => { for (const n of ns) { if (n.type === "page") out.push(n.questionIds); if (n.children) walk(n.children); } }; walk(def.flow as any[]); return out; };

/* ------------------------------------------------------------------ consent */

test("a consent question is recognised from its name or its wording, and the author's setting overrides both", () => {
  assert.equal(isConsentQuestion(q("CONSENT", "single_select", YN) as never), true);
  assert.equal(isConsentQuestion(q("S0", "single_select", YN, { text: "Do you agree to take part in this study?" }) as never), true);
  assert.equal(isConsentQuestion(q("S0", "multi_select", [opt(1, "I agree")], { text: "<p>I consent to the processing of my answers.</p>" }) as never), true);
  assert.equal(isConsentQuestion(q("Q1", "single_select", YN, { text: "Do you own a car?" }) as never), false);
  assert.equal(isConsentQuestion(q("Q1", "open_text", [], { text: "Do you agree to take part?" }) as never), false, "only a choice question records consent");
  assert.equal(isConsentQuestion(q("Q1", "single_select", YN, { text: "Do you own a car?", settings: { consent: true } }) as never), true);
  assert.equal(isConsentQuestion(q("CONSENT", "single_select", YN, { settings: { consent: false } }) as never), false);
});

test("consent is never answered for the respondent: not by an auto-punch rule, a default, or the single-option rule", () => {
  const punch = [{ id: "p", source: { kind: "codes", codes: [1] }, action: "select", recompute: "always", when: sel("Q1", 1) }];
  const def = survey([
    q("Q1", "single_select", YN),
    q("CONSENT", "single_select", YN, { punches: punch }),
    q("Q2", "single_select", YN, { punches: punch }),
    q("AGREE", "single_select", YN, { text: "Do you agree to take part?", settings: { defaultValue: 1 } }),
  ], [page("p1", ["Q1"]), page("p2", ["CONSENT"]), page("p3", ["Q2"]), page("p4", ["AGREE"])]);
  const state = createResponseState(def, { seed: 1 });
  let r = start(def, state, {});
  setAnswer(def, state, "Q1", 1 as never);
  r = advance(def, state, {});
  assert.equal(pageOf(r), "p2");
  assert.equal(state.answers.CONSENT, undefined, "the punch rule does not select consent");
  setAnswer(def, state, "CONSENT", 1 as never);
  r = advance(def, state, {});
  assert.equal(state.answers.Q2, 1, "the same rule on an ordinary question selects the matching answer on the next page");
  r = advance(def, state, {});
  assert.equal(pageOf(r), "p4");
  assert.equal(state.answers.AGREE, undefined, "a default value does not answer consent");

  /* a consent list narrowed to one answer is still asked */
  const narrowed = survey([
    q("Q1", "multi_select", BRANDS),
    q("CONSENT", "multi_select", BRANDS.map((o) => ({ ...o, visibleIf: sel("Q1", o.code) })), { text: "Which of these do you consent to being contacted about?" }),
  ], [page("p1", ["Q1"]), page("p2", ["CONSENT"])]);
  const s2 = createResponseState(narrowed, { seed: 1 });
  start(narrowed, s2, {});
  setAnswer(narrowed, s2, "Q1", [2] as never);
  const r2 = advance(narrowed, s2, {});
  assert.equal(pageOf(r2), "p2");
  assert.deepEqual(shown(narrowed, r2, s2), ["CONSENT"]);
  assert.equal(s2.answers.CONSENT, undefined);
});

test("consent never moves the page on: no auto-next kind, and a page holding it waits for Next", () => {
  const consent = q("CONSENT", "single_select", YN);
  const plain = q("Q1", "single_select", YN);
  assert.equal(autoNextKind(plain as never), "single");
  assert.equal(autoNextKind(consent as never), null);
  const def = survey([plain, consent], [page("p1", ["Q1", "CONSENT"])], { branding: { layout: { autoAdvance: true } } });
  const [a, b] = def.questions;
  assert.equal(autoNextReady(def, [a], () => 1), true, "an answered single choice moves its page on");
  assert.equal(autoNextReady(def, [b], () => 1), false, "an answered consent question does not");
  assert.equal(autoNextReady(def, [a, b], () => 1), false, "…and neither does a page that holds one");
  assert.equal(autoNextReady(def, [{ ...b, settings: { ...b.settings, autoNext: true } } as never], () => 1), false, "even when switched on for the question");
});

/* ------------------------------------------- selecting and skipping are separate */

test("the single-option rule: skip (default) answers and hides; select answers and shows; ask does neither", () => {
  const make = (mode?: string) => survey([
    q("Q1", "multi_select", BRANDS),
    q("Q2", "single_select", BRANDS.map((o) => ({ ...o, visibleIf: sel("Q1", o.code) })), mode ? { settings: { singleOption: mode } } : {}),
    q("Q3", "open_text", [], { required: false }),
  ], [page("p1", ["Q1"]), page("p2", ["Q2"]), page("p3", ["Q3"])]);
  const run = (mode?: string) => { const def = make(mode); const state = createResponseState(def, { seed: 1 }); start(def, state, {}); setAnswer(def, state, "Q1", [3] as never); const r = advance(def, state, {}); return { def, state, r }; };

  const skip = run();
  assert.equal(pageOf(skip.r), "p3");
  assert.equal(skip.state.answers.Q2, 3);
  assert.deepEqual(autoAnswered(skip.state), ["Q2"]);

  const select = run("select");
  assert.equal(pageOf(select.r), "p2", "the page is shown");
  assert.deepEqual(shown(select.def, select.r, select.state), ["Q2"]);
  assert.equal(select.state.answers.Q2, 3, "with the one answer already selected");
  assert.deepEqual(autoAnswered(select.state), ["Q2"], "and still marked as given by the engine");
  assert.equal(pageOf(advance(select.def, select.state, {})), "p3", "Next leaves it");

  const ask = run("ask");
  assert.equal(pageOf(ask.r), "p2");
  assert.equal(ask.state.answers.Q2, undefined);
  assert.deepEqual(autoAnswered(ask.state), []);
});

/* ------------------------------------------------------------ page structure */

const design = { id: "d1", kind: "maxdiff", name: "D", version: 1, seed: 1, config: {}, file: { format: "json", columns: ["version", "task", "item_index", "item_label"], rows: Array.from({ length: 6 }, (_, t) => [1, 2, 3].map((i) => ({ version: 1, task: t + 1, item_index: i, item_label: `Item ${i}` }))).flat() } };

test("lint + repair: an exercise, consent, the four price questions, two stimuli and a funnel stage each get their page — ids and order kept", () => {
  const def = survey([
    q("CONSENT", "single_select", YN), q("AGE", "numeric"),
    q("INTRO", "html", [], { required: false }), q("MD", "maxdiff_task", [], { settings: { designRef: "d1" } }), q("WHY", "open_text"),
    q("PSM_TOO_CHEAP", "numeric"), q("PSM_CHEAP", "numeric"), q("PSM_EXPENSIVE", "numeric"), q("PSM_TOO_EXPENSIVE", "numeric"),
    q("C1_SHOW", "html", [], { required: false }), q("C1_APPEAL", "single_select", YN), q("C2_SHOW", "html", [], { required: false }), q("C2_APPEAL", "single_select", YN),
    q("AWARE", "multi_select", BRANDS), q("USED", "multi_select", [], { carryForward: { sourceQuestionId: "AWARE", filter: "selected", into: "options" } }),
    q("A", "single_select", YN), q("B", "single_select", YN), q("C", "open_text"),
  ], [
    page("p1", ["CONSENT", "AGE"]), page("p2", ["INTRO", "MD", "WHY"]), page("p3", ["PSM_TOO_CHEAP", "PSM_CHEAP", "PSM_EXPENSIVE", "PSM_TOO_EXPENSIVE"]),
    page("p4", ["C1_SHOW", "C1_APPEAL", "C2_SHOW", "C2_APPEAL"], { title: "Concepts", visibleIf: sel("CONSENT", 1) }), page("p5", ["AWARE", "USED"]), page("p6", ["A", "B", "C"]),
  ], { designs: [design] });
  const issues = lintPageStructure(def);
  assert.deepEqual(issues.map((i) => i.code).sort(), ["consent_shares_page", "funnel_shares_page", "price_questions_share_page", "stimuli_share_page", "task_shares_page"]);
  assert.ok(issues.every((i) => i.fix === "auto"));
  assert.equal(runQualityCheck(def).areas.flatMap((a) => a.issues).filter((i) => /page of its own|its own page|same page/.test(i.message)).length >= 4, true, "the quality check reports them");

  const fixed = fixPageStructure(def);
  assert.equal(fixed.applied.length, 5);
  assert.deepEqual(pagesOf(fixed.def), [
    ["CONSENT"], ["AGE"], ["INTRO", "MD"], ["WHY"], ["PSM_TOO_CHEAP"], ["PSM_CHEAP"], ["PSM_EXPENSIVE"], ["PSM_TOO_EXPENSIVE"],
    ["C1_SHOW", "C1_APPEAL"], ["C2_SHOW", "C2_APPEAL"], ["AWARE"], ["USED"], ["A", "B", "C"],
  ], "an introduction stays with its exercise; an ordinary page of related questions is left alone");
  assert.deepEqual(fixed.def.questions, def.questions, "no question is touched");
  const p4 = (fixed.def.flow as any[]).filter((n) => n.title === "Concepts");
  assert.equal(p4.length, 2);
  assert.deepEqual(p4.map((n) => n.id), ["p4", "p4_2"], "the first part keeps the page id");
  assert.ok(p4.every((n) => n.visibleIf), "each part keeps the page's display condition");
  assert.deepEqual(lintPageStructure(fixed.def), [], "nothing left to report");
  assert.doesNotThrow(() => SurveyDefinition.parse(fixed.def));
  assert.deepEqual(lintPageStructure(input()), [], "a well laid out survey has no findings");
  function input() { return survey([q("A", "single_select", YN), q("B", "single_select", YN), q("C", "open_text")], [page("p1", ["A", "B", "C"])]); }
});

test("judgements are asked, not decided: a long page, stacked tasks, plain notes above questions, a page directly in a randomizer", () => {
  const many = Array.from({ length: 10 }, (_, i) => q(`L${i + 1}`, "single_select", YN));
  const def = survey([
    ...many,
    q("MD", "maxdiff_task", [], { settings: { designRef: "d1", taskPaging: "all" } }),
    q("N1", "html", [], { required: false }), q("X1", "single_select", YN), q("N2", "html", [], { required: false }), q("X2", "single_select", YN),
    q("CONSENT", "single_select", YN), q("Z", "numeric"),
  ], [
    page("long", many.map((x) => x.id)), page("md", ["MD"]), page("notes", ["N1", "X1", "N2", "X2"]),
    { id: "r", type: "randomizer", children: [page("rp", ["CONSENT", "Z"]), page("rp2", [])] },
  ], { designs: [design] });
  const issues = lintPageStructure(def);
  assert.deepEqual(issues.map((i) => `${i.code}:${i.fix}`).sort(), ["consent_shares_page:ask", "long_page:ask", "stacked_tasks:ask", "stimuli_share_page:ask"]);
  const fixed = fixPageStructure(def);
  assert.equal(fixed.applied.length, 0);
  assert.deepEqual(fixed.def.flow, def.flow, "nothing is rearranged");
  assert.equal(fixed.ask.length, 4);
});

test("consent with a rule that answers or leaves it: the automation is removed, the question is kept", () => {
  const def = survey([q("Q1", "single_select", YN), q("CONSENT", "single_select", YN, { punches: [{ id: "p", source: { kind: "codes", codes: [1] }, action: "select", recompute: "always", when: sel("Q1", 1) }], settings: { autoNext: true } })], [page("p1", ["Q1"]), page("p2", ["CONSENT"])]);
  assert.deepEqual(lintPageStructure(def).map((i) => i.code), ["consent_automated"]);
  const fixed = fixPageStructure(def).def;
  const c = fixed.questions.find((x) => x.id === "CONSENT")!;
  assert.equal(c.punches?.length ?? 0, 0);
  assert.equal((c.settings as { autoNext?: boolean }).autoNext, undefined);
  assert.deepEqual(lintPageStructure(fixed), []);
});

test("the action gate repairs what a batch lays out wrongly, says so, and leaves an existing layout alone", () => {
  const empty = survey([], []);
  const acts = coerceSurveyActions([
    { op: "create_block", title: "Start", ref: "b" },
    { op: "create_question", block: "b", ref: "c", type: "single_select", code: "CONSENT", text: "Do you agree to take part in this study?", options: ["Yes", "No"] },
    { op: "create_question", block: "b", ref: "a", type: "numeric", code: "AGE", text: "How old are you?" },
  ]);
  assert.deepEqual(acts.rejected, []);
  const out = applySurveyActions(empty, acts.actions);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(pagesOf(out.def).map((p) => p.length), [1, 1], "consent was given its own page");
  assert.ok(out.warnings.some((w) => /Page structure \(corrected\).*consent/i.test(w)), out.warnings.join(" | "));

  /* a survey that already has the layout: an unrelated change does not rearrange it */
  const existing = survey([q("CONSENT", "single_select", YN), q("AGE", "numeric")], [{ id: "b1", type: "block", title: "Start", children: [page("p1", ["CONSENT", "AGE"])] }]);
  const edit = coerceSurveyActions([{ op: "update_question", target: "AGE", text: "What is your age?" }]);
  const out2 = applySurveyActions(existing, edit.actions);
  assert.deepEqual(out2.errors, []);
  assert.deepEqual(pagesOf(out2.def), [["CONSENT", "AGE"]]);
  assert.equal(out2.warnings.some((w) => /Page structure/.test(w)), false);
});

/* ------------------------------------------------------------ blocks */

const blocked = () => survey([
  q("S1", "single_select", YN), q("A1", "multi_select", BRANDS),
  q("B1", "single_select", [], { carryForward: { sourceQuestionId: "A1", filter: "selected", into: "options" } }),
  q("C1", "open_text", [], { displayLogic: sel("S1", 1), text: "You said {{A1}} — why?" }),
], [
  { id: "ed", type: "embedded_data", fields: [{ name: "SRC", source: "url" }] },
  { id: "bS", type: "block", title: "Screener", children: [page("pS", ["S1"])] },
  { id: "bA", type: "block", title: "Awareness", children: [page("pA", ["A1"])] },
  { id: "sec", type: "section", title: "Main", children: [{ id: "bB", type: "block", title: "Usage", children: [page("pB", ["B1"])] }, { id: "bC", type: "block", title: "Reasons", children: [page("pC", ["C1"])] }] },
  { id: "end", type: "end", status: "complete" },
]);
const titles = (def: SurveyDefinition) => listBlocks(def.flow as unknown[]).map((b) => b.title);

test("a block can be created at the beginning, before a block, after a block, or at the end", () => {
  const node = (id: string, title: string) => ({ id, type: "block", title, children: [page(`${id}_p`, [])] }) as never;
  const d = blocked();
  assert.equal(insertBlockAt(d, node("n1", "First"), { at: "start" }), null);
  assert.equal(insertBlockAt(d, node("n2", "Before usage"), { at: "before", block: "bB" }), null);
  assert.equal(insertBlockAt(d, node("n3", "After awareness"), { at: "after", block: "bA" }), null);
  assert.equal(insertBlockAt(d, node("n4", "Last"), { at: "end" }), null);
  assert.deepEqual(titles(d), ["First", "Screener", "Awareness", "After awareness", "Before usage", "Usage", "Reasons", "Last"]);
  assert.equal((d.flow as any[])[0].type, "embedded_data", "the set-up stays first");
  assert.equal((d.flow as any[]).at(-1).type, "end", "the End stays last");
  assert.deepEqual((d.flow as any[]).find((n) => n.id === "sec").children.map((n: any) => n.title), ["Before usage", "Usage", "Reasons"], "“before Usage” lands beside it, inside its section");
  assert.match(String(insertBlockAt(d, node("n5", "X"), { at: "before", block: "nope" })), /no block/);
  assert.doesNotThrow(() => SurveyDefinition.parse(d));

  /* the same through actions */
  const acts = coerceSurveyActions([{ op: "create_block", title: "Warm-up", before: "Awareness" }, { op: "create_block", title: "Intro", after: "start" }, { op: "create_block", title: "Both", before: "Usage", after: "Usage" }]);
  assert.equal(acts.rejected.length, 1, "before AND after is refused");
  const out = applySurveyActions(blocked(), acts.actions);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(titles(out.def), ["Intro", "Screener", "Warm-up", "Awareness", "Usage", "Reasons"]);
});

test("moving a block keeps every id, variable and rule; the preview shows the new order and what it would break", () => {
  const def = blocked();
  const ok = previewBlockMove(def, "bC", { at: "before", block: "bB" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.after.map((b) => b.title), ["Screener", "Awareness", "Reasons", "Usage"]);
  assert.equal(ok.after.find((b) => b.moved)?.title, "Reasons");
  assert.deepEqual(ok.conflicts, [], "Reasons reads only the screener and awareness, which still come first");
  assert.deepEqual(def.flow, blocked().flow, "a preview changes nothing");

  const bad = previewBlockMove(def, "bA", { at: "end" });
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.after.map((b) => b.title), ["Screener", "Usage", "Reasons", "Awareness"]);
  assert.equal(bad.conflicts.length, 2, bad.conflicts.join(" | "));
  assert.ok(bad.conflicts.some((c) => /B1 uses the answer to A1, which would now be asked after it/.test(c)), "carry-forward");
  assert.ok(bad.conflicts.some((c) => /C1 uses the answer to A1/.test(c)), "piping");

  const same = previewBlockMove(def, "bS", { at: "start" });
  assert.equal(same.unchanged, true);
  assert.match(String(previewBlockMove(def, "bB", { at: "after", block: "bB" }).error), /next to itself/);
  assert.match(String(previewBlockMove(def, "sec", { at: "before", block: "bC" }).error), /inside itself/);

  const moved = structuredClone(def);
  assert.equal(moveBlockTo(moved, "bC", { at: "after", block: "bS" }), null);
  assert.deepEqual(titles(moved), ["Screener", "Reasons", "Awareness", "Usage"]);
  assert.deepEqual(moved.questions, def.questions, "questions — ids, variables, logic, piping, carry-forward — are untouched");
  assert.equal(listBlocks(moved.flow as unknown[]).find((b) => b.title === "Reasons")!.id, "bC", "the block keeps its id");
  assert.doesNotThrow(() => SurveyDefinition.parse(moved));
  assert.ok(blockPositionChoices(def, "bA").every((c) => !("block" in c.position) || c.position.block !== "bA"), "a block is not offered a place next to itself");
  assert.equal(blockPositionChoices(def).length, 2 + 2 * 4);
});

test("move_block as an action: before / after / to, with the conflicts reported and nothing lost", () => {
  const def = blocked();
  const acts = coerceSurveyActions([{ op: "move_block", target: "Reasons", before: "Usage" }]);
  assert.deepEqual(acts.rejected, []);
  const out = applySurveyActions(def, acts.actions);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(titles(out.def), ["Screener", "Awareness", "Reasons", "Usage"]);
  assert.equal(out.warnings.some((w) => /Moving/.test(w)), false);

  const risky = applySurveyActions(def, coerceSurveyActions([{ op: "move_block", target: "Awareness", to: "end" }]).actions);
  assert.deepEqual(risky.errors, []);
  assert.deepEqual(titles(risky.def), ["Screener", "Usage", "Reasons", "Awareness"]);
  assert.ok(risky.warnings.some((w) => /Moving “Awareness”: B1 uses the answer to A1/.test(w)), risky.warnings.join(" | "));
  assert.deepEqual(risky.def.questions.map((x) => x.id), def.questions.map((x) => x.id));

  assert.equal(coerceSurveyActions([{ op: "move_block", target: "Usage" }]).rejected.length, 1, "a move needs a place");
  assert.equal(coerceSurveyActions([{ op: "move_block", target: "Usage", before: "Reasons", to: "end" }]).rejected.length, 1);
  const none = applySurveyActions(def, coerceSurveyActions([{ op: "move_block", target: "Usage", before: "Nowhere" }]).actions);
  assert.equal(none.errors.length, 1);
  assert.deepEqual(none.def.flow, def.flow);
});

test("the settings are set by an action and checked: consent, singleOption anywhere; task paging only on a choice exercise", () => {
  const def = survey([q("Q1", "single_select", YN), q("MD", "maxdiff_task", [], { settings: { designRef: "d1" } })], [page("p1", ["Q1"]), page("p2", ["MD"])], { designs: [design] });
  const ok = applySurveyActions(def, coerceSurveyActions([
    { op: "update_question", target: "Q1", settings: { consent: true, singleOption: "select" } },
    { op: "update_question", target: "MD", settings: { taskPaging: "all", taskAutoNext: true } },
  ]).actions);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual({ ...ok.def.questions[0].settings }.consent, true);
  assert.equal((ok.def.questions[0].settings as { singleOption?: string }).singleOption, "select");
  assert.equal((ok.def.questions[1].settings as { taskPaging?: string }).taskPaging, "all");
  for (const bad of [{ target: "Q1", settings: { taskPaging: "all" } }, { target: "Q1", settings: { singleOption: "sometimes" } }, { target: "MD", settings: { taskPaging: "two" } }, { target: "Q1", settings: { consent: "yes" } }]) {
    const r = applySurveyActions(def, coerceSurveyActions([{ op: "update_question", ...bad }]).actions);
    assert.equal(r.errors.length, 1, JSON.stringify(bad));
  }
});
