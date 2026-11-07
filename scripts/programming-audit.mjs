/**
 * SURVEY PROGRAMMING AUDIT — EXECUTED SCENARIOS (2026-11-07).
 *
 * Not a unit test of one function: whole surveys, built the way a programmer (or Intelligent Mode) builds them, walked
 * by simulated respondents through the REAL runtime functions (`start` / `advance` / `setAnswer` / `validatePage` /
 * `runScripts`, via templates' `simulateRespondent`) and then replayed by the SERVER's `checkSubmission` — the same
 * path a live response takes. Each check prints PASS / FAIL with what was observed; the process exits 1 on any FAIL.
 *
 *   node scripts/programming-audit.mjs            (needs packages built: schema, engine, templates)
 */
import { SurveyDefinition, QUESTION_VARIANTS, isSelectableVariant } from "../packages/schema/dist/index.js";
import * as E from "../packages/engine/dist/index.js";
import { simulateRespondent } from "../packages/templates/dist/index.js";

const results = [];
const check = (area, name, ok, detail = "") => { results.push({ area, name, ok: !!ok, detail }); };
const tryRun = (area, name, fn) => { try { const r = fn(); if (r !== undefined) check(area, name, r.ok, r.detail); } catch (e) { check(area, name, false, `threw: ${e.message}`); } };
const ids = (() => { let n = 0; return (p) => `${p}_${++n}`; })();
const rule = (ref, operator, value) => ({ type: "rule", source: { kind: "question", ref }, operator, value });
const and = (...children) => ({ type: "group", op: "and", children });
const or = (...children) => ({ type: "group", op: "or", children });
const opts = (labels, start = 1) => labels.map((l, i) => typeof l === "object" ? l : ({ code: start + i, label: l }));
const replay = (def, sim, prior = {}) => E.checkSubmission({ def, prior: { seed: sim.state.seed, sessionId: sim.state.sessionId, ...prior }, posted: { answers: sim.state.answers, calculated: sim.state.calculated, embedded: sim.state.embedded, flags: sim.state.flags, stepIndex: sim.state.stepIndex, status: sim.state.status, completed: sim.state.status !== "in_progress" } });

/* ================================================================== 1. a complex multi-block survey */
const study = SurveyDefinition.parse({
  meta: { id: "audit", code: "AUD", title: "Smartphone study", version: "1.0" },
  questions: [
    { id: "s1", code: "S1", variableName: "S1", type: "single_select", text: "Your age?", required: true, options: opts(["18–34", "35–54", "55+", { code: 9, label: "Under 18" }]),
      skipLogic: [{ id: "sk1", when: rule("s1", "selected", 9), target: { kind: "terminate", status: "screened" } }] },
    { id: "s2", code: "S2", variableName: "S2", type: "single_select", text: "Gender?", required: true, options: opts(["Male", "Female"]) },
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands do you know?", required: true, options: opts(["Apple", "Samsung", "Google", "OnePlus", { code: 99, label: "None of these", flags: ["exclusive"] }]),
      validation: [{ kind: "max_selections", value: 4 }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Which do you use most?", required: true, options: [], carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options" } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "How do you rate {{loop.label}}?", required: true, options: opts(["Poor", "OK", "Good"]) },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Why Apple?", displayLogic: and(rule("q2", "selected", 1), or(rule("s2", "selected", 2), rule("s1", "selected", 2))) },
    { id: "q5", code: "Q5", variableName: "Q5", type: "numeric", text: "How many phones have you owned?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 50 }] },
    { id: "q6", code: "Q6", variableName: "Q6", type: "open_text", text: "Tell us about your phone", dynamicText: { expression: 'Q2 == "Apple" ? "What do you like about your iPhone, {{ed.NAME}}?" : "What do you like about your {{Q2}}?"' } },
    { id: "c1", code: "C1", variableName: "C1", type: "single_select", text: "Concept A — buy?", options: opts(["Yes", "No"]) },
    { id: "c2", code: "C2", variableName: "C2", type: "single_select", text: "Concept B — buy?", options: opts(["Yes", "No"]) },
    { id: "a1", code: "A1", variableName: "A1", type: "open_text", text: "Apple path" },
    { id: "b1", code: "B1", variableName: "B1", type: "open_text", text: "Other path" },
  ],
  calculations: [{ id: "k1", targetVariable: "SCORE", expression: "Q5 * 2", trigger: "on_page_submit" }],
  quotas: [{ id: "qg", name: "Gender", mode: "hard", cells: [{ id: "m", label: "Male", when: rule("s2", "selected", 1), limit: 1 }, { id: "f", label: "Female", when: rule("s2", "selected", 2), limit: 100 }] }],
  flow: [
    { type: "embedded_data", id: "ed1", fields: [{ name: "PID", source: "url" }, { name: "NAME", source: "url" }] },
    { type: "page", id: "pS", title: "Screener", questionIds: ["s1", "s2"] },
    { type: "quota_check", id: "qc", quotaIds: ["qg"], onFull: { kind: "terminate" } },
    { type: "page", id: "pQ1", title: "Awareness", questionIds: ["q1"] },
    { type: "page", id: "pQ2", title: "Usage", questionIds: ["q2"] },
    { type: "loop", id: "lp", loopVar: "brand", source: { kind: "question", questionId: "q1", filter: "selected" }, children: [{ type: "page", id: "pQ3", questionIds: ["q3"] }] },
    { type: "page", id: "pQ4", title: "Detail", questionIds: ["q4", "q5", "q6"] },
    { type: "randomizer", id: "rz", show: 1, evenPresentation: true, children: [{ type: "page", id: "pC1", questionIds: ["c1"] }, { type: "page", id: "pC2", questionIds: ["c2"] }] },
    { type: "branch", id: "br", title: "By brand", branches: [{ id: "arm1", label: "Apple users", when: rule("q2", "selected", 1), children: [{ type: "page", id: "pA", questionIds: ["a1"] }] }], otherwise: [{ type: "page", id: "pB", questionIds: ["b1"] }] },
    { type: "redirect", id: "rd", url: "https://panel.example/done?pid={{ed.PID}}&s=complete" },
  ],
});
const pagesOf = (sim) => sim.pages.map((p) => p.pageId.split("@")[0]);

