/**
 * THE REPORT PLANNER — the story report from a run of the analysis plan.
 *
 * The narrative is the storytelling deck's (`deckFromRun`): the summary, the
 * key findings strongest first with the evidence line and the "so what",
 * the group comparisons, the implications against the hypotheses, the next
 * steps the evidence calls for, the method and the caveats — every sentence
 * from the run. This planner turns it into scenes and adds what a research
 * report needs around it: the objective and questions, the methodology with
 * the sample and the quality exclusions, who took part, the hypothesis
 * verdicts, themes from open text when there are any, and an appendix with
 * the full tables behind the main scenes.
 *
 * Sections appear only when there is something true to put in them: no
 * objective, no objective scene; no hypotheses, no verdict scene; no open
 * text, no themes. A finding's chart is the analysis' own result, frozen
 * with a reference to the analysis, and the same analysis is never drawn
 * twice in the main story.
 */
import type { SurveyDefinition } from "@rescript/schema";
import type { AnalysisDefinition, AnalysisResult } from "../types.js";
import type { AnalysisRun, Finding, RunItem } from "../findings.js";
import { deckFromRun, type DeckSlide, type NarrativeSections } from "../deck.js";
import type { Audience } from "../chartPurpose.js";
import { hashDefinition } from "../analyses/common.js";
import type { DesignConfig, EvidenceLevel, FrozenChartData, Scene, SceneVisual, SourceRef, StoryReport } from "./types.js";
import { STORY_SCHEMA } from "./types.js";
import { freezeChartData, freezeTable, recommendStoryChart } from "./charts.js";
import { defaultDesign } from "./design.js";

export interface SampleFacts {
  /** completes in the dataset the run used */
  analysed: number;
  /** completes before the quality rule (clean datasets only) */
  completesBeforeQuality?: number;
  environment: string;
  /** "all" or "clean" */
  dataset: string;
  fieldwork?: { from?: string; to?: string };
  weighting?: string | null;
}

export interface PlannerOptions {
  audience?: Audience;
  design?: DesignConfig;
  title?: string;
  client?: string;
  /** the saved analysis a run item is stored as */
  analysisIdFor?: (plannedId: string | undefined, name: string) => string | undefined;
  runId?: string | null;
  planHash?: string | null;
  surveyVersion?: string | null;
  sample: SampleFacts;
  /** respondent profile: the segmentation variables' frequency results, most important first */
  profile?: { variable: string; label: string; result: AnalysisResult; definition: AnalysisDefinition }[];
  narrative?: NarrativeSections;
  maxFindings?: number;
  /** sections the researcher switched off */
  exclude?: Scene["kind"][];
  outputs?: { pptx: boolean; video: boolean };
  date?: string;
}

type RunWithResults = Pick<AnalysisRun, "computedAt" | "trigger" | "environment" | "n" | "findings" | "verdicts" | "warnings" | "corrections" | "advice" | "discoveries" | "kpis" | "since"> & { items: (RunItem & { result: AnalysisResult })[] };

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const VERDICT_WORDS = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Untested" } as const;

function baseScene(id: string, kind: Scene["kind"], title: string, visual: SceneVisual, layout: Scene["layout"], extra: Partial<Scene> = {}): Scene {
  return {
    id, kind, section: "main", title, visual, layout, emphasis: "standard",
    motion: { enter: "rise", chart: visual.type === "chart" ? "grow" : "none", transition: "inherit" },
    duration: "auto", notes: { sources: [], footnotes: [], caveats: [] }, locked: [], ...extra,
  };
}

/** every scene carries its own engine version, so "restore the recommendation" has something to restore */
function withRecommended(s: Scene): Scene {
  const { recommended: _r, locked: _l, ...rest } = s;
  void _r; void _l;
  return { ...s, recommended: structuredClone(rest) };
}

