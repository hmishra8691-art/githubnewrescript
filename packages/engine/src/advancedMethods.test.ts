import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type PlannedTest } from "@rescript/schema";
import { advancedPlanItems, advancedSuitability, gaborGrangerPattern, semModelFromDesign, ADVANCED_RULES } from "./advancedMethods.js";
import { readAdvancedRequest } from "./advancedIntent.js";
import { buildAnalysisFramework, explainPlanItem, requiredBase } from "./analysisFramework.js";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { interpretRequest } from "./nlIntent.js";
import { validateResearch } from "./researchValidation.js";
import { capabilityBrief, capabilityOf, methodologyOf } from "./capabilities.js";

/**
 * ADVANCED MODELS IN THE PLAN — the engine's half (2026-10-22): the SEM a research design describes, the
 * method-suitability rules, the Gabor–Granger ladder, what the generator proposes, the analysis actions'
 * options and refusals, the deterministic sentences, the validator and the registry. Every refusal names
 * the rule; the gate changes nothing when it refuses.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const agree = opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree");
const item = (id: string, v: string, text: string) => ({ id, code: v, variableName: v, type: "single_select", text, options: agree });
function study(over: { research?: Record<string, unknown>; questions?: unknown[]; designs?: unknown[] } = {}): SurveyDefinition {
  const qs = [
    item("q_p1", "PP1", "Prices are fair"), item("q_p2", "PP2", "It is good value"), item("q_p3", "PP3", "It is affordable"),
    item("q_t1", "TR1", "I trust the brand"), item("q_t2", "TR2", "The brand keeps its promises"), item("q_t3", "TR3", "The brand is honest"),
    item("q_i1", "PI1", "I will buy it"), item("q_i2", "PI2", "I would recommend it"), item("q_i3", "PI3", "I plan to buy within a year"),
    ...[1, 2, 3, 4].map((k) => ({ id: `q_u${k}`, code: `U${k}`, variableName: `U${k}`, type: "single_select", text: `Usage ${k}`, options: opts("Never", "Sometimes", "Often"), analysis: { modeling: ["latent_class"] } })),
    { id: "q_cbc", code: "CBC", variableName: "CBC", type: "conjoint_task", text: "Which would you choose?", settings: { designRef: "d_cbc" } },
    { id: "q_md", code: "MD", variableName: "MD", type: "maxdiff_task", text: "Most and least important", settings: { designRef: "d_md" } },
    { id: "q_age", code: "AGE", variableName: "AGE", type: "numeric", text: "Age" },
    { id: "q_ch", code: "CH", variableName: "CH", type: "single_select", text: "Channel", options: opts("Online", "Store") },
    ...(over.questions ?? []),
  ];
  return SurveyDefinition.parse({
    meta: { id: "s", code: "ADV", title: "Advanced" },
    designs: over.designs ?? [
      { id: "d_cbc", kind: "conjoint", name: "CBC", config: { attributes: [{ name: "Brand", levels: ["A", "B", "C"] }, { name: "Price", levels: ["1", "2", "3"] }], tasks: 12, alternativesPerTask: 3 } },
      { id: "d_md", kind: "maxdiff", name: "MD", config: { items: ["a", "b", "c", "d", "e", "f", "g", "h"], itemsPerTask: 4, tasks: 10 } },
    ],
    research: {
      objective: "Segment buyers and test what drives purchase intent",
      hypotheses: ["Trust increases purchase intent", "Trust mediates the effect of price perception on purchase intent", "Women are more satisfied than men", "The effect of trust on purchase intent is stronger for online buyers"],
      constructs: [
        { name: "Price perception", role: "independent", questionIds: ["q_p1", "q_p2", "q_p3"] },
        { name: "Trust", role: "mediator", questionIds: ["q_t1", "q_t2", "q_t3"] },
        { name: "Purchase intent", role: "dependent", questionIds: ["q_i1", "q_i2", "q_i3"] },
        { name: "online buyers", role: "moderator", questionIds: ["q_ch"] },
      ],
      sampleSize: 400,
      ...(over.research ?? {}),
    },
    questions: qs,
    flow: [{ type: "page", id: "p1", questionIds: qs.map((q) => (q as { id: string }).id) }, { type: "end", id: "e", status: "complete" }],
  });
}
const T = (x: Partial<PlannedTest> & Pick<PlannedTest, "method">): PlannedTest => ({ id: "x", variables: [], priority: 2, hypotheses: [], ...x } as PlannedTest);

test("the SEM a research design describes: a factor per multi-item construct, a path per hypothesis, the mediation's indirect effect defined, the rest said", () => {
  const m = semModelFromDesign(study());
  assert.ok(!("error" in m));
  if ("error" in m) return;
  assert.deepEqual(m.latents.map((l) => [l.name, l.items]), [["TRUST", ["TR1", "TR2", "TR3"]], ["PURCHASE_INTENT", ["PI1", "PI2", "PI3"]], ["PRICE_PERCEPTION", ["PP1", "PP2", "PP3"]]]);
  assert.match(m.syntax, /^PURCHASE_INTENT ~ p_h1\*TRUST {3}# H1, H2$/m);
  assert.match(m.syntax, /^TRUST ~ a_h2\*PRICE_PERCEPTION/m);
  assert.match(m.syntax, /^PURCHASE_INTENT ~ c_h2\*PRICE_PERCEPTION/m);
  assert.match(m.syntax, /^ind_h2 := a_h2\*p_h1$/m);
  assert.deepEqual(m.hypothesisPaths, { H1: "PURCHASE_INTENT ~ TRUST", H2: ":=ind_h2" });
  assert.deepEqual(m.skipped.map((s) => s.label), ["H3", "H4"]);
  assert.match(m.skipped[0].reason, /compares groups/); assert.match(m.skipped[1].reason, /compares groups|moderation — latent interactions are not estimated/);
  const modded = semModelFromDesign(study({ research: { hypotheses: ["Trust increases purchase intent", "online buyers moderates the effect of trust on purchase intent"] } }));
  assert.ok(!("error" in modded) && /moderation — latent interactions are not estimated/.test(modded.skipped[0].reason));
  /* the t-rule, counted: 9 indicators → 45 moments; 6 loadings + 9 residuals + 3 paths + 1 exogenous variance + 2 endogenous residuals = 21 */
  assert.equal(m.freeParameters, 21); assert.equal(m.df, 24);
  const only = semModelFromDesign(study(), { only: ["H1"] });
  assert.ok(!("error" in only) && only.latents.length === 2 && Object.keys(only.hypothesisPaths).join() === "H1");
  const none = semModelFromDesign(study({ research: { hypotheses: [] } }));
  assert.ok("error" in none && /no hypotheses/.test(none.error));
  const nominal = semModelFromDesign(study({ questions: [{ id: "q_br", code: "BR", variableName: "BR", type: "single_select", text: "Brand used", options: opts("Apple", "Samsung", "Other") }], research: { constructs: [{ name: "Trust", questionIds: ["q_br", "q_t1"] }, { name: "Purchase intent", questionIds: ["q_i1", "q_i2"] }], hypotheses: ["Trust increases purchase intent"] } }));
  assert.ok("error" in nominal && /rating-scale items/.test(nominal.error), JSON.stringify(nominal));
});

