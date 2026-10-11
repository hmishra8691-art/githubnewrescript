import type { SurveyDefinition } from "@rescript/schema";
import type { AnalysisResult, ChartSpec } from "./types.js";
import type { AnalysisRun, Finding, HypothesisVerdict, RunItem } from "./findings.js";
import { chooseChart, type Audience } from "./chartPurpose.js";
import { reportNarrative } from "./findingsReport.js";
import { CORRECTION_WORDS } from "./posthoc.js";

/**
 * THE STORYTELLING DECK (Research Engine audit, Phase 5).
 *
 * A findings deck is not the report's blocks on slides: it is a story in a
 * fixed order a client can follow — what we set out to learn and what we
 * found (summary), the key findings one per slide with the chart chosen for
 * the audience and the one sentence that says why it matters, the groups
 * that differ (segment comparison), the strongest effects as a statistical
 * highlight, what the run found beyond the plan, what it means
 * (implications), what to do next (recommendations), how it was done, and
 * the caveats. Every sentence here is the engine's, from the run: the
 * implications restate the verdicts against the design, the
 * recommendations are next steps the evidence calls for (lead with this,
 * treat that with caution, re-run when the base allows, plan the test that
 * is missing, add the discovery to the plan). A model-written narrative,
 * when one passed the gate, replaces those texts slide by slide — never
 * the numbers.
 */
export type DeckSlide =
  | { type: "title"; title: string; subtitle: string; date: string; client?: string; audience: Audience }
  | { type: "summary"; title: string; headline: string; bullets: string[] }
  | { type: "section"; title: string; subtitle?: string }
  | { type: "key_finding"; title: string; analysisId?: string; chart: ChartSpec; evidence: string; soWhat: string; hypothesis?: string; significant: boolean; beyond?: boolean }
  | { type: "segment_comparison"; title: string; measure: string; analysisId?: string; chart?: ChartSpec; groups: { label: string; value: string; n: number }[]; differs: string }
  | { type: "statistical_highlight"; title: string; stat: string; label: string; test: string; p: string; n: number; context: string; pairs?: string }
  | { type: "implications"; title: string; bullets: string[] }
  | { type: "recommendations"; title: string; items: string[] }
  | { type: "method"; title: string; items: { label: string; value: string }[] }
  | { type: "caveats"; title: string; bullets: string[] }
  /** what moved since the previous run (Phase 8): the KPIs with their deltas and whether each move is significant, the findings that changed, the verdicts that changed */
  | { type: "wave_change"; title: string; since: string; kpis: { name: string; from: string; to: string; delta: string; verdict: "better" | "worse" | "flat" | "unknown"; significant?: boolean }[]; changes: string[]; verdicts: string[] };

export interface DeckDefinition { title: string; subtitle: string; audience: Audience; slides: DeckSlide[]; /** the analysis ids the slides draw */ analysisIds: string[] }

/** model-written sections that passed the gate: each replaces the engine's text on its slide */
export interface NarrativeSections { headline?: string; summary?: string[]; implications?: string[]; recommendations?: string[]; soWhat?: Record<string, string> }

export interface DeckOptions {
  audience?: Audience;
  client?: string;
  title?: string;
  date?: string;
  /** the analysis an item's planned id (or name) is stored as, for the slides' charts */
  analysisIdFor?: (plannedId: string | undefined, name: string) => string | undefined;
  /** how many key findings at most */
  maxFindings?: number;
  narrative?: NarrativeSections;
  /** the results by analysis id, so the chart can be chosen for the audience (the run's own results when it has them) */
  results?: Record<string, AnalysisResult>;
}

type RunForDeck = Pick<AnalysisRun, "computedAt" | "trigger" | "environment" | "n" | "findings" | "verdicts" | "warnings"> & { items: (Pick<RunItem, "definition" | "hypotheses" | "chart" | "findings"> & { result?: AnalysisResult; adaptedFrom?: string })[]; corrections?: AnalysisRun["corrections"]; advice?: AnalysisRun["advice"]; discoveries?: AnalysisRun["discoveries"]; kpis?: AnalysisRun["kpis"]; since?: AnalysisRun["since"] };

