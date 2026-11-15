import type { AnalysisDefinition, ChartType } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import { layerName, parseBands, nonSubstantiveCodes, DEFAULT_AGE_BANDS, type LayerFilter, type LayerVariable } from "./analysisLayer.js";

/**
 * FROM ONE SENTENCE TO A FINISHED ANALYSIS (2026-11-15).
 *
 * "Calculate NPS from Q15, compare it across Gender and Age Groups, test at 95% and show a stacked bar." That is
 * five things a researcher used to set up by hand: find the question, check its scale, make an age-band variable,
 * classify respondents, configure the comparison and its test. The planner reads the whole sentence and returns ONE
 * analysis specification — the target, the groupings, the derived variables it needs (analysisLayer.ts), the filters,
 * the confidence level, the chart — plus the steps it will run, in dependency order, in plain words.
 *
 * It never guesses where the survey does not say: two candidate NPS questions, an income question with no bands, a
 * name that matches nothing — each comes back as a question to answer, with the closest matches. Nothing here
 * computes a statistic; the run does (runAnalysis), on the raw answers, every time.
 *
 * Layers (the brief's architecture), as they appear in `steps`:
 *   1 understood   what was asked          2 variables   which survey variables, and their types
 *   3 plan         derived variables, method, test     4 transform   how the derived variables are populated
 *   5 compute      what is calculated      6 chart       the visual and why
 *   7 checks       what is validated before a number is shown            8 output   what the researcher gets
 */

export interface AnalysisSpec {
  kind: "nps" | "crosstab";
  /** NPS: the 0–10 question. Crosstab: the row variables (questions or layer variables) */
  target: string[];
  /** the groupings / banner variables (questions or layer variables) */
  by: string[];
  layer: LayerVariable[];
  filters: LayerFilter[];
  /** significance testing at this level, or null for none */
  confidence: 0.9 | 0.95 | 0.99 | null;
  measure: "pct_col" | "pct_row" | "count";
  chart?: ChartType;
  /** the steps the run takes, in order, in plain words */
  steps: string[];
  /** what was assumed, said once */
  assumptions: string[];
}

export interface PlannerResult {
  /** whether the planner took the request (the rest of Intelligent Mode does not also read it) */
  handled: boolean;
  spec?: AnalysisSpec;
  name?: string;
  /** questions to answer before anything can be planned */
  clarify: string[];
  notes: string[];
}

export interface PlannerContext {
  variables: readonly VariableMeta[];
  /** the analysis that is open, for "these results", "now by region", "add significance testing" */
  focus?: { id: string; name: string; definition: AnalysisDefinition };
  findVariables: (text: string, variables: readonly VariableMeta[]) => { found: VariableMeta[]; ambiguous: { phrase: string; options: VariableMeta[] }[] };
  chartWords: readonly [RegExp, ChartType][];
}

/* ------------------------------------------------------------ reading the sentence */

const METRIC = /\b(nps|net\s+promoter(?:\s+score)?|promoters?|detractors?|csat|customer\s+satisfaction\s+score|ces|customer\s+effort|top\s*-?\s*(?:2|two|3|three)\s*(?:-?\s*box)?|t[23]b|bottom\s*-?\s*(?:2|two)\s*(?:-?\s*box)?|b2b|mean\s+scores?|average\s+scores?)\b/;
const DERIVED = /\b(derived|hidden)\s+variables?|\brecode\w*|\b(?:age|income)\s+(?:groups?|bands?|brackets?|ranges?)\b/;
const CONFIDENCE = /\b(9[059](?:\.\d)?)\s*%?\s*(?:confidence|level|significance|sig)|\b(?:confidence|significance)\s+(?:level\s+)?(?:of\s+)?(9[059])\s*%?|\bp\s*[<≤]\s*0?\.(05|1|01)\b|\b(5|10|1)\s*%\s+(?:significance\s+)?level\b|\bat\s+(?:the\s+)?(9[059])\s*%/;
const FILTER = /\bexclud\w*\b|\bonly\s+(?:respondents|those|people|customers|the\s+ones)\b|\bamong\s+(?:respondents|those|people)\b|\bwho\s+(?:are|were)\s+aware\b|\bdon'?t\s+know\b/;
const FOLLOW_UP = /^\s*(?:now|also|next|then)\b|\b(?:these|those)\s+results\b|\bthis\s+(?:analysis|table|chart|result)\b|^\s*add\s+(?:significance|sig\s+test|testing)|^\s*(?:change|switch|convert|turn)\s+(?:this|it)\b|^\s*(?:exclude|show\s+only|only\s+show)\b/i;
const SIG = /\bsignifican\w*|\bsig\s*test\w*|\bconfidence\b|\bstatistically\b/;

