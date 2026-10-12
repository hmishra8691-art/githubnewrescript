import type { AnalysisDefinition, AnalysisResult, ChartType, ReportBlock, ReportDefinition, StoryDefinition, StoryScene } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import type { Audience } from "./chartPurpose.js";
import { adviseChart, checkChartChoice, type ChartAdvice } from "./questionChart.js";
import { analysisSignature } from "./planCheck.js";
import { sentenceProblem } from "./narrative.js";
import { mentionsVariable } from "./analyses/index.js";

/**
 * THE INTELLIGENT REPORT BUILDER (Data Analytics audit, Oct 2026).
 *
 * A report is drafted from what the analytics module has ALREADY computed:
 * the saved analyses and their results. Nothing here computes a statistic and
 * nothing invents one — every sentence is an insight the analysis produced, a
 * base it printed, or a test line built from its own numbers; a sentence a
 * model offers (the optional interpretation) must pass the same number gate
 * the Research Engine uses, or it is dropped with the reason.
 *
 * The researcher states the objective, audience, tone, scope and the key
 * questions. The builder then:
 *   1. checks each analysis can be shown at all (computed, has respondents,
 *      not a repeat of another) and says why one is left out;
 *   2. ranks the rest against the key questions and the evidence in them;
 *   3. chooses each chart from the question's structure (adviseChart) and
 *      keeps the denominator beside it;
 *   4. lays out the report and, on request, the animated story — and lists
 *      the key questions no saved analysis answers, instead of papering over
 *      the gap.
 */
export type ReportTone = "plain" | "formal" | "concise";
export interface ReportBrief {
  objective: string;
  audience: Audience;
  tone: ReportTone;
  /** key questions the report must answer, in the researcher's words */
  keyQuestions: string[];
  /** restrict to these saved analyses; absent = every usable one */
  analysisIds?: string[];
  /** at most this many analyses (defaults by audience) */
  maxItems?: number;
  includeTests?: boolean;
  includeCrosstabs?: boolean;
  title?: string;
  client?: string;
}

export interface BuilderItem { id: string; name: string; definition: AnalysisDefinition; result: AnalysisResult }
export type ItemRole = "key" | "finding" | "comparison" | "difference";
export interface IncludedItem {
  id: string; name: string; role: ItemRole; chart: ChartType; chartReason: string; denominator: string; scale: string;
  /** the key questions this analysis answers */
  answers: string[]; significant: boolean; notes: string[];
}
export interface SkippedItem { id: string; name: string; reason: string }
export interface BuilderDraft {
  report: ReportDefinition;
  story?: StoryDefinition;
  included: IncludedItem[];
  skipped: SkippedItem[];
  /** key questions that no saved analysis speaks to */
  uncovered: string[];
  notes: string[];
}

const ALPHA = 0.05;
const SMALL = 30;
const DEFAULT_MAX: Record<Audience, number> = { executive: 6, client: 10, researcher: 16 };

/* ------------------------------------------------------------ small helpers */

