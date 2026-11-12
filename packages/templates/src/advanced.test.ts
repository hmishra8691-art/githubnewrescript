/**
 * THE ADVANCED RESEARCH TEMPLATES, RUN (advanced.ts). The starters' test already holds every template to the
 * quality check with nothing to report and walks it once. These tests are about the METHOD: the screen ends the
 * right people, the derived variables come out as the guide says, each role or stage sees its own path, the
 * experimental design is answered task by task — and a generated population of fictional respondents gets through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoAnswered } from "@rescript/engine";
import { advancedTemplates, findSurveyTemplate } from "./index.js";
import { simulateRespondent } from "./simulate.js";
import { generatePopulation } from "./generate.js";

const run = (key: string, answers: Record<string, unknown>, seed = 3) => {
  const def = findSurveyTemplate(key)!.build("t");
  const r = simulateRespondent(def, { seed, answers });
  return { def, r, a: r.state.answers as Record<string, unknown>, seen: new Set(r.pages.flatMap((p) => p.questionIds)) };
};

test("six advanced templates, each with a complete guide", () => {
  const all = advancedTemplates();
  assert.deepEqual(all.map((t) => t.key), ["adv_cbc", "adv_maxdiff", "adv_pricing", "adv_segmentation", "adv_b2b", "adv_journey"]);
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
    assert.ok(completes >= 10, `${t.key}: ${completes} of 60 complete`);
  }
});
