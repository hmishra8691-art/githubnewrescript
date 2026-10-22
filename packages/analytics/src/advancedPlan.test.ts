import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisFramework, researchTraceability } from "@rescript/engine";
import type { PlannedTest, SurveyDefinition } from "@rescript/schema";
import { gaborGrangerFixture, intelligentFixture, advSpec } from "./models/fixture.js";
import { plannedAnalyses, testDefinition, type PlannedAnalysis } from "./planBridge.js";
import { plannedItemReadiness, analysisReadiness } from "./planCheck.js";
import { variableMetadata } from "./dataset.js";
import { runPlan } from "./findings.js";
import { runAnalysis } from "./analyses/index.js";
import { advancedFacts, advancedNarrative, narrativeMarkdown, semPathDiagramSvg } from "./advancedNarrative.js";
import { advancedStaleness } from "./advancedStale.js";
import { checkSentence, claimsFromItems, printedNumbers } from "./claims.js";
import { draftReport, gateInterpretation, interpretationBrief, type BuilderItem, type ReportBrief } from "./reportBuilder.js";
import type { AnalysisDefinition } from "./types.js";

/**
 * ADVANCED MODELS FROM THE PLAN (2026-10-22), end to end on data with a known structure: the generator proposes
 * HB, SEM, latent class, a bootstrapped mediation and ω when the design calls for them; each planned item has ONE
 * readiness rule (valid and invalid per method); the run executes them (HB as a pending job unless its finished
 * result is handed in), reads each hypothesis from its own SEM path, and the traceability says "tested" only with
 * a run; the engine's narrative prints only numbers the result printed; the gate holds a model's sentences to the
 * same claims (per-respondent tables excluded, digits of any script read); the report carries it all.
 */
const F = intelligentFixture({ n: 300 });
const plan = buildAnalysisFramework(F.def, { now: "2026-10-22T00:00:00Z" });
const def: SurveyDefinition = { ...F.def, research: { ...F.def.research!, analysisPlan: plan } };
const dict = variableMetadata(def);
const byMethod = (m: string) => plan.tests.filter((t) => t.method === m);

test("the generator proposes the advanced models the design calls for — and says why", () => {
  const hb = byMethod("hb");
  assert.deepEqual(hb.map((t) => t.variables[0]).sort(), ["CBC", "MD"], "HB beside the CBC and the MaxDiff");
  const [sem] = byMethod("sem");
  assert.ok(sem, "SEM for hypotheses between multi-item constructs");
  assert.deepEqual(sem.hypotheses, ["H1", "H2", "H3"]);
  assert.deepEqual(sem.options?.hypothesisPaths, { H1: "PURCHASE_INTENT ~ TRUST", H2: ":=ind_h2", H3: "PURCHASE_INTENT ~ PRICE_PERCEPTION" });
  assert.match(String(sem.options?.syntax), /PRICE_PERCEPTION =~ X1 \+ X2 \+ X3/);
  assert.match(String(sem.options?.syntax), /ind_h2 := a_h2\*p_h1/);
  const [lca] = byMethod("latent_class");
  assert.deepEqual(lca.variables, ["U1", "U2", "U3", "U4", "U5", "U6"], "latent class of the tagged indicators, for a segmentation objective");
  const med = plan.tests.find((t) => t.method === "regression" && t.mediator);
  assert.ok(med && med.options?.bootstrap === 5000 && med.hypotheses.includes("H2"), "the mediated hypothesis bootstrapped");
  const rel = byMethod("reliability");
  assert.equal(rel.length, 3); assert.ok(rel.every((t) => t.options?.omega === true), "ω on every three-item scale");
  for (const t of [...hb, sem, lca]) assert.ok(t.reason && t.reason.length > 20, `${t.method} says why`);
});