const confidenceOf = (t: string): AnalysisSpec["confidence"] => {
  const m = CONFIDENCE.exec(t);
  if (m) {
    if (m[1] || m[2]) { const v = Number(m[1] ?? m[2]); return v >= 99 ? 0.99 : v >= 95 ? 0.95 : 0.9; }
    if (m[3]) return m[3] === "01" ? 0.99 : m[3] === "1" ? 0.9 : 0.95;
    if (m[4]) return m[4] === "1" ? 0.99 : m[4] === "10" ? 0.9 : 0.95;
    if (m[5]) { const v = Number(m[5]); return v >= 99 ? 0.99 : v >= 95 ? 0.95 : 0.9; }
  }
  return SIG.test(t) ? 0.95 : null;
};

const codeRe = /\b([A-Za-z]{1,3}\d+[a-z]?(?:_\d+)?)\b/g;
const headOf = (v: VariableMeta) => !v.optionCode && v.rowCode == null;

/** a phrase → the variable it names: an exact question code / variable name first, then the label's words */
function resolve(phrase: string, ctx: PlannerContext, prefer?: (v: VariableMeta) => boolean): { v?: VariableMeta; options?: VariableMeta[] } {
  const usable = ctx.variables.filter((v) => !v.name.startsWith("_") && headOf(v));
  for (const m of phrase.matchAll(codeRe)) {
    const tok = m[1].toLowerCase();
    const hit = usable.find((v) => v.name.toLowerCase() === tok) ?? usable.find((v) => (v.questionCode ?? "").toLowerCase() === tok);
    if (hit) return { v: hit };
  }
  const cleaned = phrase.replace(/\b(groups?|bands?|brackets?|ranges?|segments?|categories|levels?|the|respondents?|by|across|and)\b/gi, " ");
  const { found, ambiguous } = ctx.findVariables(cleaned, usable);
  if (ambiguous.length) {
    const opts = ambiguous[0].options;
    const pref = prefer ? opts.filter(prefer) : [];
    if (pref.length === 1) return { v: pref[0] };
    return { options: opts };
  }
  if (found.length) { const pref = prefer ? found.filter(prefer) : []; return { v: pref[0] ?? found[0] }; }
  return {};
}

const isNumeric = (v?: VariableMeta) => v?.role === "numeric";
const npsCapable = (v: VariableMeta) => !!v.nps || (v.role === "numeric" && /recommend|nps|likel/i.test(v.label)) || (!!v.categories && v.categories.length >= 11 && v.categories.some((c) => c.code === "0") && v.categories.some((c) => c.code === "10"));
const lbl = (v: VariableMeta) => v.label.replace(/^[A-Za-z]{1,3}\d+[a-z]?\s*[—–-]\s*/, "");
const said = (v: VariableMeta) => `${v.questionCode && v.questionCode !== v.name ? `${v.questionCode} ` : ""}${lbl(v)} (${v.name})`;
const scaleOf = (v: VariableMeta) => (v.categories ?? []).filter((c) => Number.isFinite(Number(c.code))).map((c) => Number(c.code)).sort((a, b) => a - b);

/** the groupings: the phrases after "across / by / between / vs", up to where the sentence moves on */
function bannerPhrases(t: string): string[] {
  const m = /\b(?:across|by|between|among(?:st)?|versus|vs\.?|for\s+each|split\s+by|broken\s+down\s+by|per)\s+(.+)$/i.exec(t);
  if (!m) return [];
  let rest = m[1];
  const stop = /\s*(?:[.;:]|\b(?:exclud\w*|only|among\s+(?:respondents|those|people|customers)|who\s+(?:are|were)|perform\w*|with|show\w*|display\w*|generat\w*|creat\w*|calculat\w*|apply\w*|highlight\w*|using|at\s+(?:the\s+)?\d+|includ\w*|then|compar\w*|test\w*|and\s+(?:show|display|generate|create|calculate|perform|apply|highlight|test|compare|add|make|build|give|plot|chart))\b|\b\d{2}\s*%)/i;
  const s = stop.exec(rest);
  if (s) rest = rest.slice(0, s.index);
  const parts = rest.split(/\s*,\s*|\s+and\s+|\s*&\s*|\s*\/\s*/).map((x) => x.trim()).filter((x) => x && !/^(the|each|every|all)$/i.test(x));
  /* "age groups under 30, 30-49, 50+": the bands belong to the phrase before them, not new groupings */
  const out: string[] = [];
  for (const x of parts) {
    if (out.length && /^(?:(?:under|below|less\s+than|over|above)\s*)?\d+(?:\s*(?:-|–|to)\s*\d+|\s*\+|\s*(?:and|or)\s+(?:over|above|older|more))?$/i.test(x)) out[out.length - 1] += `, ${x}`;
    else out.push(x);
  }
  return out;
}