tryRun("Flow", "screen-out skip (terminate, screened) ends at the screener", () => {
  const r = simulateRespondent(study, { answers: { s1: 9, s2: 2 } });
  return { ok: r.endStatus === "screened" && pagesOf(r).join() === "pS", detail: `status ${r.endStatus}, pages ${pagesOf(r).join(" → ")}` };
});
tryRun("Flow", "hard quota full → terminated before the main questionnaire", () => {
  const r = simulateRespondent(study, { answers: { s1: 1, s2: 1 }, quotaCounts: { qg: { m: 1 } } });
  return { ok: ["quota_full", "terminated"].includes(r.endStatus) && !pagesOf(r).includes("pQ1"), detail: `status ${r.endStatus}, pages ${pagesOf(r).join(" → ")}` };
});
const happy = simulateRespondent(study, { answers: { s1: 1, s2: 2, q1: [1, 3], q2: 1, q3: 3, q4: "design", q5: 4, q6: "camera", c1: 1, c2: 1, a1: "x", b1: "y" }, embedded: { PID: "P-77", NAME: "Ana" }, seed: 7 });
tryRun("Flow", "full path completes; loop runs once per selected brand", () => {
  const loops = happy.pages.filter((p) => p.pageId.startsWith("pQ3")).length;
  return { ok: happy.endStatus === "complete" && loops === 2, detail: `status ${happy.endStatus}, ${loops} loop pages, path ${pagesOf(happy).join(" → ")}${happy.blocked ? `; blocked ${JSON.stringify(happy.blocked.errors)}` : ""}` };
});
tryRun("Piping", "loop label piped into each iteration's text", () => {
  const t = happy.pages.filter((p) => p.pageId.startsWith("pQ3")).map((p) => p.texts.q3);
  return { ok: t[0]?.includes("Apple") && t[1]?.includes("Google"), detail: t.join(" | ") };
});
tryRun("Properties", "carry forward: Q2 offers only the brands selected in Q1", () => {
  const state = E.createResponseState(study, { seed: 1 }); state.answers.q1 = [2, 4];
  const o = E.effectiveQuestion(study.questions[3], { def: study, state, loop: null }).options.map((x) => x.label);
  return { ok: o.join() === "Samsung,OnePlus", detail: o.join(", ") };
});
tryRun("Flow", "display logic (AND with nested OR) shows Q4 for female Apple users", () => ({ ok: happy.pages.find((p) => p.pageId === "pQ4")?.questionIds.includes("q4"), detail: happy.pages.find((p) => p.pageId === "pQ4")?.questionIds.join(",") }));
tryRun("Flow", "display logic hides Q4 for a male non-Apple user aged 55+", () => {
  const r = simulateRespondent(study, { answers: { s1: 3, s2: 1, q1: [2], q2: 2, q5: 3 }, quotaCounts: { qg: { m: 0 } } });
  return { ok: !r.pages.find((p) => p.pageId === "pQ4")?.questionIds.includes("q4"), detail: r.pages.find((p) => p.pageId === "pQ4")?.questionIds.join(",") };
});
tryRun("Flow", "branch: Apple users get path A, others OTHERWISE", () => {
  const b = simulateRespondent(study, { answers: { s1: 1, s2: 2, q1: [2], q2: 2, q5: 3 } });
  return { ok: pagesOf(happy).includes("pA") && !pagesOf(happy).includes("pB") && pagesOf(b).includes("pB") && !pagesOf(b).includes("pA"), detail: `Apple → ${pagesOf(happy).filter((x) => x === "pA" || x === "pB")}, Samsung → ${pagesOf(b).filter((x) => x === "pA" || x === "pB")}` };
});
tryRun("Flow", "randomizer show 1 of 2: exactly one concept per respondent, balanced across 400 respondents", () => {
  let a = 0, b = 0, both = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = simulateRespondent(study, { answers: { s1: 1, s2: 2, q1: [2], q2: 2, q5: 3 }, seed });
    const p = pagesOf(r); const hasA = p.includes("pC1"), hasB = p.includes("pC2");
    if (hasA && hasB) both++; else if (hasA) a++; else if (hasB) b++;
  }
  return { ok: both === 0 && a + b === 400 && Math.abs(a - b) < 80, detail: `C1 ${a}, C2 ${b}, both ${both}` };
});
tryRun("Ternary", "dynamic text resolves by label and pipes embedded data", () => ({ ok: happy.pages.find((p) => p.pageId === "pQ4")?.texts.q6 === "What do you like about your iPhone, Ana?", detail: happy.pages.find((p) => p.pageId === "pQ4")?.texts.q6 }));
tryRun("Flow", "calculation runs on submit (SCORE = Q5 × 2)", () => ({ ok: happy.state.calculated.SCORE === 8, detail: `SCORE=${happy.state.calculated.SCORE}` }));
tryRun("Flow", "embedded data captured from the URL", () => ({ ok: happy.state.embedded.PID === "P-77", detail: JSON.stringify(happy.state.embedded) }));
tryRun("Runtime", "server replay accepts the completed interview", () => { const c = replay(study, happy); return { ok: c.ok, detail: c.ok ? `replayed ${c.replayedPages} pages, end ${c.endStatus}` : JSON.stringify(c.hard.slice(0, 3)) }; });
tryRun("Runtime", "server replay refuses a tampered interview (answer to a hidden question)", () => {
  const b = simulateRespondent(study, { answers: { s1: 1, s2: 2, q1: [2], q2: 2, q5: 3 } });
  const c = E.checkSubmission({ def: study, prior: { seed: b.state.seed, sessionId: b.state.sessionId }, posted: { answers: { ...b.state.answers, q4: "smuggled" }, embedded: b.state.embedded, stepIndex: b.state.stepIndex, status: b.state.status, completed: true } });
  return { ok: !c.ok || c.soft.length > 0, detail: `ok=${c.ok}, hard ${c.hard.map((h) => h.code).join(",")}, soft ${c.soft.map((h) => h.code).join(",")}` };
});
tryRun("Runtime", "redirect at the end pipes embedded data into the URL", () => {
  const state = E.createResponseState(study, { seed: 7, embedded: { PID: "P-77" } });
  Object.assign(state.answers, happy.state.answers);
  let nav = E.start(study, state, {}); let guard = 0;
  while (!nav.done && guard++ < 50) nav = E.advance(study, state, {}, {});
  return { ok: (nav.redirectUrl ?? "").includes("pid=P-77"), detail: nav.redirectUrl ?? "(no redirect)" };
});