test("the plan becomes analyses: each method's own settings, the plan's bookkeeping last", () => {
  const [sem] = byMethod("sem");
  const d = testDefinition(sem, advSpec, def);
  assert.equal(d.kind, "sem");
  assert.equal(d.options?.planned, sem.id);
  assert.equal(d.options?.syntax, sem.options?.syntax);
  assert.deepEqual(d.options?.hypothesisPaths, sem.options?.hypothesisPaths);
  assert.equal(d.options?.freeParameters, undefined, "a key the runner does not read is not passed");
  const hb = testDefinition(byMethod("hb")[0], advSpec, def);
  assert.equal(hb.kind, "hb"); assert.equal(hb.options?.burnIn, 5000);
  const med = testDefinition(plan.tests.find((t) => t.method === "regression" && t.mediator)!, advSpec, def);
  assert.equal(med.options?.model, "mediation"); assert.equal(med.options?.bootstrap, 5000);
  /* an item planned before options existed is translated exactly as before */
  const old: PlannedTest = { id: "t_old", method: "regression", outcome: "Y1", variables: ["X1"], priority: 1, hypotheses: [] };
  assert.deepEqual(testDefinition(old, advSpec, def).options, { planned: "t_old", model: "linear" });
});

test("ONE readiness rule per advanced item — valid and invalid, in the researcher's words", () => {
  const ready = (t: Partial<PlannedTest> & Pick<PlannedTest, "method">) => plannedItemReadiness({ kind: "test", test: { variables: [], ...t } as PlannedTest }, dict, def);
  /* HB */
  assert.ok(ready({ method: "hb", variables: ["CBC"] }).ready);
  assert.match(ready({ method: "hb" }).missing.join(" "), /reads one CBC/);
  assert.match(ready({ method: "hb", variables: ["CBC", "MD"] }).missing.join(" "), /exactly one/);
  assert.match(ready({ method: "hb", variables: ["SAT"] }).missing.join(" "), /single select question/);
  assert.match(ready({ method: "hb", variables: ["CBC"], options: { burnIn: 150000, draws: 100000 } }).missing.join(" "), /200,000/);
  /* latent class */
  assert.ok(ready({ method: "latent_class", variables: ["U1", "U2", "U3", "U4"] }).ready);
  assert.match(ready({ method: "latent_class" }).missing.join(" "), /indicators/);
  assert.match(ready({ method: "latent_class", variables: ["U1"] }).missing.join(" "), /at least two categorical/);
  assert.match(ready({ method: "latent_class", variables: ["U1", "U2", "U3"], options: { covariates: ["SAT"] } }).missing.join(" "), /covariates \(SAT\) is not estimated/);
  assert.match(ready({ method: "latent_class", variables: ["U1", "U2", "U3"], options: { minClasses: 0, maxClasses: 9 } }).missing.join(" "), /1 to at most 8/);
  /* SEM */
  const [sem] = byMethod("sem");
  assert.ok(ready(sem).ready, ready(sem).missing.join(" "));
  assert.match(ready({ method: "sem", variables: ["X1"] }).missing.join(" "), /needs its model/);
  assert.match(ready({ method: "sem", variables: ["X1"], options: { syntax: "F =~ X1 + NOPE + X3" } }).missing.join(" "), /NOPE/);
  assert.match(ready({ method: "sem", variables: ["X1"], options: { syntax: "F =~ X1 + X2" } }).missing.join(" "), /identified|two indicators|t-rule/);
  assert.match(ready({ ...sem, options: { ...sem.options, hypothesisPaths: { H1: "TRUST ~ PURCHASE_INTENT" } } }).warnings.join(" "), /not a path in the model/);
  /* the bootstrapped mediation */
  assert.ok(ready({ method: "regression", outcome: "Y1", variables: ["X1"], mediator: "M1", options: { bootstrap: 2000 } }).ready);
  assert.match(ready({ method: "regression", outcome: "Y1", variables: ["X1"], options: { bootstrap: 2000 } }).missing.join(" "), /name the mediator/);
  assert.match(ready({ method: "regression", outcome: "Y1", variables: ["X1"], mediator: "M1", options: { bootstrap: 50 } }).missing.join(" "), /between 200 and 20,000/);
  /* ω */
  assert.ok(ready({ method: "reliability", variables: ["X1", "X2", "X3"], options: { omega: true } }).ready);
  assert.match(ready({ method: "reliability", variables: ["X1", "X2"], options: { omega: true } }).missing.join(" "), /McDonald's ω needs at least three items/);
  assert.ok(ready({ method: "reliability", variables: ["X1", "X2"] }).ready, "α alone with two items, as before");
  /* the same rule refuses the definition at the run route (analysisReadiness on the built analysis) */
  assert.equal(analysisReadiness(testDefinition({ id: "x", method: "latent_class", variables: ["U1"], priority: 2, hypotheses: [] }, advSpec, def), dict).ready, false);
});

test("Gabor–Granger from the plan: the ladder found with its prices, refused without them, run to a revenue-maximising price", () => {
  const G = gaborGrangerFixture();
  const p = buildAnalysisFramework(G.def, { now: "" });
  const gg = p.tests.find((t) => t.method === "pricing" && t.options?.method === "gabor_granger");
  assert.ok(gg, "the price ladder is planned");
  assert.deepEqual(gg!.options?.prices, G.prices);
  const gdict = variableMetadata(G.def);
  assert.ok(plannedItemReadiness({ kind: "test", test: gg! }, gdict, G.def).ready);
  const noPrices = plannedItemReadiness({ kind: "test", test: { ...gg!, options: { method: "gabor_granger" } } }, gdict, G.def);
  assert.match(noPrices.missing.join(" "), /needs the price of each of the 4 purchase-intent questions/);
  const short = plannedItemReadiness({ kind: "test", test: { ...gg!, options: { method: "gabor_granger", prices: [1, 2] } } }, gdict, G.def);
  assert.match(short.missing.join(" "), /2 price points for 4 purchase-intent items/);
  const r = runAnalysis(testDefinition(gg!, G.ds.spec, G.def), G.ds);
  const table = r.tables.find((t) => t.id === "gg")!;
  assert.deepEqual(table.rows.map((x) => x.price), G.prices);
  const probs = table.rows.map((x) => x.probability as number);
  assert.ok(probs.every((v, i) => i === 0 || v <= probs[i - 1]), `demand falls with price: ${probs}`);
  /* the math: revenue index = share buying × price; the maximum is the arg-max of that product */
  const revenue = table.rows.map((x) => x.revenue as number);
  table.rows.forEach((x, i) => assert.ok(Math.abs((x.probability as number) / 100 * G.prices[i] - revenue[i]) < 0.03, `${x.probability} × ${G.prices[i]} vs ${revenue[i]}`));
  const best = G.prices[revenue.indexOf(Math.max(...revenue))];
  const n = advancedNarrative(testDefinition(gg!, G.ds.spec, G.def), r)!;
  assert.equal(n.method, "gabor_granger");
  assert.match(n.summary[0], new RegExp(`peaks at a price of ${best}`));
});

/* ---------------------------------------------------------------- the run */

const items: PlannedAnalysis[] = plannedAnalyses(def, F.ds.spec);
const hbSmall = (p: PlannedAnalysis): PlannedAnalysis => ({ ...p, definition: { ...p.definition, options: { ...p.definition.options, chains: 2, burnIn: 1000, draws: 1000, thin: 2 } } });
const run = runPlan(def, F.ds, { items, discover: false });

test("the run: HB waits for its job; SEM reads each hypothesis from its own path; the traceability says tested only with a run", () => {
  const hb = run.items.filter((it) => it.definition.kind === "hb");
  assert.equal(hb.length, 2);
  assert.ok(hb.every((it) => it.error?.code === "job_pending" && it.provenance?.inputHash), "pending, with the input hash its job is cached under");
  assert.ok(run.warnings.some((w) => /2 models run as a background job/.test(w)));
  const sem = run.items.find((it) => it.definition.kind === "sem")!;
  assert.ok(!sem.error, sem.error?.message);
  const tagged = (h: string) => sem.findings.filter((f) => f.hypotheses.includes(h));
  assert.deepEqual(tagged("H1").map((f) => f.variables), [["PURCHASE_INTENT", "TRUST"]]);
  assert.deepEqual(tagged("H3").map((f) => f.variables), [["PURCHASE_INTENT", "PRICE_PERCEPTION"]]);
  assert.ok(tagged("H2").length === 1 && tagged("H2")[0].kind === "mediation");
  const verdict = (h: string) => run.verdicts.find((v) => v.label === h)!;
  assert.equal(verdict("H1").verdict, "supported", verdict("H1").reason);
  assert.equal(verdict("H2").verdict, "supported", verdict("H2").reason);
  assert.equal(verdict("H1").direction?.contradicting, 0);
  /* the traceability matrix: planned before a run, tested with one */
  const before = researchTraceability(def);
  assert.ok(before.rows.filter((r) => r.kind === "hypothesis").every((r) => !/^tested/.test(r.status)), "no 'tested' without a run");
  assert.ok(before.rows.find((r) => r.id === "H1")?.analyses.some((a) => /sem|structural/i.test(JSON.stringify(a))), "the SEM is in the matrix as H1's planned analysis");
  const after = researchTraceability(def, { verdicts: run.verdicts.map((v) => ({ label: v.label, verdict: v.verdict })) });
  assert.equal(after.rows.find((r) => r.id === "H1")?.status, "tested_supported");
});

test("a finished HB job's result joins the run (precomputed); a model that cannot be estimated makes its hypothesis inconclusive, with why", () => {
  const hbItem = hbSmall(items.find((p) => p.definition.kind === "hb" && p.definition.variables[0] === "MD")!);
  const done = runAnalysis(hbItem.definition, F.ds);
  assert.ok(!done.error && done.tables.some((t) => t.id === "hb_shares"), done.warnings.join(" "));
  const r2 = runPlan(def, F.ds, { items: items.map((p) => (p.definition.kind === "hb" && p.definition.variables[0] === "MD" ? hbItem : p)), discover: false, precomputed: (p) => (p === hbItem ? done : undefined) });
  const md = r2.items.find((it) => it.definition.kind === "hb" && it.definition.variables[0] === "MD")!;
  assert.ok(!md.error && md.result.tables.some((t) => t.id === "hb_shares"));
  assert.ok(r2.items.find((it) => it.definition.kind === "hb" && it.definition.variables[0] === "CBC")!.error?.code === "job_pending", "the other exercise still waits for its job");
  /* an SEM the data cannot identify: the hypothesis is inconclusive and says the model could not be estimated */
  const bad: PlannedAnalysis = { definition: { name: "SEM H1 (two items)", kind: "sem", dataset: F.ds.spec, variables: ["Y1", "M1"], options: { syntax: "F1 =~ Y1\nF1 ~ M1", planned: "t_bad", hypotheses: ["H1"] } }, source: { kind: "test", id: "t_bad" }, priority: 1, hypotheses: ["H1"] };
  const r3 = runPlan(def, F.ds, { items: [bad], discover: false });
  const v = r3.verdicts.find((x) => x.label === "H1")!;
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.reason, /could not be estimated/);
});

