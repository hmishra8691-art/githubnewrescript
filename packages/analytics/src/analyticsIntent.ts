import type { AnalysisDefinition, AnalysisResult, ChartSpec, ChartType, DatasetSpec, ReportDefinition } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import { adviseChart, checkChartChoice } from "./questionChart.js";
import { analysisSignature, crosstabCarriesChiSquare, findExistingDuplicate, validateAnalysis, type KnownNames } from "./planCheck.js";
import { reportAnalysisIds } from "./blockRefs.js";
import { CHART_CATALOG } from "./recommend.js";
import { tokens, wordsMatch, type ReportBrief } from "./reportBuilder.js";

/**
 * INTELLIGENT MODE FOR ANALYTICS (Data Analytics audit, Phase 5).
 *
 * A researcher asks in words — "cross-tabs of satisfaction by age and gender",
 * "remove the redundant analyses", "choose the best chart for each question",
 * "a management summary", "an animated report" — and gets back a PROPOSAL:
 * a list of concrete, individually reviewable operations from a CLOSED
 * vocabulary. Nothing here runs anything. Every operation is validated against
 * the survey's real variables, the saved analyses and the computed results
 * (the same checks the Analysis tab uses), carries the reason it was proposed,
 * and is re-validated by the server when the person applies it — so a stale or
 * tampered proposal cannot do more than the vocabulary allows.
 *
 * Words are read by rules first (the same engine-first order the survey
 * Intelligent Mode uses); a model is only asked about what the rules could not
 * read, answers in the same closed vocabulary, and its operations go through
 * the same validation. Nothing the model says is a statistic: there are no
 * numbers in an operation.
 */
export type AskOp =
  | { op: "add_crosstab"; name: string; rows: string[]; columns: string[] }
  | { op: "add_test"; name: string; outcome: string; groupBy: string }
  | { op: "add_descriptive"; name: string; variables: string[] }
  | { op: "remove_analysis"; name: string; analysisId: string; keptId?: string }
  | { op: "set_chart"; name: string; reportId: string; blockId: string; analysisId: string; chart: ChartType; from?: ChartType }
  | { op: "build_report"; name: string; brief: ReportBrief; story: boolean };

export interface AskItem {
  id: string;
  op: AskOp;
  /** one line: what will happen */
  title: string;
  /** why it was proposed */
  why: string;
  /** reasons it cannot be applied as it stands — a blocked item is shown, never run */
  blocked: string[];
  /** things to know before applying it */
  warnings: string[];
  /** what applying it creates / changes, in words */
  effect: "creates an analysis" | "removes an analysis" | "changes a chart" | "creates a report";
  /** for a chart change: the other charts that suit this result, best first — the person can swap the proposed one for any of them */
  options?: { chart: ChartType; reason: string }[];
}

export interface AskProposal { request: string; items: AskItem[]; /** the parts of the request that were understood */ read: string[]; /** the parts that were not, with what to say instead */ unread: string[]; notes: string[] }

export interface AskContext {
  variables: readonly VariableMeta[];
  known: KnownNames;
  analyses: readonly { id: string; name: string; definition: AnalysisDefinition }[];
  reports: readonly { id: string; name: string; definition: ReportDefinition }[];
  /** computed results by analysis id — needed to choose charts and to judge a chart */
  results?: Readonly<Record<string, AnalysisResult | undefined>>;
  dataset: DatasetSpec;
}

