import type { AnalysisMethod, MeasurementLevel, PlannedCrosstab, PlannedTest, Question, SurveyDefinition } from "@rescript/schema";
import { explainPlanItem, expectedSample, hypothesisCoverage, inferQuestionAnalysis, isNonQuestionVariable, planItemTitle, requiredBase } from "./analysisFramework.js";
import { constructFor, describeHypothesis, hypothesisConstructs, structuredHypotheses, type StructuredHypothesis } from "./hypotheses.js";
import { planItemReads } from "./planReads.js";
import { coverageReport } from "./relevance.js";
import { researchBlockers } from "./researchBlockers.js";
import { planItemSuitability, type SuitabilityIssue } from "./researchSuitability.js";
import { METHOD_CHART } from "./capabilities.js";
import { conceptWords, wordingOf } from "./nlSemantics.js";
import { questionOrder } from "./dependencies.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { stripHtmlText } from "./html.js";
import { listBlocks } from "./blocks.js";

/**
 * THE TRACEABILITY MATRIX (Research intelligence, 2026-10-17) — objective →
 * hypothesis → construct → questions → variables → analysis → visualisation →
 * interpretation → limitations, built from THE STUDY AS CONFIGURED (the
 * research design, the questions' analysis tags, the analysis plan), never
 * from what the model said it did.
 *
 * Every row says how far its hypothesis has got, in words that cannot be
 * mistaken for a finding: PLANNED (measured and an analysis planned, nothing
 * run), UNTESTED (not measured, or nothing planned reads it), DESCRIPTIVE
 * ONLY (a descriptive statement, or only descriptive analyses serve it), and
 * — only when an analysis run is handed in — TESTED: SUPPORTED / NOT
 * SUPPORTED / MIXED, or INCONCLUSIVE. The researcher's own recorded status is
 * shown beside it, never instead of it.
 *
 * The gaps are the matrix's holes: a hypothesis no question measures, one no
 * analysis reads, a construct with no question, a question serving nothing, an
 * analysis reading a variable the survey does not have, a method that does not
 * fit its variables, a KPI with no variable, a research question nothing
 * explores.
 *
 * `researchTraceability(def, run?)` is what the Studio's Review tab, the
 * validator and the Word research plan (`traceabilityTable`) read.
 */

export type TraceStatus = "planned" | "untested" | "descriptive_only" | "tested_supported" | "tested_not_supported" | "tested_mixed" | "inconclusive";
export const TRACE_STATUS_WORDS: Record<TraceStatus, string> = {
  planned: "Planned — not yet tested",
  untested: "Untested — cannot be tested as configured",
  descriptive_only: "Descriptive only — no test planned",
  tested_supported: "Tested — supported",
  tested_not_supported: "Tested — not supported",
  tested_mixed: "Tested — mixed evidence",
  inconclusive: "Tested — inconclusive",
};

export type TraceGapCode =
  | "no_objective" | "no_design" | "hypothesis_unmeasured" | "hypothesis_no_analysis" | "construct_unmeasured"
  | "question_serves_nothing" | "analysis_missing_variable" | "analysis_incompatible" | "kpi_no_variable" | "research_question_unexplored";
export type TraceSeverity = "blocking" | "warning" | "recommendation";
export interface TraceGap {
  code: TraceGapCode;
  severity: TraceSeverity;
  message: string;
  questionIds: string[];
  hypothesis?: string;
  itemId?: string;
  suggestion?: string;
}

