/**
 * THE ADVANCED RESEARCH TEMPLATES, RUN (advanced.ts). The starters' test already holds every template to the
 * quality check with nothing to report and walks it once. These tests are about the METHOD: the screen ends the
 * right people, the derived variables come out as the guide says, each role or stage sees its own path, the
 * experimental design is answered task by task — and a generated population of fictional respondents gets through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acbcDone, autoAnswered, buildVariableDictionary } from "@rescript/engine";
import { advancedTemplates, findSurveyTemplate } from "./index.js";
import { simulateRespondent } from "./simulate.js";
import { generatePopulation } from "./generate.js";

const run = (key: string, answers: Record<string, unknown>, seed = 3) => {
  const def = findSurveyTemplate(key)!.build("t");
  const r = simulateRespondent(def, { seed, answers });
  return { def, r, a: r.state.answers as Record<string, unknown>, seen: new Set(r.pages.flatMap((p) => p.questionIds)) };
};

test("fifteen advanced templates in eight categories, each with a complete guide", () => {
  const all = advancedTemplates();
  assert.deepEqual(all.map((t) => t.key), ["adv_cbc", "adv_maxdiff", "adv_pricing", "adv_segmentation", "adv_b2b", "adv_journey", "adv_acbc", "adv_menu", "adv_diary", "adv_health", "adv_adtest", "adv_product", "adv_political", "adv_multicountry", "adv_hybrid"]);
  assert.equal(new Set(all.map((t) => t.guide!.category)).size, 8);
  for (const t of all) {
    const g = t.guide!;
    for (const k of ["objective", "audience", "methodology", "logic", "dataStructure", "sample", "analysis", "limitations", "whenEditing"] as const) assert.ok(g[k].length > 40, `${t.key}: ${k}`);
    assert.ok(g.useCases.length >= 3 && g.features.length >= 5 && g.methods.length >= 1 && g.minutes > 0, t.key);
  }
});

test("CBC: the screen, the quota, twelve tasks from the design, and the derived buyer type", () => {
  assert.equal(run("adv_cbc", { q_age: 17 }).r.endStatus, "screened", "under 18");
  assert.equal(run("adv_cbc", { q_age: 30, q_intent: 1 }).r.endStatus, "screened", "not in the market");
  assert.equal(run("adv_cbc", { q_age: 30, q_intent: 5, q_role: 3 }).r.endStatus, "screened", "not a decider");
  const ok = run("adv_cbc", { q_age: 41, q_intent: 5, q_role: 1, q_aware: [1, 3], q_driver: 2, q_budget: 3 });
  assert.equal(ok.r.endStatus, "complete");
  assert.equal(ok.a.h_age, "2", "41 → 35–54");
  assert.equal(ok.a.h_seg, "1", "price was the driver → price-led");
  assert.ok(ok.seen.has("q_cbc") && ok.a.q_cbc !== undefined, "the conjoint was answered");
  const design = ok.def.designs.find((d) => d.id === "design_cbc_ev")!;
  assert.equal((design.config as { tasks: number; holdoutTasks: number; versions: number }).tasks + (design.config as { holdoutTasks: number }).holdoutTasks, 12);
  /* knows no brand → the consideration question is not asked */
  assert.ok(!run("adv_cbc", { q_age: 41, q_intent: 5, q_role: 1, q_aware: [98] }).seen.has("q_consider"));
  /* a full age cell ends the interview at the quota check */
  const full = simulateRespondent(ok.def, { seed: 3, answers: { q_age: 41 }, quotaCounts: { quota_age: { cell_3554: 200 } } });
  assert.equal(full.endStatus, "quota_full");
});

test("MaxDiff: one channel used → the engine answers “most used” itself; the follow-up only for the dissatisfied", () => {
  const one = run("adv_maxdiff", { q_contact: 1, q_channel: [2], q_sat: 1 });
  assert.equal(one.a.q_main, 2);
  assert.ok(!one.seen.has("q_main"), "not shown");
  assert.ok(autoAnswered(one.r.state).includes("q_main"));
  assert.ok(one.seen.has("q_bad") && one.a.h_sat === "1");
  const two = run("adv_maxdiff", { q_contact: 1, q_channel: [1, 3], q_main: 3, q_sat: 5 });
  assert.ok(two.seen.has("q_main") && !two.seen.has("q_bad") && two.a.h_sat === "3");
  assert.ok(two.a.q_md !== undefined, "the MaxDiff was answered");
  assert.equal(run("adv_maxdiff", { q_contact: 2 }).r.endStatus, "screened");
});

