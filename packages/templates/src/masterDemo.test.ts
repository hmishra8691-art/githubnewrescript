import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVariableDictionary, countRespondentQuestions, createResponseState, decideListFill, effectiveQuestion, lintSurveyLogic,
  lintVariables, prefillQuestions, runCalculations, runScripts, validatePage, answerKey, resolvePiping, loopContexts,
} from "@rescript/engine";
import type { LoopFlowNode } from "@rescript/engine";
import { exportSurveyJson, importSurveyJson, exportVariableDictionaryXlsx, variableDictionaryToCSV } from "@rescript/exporters";
import { BRANDS, MASTER_DEMO_TEST_PATHS, buildMasterDemoSurvey, simulateRespondent } from "./index.js";

/**
 * THE MASTER DEMO'S ACCEPTANCE CRITERIA (§57), as tests.
 *
 * The survey is a programmed artefact, so its correctness is testable: it must
 * lint clean, every test path must run to an end without a validation stall,
 * every loop must iterate exactly the items its source promises, references
 * must pipe from the loop that owns them, and the exports must carry it all.
 */

const def = buildMasterDemoSurvey("test");
const path = (id: string) => MASTER_DEMO_TEST_PATHS.find((p) => p.id === id)!;
const q = (id: string) => def.questions.find((x) => x.id === id)!;
const loopNode = (id: string) => {
  const find = (nodes: any[]): LoopFlowNode | undefined => {
    for (const n of nodes) {
      if (n.type === "loop" && n.id === id) return n;
      const kids = [...(n.children ?? []), ...(n.otherwise ?? []), ...((n.branches ?? []).flatMap((b: any) => b.children))];
      const hit = find(kids); if (hit) return hit;
    }
  };
  return find(def.flow)!;
};

/* ------------------------------------------------------------ structure */

test("builds deterministically and parses", () => {
  assert.deepEqual(buildMasterDemoSurvey("x"), buildMasterDemoSurvey("x"));
  assert.equal(def.meta.code, "MASTER_DEMO_2026");
});

test("§57.1 at least 100 meaningful respondent questions, none without a purpose", () => {
  const n = countRespondentQuestions(def);
  assert.ok(n >= 100, `only ${n} respondent-facing questions`);
  // every non-hidden question is placed on a page and every id is unique
  const ids = def.questions.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate question ids");
  const codes = def.questions.map((x) => x.code);
  assert.equal(new Set(codes).size, codes.length, "duplicate question codes");
  const vars = def.questions.map((x) => x.variableName);
  assert.equal(new Set(vars).size, vars.length, "duplicate variable names");
});

test("§57.2 every relevant built-in question type appears at least once", () => {
  const present = new Set(def.questions.map((x) => x.type));
  const wanted = [
    "single_select", "multi_select", "dropdown", "multi_dropdown", "numeric", "open_text", "long_text", "numeric_list", "text_list",
    "date", "time", "ranking", "slider", "nps", "matrix_single", "matrix_multi", "matrix_numeric", "matrix_text", "matrix_dropdown",
    "image_select", "image_ranking", "hotspot", "allocation", "composite", "custom_table", "hidden", "calculated", "html",
    "conjoint_task", "maxdiff_task", "annotation", "media_timeline", "upload", "repeating_group", "experiment",
  ];
  const missing = wanted.filter((t) => !present.has(t));
  assert.deepEqual(missing, [], `missing types: ${missing.join(", ")}`);
});

test("§57.3 the big lists have more than 10 options", () => {
  for (const id of ["q_aware", "q_used", "q_devices", "q_fin_products", "q_apps", "q_country", "q_industry", "q_rand_pick", "q_rand_anchor"]) {
    assert.ok(q(id).options.length > 10, `${id} has ${q(id).options.length} options`);
  }
});

test("§57.48 lint clean — no broken routes, unresolved pipes, missing references or duplicate variables", () => {
  const issues = lintSurveyLogic(def);
  assert.deepEqual(issues.map((i) => `${i.level} ${i.questionCode ?? ""} ${i.path}: ${i.message}`), []);
  assert.deepEqual(lintVariables(def), []);
});