export interface TraceQuestion { id: string; code: string; variable: string; text: string; level: MeasurementLevel; role: string; construct?: string }
export interface TraceAnalysis {
  id: string;
  kind: "crosstab" | "test";
  method: AnalysisMethod | "crosstab";
  title: string;
  /** the variable names it reads */
  variables: string[];
  /** names it reads that the survey does not have */
  missing: string[];
  /** no blocking or warning method-suitability issue */
  compatible: boolean;
  issues: SuitabilityIssue[];
  /** an inferential analysis (a test, or a crosstab with significance) rather than a description */
  inferential: boolean;
  chart: string;
}
export interface TraceRow {
  /** "H1" for a hypothesis, "RQ1" for a research question with no hypothesis */
  id: string;
  kind: "hypothesis" | "research_question";
  objective: string;
  statement: string;
  /** the hypothesis's reading: "causal · Price perception ↓ Switching" */
  reading?: string;
  constructs: { name: string; role: string; measured: boolean }[];
  questions: TraceQuestion[];
  analyses: TraceAnalysis[];
  visualisations: string[];
  status: TraceStatus;
  interpretation: string;
  /** what the researcher recorded about it — never read as a test result */
  researcherStatus?: string;
  limitations: string[];
  gaps: TraceGapCode[];
}
export interface ResearchTraceability {
  objective?: string;
  rows: TraceRow[];
  /** the variable mapping: every placed data question and what it serves */
  questions: (TraceQuestion & { serves: string[] })[];
  gaps: TraceGap[];
  /** true when an analysis run was handed in */
  executed: boolean;
  counts: Record<TraceSeverity, number>;
  summary: string;
}
/** an analysis run's hypothesis verdicts — `@rescript/analytics`' `StudyFindings` / a stored run fits as it is */
export interface TraceabilityResults {
  verdicts?: { label: string; verdict: string; reason?: string; corrected?: { verdict: string } }[];
  at?: string;
}

const NOT_DATA = new Set(["html", "custom_component", "media_timeline"]);
const FRAMING_BLOCK = /\b(?:warm[\s-]?up|intro(?:duction)?|wrap[\s-]?up|clos(?:e|ing)|thank)/i;
const FRAMING_TEXT = /\banything else\b|\bwould you like to add\b|\bto start,? tell us\b|\bto begin\b/i;
/** a guide's warm-up or wrap-up: it opens or closes the interview and serves no topic of its own */
export function isFramingQuestion(def: SurveyDefinition, q: Question): boolean {
  if (FRAMING_TEXT.test(stripHtmlText(q.text ?? ""))) return true;
  const block = listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(q.id)));
  return FRAMING_BLOCK.test(block?.title ?? "");
}
const DESCRIPTIVE = new Set<string>(["frequencies", "mean", "median", "top_box", "nps", "text_themes", "ranking_scores", "allocation_shares", "turf", "brand_funnel", "pricing", "maxdiff_scores", "conjoint_utilities", "factor", "reliability", "cluster"]);
const plain = (s: string | undefined, n = 90) => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const resolve = (def: SurveyDefinition, ref: string): Question | undefined => getQuestionByCodeOrVar(def, ref) ?? def.questions.find((q) => q.id === ref);

function traceQuestion(def: SurveyDefinition, q: Question): TraceQuestion {
  const a = inferQuestionAnalysis(def, q);
  return { id: q.id, code: String(q.code), variable: q.variableName, text: plain(q.text), level: a.measurement, role: a.role, ...(a.construct ? { construct: a.construct } : {}) };
}

function traceAnalysis(def: SurveyDefinition, item: PlannedCrosstab | PlannedTest): TraceAnalysis {
  const plan = def.research?.analysisPlan;
  const variables = planItemReads(item);
  const missing = variables.filter((v) => !resolve(def, v) && !isNonQuestionVariable(def, v, plan));
  const issues = planItemSuitability(def, item, plan);
  const method: AnalysisMethod | "crosstab" = "rows" in item ? "crosstab" : item.method;
  return {
    id: item.id, kind: "rows" in item ? "crosstab" : "test", method,
    title: planItemTitle(def, item).replace(/^./, (c) => c.toUpperCase()),
    variables, missing,
    compatible: !missing.length && !issues.some((i) => i.level !== "recommendation"),
    issues,
    inferential: method === "crosstab" || !DESCRIPTIVE.has(method),
    chart: method === "crosstab" ? METHOD_CHART.crosstab : METHOD_CHART[method],
  };
}