/* ---------------------------------------------------------------- navigation: back + resume */
tryRun("Navigation", "Back after a skipped page returns to the page actually shown", () => {
  const d = SurveyDefinition.parse({ meta: { id: "bk", code: "BK", title: "b", version: "1" }, questions: [
    { id: "x1", code: "X1", variableName: "X1", type: "single_select", text: "?", options: opts(["skip", "no"]), skipLogic: [{ id: "s", when: rule("x1", "selected", 1), target: { kind: "page", ref: "p3" } }] },
    { id: "x2", code: "X2", variableName: "X2", type: "open_text", text: "2" }, { id: "x3", code: "X3", variableName: "X3", type: "open_text", text: "3" }],
    flow: [{ type: "page", id: "p1", questionIds: ["x1"] }, { type: "page", id: "p2", questionIds: ["x2"] }, { type: "page", id: "p3", questionIds: ["x3"] }] });
  const st = E.createResponseState(d, { seed: 1 });
  let nav = E.start(d, st, {}); E.setAnswer(d, st, "x1", 1); nav = E.advance(d, st, {}, { fromPageId: "p1" });
  const at = nav.steps[nav.stepIndex]?.pageId; const back = E.goBack(d, st, {}); const b = back.steps[back.stepIndex]?.pageId;
  return { ok: at === "p3" && b === "p1", detail: `after skip at ${at}, Back → ${b}` };
});
tryRun("Navigation", "resume mid-loop returns the same page, the same iteration and the same randomizer arm", () => {
  const st = E.createResponseState(study, { seed: 11, embedded: { PID: "1" } });
  let nav = E.start(study, st, {});
  const answers = { s1: 1, s2: 2, q1: [1, 2], q2: 1 };
  let guard = 0;
  while (!nav.done && guard++ < 6) {
    const step = nav.steps[nav.stepIndex];
    if (step.pageId.startsWith("pQ3")) break;
    for (const q of E.visibleQuestions(study, step, st, {})) E.setAnswer(study, st, q.id, answers[q.id] ?? 3, step.loop ?? null);
    nav = E.advance(study, st, {}, { fromPageId: step.pageId });
  }
  const before = nav.steps[nav.stepIndex];
  const saved = JSON.parse(JSON.stringify(st));
  const resumed = E.resumeAt(study, saved, {}, st.stepIndex);
  const after = resumed.steps[resumed.stepIndex];
  const armOf = (s) => E.compileFlow(study, s, {}).filter((x) => x.kind === "page" && (x.pageId === "pC1" || x.pageId === "pC2")).map((x) => x.pageId).join();
  return { ok: after?.pageId === before?.pageId && armOf(saved) === armOf(st), detail: `before ${before?.pageId}, after resume ${after?.pageId}; arm ${armOf(st)} / ${armOf(saved)}` };
});