/* ---------------------------------------------------------------- the narrative, the gate, the report */

const builderItem = (it: { definition: AnalysisDefinition; result: BuilderItem["result"] }, id: string): BuilderItem => ({ id, name: it.definition.name, definition: it.definition, result: it.result });

test("the engine's narrative of every advanced result prints only numbers the result printed, with diagnostics and caveats", () => {
  const hbItem = hbSmall(items.find((p) => p.definition.kind === "hb" && p.definition.variables[0] === "MD")!);
  const hbRes = runAnalysis(hbItem.definition, F.ds);
  const cases: { def: AnalysisDefinition; res: BuilderItem["result"]; method: string; diag: RegExp }[] = [
    { def: hbItem.definition, res: hbRes, method: "hb", diag: /R̂/ },
    ...run.items.filter((it) => it.definition.kind === "sem" || it.definition.kind === "lca" || (it.definition.kind === "regression" && it.definition.options?.bootstrap) || (it.definition.kind === "reliability" && it.definition.options?.omega)).slice(0, 4)
      .map((it) => ({ def: it.definition, res: it.result, method: advancedFacts(it.definition, it.result)!.method, diag: /./ })),
  ];
  assert.deepEqual([...new Set(cases.map((c) => c.method))].sort(), ["hb", "latent_class", "mediation_bootstrap", "omega", "sem"].filter((m) => cases.some((c) => c.method === m)).sort());
  assert.ok(cases.length >= 4);
  for (const c of cases) {
    const n = advancedNarrative(c.def, c.res, { objective: "Segment phone buyers and test what drives purchase intent" })!;
    assert.ok(n.valid, `${c.method}: ${n.summary[0]}`);
    assert.ok(n.diagnostics.length && n.caveats.length, c.method);
    assert.ok(n.diagnostics.some((d) => c.diag.test(d.label)));
    const claims = claimsFromItems([builderItem({ definition: c.def, result: c.res }, "a1")], { objective: "Segment phone buyers and test what drives purchase intent" });
    for (const s of n.summary) for (const num of printedNumbers(s)) assert.ok(claims.some((cl) => cl.numbers.includes(num)), `${c.method}: ${num} in “${s}” is not a number the result printed`);
    assert.match(narrativeMarkdown(n), /\*\*Diagnostics\*\*[\s\S]*\*\*Caveats\*\*/);
  }
  /* a model that is still running, or refused, is said to be — never read */
  const pending = run.items.find((it) => it.error?.code === "job_pending")!;
  const pn = advancedNarrative(pending.definition, pending.result)!;
  assert.equal(pn.valid, false); assert.match(pn.summary[0], /still running/);
});