export function sourceOf(item: Pick<RunItem, "definition">, opts: Pick<PlannerOptions, "analysisIdFor" | "runId">): SourceRef {
  const planned = item.definition.options?.planned ? String(item.definition.options.planned) : undefined;
  const analysisId = opts.analysisIdFor?.(planned, item.definition.name);
  return { name: item.definition.name, ...(analysisId ? { analysisId } : {}), ...(planned ? { plannedId: planned } : {}), ...(opts.runId ? { runId: opts.runId } : {}), definitionHash: hashDefinition(item.definition) };
}

const evidenceOf = (f: Finding): EvidenceLevel =>
  ["segment", "anomaly", "trend"].includes(f.kind) ? "exploratory"
  : f.significant ? (f.evidence.adjusted && !f.evidence.adjusted.significant ? "mixed" : "significant")
  : f.evidence.p != null ? "not_significant" : "descriptive";

/** the category a significant single-series result is about: the highest value */
function highlightFor(data: FrozenChartData, significant: boolean): string[] | undefined {
  if (!significant || data.series.length !== 1) return undefined;
  const vals = data.series[0].values;
  let best = -1;
  vals.forEach((v, i) => { if (v != null && (best < 0 || v > (vals[best] ?? -Infinity))) best = i; });
  return best >= 0 ? [data.categories[best]] : undefined;
}