test("Segmentation: the first rule that holds assigns the segment, and each segment gets its own follow-up", () => {
  const att = (o: Record<number, number>) => ({ 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, ...o });
  const base = { q_age: 29, q_shop: 1, q_cats: [1, 2], q_spend: 3 };
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["technology enthusiast", { ...base, q_att: att({ 4: 5 }) }, "1", "q_tech"],
    ["premium buyer", { ...base, q_shop: 2, q_att: att({ 2: 5 }) }, "2", "q_prem"],
    ["price-sensitive", { ...base, q_shop: 2, q_spend: 1, q_att: att({ 1: 4 }) }, "3", "q_price"],
    ["convenience seeker", { ...base, q_shop: 2, q_spend: 1, q_att: att({ 3: 4 }) }, "4", "q_conv"],
  ];
  for (const [name, answers, seg, follow] of cases) {
    const x = run("adv_segmentation", answers);
    assert.equal(x.a.h_seg, seg, name);
    assert.deepEqual(["q_tech", "q_prem", "q_price", "q_conv"].filter((q) => x.seen.has(q)), [follow], name);
  }
  const none = run("adv_segmentation", { ...base, q_shop: 2, q_att: att({}) });
  assert.equal(none.a.h_seg, "5");
});

test("B2B: decision-makers, influencers and end users each see their own path", () => {
  const base = { q_emp: 3, q_involve: 1, q_use: [1, 2], q_main: 2, q_budget: 2 };
  const dm = run("adv_b2b", base);
  assert.equal(dm.a.h_role, "1");
  assert.ok(dm.seen.has("q_budget") && dm.seen.has("q_alloc") && dm.seen.has("q_process") && !dm.seen.has("q_criteria") && !dm.seen.has("q_daily"));
  assert.match(String(dm.r.pages.find((p) => p.questionIds.includes("q_vsat"))?.texts.q_vsat), /Halcyon Suite/, "the main supplier is piped");
  const inf = run("adv_b2b", { ...base, q_involve: 3 });
  assert.ok(inf.a.h_role === "2" && inf.seen.has("q_criteria") && !inf.seen.has("q_budget") && !inf.seen.has("q_daily"));
  const user = run("adv_b2b", { ...base, q_involve: 4 });
  assert.ok(user.a.h_role === "3" && user.seen.has("q_daily") && !user.seen.has("q_criteria") && !user.seen.has("q_budget"));
  assert.equal(run("adv_b2b", { q_emp: 1 }).r.endStatus, "screened", "too small");
  assert.equal(run("adv_b2b", { q_emp: 3, q_involve: 5 }).r.endStatus, "screened", "not involved");
  /* "don't know" the budget → the split is not asked */
  assert.ok(!run("adv_b2b", { ...base, q_budget: 99 }).seen.has("q_alloc"));
});

test("Journey: the funnel carries forward, one bank ever used is the main bank without asking, and the stage routes", () => {
  const cust = run("adv_journey", { q_acct: 1, q_aware: [1, 2, 4], q_consider: [1, 4], q_ever: [4], q_stay: 2 });
  assert.equal(cust.a.q_main, 4, "the only bank ever used");
  assert.ok(!cust.seen.has("q_main") && autoAnswered(cust.r.state).includes("q_main"));
  assert.equal(cust.a.h_stage, "1");
  assert.ok(cust.seen.has("q_nps") && cust.seen.has("q_leave") && !cust.seen.has("q_barrier") && !cust.seen.has("q_know"));
  assert.match(String(cust.r.pages.find((p) => p.questionIds.includes("q_nps"))?.texts.q_nps), /Fennel Digital/);
  const cons = run("adv_journey", { q_acct: 1, q_aware: [1, 2], q_consider: [2], q_ever: [98] });
  assert.ok(cons.a.h_stage === "2" && cons.seen.has("q_barrier") && !cons.seen.has("q_nps") && !cons.seen.has("q_know"));
  const aware = run("adv_journey", { q_acct: 1, q_aware: [1, 2], q_consider: [98], q_ever: [98] });
  assert.ok(aware.a.h_stage === "3" && aware.seen.has("q_know") && !aware.seen.has("q_barrier"));
  assert.equal(run("adv_journey", { q_acct: 1, q_aware: [98] }).r.endStatus, "screened");
});