let seq = 0;
const iid = () => `ask_${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
const unique = <T,>(xs: readonly T[]) => [...new Set(xs)];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ------------------------------------------------------------ variables, by the words a researcher uses */

/** the label without its question-number prefix: "Q7 — Brands considered" → "Brands considered" */
const core = (label: string) => label.replace(/^Q\d+[a-z]?\s*[—–-]\s*/i, "");
const GENERIC = new Set(["overall", "customer", "customers", "respondent", "respondents", "people", "score", "scores", "rating", "ratings", "average", "mean", "level", "levels", "answer", "answers", "question", "questions", "variable", "variables", "data", "total", "survey"]);

export interface Mention { variable: VariableMeta; score: number }
export interface Ambiguity { phrase: string; options: VariableMeta[] }

/**
 * Every variable a piece of text names. A variable is named by its code
 * ("SAT") or by the words of its label; the longest, best-matching one wins the
 * words it matches, and two variables that match the same words equally are an
 * ambiguity the person must resolve — never a coin toss.
 */
export function findVariables(text: string, variables: readonly VariableMeta[]): { found: VariableMeta[]; ambiguous: Ambiguity[] } {
  const usable = variables.filter((v) => !v.hidden && !v.name.startsWith("_") && !v.optionCode);
  const lower = text.toLowerCase();
  const words = tokens(text);
  const cand: { v: VariableMeta; score: number; used: string[] }[] = [];
  for (const v of usable) {
    const esc = v.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9_])${esc}($|[^a-z0-9_])`).test(lower)) { cand.push({ v, score: 2, used: [`#${v.name}`] }); continue; }
    const vt = tokens(core(v.label)).filter((t) => !GENERIC.has(t) || tokens(core(v.label)).length === 1);
    if (!vt.length) continue;
    const used = words.filter((w) => vt.some((t) => wordsMatch(t, w)) && !GENERIC.has(w));
    const matched = vt.filter((t) => words.some((w) => wordsMatch(t, w)));
    if (!matched.length) continue;
    const score = matched.length / vt.length;
    if (score >= 0.5) cand.push({ v, score, used });
  }
  cand.sort((a, b) => b.score - a.score || tokens(core(a.v.label)).length - tokens(core(b.v.label)).length);
  const found: VariableMeta[] = []; const ambiguous: Ambiguity[] = []; const taken = new Set<string>();
  for (let i = 0; i < cand.length; i++) {
    const c = cand[i];
    if (found.includes(c.v) || ambiguous.some((a) => a.options.includes(c.v))) continue;
    if (c.used.length && c.used.every((u) => taken.has(u))) continue;
    const rivals = cand.filter((o, j) => j !== i && o.score === c.score && o.used.length && o.used.join("|") === c.used.join("|") && !found.includes(o.v));
    if (rivals.length && c.score < 2) { ambiguous.push({ phrase: c.used.join(" "), options: [c.v, ...rivals.map((r) => r.v)] }); c.used.forEach((u) => taken.add(u)); continue; }
    found.push(c.v); c.used.forEach((u) => taken.add(u));
  }
  return { found, ambiguous };
}

const labelOf = (v: VariableMeta) => core(v.label);

/* ------------------------------------------------------------ the rules */

const CHART_WORDS: [RegExp, ChartType][] = [
  [/\bhorizontal\s+bars?\b/, "bar_horizontal"], [/\b(?:100\s*%?\s*stacked|stacked\s*100)/, "bar_stacked_100"], [/\bstacked\b/, "bar_stacked"], [/\b(?:grouped|clustered)\b/, "bar_grouped"],
  [/\bdiverging|\blikert\b/, "diverging_likert"], [/\b(?:donut|doughnut)\b/, "donut"], [/\bpie\b/, "pie"], [/\bline\b/, "line"], [/\bhistogram\b/, "histogram"], [/\bbox\s?plot\b/, "box_plot"],
  [/\bheat\s?map\b/, "heatmap"], [/\b(?:column|vertical\s+bars?|bars?)\b/, "bar_vertical"], [/\btable\b/, "table"],
];
const NOISE = /\b(please|can you|could you|i want to|i would like to|i need to|i'd like to|let's|we need to|we want to|go ahead and)\b/g;
const VERBS = "create|add|remove|delete|drop|choose|use|show|build|make|generate|run|test|pick|prepare|write|draft|do";
const CLAUSE_SPLIT = new RegExp(`\\s*(?:[.;\\n]|,?\\s+and\\s+then\\s+|,?\\s+then\\s+|,?\\s+and\\s+also\\s+|,?\\s+and\\s+(?=(?:${VERBS})\\b)|,\\s+(?=(?:${VERBS})\\b))\\s*`, "i");

/** "satisfaction, nps and age" → separate banner variables */
const joinWords = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");

