import type { Question, SurveyDefinition } from "@rescript/schema";
import { expectedSample, inferQuestionAnalysis, measurementOf } from "./analysisFramework.js";
import { capabilitiesMentioned, methodologiesNamed } from "./capabilities.js";
import { questionOrder } from "./dependencies.js";
import { stripHtmlText } from "./html.js";
import { lintProbes, PROBE_TYPES } from "./probe.js";
import { planSuitability } from "./researchSuitability.js";
import { isFramingQuestion, researchTraceability, type ResearchTraceability, type TraceabilityResults, type TraceGap } from "./researchTraceability.js";
import { reviewSurvey, type ReviewFinding, type SurveyReview } from "./surveyReview.js";
import type { SurveyAction } from "./surveyActions.js";

/**
 * ONE VALIDATOR FOR A RESEARCH STUDY (Research intelligence, 2026-10-17).
 *
 * Three classes, decided by the engine:
 *
 *   blocking         the study cannot answer its question as configured, or
 *                    cannot run: a hypothesis nothing measures, an analysis
 *                    reading a variable that is not there, a test on open
 *                    text, broken logic, a question nobody can reach
 *   warning          it runs, but the evidence will be weaker or wrong: a
 *                    method that does not fit its variables, a hypothesis no
 *                    analysis reads, a question serving nothing, leading
 *                    wording, an unsupported configuration
 *   recommendation   worth doing: probes on the open ends of a guide, a
 *                    sample size so the bases can be checked, a range on a
 *                    numeric answer, a text-themes plan for a qualitative study
 *
 * It REUSES what exists — the survey review (logic, reachability, wording,
 * options, scales, duplicates, length, the analysis-plan review, quotas,
 * languages, the enforced design's blockers) is taken whole and classed —
 * and adds the research checks the review did not make: the traceability
 * gaps, the method-suitability rules, the qualitative checks (interview flow,
 * probe coverage, objective ↔ topic mapping), the quantitative ones (sample,
 * variable naming, required analysis variables, numeric ranges), the mixed
 * ones (phases, qualitative evidence kept apart from estimates), document
 * consistency (a hypothesis marked supported with no run) and configurations
 * the platform does not support (from the capability registry).
 *
 * The Studio's Review tab and the proposal card show it; nothing here writes.
 */

export type ValidationClass = "blocking" | "warning" | "recommendation";
export type ValidationArea =
  | "alignment" | "options" | "wording" | "logic" | "structure" | "validation" | "naming" | "method" | "feasibility"
  | "document" | "unsupported" | "qualitative" | "quantitative" | "mixed" | "localization" | "quota" | "ux";
export interface ValidationItem {
  class: ValidationClass;
  area: ValidationArea;
  message: string;
  questionIds: string[];
  suggestion?: string;
  fix?: SurveyAction[];
  /** review: the survey review's own finding; the rest are the research checks this module adds */
  source: "review" | "traceability" | "research";
  /** the enforced research design blocks changes that widen it (from the review) */
  blocks?: boolean;
}
export type StudyKind = "quantitative" | "qualitative" | "mixed" | "none";
export interface ResearchValidation {
  kind: StudyKind;
  items: ValidationItem[];
  counts: Record<ValidationClass, number>;
  /** no blocking item */
  ok: boolean;
  summary: string;
  traceability: ResearchTraceability;
}

const CLASS_OF: Record<ReviewFinding["severity"], ValidationClass> = { critical: "blocking", warning: "warning", suggestion: "recommendation" };
const AREA_OF: Record<ReviewFinding["category"], ValidationArea> = {
  logic: "logic", reachability: "logic", structure: "structure", wording: "wording", options: "options", scales: "options", duplicates: "wording",
  length: "feasibility", screening: "structure", sequencing: "structure", hypothesis: "alignment", analysis: "method", ux: "ux", localization: "localization", quota: "quota",
};
const ASKED_NOT = new Set(["hidden", "calculated", "embedded_data", "html", "custom_component", "media_timeline"]);
const isOpen = (q: Question) => (PROBE_TYPES as readonly string[]).includes(q.type);
const QUAL_WORDS = /\bqualitative\b|\bqual\b|\binterview guide\b|\bdiscussion guide\b|\bin[\s-]depth\b|\bexplorator\w*\b|\bethnograph\w*|\bopen[\s-]ended interviews?\b/i;
const MIXED_WORDS = /\bmixed[\s-]?methods?\b|\bphase\s*1\b[\s\S]*\bphase\s*2\b|\bqual(?:itative)?\b[\s\S]{0,40}\b(?:then|followed by|→|->)\b[\s\S]{0,20}\bquant/i;
const NAME_OK = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const plain = (s: string | undefined) => stripHtmlText(s ?? "").replace(/\s+/g, " ").trim();

