import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { conjointMethodOf, conjointPlanReadiness, cvaTasksFor, dualKey } from "./conjointSuite.js";
import { validateQuestion, blockingErrors } from "./validate.js";
import { flattenVariables } from "./flatten.js";
import { buildVariableDictionary } from "./variables.js";
import { stackedChoiceData } from "./choiceData.js";
import { createResponseState } from "./state.js";
import { lintSurveyLogic } from "./lintLogic.js";
import { interpretRequest } from "./nlIntent.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { acbcByoPrice, emptyAcbcAnswer, normalizeAcbc, parsePriceIncrements, submitByo, nearConcepts } from "./acbc.js";
import { designVersionFor } from "./designVersion.js";

/*
 * THE CONJOINT SUITE IN THE ENGINE (F4, 2026-10-22): method detection, the respondent's answers
 * validated (dual-response follow-up, CVA ratings, menu sections), the wide / stacked exports and
 * the dictionary, ACBC summed price in the interview machine, the lint, the grammar's hand-off and
 * the simulator-scenario action — on hand-made design rows (the engine never imports the generators).
 */

const cbcRows = (dual: boolean) => [1, 2].flatMap((task) => [1, 2, 3].map((alt) => ({ version: 1, task, alt, is_holdout: 0, Brand: ["Alpha", "Beta", "Gamma"][(alt + task) % 3], "5G": alt === 3 ? "" : alt === 1 ? "Yes" : "No", none_option: 0 })));
const cvaRows = [1, 2, 3].map((task) => ({ version: 1, task, alt: 1, is_holdout: task === 3 ? 1 : 0, Brand: ["Alpha", "Beta", "Gamma"][task - 1], Speed: task % 2 ? "Fast" : "Slow" }));
const menuRows = [1, 2].flatMap((task) => ["Basic", "Plus", "Extra"].map((label, i) => ({ version: 1, task, item: i + 1, item_label: label, price: `$${task + i}`, price_index: 1, price_value: task + i, required: 0, group: i < 2 ? "Plan" : "" })));
const def = (extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Suite", version: "1" },
  designs: [
    { id: "d_dual", kind: "conjoint", name: "Dual", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "5G", levels: ["No", "Yes"] }], dualResponseNone: true, alternativeSpecific: ["5G: Alpha, Beta"] }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand", "5G", "none_option"], rows: cbcRows(true) } },
    { id: "d_cva", kind: "cva", name: "CVA", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Speed", levels: ["Slow", "Fast"] }], scaleMin: 0, scaleMax: 10, minLabel: "No way" }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand", "Speed"], rows: cvaRows } },
    { id: "d_menu", kind: "menu", name: "Menu", version: 1, config: { items: [{ name: "Basic", levels: ["$1", "$2"] }, { name: "Plus", levels: ["$2", "$3"] }, { name: "Extra", levels: ["$3", "$4"] }], exclusiveGroups: ["Plan: Basic | Plus"] }, file: { format: "json", columns: ["version", "task", "item", "item_label", "price", "price_index", "price_value", "required", "group"], rows: menuRows } },
    { id: "d_acbc", kind: "acbc", name: "ACBC", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Speed", levels: ["Slow", "Fast"] }], priceBase: 100, priceIncrements: ["Brand: 0, 20, 40", "Speed: 0, 15"], priceVariation: 20 }, file: { format: "json", columns: ["stage"], rows: [{ stage: "byo" }] } },
  ],
  questions: [
    { id: "q_dual", code: "Q1", variableName: "DUAL", type: "conjoint_task", text: "Choose", required: true, settings: { designRef: "d_dual" } },
    { id: "q_cva", code: "Q2", variableName: "CVA", type: "conjoint_task", variant: "conjoint.cva", text: "Rate", required: true, settings: { designRef: "d_cva" } },
    { id: "q_menu", code: "Q3", variableName: "MENU", type: "conjoint_task", variant: "conjoint.menu", text: "Menu", settings: { designRef: "d_menu" } },
    { id: "q_acbc", code: "Q4", variableName: "ACBC", type: "acbc_task", variant: "conjoint.acbc", text: "Adaptive", settings: { designRef: "d_acbc" } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_dual", "q_cva", "q_menu", "q_acbc"] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});

test("conjointMethodOf: the method and its options, from the design", () => {
  const d = def();
  const info = (id: string) => conjointMethodOf(d, d.questions.find((q) => q.id === id)!)!;
  assert.deepEqual([info("q_dual").method, info("q_dual").dualResponse, info("q_dual").alternativeSpecific], ["cbc", true, true]);
  assert.deepEqual(info("q_cva").cva, { mode: "single", min: 0, max: 10, minLabel: "No way" });
  assert.equal(info("q_menu").exclusiveGroups, true);
  assert.equal(info("q_acbc").summedPrice, true);
  const plan = conjointPlanReadiness(d, d.questions[1]);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.estimators.map((e) => [e.id, e.available]), [["cva_ols", true], ["cva_hb", false]]);
  assert.deepEqual(conjointPlanReadiness(d, d.questions[0]).estimators.map((e) => e.id), ["cbc_aggregate", "cbc_hb", "cbc_forced"]);
});

test("validation: the dual-response follow-up is required and yes / no; a CVA rating is on the scale for a task of the version; a menu section takes one item", () => {
  const d = def();
  const state = createResponseState(d, { seed: 99 });
  const ctx = { def: d, state };
  const msgs = (qid: string, v: unknown) => blockingErrors(validateQuestion(d, d.questions.find((q) => q.id === qid)!, v, ctx as never)).map((e) => e.message).join(" | ");
  assert.equal(msgs("q_dual", { "1": "2", [dualKey(1)]: "yes", "2": "1", [dualKey(2)]: "no" }), "");
  assert.match(msgs("q_dual", { "1": "2", [dualKey(1)]: "yes", "2": "1" }), /would buy the option you chose in task 2/);
  assert.match(msgs("q_dual", { "1": "2", [dualKey(1)]: "maybe", "2": "1", [dualKey(2)]: "no" }), /with yes or no/);
  assert.match(msgs("q_dual", { "1": "7", [dualKey(1)]: "yes", "2": "1", [dualKey(2)]: "no" }), /not one of the options shown/);
  assert.equal(msgs("q_cva", { "1": 0, "2": 10, "3": 5 }), "");
  assert.match(msgs("q_cva", { "1": 11, "2": 10, "3": 5 }), /rating from 0 to 10/);
  assert.match(msgs("q_cva", { "1": 3, "2": 4 }), /task 3/);
  assert.equal(msgs("q_menu", { "1": ["1", "3"], "2": ["2"] }), "");
  assert.match(msgs("q_menu", { "1": ["1", "2"] }), /at most one item from “Plan”/);
});

test("exports: CVA ratings and the dual BUY columns in the wide file and the dictionary; the stacked file's buy column and not-applicable codes", () => {
  const d = def();
  const state = createResponseState(d, { seed: 5 });
  state.answers = { q_dual: { "1": "2", [dualKey(1)]: "no", "2": "3", [dualKey(2)]: "yes" }, q_cva: { "1": 7, "2": 3, "3": 9 } };
  const flat = flattenVariables(d, state);
  assert.deepEqual([flat.DUAL_T1, flat.DUAL_T1_BUY, flat.DUAL_T2_BUY], [2, 0, 1]);
  assert.equal(flat["DUAL_T1_buy"], undefined);
  assert.deepEqual([flat.CVA_T1, flat.CVA_T2, flat.CVA_T3], [7, 3, 9]);
  assert.equal(flat.CVA_T1_ORDER, undefined);
  const dict = buildVariableDictionary(d);
  const v = (n: string) => dict.find((x) => x.name === n);
  assert.deepEqual(v("DUAL_T1_BUY")?.valueCodes, [0, 1]);
  assert.match(v("CVA_T3")!.label, /holdout profile 3 rating/);
  const st = stackedChoiceData(d, [{ sessionId: "s1", seed: 5, answers: state.answers }]);
  assert.deepEqual(st.questions, ["DUAL"], "the CVA question is not a choice question");
  assert.ok(st.columns.includes("buy"));
  const t1 = st.rows.filter((r) => r.task === 1);
  assert.ok(t1.every((r) => r.buy === 0));
  assert.ok(t1.filter((r) => r["5G"] === "").every((r) => r["5G_code"] === 0));
  assert.equal(designVersionFor(d.questions[0], cbcRows(true), 5), "1");
});

test("ACBC summed price: every concept priced within the variation of its list price, the BYO at its list price, the concepts unchanged", () => {
  const d = def();
  const cfg = normalizeAcbc(d.designs[3].config as never);
  assert.deepEqual(parsePriceIncrements(["Brand: 0, +20, ₹40", "Speed: -5 | 15"]), { Brand: [0, 20, 40], Speed: [-5, 15] });
  const a = submitByo(cfg, emptyAcbcAnswer(), 11, { Brand: "Beta", Speed: "Fast" });
  assert.equal(acbcByoPrice(cfg, a.byo), 135);
  for (const c of a.screens[0].concepts) {
    const list = 100 + [0, 20, 40][["Alpha", "Beta", "Gamma"].indexOf(c.profile.Brand)] + [0, 15][["Slow", "Fast"].indexOf(c.profile.Speed)];
    assert.ok(c.price! >= list * 0.8 - 0.5 && c.price! <= list * 1.2 + 0.5, `${c.price} vs ${list}`);
  }
  const plain = normalizeAcbc({ attributes: cfg.attributes });
  assert.deepEqual(nearConcepts(plain, a, 11, 1, 4, new Set()).map((c) => c.profile), nearConcepts(cfg, a, 11, 1, 4, new Set()).map((c) => c.profile));
});

test("lint: an ACBC design on a CBC question, a CVA question on a choice design, dual + None together", () => {
  const d = def();
  d.questions.push({ ...d.questions[0], id: "q_bad", code: "Q5", variableName: "BAD", settings: { designRef: "d_acbc" } } as never);
  d.questions.push({ ...d.questions[1], id: "q_bad2", code: "Q6", variableName: "BAD2", settings: { designRef: "d_dual" } } as never);
  (d.designs[0].config as Record<string, unknown>).noneOption = true;
  const issues = lintSurveyLogic(d).map((i) => i.message).join(" | ");
  assert.match(issues, /Q5 points at the ACBC design/);
  assert.match(issues, /Q6 is a rating-based conjoint \(CVA\) question but design “d_dual” is a conjoint design/);
  assert.match(issues, /asked about “none” twice/);
});

test("Intelligent Mode: the grammar hands the suite's requests to the model; simulate_conjoint is checked against the design and saved", () => {
  const d = def();
  for (const t of ["add a none option as dual response", "run the menu simulator with the premium bundle at ₹499", "make a rating-based conjoint with 4 attributes"]) {
    assert.equal(interpretRequest(d, t).kind, "model", t);
  }
  const ok = applySurveyActions(d, coerceSurveyActions([{ op: "simulate_conjoint", target: "MENU", scenario: { name: "Plus deal", prices: { plus: "$2.50" }, bundles: [{ name: "Combo", items: ["Basic", "Extra"], price: 5 }] } }]).actions);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual((ok.def.designs[2].config as { simulations: unknown[] }).simulations, [{ name: "Plus deal", prices: { Plus: 2.5 }, bundles: [{ name: "Combo", items: ["Basic", "Extra"], price: 5 }] }]);
  assert.deepEqual(ok.def.designs[2].file!.rows, d.designs[2].file!.rows);
  const replaced = applySurveyActions(ok.def, coerceSurveyActions([{ op: "simulate_conjoint", target: "MENU", scenario: { name: "plus deal", prices: { Plus: "$3" } } }]).actions);
  assert.equal((replaced.def.designs[2].config as { simulations: unknown[] }).simulations.length, 1, "same name → replaced");
  const removed = applySurveyActions(replaced.def, coerceSurveyActions([{ op: "simulate_conjoint", target: "MENU", remove: true, scenario: { name: "Plus deal" } }]).actions);
  assert.equal((removed.def.designs[2].config as { simulations?: unknown[] }).simulations, undefined);
  const cva = applySurveyActions(d, coerceSurveyActions([{ op: "simulate_conjoint", target: "CVA", scenario: { name: "Two", products: [{ name: "A", levels: { brand: "beta", speed: "fast" } }, { name: "B", levels: { Brand: "Gamma", Speed: "Slow" } }], rule: "btl" } }]).actions);
  assert.deepEqual(cva.errors, []);
  assert.deepEqual(((cva.def.designs[1].config as { simulations: { products: { levels: unknown }[] }[] }).simulations[0].products[0].levels), { Brand: "Beta", Speed: "Fast" });
  const rej = (raw: unknown) => coerceSurveyActions([raw]).rejected[0]?.reason ?? "";
  assert.match(rej({ op: "simulate_conjoint", target: "MENU", scenario: { name: "x" } }), /needs products .* or menu prices/);
  assert.match(rej({ op: "simulate_conjoint", target: "MENU", scenario: { name: "x", bundles: [{ name: "b", items: ["Basic"], price: 3 }] } }), /at least two items/);
  assert.match(rej({ op: "simulate_conjoint", target: "MENU", scenario: { name: "x", prices: { Basic: 1 }, rule: "magic" } }), /rule is logit/);
  const bad = applySurveyActions(d, coerceSurveyActions([{ op: "simulate_conjoint", target: "CVA", scenario: { name: "x", products: [{ name: "A", levels: { Brand: "Delta" } }] } }]).actions);
  assert.match(bad.errors[0], /“Delta” is not a level of Brand/);
});

test("CVA tasks for the renderer: the respondent's version in task order with each profile's levels", () => {
  const d = def();
  const tasks = cvaTasksFor(d, d.questions[1], 1);
  assert.deepEqual(tasks.map((t) => [t.task, t.holdout, t.profiles[0].levels.Brand]), [["1", false, "Alpha"], ["2", false, "Beta"], ["3", true, "Gamma"]]);
});