function validate(op: AskOp, ctx: AskContext): { blocked: string[]; warnings: string[] } {
  const blocked: string[] = []; const warnings: string[] = [];
  const byName = new Map(ctx.variables.map((v) => [v.name, v]));
  const def = definitionFor(op, ctx.dataset, "");
  if (def) {
    for (const i of validateAnalysis(def, ctx.variables, ctx.known)) (i.severity === "error" ? blocked : warnings).push(i.message);
    const dup = findExistingDuplicate(def, ctx.analyses);
    if (dup) blocked.push(`You already have “${dup.name}”, which computes the same thing.`);
    return { blocked, warnings };
  }
  if (op.op === "remove_analysis") {
    const a = ctx.analyses.find((x) => x.id === op.analysisId);
    if (!a) { blocked.push("That analysis no longer exists."); return { blocked, warnings }; }
    const users = ctx.reports.filter((r) => reportAnalysisIds(r.definition as never).includes(a.id));
    if (users.length) blocked.push(`It is used by ${users.slice(0, 3).map((r) => `“${r.name}”`).join(", ")}${users.length > 3 ? ` and ${users.length - 3} more` : ""} — those reports would lose a chart. Remove it from them first.`);
    if (op.keptId && !ctx.analyses.some((x) => x.id === op.keptId)) blocked.push("The analysis it duplicates no longer exists, so it is not a repeat any more.");
    return { blocked, warnings };
  }
  if (op.op === "set_chart") {
    const r = ctx.reports.find((x) => x.id === op.reportId);
    const block = r?.definition.blocks?.find((b) => b.id === op.blockId);
    if (!r || !block || block.type !== "chart") { blocked.push("That chart is no longer in the report."); return { blocked, warnings }; }
    const res = ctx.results?.[op.analysisId];
    if (!res || res.error) { blocked.push("The analysis behind this chart has no computed result to check the chart against."); return { blocked, warnings }; }
    const chk = checkChartChoice(res, op.chart);
    if (!chk.valid) blocked.push(`${op.chart.replace(/_/g, " ")} cannot draw this result (it needs a different data shape).`);
    const def2 = ctx.analyses.find((a) => a.id === op.analysisId)?.definition;
    if (def2) { const adv = adviseChart(def2, res, ctx.variables); const av = adv.avoided.find((x) => x.type === op.chart); if (av) warnings.push(`${op.chart.replace(/_/g, " ")} is usually a poor fit here: ${av.why}.`); }
    return { blocked, warnings };
  }
  if (op.op === "build_report") {
    if (!ctx.analyses.length) blocked.push("There are no saved analyses to build a report from. Create the analyses first.");
    if (!op.brief.objective && !op.brief.keyQuestions.length) blocked.push("A report needs an objective or a key question.");
    void byName;
    return { blocked, warnings };
  }
  return { blocked, warnings };
}

const chartOptions = (def: AnalysisDefinition, res: AnalysisResult, ctx: AskContext, not: ChartType): { chart: ChartType; reason: string }[] =>
  adviseChart(def, res, ctx.variables).alternatives.filter((a) => a.type !== not && checkChartChoice(res, a.type).valid).slice(0, 4).map((a) => ({ chart: a.type, reason: a.reason }));

/** a requested chart that suits the result badly is allowed — it is the person's call — but said plainly */
const chartWarning = (def: AnalysisDefinition, res: AnalysisResult, ctx: AskContext, chart: ChartType): string[] => {
  const adv = adviseChart(def, res, ctx.variables);
  const av = adv.avoided.find((x) => x.type === chart);
  if (av) return [`${chart.replace(/_/g, " ")} is usually a poor fit here: ${av.why}.`];
  if (adv.scale === "multi" && /pie|donut|stacked_100/.test(chart)) return [`${chart.replace(/_/g, " ")} implies the answers add up to 100%, but people could choose several.`];
  return [];
};

function item(op: AskOp, ctx: AskContext, title: string, why: string, effect: AskItem["effect"], extraWarnings: string[] = []): AskItem {
  const v = validate(op, ctx);
  return { id: iid(), op, title, why, effect, blocked: v.blocked, warnings: [...new Set([...extraWarnings, ...v.warnings])] };
}

/** the one validation the server runs again when an item is applied */
export function validateAskOp(op: AskOp, ctx: AskContext): { blocked: string[]; warnings: string[] } { return validate(op, ctx); }

/* ------- the redundant analyses: exact repeats, and tests a cross-tab already carries */

export function redundantAnalyses(analyses: ReadonlyArray<{ id: string; name: string; definition: AnalysisDefinition }>): { id: string; name: string; keptId: string; keptName: string; reason: string }[] {
  const out: { id: string; name: string; keptId: string; keptName: string; reason: string }[] = [];
  const isPlannedDef = (d: AnalysisDefinition) => typeof d.options?.planned === "string" && !!d.options.planned;
  /* keep the researcher's own over a generated one; otherwise the earlier */
  const order = [...analyses].sort((a, b) => Number(isPlannedDef(a.definition)) - Number(isPlannedDef(b.definition)));
  const kept = new Map<string, { id: string; name: string }>();
  const gone = new Set<string>();
  for (const a of order) {
    const sig = analysisSignature(a.definition);
    const same = kept.get(sig);
    if (same) { out.push({ id: a.id, name: a.name, keptId: same.id, keptName: same.name, reason: "It computes exactly what the other one does." }); gone.add(a.id); continue; }
    kept.set(sig, a);
  }
  for (const t of analyses) {
    if (gone.has(t.id) || t.definition.kind !== "test") continue;
    const x = analyses.find((c) => !gone.has(c.id) && c.id !== t.id && crosstabCarriesChiSquare(c.definition, t.definition));
    if (x) { out.push({ id: t.id, name: t.name, keptId: x.id, keptName: x.name, reason: "The cross-tab for the same two variables already reports this chi-square test." }); gone.add(t.id); }
  }
  return out;
}