test("method suitability: sample minimums, indicators, identification and tasks per respondent — refusals name the rule", () => {
  const def = study();
  const block = (t: PlannedTest, d = def) => advancedSuitability(d, t).blocking.join(" ");
  const warn = (t: PlannedTest, d = def) => advancedSuitability(d, t).warnings.join(" ");
  /* HB */
  assert.equal(block(T({ method: "hb", variables: ["CBC"] })), "");
  assert.match(block(T({ method: "hb", variables: ["AGE"] })), /reads a CBC, ACBC, menu-based or MaxDiff exercise; AGE is a numeric question/);
  /* F4's runner estimates ACBC and menu-based exercises by HB too; a rating-based conjoint (CVA) is not a choice model */
  const suite = study({
    questions: [{ id: "q_acbc", code: "AC", variableName: "AC", type: "acbc_task", text: "Build yours", settings: { designRef: "d_acbc" } }, { id: "q_menu", code: "MENU", variableName: "MENU", type: "conjoint_task", text: "Pick", settings: { designRef: "d_menu" } }, { id: "q_cva", code: "CVA", variableName: "CVA", type: "conjoint_task", text: "Rate", settings: { designRef: "d_cva" } }],
    designs: [{ id: "d_cbc", kind: "conjoint", name: "CBC", config: { tasks: 12, alternativesPerTask: 3 } }, { id: "d_md", kind: "maxdiff", name: "MD", config: { items: ["a", "b", "c", "d"], itemsPerTask: 4, tasks: 4 } }, { id: "d_acbc", kind: "acbc", name: "AC", config: {} }, { id: "d_menu", kind: "menu", name: "MENU", config: { tasks: 8 } }, { id: "d_cva", kind: "cva", name: "CVA", config: {} }],
  });
  assert.equal(block(T({ method: "hb", variables: ["AC"] }), suite), "", "ACBC is estimated by HB");
  assert.equal(block(T({ method: "hb", variables: ["MENU"] }), suite), "", "menu-based is estimated by HB");
  assert.match(block(T({ method: "hb", variables: ["CVA"] }), suite), /rating-based conjoint \(CVA\)/);
  assert.ok(advancedPlanItems(suite, { tests: [] }).some((p) => p.test.method === "hb" && p.test.variables[0] === "AC" && /adaptive CBC/.test(p.why)), "the generator proposes HB beside an ACBC exercise");
  assert.match(block(T({ method: "hb", variables: ["CBC", "MD"] })), /exactly one/);
  const few = study({ designs: [{ id: "d_cbc", kind: "conjoint", name: "CBC", config: { tasks: 3, alternativesPerTask: 3 } }, { id: "d_md", kind: "maxdiff", name: "MD", config: { items: ["a", "b", "c", "d", "e", "f", "g", "h"], itemsPerTask: 3, tasks: 2, anchored: false } }] });
  assert.match(block(T({ method: "hb", variables: ["CBC"] }), few), /answers 3 choice tasks — HB needs at least 4/);
  assert.match(block(T({ method: "hb", variables: ["MD"] }), few), /shown about 0\.8 times per respondent/);
  const six = study({ designs: [{ id: "d_cbc", kind: "conjoint", name: "CBC", config: { tasks: 6, alternativesPerTask: 3 } }, { id: "d_md", kind: "maxdiff", name: "MD", config: { items: ["a"], itemsPerTask: 4, tasks: 10, anchored: true } }] });
  assert.match(warn(T({ method: "hb", variables: ["CBC"] }), six), /6 tasks per respondent: individual utilities will lean on the population prior/);
  assert.match(block(T({ method: "hb", variables: ["MD"] }), six), /anchored MaxDiff/);
  assert.match(block(T({ method: "hb", variables: ["CBC"] }), study({ research: { sampleSize: 30 } })), /needs at least 50 completes and the design expects 30/);
  assert.match(warn(T({ method: "hb", variables: ["CBC"] }), study({ research: { sampleSize: undefined } })), /No sample size is recorded/);
  /* latent class */
  assert.equal(block(T({ method: "latent_class", variables: ["U1", "U2", "U3", "U4"] })), "");
  assert.match(block(T({ method: "latent_class", variables: ["U1", "AGE"] })), /AGE is ratio/);
  assert.match(block(T({ method: "latent_class", variables: ["U1"] })), /at least 2 indicators/);
  assert.match(block(T({ method: "latent_class", variables: ["U1", "U2", "U3"], options: { covariates: ["AGE"] } })), /covariates is not estimated here/);
  assert.match(warn(T({ method: "latent_class", variables: ["CH", "U1"], options: { maxClasses: 4 } })), /At most \d classes are identified/);
  assert.match(block(T({ method: "latent_class", variables: ["U1", "U2", "U3"] }), study({ research: { sampleSize: 80 } })), /at least 100 completes/);
  /* SEM */
  const m = semModelFromDesign(def);
  if ("error" in m) throw new Error(m.error);
  assert.equal(block(T({ method: "sem", options: { syntax: m.syntax, freeParameters: m.freeParameters } })), "");
  assert.match(block(T({ method: "sem", options: { syntax: "F =~ PI1\nG =~ TR1 + TR2 + TR3" } })), /F has a single indicator/);
  assert.match(warn(T({ method: "sem", options: { syntax: "F =~ PI1 + PI2\nG =~ TR1 + TR2 + TR3\nF ~ G" } })), /F has only two indicators/);
  assert.match(block(T({ method: "sem", options: { syntax: "F =~ CH + TR1 + TR2" } })), /CH \(nominal\)/);
  assert.match(warn(T({ method: "sem", options: { syntax: "F =~ U1 + U2 + U3" } })), /U1, U2, U3 have fewer than five scale points/);
  assert.match(block(T({ method: "sem", options: { syntax: m.syntax, freeParameters: 21 } }), study({ research: { sampleSize: 90 } })), /needs at least 105 completes/);
  /* mediation, ω, Gabor–Granger */
  assert.match(block(T({ method: "regression", outcome: "PI1", variables: ["PP1"], options: { bootstrap: 5000 } })), /name the mediator/);
  assert.match(block(T({ method: "regression", outcome: "CH", variables: ["PP1"], mediator: "TR1", options: { bootstrap: 5000 } })), /outcome of a mediation must be numeric or a rating scale; CH is nominal/);
  assert.equal(block(T({ method: "regression", outcome: "PI1", variables: ["PP1"], mediator: "TR1", options: { bootstrap: 5000 } })), "");
  assert.match(block(T({ method: "reliability", variables: ["TR1", "TR2"], options: { omega: true } })), /needs at least three items — 2 named/);
  assert.match(block(T({ method: "pricing", variables: ["PP1", "PP2"], options: { method: "gabor_granger", prices: [5] } })), /one price per purchase-intent question/);
  assert.match(block(T({ method: "pricing", variables: ["PP1", "PP2"], options: { method: "gabor_granger", prices: [5, 5] } })), /same price/);
  assert.deepEqual(advancedSuitability(def, T({ method: "t_test", outcome: "PI1", groupBy: "CH" })), { blocking: [], warnings: [] }, "other methods untouched");
  assert.equal(ADVANCED_RULES.semPerParamMin, 5);
});