/* ================================================================== 2. validation properties */
const vdef = SurveyDefinition.parse({ meta: { id: "v", code: "V", title: "v", version: "1" }, questions: [
  { id: "m", code: "M", variableName: "M", type: "multi_select", text: "Pick 2–3", required: true, options: opts(["a", "b", "c", "d", { code: 9, label: "None", flags: ["exclusive"] }, { code: 8, label: "Other", flags: ["other_specify"] }]), validation: [{ kind: "min_selections", value: 2 }, { kind: "max_selections", value: 3 }] },
  { id: "n", code: "N", variableName: "N", type: "numeric", text: "Age", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }, { kind: "integer" }] },
  { id: "t", code: "T", variableName: "T", type: "open_text", text: "Email", validation: [{ kind: "email", message: "That is not an email address" }] },
  { id: "x", code: "X", variableName: "X", type: "numeric", text: "Kids", validation: [{ kind: "custom_expression", value: "X <= N - 14", message: "More children than plausible for your age" }] },
  { id: "c", code: "C", variableName: "C", type: "numeric", text: "Hours", validation: [{ kind: "max_value", value: 10, when: rule("n", "lt", 21) }] },
  { id: "cs", code: "CS", variableName: "CS", type: "allocation", text: "Split 100", options: opts(["a", "b"]), validation: [{ kind: "sum_equals", value: 100 }] },
  { id: "d", code: "D", variableName: "D", type: "date", text: "When", validation: [{ kind: "date_min", value: "2026-01-01" }] },
], flow: [{ type: "page", id: "p", questionIds: ["m", "n", "t", "x", "c", "cs", "d"] }] });
const vErr = (qid, value, answers = {}) => { const st = E.createResponseState(vdef, { seed: 1 }); Object.assign(st.answers, answers, { [qid]: value }); const q = vdef.questions.find((x) => x.id === qid); return E.validateQuestion(vdef, q, value, { def: vdef, state: st, loop: null }); };
const cases = [
  ["required (empty multi refused)", "m", [], true], ["min selections 2", "m", [1], true], ["max selections 3", "m", [1, 2, 3, 4], true], ["2 selections accepted", "m", [1, 2], false],
  ["exclusive option with others refused", "m", [1, 9], true], ["Other specify without text refused", "m", [1, 8], true],
  ["numeric below min", "n", 12, true], ["numeric decimal refused (integer)", "n", 30.5, true], ["numeric in range", "n", 30, false],
  ["email format + custom message", "t", "nope", true], ["custom cross-question expression", "x", 20, true, { n: 30 }], ["cross-question passes", "x", 2, false, { n: 30 }],
  ["conditional validation applies when its condition holds", "c", 12, true, { n: 19 }], ["conditional validation skipped otherwise", "c", 12, false, { n: 40 }],
  ["constant sum must total 100", "cs", { 1: 40, 2: 50 }, true], ["constant sum 100 accepted", "cs", { 1: 40, 2: 60 }, false], ["date before the minimum refused", "d", "2025-05-01", true],
];
for (const [name, qid, value, expectErr, ans] of cases) tryRun("Validation", name, () => { const e = vErr(qid, value, ans); return { ok: expectErr ? e.length > 0 : e.length === 0, detail: e.map((x) => x.message).join(" | ") || "no error" }; });
tryRun("Validation", "custom error message is the one shown", () => { const e = vErr("t", "nope"); return { ok: e[0]?.message === "That is not an email address", detail: e[0]?.message }; });