export function proposeFromText(request: string, ctx: AskContext): AskProposal {
  const text = request.trim();
  const items: AskItem[] = []; const read: string[] = []; const unread: string[] = []; const notes: string[] = [];
  const clauses = text.toLowerCase().replace(NOISE, " ").split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
  const originals = text.replace(NOISE, " ").split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
  const stems = (s: string) => s.replace(/\bcross[\s-]?tabs?(?:ulations?)?\b/g, "crosstab");

  clauses.forEach((raw, ci) => {
    const c = stems(raw);
    const orig = originals[ci] ?? raw;
    let handled = false;

    /* ---- remove redundant / duplicate analyses */
    if (/\b(remove|delete|drop|clean\s*up|get rid of|prune)\b/.test(c) && /\b(redundant|duplicate[ds]?|repeated|repeat(?:s|ed)?|same|overlapping|unnecessary)\b/.test(c)) {
      const dups = redundantAnalyses(ctx.analyses);
      if (!dups.length) notes.push("No redundant analyses were found: no two saved analyses compute the same thing, and no test repeats a cross-tab.");
      for (const d of dups) items.push(item({ op: "remove_analysis", name: d.name, analysisId: d.id, keptId: d.keptId }, ctx, `Remove “${d.name}”`, `${d.reason} Kept: “${d.keptName}”.`, "removes an analysis"));
      read.push(orig); handled = true;
    }

    /* ---- best chart for each question */
    else if (/\b(chart|graph|plot|visuali[sz]ation)s?\b/.test(c) && /\b(best|right|appropriate|suitable|proper|correct|sensible)\b/.test(c) && /\b(each|every|all|per)\b/.test(c)) {
      let any = 0;
      for (const r of ctx.reports) for (const b of r.definition.blocks ?? []) {
        if (b.type !== "chart") continue;
        const a = ctx.analyses.find((x) => x.id === b.analysisId); const res = ctx.results?.[b.analysisId];
        if (!a || !res || res.error) continue;
        const adv = adviseChart(a.definition, res, ctx.variables);
        const cur = b.chart?.type;
        const misfit = cur && adv.avoided.find((x) => x.type === cur);
        const ok = cur && (cur === adv.type || adv.alternatives.slice(0, 3).some((x) => x.type === cur)) && !misfit;
        if (ok) continue;
        any++;
        const it0: AskItem = item({ op: "set_chart", name: b.title ?? a.name, reportId: r.id, blockId: b.id, analysisId: a.id, chart: adv.type, ...(cur ? { from: cur } : {}) }, ctx,
          `In “${r.name}”, show “${b.title ?? a.name}” as ${adv.type.replace(/_/g, " ")}${cur ? ` (now ${cur.replace(/_/g, " ")})` : ""}`, `${misfit ? `${cur!.replace(/_/g, " ")} misrepresents it: ${misfit.why}. ` : cur && adv.scale === "multi" && /pie|donut|stacked_100/.test(cur) ? `${cur.replace(/_/g, " ")} implies the answers add up to 100%, but people could choose several. ` : cur ? `${cur.replace(/_/g, " ")} is not among the better fits for this question. ` : ""}${adv.reason}.`, "changes a chart");
        items.push({ ...it0, options: chartOptions(a.definition, res, ctx, adv.type) });
      }
      if (!any) notes.push(ctx.reports.some((r) => (r.definition.blocks ?? []).some((b) => b.type === "chart")) ? "Every chart in your reports already suits its question." : "No report has a chart yet, so there is nothing to change.");
      read.push(orig); handled = true;
    }

    /* ---- a specific chart for a question: "use a horizontal bar for satisfaction" */
    else if (/\b(use|make|change|switch|show|display|draw|plot)\b/.test(c) && CHART_WORDS.some(([re]) => re.test(c)) && /\b(for|of|to show|as)\b/.test(c)) {
      const chart = CHART_WORDS.find(([re]) => re.test(c))![1];
      const { found, ambiguous } = findVariables(c.replace(/\b(horizontal|vertical|stacked|grouped|clustered|donut|doughnut|pie|line|bars?|columns?|chart|graph|table|heat\s?map|histogram|box\s?plot)\b/g, " "), ctx.variables);
      const names = new Set(found.map((v) => v.name));
      const matches = ctx.analyses.filter((a) => [...(a.definition.variables ?? []), ...(a.definition.rows ?? []), ...(a.definition.columns ?? [])].some((n) => names.has(n)));
      let any = 0;
      for (const r of ctx.reports) for (const b of r.definition.blocks ?? []) {
        if (b.type !== "chart" || !matches.some((m) => m.id === b.analysisId) || b.chart?.type === chart) continue;
        any++;
        const an = ctx.analyses.find((x) => x.id === b.analysisId); const rs = ctx.results?.[b.analysisId];
        items.push(item({ op: "set_chart", name: b.title ?? "chart", reportId: r.id, blockId: b.id, analysisId: b.analysisId, chart, ...(b.chart?.type ? { from: b.chart.type } : {}) }, ctx, `In “${r.name}”, show “${b.title ?? "chart"}” as ${chart.replace(/_/g, " ")}`, `You asked for ${chart.replace(/_/g, " ")} for ${joinWords(found.map(labelOf)) || "it"}.`, "changes a chart", an && rs && !rs.error ? chartWarning(an.definition, rs, ctx, chart) : []));
      }
      for (const a of ambiguous) unread.push(`“${a.phrase}” could mean ${joinWords(a.options.map((o) => `“${labelOf(o)}” (${o.name})`))} — name one.`);
      if (!found.length && !ambiguous.length) unread.push(`${orig} — I could not tell which question the chart is for. Name a question or variable.`);
      else if (!any && found.length) notes.push(`No chart in your reports shows ${joinWords(found.map(labelOf))} as something other than ${chart.replace(/_/g, " ")} — nothing to change.`);
      read.push(orig); handled = true;
    }

    /* ---- reports */
    else if (/\b(management|executive|leadership|board)\s+(summary|report|brief|overview)\b/.test(c) || /\b(animated|animation|video|story|storytelling|story-driven)\b/.test(c) || (/\b(create|build|make|generate|write|draft|prepare)\b/.test(c) && /\b(report|deck|presentation|summary)\b/.test(c))) {
      const story = /\b(animated|animation|video|story|storytelling|story-driven)\b/.test(c);
      const exec = /\b(management|executive|leadership|board)\b/.test(c);
      if (/\bvideo\b/.test(c)) notes.push("Video files (MP4) cannot be generated here. The animated report is a self-contained HTML story that plays in any browser — it can be screen-recorded if a video is required.");
      const brief: ReportBrief = { objective: orig.replace(/^(create|build|make|generate|write|draft|prepare)\s+(me\s+)?(an?\s+|the\s+)?/i, "").trim() || (exec ? "Management summary of the survey findings" : "Survey findings"), audience: exec ? "executive" : "client", tone: exec ? "concise" : "plain", keyQuestions: [] };
      const title = exec ? "Management summary" : story ? "Animated report" : "Survey report";
      items.push(item({ op: "build_report", name: title, brief: { ...brief, title }, story }, ctx, `Build “${title}”${story ? " with an animated story" : ""}`, `${exec ? "A short, executive-audience report" : "A report"} drafted only from your saved analyses and their results; you review it before it is created.`, "creates a report"));
      read.push(orig); handled = true;
    }

    /* ---- a significance test: "test whether satisfaction differs by gender" */
    else if (/\b(significan\w*|test|differ\w*|different|difference|compare|comparison|associat\w*)\b/.test(c) && /\b(by|across|between|among|per|and)\b/.test(c) && !/\bcrosstab\b/.test(c)) {
      const m = /^(.*?)\b(?:by|across|between|among|per)\b(.*)$/.exec(c) ?? /^(.*?)\band\b(.*)$/.exec(c);
      const L = findVariables(m?.[1] ?? c, ctx.variables), R = findVariables(m?.[2] ?? "", ctx.variables);
      for (const a of [...L.ambiguous, ...R.ambiguous]) unread.push(`“${a.phrase}” could mean ${joinWords(a.options.map((o) => `“${labelOf(o)}” (${o.name})`))} — name one.`);
      if (!L.found.length || !R.found.length) { if (!L.ambiguous.length && !R.ambiguous.length) unread.push(`${orig} — a test compares one question across another; name both (for example “does satisfaction differ by gender”).`); }
      else for (const out of L.found) for (const g of R.found) {
        if (out.name === g.name) continue;
        items.push(item({ op: "add_test", name: `${labelOf(out)} across ${labelOf(g)}`, outcome: out.name, groupBy: g.name }, ctx, `Test ${labelOf(out)} across ${labelOf(g)}`, `You asked whether ${labelOf(out)} differs by ${labelOf(g)}; the test is chosen from the two questions' types when it runs.`, "creates an analysis"));
      }
      read.push(orig); handled = true;
    }

    /* ---- a cross-tab: "satisfaction by age and gender" */
    else if (/\bcrosstab\b/.test(c) || /\bby\b/.test(c)) {
      const m = /^(.*?)\b(?:by|against|across|vs\.?|versus)\b(.*)$/.exec(c);
      if (!m) { unread.push(`${orig} — a cross-tab needs two sides, for example “satisfaction by age and gender”.`); read.push(orig); handled = true; }
      else {
        const L = findVariables(m[1], ctx.variables), R = findVariables(m[2], ctx.variables);
        for (const a of [...L.ambiguous, ...R.ambiguous]) unread.push(`“${a.phrase}” could mean ${joinWords(a.options.map((o) => `“${labelOf(o)}” (${o.name})`))} — name one.`);
        if (!L.found.length || !R.found.length) { if (!L.ambiguous.length && !R.ambiguous.length) unread.push(`${orig} — I could not find a question on ${!L.found.length ? "the left" : "the right"} of “by”. Name the survey question or its code.`); }
        else {
          for (const col of R.found) {
            const rows = L.found.filter((r) => r.name !== col.name);
            if (!rows.length) continue;
            items.push(item({ op: "add_crosstab", name: `${rows.map(labelOf).join(", ")} by ${labelOf(col)}`, rows: rows.map((r) => r.name), columns: [col.name] }, ctx, `Cross-tab ${rows.map(labelOf).join(", ")} by ${labelOf(col)}`, `Rows: ${joinWords(rows.map(labelOf))}; columns: ${labelOf(col)} — with column percentages and significance letters.`, "creates an analysis"));
          }
          if (R.found.length > 1) notes.push(`“${m[2].trim()}” names ${R.found.length} banner variables, so one cross-tab was proposed for each (a single table with them side by side gets very wide).`);
        }
        read.push(orig); handled = true;
      }
    }

    /* ---- a frequency / distribution */
    else if (/\b(frequenc\w*|distribution|descriptives?|breakdown of|how many)\b/.test(c)) {
      const { found, ambiguous } = findVariables(c, ctx.variables);
      for (const a of ambiguous) unread.push(`“${a.phrase}” could mean ${joinWords(a.options.map((o) => `“${labelOf(o)}” (${o.name})`))} — name one.`);
      for (const v of found) items.push(item({ op: "add_descriptive", name: labelOf(v), variables: [v.name] }, ctx, `Add the distribution of ${labelOf(v)}`, "A frequency table and chart of the answers.", "creates an analysis"));
      if (!found.length && !ambiguous.length) unread.push(`${orig} — name the question whose answers you want to see.`);
      read.push(orig); handled = true;
    }

    if (!handled) unread.push(`${orig} — I do not know how to do that here. I can add cross-tabs, significance tests and distributions, remove redundant analyses, choose charts, and build a report, a management summary or an animated report.`);
  });

  if (!clauses.length) unread.push("Say what you want, for example: “cross-tabs of satisfaction by age and gender”.");
  /* the same operation asked for twice in one request is one item */
  const seen = new Set<string>(); const dedup: AskItem[] = [];
  for (const it of items) { const key = JSON.stringify({ ...it.op, name: undefined }); if (seen.has(key)) continue; seen.add(key); dedup.push(it); }
  return { request: text, items: dedup, read, unread: unique(unread), notes: unique(notes) };
}