/** the sentence without its filter clauses, so "among those aware of Alpha" is not read as a grouping */
const FILTER_CLAUSE = /,?\s*\b(?:(?:only|among)\s+(?:respondents|those|people|customers)?\s*(?:who\s+(?:are|were|is)\s+)?aware\s+of\s+[A-Za-z0-9 &'-]+?(?=[,.;]|\s+(?:and|then|with|at|perform|show|by|across)\b|$)|exclud\w*\s+(?:the\s+)?(?:don'?t\s+know|dk|not\s+sure|prefer\s+not(?:\s+to\s+say)?)(?:\s+answers?)?)/gi;
const withoutFilters = (t: string) => t.replace(FILTER_CLAUSE, " ").replace(/\s+/g, " ").trim();

/** the target phrase: what is being measured — before "across / by", after "of / from / using / for" */
function targetPhrase(t: string): string {
  const before = t.split(/\b(?:across|by|between|among(?:st)?|versus|vs\.?|split\s+by|broken\s+down\s+by|per)\b/i)[0] ?? t;
  const m = /\b(?:of|from|using|for|on)\s+(.+)$/i.exec(before);
  return (m ? m[1] : before).replace(METRIC, " ").replace(/\b(calculate|compute|show|give|create|make|build|get|run|do|a|an|the|crosstab\w*|cross[\s-]?tab\w*|tabulation|table|compare|comparing|analy[sz]\w*)\b/gi, " ").trim();
}