test("Gabor–Granger: the ladder of purchase-intent questions at stated prices is found; anything less is not", () => {
  const ladder = [9, 12, 15, 19].map((p, i) => ({ id: `g${i}`, code: `G${i + 1}`, variableName: `G${i + 1}`, type: "single_select", text: `How likely would you be to buy it at $${p}?`, options: opts("Definitely not", "Probably not", "Maybe", "Probably", "Definitely") }));
  assert.deepEqual(gaborGrangerPattern(study({ questions: ladder })), { questions: ["G1", "G2", "G3", "G4"], prices: [9, 12, 15, 19] });
  assert.equal(gaborGrangerPattern(study({ questions: ladder.slice(0, 1) })), null, "one price is not a ladder");
  assert.equal(gaborGrangerPattern(study({ questions: [ladder[0], { ...ladder[1], options: opts("Yes", "No") }] })), null, "a different answer scale breaks the ladder");
  const plan = buildAnalysisFramework(study({ questions: ladder }), { now: "" });
  const gg = plan.tests.find((t) => t.options?.method === "gabor_granger");
  assert.ok(gg && gg.method === "pricing" && gg.variables.join() === "G1,G2,G3,G4");
});

test("the plan generator proposes the advanced models the design calls for, never twice, and only what the design can carry", () => {
  const plan = buildAnalysisFramework(study(), { now: "" });
  const methods = plan.tests.map((t) => t.method);
  assert.equal(methods.filter((m) => m === "hb").length, 2);
  const sem = plan.tests.find((t) => t.method === "sem")!;
  assert.ok(sem && sem.hypotheses.includes("H1") && sem.options?.syntax, "two 3-item constructs and a sample that carries them → SEM");
  assert.deepEqual(plan.tests.find((t) => t.method === "latent_class")?.variables, ["U1", "U2", "U3", "U4"]);
  assert.ok(plan.tests.some((t) => t.method === "regression" && t.mediator && t.options?.bootstrap === 5000), "the mediated hypothesis");
  assert.ok(plan.tests.filter((t) => t.method === "reliability").every((t) => t.options?.omega === true));
  /* conservative: two-item constructs and no SEM asked for → regressions on the mean scores, no SEM */
  const two = study({ research: { constructs: [{ name: "Trust", questionIds: ["q_t1", "q_t2"] }, { name: "Purchase intent", questionIds: ["q_i1", "q_i2"] }], hypotheses: ["Trust increases purchase intent"] } });
  assert.ok(!buildAnalysisFramework(two, { now: "" }).tests.some((t) => t.method === "sem"));
  const asked = study({ research: { constructs: [{ name: "Trust", questionIds: ["q_t1", "q_t2"] }, { name: "Purchase intent", questionIds: ["q_i1", "q_i2"] }], hypotheses: ["Trust increases purchase intent"], methodology: "Online survey; structural equation model of the constructs" } });
  assert.ok(buildAnalysisFramework(asked, { now: "" }).tests.some((t) => t.method === "sem"), "the design asks for SEM");
  /* a sample the SEM cannot carry: not proposed (one sentence away, with the reason, if asked) */
  assert.ok(!buildAnalysisFramework(study({ research: { sampleSize: 150 } }), { now: "" }).tests.some((t) => t.method === "sem"));
  /* no segmentation objective → no latent class; the HB proposal is not repeated once planned */
  assert.ok(!buildAnalysisFramework(study({ research: { objective: "Measure satisfaction" } }), { now: "" }).tests.some((t) => t.method === "latent_class"));
  assert.equal(advancedPlanItems(study(), { tests: plan.tests }).length, 0, "everything already planned");
});