/* ------------------------------------------------------------ the model's part: the same vocabulary, nothing else */

export const ASK_INSTRUCTIONS = `You turn a researcher's request about survey ANALYSIS into operations. Answer as JSON: {"ops": [ ... ]} using ONLY these operations, each with a short "why":
{"op":"add_crosstab","rows":["<variable code>"],"columns":["<variable code>"],"why":"..."}
{"op":"add_test","outcome":"<variable code>","groupBy":"<variable code>","why":"..."}
{"op":"add_descriptive","variables":["<variable code>"],"why":"..."}
{"op":"build_report","objective":"<one sentence>","audience":"executive|client|researcher","story":false,"why":"..."}
Rules: variable codes must come from the VARIABLES list exactly; never invent a variable, a number or a result; if the request cannot be expressed with these operations answer {"ops": []}. At most 8 operations.`;

export function askBrief(request: string, variables: readonly VariableMeta[]): string {
  const vs = variables.filter((v) => !v.hidden && !v.name.startsWith("_") && !v.optionCode).slice(0, 120).map((v) => `${v.name}: ${labelOf(v)}${v.categories?.length ? ` (${v.categories.length} answers)` : ""}`);
  return `REQUEST: ${request}\n\nVARIABLES:\n${vs.join("\n")}`;
}