test("§16/§17 references live only on the loop nodes — the source question is untouched", () => {
  const used = q("q_used");
  assert.equal((used as any).references, undefined);
  for (const o of used.options) assert.equal(Object.keys(o).some((k) => /Brand_Nickname|Product_ID|Category/.test(k)), false);
  const l1 = loopNode("loop_001"); const lf = loopNode("loop_lf"); const l3 = loopNode("loop_003");
  assert.deepEqual(l1.references!.columns.map((c) => c.name), ["Brand_Nickname", "Product_ID", "Client_Code", "Category", "Internal_Name", "Region", "Product_Type"]);
  assert.deepEqual(lf.references!.columns.map((c) => c.name), ["Tier", "Segment"], "LOOP_LF has a different structure over the same brands");
  assert.deepEqual(l3.references!.columns.map((c) => c.name), ["Reason_Prompt"]);
});

/* ------------------------------------------------------------ the paths */

function run(id: string, extra: Partial<Parameters<typeof simulateRespondent>[1]> = {}) {
  const p = path(id);
  const res = simulateRespondent(def, { answers: p.answers, seed: p.seed, embedded: { PANEL_ID: "P-1", SOURCE: "test" }, ...extra });
  assert.equal(res.blocked, undefined, `path ${id} stalled on ${res.blocked?.pageId}: ${JSON.stringify(res.blocked?.errors)}`);
  return res;
}
const iterations = (res: ReturnType<typeof run>, loopVar: string, page: string) =>
  res.pages.filter((p) => p.loop?.loopVar === loopVar && p.pageId.startsWith(page)).map((p) => p.loop!.code);

test("Path A — three brands: LOOP_001 ×3 in selection order, nested LOOP_002 ×3 each, LOOP_003, LOOP_004, List Fill ×2, completes", () => {
  const res = run("A");
  assert.equal(res.endStatus, "complete");
  assert.deepEqual(iterations(res, "brand", "p_l1_a"), ["1", "3", "2"], "selection order Apple, Google, Samsung");
  assert.equal(iterations(res, "feature", "p_l2").length, 9, "3 features × 3 brands");
  assert.deepEqual(iterations(res, "feature", "p_l2").slice(0, 3), ["battery", "camera", "price"], "ordered by the Weight reference, desc, capped at 3");
  const notSel = iterations(res, "nonuser", "p_l3");
  assert.equal(notSel.length, 3);
  for (const c of notSel) assert.ok(["4", "6", "9"].includes(c), `aware-but-unused only, got ${c}`);
  assert.deepEqual(iterations(res, "exited", "p_l4"), ["9", "12"], "invalid = Market_Status 'exited'");
  assert.equal(iterations(res, "product", "p_l6").length, 2);
  const lf = res.listFills.find((l) => l.listFillId === "lf_brand_eval")!;
  assert.equal(lf.items.length, 2, "count = min(2, 3)");
  assert.equal(res.state.calculated.LISTFILL_BRAND_EVAL_COUNT, 2);
  assert.equal(res.state.answers.h_lf_brand_1, lf.items[0].code, "destination 1 written as an answer");
  // the List-Fill loop ran once per allocated brand
  assert.deepEqual(iterations(res, "lfbrand", "p_lf_loop"), lf.items.map((i) => i.code));
  // the custom-design loop
  assert.deepEqual(iterations(res, "task", "p_cd"), ["1", "2", "3"]);
  // randomizer showed 2 of 3 attitude blocks
  assert.equal(res.pages.filter((p) => p.pageId.startsWith("p_att_")).length, 2);
  // the branch: Both + employed → combined section
  assert.ok(res.pages.some((p) => p.pageId === "p_combined"));
  assert.ok(!res.pages.some((p) => p.pageId === "p_consumer" || p.pageId === "p_business"));
});