/** the "since the last wave" slide, when the run has a previous one to compare with (Phase 8) */
export function waveSlide(run: Pick<RunForDeck, "since">): Extract<DeckSlide, { type: "wave_change" }> | null {
  const c = run.since;
  if (!c) return null;
  const unit = (m: string) => (/share|box/.test(m) ? "%" : "");
  const num = (x: number | null, m: string) => (x === null ? "—" : `${Math.round(x * 10) / 10}${unit(m)}`);
  const kpis = c.kpis.map((k) => ({ name: `${k.name} (${k.measure})`, from: num(k.from, k.measure), to: num(k.to, k.measure), delta: k.delta === null ? "—" : `${k.delta > 0 ? "+" : ""}${Math.round(k.delta * 10) / 10}${/share|box/.test(k.measure) ? " pts" : ""}`, verdict: k.verdict, ...(k.significant !== undefined ? { significant: k.significant } : {}) }));
  const changes = c.findings.filter((f) => f.change !== "same").slice(0, 6).map((f) => `${f.change === "new" ? "New" : f.change === "stronger" ? "Stronger" : f.change === "weaker" ? "Weaker" : "Reversed"}: ${strip(f.headline)}`);
  const verdicts = c.verdicts.map((v) => `${v.label}: ${VERDICT_WORD[v.from]} → ${VERDICT_WORD[v.to]}`);
  return { type: "wave_change", title: "Since the last wave", since: `vs ${c.previous.computedAt.slice(0, 10)} (${c.previous.n} completes → now)`, kpis, changes, verdicts };
}

const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);
const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** a headline without its test parenthesis: "SAT by Gender: a strong difference (Welch's t-test, p < .001, d = 1.01)." → "SAT by Gender: a strong difference" */
const strip = (s: string) => s.replace(/\s*\([^()]*\bp\s*[<=][^()]*\)\.?$/, "").replace(/\.$/, "");
const VERDICT_WORD: Record<HypothesisVerdict["verdict"], string> = { supported: "supported", not_supported: "not supported", mixed: "mixed", inconclusive: "inconclusive", untested: "untested" };
const STRENGTH_WORD: Record<Finding["strength"], string> = { strong: "a strong effect", moderate: "a moderate effect", weak: "a small effect", none: "no effect" };

/** the one line that says why a finding matters, from what it serves */
function soWhatFor(def: SurveyDefinition, f: Finding, verdicts: HypothesisVerdict[]): string {
  const h = f.hypotheses.map((l) => verdicts.find((v) => v.label === l)).find(Boolean);
  const objective = def.research?.objective ? ` — the objective was: ${short(def.research.objective, 90)}` : "";
  if (f.evidence.adjusted && f.significant && !f.evidence.adjusted.significant) return `Read with caution: significant on its own, this does not hold once the ${CORRECTION_WORDS[f.evidence.adjusted.method]} correction for the family of tests is applied.`;
  const weight = f.strength === "strong" || f.strength === "moderate" ? `${STRENGTH_WORD[f.strength]}, so it is a difference worth acting on` : f.strength === "weak" ? "a small effect — real, but modest in size" : "no measurable effect";
  if (h) return `This is the evidence for ${h.label} (“${short(h.text, 80)}”), which is ${VERDICT_WORD[h.verdict]} overall${f.significant ? `; ${weight}` : "; this test did not reach significance"}.`;
  if (f.kind === "segment") return "The plan did not test this pair; it was found by looking at every outcome by every demographic and holds after correction.";
  if (f.kind === "trend") return "A move across the waves of fieldwork, corrected for the number of outcomes looked at.";
  if (f.significant) return `${STRENGTH_WORD[f.strength][0].toUpperCase()}${STRENGTH_WORD[f.strength].slice(1)} on ${f.evidence.n} respondents${objective}.`;
  return `Not significant on ${f.evidence.n} respondents — no difference to report here${objective}.`;
}

/** the groups highest first, so "who differs" reads top to bottom */
const groupsOf = (f: Finding) => [...(f.evidence.groups ?? [])].filter((g) => g.mean != null).sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0)).map((g) => ({ label: g.label, value: fmt(g.mean), n: g.n }));