/** what kind of study this is: its methodology's words first, else the share of open-ended questions it asks */
export function studyKind(def: SurveyDefinition): StudyKind {
  const m = def.research?.methodology ?? "";
  if (MIXED_WORDS.test(m)) return "mixed";
  const order = questionOrder(def);
  const asked = def.questions.filter((q) => !ASKED_NOT.has(q.type) && order.includes(q.id));
  const open = asked.filter(isOpen).filter((q) => inferQuestionAnalysis(def, q).role !== "screening");
  const closed = asked.length - open.length;
  if (QUAL_WORDS.test(m)) return closed >= 4 && open.length >= 3 && /\bquant/i.test(m) ? "mixed" : "qualitative";
  if (!asked.length) return def.research ? "quantitative" : "none";
  return open.length >= 3 && open.length / asked.length >= 0.6 ? "qualitative" : "quantitative";
}

/** is a traceability gap something the survey review already says in its own words? */
function inReview(g: TraceGap, review: SurveyReview): boolean {
  const ms = review.findings.map((f) => f.message);
  switch (g.code) {
    case "hypothesis_unmeasured": return !!g.hypothesis && ms.some((m) => m.startsWith(`${g.hypothesis} `) && /nothing in the survey tests it|cannot be tested/.test(m));
    case "hypothesis_no_analysis": return !!g.hypothesis && ms.some((m) => m.startsWith(`${g.hypothesis} is measured but no planned test`));
    case "construct_unmeasured": { const name = /“([^”]+)”/.exec(g.message)?.[1]; return !!name && ms.some((m) => m.includes(`“${name}”`) && /not measured|measured by no question/.test(m)); }
    case "analysis_missing_variable": { const names = /reads (.+?), which (?:is|are) not in the survey/.exec(g.message)?.[1]?.split(", ") ?? []; return names.length > 0 && ms.some((m) => /not in the survey/.test(m) && names.every((n) => m.includes(n))); }
    case "kpi_no_variable": return ms.includes(g.message);
    default: return false;
  }
}

/**
 * Validate a research study: the survey review classed, plus the research
 * checks. `results` is an analysis run (for the traceability's verdicts and
 * the consistency of what is claimed); `review` reuses one already computed.
 */