test("Path A — loop piping: CURRENT_ITEM, several references in one sentence, index/count, nested loop names, §41 combination", () => {
  const res = run("A");
  const apple = res.pages.find((p) => p.pageId === "p_l1_a@1")!;
  assert.equal(apple.texts.q_l1_familiar, "How familiar are you with Apple?");
  assert.equal(apple.texts.q_l1_freq, "How frequently do you use Apple products or services? (brand 1 of 3)");
  assert.equal(apple.texts.q_l1_sat, "Please rate APPLE, product PROD_001, in the Smartphone category.");
  const google = res.pages.find((p) => p.pageId === "p_l1_c@3")!;
  assert.match(google.texts.q_l1_spend_rate, /spend about 120 per month/);
  assert.match(google.texts.q_l1_spend_rate, /GOOGLE \(product PROD_003\)/);
  assert.match(google.texts.q_l1_spend_rate, /your favourite, Apple/);
  assert.ok(google.questionIds.includes("q_l1_smartphone"), "Google is a Smartphone → category question shown");
  const nested = res.pages.find((p) => p.pageId === "p_l2@3@camera")!;
  assert.equal(nested.texts.q_l2_feature_rate, "Rate Google on Camera (Hardware group).");
  assert.equal(nested.texts.q_l2_feature_reason, "Is Camera a reason you chose GOOGLE?");
  const l3 = res.pages.find((p) => p.pageId.startsWith("p_l3@"))!;
  assert.match(l3.texts.q_l3_convince, /^What would make you try \w+ for the first time\?$/);
  const l4 = res.pages.find((p) => p.pageId === "p_l4@9")!;
  assert.match(l4.texts.q_l4_aware_exit, /^Huawei has stopped .* since 2021/);
  const cd = res.pages.find((p) => p.pageId === "p_cd@1")!;
  assert.match(cd.texts.q_cd_agree, /^Statement: “.+” \(\w+ · intensity level \d\)/);
});

test("Path A — auto-punch inside the loop reads the reference; outside it reads answers, mappings, calculations and the List Fill", () => {
  const res = run("A");
  assert.equal(res.state.answers[answerKey("q_l1_category_auto", { loopVar: "brand", code: "1", label: "Apple", index: 1 } as any)], "phone");
  assert.equal(res.state.answers.q_auto_segment, "mid", "120/month → mid");
  assert.equal(res.state.answers.q_auto_fav_mirror, 1);
  assert.equal(res.state.answers.q_auto_os_family, "ios", "mapped Apple → ios");
  assert.equal(res.state.answers.q_auto_lf_mirror, res.state.answers.h_lf_brand_1);
  assert.equal(res.state.answers.q_quota_cell, "f_young");
});

test("Path A — calculations, hidden variables and end-of-survey piping", () => {
  const res = run("A");
  const c = res.state.calculated;
  assert.equal(c.N_BRANDS_USED, 3);
  assert.equal(c.N_AWARE, 6);
  assert.equal(c.N_AWARE_NOT_USED, 3);
  assert.equal(c.TOTAL_SPEND_12M, 1230);
  assert.equal(c.PCT_SUBSCRIPTIONS, 33.3);
  assert.equal(c.ANNUAL_SPEND, 1440);
  assert.equal(res.state.answers.h_age_group, "25-34");
  assert.equal(res.state.answers.h_eligible, 1);
  assert.equal(res.state.answers.h_loop_cap, 3);
  assert.equal(res.state.answers.h_quota_flag, "2_25-34");
  assert.equal(typeof c.ENGAGEMENT_SCORE, "number");
  assert.ok(["Digital Native", "Connected Mainstream", "Selective User"].includes(String(c.TECH_SEGMENT)));
  assert.equal(c.BUILD_TAG, "MASTER_DEMO_2026_v1", "on_load script ran");
  assert.equal(c.LAST_CLIENT_CODE, "C002", "loop inspection script saw the last iteration (Samsung)");
  assert.equal(c.LOOP_BRAND_COUNT, 3);
  assert.equal(c.LOOP_BRAND_ITEM_1_CODE, "1");
  assert.equal(c.LOOP_BRAND_ITEM_1_PRODUCT_ID, "PROD_001", "reference values are loop variables (column names upper-cased)");
  const calcPage = res.pages.find((p) => p.pageId === "p_calc_summary")!;
  assert.match(calcPage.texts.q_calc_confirm, /about 1230,/);
});

test("Path B — Apple only: one iteration, one List Fill item, second slot hidden", () => {
  const res = run("B");
  assert.equal(res.endStatus, "complete");
  assert.deepEqual(iterations(res, "brand", "p_l1_a"), ["1"]);
  assert.equal(res.state.calculated.LISTFILL_BRAND_EVAL_COUNT, 1);
  const lfPage = res.pages.find((p) => p.pageId === "p_lf_eval")!;
  assert.ok(lfPage.questionIds.includes("q_lf_sat_1"));
  assert.ok(!lfPage.questionIds.includes("q_lf_sat_2"), "LF_SAT_2 hidden when only one item was allocated");
  assert.ok(!res.pages.some((p) => p.pageId.startsWith("p_l5")), "no invalid years → LOOP_005 does not run");
});