/** the filters a sentence asks for: "exclude don't know" on the target, "only those aware of Alpha" as a derived flag */
function filtersFor(t: string, target: VariableMeta | undefined, ctx: PlannerContext): { filters: LayerFilter[]; layer: LayerVariable[]; clarify: string[]; notes: string[] } {
  const filters: LayerFilter[] = []; const layer: LayerVariable[] = []; const clarify: string[] = []; const notes: string[] = [];
  if (/\bexclud\w*\b[^.]*\b(don'?t\s+know|dk|not\s+sure|prefer\s+not)\b/i.test(t) && target) {
    const dk = nonSubstantiveCodes(target.categories ?? []);
    if (dk.length) filters.push({ variable: target.name, drop: dk, label: `excluding ${(target.categories ?? []).filter((c) => dk.includes(c.code)).map((c) => c.label).join(" / ")} at ${target.questionCode ?? target.name}` });
    else notes.push(`${said(target)} has no “Don't know”-type answer to exclude.`);
  }
  const aware = /\b(?:only|among)\s+(?:respondents|those|people|customers)?\s*(?:who\s+(?:are|were|is)\s+)?aware\s+of\s+([A-Za-z0-9 &'-]+?)(?=[,.;]|\s+(?:and|then|with|at|perform|show)\b|$)/i.exec(t);
  if (aware) {
    const brand = aware[1].trim();
    const awareVar = ctx.variables.find((v) => headOf(v) && /aware/i.test(v.label) && (v.categories ?? []).some((c) => c.label.toLowerCase() === brand.toLowerCase()));
    if (!awareVar) clarify.push(`I could not find an awareness question with “${brand}” as an answer.`);
    else {
      const code = awareVar.categories!.find((c) => c.label.toLowerCase() === brand.toLowerCase())!.code;
      const fl: LayerVariable = { label: `Aware of ${brand}`, kind: "flag", from: [awareVar.name], codes: [code] };
      layer.push(fl); filters.push({ variable: layerName(fl), keep: ["1"], label: `respondents aware of ${brand} (${awareVar.questionCode ?? awareVar.name})` });
    }
  }
  return { filters, layer, clarify, notes };
}

/* ------------------------------------------------------------ the planner */

export function planRequest(text: string, ctx: PlannerContext): PlannerResult {
  const t = text.trim();
  const low = t.toLowerCase();
  const follow = !!ctx.focus && FOLLOW_UP.test(t);
  const metricHit = METRIC.exec(low)?.[1] ?? null;
  /* a mean on its own, and the one-table / item-table presets, are Intelligent Mode's existing readings — left to them */
  const metricTrigger = !!metricHit && !/^(mean|average)/.test(metricHit);
  const derivedOrMore = DERIVED.test(low) || CONFIDENCE.test(low) || FILTER.test(low);
  if (!follow && !derivedOrMore && /\bin\s+one\s+table\b|\bitem\s+table\b|\bone\s+table\s+(?:per|for)\b/.test(low)) return { handled: false, clarify: [], notes: [] };
  const wants = metricTrigger || derivedOrMore || follow;
  if (!wants) return { handled: false, clarify: [], notes: [] };
  if (follow) return planFollowUp(t, ctx);

  const clarify: string[] = []; const notes: string[] = []; const assumptions: string[] = [];
  const layer: LayerVariable[] = []; const filters: LayerFilter[] = [];
  const metric: "nps" | "csat" | "ces" | "t2b" | "b2b" | "mean" | null =
    !metricHit ? null : /nps|promoter|detractor/.test(metricHit) ? "nps" : /^ces|effort/.test(metricHit) ? "ces" : /csat|satisfaction score/.test(metricHit) ? "csat" : /bottom|b2b/.test(metricHit) ? "b2b" : /top|t[23]b/.test(metricHit) ? "t2b" : "mean";

  /* ---- layer 2: the target */
  let target: VariableMeta | undefined;
  const tp = targetPhrase(withoutFilters(t));
  const r = tp ? resolve(tp, ctx, metric === "nps" ? npsCapable : undefined) : {};
  if (r.v) target = r.v;
  else if (r.options) clarify.push(`“${tp}” could be ${r.options.slice(0, 5).map(said).join(", ")} — which one?`);
  if (!target && !r.options && metric === "nps") {
    const cands = ctx.variables.filter((v) => headOf(v) && !v.name.startsWith("_") && npsCapable(v));
    if (cands.length === 1) { target = cands[0]; assumptions.push(`${said(target)} is the survey's only 0–10 recommendation question, so it was used.`); }
    else if (cands.length > 1) clarify.push(`Which question is the NPS question? ${cands.slice(0, 6).map(said).join(", ")} could all be.`);
    else clarify.push("This survey has no 0–10 recommendation question to calculate NPS from. Name the question to use.");
  }
  if (!target && !clarify.length) clarify.push(`I could not tell which question to analyse${tp ? ` from “${tp}”` : ""}. Name it by its code (for example Q15) or its wording.`);

  /* ---- layer 2: the groupings, and the derived variables they need */
  const by: string[] = []; const byWords: string[] = [];
  for (const phrase of bannerPhrases(withoutFilters(t))) {
    const rv = resolve(phrase, ctx);
    if (rv.options) { clarify.push(`“${phrase}” could be ${rv.options.slice(0, 5).map(said).join(", ")} — which one?`); continue; }
    if (!rv.v) { clarify.push(`“${phrase}” matches no question in this survey. Name it by its code or wording.`); continue; }
    const v = rv.v;
    if (target && v.name === target.name) continue;
    if (isNumeric(v)) {
      const bands = parseBands(phrase) ?? parseBands(t.slice(t.toLowerCase().indexOf(phrase.toLowerCase())));
      const isAge = /\bage\b/i.test(phrase) || /\bage\b/i.test(v.label);
      if (!bands && !isAge) { clarify.push(`${said(v)} is a number. Say the groups to put it in (for example “${lbl(v)} under 30, 30–60, 60+”).`); continue; }
      const bins = bands ?? DEFAULT_AGE_BANDS;
      if (!bands) assumptions.push(`Age was grouped into the standard bands ${DEFAULT_AGE_BANDS.map((b) => b.label).join(", ")} — say other bands to change them.`);
      const lv: LayerVariable = { label: `${lbl(v)} group`, kind: "group_numeric", from: [v.name], bins };
      layer.push(lv); by.push(layerName(lv)); byWords.push(`${lbl(v)} group (derived from ${said(v)}: ${bins.map((b) => b.label).join(" / ")})`);
    } else { by.push(v.name); byWords.push(`${said(v)}${v.role === "multi" ? " — multi-choice" : ""}`); }
  }

  /* ---- filters */
  { const fx = filtersFor(t, target, ctx); filters.push(...fx.filters); layer.push(...fx.layer); clarify.push(...fx.clarify); notes.push(...fx.notes); }
  if (/\bweight\w*\b/i.test(t)) notes.push("Weighting: the analysis uses the survey's weighting when one is set up in Weighting; this request does not create weights.");

  if (clarify.length || !target) return { handled: true, clarify, notes };

  /* ---- layer 3: the method */
  const confidence = confidenceOf(low);
  const chart = ctx.chartWords.find(([re]) => re.test(low))?.[1];
  const steps: string[] = [];
  let spec: AnalysisSpec;
  let name: string;
  const kindWords = target.nps ? "programmed as NPS" : target.role === "multi" ? "multi-choice" : target.role === "numeric" ? "numeric" : target.categories ? `${target.categories.length}-point single choice` : target.role;
  steps.push(`1 · Understood: ${metric ? metric.toUpperCase() + " of " : ""}${said(target)}${by.length ? ` by ${byWords.map((w) => w.split(" (")[0]).join(", ")}` : ""}${confidence ? `, tested at ${Math.round(confidence * 100)}% confidence` : ""}${filters.length ? `, ${filters.map((f) => f.label).join("; ")}` : ""}.`);
  steps.push(`2 · Variables: ${said(target)} — ${kindWords}${byWords.length ? `; ${byWords.join("; ")}` : ""}.`);

  if (metric === "nps") {
    if (!npsCapable(target)) return { handled: true, clarify: [`${said(target)} does not look like a 0–10 recommendation question. Is it the NPS question? If so, its answers must run 0–10.`], notes };
    const cls: LayerVariable = { label: `${lbl(target)} — NPS group`, kind: "nps_class", from: [target.name] };
    layer.unshift(cls);
    steps.push(`3 · Plan: classify every respondent who answered as Detractor (0–6), Passive (7–8) or Promoter (9–10) in a derived variable; NPS = % Promoters − % Detractors${by.length ? ", overall and in every group" : ""}${confidence && by.length ? `; groups compared with a two-sample z-test on the NPS score at ${Math.round(confidence * 100)}%, Holm-adjusted within each grouping; groups under 30 respondents shown but not tested; multi-choice groupings not tested (a respondent can be in two groups)` : ""}.`);
    spec = { kind: "nps", target: [target.name], by, layer, filters, confidence: confidence ?? (by.length ? 0.95 : null), measure: "pct_col", chart: chart ?? (by.length ? "bar_stacked_100" : "gauge"), steps, assumptions };
    if (!confidence && by.length) assumptions.push("No confidence level was named, so groups are compared at 95%.");
    name = `NPS — ${lbl(target)}${by.length ? ` by ${byWords.map((w) => w.split(" (")[0]).join(", ")}` : ""}`;
  } else {
    const rows: string[] = [target.name];
    let measureWords = "column percentages";
    if (metric === "t2b" || metric === "b2b" || metric === "csat" || metric === "ces") {
      const dk = nonSubstantiveCodes(target.categories ?? []);
      const scale = scaleOf(target).filter((c) => !dk.includes(String(c)));
      if (scale.length < 3) return { handled: true, clarify: [`${said(target)} has no ordered scale of three or more points, so it has no ${metric === "b2b" ? "bottom" : "top"}-box score.`], notes };
      const bottom = metric === "b2b" || (metric === "ces" && /low\w*\s+is\s+(?:easy|better)/i.test(t));
      const box = bottom ? scale.slice(0, 2) : scale.slice(-2);
      const lv: LayerVariable = { label: `${lbl(target)} — ${bottom ? "bottom" : "top"} 2 box`, kind: "map_codes", from: [target.name], groups: [{ label: `${bottom ? "Bottom" : "Top"} 2 box (${box.join(", ")})`, codes: box.map(String) }, { label: "Other answers", codes: scale.filter((c) => !box.includes(c)).map(String) }] };
      layer.push(lv); rows.push(layerName(lv));
      if (dk.length && !filters.some((f) => f.variable === target!.name)) {
        filters.push({ variable: target.name, drop: dk, label: `“${(target.categories ?? []).filter((c) => dk.includes(c.code)).map((c) => c.label).join(" / ")}” excluded from the base` });
        assumptions.push(`${(target.categories ?? []).filter((c) => dk.includes(c.code)).map((c) => c.label).join(" / ")} is not on the scale, so it is left out of the base of the box score.`);
      }
      measureWords = `the share in the ${bottom ? "bottom" : "top"} 2 box (${box.join(", ")}) and the full distribution`;
      if (metric === "csat") assumptions.push(`CSAT is read as the top-2-box share of ${said(target)} (${box.join(", ")} on a ${scale[0]}–${scale[scale.length - 1]} scale).`);
    }
    if (!by.length) return { handled: true, clarify: [`Compare ${said(target)} across what? Name the groups (for example “by gender and age group”).`], notes };
    steps.push(`3 · Plan: one banner table with ${by.length} grouping${by.length === 1 ? "" : "s"} side by side; ${measureWords}${confidence ? `; column-proportion tests at ${Math.round(confidence * 100)}% (letters mark a column significantly higher, Holm-adjusted across the columns of each grouping)` : ""}${target.role === "multi" ? "; a multi-choice question is counted once per respondent per answer, so its percentages can add to more than 100%" : ""}.`);
    spec = { kind: "crosstab", target: rows, by, layer, filters, confidence, measure: /\brow\s+(?:%|percent)/i.test(t) ? "pct_row" : "pct_col", chart: chart ?? (by.length > 1 ? "bar_grouped" : "bar_grouped"), steps, assumptions };
    name = `${metric === "t2b" || metric === "csat" ? "Top 2 box — " : metric === "b2b" ? "Bottom 2 box — " : ""}${lbl(target)} by ${byWords.map((w) => w.split(" (")[0]).join(", ")}`;
  }
  if (layer.length) steps.push(`4 · Transform: ${layer.length} derived variable${layer.length === 1 ? "" : "s"} (${layer.map((l) => l.label).join("; ")}) computed from the raw answers on every run, in a separate analysis layer — the stored responses and the questionnaire are not changed.`);
  else steps.push("4 · Transform: no derived variable is needed — the survey's own variables are used as they are.");
  steps.push(`5 · Compute: ${spec.kind === "nps" ? "Promoter / Passive / Detractor shares, NPS and its interval" : "counts, percentages and bases"}${by.length ? " for every group" : ""}${spec.confidence ? `, with ${Math.round(spec.confidence * 100)}% significance tests` : ""}${filters.length ? `, after ${filters.map((f) => f.label).join(" and ")}` : ""}.`);
  steps.push(`6 · Chart: ${String(spec.chart ?? "table").replace(/_/g, " ")} — ${spec.kind === "nps" && by.length ? "each group's split into detractors, passives and promoters, side by side" : spec.kind === "nps" ? "the score on its −100 to +100 range" : "the groups side by side"}${chart ? " (as you asked)" : ""}.`);
  steps.push("7 · Checks: every derived variable reports how many respondents it was populated for and which answers fitted no rule; the counts must reconcile before a result is shown; tests are run only where the bases and the design allow, and the result says where they were not.");
  steps.push("8 · Output: the table(s) with bases, the chart, the tests that were run, and a plain-language reading — editable, and changeable in words (“now by region”, “exclude don't know”).");
  return { handled: true, spec, name, clarify: [], notes };
}

/* ------------------------------------------------------------ "now by region", "add significance testing", … */

export function specFromDefinition(def: AnalysisDefinition): AnalysisSpec | null {
  const o = (def.options ?? {}) as Record<string, unknown>;
  const layer = Array.isArray(o.layer) ? (o.layer as LayerVariable[]) : [];
  const filters = Array.isArray(o.layerFilter) ? (o.layerFilter as LayerFilter[]) : [];
  const conf = [0.9, 0.95, 0.99].includes(Number(o.confidence)) ? (Number(o.confidence) as 0.9) : o.significance ? (o.alpha ? (1 - Number(o.alpha)) as 0.95 : 0.95) : null;
  if (def.kind === "nps") return { kind: "nps", target: [...def.variables.slice(0, 1)], by: Array.isArray(o.by) ? (o.by as string[]) : typeof o.by === "string" ? [o.by] : [], layer, filters, confidence: conf, measure: "pct_col", chart: o.chartPreference as ChartType | undefined, steps: [], assumptions: [] };
  if (def.kind === "crosstab") return { kind: "crosstab", target: [...(def.rows ?? [])], by: [...(def.columns ?? [])], layer, filters, confidence: conf, measure: (def.measure === "pct_row" || def.measure === "count" ? def.measure : "pct_col"), chart: o.chartPreference as ChartType | undefined, steps: [], assumptions: [] };
  return null;
}

function planFollowUp(t: string, ctx: PlannerContext): PlannerResult {
  const f = ctx.focus!;
  const base = specFromDefinition(f.definition);
  if (!base) return { handled: true, clarify: [`“${f.name}” is a ${f.definition.kind} analysis; follow-up changes in words work on NPS and cross-tab analyses. Make the change in the Analysis tab.`], notes: [] };
  const spec: AnalysisSpec = { ...base, by: [...base.by], layer: [...base.layer], filters: [...base.filters], steps: [], assumptions: [] };
  const changes: string[] = []; const clarify: string[] = []; const notes: string[] = [];
  const low = t.toLowerCase();
  /* more groupings */
  if (/\b(?:by|across|for)\b/.test(low) && !/\bexclud/.test(low)) {
    const sub = planRequest(`analyse ${f.definition.variables[0] ?? ""} ${t.replace(/^\s*(?:now|also|next|then)\s+/i, "").replace(/\b(?:compare|show)\s+(?:these|those)\s+results\b/i, "")}`, { ...ctx, focus: undefined });
    if (sub.clarify.length) clarify.push(...sub.clarify.filter((c) => !/across what/.test(c)));
    for (const b of sub.spec?.by ?? []) if (!spec.by.includes(b)) { spec.by.push(b); const lv = sub.spec!.layer.find((l) => layerName(l) === b); if (lv) spec.layer.push(lv); changes.push(`add ${lv ? lv.label : ctx.variables.find((v) => v.name === b)?.label ?? b} as a grouping`); }
  }
  /* filters */
  if (FILTER.test(low)) {
    const target = ctx.variables.find((v) => v.name === spec.target[0]);
    const fx = filtersFor(t, target, ctx);
    notes.push(...fx.notes); clarify.push(...fx.clarify);
    for (const fl of fx.filters) if (!spec.filters.some((x) => x.label === fl.label)) { spec.filters.push(fl); changes.push(fl.label ?? "a filter"); }
    for (const lv of fx.layer) if (!spec.layer.some((x) => layerName(x) === layerName(lv))) spec.layer.push(lv);
  }
  /* significance */
  const conf = confidenceOf(low);
  if (conf && conf !== spec.confidence) { spec.confidence = conf; changes.push(`significance testing at ${Math.round(conf * 100)}%`); }
  /* chart */
  const chart = ctx.chartWords.find(([re]) => re.test(low))?.[1];
  if (chart && chart !== spec.chart) { spec.chart = chart; changes.push(`show it as ${chart.replace(/_/g, " ")}`); }
  else if (chart) notes.push(`“${f.name}” is already shown as ${chart.replace(/_/g, " ")}.`);
  if (conf && conf === base.confidence) notes.push(`“${f.name}” is already tested at ${Math.round(conf * 100)}%.`);
  if (!changes.length) return { handled: true, clarify: clarify.length ? clarify : notes.length ? notes : [`I could not tell what to change in “${f.name}”. Say it like “now by region”, “exclude don't know”, “add significance testing” or “as a 100% stacked bar”.`], notes: [] };
  spec.steps = [`Update “${f.name}”: ${changes.join("; ")}. Everything else stays as it is; the derived variables already defined are reused, not made again.`];
  return { handled: true, spec, name: f.name, clarify, notes: [...notes, `“${t.trim()}” was read as a change to “${f.name}”, the analysis you have open.`] };
}

/** the analysis a specification stands for */
export function definitionFromSpec(spec: AnalysisSpec, name: string, dataset: AnalysisDefinition["dataset"], requested: string): AnalysisDefinition {
  const common = { layer: spec.layer, layerFilter: spec.filters, requested: requested.slice(0, 300), ...(spec.chart ? { chartPreference: spec.chart } : {}), plannedSteps: spec.steps };
  if (spec.kind === "nps") {
    return { name, kind: "nps", dataset, variables: [spec.target[0]!, ...spec.by], options: { ...common, by: spec.by, ...(spec.confidence ? { confidence: spec.confidence } : {}), correction: "holm" } };
  }
  return {
    name, kind: "crosstab", dataset, variables: [...spec.target, ...spec.by], rows: spec.target, columns: spec.by, measure: spec.measure,
    options: { ...common, layout: "banner", stackRows: true, hideEmptyRows: true, significance: !!spec.confidence, ...(spec.confidence ? { alpha: Number((1 - spec.confidence).toFixed(2)) } : {}) },
  };
}

/** what a layer variable looks like to the validators before it has been computed */
export function layerMeta(v: LayerVariable): VariableMeta {
  const name = v.name ?? layerName(v);
  const base = { name, label: v.label, derived: true, hidden: true };
  switch (v.kind) {
    case "group_numeric": return { ...base, role: "categorical", categories: v.bins.map((b, i) => ({ code: String(i + 1), label: b.label })) };
    case "map_codes": return { ...base, role: "categorical", categories: v.groups.map((g, i) => ({ code: String(i + 1), label: g.label })) };
    case "nps_class": return { ...base, role: "categorical", categories: [{ code: "1", label: "Detractors" }, { code: "2", label: "Passives" }, { code: "3", label: "Promoters" }] };
    case "box": case "flag": return { ...base, role: "categorical", categories: [{ code: "1", label: "Yes" }, { code: "0", label: "No" }] };
    default: return { ...base, role: "numeric" };
  }
}

/* ------------------------------------------------------------ what comes back from the browser, rebuilt */

const str = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const names = (x: unknown, max = 40): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_.]{0,119}$/.test(v)).slice(0, max) : []);
const codeList = (x: unknown): string[] => (Array.isArray(x) ? x.map(String).filter((c) => c.length > 0 && c.length <= 40).slice(0, 200) : []);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