test("Pricing: three methods in one interview, open prices before any fixed price", () => {
  const x = run("adv_pricing", { q_owns: 1 });
  assert.equal(x.r.endStatus, "complete");
  const order = x.r.pages.flatMap((p) => p.questionIds);
  assert.ok(order.indexOf("q_elastic") > 0 && order.indexOf("q_comp") > order.indexOf("q_elastic"));
  const firstFixed = order.indexOf("q_elastic");
  const openPrice = order.findIndex((id) => x.def.questions.find((q) => q.id === id)?.type === "numeric");
  assert.ok(openPrice >= 0 && openPrice < firstFixed, "the open price questions come before any fixed price is shown");
  assert.ok((x.def.research?.analysisPlan?.tests ?? []).length >= 2, "the pricing analyses are planned");
  assert.equal(run("adv_pricing", { q_owns: 2 }).r.endStatus, "screened");
});

test("a fictional population gets through every advanced template with no blocked page and no script error", () => {
  for (const t of advancedTemplates()) {
    const rep = generatePopulation(t.build("pop"), { count: 60, seed: 20261112 });
    const blocked = rep.respondents.filter((r) => (r as { blocked?: unknown }).blocked);
    assert.equal(blocked.length, 0, `${t.key}: ${blocked.length} respondents could not get past a page`);
    const completes = rep.respondents.filter((r) => (r as { endStatus?: string }).endStatus === "complete").length;
    assert.ok(completes >= 8, `${t.key}: ${completes} of 60 complete`);
  }
});

/* ------------------------------------------------------------ part 2 */

test("ACBC: the adaptive exercise reaches a winner, and the follow-up depends on intent for it", () => {
  const x = run("adv_acbc", { q_age: 33, q_buy: 1, q_use: 3, q_sure: 2 });
  assert.equal(x.r.endStatus, "complete");
  assert.ok(acbcDone(x.a.q_acbc as never), "build → screen → tournament → a winner");
  assert.ok(x.seen.has("q_stop") && x.a.h_use === "2");
  assert.equal(run("adv_acbc", { q_age: 33, q_buy: 3 }).r.endStatus, "screened");
});

test("Menu: extras depend on the plan, the total is calculated, and being over budget changes the follow-up", () => {
  const biz = run("adv_menu", { q_resp: 1, q_budget: 100, q_plan: 3, q_ad_ai: 1, q_ad_sso: 1, q_ad_support: 2, q_ad_store: 2, q_ok: 2 });
  assert.ok(biz.seen.has("q_ad_sso") && !biz.seen.has("q_ad_seats"), "single sign-on on Business only; no extra seats there");
  assert.equal(biz.r.state.calculated.MENU_TOTAL, 205, "150 + 25 + 30");
  assert.equal(biz.r.state.calculated.MENU_OVER, 1);
  assert.ok(biz.seen.has("q_drop"));
  assert.match(String(biz.r.pages.find((p) => p.questionIds.includes("q_ok"))?.texts.q_ok), /\$205/);
  const small = run("adv_menu", { q_resp: 1, q_budget: 100, q_plan: 1, q_ad_seats: 1, q_ad_ai: 2, q_ad_support: 2, q_ad_store: 2, q_ok: 1 });
  assert.ok(small.seen.has("q_ad_seats") && !small.seen.has("q_ad_sso"));
  assert.equal(small.r.state.calculated.MENU_TOTAL, 60);
  assert.ok(!small.seen.has("q_drop") && !small.seen.has("q_missing"));
});

test("Diary: the day in the link decides the block — baseline, daily entry, wrap-up on day 7", () => {
  const at = (day: string, answers: Record<string, unknown> = {}) => { const def = findSurveyTemplate("adv_diary")!.build("t"); const r = simulateRespondent(def, { seed: 3, answers, embedded: { PID: "1042", DAY: day } }); return { r, seen: new Set(r.pages.flatMap((p) => p.questionIds)) }; };
  const d0 = at("0", { q_consent: 1 });
  assert.ok(d0.seen.has("q_skin") && !d0.seen.has("q_used") && !d0.seen.has("q_overall"));
  assert.equal(at("0", { q_consent: 2 }).r.endStatus, "screened");
  const d3 = at("3", { q_used: 3 });
  assert.ok(!d3.seen.has("q_skin") && d3.seen.has("q_whynot") && !d3.seen.has("q_feel") && !d3.seen.has("q_overall"));
  assert.match(String(d3.r.pages.find((p) => p.questionIds.includes("q_used"))?.texts.q_used), /Day 3 of 7/);
  const d7 = at("7", { q_used: 1, q_feel: { 1: 3, 2: 3, 3: 3, 4: 4 } });
  assert.ok(d7.seen.has("q_feel") && d7.seen.has("q_react") && d7.seen.has("q_overall"), "irritation is followed up; day 7 adds the wrap-up");
  assert.equal(d7.r.state.embedded.PID, "1042");
});