/** The model's operations, coerced into the closed vocabulary and validated like any other; what is not in the vocabulary is dropped with the reason. */
export function itemsFromModel(raw: unknown, ctx: AskContext): { items: AskItem[]; rejected: string[] } {
  const ops = Array.isArray((raw as { ops?: unknown })?.ops) ? ((raw as { ops: unknown[] }).ops) : [];
  const items: AskItem[] = []; const rejected: string[] = [];
  const names = new Set(ctx.variables.map((v) => v.name));
  const byName = new Map(ctx.variables.map((v) => [v.name, v]));
  const vars = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  const L = (n: string) => labelOf(byName.get(n)!);
  for (const o of ops.slice(0, 8) as Record<string, unknown>[]) {
    const why = typeof o?.why === "string" ? o.why.slice(0, 300) : "Suggested by the model.";
    const bad = (x: string[]) => x.filter((n) => !names.has(n));
    if (o?.op === "add_crosstab") {
      const rows = vars(o.rows), columns = vars(o.columns); const b = bad([...rows, ...columns]);
      if (b.length || !rows.length || !columns.length) { rejected.push(`add_crosstab: ${b.length ? `${b.join(", ")} is not a variable of this survey` : "needs rows and columns"}`); continue; }
      items.push(item({ op: "add_crosstab", name: `${rows.map(L).join(", ")} by ${columns.map(L).join(", ")}`, rows, columns }, ctx, `Cross-tab ${rows.map(L).join(", ")} by ${columns.map(L).join(", ")}`, why, "creates an analysis"));
    } else if (o?.op === "add_test") {
      const outcome = String(o.outcome ?? ""), groupBy = String(o.groupBy ?? ""); const b = bad([outcome, groupBy]);
      if (b.length) { rejected.push(`add_test: ${b.join(", ")} is not a variable of this survey`); continue; }
      items.push(item({ op: "add_test", name: `${L(outcome)} across ${L(groupBy)}`, outcome, groupBy }, ctx, `Test ${L(outcome)} across ${L(groupBy)}`, why, "creates an analysis"));
    } else if (o?.op === "add_descriptive") {
      const vs = vars(o.variables); const b = bad(vs);
      if (b.length || !vs.length) { rejected.push(`add_descriptive: ${b.length ? `${b.join(", ")} is not a variable of this survey` : "needs a variable"}`); continue; }
      for (const v of vs) items.push(item({ op: "add_descriptive", name: L(v), variables: [v] }, ctx, `Add the distribution of ${L(v)}`, why, "creates an analysis"));
    } else if (o?.op === "build_report") {
      const audience = o.audience === "executive" || o.audience === "researcher" ? o.audience : "client";
      const objective = typeof o.objective === "string" ? o.objective.trim().slice(0, 500) : "";
      const story = o.story === true;
      items.push(item({ op: "build_report", name: story ? "Animated report" : "Survey report", brief: { objective, audience, tone: audience === "executive" ? "concise" : "plain", keyQuestions: [], title: story ? "Animated report" : "Survey report" }, story }, ctx, `Build a ${story ? "report with an animated story" : "report"}`, why, "creates a report"));
    } else rejected.push(`${typeof o?.op === "string" ? o.op : "an unknown operation"} is not something this can do`);
  }
  return { items, rejected };
}