function parseLayerVariable(raw: unknown): LayerVariable | null {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object") return null;
  const label = str(o.label, 160) || "Derived variable";
  const from = names(o.from, 30);
  if (!from.length) return null;
  switch (o.kind) {
    case "group_numeric": {
      const bins = (Array.isArray(o.bins) ? o.bins : []).slice(0, 30).map((b) => ({ label: str((b as Record<string, unknown>)?.label, 60), min: num((b as Record<string, unknown>)?.min), max: num((b as Record<string, unknown>)?.max) })).filter((b) => b.label);
      return bins.length ? { label, kind: "group_numeric", from: [from[0]], bins: bins.map((b) => ({ label: b.label, ...(b.min != null ? { min: b.min } : {}), ...(b.max != null ? { max: b.max } : {}) })) } : null;
    }
    case "map_codes": {
      const groups = (Array.isArray(o.groups) ? o.groups : []).slice(0, 40).map((g) => ({ label: str((g as Record<string, unknown>)?.label, 80), codes: codeList((g as Record<string, unknown>)?.codes) })).filter((g) => g.label && g.codes.length);
      return groups.length ? { label, kind: "map_codes", from: [from[0]], groups } : null;
    }
    case "nps_class": return { label, kind: "nps_class", from: [from[0]] };
    case "box": return (o.side === "top" || o.side === "bottom") && [1, 2, 3].includes(Number(o.size)) ? { label, kind: "box", from: [from[0]], side: o.side, size: Number(o.size) as 1 } : null;
    case "flag": { const c = codeList(o.codes); return c.length ? { label, kind: "flag", from: [from[0]], codes: c } : null; }
    case "count": case "mean": return { label, kind: o.kind, from };
    default: return null;
  }
}