test("Path C — seven brands: LOOP_001 capped at 6 by the hidden LOOP_CAP, LOOP_006 ×5, every list operation non-empty", () => {
  const res = run("C");
  assert.equal(res.endStatus, "complete");
  assert.equal(iterations(res, "brand", "p_l1_a").length, 6);
  assert.equal(res.state.answers.h_loop_cap, 6);
  assert.equal(iterations(res, "product", "p_l6").length, 5);
  const p1 = res.pages.find((p) => p.pageId === "p_listops_1")!;
  const p2 = res.pages.find((p) => p.pageId === "p_listops_2")!;
  for (const id of ["q_curious", "q_consider"]) assert.ok(p1.questionIds.includes(id), `${id} shown`);
  for (const id of ["q_core_brand", "q_never_seen"]) assert.ok(p2.questionIds.includes(id), `${id} shown`);
  const ctx = { def, state: res.state, loop: null };
  const codes = (id: string) => effectiveQuestion(q(id), ctx).options.map((o) => String(o.code)).sort();
  assert.deepEqual(codes("q_curious"), ["10", "11", "12", "8"], "aware − used");
  assert.deepEqual(codes("q_core_brand"), ["1", "2", "7"], "used ∩ trusted");
  assert.deepEqual(codes("q_consider"), ["1", "2", "3", "4", "5", "6", "7"], "used ∪ trusted, deduped");
  assert.deepEqual(codes("q_never_seen"), ["9"], "the one brand not ticked in BRANDS_AWARE");
  assert.equal(effectiveQuestion(q("q_random_three"), ctx).options.length, 3, "pick 3");
  assert.deepEqual(effectiveQuestion(q("q_sorted_pick"), ctx).options.map((o) => o.label), ["Apple", "Google", "Microsoft", "OnePlus", "Samsung", "Sony", "Xiaomi"], "a–z");
  assert.equal(effectiveQuestion(q("q_prioritized"), ctx).options[0].label, "Samsung", "favourite prioritised to the top");
  assert.deepEqual(codes("q_masked"), ["1", "2", "3", "4", "5", "6", "7"], "(used ∪ consider) ∩ aware");
});

test("Path D — declines consent: terminated as screened on page one", () => {
  const res = simulateRespondent(def, { answers: path("D").answers, seed: 104 });
  assert.equal(res.endStatus, "screened");
  assert.equal(res.pages.length, 1);
});

test("Path E — quota full: the quota_check node terminates with quota_full", () => {
  const res = simulateRespondent(def, {
    answers: path("E").answers, seed: 105,
    quotaCounts: { quota_gender: { qg_female: 150 }, quota_gender_age: { qga_f_2534: 45 } },
  });
  assert.equal(res.endStatus, "quota_full");
  assert.ok(res.pages.some((p) => p.pageId === "p_demo_dates"), "asked up to the quota check");
  assert.ok(!res.pages.some((p) => p.pageId === "p_tech_usage"), "nothing after it");
  // soft quota only flags
  const soft = simulateRespondent(def, { answers: path("A").answers, seed: 1, quotaCounts: { quota_soft_region: { qs_na: 200 } } });
  assert.equal(soft.endStatus, "complete");
});

test("Path F — List Fill cap: Apple at its maximum is rejected and the priority order moves to Samsung", () => {
  const res = run("F", { listFillCounts: { lf_brand_eval: { "1": 150 } } });
  const lf = res.listFills.find((l) => l.listFillId === "lf_brand_eval")!;
  assert.equal(lf.items[0].code, "2", "Samsung takes position 1");
  assert.ok(!lf.items.some((i) => i.code === "1"), "Apple not allocated");
  // and the trace explains why
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, path("F").answers);
  runCalculations(def, state, "on_page_submit");
  const decided = decideListFill({ def, listFill: def.listFills[0], state, counts: { lf_brand_eval: { "1": 150 } } });
  const apple = decided.trace.options.find((o: any) => o.code === "1") as any;
  assert.equal(apple.rejection ?? apple.reason ?? apple.status, apple.rejection ?? apple.reason ?? apple.status); // shape-agnostic: just make sure Apple is traced
  assert.ok(JSON.stringify(apple).includes("maximum_reached"), `Apple's trace should say maximum_reached: ${JSON.stringify(apple)}`);
  // when nobody has anything yet, Apple wins by priority
  const fresh = decideListFill({ def, listFill: def.listFills[0], state, counts: {} });
  assert.equal(fresh.items[0].code, "1");
});