/* ------------------------------------------------------------ what comes back from the browser */

const idOk = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const nm = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const codes = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 120).slice(0, 12) : []);

/**
 * An operation from a request body, rebuilt field by field. The browser sends back
 * what the server proposed; it is not trusted to be that — anything outside the
 * vocabulary, with a malformed id, or with an unknown chart type is dropped with
 * the reason, and the survivors are validated again against the live data.
 */
export function parseAskOps(raw: unknown): { ops: AskOp[]; rejected: string[] } {
  const ops: AskOp[] = []; const rejected: string[] = [];
  const list = Array.isArray(raw) ? raw.slice(0, 30) : [];
  for (const o of list as Record<string, unknown>[]) {
    const name = nm(o?.name, 160);
    switch (o?.op) {
      case "add_crosstab": { const rows = codes(o.rows), columns = codes(o.columns); if (!rows.length || !columns.length) { rejected.push("A cross-tab needs rows and columns."); break; } ops.push({ op: "add_crosstab", name: name || `${rows.join(", ")} by ${columns.join(", ")}`, rows, columns }); break; }
      case "add_test": { const outcome = nm(o.outcome, 120), groupBy = nm(o.groupBy, 120); if (!outcome || !groupBy) { rejected.push("A test needs an outcome and a grouping."); break; } ops.push({ op: "add_test", name: name || `${outcome} across ${groupBy}`, outcome, groupBy }); break; }
      case "add_descriptive": { const variables = codes(o.variables); if (!variables.length) { rejected.push("A distribution needs a variable."); break; } ops.push({ op: "add_descriptive", name: name || variables.join(", "), variables }); break; }
      case "remove_analysis": { if (!idOk(o.analysisId)) { rejected.push("An analysis to remove must be named by its id."); break; } ops.push({ op: "remove_analysis", name, analysisId: o.analysisId, ...(idOk(o.keptId) ? { keptId: o.keptId } : {}) }); break; }
      case "set_chart": {
        const chart = nm(o.chart, 40) as ChartType;
        if (!idOk(o.reportId) || !nm(o.blockId, 80) || !idOk(o.analysisId)) { rejected.push("A chart change must name its report, block and analysis."); break; }
        if (chart !== "table" && !CHART_CATALOG.some((c) => c.type === chart)) { rejected.push(`“${chart}” is not a chart type.`); break; }
        const from = nm(o.from, 40) as ChartType;
        ops.push({ op: "set_chart", name, reportId: o.reportId, blockId: nm(o.blockId, 80), analysisId: o.analysisId, chart, ...(from ? { from } : {}) }); break;
      }
      case "build_report": {
        const b = (o.brief && typeof o.brief === "object" ? o.brief : {}) as Record<string, unknown>;
        const audience = b.audience === "executive" || b.audience === "researcher" ? b.audience : "client";
        ops.push({ op: "build_report", name, story: o.story === true, brief: { objective: nm(b.objective, 1000), audience, tone: b.tone === "formal" || b.tone === "concise" ? b.tone : "plain", keyQuestions: [], ...(nm(b.title, 120) ? { title: nm(b.title, 120) } : {}) } }); break;
      }
      default: rejected.push(`${typeof o?.op === "string" ? o.op : "An item"} is not something this can do.`);
    }
  }
  return { ops, rejected };
}