test("the gate holds a model's interpretation of an advanced result to its claims — per-respondent numbers excluded, any script's digits read", () => {
  const sem = run.items.find((it) => it.definition.kind === "sem")!;
  const hbItem = hbSmall(items.find((p) => p.definition.kind === "hb" && p.definition.variables[0] === "MD")!);
  const hbRes = runAnalysis(hbItem.definition, F.ds);
  const bi = [builderItem(sem, "sem1"), builderItem({ definition: hbItem.definition, result: hbRes }, "hb1")];
  const brief: ReportBrief = { objective: "Segment phone buyers and test what drives purchase intent", audience: "researcher", tone: "plain", keyQuestions: [], language: "hi" };
  const text = interpretationBrief(brief, bi);
  assert.match(text, /DIAGNOSTICS: χ² \(df\), p/); assert.match(text, /Largest R̂/); assert.match(text, /LANGUAGE: write every sentence in hi/);
  const cfi = String((sem.result.tables.find((t) => t.id === "sem_fit")!.rows.find((r) => r.m === "CFI")!.v));
  const rlh = String(hbRes.tables.find((t) => t.id === "hb_fit")!.rows.find((r) => /^Root likelihood/.test(String(r.m)))!.v);
  const indiv = hbRes.tables.find((t) => t.id === "hb_individual")!.rows[0];
  const someone = Object.values(indiv).find((v) => typeof v === "number" && Math.abs(v as number) > 0.3 && !hbRes.tables.filter((t) => t.id !== "hb_individual" && t.id !== "hb_individual_sd").some((t) => t.rows.some((r) => Object.values(r).includes(v))));
  assert.ok(someone !== undefined, "an individual utility not printed elsewhere");
  const toDeva = (s: string) => s.replace(/\d/g, (d) => String.fromCodePoint(0x0966 + Number(d)));
  const g = gateInterpretation(bi, {
    implications: [
      { claims: ["C1"], text: `The model fits well (CFI ${cfi}), which may support the planned paths.` },
      { claims: ["C2"], text: `One respondent's utility is ${someone}, which suggests a niche.` },
      { claims: ["C2"], text: `मॉडल का RLH ${toDeva(rlh)} है।` },
      { claims: ["C2"], text: `मॉडल का RLH ${toDeva("0.987")} है।` },
    ],
    recommendations: [],
  }, brief);
  assert.equal(g.implications.length, 2, JSON.stringify(g.rejected));
  assert.ok(g.rejected.some((r) => r.text.includes(String(someone))), "a per-respondent number is not a claim");
  assert.ok(g.rejected.some((r) => r.text.includes(toDeva("0.987"))), "an invented number in Devanagari digits is caught");
  assert.equal(checkSentence(`RLH ${toDeva(rlh)}`, claimsFromItems(bi), ["C2"]).problem, null);
});