test("Healthcare: consent first; patients and professionals take different paths with their own eligibility rules", () => {
  assert.equal(run("adv_health", { q_consent: 2 }).r.endStatus, "screened");
  const pt = run("adv_health", { q_consent: 1, q_who: 1, q_cond: [3], q_treat: [1, 2] });
  assert.equal(pt.a.q_main, 3, "one condition → it is the main one, not asked");
  assert.ok(!pt.seen.has("q_main") && pt.seen.has("q_adhere") && pt.seen.has("q_journey") && !pt.seen.has("q_role"));
  assert.match(String(pt.r.pages.find((p) => p.questionIds.includes("q_treat"))?.texts.q_treat), /Asthma/);
  assert.ok(!run("adv_health", { q_consent: 1, q_who: 1, q_cond: [1, 2], q_main: 2, q_treat: [2] }).seen.has("q_adhere"), "no prescription → adherence not asked");
  assert.equal(run("adv_health", { q_consent: 1, q_who: 1, q_cond: [98] }).r.endStatus, "screened");
  const hcp = run("adv_health", { q_consent: 1, q_who: 2, q_role: 2, q_exp: 12, q_see: [1, 2] });
  assert.ok(hcp.seen.has("q_spec") && hcp.seen.has("q_barriers") && !hcp.seen.has("q_cond") && hcp.a.h_path === "2");
  assert.ok(!run("adv_health", { q_consent: 1, q_who: 2, q_role: 3, q_exp: 12, q_see: [1] }).seen.has("q_spec"), "specialty only for specialists");
  assert.equal(run("adv_health", { q_consent: 1, q_who: 2, q_role: 1, q_exp: 1 }).r.endStatus, "screened", "under two years in practice");
  /* the consent question is one the respondent must answer themselves */
  assert.ok(run("adv_health", { q_consent: 1, q_who: 3 }).seen.has("q_consent"));
});

test("Ad and concept test: awareness before exposure, every concept rated, a final preference", () => {
  const x = run("adv_adtest", { q_drink: 1, q_best: 2 });
  assert.equal(x.r.endStatus, "complete");
  const order = x.r.pages.flatMap((p) => p.questionIds);
  assert.ok(order.indexOf("q_pre") < order.findIndex((id) => x.def.questions.find((q) => q.id === id)?.variant?.startsWith("media.")), "awareness is asked before the ad is shown");
  assert.ok(x.seen.has("q_bestwhy"));
  assert.ok(!run("adv_adtest", { q_drink: 1, q_best: 9 }).seen.has("q_bestwhy"));
  assert.ok((x.def.research?.analysisPlan?.tests ?? []).length >= 2);
  assert.equal(run("adv_adtest", { q_drink: 4 }).r.endStatus, "screened");
});

test("Product test: every sample rated once, in an order that differs between respondents, and a safety screen", () => {
  const orders = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const x = run("adv_product", { q_eat: 1, q_allergy: 2 }, seed);
    const tasted = x.r.pages.filter((p) => p.pageId.startsWith("p_taste")).map((p) => String(p.loop?.code ?? p.loop?.label ?? p.pageId));
    assert.equal(tasted.length, 3, "three samples");
    assert.equal(new Set(tasted).size, 3, "each once");
    orders.add(tasted.join(">"));
  }
  assert.ok(orders.size >= 3, `serving order varies (${orders.size} orders in 8 respondents)`);
  assert.equal(run("adv_product", { q_eat: 1, q_allergy: 1 }).r.endStatus, "screened", "an allergy ends the test before tasting");
  const low = run("adv_product", { q_eat: 1, q_allergy: 2, q_like: 2, q_pref: "none" });
  assert.ok(low.seen.has("q_dislike") && !low.seen.has("q_buy"));
});