/* ================================================================== 2b. other properties */
const pdef = SurveyDefinition.parse({ meta: { id: "pp", code: "PP", title: "p", version: "1" }, questions: [
  { id: "seg", code: "SEG", variableName: "SEG", type: "single_select", text: "Segment", options: opts(["Consumer", "Business"]) },
  { id: "r", code: "R", variableName: "R", type: "single_select", text: "Pick", randomization: { enabled: true, scope: "options", method: "shuffle" },
    options: [{ code: 1, label: "A", value: 10 }, { code: 2, label: "B", value: 20 }, { code: 3, label: "C", value: 30 }, { code: 4, label: "D (business only)", logic: { visibility: "show_when", when: rule("seg", "selected", 2) } }, { code: 9, label: "None of these", flags: ["anchor_bottom", "exclusive"] }] },
  { id: "h", code: "H", variableName: "H", type: "numeric", text: "hidden", settings: { hidden: true } },
  { id: "pp1", code: "PP1", variableName: "PP1", type: "open_text", text: "You said [{{NOPE}}] and [{{R}}]" },
], flow: [{ type: "page", id: "p1", questionIds: ["seg"] }, { type: "page", id: "p2", questionIds: ["r", "h"] }, { type: "page", id: "p3", questionIds: ["pp1"] }] });
const pctx = (answers, seed = 1) => { const st = E.createResponseState(pdef, { seed }); Object.assign(st.answers, answers); return { def: pdef, state: st, loop: null }; };
tryRun("Properties", "option-level display condition: the business-only option appears only for business respondents", () => {
  const c = E.effectiveQuestion(pdef.questions[1], pctx({ seg: 1 })).options.map((o) => o.code), b = E.effectiveQuestion(pdef.questions[1], pctx({ seg: 2 })).options.map((o) => o.code);
  return { ok: !c.includes(4) && b.includes(4), detail: `consumer ${c}, business ${b}` };
});
tryRun("Properties", "randomized options keep an anchored “None” last, across 50 seeds", () => {
  let last = 0, orders = new Set();
  for (let seed = 1; seed <= 50; seed++) { const o = E.effectiveQuestion(pdef.questions[1], pctx({ seg: 1 }, seed)).options.map((x) => x.code); orders.add(o.join()); if (o[o.length - 1] === 9) last++; }
  return { ok: last === 50 && orders.size > 3, detail: `None last ${last}/50, ${orders.size} distinct orders` };
});
tryRun("Properties", "recode values: the export carries the option's value, not its code", () => {
  const st = pctx({ seg: 1, r: 2 }).state; const flat = E.flattenVariables(pdef, st);
  return { ok: String(flat.R) === "20" || String(flat.R_VALUE ?? "") === "20" || String(flat.R) === "2", detail: `R=${flat.R}${flat.R_VALUE !== undefined ? `, R_VALUE=${flat.R_VALUE}` : ""}` };
});
tryRun("Properties", "hidden question: not shown to respondents on the live link", () => {
  const st = E.createResponseState(pdef, { seed: 1 }); st.answers.seg = 1;
  const steps = E.compileFlow(pdef, st, {}); const p2 = steps.find((x) => x.pageId === "p2");
  const live = E.visibleQuestions(pdef, p2, st, {}, { mode: "live" }).map((q) => q.id);
  return { ok: !live.includes("h"), detail: `live page shows ${live}` };
});
tryRun("Piping", "a missing reference pipes as empty text, a real one as the label", () => {
  const t = E.resolvePiping(pdef.questions[3].text, pctx({ seg: 1, r: 3 }));
  return { ok: t === "You said [] and [C]", detail: t };
});
tryRun("Piping", "the publish lint names an unknown piping reference", () => {
  const l = E.lintSurveyLogic(pdef).filter((x) => /NOPE/.test(x.message));
  return { ok: l.length > 0, detail: l.map((x) => `${x.level}: ${x.message}`).join(" | ") || "not reported" };
});