function statusFor(h: StructuredHypothesis, measured: boolean, analyses: TraceAnalysis[], results?: TraceabilityResults): { status: TraceStatus; text: string } {
  const v = results?.verdicts?.find((x) => x.label === h.label);
  if (v) {
    const verdict = v.corrected?.verdict ?? v.verdict;
    const status: TraceStatus = verdict === "supported" ? "tested_supported" : verdict === "not_supported" ? "tested_not_supported" : verdict === "mixed" ? "tested_mixed" : verdict === "inconclusive" ? "inconclusive" : "untested";
    return { status, text: `${TRACE_STATUS_WORDS[status]}${v.reason ? `: ${v.reason}` : ""}${results?.at ? ` (run ${results.at})` : ""}` };
  }
  const usable = analyses.filter((a) => !a.missing.length);
  if (!measured || !usable.length) return { status: "untested", text: `${TRACE_STATUS_WORDS.untested}: ${!measured ? "no question measures it" : "no analysis in the plan reads it"}.` };
  if (h.type === "descriptive" || !usable.some((a) => a.inferential)) return { status: "descriptive_only", text: `${TRACE_STATUS_WORDS.descriptive_only}: it is read from ${usable.map((a) => a.title).join("; ")}, which ${usable.length === 1 ? "describes" : "describe"} the data without a test${h.type === "descriptive" ? " (a descriptive statement)" : ""}.` };
  return { status: "planned", text: `${TRACE_STATUS_WORDS.planned}: ${usable.filter((a) => a.inferential).map((a) => a.title).join("; ")} will test it once there is data. No analysis has run, so nothing is supported or rejected yet.` };
}

/** the research questions a design records, matched to the questions and constructs that explore them by their words */
function researchQuestionMatches(def: SurveyDefinition, rq: string, data: Question[]): Question[] {
  const c = constructFor(def, rq);
  if (c) return data.filter((q) => c.questionIds.includes(q.id));
  const fams = conceptWords(rq).families;
  if (!fams.length) return [];
  return data.filter((q) => {
    const have = conceptWords(`${wordingOf(q)} ${q.analysis?.construct ?? ""} ${q.analysis?.notes ?? ""}`).families;
    const hits = fams.filter((f) => have.some((g) => [...f].some((x) => g.has(x)))).length;
    return hits >= Math.min(2, fams.length);
  });
}

/**
 * The traceability of a study from its configuration — and, when an analysis
 * run is handed in, what the run concluded for each hypothesis.
 */