test("analysis actions: options read and bounded, SEM built from the hypotheses, refusals in words, options kept through an edit", () => {
  const def = study();
  const run = (actions: unknown[]) => { const { actions: a, rejected } = coerceSurveyActions(actions); return { out: applySurveyActions(def, a as SurveyAction[], { now: "2026-10-22T00:00:00Z" }), rejected }; };
  const sem = run([{ op: "add_analysis_test", method: "sem", hypotheses: ["H1", "H2"] }]);
  assert.deepEqual(sem.out.errors, []);
  const t = sem.out.def.research!.analysisPlan!.tests[0];
  assert.equal(t.method, "sem"); assert.match(String(t.options?.syntax), /TRUST =~ TR1 \+ TR2 \+ TR3/);
  assert.deepEqual(t.options?.hypothesisPaths, { H1: "PURCHASE_INTENT ~ TRUST", H2: ":=ind_h2" });
  assert.equal(t.variables.length, 9);
  assert.match(sem.out.results[0].description, /Planned a structural equation model with .* and 1 more \(paths for H1, H2\)/);
  const bad = run([{ op: "add_analysis_test", method: "sem", options: { syntax: "F =~ TR1 + TR2 + NOPE" } }]);
  assert.match(bad.out.errors.join(" "), /names NOPE, which is not a variable/);
  const lca = run([{ op: "add_analysis_test", method: "latent_class", variables: ["U1", "U2", "U3"], maxClasses: 6 }]);
  assert.deepEqual(lca.out.def.research!.analysisPlan!.tests[0].options, { maxClasses: 6 });
  assert.match(run([{ op: "add_analysis_test", method: "latent_class", variables: ["U1", "U2"], options: { maxClasses: 12 } }]).rejected.map((r) => r.reason).join(" "), /maxClasses must be a whole number from 1 to 8/);
  assert.match(run([{ op: "add_analysis_test", method: "hb", variables: ["AGE"] }]).out.errors.join(" "), /AGE is a numeric question/);
  const hb = run([{ op: "add_analysis_test", method: "hb", variables: ["CBC"] }]);
  assert.deepEqual(hb.out.errors, []);
  /* warnings travel with the change */
  const thin = applySurveyActions(study({ research: { sampleSize: 120 } }), coerceSurveyActions([{ op: "add_analysis_test", method: "hb", variables: ["CBC"] }]).actions as SurveyAction[]);
  assert.ok(thin.warnings.some((w) => /120 expected completes is thin/.test(w)), JSON.stringify(thin.warnings));
  /* an edit keeps the options, merges a patch, removes a key set to null */
  const id = lca.out.def.research!.analysisPlan!.tests[0].id;
  const edited = applySurveyActions(lca.out.def, coerceSurveyActions([{ op: "update_analysis_test", id, priority: 1, options: { minClasses: 2 } }]).actions as SurveyAction[]);
  assert.deepEqual(edited.def.research!.analysisPlan!.tests[0].options, { maxClasses: 6, minClasses: 2 });
  const cleared = applySurveyActions(edited.def, coerceSurveyActions([{ op: "update_analysis_test", id, options: { maxClasses: null } }]).actions as SurveyAction[]);
  assert.deepEqual(cleared.def.research!.analysisPlan!.tests[0].options, { minClasses: 2 });
  const untouched = applySurveyActions(edited.def, coerceSurveyActions([{ op: "update_analysis_test", id, reason: "segments" }]).actions as SurveyAction[]);
  assert.deepEqual(untouched.def.research!.analysisPlan!.tests[0].options, { maxClasses: 6, minClasses: 2 }, "an edit that does not name options keeps them");
  /* GG prices read from the questions when the item names the ladder */
  const ladder = [9, 12, 15].map((p, i) => ({ id: `g${i}`, code: `G${i + 1}`, variableName: `G${i + 1}`, type: "single_select", text: `Would you buy it at $${p}?`, options: opts("No", "Maybe", "Yes") }));
  const gg = applySurveyActions(study({ questions: ladder }), coerceSurveyActions([{ op: "add_analysis_test", method: "pricing", variables: ["G1", "G2", "G3"], options: { method: "gabor_granger" } }]).actions as SurveyAction[]);
  assert.deepEqual(gg.def.research!.analysisPlan!.tests[0].options, { method: "gabor_granger", prices: [9, 12, 15] });
  /* the re-run policy of the advanced models rides on set_analysis_plan, alone: the plan's items are untouched */
  const pol = applySurveyActions(lca.out.def, coerceSurveyActions([{ op: "set_analysis_plan", advancedRerun: { mode: "threshold", newResponses: 100 } }]).actions as SurveyAction[]);
  assert.deepEqual(pol.errors, []);
  assert.deepEqual(pol.def.research!.analysisPlan!.advancedRerun, { mode: "threshold", newResponses: 100 });
  assert.equal(pol.def.research!.analysisPlan!.tests.length, 1, "no list replaced");
  assert.match(pol.results[0].description, /re-run after 100 new completes/);
  assert.match(coerceSurveyActions([{ op: "set_analysis_plan", advancedRerun: { mode: "threshold" } }]).rejected.map((r) => r.reason).join(" "), /needs newResponses/);
  assert.match(coerceSurveyActions([{ op: "set_analysis_plan", advancedRerun: { mode: "weekly" } }]).rejected.map((r) => r.reason).join(" "), /"manual".*"threshold"/);
  const back = applySurveyActions(pol.def, coerceSurveyActions([{ op: "set_analysis_plan", advancedRerun: null }]).actions as SurveyAction[]);
  assert.equal(back.def.research!.analysisPlan!.advancedRerun, undefined);
});