test("Path G — a script defines the invalid items: LOOP_005 runs once for the implausible brand, with its own reference table", () => {
  const res = run("G");
  assert.equal(res.endStatus, "complete");
  assert.equal(iterations(res, "brand", "p_l1_a").length, 4);
  assert.deepEqual(res.state.calculated.INVALID_BRANDS, [{ code: "2", label: "40" }]);
  assert.deepEqual(iterations(res, "badyears", "p_l5"), ["2"]);
  const fix = res.pages.find((p) => p.pageId === "p_l5@2")!;
  assert.equal(fix.texts.q_l5_fix_years, "You entered 40 years for Samsung, which is more than your age (29). Please re-enter the number of years you have used Samsung.");
  assert.equal(iterations(res, "product", "p_l6").length, 3);
  assert.ok(res.state.flags.includes("implausible_years_used"));
});

test("Path H — skip logic to a section: 'No' on DETAIL_INTEREST lands on 11_Loop_Count", () => {
  const res = run("H");
  assert.equal(res.endStatus, "complete");
  const ids = res.pages.map((p) => p.pageId);
  const gate = ids.indexOf("p_brand_detail_gate");
  assert.equal(ids[gate + 1], "p_l6_count", `after the gate came ${ids[gate + 1]}`);
  assert.ok(!ids.some((id) => id.startsWith("p_lf_") || id.startsWith("p_listops") || id.startsWith("p_l1_") || id.startsWith("p_l3") || id.startsWith("p_l4")));
});

/* ------------------------------------------------------------ validation */

test("validation blocks what it should: cross-question, exact count, email, regex, conditional required", () => {
  const state = createResponseState(def, { seed: 1 });
  const ctx = { def, state, loop: null };
  const errs = (id: string, v: unknown, extra: Record<string, unknown> = {}) => {
    Object.assign(state.answers, extra, { [id]: v });
    return validatePage(def, [q(id)], ctx).map((e) => e.message);
  };
  assert.ok(errs("q_hh_children", 3, { q_hh_size: 3 }).some((m) => /fewer than/.test(m)));
  assert.deepEqual(errs("q_hh_children", 1, { q_hh_size: 3 }), []);
  assert.ok(errs("q_hw_spend", 90, { q_monthly_spend: 120, q_sub_spend: 40 }).length > 0, "40 + 90 > 120");
  assert.deepEqual(errs("q_hw_spend", 50, { q_monthly_spend: 120, q_sub_spend: 40 }), []);
  assert.ok(errs("q_exact_three", [1, 2]).length > 0);
  assert.deepEqual(errs("q_exact_three", [1, 2, 3]), []);
  assert.ok(errs("q_email", "not-an-email").length > 0);
  assert.ok(errs("q_postcode", "!").length > 0);
  assert.ok(errs("q_phone", "", { q_contact_ok: 1 }).length > 0, "required when contact ok");
  assert.deepEqual(errs("q_phone", "", { q_contact_ok: 2 }), [], "not required otherwise");
  assert.ok(errs("q_age", 17).length > 0);
  assert.ok(errs("q_age", 30.5).length > 0, "integer");
  assert.ok(errs("q_budget_next", 100, { q_sub_spend: 40 }).length > 0, "budget < 12 × subscriptions");
});

test("custom JavaScript validation: warranty end before purchase date blocks the page", () => {
  const state = createResponseState(def, { seed: 1 });
  state.answers.q_last_purchase = "2026-03-10"; state.answers.q_warranty_end = "2025-01-01";
  const r = runScripts(def, state, "on_submit", { scopeRef: "p_demo_dates" });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].questionRef, "q_warranty_end");
  state.answers.q_warranty_end = "2028-01-01";
  assert.equal(runScripts(def, state, "on_submit", { scopeRef: "p_demo_dates" }).errors.length, 0);
});

/* ------------------------------------------------------------ randomization */