export function researchTraceability(def: SurveyDefinition, results?: TraceabilityResults | null): ResearchTraceability {
  const r = def.research;
  const objective = r?.objective?.trim() || undefined;
  const order = questionOrder(def);
  const data = def.questions.filter((q) => !NOT_DATA.has(q.type) && order.includes(q.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const plan = r?.analysisPlan;
  const items: (PlannedCrosstab | PlannedTest)[] = [...(plan?.crosstabs ?? []), ...(plan?.tests ?? [])];
  const analyses = new Map(items.map((x) => [x.id, traceAnalysis(def, x)]));
  const gaps: TraceGap[] = [];
  const gap = (g: TraceGap) => { if (!gaps.some((x) => x.code === g.code && x.message === g.message)) gaps.push(g); };
  const coverage = hypothesisCoverage(def);
  const structured = structuredHypotheses(def);
  const expected = expectedSample(def);
  const hasDesign = !!r && (r.hypotheses.length > 0 || (r.constructs ?? []).length > 0 || (r.researchQuestions ?? []).length > 0 || !!objective);

  if (!hasDesign) gap({ code: "no_design", severity: "recommendation", message: "No research design is recorded (objective, research questions, hypotheses, constructs) — nothing can be traced from objective to analysis.", questionIds: [], suggestion: "Tell the copilot the objective and hypotheses (set_research), or fill in the research design." });
  else if (!objective) gap({ code: "no_objective", severity: "warning", message: "The research design has no objective — every row of the matrix starts from it.", questionIds: [], suggestion: "Record the primary objective (set_research objective)." });

  const rows: TraceRow[] = [];
  const served = new Map<string, string[]>();
  const serve = (qid: string, what: string) => served.set(qid, [...new Set([...(served.get(qid) ?? []), what])]);

  structured.forEach((h, i) => {
    const cov = coverage[i];
    const constructs = cov?.constructs.map((c) => ({ name: c.name, role: c.role, measured: c.measured })) ?? [];
    const ids = new Set<string>([...hypothesisConstructs(h).flatMap((c) => c.questionIds), ...(r?.constructs ?? []).filter((c) => constructs.some((x) => x.name === c.name)).flatMap((c) => c.questionIds), ...def.questions.filter((q) => q.analysis?.hypotheses?.includes(h.label)).map((q) => q.id)]);
    const qs = data.filter((q) => ids.has(q.id));
    for (const q of qs) serve(q.id, h.label);
    const mine = items.filter((x) => x.hypotheses.includes(h.label)).map((x) => analyses.get(x.id)!);
    // a side the statement names that resolves to no construct, with no question tagged with the hypothesis: nothing measures that side
    const tagged = def.questions.some((q) => q.analysis?.hypotheses?.includes(h.label));
    const unresolved = tagged ? [] : (["independent", "dependent"] as const).filter((k) => h[k] && !h.constructs[k] && h.type !== "descriptive").map((k) => `its ${k} side “${h[k]}”`);
    const measured = qs.length > 0 && cov?.status !== "unmeasured" && !unresolved.length;
    const { status, text } = statusFor(h, measured, mine, results ?? undefined);
    const rowGaps: TraceGapCode[] = [];
    if (!measured) {
      rowGaps.push("hypothesis_unmeasured");
      const lacking = constructs.filter((c) => !c.measured).map((c) => `“${c.name}”`);
      gap({ code: "hypothesis_unmeasured", severity: "blocking", hypothesis: h.label, message: `${h.label} has no measuring question${lacking.length ? ` — ${lacking.join(", ")} ${lacking.length === 1 ? "is" : "are"} measured by nothing` : unresolved.length ? ` for ${unresolved.join(" and ")}` : constructs.length ? "" : " — it names no construct and no question is tagged with it"}.`, questionIds: [], suggestion: `Add the question(s) that measure it and tag them with ${h.label} (set_question_analysis hypotheses).` });
    }
    if (!mine.length) {
      rowGaps.push("hypothesis_no_analysis");
      gap({ code: "hypothesis_no_analysis", severity: "warning", hypothesis: h.label, message: `${h.label} is served by no planned analysis, so it cannot be tested.`, questionIds: qs.map((q) => q.id), suggestion: `Add the test that answers it with "hypotheses":["${h.label}"] (add_analysis_test / add_crosstab).` });
    }
    for (const a of mine) {
      if (a.missing.length) rowGaps.push("analysis_missing_variable");
      if (!a.compatible && !a.missing.length) rowGaps.push("analysis_incompatible");
    }
    const limitations: string[] = [];
    for (const x of items.filter((y) => y.hypotheses.includes(h.label)).slice(0, 3)) {
      try { limitations.push(...explainPlanItem(def, x).limitations.slice(0, 2)); } catch { /* an item the explainer cannot read is reported as a gap */ }
      const rb = requiredBase(def, x);
      if (expected && rb.minimum > expected.n) limitations.push(`${planItemTitle(def, x).replace(/^./, (c) => c.toUpperCase())} needs about ${rb.minimum} completes; ${expected.note}.`);
    }
    if (!expected) limitations.push("No sample size is recorded, so the bases the tests need cannot be checked.");
    if (h.type === "causal") limitations.push("A survey shows association; a causal reading needs the design (an experiment, a monadic split) to support it.");
    rows.push({
      id: h.label, kind: "hypothesis", objective: objective ?? "", statement: h.text, reading: describeHypothesis(h),
      constructs, questions: qs.map((q) => traceQuestion(def, q)), analyses: mine,
      visualisations: [...new Set(mine.map((a) => a.chart))], status, interpretation: text,
      ...(h.status ? { researcherStatus: h.status.replace(/_/g, " ") } : {}),
      limitations: [...new Set(limitations)].slice(0, 6), gaps: [...new Set(rowGaps)],
    });
  });

  // research questions with no hypothesis — the rows of a qualitative or descriptive design
  (r?.researchQuestions ?? []).forEach((rq, i) => {
    const id = `RQ${i + 1}`;
    const qs = researchQuestionMatches(def, rq, data);
    for (const q of qs) serve(q.id, id);
    const ids = new Set(qs.map((q) => q.variableName));
    const mine = items.filter((x) => planItemReads(x).some((v) => ids.has(v) || ids.has(resolve(def, v)?.variableName ?? ""))).map((x) => analyses.get(x.id)!);
    const rowGaps: TraceGapCode[] = [];
    if (!qs.length) {
      rowGaps.push("research_question_unexplored");
      gap({ code: "research_question_unexplored", severity: "warning", message: `${id} (“${plain(rq, 80)}”) is explored by no question that the engine can link to it.`, questionIds: [], suggestion: `Record it as a construct listing the questions that explore it, or add those questions.` });
    }
    const qual = qs.length > 0 && qs.every((q) => inferQuestionAnalysis(def, q).measurement === "text");
    rows.push({
      id, kind: "research_question", objective: objective ?? "", statement: rq,
      constructs: [], questions: qs.map((q) => traceQuestion(def, q)), analyses: mine, visualisations: [...new Set(mine.map((a) => a.chart))],
      status: qs.length ? "descriptive_only" : "untested",
      interpretation: qs.length ? `${TRACE_STATUS_WORDS.descriptive_only}: ${qual ? "qualitative evidence — themes describe what was said, not how many in the population think it" : "answered by description of the questions that explore it"}.` : `${TRACE_STATUS_WORDS.untested}: no question explores it.`,
      limitations: qual ? ["Qualitative evidence is not a population estimate; themes are keyword-coded counts of mentions."] : [],
      gaps: rowGaps,
    });
  });

  // constructs nothing measures (those on no hypothesis are not covered above)
  for (const b of researchBlockers(def)) {
    if (b.code === "unmeasured_construct" && /^The \w+ construct/.test(b.message)) gap({ code: "construct_unmeasured", severity: "blocking", message: b.message, questionIds: [], ...(b.suggestion ? { suggestion: b.suggestion } : {}) });
    if (b.code === "dead_kpi") gap({ code: "kpi_no_variable", severity: "blocking", message: b.message, questionIds: [], ...(b.suggestion ? { suggestion: b.suggestion } : {}) });
  }
  // analyses: dead references and unsuitable methods
  for (const a of analyses.values()) {
    if (a.missing.length) gap({ code: "analysis_missing_variable", severity: "blocking", itemId: a.id, message: `${a.title} reads ${a.missing.join(", ")}, which ${a.missing.length === 1 ? "is" : "are"} not in the survey.`, questionIds: [], suggestion: "Point it at variables the survey has, or remove it from the plan." });
    for (const i of a.issues.filter((x) => x.level !== "recommendation")) gap({ code: "analysis_incompatible", severity: i.level, itemId: a.id, message: i.message, questionIds: i.questionIds, ...(i.suggestion ? { suggestion: i.suggestion } : {}) });
  }
  // questions that serve nothing — only meaningful once there is a design to serve
  const connected = coverageReport(def);
  if (hasDesign && (r!.hypotheses.length || (r!.constructs ?? []).length)) {
    for (const q of connected.unconnected.filter((x) => !isFramingQuestion(def, x))) gap({ code: "question_serves_nothing", severity: "warning", message: `${q.code} serves no hypothesis, construct, research question, plan item or KPI.`, questionIds: [q.id], suggestion: `Tag it (set_question_analysis), add it to a construct, or remove it if it is not needed.` });
  }
  // the variable mapping: what every data question serves
  for (const q of data) {
    for (const c of (r?.constructs ?? []).filter((c) => c.questionIds.includes(q.id))) serve(q.id, `construct “${c.name}”`);
    for (const k of (r?.kpis ?? []).filter((k) => k.variable && (k.variable === q.variableName || k.variable === String(q.code)))) serve(q.id, `KPI “${k.name}”`);
    for (const a of analyses.values()) if (a.variables.some((v) => v === q.variableName || v === String(q.code))) serve(q.id, a.id);
  }
  const questions = data.map((q) => ({ ...traceQuestion(def, q), serves: served.get(q.id) ?? [] }));
  const counts: Record<TraceSeverity, number> = { blocking: 0, warning: 0, recommendation: 0 };
  for (const g of gaps) counts[g.severity]++;
  const statusCounts = rows.filter((x) => x.kind === "hypothesis").reduce<Record<string, number>>((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {});
  const summary = !hasDesign ? "No research design to trace." : `${rows.filter((x) => x.kind === "hypothesis").length} hypothes${rows.filter((x) => x.kind === "hypothesis").length === 1 ? "is" : "es"}${Object.keys(statusCounts).length ? ` (${Object.entries(statusCounts).map(([k, n]) => `${n} ${TRACE_STATUS_WORDS[k as TraceStatus].split(" — ")[0].toLowerCase()}${k.startsWith("tested_") ? ` ${k.replace("tested_", "").replace(/_/g, " ")}` : ""}`).join(", ")})` : ""}, ${rows.filter((x) => x.kind === "research_question").length} research question${rows.filter((x) => x.kind === "research_question").length === 1 ? "" : "s"}; ${gaps.length ? `${gaps.length} gap${gaps.length === 1 ? "" : "s"} (${counts.blocking} blocking, ${counts.warning} warning${counts.warning === 1 ? "" : "s"}, ${counts.recommendation} recommendation${counts.recommendation === 1 ? "" : "s"})` : "no gaps"}${results?.verdicts?.length ? "" : "; nothing has been run"}.`;
  return { ...(objective ? { objective } : {}), rows, questions, gaps, executed: !!results?.verdicts?.length, counts, summary };
}

/** The columns of the Word plan's traceability table. */
export const TRACEABILITY_COLUMNS = ["Objective / research question", "Hypothesis", "Constructs", "Questions", "Variables", "Analysis", "Visualisation", "Interpretation", "Limitations"] as const;

/**
 * The matrix as plain rows of text, one per hypothesis or research question —
 * what a Word or spreadsheet table prints (`TRACEABILITY_COLUMNS`). Gaps are
 * listed separately (`researchTraceability(def).gaps`).
 */
export function traceabilityTable(t: ResearchTraceability): string[][] {
  return t.rows.map((row) => [
    row.kind === "hypothesis" ? row.objective || "—" : `${row.id}: ${row.statement}`,
    row.kind === "hypothesis" ? `${row.id}: ${row.statement}${row.reading ? ` (${row.reading})` : ""}` : "—",
    row.constructs.map((c) => `${c.name} (${c.role}${c.measured ? "" : ", not measured"})`).join("; ") || "—",
    row.questions.map((q) => q.code).join(", ") || "none",
    row.questions.map((q) => `${q.variable} (${q.level})`).join(", ") || "—",
    row.analyses.map((a) => `${a.title}${a.missing.length ? ` [reads missing ${a.missing.join(", ")}]` : !a.compatible ? " [method does not fit]" : ""}`).join("; ") || "none planned",
    row.visualisations.join(", ") || "—",
    row.interpretation,
    row.limitations.join(" ") || "—",
  ]);
}