test("sentences → actions through the gate (deterministic): HB, latent class, mediation, ω, SEM, CFA, Gabor–Granger — and refusals with the rule", () => {
  const def = study();
  const read = (s: string) => interpretRequest(def, s, {});
  const acts = (s: string) => { const r = read(s); assert.equal(r.kind, "actions", `${s}: ${JSON.stringify(r)}`); return r.kind === "actions" ? r.actions as unknown as Record<string, unknown>[] : []; };
  assert.deepEqual(acts("run HB on the conjoint").map((a) => [a.op, a.method, a.variables]), [["add_analysis_test", "hb", ["CBC"]]]);
  assert.deepEqual(acts("estimate hierarchical Bayes utilities for the MaxDiff")[0].variables, ["MD"]);
  const lca = acts("segment respondents with latent class using U1–U4 with 2 to 6 classes")[0];
  assert.deepEqual([lca.method, lca.variables, (lca.options as Record<string, unknown>).maxClasses], ["latent_class", ["U1", "U2", "U3", "U4"], 6]);
  const med = acts("test H2 as a mediation through trust");
  assert.deepEqual(med.map((a) => a.op), ["add_derived_variable", "add_derived_variable", "add_derived_variable", "add_analysis_test"]);
  assert.deepEqual([med[3].outcome, med[3].variables, med[3].mediator, med[3].hypotheses, (med[3].options as Record<string, unknown>).bootstrap], ["PURCHASE_INTENT_SCORE", ["PRICE_PERCEPTION_SCORE"], "TRUST_SCORE", ["H2"], 5000]);
  const om = acts("check reliability with omega");
  assert.equal(om.length, 3); assert.ok(om.every((a) => (a.options as Record<string, unknown>).omega === true));
  assert.equal(acts("compute McDonald's omega for trust")[0].variables?.toString(), "TR1,TR2,TR3");
  assert.deepEqual(acts("test H1 and H2 with a structural equation model")[0].hypotheses, ["H1", "H2"]);
  assert.match(String((acts("run a CFA of the constructs")[0].options as Record<string, unknown>).syntax), /PRICE_PERCEPTION =~ PP1 \+ PP2 \+ PP3/);
  /* refused, nothing applied, the rule named */
  const no = read("segment respondents with latent class using PP1 with AGE as covariates");
  assert.equal(no.kind, "refused"); assert.match(no.kind === "refused" ? no.reason : "", /^Not planned: Latent class with covariates is not estimated/);
  const hbAge = read("run HB on AGE");
  assert.ok(hbAge.kind === "refused" && /AGE is a numeric question/.test(hbAge.reason));
  assert.ok(read("test H9 as a mediation through trust").kind === "refused");
  assert.ok(read("check the reliability of TR1 to TR2 with omega").kind === "refused");
  const ggNone = read("plan a Gabor-Granger demand curve");
  assert.ok(ggNone.kind === "refused" && /No purchase-intent questions at a ladder of prices/.test(ggNone.reason));
  /* already planned → said, nothing to add */
  const planned = applySurveyActions(def, coerceSurveyActions([{ op: "add_analysis_test", method: "hb", variables: ["CBC"] }]).actions as SurveyAction[]).def;
  const again = interpretRequest(planned, "run HB on the conjoint", {});
  assert.ok(again.kind === "refused" && again.noop === true);
  /* two exercises of a kind → which one? */
  const twoCbc = study({ questions: [{ id: "q_cbc2", code: "CBC2", variableName: "CBC2", type: "conjoint_task", text: "Second", settings: { designRef: "d_cbc" } }] });
  assert.equal(interpretRequest(twoCbc, "run HB on the conjoint", {}).kind, "clarify");
  /* not ours: the methods hand-off and other recognisers still read their sentences */
  assert.equal(readAdvancedRequest(def, "add a None option to the conjoint"), null);
  assert.equal(interpretRequest(def, "add a None option to the conjoint", {}).kind, "model");
});