test("the report: an 'Advanced models' section with the engine's reading, the key table, and the gated interpretation when there is one", () => {
  const bi = run.items.filter((it) => !it.error && ["sem", "lca", "reliability"].includes(it.definition.kind)).map((it, i) => builderItem(it, `a${i}`));
  const brief: ReportBrief = { objective: "Segment phone buyers and test what drives purchase intent", audience: "researcher", tone: "formal", keyQuestions: [], hypotheses: def.research!.hypotheses.map((text, i) => ({ label: `H${i + 1}`, text })) };
  const semId = bi.find((x) => x.definition.kind === "sem")!.id;
  const draft = draftReport(brief, bi, dict, { advancedInterpretations: { [semId]: { implications: ["The paths may support the trust route."], recommendations: [] } } });
  const blocks = draft.report.blocks ?? [];
  const sec = blocks.findIndex((b) => b.type === "section" && b.title === "Advanced models — what they show");
  assert.ok(sec >= 0);
  const after = blocks.slice(sec + 1);
  assert.ok(after.some((b) => b.type === "text" && /Structural equation model/.test(b.title ?? "") && /What it may mean[\s\S]*trust route/.test(b.markdown)));
  assert.ok(after.some((b) => b.type === "table" && b.tableId === "sem_structural"));
  assert.ok(after.some((b) => b.type === "table" && b.tableId === "lca_sizes"));
  /* the path diagram, as a figure */
  const svg = semPathDiagramSvg(run.items.find((it) => it.definition.kind === "sem")!.result)!;
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  for (const name of ["PRICE_PERCEPTION", "TRUST", "PURCHASE_INTENT", "X1", "Y3"]) assert.ok(svg.includes(`>${name}<`), name);
  assert.equal((svg.match(/<ellipse/g) ?? []).length, 3);
});