test("randomization is seeded: stable per respondent, different across respondents, anchors stay put", () => {
  const order = (seed: number) => effectiveQuestion(q("q_aware"), { def, state: createResponseState(def, { seed }), loop: null }).options.map((o) => o.code);
  assert.deepEqual(order(5), order(5));
  assert.notDeepEqual(order(5), order(6));
  assert.equal(order(5).at(-1), 98, "None anchored bottom");
  const rand = (seed: number) => effectiveQuestion(q("q_rand_anchor"), { def, state: createResponseState(def, { seed }), loop: null }).options.map((o) => o.code);
  assert.deepEqual(rand(3).slice(-2), [98, 99]);
  // conditional randomization: under 35 shuffles, 35+ keeps the programmed order
  const young = createResponseState(def, { seed: 9 }); young.answers.q_age = 25;
  const old = createResponseState(def, { seed: 9 }); old.answers.q_age = 55;
  const programmed = q("q_rand_conditional").options.map((o) => o.code);
  assert.deepEqual(effectiveQuestion(q("q_rand_conditional"), { def, state: old, loop: null }).options.map((o) => o.code), programmed);
  assert.notDeepEqual(effectiveQuestion(q("q_rand_conditional"), { def, state: young, loop: null }).options.map((o) => o.code), programmed);
  // loop order 'random' is seeded too
  const s1 = createResponseState(def, { seed: 11 }); s1.answers.q_aware = [1, 2, 3, 4, 5, 6]; s1.answers.q_used = [1];
  const s2 = createResponseState(def, { seed: 11 }); Object.assign(s2.answers, s1.answers);
  const a = loopContexts(def, s1, loopNode("loop_003"), null).map((c) => c.code);
  const b = loopContexts(def, s2, loopNode("loop_003"), null).map((c) => c.code);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});

/* ------------------------------------------------------------ designs */

test("designs: conjoint, MaxDiff and custom design files are generated, versioned and referenced by questions/loops", () => {
  const cbc = def.designs.find((d) => d.id === "design_conjoint_phone")!;
  assert.equal(cbc.file!.rows.length, 2 * (8 + 1) * (3 + 1), "2 versions × 9 tasks × (3 alts + none)");
  assert.deepEqual(cbc.file!.columns, ["version", "task", "alt", "is_holdout", "Brand tier", "Price", "Battery life", "Warranty", "none_option"]);
  assert.equal(q("q_conjoint").settings.designRef, cbc.id);
  const md = def.designs.find((d) => d.id === "design_maxdiff_features")!;
  assert.equal(md.file!.rows.length, 2 * 9 * 5);
  assert.equal(q("q_maxdiff").settings.designRef, md.id);
  const cd = def.designs.find((d) => d.id === "design_custom_statements")!;
  assert.equal(cd.file!.rows.length, 6);
  assert.deepEqual(cd.file!.columns, ["version", "row", "statement", "component", "level", "block", "stimulus"]);
  assert.equal((loopNode("loop_007").source as any).designId, cd.id);
  for (const d of def.designs) { assert.equal(d.version, 1); assert.ok(d.seed); assert.ok(d.file!.generatedAt); }
});

/* ------------------------------------------------------------ dictionary + exports */

