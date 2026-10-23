import type { SurveyDefinition, AnalysisPlan, PlannedTest, Question } from "@rescript/schema";
import { buildAnalysisFramework, conditionSummary, explainPlan, expectedSample, planSampleSize, structuredHypotheses, describeHypothesis, MIN_READ_BASE, type PlanExplanation, type PlanVariable } from "@rescript/engine";
import { ANALYTICS_ENGINE_VERSION } from "../provenance.js";
import { docKit, definitionStamp, samplingDesign, screeningRules, reorderSections, METHOD_WORDS, type DocBlock } from "./docx.js";

/**
 * THE STATISTICAL ANALYSIS PLAN (audit DOC-03) — the standalone document a
 * client or a methodologist signs off BEFORE fieldwork: what is tested and
 * why, on whom, at what significance level, with what correction, weighting
 * and missing-data rule, on what sample, in what software.
 *
 * Every line is the definition's: the analysis plan the researcher saved
 * (else the engine's, labelled as derived and not yet saved), the research
 * design, the questionnaire. A decision the plan does not record (alpha, the
 * multiple-comparison rule, weighting, missing data) is printed as a DEFAULT
 * and marked so — the document never presents an assumption as a decision.
 * The stamp carries a hash of the definition it was read from.
 */
export interface SapOptions { client?: string; author?: string; date?: string; title?: string; /** the report theme (2026-10-18): the look only */ theme?: import("../reportThemes.js").ThemeSpec | null; logo?: import("./docx.js").DocLogo | null; /** the project's section order (#18), `sap` family */ structure?: import("../reportThemes.js").StructureRequest | null }

const { h1, h2, label, body, lead, muted, bullet, divider, gridTable, cover, document, plain, themed } = docKit;

/** what each planned method is, in the words of a methods section (kept with the Word kit, shared with the research plan) */
export { METHOD_WORDS };
const CORRECTION_TEXT: Record<string, string> = {
  none: "No correction: every test is read at its own p-value.",
  bonferroni: "Bonferroni: each p-value is multiplied by the number of tests in its family, so the family-wise error rate stays at α.",
  holm: "Holm step-down: tests in a family are ordered by p-value and compared against successively less strict thresholds; controls the family-wise error rate and is never less powerful than Bonferroni.",
  bh: "Benjamini–Hochberg: controls the false-discovery rate, the expected share of significant results that are false positives, within each family.",
};
const MISSING_TEXT: Record<string, string> = {
  listwise: "Listwise deletion: an analysis uses only respondents who answered every variable it reads. The base is shown beside every result.",
  pairwise: "Pairwise: each statistic uses every respondent with data on the variables that statistic involves, so bases differ between statistics. The base is shown beside every result.",
  impute_none: "No imputation: missing answers are never filled in or replaced; each table and test is read on the respondents who answered it, with the base shown.",
};
const WEIGHT_NONE = "No weighting is specified: every completed interview counts once (unweighted). If the achieved sample departs from the population, add rim or cell weights to the plan.";

const levelWord = (l: string) => ({ nominal: "nominal", ordinal: "ordinal", interval: "interval", ratio: "ratio", multi: "multi-select", text: "open text", rank: "ranking", allocation: "allocation", choice: "choice task", date: "date" } as Record<string, string>)[l] ?? l;

/** "1 = Yes; 2 = No; …" — the coding of a question's options, capped */
function coding(q: Question | undefined, cap = 8): string {
  const o = q?.options ?? [];
  if (!o.length) return "";
  const parts = o.slice(0, cap).map((x) => `${x.code} = ${plain(x.label, 28)}`);
  return `${parts.join("; ")}${o.length > cap ? `; … (${o.length} in all)` : ""}`;
}

const findQuestion = (def: SurveyDefinition, ref: string): Question | undefined => def.questions.find((q) => q.variableName === ref || String(q.code) === ref || q.id === ref);