test("the research validator flags a planned advanced item the design cannot carry; the registry says what moved", () => {
  const def = study({ research: { sampleSize: 30, analysisPlan: { crosstabs: [], derived: [], segments: [], tests: [{ id: "t_hb", method: "hb", variables: ["CBC"], priority: 2, hypotheses: [] }, { id: "t_lc", method: "latent_class", variables: ["U1", "U2", "U3"], priority: 2, hypotheses: [] }] } } });
  const v = validateResearch(def);
  const method = v.items.filter((i) => i.area === "method" && i.source === "research");
  assert.ok(method.some((i) => i.class === "blocking" && /planned hb \(t_hb\) cannot run as designed: Hierarchical Bayes needs at least 50 completes/.test(i.message)), JSON.stringify(method));
  assert.ok(method.some((i) => i.class === "blocking" && /latent class \(t_lc\)/.test(i.message)));
  assert.equal(capabilityOf("analysis:hb")?.status, "supported");
  assert.equal(capabilityOf("analysis:sem")?.status, "supported");
  assert.equal(capabilityOf("analysis:latent_class")?.status, "partial");
  assert.deepEqual(capabilityOf("analysis:hb")?.implementedAs?.analysis, ["hb"]);
  assert.equal(methodologyOf("gabor_granger")?.status, "supported");
  assert.match(capabilityOf("analysis:reliability")?.note ?? "", /McDonald's ω/);
  assert.ok(capabilityBrief().length < 2200);
});

test("why this analysis, and the base it needs: SEM, HB and latent class explained by the engine", () => {
  const def = study();
  const plan = buildAnalysisFramework(def, { now: "" });
  const sem = plan.tests.find((t) => t.method === "sem")!, hb = plan.tests.find((t) => t.method === "hb")!, lc = plan.tests.find((t) => t.method === "latent_class")!;
  const e = explainPlanItem(def, sem, plan);
  assert.match(e.why, /H1 \(PURCHASE_INTENT ~ TRUST\)/); assert.match(e.expectedOutput, /CFI, TLI, RMSEA/); assert.ok(e.limitations.some((l) => /does not show causation/.test(l)));
  assert.match(explainPlanItem(def, hb, plan).expectedOutput, /convergence diagnostics/);
  assert.match(explainPlanItem(def, lc, plan).why, /1–5 classes by BIC/);
  assert.equal(requiredBase(def, sem, { plan }).minimum, 210);
  assert.equal(requiredBase(def, hb, { plan }).minimum, ADVANCED_RULES.hbWarn);
  assert.equal(requiredBase(def, lc, { plan }).minimum, ADVANCED_RULES.lcaWarn);
  const med = plan.tests.find((t) => t.method === "regression" && t.mediator)!;
  assert.match(explainPlanItem(def, med, plan).expectedOutput, /BCa intervals from 5000 seeded bootstrap resamples/);
});