test("variable dictionary: questions, multi flags, calculations, hidden, List Fill, loop (positional + references), conjoint, MaxDiff — no duplicates", () => {
  const dict = buildVariableDictionary(def);
  const names = dict.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, "duplicate variable names in the dictionary");
  const has = (n: string) => assert.ok(names.includes(n), `missing variable ${n}`);
  has("AGE"); has("BRANDS_USED_1"); has("BRANDS_USED_12"); has("TOTAL_SPEND_12M"); has("ENGAGEMENT_SCORE"); has("AGE_GROUP"); has("ELIGIBLE_FLAG");
  has("LISTFILL_BRAND_EVAL_COUNT"); has("LISTFILL_BRAND_EVAL_1"); has("LISTFILL_BRAND_EVAL_2_CODE"); has("LISTFILL_TOPIC_1");
  has("LOOP_BRAND_COUNT"); has("LOOP_BRAND_ITEM_1_CODE"); has("LOOP_BRAND_ITEM_1_PRODUCT_ID"); has("LOOP_BRAND_ITEM_6_CLIENT_CODE");
  has("L1_SAT_1"); has("L1_SAT_6"); has("L1_WHY_1");
  has("L2_FEATURE_1_1"); has("L2_FEATURE_6_3");
  has("L3_TRY_1"); has("L3_TRY_3"); has("L5_FIX_YEARS_1"); has("L6_TYPE_5");
  has("CBC_TASKS"); has("MD_TASKS");
  has("PG_RATING_phone"); has("SUM_MONTHLY_you");
  const loopVars = dict.filter((v) => v.loopId === "loop_001");
  assert.ok(loopVars.length > 50, "LOOP_001 declares its iteration and reference variables");
  assert.ok(dict.some((v) => v.referenceColumn === "Product_ID" && v.loopId === "loop_001"));
  assert.ok(dict.some((v) => v.referenceColumn === "Tier" && v.loopId === "loop_lf"), "LOOP_LF's references are its own");
  assert.ok(!dict.some((v) => v.referenceColumn === "Tier" && v.loopId === "loop_001"), "…and never leak into LOOP_001");
  assert.ok(dict.filter((v) => v.hidden).length >= 5);
  assert.ok(dict.filter((v) => v.derived).length >= 10);
});

test("exports: complete JSON round-trips, CSV dictionary and XLSX build", async () => {
  const json = exportSurveyJson(def);
  const back = importSurveyJson(json);
  assert.deepEqual(back, def, "JSON is sufficient to reconstruct the survey");
  const parsed = JSON.parse(json);
  for (const k of ["meta", "branding", "questions", "flow", "logicFlow", "displayRules", "calculations", "quotas", "scripts", "designs", "listFills", "embeddedData", "deployment"]) {
    assert.ok(k in parsed, `JSON carries ${k}`);
  }
  assert.ok(parsed.logicFlow.nodes.length >= 15 && parsed.logicFlow.edges.length >= 20, "Logic Flow graph present");
  const csv = variableDictionaryToCSV(def);
  assert.ok(csv.includes("LOOP_BRAND_ITEM_1_PRODUCT_ID") && csv.includes("LISTFILL_BRAND_EVAL_1") && csv.includes("CBC_TASKS"));
  const xlsx = await exportVariableDictionaryXlsx(def);
  assert.ok((xlsx as any).length > 20000 || (xlsx as any).byteLength > 20000, "XLSX has content");
});

test("visibility is not execution: hidden questions still execute and feed logic", () => {
  const res = run("A");
  for (const id of ["h_age_group", "h_eligible", "h_quota_flag", "h_loop_cap", "h_score", "h_lf_brand_1", "h_lf_source", "h_lf_topic"]) {
    assert.notEqual(res.state.answers[id], undefined, `${id} has a value although it was never shown`);
    assert.ok(!res.pages.some((p) => p.questionIds.includes(id)), `${id} was never visible`);
  }
  assert.deepEqual(res.state.answers.h_lf_source, [1, 3], "script wrote used ∩ trusted into the hidden question");
  assert.equal(typeof res.state.answers.h_score, "number");
});

test("piping resolves everywhere on every path — no token survives", () => {
  for (const p of MASTER_DEMO_TEST_PATHS) {
    if (p.id === "D" || p.id === "E") continue;
    const res = run(p.id);
    for (const page of res.pages) for (const [id, text] of Object.entries(page.texts)) {
      assert.ok(!/\{\{/.test(text), `path ${p.id} ${page.pageId} ${id}: ${text}`);
    }
    // and the end message
    const end = def.flow.find((n) => n.type === "end" && n.id === "end_complete") as any;
    const msg = resolvePiping(end.message, { def, state: res.state, loop: null });
    assert.ok(!/\{\{/.test(msg), msg);
  }
});

test("auto-punch prefill on a page mirrors the runtime", () => {
  const state = createResponseState(def, { seed: 1 });
  state.answers.q_monthly_spend = 250; state.answers.q_fav_brand = 2;
  const filled = prefillQuestions([q("q_auto_segment"), q("q_auto_os_family")], { def, state, loop: null }, (x) => x.id);
  assert.deepEqual(filled.sort(), ["q_auto_os_family", "q_auto_segment"]);
  assert.equal(state.answers.q_auto_segment, "high");
  assert.equal(state.answers.q_auto_os_family, "android");
});