let seq = 0;
const bid = (p: string) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const analysesOf = (n: number) => `${n} ${n === 1 ? "analysis" : "analyses"}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);

export const isSignificant = (r: AnalysisResult): boolean => r.tests.some((t) => t.p != null && t.p < ALPHA);

/** the test line of a result, built from its own numbers: "Chi-square: χ² = 12.4, p = .002, Cramér's V = 0.21" */
export function testLine(r: AnalysisResult): string | undefined {
  const t = r.tests.find((x) => x.p != null) ?? r.tests[0];
  if (!t) return undefined;
  const parts = [t.statistic != null && Number.isFinite(t.statistic) ? `statistic = ${Math.round(t.statistic * 100) / 100}` : "", fmtP(t.p), t.effectSize && t.effectSize.value != null ? `${t.effectSize.name} = ${Math.round(t.effectSize.value * 100) / 100}` : ""].filter(Boolean);
  return `${t.test}: ${parts.join(", ")}`;
}

const STOP = new Set(["what", "which", "does", "have", "with", "that", "this", "from", "about", "their", "they", "them", "your", "how", "why", "who", "when", "are", "the", "and", "for", "our", "do", "is", "of", "to", "in", "on", "by", "a", "an", "we", "us", "more", "most", "between", "among", "across", "than", "like", "would", "should", "can", "will", "any", "all", "per", "each", "over", "into", "differ", "differs", "difference", "differences", "vary", "varies"]);
export const tokens = (s: string): string[] => [...new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];

/** the words an analysis is about: its name, and the labels of the variables it reads */
function aboutWords(item: BuilderItem, byName: Map<string, VariableMeta>): { words: Set<string>; names: string[] } {
  const d = item.definition;
  const names = [...(d.variables ?? []), ...(d.rows ?? []), ...(d.columns ?? [])].filter(Boolean);
  const text = [item.name, ...names.map((n) => byName.get(n)?.label ?? ""), ...names.map((n) => byName.get(n)?.itemLabel ?? "")].join(" ");
  return { words: new Set(tokens(text)), names };
}

/** two words are the same word for matching: equal, or long enough to share their first five letters ("satisfied" / "satisfaction") */
export const wordsMatch = (a: string, b: string): boolean => a === b || (a.length > 4 && b.length > 4 && a.slice(0, 5) === b.slice(0, 5));

/** does this key question speak to this analysis? Named variable, or enough shared words. */
function answers(question: string, about: ReturnType<typeof aboutWords>): boolean {
  if (about.names.some((n) => mentionsVariable(question, n))) return true;
  const q = tokens(question);
  if (!q.length) return false;
  const shared = q.filter((w) => about.words.has(w) || [...about.words].some((a) => wordsMatch(a, w)));
  return shared.length >= Math.max(1, Math.ceil(q.length / 2));
}

/* ------------------------------------------------------------ 1–2: what can be shown, in what order */

export function usability(items: readonly BuilderItem[]): { usable: BuilderItem[]; skipped: SkippedItem[] } {
  const skipped: SkippedItem[] = []; const usable: BuilderItem[] = [];
  const seen = new Map<string, string>();
  for (const it of items) {
    const r = it.result;
    if (r.error) { skipped.push({ id: it.id, name: it.name, reason: r.error.message }); continue; }
    if ((r.base?.n ?? 0) === 0) { skipped.push({ id: it.id, name: it.name, reason: "No respondent is in this analysis' selected data, so there is nothing to report." }); continue; }
    const empty = !r.tables.length && !(r.chart.series?.length) && !r.chart.matrix && !r.chart.points?.length && !r.chart.kpis?.length && !r.chart.words?.length && !r.insights.length;
    if (empty) { skipped.push({ id: it.id, name: it.name, reason: "It produced no table, chart or finding." }); continue; }
    const sig = analysisSignature(it.definition);
    const dup = seen.get(sig);
    if (dup) { skipped.push({ id: it.id, name: it.name, reason: `It computes exactly what “${dup}” already does.` }); continue; }
    seen.set(sig, it.name); usable.push(it);
  }
  return { usable, skipped };
}

export interface Ranked { item: BuilderItem; role: ItemRole; score: number; answers: string[]; significant: boolean; advice: ChartAdvice }

export function rankItems(items: readonly BuilderItem[], variables: readonly VariableMeta[], brief: ReportBrief): { ranked: Ranked[]; skipped: SkippedItem[]; uncovered: string[] } {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const wanted = brief.analysisIds?.length ? new Set(brief.analysisIds) : null;
  const pool = wanted ? items.filter((i) => wanted.has(i.id)) : items;
  const { usable, skipped } = usability(pool);
  const questions = brief.keyQuestions.map((q) => q.trim()).filter(Boolean);
  const covered = new Set<string>();
  const ranked: Ranked[] = [];
  for (const it of usable) {
    const kind = it.definition.kind;
    const significant = isSignificant(it.result);
    if (kind === "test" && brief.includeTests === false) { skipped.push({ id: it.id, name: it.name, reason: "Significance tests were left out of the scope." }); continue; }
    if (kind === "crosstab" && brief.includeCrosstabs === false) { skipped.push({ id: it.id, name: it.name, reason: "Cross-tabulations were left out of the scope." }); continue; }
    const about = aboutWords(it, byName);
    const hit = questions.filter((q) => answers(q, about));
    hit.forEach((q) => covered.add(q));
    const role: ItemRole = hit.length ? "key" : kind === "test" || (kind !== "crosstab" && significant) ? "difference" : kind === "crosstab" ? "comparison" : "finding";
    const n = it.result.base.n;
    const score = (hit.length ? 50 + 5 * hit.length : 0) + (significant ? 20 : 0) + (kind === "crosstab" ? 4 : 0) + (it.result.insights.length ? 6 : 0) - (n < SMALL ? 10 : 0) - Math.min(6, it.result.warnings.length * 2);
    ranked.push({ item: it, role, score, answers: hit, significant, advice: adviseChart(it.definition, it.result, variables, { audience: brief.audience }) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const max = brief.maxItems && brief.maxItems > 0 ? brief.maxItems : DEFAULT_MAX[brief.audience];
  const keep = ranked.slice(0, max);
  for (const r of ranked.slice(max)) skipped.push({ id: r.item.id, name: r.item.name, reason: `Left out to keep the report to ${max} analyses for a${brief.audience === "executive" ? "n" : ""} ${brief.audience} audience; raise the limit to include it.` });
  /* a key question counts as covered by the analyses that made the cut, not by those dropped */
  const kept = new Set(keep.flatMap((k) => k.answers));
  const uncovered = questions.filter((q) => !kept.has(q));
  return { ranked: keep, skipped, uncovered };
}

/* ------------------------------------------------------------ sentences, all from the results */

/** the sample, from the bases the analyses printed */
export function sampleSentence(items: readonly BuilderItem[]): string {
  const ns = items.map((i) => i.result.base.n).filter((n) => n > 0);
  const total = items.reduce((m, i) => Math.max(m, i.result.base.total ?? 0), 0);
  if (!ns.length) return "No respondents are in the data selected for these analyses.";
  const lo = Math.min(...ns), hi = Math.max(...ns);
  const who = plural(total || hi, "respondent");
  return lo === hi ? `${who} in the selected data; ${hi} answered the questions shown.` : `${who} in the selected data; between ${lo} and ${hi} answered each question shown.`;
}

const headline = (r: AnalysisResult): string => (r.insights[0] ?? "").trim() || `${r.name}: ${plural(r.base.n, "respondent")}.`;

function captionFor(r: Ranked, brief: ReportBrief): string {
  const lines = [headline(r.item.result)];
  if (brief.tone !== "concise" && r.item.result.insights[1]) lines.push(r.item.result.insights[1].trim());
  if (brief.audience === "researcher") { const t = testLine(r.item.result); if (t) lines.push(t + "."); }
  lines.push(r.advice.denominator);
  return lines.join(" ");
}

/* ------------------------------------------------------------ the report */

const HEAD: Record<ReportTone, { key: string; comparison: string; difference: string }> = {
  plain: { key: "What you asked", comparison: "How groups compare", difference: "Where answers differ" },
  formal: { key: "Findings on the key questions", comparison: "Comparisons between groups", difference: "Statistically significant differences" },
  concise: { key: "Key findings", comparison: "Group comparisons", difference: "Significant differences" },
};

export function draftReport(brief: ReportBrief, items: readonly BuilderItem[], variables: readonly VariableMeta[], opts: { story?: boolean; interpretation?: GatedInterpretation | null; now?: Date } = {}): BuilderDraft {
  const { ranked, skipped, uncovered } = rankItems(items, variables, brief);
  const notes: string[] = [];
  const title = brief.title?.trim() || clip(brief.objective.trim() || "Survey findings", 90);
  const blocks: ReportBlock[] = [];
  blocks.push({ id: bid("cover"), type: "cover", title, subtitle: `${analysesOf(ranked.length)}${brief.client ? ` · prepared for ${brief.client}` : ""}`, date: (opts.now ?? new Date()).toISOString().slice(0, 10) });
  if (!ranked.length) {
    notes.push("None of the saved analyses could be shown, so the report has only its cover. Create or repair analyses first.");
    const report: ReportDefinition = { title, mode: "live", blocks };
    return { report, included: [], skipped, uncovered: brief.keyQuestions.filter(Boolean), notes };
  }
  const shown = ranked.map((r) => r.item);
  const lead = ranked.filter((r) => r.role === "key" || r.significant).slice(0, 6);
  const summaryText = [sampleSentence(shown), ...lead.map((r) => headline(r.item.result))].join(" ");
  blocks.push({ id: bid("exec"), type: "executive_summary", title: "Executive summary", analysisIds: lead.map((r) => r.item.id), text: summaryText });
  if (brief.objective.trim()) blocks.push({ id: bid("obj"), type: "text", title: "Objective", markdown: [brief.objective.trim(), ...(brief.keyQuestions.filter(Boolean).length ? ["", "**Key questions**", ...brief.keyQuestions.filter(Boolean).map((q) => `- ${q}`)] : [])].join("\n") });
  blocks.push({ id: bid("samp"), type: "text", title: "Who answered", markdown: sampleSentence(shown) });
  const H = HEAD[brief.tone];
  const section = (heading: string, group: Ranked[]) => {
    if (!group.length) return;
    blocks.push({ id: bid("sec"), type: "section", title: heading });
    for (const r of group) blocks.push({ id: bid("ch"), type: "chart", title: r.item.name, analysisId: r.item.id, chart: { type: r.advice.type, options: { title: r.item.name, dataLabels: true } }, caption: captionFor(r, brief) });
  };
  section(H.key, ranked.filter((r) => r.role === "key"));
  section(H.comparison, ranked.filter((r) => r.role === "comparison" || r.role === "finding"));
  section(H.difference, ranked.filter((r) => r.role === "difference"));
  if (opts.interpretation && (opts.interpretation.implications.length || opts.interpretation.recommendations.length)) {
    blocks.push({ id: bid("sec"), type: "section", title: "Interpretation", subtitle: "What the findings may mean — these are readings of the results above, not results themselves" });
    const md = [...opts.interpretation.implications.map((s) => `- ${s}`), ...(opts.interpretation.recommendations.length ? ["", "**Suggested next steps**", ...opts.interpretation.recommendations.map((s) => `- ${s}`)] : [])].join("\n");
    blocks.push({ id: bid("interp"), type: "text", markdown: md });
  }
  blocks.push({ id: bid("meth"), type: "methodology", title: "Methodology", includeStandardNotes: true, items: [{ label: "Analyses shown", value: `${ranked.length}, from the saved analyses of this survey` }, { label: "Respondents", value: sampleSentence(shown) }, { label: "Significance", value: `α = ${ALPHA}` }] });
  const caveats = [...new Set([
    ...ranked.filter((r) => r.item.result.base.n < SMALL).map((r) => `${r.item.name}: only ${r.item.result.base.n} respondents — read as indicative.`),
    ...ranked.flatMap((r) => r.item.result.warnings.map((w) => `${r.item.name}: ${w}`)),
  ])].slice(0, 12);
  if (caveats.length) blocks.push({ id: bid("cav"), type: "text", title: "Caveats", markdown: caveats.map((c) => `- ${c}`).join("\n") });
  if (uncovered.length) notes.push(`No saved analysis answers: ${uncovered.map((q) => `“${clip(q, 70)}”`).join("; ")}. Add an analysis for ${uncovered.length === 1 ? "it" : "them"} and build again — the report does not guess.`);
  if (skipped.length) notes.push(`${analysesOf(skipped.length)} left out — see the reasons.`);

  const included: IncludedItem[] = ranked.map((r) => ({
    id: r.item.id, name: r.item.name, role: r.role, chart: r.advice.type, chartReason: r.advice.reason, denominator: r.advice.denominator, scale: r.advice.scale, answers: r.answers, significant: r.significant,
    notes: [...r.advice.notes],
  }));
  const report: ReportDefinition = { title, subtitle: `Built from ${analysesOf(ranked.length)}`, mode: "live", blocks };
  const story = opts.story ? buildStory(brief, ranked, { interpretation: opts.interpretation ?? null, now: opts.now }) : undefined;
  if (story) report.story = story;
  return { report, ...(story ? { story } : {}), included, skipped, uncovered, notes };
}

/* ------------------------------------------------------------ the story */

/** seconds on screen from the words read: 140 words a minute, never under 4s or over 14s */
export const sceneDuration = (text: string, extraMs = 0): number => Math.min(14000, Math.max(4000, Math.round((text.split(/\s+/).filter(Boolean).length / 140) * 60000) + 1500 + extraMs));

function scene(type: StoryScene["type"], nature: StoryScene["nature"], title: string, text: string, extra: Partial<StoryScene> = {}): StoryScene {
  const narration = extra.narration ?? [text, extra.base ?? ""].filter(Boolean).join(" ");
  return { id: bid("sc"), type, title, text, narration, nature, source: "engine", durationMs: sceneDuration(narration), ...extra };
}

/** a crosstab is a comparison, a test is a difference, anything else a finding — whatever question it answers */
const sceneTypeOf = (item: BuilderItem): "finding" | "comparison" | "difference" => item.definition.kind === "crosstab" ? "comparison" : item.definition.kind === "test" ? "difference" : "finding";

/** one analysis as the scene the story tells about it */
export function sceneForItem(r: Ranked): StoryScene {
  const type = sceneTypeOf(r.item);
  const r0 = r.item.result;
  const text = type === "difference" && testLine(r0) ? `${headline(r0)} (${testLine(r0)}.)` : headline(r0);
  return scene(type, "finding", clip(r.item.name, 80), text, { analysisId: r.item.id, chart: { type: r.advice.type }, base: r.advice.denominator });
}

export function buildStory(brief: ReportBrief, ranked: readonly Ranked[], opts: { interpretation?: GatedInterpretation | null; now?: Date } = {}): StoryDefinition {
  const title = brief.title?.trim() || clip(brief.objective.trim() || "Survey findings", 90);
  const shown = ranked.map((r) => r.item);
  const scenes: StoryScene[] = [];
  scenes.push(scene("title", "frame", title, brief.client ? `Prepared for ${brief.client}` : "Survey findings", { narration: title }));
  if (brief.objective.trim()) scenes.push(scene("objective", "frame", "What we set out to learn", [brief.objective.trim(), ...brief.keyQuestions.filter(Boolean).slice(0, 4)].join(" · ")));
  scenes.push(scene("sample", "finding", "Who answered", sampleSentence(shown)));
  /*
   * The scenes an audience can take in are the best-ranked analyses (key
   * questions first, then the strongest evidence) — and they are TOLD in the
   * order a story reads: findings, then comparisons, then tested differences.
   */
  const max = brief.audience === "executive" ? 9 : brief.audience === "client" ? 14 : 22;
  const interp = opts.interpretation;
  const interpScenes: StoryScene[] = [];
  if (interp) {
    for (const s of interp.implications) interpScenes.push(scene("interpretation", "interpretation", "What this may mean", s, { source: "model" }));
    if (interp.recommendations.length) interpScenes.push(scene("interpretation", "interpretation", "Suggested next steps", interp.recommendations.join(" "), { source: "model" }));
  }
  const room = Math.max(1, max - 4 - interpScenes.length);   // title, objective, sample, summary are always there
  const chosen = ranked.slice(0, room);
  for (const type of ["finding", "comparison", "difference"] as const) for (const r of chosen) if (sceneTypeOf(r.item) === type) scenes.push(sceneForItem(r));
  scenes.push(...interpScenes);
  const heads = chosen.filter((r) => r.role === "key" || r.significant).slice(0, 5).map((r) => headline(r.item.result));
  scenes.push(scene("summary", "finding", "In summary", heads.length ? heads.join(" ") : sampleSentence(shown)));
  const kept = scenes;
  return { title, subtitle: analysesOf(ranked.length), audience: brief.audience, tone: brief.tone, scenes: kept, transition: "fade", ...(brief.objective.trim() ? { brief: { objective: brief.objective.trim(), keyQuestions: brief.keyQuestions.filter(Boolean), ...(brief.client ? { client: brief.client } : {}) } } : {}), builtAt: (opts.now ?? new Date()).toISOString() };
}

/**
 * Rebuild one scene from the analysis it reads, as it is now — the "regenerate
 * this scene" action. A scene the researcher wrote (`manual`) or a model
 * wrote is left to the caller (a model scene is asked for again, through the
 * gate); a frame scene is rebuilt from the brief.
 */
export function regenerateScene(story: StoryDefinition, sceneId: string, items: readonly BuilderItem[], variables: readonly VariableMeta[]): { scene: StoryScene } | { error: string } {
  const old = story.scenes.find((s) => s.id === sceneId);
  if (!old) return { error: "That scene is no longer in the story." };
  if (old.analysisId) {
    const item = items.find((i) => i.id === old.analysisId);
    if (!item) return { error: "The analysis this scene reads has been deleted." };
    const { usable, skipped } = usability([item]);
    if (!usable.length) return { error: skipped[0]?.reason ?? "This analysis cannot be shown." };
    const advice = adviseChart(item.definition, item.result, variables, { audience: story.audience });
    const significant = isSignificant(item.result);
    const role: ItemRole = old.type === "difference" ? "difference" : old.type === "comparison" ? "comparison" : "finding";
    const fresh = sceneForItem({ item, role, score: 0, answers: [], significant, advice });
    return { scene: { ...fresh, id: old.id, ...(old.chart && checkChartChoice(item.result, old.chart.type).valid ? { chart: old.chart } : {}) } };
  }
  if (old.type === "sample") return { scene: { ...scene("sample", "finding", old.title, sampleSentence(items)), id: old.id } };
  if (old.type === "objective" && story.brief) return { scene: { ...scene("objective", "frame", old.title, [story.brief.objective, ...story.brief.keyQuestions.slice(0, 4)].join(" · ")), id: old.id } };
  return { error: "This scene is not built from an analysis — edit its text directly." };
}

/* ------------------------------------------------------------ the model's part: interpretation, through the gate */

export interface GatedInterpretation { implications: string[]; recommendations: string[]; rejected: { text: string; reason: string }[]; offered: number }

/** every number the results printed — bases, cells, chart values, tests, insight text */
export function resultNumbers(items: readonly Pick<BuilderItem, "result">[]): Set<string> {
  const out = new Set<string>();
  const norm = (s: string) => { let t = s.replace(/%$/, "").replace(/,(?=\d{3}\b)/g, ""); if (t.startsWith(".")) t = `0${t}`; if (t.startsWith("-.")) t = `-0${t.slice(1)}`; return t.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); };
  const add = (x: unknown) => {
    if (typeof x !== "number" || !Number.isFinite(x)) return;
    for (const d of [0, 1, 2, 3]) { out.add(norm(x.toFixed(d))); out.add(norm(Math.abs(x).toFixed(d))); }
    out.add(norm(String(x))); out.add(norm(String(Math.abs(x))));
    if (Math.abs(x) <= 1) for (const d of [0, 1]) out.add(norm((x * 100).toFixed(d)));
  };
  const text = (t: unknown) => { if (typeof t === "string") for (const m of t.match(/-?\d+(?:[.,]\d+)?%?/g) ?? []) out.add(norm(m)); };
  for (const { result: r } of items) {
    for (const k of ["total", "filtered", "n", "weightedN"] as const) add(r.base?.[k]);
    r.insights.forEach(text); r.warnings.forEach(text);
    for (const s of r.chart.series ?? []) { s.values.forEach(add); s.errors?.forEach(add); }
    r.chart.kpis?.forEach((k) => { add(typeof k.value === "number" ? k.value : NaN); add(k.delta); });
    for (const t of r.tables) for (const row of t.rows) for (const v of Object.values(row)) { if (typeof v === "number") add(v); else text(v); }
    for (const t of r.tests) { add(t.statistic); add(t.p); add(t.effectSize?.value); if (typeof t.df === "number") add(t.df); else if (Array.isArray(t.df)) t.df.forEach(add); }
  }
  return out;
}

/** what the model is asked, and the shape it answers in */
export const INTERPRETATION_INSTRUCTIONS = `You are helping a research team write the INTERPRETATION of survey results. Use ONLY the RESULTS below. Answer as JSON: {"implications": ["<what a finding may mean for the stated objective, one sentence each, at most 4>"], "recommendations": ["<a next step the evidence supports, one sentence each, at most 4>"]}. Rules: every number you write must appear in the results exactly as printed; never state a result that is not listed; say "may" or "suggests" — these are readings, not findings; do not mention analyses that are not listed; no marketing language.`;

/** the facts the model sees — the same sentences and numbers the report prints, nothing else */
export function interpretationBrief(brief: ReportBrief, items: readonly BuilderItem[]): string {
  const lines = [`OBJECTIVE: ${brief.objective || "(not stated)"}`, `AUDIENCE: ${brief.audience}; TONE: ${brief.tone}`, brief.keyQuestions.length ? `KEY QUESTIONS: ${brief.keyQuestions.join(" | ")}` : "", "RESULTS:"];
  for (const it of items) {
    const r = it.result;
    lines.push(`- ${it.name} (n = ${r.base.n}): ${r.insights.slice(0, 3).join(" ") || "no finding text"}${testLine(r) ? ` [${testLine(r)}]` : ""}`);
  }
  return lines.filter(Boolean).join("\n");
}

const sentences = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 400)).slice(0, max) : []);

/** the model's interpretation, sentence by sentence, against the results — what passes is kept, what does not is listed with why */
export function gateInterpretation(items: readonly BuilderItem[], candidate: unknown): GatedInterpretation {
  const c = (candidate && typeof candidate === "object" ? candidate : {}) as Record<string, unknown>;
  const numbers = resultNumbers(items);
  const rejected: GatedInterpretation["rejected"] = []; let offered = 0;
  const pass = (list: string[]): string[] => list.filter((t) => { offered++; const p = sentenceProblem(t, numbers, []); if (p) { rejected.push({ text: t, reason: p }); return false; } return true; });
  return { implications: pass(sentences(c.implications, 4)), recommendations: pass(sentences(c.recommendations, 4)), rejected, offered };
}