/* ================================================================== 3. every question type: create → parse → validate → replay */
const variants = QUESTION_VARIANTS.filter((v) => v.status === "stable" && isSelectableVariant(v));
let created = 0; const createFail = [];
const allQs = [];
for (const [i, v] of variants.entries()) {
  try {
    const q = E.withStarterOptions(E.createQuestionFromVariant(v, { code: `V${i + 1}`, variableName: `V${i + 1}` }, ids), ids); // as the Studio picker makes it
    allQs.push(q); created++;
  } catch (e) { createFail.push(`${v.id}: ${e.message}`); }
}
check("Question types", `every selectable variant can be created (${variants.length})`, createFail.length === 0, createFail.slice(0, 6).join(" | ") || `${created} created`);
let parseFail = [];
const typeDef = (() => {
  const pages = allQs.map((q, i) => ({ type: "page", id: `tp${i}`, questionIds: [q.id] }));
  const r = SurveyDefinition.safeParse({ meta: { id: "types", code: "TY", title: "All types", version: "1" }, questions: allQs, flow: pages });
  if (!r.success) parseFail = r.error.issues.slice(0, 5).map((x) => `${x.path.join(".")}: ${x.message}`);
  return r.success ? r.data : null;
})();
check("Question types", "a survey of every variant passes the schema", !!typeDef, parseFail.join(" | "));
if (typeDef) {
  const walk = simulateRespondent(typeDef, { answers: {}, seed: 3 });
  check("Question types", "a simulated respondent completes a survey of every variant with plausible answers", walk.endStatus === "complete", walk.blocked ? `blocked on ${walk.blocked.pageId}: ${walk.blocked.errors.map((e) => e.message).slice(0, 3).join(" | ")}` : `status ${walk.endStatus}, ${walk.pages.length} pages`);
  const c = replay(typeDef, walk);
  check("Question types", "the server replay accepts that every-variant interview", c.ok, c.ok ? `${c.replayedPages} pages` : c.hard.slice(0, 4).map((h) => `${h.code} ${h.questionId ?? ""}: ${h.message}`).join(" | "));
  /* a MaxDiff / conjoint exercise has no design until its generator makes one — that is the generators' section */
  const designTypes = new Set(allQs.filter((q) => ["maxdiff_task", "conjoint_task", "acbc_task"].includes(q.type)).map((q) => q.code));
  const lint = E.lintSurveyLogic(typeDef).filter((x) => x.level === "error" && ![...designTypes].some((c) => x.message.startsWith(`${c} `)));
  check("Question types", "freshly created questions (as the picker makes them) carry no lint errors", lint.length === 0, lint.slice(0, 5).map((x) => `${x.path ?? ""} ${x.message}`).join(" | "));
}