export function buildSapDocx(def: SurveyDefinition, opts: SapOptions = {}): Promise<Buffer> {
  return themed(opts, () => sapDocx(def, opts));
}
async function sapDocx(def: SurveyDefinition, opts: SapOptions): Promise<Buffer> {
  const r = def.research;
  const b = r?.brief;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const client = opts.client ?? b?.client;
  const title = opts.title ?? (r?.objective ? plain(r.objective, 90) : def.meta.title);
  const stamp = definitionStamp(def);
  const saved = !!r?.analysisPlan;
  const plan: AnalysisPlan = r?.analysisPlan ?? buildAnalysisFramework(def, { now: "" });
  const explained = explainPlan(def, plan);
  const byId = new Map(explained.map((x) => [x.id, x]));
  const out: DocBlock[] = [];
  out.push(...cover("Statistical analysis plan", title, [client ? `Prepared for ${client}` : "", `${date}${opts.author ? ` · ${opts.author}` : ""}`, `Survey: ${def.meta.title}${def.meta.version ? ` v${def.meta.version}` : ""}`, stamp.text]));

  if (!saved) out.push(muted("No analysis plan has been saved for this survey. The analyses in this document were derived by the engine from the questionnaire and the hypotheses; they change when the questionnaire does. Save the plan in the Analysis tab to fix it."));

  /* 1 ---- objectives and hypotheses */
  out.push(h1("1. Objectives and hypotheses"));
  if (b?.businessQuestion) out.push(label("Business question"), body(b.businessQuestion));
  out.push(label("Research objective"));
  out.push(r?.objective ? lead(r.objective) : muted("No research objective is recorded yet — record it in the research design."));
  if (r?.researchQuestions.length) { out.push(label("Research questions")); for (const q of r.researchQuestions) out.push(bullet(q)); }
  const hyps = structuredHypotheses(def);
  out.push(label("Hypotheses"));
  if (!hyps.length) out.push(muted("No hypotheses are recorded; the analyses below are exploratory."));
  else {
    out.push(gridTable(["", "Hypothesis", "Reading", "Expected effect", "Tested by"], hyps.map((h) => {
      const served = [...plan.tests.map((t) => ({ id: t.id, hy: t.hypotheses })), ...plan.crosstabs.map((x) => ({ id: x.id, hy: x.hypotheses }))].filter((x) => x.hy.includes(h.label)).map((x) => x.id);
      return [h.label, h.text, describeHypothesis(h), h.expectedEffect ?? "—", served.length ? served.join(", ") : "not yet planned"];
    }), [600, 3200, 2400, 1300, 1500]));
  }
  if (r?.kpis.length) { out.push(label("KPIs")); out.push(gridTable(["KPI", "Variable", "Measure", "Target"], r.kpis.map((k) => [k.name, k.variable ?? "", k.measure ?? "", k.target != null ? `${k.target}${k.direction ? ` (${k.direction} is better)` : ""}` : ""]), [2600, 1800, 2600, 2000])); }

  /* 2 ---- populations, bases, dataset scope */
  out.push(h1("2. Populations, bases and dataset scope"));
  out.push(label("Target population"), body(r?.population ?? "Not recorded in the research design."));
  const design = samplingDesign(def);
  out.push(label("Sampling"), body(design.length ? `Quota sample: ${(def.quotas ?? []).length} quota${(def.quotas ?? []).length === 1 ? "" : "s"} over ${design.length} cell${design.length === 1 ? "" : "s"} (see the research proposal for the cells).` : "No quotas are defined; respondents are taken as they come."));
  const screens = screeningRules(def);
  out.push(body(screens.length ? `${screens.length} screening or termination rule${screens.length === 1 ? "" : "s"} decide who is eligible; only respondents who reach the end of the survey are analysed.` : "No screening or termination logic is programmed; every completed interview is eligible."));
  out.push(label("Analysis dataset"));
  out.push(bullet("Completed interviews in the live environment. Test interviews are never included."));
  out.push(bullet("The clean dataset: interviews removed under the data-cleaning plan are excluded; flagged-for-review interviews stay until a researcher decides."));
  out.push(bullet("Each result states its base: the respondents who were asked the question (its display logic) and answered it. A result whose base is below the minimum readable base is reported as low-base, not interpreted."));
  const sized = def.questions.filter((q) => q.displayLogic && !["html", "custom_component", "media_timeline"].includes(q.type));
  if (sized.length) {
    out.push(label("Questions asked of a subset"));
    out.push(gridTable(["Code", "Question", "Asked of"], sized.slice(0, 40).map((q) => [String(q.code), plain(q.text, 70), conditionSummary(def, q.displayLogic) || "—"]), [800, 4200, 4000]));
    if (sized.length > 40) out.push(muted(`… and ${sized.length - 40} more questions with display logic.`));
  }

  /* 3 ---- variables and derived variables */
  out.push(h1("3. Variables and derived variables"));
  const vars = new Map<string, PlanVariable>();
  for (const x of explained) for (const v of x.variables) if (!vars.has(v.name)) vars.set(v.name, v);
  const derivedNames = new Set(plan.derived.map((d) => d.name));
  const qVars = [...vars.values()].filter((v) => !derivedNames.has(v.name));
  if (!qVars.length) out.push(muted("No variable is read by a planned analysis yet."));
  else out.push(gridTable(["Variable", "Question", "Role", "Level", "Coding"], qVars.map((v) => {
    const q = findQuestion(def, v.name) ?? findQuestion(def, v.code);
    return [v.name, `${v.code}${v.text ? ` — ${plain(v.text, 60)}` : ""}`, v.designRole || v.role, levelWord(v.level), coding(q)];
  }), [1500, 3000, 1300, 1000, 2200]));
  out.push(h2("Derived variables"));
  if (!plan.derived.length) out.push(muted("No derived variable is planned."));
  else out.push(gridTable(["Variable", "Kind", "Built from", "Rule", "Why"], plan.derived.map((d) => [d.name, d.kind.replace(/_/g, " "), d.from.join(", "), d.expression ?? "", d.reason ?? ""]), [1600, 1300, 2300, 2000, 1800]));
  if (plan.segments.length) { out.push(h2("Segments")); out.push(gridTable(["Segment", "Defined by", "Why"], plan.segments.map((sg) => [sg.name, sg.by.join(" × "), sg.reason ?? ""]), [2400, 3600, 3000])); }

  /* 4 ---- the planned analyses */
  out.push(h1("4. Planned analyses"));
  const methodRows = (xs: { x: string; what: string; method: string; ex?: PlanExplanation }[]) => xs.map(({ x, what, method, ex }) => [x, what, method, ex?.why ?? "", ex ? `${ex.requiredBase.minimum}` : ""]);
  const testRow = (t: PlannedTest) => {
    const ex = byId.get(t.id);
    const vs = [t.outcome ? `${t.outcome} (outcome)` : "", t.groupBy ? `by ${t.groupBy}` : "", ...t.variables.filter((v) => v !== t.outcome && v !== t.groupBy), t.moderator ? `moderator ${t.moderator}` : "", t.mediator ? `mediator ${t.mediator}` : ""].filter(Boolean).join(", ");
    return { x: `${t.id}${t.hypotheses.length ? ` · ${t.hypotheses.join(", ")}` : ""}`, what: vs, method: METHOD_WORDS[t.method] ?? t.method.replace(/_/g, " "), ex };
  };
  const hdr = ["Analysis", "Variables", "Method", "Why this method", "Min. base"];
  const w = [1500, 2500, 1900, 2400, 700];
  if (plan.tests.length) { out.push(h2("Tests")); out.push(gridTable(hdr, methodRows(plan.tests.map(testRow)), w)); }
  else out.push(muted("No test is planned."));
  if (plan.crosstabs.length) {
    out.push(h2("Crosstabulations"));
    out.push(gridTable(hdr, methodRows(plan.crosstabs.map((x) => ({ x: `${x.id}${x.hypotheses.length ? ` · ${x.hypotheses.join(", ")}` : ""}`, what: `${x.rows.join(", ")} by ${x.columns.join(", ")}`, method: `${METHOD_WORDS.crosstab}${x.measure ? `; ${x.measure.replace(/_/g, " ")}` : ""}`, ex: byId.get(x.id) }))), w));
  }
  const ranked = [...plan.tests, ...plan.crosstabs];
  const primaries = ranked.filter((x) => x.priority === 1).length;
  if (ranked.length) out.push(muted(`${plan.tests.length} test${plan.tests.length === 1 ? "" : "s"} and ${plan.crosstabs.length} crosstabulation${plan.crosstabs.length === 1 ? "" : "s"}; ${primaries} answer a hypothesis or the objective directly (priority 1), the rest profile or explore.`));

  /* 5 ---- significance, correction, weighting, missing data */
  out.push(h1("5. Statistical conventions"));
  const alpha = plan.alpha ?? 0.05;
  const correction = plan.multipleComparisons;
  const missing = plan.missingData;
  out.push(gridTable(["Decision", "Setting", "Source"], [
    ["Significance level (α)", `${alpha}, two-sided`, plan.alpha != null ? "recorded in the plan" : "default — not recorded in the plan"],
    ["Multiple comparisons", correction ? correction === "bh" ? "Benjamini–Hochberg" : correction[0].toUpperCase() + correction.slice(1) : "Holm, within each hypothesis family", correction ? "recorded in the plan" : "default — not recorded in the plan"],
    ["Weighting", plan.weighting ?? "None (unweighted)", plan.weighting ? "recorded in the plan" : "default — not recorded in the plan"],
    ["Missing data", missing ? missing.replace(/_/g, " ") : "listwise", missing ? "recorded in the plan" : "default — not recorded in the plan"],
  ], [2400, 4000, 2600]));
  out.push(h2("Significance and multiple comparisons"));
  out.push(body(`Tests are read at α = ${alpha} (two-sided). ${CORRECTION_TEXT[correction ?? "holm"]}${correction ? "" : " (default)"}`));
  out.push(body("A result is reported with its test statistic, p-value, effect size and base. Statistical significance is read together with the effect size: a significant but negligible difference is reported as such."));
  out.push(h2("Weighting"));
  out.push(body(plan.weighting ?? WEIGHT_NONE));
  out.push(h2("Missing data"));
  out.push(body(MISSING_TEXT[missing ?? "listwise"] + (missing ? "" : " (default)")));

  /* 6 ---- sample size */
  out.push(h1("6. Sample size"));
  const exp = expectedSample(def);
  const size = planSampleSize(def, plan);
  const target = plan.sampleSize?.target ?? r?.sampleSize ?? exp?.n;
  out.push(body(target ? `Target: ${target} completes.${plan.sampleSize?.rationale ? ` ${plan.sampleSize.rationale}` : exp && !plan.sampleSize ? ` Source: ${exp.detail}.` : ""}` : "No target sample is recorded in the plan or the research design."));
  out.push(body(`The plan needs at least ${size.minimum} completes${size.driver ? ` (${size.driver.title}: ${size.driver.requiredBase.note})` : ""}; no result is interpreted below ${MIN_READ_BASE} respondents.`));
  if (target && target < size.minimum) out.push(muted(`The target (${target}) is below what the plan needs (${size.minimum}); some planned analyses will be reported as low-base.`));
  if (size.items.length) out.push(gridTable(["Analysis", "Minimum base", "Rule"], size.items.slice(0, 15).map((i) => [i.title, String(i.minimum), i.note]), [3800, 1400, 3800]));

  /* 7 ---- interim, software, stamp */
  out.push(h1("7. Interim analyses and software"));
  out.push(label("Interim analyses"));
  out.push(body(plan.interimAnalyses ?? (plan.autoRun === false ? "None: the plan is run once, when fieldwork closes." : "The plan is run automatically at the first readable base (30 completes), halfway to target, at target and at the close of fieldwork. These looks inform fieldwork monitoring; they do not change the sample, the hypotheses or the plan, and there is no stopping rule. (default)")));
  out.push(label("Software"));
  out.push(body(plan.software ?? `Rescript analytics engine ${ANALYTICS_ENGINE_VERSION}; the version and a hash of each analysis are stored with every run. (default)`));
  out.push(divider());
  out.push(muted(`${stamp.text} · generated ${date}. This plan is read from the survey definition above; regenerate it after the questionnaire or the research design changes.`));
  /* the project's section order (#18): the cover first, the closing stamp last */
  const closing = out.splice(out.length - 2, 2);
  return document(`${title} — statistical analysis plan`, `Statistical analysis plan for ${def.meta.title}`, [...reorderSections(out, opts.structure, "sap"), ...closing]);
}