test("live updating: new responses make a result stale, said with the count; a threshold re-runs only when reached; never silently", () => {
  assert.equal(advancedStaleness({ computedAt: null, newSince: 0 }).state, "never_run");
  assert.equal(advancedStaleness({ computedAt: "2026-10-20T00:00:00Z", newSince: 0, nAtRun: 300 }).state, "fresh");
  const s = advancedStaleness({ computedAt: "2026-10-20T00:00:00Z", newSince: 40, nAtRun: 300 });
  assert.equal(s.state, "stale"); assert.equal(s.autoRerun, false); assert.match(s.message, /40 new completes since this was computed on 300 — the result shown is the earlier one/);
  assert.equal(advancedStaleness({ computedAt: "x", newSince: 40, policy: { mode: "threshold", newResponses: 50 } }).autoRerun, false);
  assert.equal(advancedStaleness({ computedAt: "x", newSince: 60, policy: { mode: "threshold", newResponses: 50 } }).autoRerun, true);
  assert.equal(advancedStaleness({ computedAt: "x", newSince: 60, running: true }).state, "running");
});

test("the Word findings report carries an 'Advanced models' section: the engine's reading, the diagnostics table, the key table, the caveats", async () => {
  const { buildFindingsDocx } = await import("./export/docx.js");
  const { checkDocx, unzipEntries } = await import("./export/docxCheck.js");
  const buf = await buildFindingsDocx(def, run, { title: "Phone study" });
  const check = checkDocx(buf);
  assert.ok(check.ok, JSON.stringify(check));
  const xml = unzipEntries(buf).get("word/document.xml")!.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(xml, /Advanced models/);
  assert.match(xml, /Structural equation model: /);
  assert.match(xml, /Latent class analysis: /);
  assert.match(xml, /CFI \/ TLI/);
  assert.match(xml, /Caveat: A structural path is an association/);
  assert.match(xml, /Hierarchical Bayes \(individual-level utilities\)[^.]*: .*still running/, "the pending HB job is said to be running, not read");
});