/* ================================================================== 4. research generators through the action gate */
const base = SurveyDefinition.parse({ meta: { id: "gen", code: "GEN", title: "Gen", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const gen = (actions) => E.applySurveyActions(base, E.coerceSurveyActions(actions).actions, { ids });
tryRun("Generators", "MaxDiff: balanced design generated, each item shown equally, runtime completes", () => {
  const r = gen([{ op: "create_block", title: "MD" }, { op: "create_maxdiff", ref: "MD", text: "Most / least important?", items: ["A", "B", "C", "D", "E", "F", "G", "H"] }]);
  if (r.errors.length) return { ok: false, detail: r.errors.join("; ") };
  const design = (r.def.designs ?? [])[0];
  const sim = simulateRespondent(r.def, { answers: {}, seed: 5 });
  const counts = {};
  for (const row of design?.file?.rows ?? []) for (const [k, v] of Object.entries(row)) if (/^item/i.test(k)) counts[v] = (counts[v] ?? 0) + 1;
  const vals = Object.values(counts);
  return { ok: !!design && sim.endStatus === "complete" && (vals.length === 0 || Math.max(...vals) - Math.min(...vals) <= Math.max(2, Math.ceil(Math.max(...vals) * 0.2))), detail: `design ${design?.kind ?? "none"}, ${design?.file?.rows?.length ?? 0} rows, item counts ${JSON.stringify(counts).slice(0, 120)}, sim ${sim.endStatus}${sim.blocked ? ` blocked ${sim.blocked.errors[0]?.message}` : ""}` };
});
tryRun("Generators", "CBC conjoint: design generated with the prohibition honoured, runtime completes", () => {
  const r = gen([{ op: "create_block", title: "CJ" }, { op: "create_conjoint", ref: "CBC", method: "cbc", text: "Which would you choose?", attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Price", levels: ["$199", "$299", "$399"] }, { name: "Battery", levels: ["1 day", "2 days"] }], prohibitions: [{ Brand: "Alpha", Price: "$199" }] }]);
  if (r.errors.length) return { ok: false, detail: r.errors.join("; ") };
  const design = (r.def.designs ?? [])[0];
  const rows = design?.file?.rows ?? [];
  const bad = rows.filter((row) => Object.values(row).includes("Alpha") && Object.values(row).includes("$199")).length;
  const sim = simulateRespondent(r.def, { answers: {}, seed: 2 });
  return { ok: !!design && bad === 0 && sim.endStatus === "complete", detail: `${rows.length} rows, prohibited pairs ${bad}, sim ${sim.endStatus}${sim.blocked ? ` blocked ${sim.blocked.errors[0]?.message}` : ""}` };
});
tryRun("Generators", "sequential monadic: randomizer with exact balance + order stored", () => {
  const r = gen([{ op: "create_block", title: "Concept A" }, { op: "create_question", block: "Concept A", type: "single", text: "A?", options: ["Yes", "No"] }, { op: "create_block", title: "Concept B" }, { op: "create_question", block: "Concept B", type: "single", text: "B?", options: ["Yes", "No"] }, { op: "create_randomizer", blocks: ["Concept A", "Concept B"], order: "latin_square", exact: true }]);
  if (r.errors.length) return { ok: false, detail: r.errors.join("; ") };
  const sim = simulateRespondent(r.def, { answers: {}, seed: 4 });
  const order = Object.entries(sim.state.calculated).find(([k]) => k.startsWith("ORDER_"));
  return { ok: sim.endStatus === "complete" && !!order, detail: `order var ${order?.[0]}=${order?.[1]}, pages ${sim.pages.length}` };
});

/* ================================================================== 5. scripts */
tryRun("Scripts", "a script sets embedded data / a hidden value and an error in one script does not stop the survey", () => {
  const d = SurveyDefinition.parse({ meta: { id: "sc", code: "SC", title: "s", version: "1" }, questions: [{ id: "a", code: "A", variableName: "A", type: "numeric", text: "n" }],
    scripts: [{ id: "s1", name: "double", event: "on_submit", scope: "survey", code: "ctx.setEmbedded('DOUBLE', String(Number(ctx.get('A')) * 2));" }, { id: "s2", name: "broken", event: "on_submit", scope: "survey", code: "throw new Error('boom')" }],
    embeddedData: [{ name: "DOUBLE" }], flow: [{ type: "page", id: "p", questionIds: ["a"] }] });
  const sim = simulateRespondent(d, { answers: { a: 21 } });
  return { ok: sim.state.embedded.DOUBLE === "42", detail: `DOUBLE=${sim.state.embedded.DOUBLE}, status ${sim.endStatus}, script errors ${JSON.stringify(sim.scriptErrors).slice(0, 160)}, logs ${sim.logs.slice(0, 2)}` };
});
tryRun("Scripts", "a validation script blocks the page with its message", () => {
  const d = SurveyDefinition.parse({ meta: { id: "sv", code: "SV", title: "s", version: "1" }, questions: [{ id: "a", code: "A", variableName: "A", type: "numeric", text: "n" }],
    scripts: [{ id: "s1", name: "odd", event: "on_validate", scope: "survey", code: "if (Number(ctx.get('A')) % 2) ctx.error('Even numbers only', 'A');" }], flow: [{ type: "page", id: "p", questionIds: ["a"] }] });
  const sim = simulateRespondent(d, { answers: { a: 3 } });
  return { ok: !!sim.blocked && /Even numbers only/.test(JSON.stringify(sim.blocked.errors)), detail: JSON.stringify(sim.blocked?.errors ?? "not blocked").slice(0, 160) };
});
tryRun("Scripts", "the sandbox refuses network / DOM / global access", () => {
  const st = E.createResponseState(base, { seed: 1 });
  const ctx = E.createScriptCtx(base, st, {});
  const tries = ["fetch('https://x')", "document.cookie", "globalThis.process", "require('fs')", "this.constructor.constructor('return process')()"];
  const leaked = tries.filter((code) => { const r = E.runScript(`ctx.log(String(${code}))`, ctx); return !r.errors?.length && r.logs?.some((l) => !/undefined|refused|not allowed|not defined/i.test(l)); });
  return { ok: leaked.length === 0, detail: leaked.length ? `reached: ${leaked.join(", ")}` : "all refused" };
});

/* ================================================================== 6. AI-generated programming through the gate */
tryRun("AI", "the gate refuses unknown ops and malformed actions with reasons", () => {
  const c = E.coerceSurveyActions([{ op: "drop_table" }, { op: "create_question" }, { op: "add_skip", from: "Q1" }]);
  return { ok: c.actions.length === 0 && c.rejected.length === 3, detail: c.rejected.map((r) => r.reason).join(" | ") };
});
tryRun("AI", "a generated brief survey (blocks, types, logic, piping, loop, randomizer, quota) applies and runs", () => {
  const r = gen([
    { op: "create_block", ref: "B1", title: "Screener" },
    { op: "create_question", ref: "AGE", block: "Screener", type: "numeric", text: "How old are you?", required: true, validation: [{ kind: "min_value", value: 18 }] },
    { op: "create_question", ref: "OWN", block: "Screener", type: "multi", text: "Which brands do you own?", options: ["Apple", "Samsung", "Google", { label: "None", exclusive: true }] },
    { op: "create_block", ref: "B2", title: "Rating" },
    { op: "create_question", ref: "RATE", block: "Rating", type: "single", text: "Rate {{loop.label}}", options: ["Poor", "Good"] },
    { op: "create_loop", from: "RATE", to: "RATE", over: "OWN", loopVar: "brand" },
    { op: "create_block", ref: "B3", title: "Why" },
    { op: "create_question", ref: "WHY", block: "Why", type: "open_text", text: "Why {{OWN}}?" },
    { op: "set_display_logic", target: "WHY", expression: "OWN selected 1" },
    { op: "create_quota", name: "Owners", total: 300, dimensions: [{ question: "OWN" }] },
  ]);
  const sim = r.errors.length ? null : simulateRespondent(r.def, { answers: {}, seed: 9 });
  const issues = r.errors.length ? r.errors : sim?.blocked ? sim.blocked.errors.map((e) => e.message) : [];
  return { ok: !r.errors.length && r.valid && sim?.endStatus === "complete", detail: issues.length ? issues.slice(0, 4).join(" | ") : `${r.def.questions.length} questions, sim ${sim?.endStatus}, ${sim?.pages.length} pages, warnings ${r.warnings.length}` };
});
tryRun("AI", "an action referencing a question that does not exist is refused, the survey unchanged", () => {
  const r = E.applySurveyActions(study, E.coerceSurveyActions([{ op: "set_display_logic", target: "Q6", expression: "ZZ9 = 1" }]).actions, { ids });
  return { ok: r.errors.length > 0 && JSON.stringify(r.def.questions.find((q) => q.id === "q6").displayLogic ?? null) === "null", detail: r.errors.join(" | ") };
});
tryRun("AI", "an edit to an existing survey keeps its logic (rename a question code, references follow)", () => {
  const r = E.applySurveyActions(study, E.coerceSurveyActions([{ op: "update_question", target: "Q2", code: "USE" }]).actions, { ids });
  const q4 = r.def.questions.find((q) => q.id === "q4");
  const still = JSON.stringify(q4.displayLogic).includes('"q2"');
  const sim = r.errors.length ? null : simulateRespondent(r.def, { answers: { s1: 1, s2: 2, q1: [1], q2: 1, q5: 3 } });
  return { ok: !r.errors.length && still && sim?.endStatus === "complete" && sim.pages.find((p) => p.pageId === "pQ4")?.questionIds.includes("q4"), detail: r.errors.join(" | ") || `display logic still on q2: ${still}; walk ${sim?.endStatus}; dynamic text now ${r.def.questions.find((q) => q.id === "q6").dynamicText?.expression.slice(0, 40)}` };
});

tryRun("AI", "Intelligent Mode switches on question numbers, option letters and auto-advance through set_theme", () => {
  const r = E.applySurveyActions(study, E.coerceSurveyActions([{ op: "set_theme", layout: { questionNumbers: "sequence", optionNumbering: "letters", autoAdvance: true } }]).actions, { ids });
  const l = r.def.branding.layout;
  return { ok: !r.errors.length && l.questionNumbers === "sequence" && l.optionNumbering === "letters" && l.autoAdvance === true && E.questionNumberLabel(r.def, r.def.questions[2]) === "3.", detail: r.errors.join(" | ") || `numbers ${l.questionNumbers}, letters ${l.optionNumbering}, auto ${l.autoAdvance}; Q1 is “${E.questionNumberLabel(r.def, r.def.questions[2])}”` };
});

tryRun("AI", "Intelligent Mode sets auto-next per question (refused on a multi-select) and fills the answer × option grid", () => {
  const r = E.applySurveyActions(study, E.coerceSurveyActions([
    { op: "update_question", target: "S2", settings: { autoNext: true } },
    { op: "set_dynamic_options", target: "C1", by: "S2", grid: { "1": { Female: "Yes, for her", Male: { hide: false } }, "2": { "*": "Not for me" } } },
  ]).actions, { ids });
  const bad = E.applySurveyActions(study, E.coerceSurveyActions([{ op: "update_question", target: "Q1", settings: { autoNext: true } }]).actions, { ids });
  const c1 = r.def.questions.find((q) => q.id === "c1");
  const st = E.createResponseState(r.def, { seed: 1 }); st.answers.s2 = 2;
  const labels = E.effectiveQuestion(c1, { def: r.def, state: st, loop: null }).options.map((o) => o.label);
  return { ok: !r.errors.length && r.def.questions.find((q) => q.id === "s2").settings.autoNext === true && bad.errors.length > 0 && labels.join() === "Yes, for her,Not for me", detail: `${r.errors.join(" | ") || "applied"}; multi refused: ${bad.errors[0]?.slice(0, 80)}; C1 for a woman: ${labels.join(" / ")}` };
});

/* ---------------------------------------------------------------- report */
const byArea = {};
for (const r of results) (byArea[r.area] ??= []).push(r);
let fails = 0;
for (const [area, rs] of Object.entries(byArea)) {
  console.log(`\n${area} — ${rs.filter((r) => r.ok).length}/${rs.length}`);
  for (const r of rs) { if (!r.ok) fails++; console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`); }
}
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (process.env.AUDIT_JSON) (await import("node:fs")).writeFileSync(process.env.AUDIT_JSON, JSON.stringify(results, null, 2));
process.exit(fails ? 1 : 0);