/** The deck from a run: the story in its fixed order, every sentence from the run. */
export function deckFromRun(def: SurveyDefinition, run: RunForDeck, opts: DeckOptions = {}): DeckDefinition {
  const audience = opts.audience ?? "client";
  const idFor = opts.analysisIdFor ?? ((planned, name) => planned ?? name);
  const narrative = opts.narrative ?? {};
  const date = (opts.date ?? run.computedAt).slice(0, 10);
  const brief = def.research?.brief;
  const client = opts.client ?? brief?.client;
  const title = opts.title ?? `${def.research?.objective ? short(def.research.objective, 70) : def.meta.title} — findings`;
  const subtitle = `${run.n} ${run.environment.toLowerCase()} completes · ${date}${client ? ` · prepared for ${client}` : ""}`;
  const slides: DeckSlide[] = [];
  const analysisIds = new Set<string>();
  const itemOf = (f: Finding) => run.items.find((it) => it.findings.some((x) => x.id === f.id));
  const idOf = (it: RunForDeck["items"][number] | undefined) => (it ? idFor(it.definition.options?.planned ? String(it.definition.options.planned) : undefined, it.definition.name) : undefined);
  const resultOf = (it: RunForDeck["items"][number] | undefined, id: string | undefined) => it?.result ?? (id ? opts.results?.[id] : undefined);
  const chartFor = (it: RunForDeck["items"][number] | undefined, id: string | undefined, titleText: string): ChartSpec => {
    const result = resultOf(it, id);
    const type = it && result ? chooseChart(it.definition, result, { audience })[0]?.type ?? (it.chart ?? "bar_vertical") : (it?.chart ?? "bar_vertical");
    return { type, options: { title: titleText, dataLabels: true } };
  };

  slides.push({ type: "title", title, subtitle, date, ...(client ? { client } : {}), audience });

  /* summary: what we set out to learn, what we found */
  const n = reportNarrative(def, run);
  const sig = run.findings.filter((f) => f.significant && f.kind !== "inconclusive" && f.kind !== "low_base" && !["segment", "anomaly", "trend"].includes(f.kind));
  const bullets = narrative.summary?.length ? narrative.summary : [
    /* Phase 8: the brief's question and decision open the summary — the findings are read against them */
    ...(brief?.businessQuestion ? [`Business question: ${short(brief.businessQuestion, 140)}`] : []),
    ...(brief?.decision ? [`Decision this informs: ${short(brief.decision, 140)}`] : []),
    ...(def.research?.objective ? [`Objective: ${short(def.research.objective, 140)}`] : []),
    ...run.verdicts.map((v) => `${v.label} ${VERDICT_WORD[v.verdict]}: ${short(v.text, 100)}`),
    ...sig.slice(0, 3).map((f) => strip(f.headline)),
    ...(run.discoveries?.segments.length ? [`Beyond the plan: ${run.discoveries.segments.length} segment difference${run.discoveries.segments.length === 1 ? "" : "s"} the plan did not test`] : []),
  ];
  slides.push({ type: "summary", title: "What we learned", headline: narrative.headline ?? (sig[0] ? strip(sig[0].headline) : n.summary.split(". ")[0]), bullets: bullets.slice(0, 6) });

  /* since the last wave (Phase 8): right after the summary — a tracker's reader asks "what moved?" before "what did we find?" */
  const wave = waveSlide(run);
  if (wave) slides.push(wave);

  /* key findings: one per significant planned finding, strongest first */
  const max = opts.maxFindings ?? 5;
  const keys = sig.slice(0, max);
  if (keys.length) slides.push({ type: "section", title: "What we found", subtitle: `${keys.length} key finding${keys.length === 1 ? "" : "s"}, strongest first` });
  for (const f of keys) {
    const it = itemOf(f); const id = idOf(it);
    if (id) analysisIds.add(id);
    const evidence = `${f.evidence.test ? f.evidence.test.replace(/_/g, " ") : f.analysis.kind}${f.evidence.p != null ? `, ${fmtP(f.evidence.p)}` : ""}${f.evidence.effect ? `, ${f.evidence.effect.name} = ${fmt(f.evidence.effect.value)}` : ""}, n = ${f.evidence.n}${f.evidence.adjusted ? ` · ${CORRECTION_WORDS[f.evidence.adjusted.method]}-adjusted ${fmtP(f.evidence.adjusted.p)}${f.evidence.adjusted.significant ? "" : " (does not hold)"}` : ""}`;
    slides.push({ type: "key_finding", title: strip(f.headline), ...(id ? { analysisId: id } : {}), chart: chartFor(it, id, it?.definition.name ?? f.analysis.name), evidence, soWhat: narrative.soWhat?.[f.id] ?? soWhatFor(def, f, run.verdicts), ...(f.hypotheses[0] ? { hypothesis: f.hypotheses[0] } : {}), significant: f.significant });
  }

  /* segment comparison: the group tests with their means, and the discoveries by segment */
  const segsAll = [...keys.filter((f) => (f.evidence.groups?.length ?? 0) >= 2), ...(run.discoveries?.segments ?? []).filter((f) => (f.evidence.groups?.length ?? 0) >= 2)];
  // four at most on slides; a discovery that did not fit here is shown beyond the plan instead of dropped
  const segs = segsAll.slice(0, 4);
  if (segs.length) slides.push({ type: "section", title: "Who differs", subtitle: "the groups behind the differences" });
  for (const f of segs) {
    const it = itemOf(f); const id = idOf(it);
    const groups = groupsOf(f);
    const hi = groups[0], lo = groups[groups.length - 1];
    slides.push({ type: "segment_comparison", title: strip(f.headline), measure: f.variables[0], ...(id ? { analysisId: id, chart: chartFor(it, id, it?.definition.name ?? f.analysis.name) } : {}), groups, differs: f.significant ? `${hi.label} (${hi.value}) vs ${lo.label} (${lo.value}) — ${STRENGTH_WORD[f.strength]}${f.evidence.pairwise ? `. ${f.evidence.pairwise.summary}` : ""}` : "the groups do not differ significantly" });
  }

  /* statistical highlight: the strongest effects */
  const strong = sig.filter((f) => f.evidence.effect && (f.strength === "strong" || f.strength === "moderate")).slice(0, 2);
  for (const f of strong) {
    slides.push({ type: "statistical_highlight", title: strip(f.headline), stat: `${f.evidence.effect!.name} = ${fmt(f.evidence.effect!.value)}`, label: STRENGTH_WORD[f.strength], test: (f.evidence.test ?? f.analysis.kind).replace(/_/g, " "), p: fmtP(f.evidence.p), n: f.evidence.n, context: `${f.hypotheses.length ? `${f.hypotheses.join(", ")} · ` : ""}${f.evidence.adjusted ? `${CORRECTION_WORDS[f.evidence.adjusted.method]}-adjusted ${fmtP(f.evidence.adjusted.p)} — ${f.evidence.adjusted.significant ? "holds" : "does not hold"}` : "uncorrected"}`, ...(f.evidence.pairwise?.significant.length ? { pairs: f.evidence.pairwise.summary } : {}) });
  }

  /* beyond the plan: the trends and the segment differences not already shown, the anomalies */
  const d = run.discoveries;
  const beyond: DeckSlide[] = [];
  for (const f of [...(d?.trends ?? []), ...(d?.segments ?? []).filter((x) => !segs.includes(x))].slice(0, 3)) beyond.push({ type: "key_finding", title: strip(f.headline), chart: { type: f.kind === "trend" ? "line" : "bar_grouped", options: { title: f.variables.join(" by "), dataLabels: true } }, evidence: `${f.evidence.adjusted ? `${CORRECTION_WORDS[f.evidence.adjusted.method]}-adjusted ${fmtP(f.evidence.adjusted.p)}` : ""}${f.evidence.effect ? `, ${f.evidence.effect.name} = ${fmt(f.evidence.effect.value)}` : ""}, n = ${f.evidence.n}`.replace(/^, /, ""), soWhat: soWhatFor(def, f, run.verdicts), significant: f.significant, beyond: true });
  if (d?.anomalies.length) beyond.push({ type: "caveats", title: "Data anomalies", bullets: d.anomalies.slice(0, 6).map((f) => f.headline) });
  if (beyond.length && d) slides.push({ type: "section", title: "Beyond the plan", subtitle: d.summary }, ...beyond);

  /* implications: the verdicts against the design */
  const implications = narrative.implications?.length ? narrative.implications : run.verdicts.map((v) => {
    const lead = `${v.label} (${short(v.text, 70)}) is ${VERDICT_WORD[v.verdict]}`;
    switch (v.verdict) {
      case "supported": return `${lead}: the design's expectation holds — ${short(strip(v.findings.find((f) => f.significant)?.headline ?? v.reason), 110)}${v.corrected ? `; ${v.corrected.note}` : ""}.`;
      case "not_supported": return `${lead}: the expectation did not hold in this sample — ${short(strip(v.reason), 110)}.`;
      case "mixed": return `${lead}: the evidence points both ways — ${short(strip(v.reason), 120)}.`;
      case "inconclusive": return `${lead}: ${short(v.reason, 120)}.`;
      default: return `${lead}: no analysis in the plan serves it, so the data says nothing about it yet.`;
    }
  });
  if (implications.length) slides.push({ type: "implications", title: "What it means", bullets: implications.slice(0, 7) });

  /* recommendations: the next steps the evidence calls for */
  const recs = narrative.recommendations?.length ? narrative.recommendations : [
    ...(keys[0] ? [`Lead the story with the strongest finding: ${short(strip(keys[0].headline), 100)}.`] : []),
    ...run.findings.filter((f) => f.significant && f.evidence.adjusted && !f.evidence.adjusted.significant).slice(0, 2).map((f) => `Treat “${short(strip(f.headline), 70)}” with caution — it does not hold once corrected for the family of tests.`),
    ...run.verdicts.filter((v) => v.verdict === "inconclusive").slice(0, 2).map((v) => `Re-run the plan for ${v.label} when the base allows: ${short(v.reason, 90)}`),
    ...run.verdicts.filter((v) => v.verdict === "untested").slice(0, 2).map((v) => `Plan a test for ${v.label} (“${short(v.text, 60)}”) before the next wave — nothing in the plan serves it.`),
    ...(run.discoveries?.segments ?? []).slice(0, 2).map((f) => `Add ${f.variables[0]} by ${f.variables[1]} to the analysis plan — it was found outside it and holds after correction.`),
    ...(run.advice ?? []).filter((a) => a.recommended).slice(0, 2).map((a) => `Re-run ${a.name} as ${a.recommended!.label}: ${a.recommended!.reason}`),
  ];
  if (recs.length) slides.push({ type: "recommendations", title: "What to do next", items: recs.slice(0, 7) });

  /* method and caveats */
  slides.push({ type: "method", title: "How this was done", items: [
    { label: "Completes analysed", value: `${run.n} (${run.environment.toLowerCase()})` },
    { label: "Run", value: `${run.trigger.replace(/_/g, " ")}, ${date}` },
    { label: "Planned analyses", value: `${run.items.filter((it) => !it.adaptedFrom).length}` },
    { label: "Significance", value: `α = 0.05${run.corrections ? `, ${CORRECTION_WORDS[run.corrections.method]} correction by hypothesis family` : ""}` },
    ...(def.research?.population ? [{ label: "Population", value: def.research.population }] : []),
    ...(def.research?.methodology ? [{ label: "Methodology", value: def.research.methodology }] : []),
  ] });
  const caveats = [...run.warnings.slice(0, 4), ...(run.corrections?.families.some((f) => f.lost.length) ? [run.corrections.summary] : []), ...(run.advice ?? []).slice(0, 2).map((a) => a.summary), ...(run.n < 30 ? [`Only ${run.n} completes — nothing here is conclusive yet.`] : [])];
  if (caveats.length) slides.push({ type: "caveats", title: "Caveats", bullets: caveats.slice(0, 6) });

  return { title, subtitle, audience, slides, analysisIds: [...analysisIds] };
}

/** "11 slides: title, summary, 3 key findings, 2 segment comparisons, …" */
export function describeDeck(deck: DeckDefinition): string {
  const counts = new Map<string, number>();
  for (const s of deck.slides) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  return `${deck.slides.length} slides: ${[...counts].map(([k, v]) => `${v > 1 ? `${v} ` : ""}${k.replace(/_/g, " ")}${v > 1 ? "s" : ""}`).join(", ")}`;
}