/** The story report from a run with its results. Pure: the run in, the report out. */
export function planStoryReport(def: SurveyDefinition, run: RunWithResults, opts: PlannerOptions): StoryReport {
  const audience = opts.audience ?? "client";
  const design = opts.design ?? defaultDesign();
  const deck = deckFromRun(def, run, { audience, ...(opts.client ? { client: opts.client } : {}), ...(opts.title ? { title: opts.title } : {}), ...(opts.date ? { date: opts.date } : {}), analysisIdFor: (p, n) => p ?? n, maxFindings: opts.maxFindings ?? 5, ...(opts.narrative ? { narrative: opts.narrative } : {}) });
  const excluded = new Set(opts.exclude ?? []);
  const r = def.research;
  const scenes: Scene[] = [];
  const usedAnalyses = new Set<string>();
  const appendix: Scene[] = [];
  const itemFor = (f: Finding) => run.items.find((it) => it.findings.some((x) => x.id === f.id));
  const itemByKey = (key: string | undefined) => (key ? run.items.find((it) => (it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name) === key) : undefined);
  const date = (opts.date ?? run.computedAt).slice(0, 10);

  /* 1. title */
  const titleSlide = deck.slides.find((s): s is Extract<DeckSlide, { type: "title" }> => s.type === "title")!;
  scenes.push(baseScene("title", "title", titleSlide.title, { type: "none" }, "title", { subtitle: titleSlide.subtitle, motion: { enter: "fade", chart: "none", transition: "inherit" } }));

  /* 2. objective and questions */
  if (!excluded.has("objective") && (r?.objective || r?.hypotheses.length || r?.researchQuestions?.length || r?.brief?.businessQuestion)) {
    const items = [
      ...(r?.brief?.businessQuestion ? [`Business question: ${short(r.brief.businessQuestion, 150)}`] : []),
      ...(r?.brief?.decision ? [`Decision it informs: ${short(r.brief.decision, 150)}`] : []),
      ...(r?.researchQuestions ?? []).slice(0, 3).map((q) => short(q, 140)),
      ...(r?.hypotheses ?? []).slice(0, 4).map((h, i) => `H${i + 1}: ${short(h, 130)}`),
    ];
    scenes.push(baseScene("objective", "objective", r?.objective ? short(r.objective, 120) : "What we set out to learn", items.length ? { type: "bullets", items } : { type: "none" }, "text", { kicker: "Objective" }));
  }

  /* 3. methodology and sample */
  if (!excluded.has("method")) {
    const s = opts.sample;
    const facts = [
      { label: "Completes analysed", value: `${s.analysed.toLocaleString()} (${s.environment.toLowerCase()} responses)` },
      ...(s.fieldwork?.from || s.fieldwork?.to ? [{ label: "Fieldwork", value: `${s.fieldwork.from ?? "…"} → ${s.fieldwork.to ?? "…"}` }] : []),
      ...(s.dataset === "clean" ? [{ label: "Data quality", value: s.completesBeforeQuality != null ? `${s.analysed.toLocaleString()} of ${s.completesBeforeQuality.toLocaleString()} completes passed the quality checks; ${(s.completesBeforeQuality - s.analysed).toLocaleString()} excluded` : "Only completes that passed the quality checks" }] : [{ label: "Data quality", value: "All complete responses (no quality exclusions applied)" }]),
      ...(r?.population ? [{ label: "Population", value: short(r.population, 120) }] : []),
      ...(r?.methodology ? [{ label: "Method", value: short(r.methodology, 120) }] : []),
      { label: "Significance", value: `α = 0.05${run.corrections ? `; ${run.corrections.method === "bh" ? "Benjamini–Hochberg" : run.corrections.method === "bonferroni" ? "Bonferroni" : "Holm"} correction within each hypothesis` : ""}` },
      { label: "Weighting", value: s.weighting ? s.weighting : "Unweighted" },
    ];
    scenes.push(baseScene("method", "method", "How the study was done", { type: "facts", items: facts.slice(0, 7) }, "facts", { kicker: "Methodology" }));
  }

  /* 4. who took part */
  if (!excluded.has("sample") && opts.profile?.length) {
    const p = opts.profile.find((x) => freezeChartData(x.result, x.definition));
    if (p) {
      const data = freezeChartData(p.result, p.definition)!;
      const rec = recommendStoryChart(p.definition, p.result, data, audience);
      const src: SourceRef = { name: p.definition.name, ...(opts.runId ? { runId: opts.runId } : {}), definitionHash: hashDefinition(p.definition) };
      scenes.push(baseScene("sample", "sample", `Who took part: ${p.label}`, { type: "chart", chart: rec.type, data, recommendation: rec, source: src }, "visual_right", { kicker: "Sample", body: `Base: ${data.base ?? opts.sample.analysed} respondents. The profile is descriptive — no test is implied.`, evidence: "descriptive", notes: { sources: [src], footnotes: [`Base: ${data.base ?? opts.sample.analysed}`], caveats: [] } }));
    }
  }

  /* 5. summary */
  const summary = deck.slides.find((s): s is Extract<DeckSlide, { type: "summary" }> => s.type === "summary");
  if (summary && !excluded.has("summary")) {
    /* the summary says what was found; the objective scene already said what was asked — no repeats */
    const head = summary.headline.toLowerCase();
    const found = summary.bullets.filter((b) => !/^(business question|decision( it| this)? informs?|objective)\b/i.test(b) && b.toLowerCase() !== head);
    const extra = deck.slides.filter((x): x is Extract<DeckSlide, { type: "key_finding" }> => x.type === "key_finding").map((x) => x.title).filter((t) => t.toLowerCase() !== head && !found.some((b) => b.toLowerCase().includes(t.toLowerCase())));
    const items = [...found, ...extra].slice(0, 5);
    scenes.push(baseScene("summary", "summary", short(summary.headline, 140), { type: "bullets", items: items.length ? items : summary.bullets.slice(0, 3) }, "text", { kicker: "Executive summary", emphasis: "focus" }));
  }

  /* 6. since the last wave */
  const wave = deck.slides.find((s): s is Extract<DeckSlide, { type: "wave_change" }> => s.type === "wave_change");
  if (wave && wave.kpis.length && !excluded.has("wave")) {
    scenes.push(baseScene("wave", "wave", "What moved since the last wave", { type: "kpis", items: wave.kpis.slice(0, 4).map((k) => ({ label: k.name, value: k.to, detail: `${k.from} → ${k.to} (${k.delta}${k.significant === undefined ? "" : k.significant ? ", significant" : ", not significant"})` })) }, "kpi_row", { kicker: wave.since, notes: { sources: [], footnotes: wave.changes.slice(0, 3), caveats: [] } }));
  }

  /* 7. key findings: one scene per analysis, strongest first */
  const findingSlides = deck.slides.filter((s): s is Extract<DeckSlide, { type: "key_finding" }> => s.type === "key_finding" && !s.beyond);
  let k = 0;
  for (const slide of findingSlides) {
    if (excluded.has("finding")) break;
    const f = run.findings.find((x) => slide.title && x.headline.startsWith(slide.title)) ?? run.findings.find((x) => x.significant && slide.title.includes(x.variables[0] ?? "\u0000"));
    const it = (f ? itemFor(f) : undefined) ?? itemByKey(slide.analysisId);
    if (!it) continue;
    const src = sourceOf(it, opts);
    const key = src.plannedId ?? src.name;
    if (usedAnalyses.has(key)) {
      /* the same analysis again: its headline joins the earlier scene's notes rather than drawing the chart twice */
      const earlier = scenes.find((s) => s.notes.sources.some((x) => (x.plannedId ?? x.name) === key));
      if (earlier) earlier.notes.footnotes.push(`Also: ${short(slide.title, 120)}`);
      continue;
    }
    const data = freezeChartData(it.result, it.definition);
    k++;
    const evidence = f ? evidenceOf(f) : "descriptive";
    const caveats = [...(f?.evidence.adjusted && !f.evidence.adjusted.significant ? ["Significant on its own, but not after correction for the family of tests."] : []), ...((f?.evidence.n ?? 0) > 0 && (f?.evidence.n ?? 0) < 30 ? [`Base of ${f!.evidence.n} — read with caution.`] : [])];
    const visual: SceneVisual = data
      ? (() => { const rec = recommendStoryChart(it.definition, it.result, data, audience); return { type: "chart", chart: rec.type, data, recommendation: rec, source: src, ...(highlightFor(data, evidence === "significant") ? { highlight: highlightFor(data, evidence === "significant") } : {}), ...(it.chart ? { sourceChart: it.chart } : {}) } as SceneVisual; })()
      : (() => { const t = freezeTable(it.result, 0, { mainRows: 8 }); return t ? { type: "table", table: t, source: src } as SceneVisual : { type: "bullets", items: [slide.evidence] } as SceneVisual; })();
    scenes.push(baseScene(`finding_${key}`, "finding", short(slide.title, 120), visual, visual.type === "table" ? "table" : "visual_right", {
      kicker: `Key finding ${k}`, body: short(slide.soWhat, 220), evidence, emphasis: evidence === "significant" ? "focus" : "standard",
      notes: { sources: [src], footnotes: [slide.evidence], caveats },
    }));
    usedAnalyses.add(key);
    /* the full table behind it, in the appendix */
    const full = freezeTable(it.result, 0);
    if (full && (full.rows.length > 6 || full.columns.length > 5 || visual.type === "chart")) appendix.push(baseScene(`appendix_${key}`, "appendix_table", `Table: ${short(it.definition.name, 100)}`, { type: "table", table: full, source: src }, "table", { section: "appendix", kicker: "Appendix", notes: { sources: [src], footnotes: full.notes.slice(0, 3), caveats: [] }, motion: { enter: "fade", chart: "none", transition: "inherit" } }));
  }

  /* 8. who differs: the comparisons not already drawn */
  for (const slide of deck.slides.filter((s): s is Extract<DeckSlide, { type: "segment_comparison" }> => s.type === "segment_comparison")) {
    if (excluded.has("comparison")) break;
    const it = itemByKey(slide.analysisId);
    const key = it ? (it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name) : `cmp_${slide.title}`;
    if (usedAnalyses.has(key)) continue;
    const f = run.findings.find((x) => x.headline.startsWith(slide.title));
    if (!slide.groups.length) continue;
    const n = slide.groups.reduce((a, g) => a + g.n, 0);
    const data: FrozenChartData = { categories: slide.groups.map((g) => g.label), series: [{ name: `Mean ${slide.measure}`, values: slide.groups.map((g) => (g.value === "—" ? null : Number(g.value))) }], valueFormat: "mean", decimals: 2, base: n, seriesBases: slide.groups.map((g) => g.n), significanceTested: false, measure: `mean ${slide.measure}` };
    const src: SourceRef = it ? sourceOf(it, opts) : { name: f?.analysis.name ?? slide.title, ...(f?.analysis.planned ? { plannedId: f.analysis.planned } : {}), ...(opts.runId ? { runId: opts.runId } : {}) };
    scenes.push(baseScene(`comparison_${key}`, "comparison", short(slide.title, 120), { type: "chart", chart: "hbar", data, recommendation: { type: "hbar", why: "horizontal bars: compares group means; bars start at zero so their lengths stay proportional", alternatives: [{ type: "bar", why: "compares a few categories", allowed: true }] }, source: src }, "visual_right", {
      kicker: "Who differs", body: short(slide.differs, 220), evidence: f ? evidenceOf(f) : "descriptive",
      notes: { sources: [src], footnotes: slide.groups.map((g) => `${g.label}: n = ${g.n}`).slice(0, 6), caveats: f?.kind === "segment" ? ["Found outside the analysis plan; corrected for the number of comparisons looked at."] : [] },
    }));
    usedAnalyses.add(key);
  }

  /* 9. the hypotheses and their verdicts */
  if (run.verdicts.length && !excluded.has("hypotheses")) {
    scenes.push(baseScene("hypotheses", "hypotheses", "What the evidence says about each hypothesis", { type: "verdicts", items: run.verdicts.slice(0, 6).map((v) => ({ label: v.label, text: short(v.text, 110), verdict: v.verdict, reason: short(v.corrected ? `${v.reason} ${v.corrected.note}` : v.reason, 240) })) }, "verdicts", {
      kicker: "Hypotheses", notes: { sources: [], footnotes: [`Verdicts at α = 0.05${run.corrections ? `, ${run.corrections.method}-corrected within each hypothesis` : ""}. A verdict is only as strong as the tests the plan ran for it.`], caveats: run.verdicts.some((v) => v.verdict === "untested") ? ["An untested hypothesis has no analysis in the plan — the data says nothing about it yet."] : [] },
    }));
    /* the strongest effect, for a researcher audience */
    const stat = deck.slides.find((s): s is Extract<DeckSlide, { type: "statistical_highlight" }> => s.type === "statistical_highlight");
    if (stat && audience === "researcher" && !excluded.has("statistic")) scenes.push(baseScene("statistic", "statistic", short(stat.title, 120), { type: "stat", value: stat.stat.split("=")[1]?.trim() ?? stat.stat, label: `${stat.stat.split("=")[0].trim()} — ${stat.label}`, detail: `${stat.test}, ${stat.p}, n = ${stat.n}` }, "stat_center", { kicker: "Statistical highlight", body: stat.context, evidence: "significant" }));
  }

  /* 10. themes from open text, when the plan coded any */
  const textItems = run.items.filter((it) => it.definition.kind === "text" && freezeChartData(it.result, it.definition));
  if (textItems.length && !excluded.has("themes")) {
    const it = textItems[0];
    const data = freezeChartData(it.result, it.definition)!;
    const src = sourceOf(it, opts);
    scenes.push(baseScene(`themes_${src.plannedId ?? src.name}`, "themes", `Themes in what people said: ${short(it.definition.name, 80)}`, { type: "chart", chart: "hbar", data: { ...data, categories: data.categories.slice(0, 8), series: data.series.map((s) => ({ ...s, values: s.values.slice(0, 8) })) }, recommendation: { type: "hbar", why: "horizontal bars rank themes by how often they were mentioned", alternatives: [] }, source: src }, "visual_right", {
      kicker: "Open-text themes", body: "Themes coded from open answers by the engine's text analysis — counts of mentions, not a test.", evidence: "descriptive", notes: { sources: [src], footnotes: [`Base: ${data.base ?? "—"} answers`], caveats: ["Coded automatically; read alongside the verbatims."] },
    }));
  }

  /* 11. conclusions, recommendations, limitations */
  const impl = deck.slides.find((s): s is Extract<DeckSlide, { type: "implications" }> => s.type === "implications");
  if (impl && !excluded.has("conclusions")) scenes.push(baseScene("conclusions", "conclusions", "What it means", { type: "bullets", items: impl.bullets.slice(0, 5) }, "text", { kicker: "Conclusions" }));
  const recs = deck.slides.find((s): s is Extract<DeckSlide, { type: "recommendations" }> => s.type === "recommendations");
  if (recs && !excluded.has("recommendations")) scenes.push(baseScene("recommendations", "recommendations", "What to do next", { type: "bullets", items: recs.items.slice(0, 5) }, "text", { kicker: "Recommendations", notes: { sources: [], footnotes: ["Next steps the evidence calls for, derived from the verdicts and findings above."], caveats: [] } }));
  const cav = deck.slides.find((s): s is Extract<DeckSlide, { type: "caveats" }> => s.type === "caveats" && s.title === "Caveats");
  if (!excluded.has("limitations")) {
    /* the deck's caveats when it has them; otherwise what is true of every survey run, stated from its own facts */
    const facts: string[] = [
      ...(cav?.bullets ?? []),
      ...run.warnings.slice(0, 2),
      `Results describe the ${opts.sample.analysed.toLocaleString("en-US")} respondents analysed${opts.sample.weighting ? ` (weighted: ${opts.sample.weighting})` : " (unweighted)"}; differences between groups are associations, not causes.`,
      ...(run.corrections ? [] : ["Several comparisons were tested; individual significant results should be read with that in mind."]),
      ...(opts.sample.dataset === "all" ? ["All completes were analysed, including responses the quality checks marked as suspect."] : []),
    ];
    const items = [...new Set(facts)].slice(0, 5);
    scenes.push(baseScene("limitations", "limitations", "Limitations and caveats", { type: "bullets", items }, "text", { kicker: "Limitations" }));
  }

  /* 12. closing */
  scenes.push(baseScene("closing", "closing", summary ? short(summary.headline, 120) : titleSlide.title, { type: "none" }, "closing", { kicker: "In summary", subtitle: `${titleSlide.title}${opts.client ? ` · prepared for ${opts.client}` : ""} · ${date}`, motion: { enter: "fade", chart: "none", transition: "inherit" } }));

  return {
    schema: STORY_SCHEMA,
    title: titleSlide.title,
    subtitle: titleSlide.subtitle,
    audience,
    createdFrom: { runId: opts.runId ?? null, computedAt: run.computedAt, n: run.n, environment: run.environment, dataset: opts.sample.dataset, planHash: opts.planHash ?? null, surveyVersion: opts.surveyVersion ?? null },
    design,
    scenes: [...scenes, ...(excluded.has("appendix_table") ? [] : appendix)].map(withRecommended),
    outputs: opts.outputs ?? { pptx: true, video: true },
  };
}

/** "14 scenes: title, objective, method, 4 findings, …, 3 appendix tables" */
export function describeStory(r: StoryReport): string {
  const main = r.scenes.filter((s) => s.section === "main"), app = r.scenes.length - main.length;
  const counts = new Map<string, number>();
  for (const s of main) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return `${main.length} scenes: ${[...counts].map(([k, v]) => (v > 1 ? `${v} ${k.replace(/_/g, " ")}s` : k.replace(/_/g, " "))).join(", ")}${app ? `; ${app} appendix table${app === 1 ? "" : "s"}` : ""}`;
}

export const verdictWord = (v: keyof typeof VERDICT_WORDS) => VERDICT_WORDS[v];