test("Political: leaners are counted with their candidate, likely voters are flagged, the image grid shows known candidates only", () => {
  const und = run("adv_political", { q_age: 44, q_reg: 1, q_turnout: 1, q_aware: [1, 3], q_vote: 8, q_lean: 3 });
  assert.ok(und.seen.has("q_lean") && !und.seen.has("q_firm"));
  assert.deepEqual([und.a.h_vote, und.a.h_likely], ["3", "1"]);
  const dec = run("adv_political", { q_age: 44, q_reg: 1, q_turnout: 4, q_aware: [2], q_vote: 2 });
  assert.ok(!dec.seen.has("q_lean") && dec.seen.has("q_firm"));
  assert.deepEqual([dec.a.h_vote, dec.a.h_likely], ["2", "2"]);
  assert.deepEqual(Object.keys(dec.a.q_image as object), ["2"], "one row: the candidate heard of");
  assert.equal(run("adv_political", { q_age: 44, q_reg: 1, q_aware: [98], q_vote: 8, q_lean: 8 }).a.h_vote, "8");
  assert.equal(run("adv_political", { q_age: 44, q_reg: 2 }).r.endStatus, "screened");
});

test("Multi-country: each country sees its own retailers, payment methods and currency; spend lands on one comparable band", () => {
  const jp = run("adv_multicountry", { q_country: 5, q_age: 30, q_online: 1, q_spend_5: 3 });
  assert.ok(jp.seen.has("q_spend_5") && !jp.seen.has("q_spend_1") && !jp.seen.has("q_spend_2"));
  assert.match(String(jp.def.questions.find((q) => q.id === "q_spend_5")!.options.map((o) => o.label).join(" ")), /¥9,000/);
  assert.equal(jp.a.h_spend, "3");
  const ind = run("adv_multicountry", { q_country: 1, q_age: 30, q_online: 1, q_spend_1: 1 });
  assert.equal(ind.a.h_spend, "1");
  assert.match(JSON.stringify(ind.def.questions.find((q) => q.id === "q_pay")!.options.find((o) => o.label === "UPI")?.visibleIf), /"value":1/);
  assert.equal(run("adv_multicountry", { q_country: 9 }).r.endStatus, "screened");
  const full = simulateRespondent(jp.def, { seed: 3, answers: { q_country: 5, q_age: 30 }, quotaCounts: { quota_country: { cell_c5: 300 } } });
  assert.equal(full.endStatus, "quota_full", "Japan is full; the other countries stay open");
});

test("Hybrid: both choice exercises in an order that varies and is recorded, the concept written for the segment, the ladder last", () => {
  const first = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const x = run("adv_hybrid", { q_age: 28, q_own: 1, q_att: { 1: 5, 2: 2, 3: 2, 4: 2 } }, seed);
    assert.equal(x.r.endStatus, "complete");
    const order = x.r.pages.flatMap((p) => p.questionIds);
    assert.ok(x.a.q_md !== undefined && x.a.q_cbc !== undefined, "both exercises answered");
    first.add(order.indexOf("q_md") < order.indexOf("q_cbc") ? "md" : "cbc");
    assert.ok(x.seen.has("q_c_health") && !x.seen.has("q_c_tech") && !x.seen.has("q_c_gen"), "health-driven → the health concept");
    assert.ok(order.indexOf("q_final") > Math.max(order.indexOf("q_md"), order.indexOf("q_cbc")));
  }
  assert.equal(first.size, 2, "both orders occur");
  const tech = run("adv_hybrid", { q_age: 28, q_own: 2, q_att: { 1: 2, 2: 5, 3: 2, 4: 2 } });
  assert.ok(tech.a.h_seg === "2" && tech.seen.has("q_c_tech"));
  assert.equal(run("adv_hybrid", { q_age: 28, q_own: 3 }).r.endStatus, "screened");
});

test("exports: every generated row is flat, and every column is one the survey's variable dictionary declares", () => {
  for (const t of advancedTemplates()) {
    const def = t.build("exp");
    const declared = new Set(buildVariableDictionary(def).map((v) => v.name));
    const rep = generatePopulation(def, { count: 25, seed: 20261113 });
    const completes = rep.respondents.filter((r) => r.endStatus === "complete");
    assert.ok(completes.length > 0, t.key);
    for (const r of completes) {
      /* a multiple choice also appears under its own name (the list of codes) beside its one-column-per-answer variables */
      const whole = new Set(def.questions.map((q) => q.variableName));
      const undeclared = Object.keys(r.vars).filter((k) => !declared.has(k) && !whole.has(k));
      assert.deepEqual(undeclared, [], `${t.key}: columns the dictionary does not know`);
      for (const [k, v] of Object.entries(r.vars)) if (declared.has(k)) assert.ok(v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v), `${t.key}: ${k} is not a flat value (${typeof v})`);
    }
    /* the research plan travels with the survey */
    assert.ok((def.research?.methodology ?? "").length > 40 && (def.research?.assumptions ?? []).some((a) => a.startsWith("Method — keep intact")), t.key);
  }
});
