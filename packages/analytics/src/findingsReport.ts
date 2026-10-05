import type { SurveyDefinition } from "@rescript/schema";
import type { ChartType, ReportBlock, ReportDefinition } from "./types.js";
import type { AnalysisRun, Finding, HypothesisVerdict, RunItem } from "./findings.js";

/*
 * THE FINDINGS REPORT (research-intelligence Phase 6): the analysis run
 * written up as a report the Analytics workspace already knows how to show,
 * edit, publish and export — a cover, an executive summary in sentences the
 * run supports, the hypotheses with their verdicts, a section per hypothesis
 * with the planned analyses drawn as the chart each result is best shown as
 * and captioned with their findings, the other findings, the methodology
 * and the caveats.
 *
 * Everything in it traces to the run: the narrative is assembled from the
 * verdicts and the findings (their own words, their own numbers), never
 * written freely; the charts are the saved analyses the plan created, so
 * every picture is the same result the researcher opens in Analytics. The
 * report is a DRAFT — the researcher edits it in Reports, publishes it, and
 * exports it through the existing PowerPoint and Excel builders.
 */

export type RunLike = Pick<AnalysisRun, "computedAt" | "trigger" | "environment" | "n" | "findings" | "verdicts" | "warnings"> & { items: (Pick<RunItem, "definition" | "hypotheses" | "chart" | "findings"> & { result?: unknown })[] };

export interface ReportOptions {
  /** the saved analysis (analytics_analyses id) behind a run item — by its planned id or, failing that, its name; undefined leaves the block a placeholder */
  analysisIdFor: (plannedId: string | undefined, name: string) => string | undefined;
  title?: string;
  client?: string;
  author?: string;
  fieldwork?: { from?: string; to?: string };
  sampleFrame?: string;
  weighting?: string;
  /** how many findings outside the hypotheses to draw (default 6) */
  otherFindings?: number;
}