/** an analysis specification from a request body: every field rebuilt and bounded; null when it is not one */
export function parseSpec(raw: unknown, isChart: (c: string) => boolean): AnalysisSpec | null {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object" || (o.kind !== "nps" && o.kind !== "crosstab")) return null;
  const target = names(o.target, 20), by = names(o.by, 20);
  if (!target.length) return null;
  const layer = (Array.isArray(o.layer) ? o.layer : []).slice(0, 20).map(parseLayerVariable).filter((x): x is LayerVariable => !!x);
  const filters = (Array.isArray(o.filters) ? o.filters : []).slice(0, 10).map((f) => {
    const x = f as Record<string, unknown>;
    const variable = names([x?.variable], 1)[0];
    if (!variable) return null;
    const keep = codeList(x.keep), drop = codeList(x.drop);
    if (!keep.length && !drop.length) return null;
    const lf: LayerFilter = { variable };
    if (keep.length) lf.keep = keep;
    if (drop.length) lf.drop = drop;
    const lb = str(x.label, 200);
    if (lb) lf.label = lb;
    return lf;
  }).filter((x): x is LayerFilter => x !== null);
  const confidence = [0.9, 0.95, 0.99].includes(Number(o.confidence)) ? (Number(o.confidence) as 0.95) : null;
  const measure = o.measure === "pct_row" || o.measure === "count" ? o.measure : "pct_col";
  const chart = typeof o.chart === "string" && isChart(o.chart) ? (o.chart as ChartType) : undefined;
  const steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 12).map((s) => str(s, 700)).filter(Boolean);
  const assumptions = (Array.isArray(o.assumptions) ? o.assumptions : []).slice(0, 8).map((s) => str(s, 400)).filter(Boolean);
  return { kind: o.kind, target, by, layer, filters, confidence, measure, ...(chart ? { chart } : {}), steps, assumptions };
}