/** The analysis a creating operation stands for — one place, so the proposal's validation and the saved row cannot disagree. */
export function definitionFor(op: AskOp, dataset: DatasetSpec, request: string): AnalysisDefinition | null {
  const requested = request.slice(0, 300);
  if (op.op === "add_crosstab") return { name: op.name, kind: "crosstab", dataset, variables: [...op.rows, ...op.columns], rows: op.rows, columns: op.columns, measure: "pct_col", options: { layout: "separate", significance: true, requested } } as AnalysisDefinition;
  if (op.op === "add_test") return { name: op.name, kind: "test", dataset, variables: [op.outcome, op.groupBy], options: { test: "auto", requested } } as AnalysisDefinition;
  if (op.op === "add_descriptive") return { name: op.name, kind: "descriptive", dataset, variables: op.variables, options: { requested } } as AnalysisDefinition;
  return null;
}

/* ------------------------------------------------------------ undo records */

export type UndoRecord =
  | { kind: "created_analysis"; id: string }
  | { kind: "removed_analysis"; id: string; chartIds: string[] }
  | { kind: "chart_changed"; reportId: string; blockId: string; before: ChartSpec; after: ChartSpec };

const spec = (x: unknown): ChartSpec | null => {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.type !== "string") return null;
  if (o.type !== "table" && !CHART_CATALOG.some((c) => c.type === o.type)) return null;
  return { ...(o as object), type: o.type as ChartType, options: o.options && typeof o.options === "object" ? o.options : {} } as ChartSpec;
};

/** Undo records come back from the browser: rebuilt and checked, never trusted. */
export function parseUndo(raw: unknown): UndoRecord[] {
  const out: UndoRecord[] = [];
  for (const r of (Array.isArray(raw) ? raw.slice(0, 40) : []) as Record<string, unknown>[]) {
    if (r?.kind === "created_analysis" && idOk(r.id)) out.push({ kind: "created_analysis", id: r.id });
    else if (r?.kind === "removed_analysis" && idOk(r.id)) out.push({ kind: "removed_analysis", id: r.id, chartIds: (Array.isArray(r.chartIds) ? r.chartIds : []).filter(idOk).slice(0, 50) });
    else if (r?.kind === "chart_changed" && idOk(r.reportId) && nm(r.blockId, 80)) {
      const before = spec(r.before), after = spec(r.after);
      if (before && after) out.push({ kind: "chart_changed", reportId: r.reportId, blockId: nm(r.blockId, 80), before, after });
    }
  }
  return out;
}