const VERDICT_WORD: Record<HypothesisVerdict["verdict"], string> = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Untested" };
const MILESTONE_WORD: Record<string, string> = { first_results: "first results", halfway: "halfway to target", target_reached: "target reached", field_end: "end of fieldwork", manual: "on request" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const date = (iso: string) => iso.slice(0, 10);

let seq = 0;
const bid = (p: string) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

/* ------------------------------------------------------------ narrative */

/** The executive summary, in sentences the run supports — the verdicts, then the strongest findings in their own words. */
export function reportNarrative(def: SurveyDefinition, run: RunLike): { summary: string; hypotheses: string; caveats: string } {
  const planned = run.items.length;
  const when = `${MILESTONE_WORD[run.trigger] ?? run.trigger}, ${date(run.computedAt)}`;
  const first = `This report reads the ${planned} planned ${planned === 1 ? "analysis" : "analyses"} run on ${run.n} ${run.environment.toLowerCase()} completes (${when}).`;
  const v = run.verdicts;
  const count = (k: HypothesisVerdict["verdict"]) => v.filter((x) => x.verdict === k).length;
  const parts = ([["supported", "supported"], ["not_supported", "not supported"], ["mixed", "mixed"], ["inconclusive", "inconclusive"], ["untested", "untested"]] as const).filter(([k]) => count(k)).map(([k, w]) => `${count(k)} ${w}`);
  const second = v.length ? `Of the ${v.length} ${v.length === 1 ? "hypothesis" : "hypotheses"}, ${parts.join(", ")}.` : "";
  const top = run.findings.filter((f) => f.significant).slice(0, 3);
  const third = top.length ? `The strongest finding: ${top[0].headline}${top.length > 1 ? ` Also: ${top.slice(1).map((f) => f.headline.replace(/\.$/, "")).join("; ")}.` : ""}` : "No planned test reached significance on this base.";
  const small = run.n < 30 ? ` With only ${run.n} completes nothing here is conclusive yet.` : "";
  const summary = [first, second, third].filter(Boolean).join(" ") + small;
  const hypotheses = v.length ? v.map((x) => `**${x.label}** ${x.text} — **${VERDICT_WORD[x.verdict]}.** ${x.reason}`).join("\n\n") : "_No hypotheses are recorded in the research design._";
  const caveats = run.warnings.length ? run.warnings.map((w) => `- ${w}`).join("\n") : "";
  return { summary, hypotheses, caveats };
}

/* ------------------------------------------------------------ the report */

const chartFor = (item: RunLike["items"][number]): ChartType => (item.chart as ChartType | undefined) ?? "bar_vertical";
const captionFor = (item: RunLike["items"][number]): string | undefined => {
  const fs = item.findings.filter((f) => f.kind !== "inconclusive" && f.kind !== "low_base");
  if (!fs.length) return undefined;
  const sig = fs.filter((f) => f.significant);
  return (sig.length ? sig : fs).slice(0, 2).map((f) => f.headline).join(" ");
};

/** The run as a report definition: cover, executive summary, hypotheses, a section per hypothesis with its analyses drawn, other findings, methodology, caveats. */
export function reportFromRun(def: SurveyDefinition, run: RunLike, opts: ReportOptions): ReportDefinition {
  const narrative = reportNarrative(def, run);
  const title = opts.title ?? (def.research?.objective ? `${def.research.objective} — findings` : `${def.meta.title} — findings`);
  const idOf = (item: RunLike["items"][number]) => opts.analysisIdFor(item.definition.options?.planned as string | undefined, item.definition.name);
  const blocks: ReportBlock[] = [];
  blocks.push({ id: bid("cover"), type: "cover", title, subtitle: `${plural(run.n, "complete")} · ${MILESTONE_WORD[run.trigger] ?? run.trigger} · ${date(run.computedAt)}${opts.client ? ` · prepared for ${opts.client}` : ""}`, date: date(run.computedAt), ...(opts.author ? { author: opts.author } : {}) });
  const sigItems = run.items.filter((it) => it.findings.some((f) => f.significant));
  blocks.push({ id: bid("exec"), type: "executive_summary", title: "Executive summary", analysisIds: sigItems.slice(0, 6).map(idOf).filter((x): x is string => !!x), text: narrative.summary });
  if (run.verdicts.length) blocks.push({ id: bid("hyp"), type: "text", title: "The hypotheses", markdown: narrative.hypotheses });
  blocks.push({ id: bid("pb"), type: "page_break" });

  const used = new Set<RunLike["items"][number]>();
  for (const v of run.verdicts) {
    const items = run.items.filter((it) => it.hypotheses.includes(v.label));
    if (!items.length) continue;
    blocks.push({ id: bid("sec"), type: "section", title: `${v.label} — ${v.text}`, subtitle: VERDICT_WORD[v.verdict] });
    blocks.push({ id: bid("why"), type: "text", markdown: v.reason });
    for (const it of items) {
      used.add(it);
      const analysisId = idOf(it);
      blocks.push({ id: bid("ch"), type: "chart", title: it.definition.name, analysisId: analysisId ?? "", chart: { type: chartFor(it), options: { title: it.definition.name, dataLabels: true } }, ...(captionFor(it) ? { caption: captionFor(it) } : {}) });
    }
    const ids = items.map(idOf).filter((x): x is string => !!x);
    if (ids.length) blocks.push({ id: bid("ins"), type: "insights", title: "What the analyses say", analysisIds: ids });
    blocks.push({ id: bid("pb"), type: "page_break" });
  }

  const others = run.items.filter((it) => !used.has(it) && it.findings.some((f) => f.kind !== "inconclusive" && f.kind !== "low_base")).sort((a, b) => Number(b.findings.some((f) => f.significant)) - Number(a.findings.some((f) => f.significant))).slice(0, opts.otherFindings ?? 6);
  if (others.length) {
    blocks.push({ id: bid("sec"), type: "section", title: "Other findings", subtitle: "Planned analyses outside the hypotheses" });
    for (const it of others) blocks.push({ id: bid("ch"), type: "chart", title: it.definition.name, analysisId: idOf(it) ?? "", chart: { type: chartFor(it), options: { title: it.definition.name, dataLabels: true } }, ...(captionFor(it) ? { caption: captionFor(it) } : {}) });
    blocks.push({ id: bid("pb"), type: "page_break" });
  }

  blocks.push({
    id: bid("meth"), type: "methodology", title: "Methodology", includeStandardNotes: true,
    ...(opts.fieldwork ? { fieldwork: opts.fieldwork } : {}), ...(opts.sampleFrame ? { sampleFrame: opts.sampleFrame } : {}), ...(opts.weighting ? { weighting: opts.weighting } : {}),
    items: [
      { label: "Completes analysed", value: `${run.n} (${run.environment.toLowerCase()})` },
      { label: "Analysis run", value: `${MILESTONE_WORD[run.trigger] ?? run.trigger}, ${run.computedAt.slice(0, 16).replace("T", " ")} UTC` },
      { label: "Planned analyses", value: `${run.items.length}, from the research design's analysis plan` },
      { label: "Significance", value: "α = 0.05; effect sizes on their usual scales (Cramér's V, Cohen's d, η², r, β)" },
    ],
  });
  if (narrative.caveats) blocks.push({ id: bid("cav"), type: "text", title: "Caveats", markdown: narrative.caveats });
  return { title, subtitle: `Findings as of ${date(run.computedAt)}`, mode: "live", blocks };
}

/** every saved analysis the report draws — for the export's results map */
export function reportAnalysisIds(report: ReportDefinition): string[] {
  const ids = new Set<string>();
  for (const b of report.blocks) {
    if ((b.type === "chart" || b.type === "table" || b.type === "kpi") && b.analysisId) ids.add(b.analysisId);
    if ((b.type === "insights" || b.type === "executive_summary")) for (const id of b.analysisIds) ids.add(id);
    if (b.type === "panel_grid") for (const p of b.panels) if (p.analysisId) ids.add(p.analysisId);
  }
  return [...ids];
}

/** a finding's own line for a slide or a caption */
export const findingLine = (f: Finding): string => `${f.headline}${f.hypotheses.length ? ` (${f.hypotheses.join(", ")})` : ""}`;