export function validateResearch(def: SurveyDefinition, opts: { review?: SurveyReview; results?: TraceabilityResults | null } = {}): ResearchValidation {
  const review = opts.review ?? reviewSurvey(def);
  const items: ValidationItem[] = [];
  const seen = new Set<string>();
  const add = (x: ValidationItem) => { const k = `${x.class}|${x.message}`; if (seen.has(k)) return; seen.add(k); items.push(x); };
  const r = def.research;
  const kind = studyKind(def);
  const trace = researchTraceability(def, opts.results);
  const order = questionOrder(def);
  const asked = def.questions.filter((q) => !ASKED_NOT.has(q.type) && order.includes(q.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  /* 1 — the survey review, classed */
  for (const f of review.findings) add({ class: CLASS_OF[f.severity], area: AREA_OF[f.category] ?? "structure", message: f.message, questionIds: f.questionIds, ...(f.suggestion ? { suggestion: f.suggestion } : {}), ...(f.fix ? { fix: f.fix } : {}), source: "review", ...(f.blocks ? { blocks: true } : {}) });

  /* 2 — the traceability's gaps the review does not already say */
  for (const g of trace.gaps) {
    if (inReview(g, review)) continue;
    const area: ValidationArea = g.code === "analysis_incompatible" ? "method" : g.code === "question_serves_nothing" || g.code === "research_question_unexplored" || g.code.startsWith("hypothesis") || g.code === "construct_unmeasured" || g.code === "no_objective" || g.code === "no_design" ? "alignment" : g.code === "kpi_no_variable" || g.code === "analysis_missing_variable" ? "naming" : "alignment";
    add({ class: g.severity, area, message: g.message, questionIds: g.questionIds, ...(g.suggestion ? { suggestion: g.suggestion } : {}), source: "traceability" });
  }

  /* 3 — feasibility: the expected counts no sample lets anyone check, said once */
  const counts = planSuitability(def).filter((i) => i.rule === "expected_counts");
  if (counts.length) {
    const most = Math.max(...counts.map((c) => Number(/about (\d+) completes/.exec(c.message)?.[1] ?? 0)));
    add({ class: "recommendation", area: "feasibility", message: `${counts.length} planned table${counts.length === 1 ? "" : "s"} or test${counts.length === 1 ? "" : "s"} need${counts.length === 1 ? "s" : ""} enough completes for a chi-square's expected counts (≥ 5 a cell; the largest needs about ${most}), but the study names no sample, so the bases cannot be checked.`, questionIds: [...new Set(counts.flatMap((c) => c.questionIds))], suggestion: "Record the planned sample (set_research sampleSize) or the quotas' targets.", source: "research" });
  }

  /* 4 — what the platform does not run, named in the design */
  const designText = [r?.methodology, ...(r?.analysis ?? [])].filter(Boolean).join(" ");
  for (const c of capabilitiesMentioned(designText).filter((c) => c.status !== "supported" && c.kind !== "question_type")) {
    add({ class: c.status === "not_supported" ? "warning" : "recommendation", area: "unsupported", message: `The design names ${c.name}, which is ${c.status === "not_supported" ? "not supported" : "only partly supported"} here${c.note ? `: ${c.note}` : ""}.`, questionIds: [], source: "research", suggestion: c.status === "not_supported" ? "Keep it as a specification for analysis elsewhere, or use the supported alternative." : "Plan within what runs, and say the rest in the plan's limitations." });
  }
  for (const m of methodologiesNamed(r?.methodology).filter((m) => m.status === "partial" && !capabilitiesMentioned(designText).some((c) => c.id === `methodology:${m.id}`))) {
    add({ class: "recommendation", area: "unsupported", message: `${m.name} is partly supported: ${m.note}.`, questionIds: [], source: "research" });
  }

  /* 5 — document and report consistency: nothing is claimed that has not happened */
  const ran = !!opts.results?.verdicts?.length;
  (r?.hypothesisDetails ?? []).forEach((d, i) => {
    if (!r?.hypotheses[i] || !d?.status || d.status === "proposed") return;
    if (!ran) add({ class: "warning", area: "document", message: `H${i + 1} is recorded as “${d.status.replace(/_/g, " ")}”, but no analysis run says so — a hypothesis is a finding only once its planned test has run.`, questionIds: [], suggestion: `Set it back to proposed, or run the plan (Findings tab) and read the verdict.`, source: "research" });
  });
  if ((r?.analysis ?? []).length && !r?.analysisPlan) add({ class: "recommendation", area: "document", message: `The design lists ${r!.analysis.length} anticipated analys${r!.analysis.length === 1 ? "is" : "es"} in words, but no analysis plan is recorded — the plan document and the run have nothing to execute.`, questionIds: [], suggestion: "Propose the analysis plan (propose_analysis_plan) and review it.", source: "research" });

  /* 6 — qualitative: the guide's flow, its probes, its topics */
  const open = asked.filter(isOpen).filter((q) => inferQuestionAnalysis(def, q).role !== "screening");
  if (kind === "qualitative" || kind === "mixed") {
    const unprobed = open.filter((q) => !q.probe && !isFramingQuestion(def, q));
    const topical = open.filter((q) => !isFramingQuestion(def, q));
    if (topical.length && unprobed.length) add({ class: "recommendation", area: "qualitative", message: `${unprobed.length} of ${topical.length} topic question${topical.length === 1 ? "" : "s"} ${unprobed.length === 1 ? "has" : "have"} no AI follow-up probe (${unprobed.slice(0, 6).map((q) => q.code).join(", ")}${unprobed.length > 6 ? ", …" : ""}) — an interview guide gets its depth from the follow-ups.`, questionIds: unprobed.map((q) => q.id), suggestion: "Add a probe (set_probe) with an instruction for what to ask about.", fix: unprobed.slice(0, 10).map((q) => ({ op: "set_probe", target: String(q.code), maxProbes: 2, minWords: 3, instruction: "Ask for a concrete example or the reason behind the answer." }) as SurveyAction), source: "research" });
    for (const m of lintProbes(def)) add({ class: "warning", area: "qualitative", message: m, questionIds: def.questions.filter((q) => m.startsWith(`${q.code}:`)).map((q) => q.id), source: "research" });
    if (kind === "qualitative" && open.length < 3) add({ class: "warning", area: "qualitative", message: `A qualitative guide with ${open.length} open question${open.length === 1 ? "" : "s"} — too few to explore a topic.`, questionIds: [], suggestion: "Give each research question its own short block of open questions.", source: "research" });
    const firstOpen = open[0];
    if (firstOpen && firstOpen === asked.find((q) => inferQuestionAnalysis(def, q).role !== "screening") && open.length >= 3 && r?.objective && sharesWords(plain(firstOpen.text), r.objective)) add({ class: "recommendation", area: "qualitative", message: `The guide opens on the core topic (${firstOpen.code}) — an interview starts with an easy warm-up question before the core.`, questionIds: [firstOpen.id], suggestion: "Open with a short, general warm-up question about the respondent's context.", source: "research" });
    const last = open[open.length - 1];
    if (open.length >= 3 && last && !/\banything else\b|\bwould you like to add\b|\bfinal\b|\bone thing\b|\blast\b/i.test(plain(last.text))) add({ class: "recommendation", area: "qualitative", message: "The guide has no closing question (“Is there anything else you would like to add?”).", questionIds: [], suggestion: "End with an open wrap-up question.", source: "research" });
    if (!(r?.researchQuestions ?? []).length && !(r?.constructs ?? []).length) add({ class: "warning", area: "qualitative", message: "No research questions or topics are recorded, so nothing maps the guide's questions to what the study wants to learn.", questionIds: [], suggestion: "Record the research questions (set_research researchQuestions) and a construct per topic listing its questions.", source: "research" });
    const themes = (r?.analysisPlan?.tests ?? []).some((t) => t.method === "text_themes");
    if (open.length && !themes) add({ class: "recommendation", area: "qualitative", message: "No text-themes analysis is planned on the open answers.", questionIds: open.map((q) => q.id), suggestion: "Add a text_themes analysis per open topic; themes are keyword-coded counts of mentions.", source: "research" });
    if (kind === "qualitative" && (r?.hypotheses ?? []).length) add({ class: "recommendation", area: "qualitative", message: "A qualitative study does not test hypotheses: its open answers support or refine propositions.", questionIds: [], suggestion: "Record them as research questions / propositions, or test them in a quantitative phase.", source: "research" });
  }

  /* 7 — quantitative: sample, naming, analysis variables, ranges, answer lists */
  if (kind === "quantitative" || kind === "mixed") {
    if (r && (r.analysisPlan?.tests.length || r.hypotheses.length) && !expectedSample(def) && !counts.length) add({ class: "recommendation", area: "feasibility", message: "No sample size is recorded (no quota targets, no planned sample), so the analysis plan's bases cannot be checked.", questionIds: [], suggestion: "Record it (set_research sampleSize) with its rationale.", source: "research" });
    const names = new Map<string, Question[]>();
    for (const q of asked) names.set(q.variableName.toLowerCase(), [...(names.get(q.variableName.toLowerCase()) ?? []), q]);
    for (const [, qs] of names) if (qs.length > 1) add({ class: "blocking", area: "naming", message: `${qs.map((q) => q.code).join(" and ")} share the variable name ${qs[0].variableName} — their columns collide in the data.`, questionIds: qs.map((q) => q.id), source: "research" });
    const badNames = asked.filter((q) => !NAME_OK.test(q.variableName));
    if (badNames.length) add({ class: "warning", area: "naming", message: `${badNames.map((q) => `${q.code} (${q.variableName})`).slice(0, 6).join(", ")} ${badNames.length === 1 ? "has a variable name" : "have variable names"} SPSS, SAS and Stata will rename (letters, digits and _ only, starting with a letter, at most 64).`, questionIds: badNames.map((q) => q.id), source: "research" });
    const analytic = asked.filter((q) => { const a = inferQuestionAnalysis(def, q); return (a.role === "dependent" || a.role === "independent") && !a.inferred.includes("role"); });
    const optional = analytic.filter((q) => !q.required && measurementOf(q) !== "text");
    if (optional.length) add({ class: "recommendation", area: "validation", message: `${optional.map((q) => q.code).slice(0, 8).join(", ")} ${optional.length === 1 ? "is an analysis variable" : "are analysis variables"} a respondent may skip — every skip shrinks the model's base (listwise deletion).`, questionIds: optional.map((q) => q.id), suggestion: "Make them required, or plan for the missing data.", source: "research" });
    const unbounded = asked.filter((q) => q.type === "numeric" && !(q.validation ?? []).some((v) => v.kind === "min_value" || v.kind === "max_value") && q.settings?.minValue === undefined && q.settings?.maxValue === undefined);
    if (unbounded.length) add({ class: "recommendation", area: "validation", message: `${unbounded.map((q) => q.code).slice(0, 8).join(", ")} accept${unbounded.length === 1 ? "s" : ""} any number — an impossible value goes straight into the means.`, questionIds: unbounded.map((q) => q.id), suggestion: "Add a plausible range (set_validation min_value / max_value).", source: "research" });
    const noEscape = asked.filter((q) => q.type === "single_select" && (q.options?.length ?? 0) >= 6 && measurementOf(q) === "nominal" && !q.options.some((o) => /^(?:other|none|don['’]?t know|not sure|prefer not)/i.test(plain(o.label)) || o.flags?.includes("other_specify") || o.flags?.includes("exclusive")));
    if (noEscape.length) add({ class: "recommendation", area: "options", message: `${noEscape.map((q) => q.code).slice(0, 8).join(", ")} list${noEscape.length === 1 ? "s" : ""} 6+ categories with no “Other” or “Don't know” — a respondent whose answer is missing must pick something untrue.`, questionIds: noEscape.map((q) => q.id), source: "research" });
  }

  /* 8 — mixed: qualitative evidence and quantitative estimates kept apart, the phases connected */
  if (kind === "mixed") {
    const tagged = (r?.analysisPlan?.tests ?? []).filter((t) => t.method === "text_themes" && t.hypotheses.length);
    if (tagged.length) add({ class: "warning", area: "mixed", message: `${tagged.map((t) => t.id).join(", ")} ${tagged.length === 1 ? "tags" : "tag"} a hypothesis on text themes — themes are qualitative evidence, not a test; the hypothesis's verdict must come from the quantitative phase.`, questionIds: [], suggestion: "Move the hypothesis tag to the quantitative test; keep the themes as the research question's evidence.", source: "research" });
    if (!(r?.researchQuestions ?? []).length || !(r?.hypotheses ?? []).length) add({ class: "warning", area: "mixed", message: "A mixed-methods design needs both its qualitative research questions and the hypotheses the quantitative phase tests — one side is not recorded.", questionIds: [], suggestion: "Record phase 1's research questions and phase 2's hypotheses (set_research).", source: "research" });
    if (!/\bphase\b|\bstage\b|\bthen\b|→|->/.test(r?.methodology ?? "")) add({ class: "recommendation", area: "mixed", message: "The methodology does not say how the phases connect (what the qualitative phase hands to the quantitative one).", questionIds: [], suggestion: "Write it in the methodology: “Phase 1 … → propositions → Phase 2 …”.", source: "research" });
  }

  const rank: Record<ValidationClass, number> = { blocking: 0, warning: 1, recommendation: 2 };
  items.sort((a, b) => rank[a.class] - rank[b.class] || Number(!!b.blocks) - Number(!!a.blocks));
  const c: Record<ValidationClass, number> = { blocking: 0, warning: 0, recommendation: 0 };
  for (const i of items) c[i.class]++;
  const summary = `${kind === "none" ? "No study yet" : `${kind[0].toUpperCase()}${kind.slice(1)} study`}: ${c.blocking} blocking, ${c.warning} warning${c.warning === 1 ? "" : "s"}, ${c.recommendation} recommendation${c.recommendation === 1 ? "" : "s"}.${c.blocking ? " Fix the blocking items before fieldwork." : ""}`;
  return { kind, items, counts: c, ok: c.blocking === 0, summary, traceability: trace };
}

function sharesWords(a: string, b: string): boolean {
  const w = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 4));
  const x = w(a), y = w(b);
  return [...x].some((t) => y.has(t));
}

/** the items the research checks add — what a Review tab already showing the survey review lists beside it */
export const researchOnlyItems = (v: ResearchValidation): ValidationItem[] => v.items.filter((i) => i.source !== "review");
