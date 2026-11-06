import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyDefinition } from "@rescript/schema";
import { interpretResult, namingContext, reportForExport, researchLabel, researchVariable, variableMetadata, type AnalysisDefinition, type AnalysisResult, type ChartSpec, type DashboardDefinition, type ReportBlock, type ReportDefinition } from "@rescript/analytics";
import { evidenceLine } from "@rescript/analytics";
import { compute, latestRun, type LoadedContext } from "./analytics";
import { planContextFor } from "./analyticsInterpret";
import { loadRows as loadQualRows } from "./qual/qualStore";
import { codingState } from "./qual/qualWorkspace";

/**
 * A SELECTION BECOMES A REPORT (Analytics upgrade M6). The unified selection — catalogue keys from any mode:
 * analyses, charts, hypotheses, themes, findings, whole reports and dashboards — is turned into ONE report
 * definition, the same shape every export and the Reports workspace already read:
 *
 *   an analysis       its chart (the saved styling when there is one, else the engine's recommendation), its first
 *                     table, and — when asked — a text block with the engine's plain reading and its statistics
 *   a chart           the chart as styled, and the same
 *   a hypothesis      a text block: the verdict, the reason, the evidence lines
 *   a finding         a text block: the headline and its evidence
 *   a theme           a text block: the theme and its description
 *   a report          its blocks, appended (its cover becomes a section)
 *   a dashboard       its widgets as blocks (reportForExport)
 *
 * Titles and notes the person wrote in Present override the labels and precede the interpretation. Results are
 * computed through compute(), so an export is never built on stale numbers. Nothing here writes anything.
 */
export interface SelectionItem { key: string; title?: string; note?: string }

export interface SelectionReport { report: ReportDefinition; results: Record<string, AnalysisResult>; skipped: { key: string; reason: string }[] }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let seq = 0;
const bid = (p: string) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

export async function selectionReport(db: SupabaseClient, surveyId: string, ctx: LoadedContext, items: SelectionItem[], opts: { title: string; subtitle?: string; interpretations?: boolean; author?: string }): Promise<SelectionReport> {
  const def = ctx.def as SurveyDefinition;
  const naming = namingContext(def, variableMetadata(def).filter((v) => !v.hidden));
  const blocks: ReportBlock[] = [{ id: "cover", type: "cover", title: opts.title, ...(opts.subtitle ? { subtitle: opts.subtitle } : {}), ...(opts.author ? { author: opts.author } : {}), date: new Date().toISOString().slice(0, 10) }];
  const results: Record<string, AnalysisResult> = {};
  const skipped: SelectionReport["skipped"] = [];
  const analysisCache = new Map<string, { id: string; name: string; definition: AnalysisDefinition } | null>();
  const loadAnalysis = async (id: string) => {
    if (analysisCache.has(id)) return analysisCache.get(id)!;
    const { data } = uuid.test(id) ? await db.from("analytics_analyses").select("id, name, definition").eq("id", id).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle() : { data: null };
    const a = data ? { id: String(data.id), name: String(data.name), definition: data.definition as AnalysisDefinition } : null;
    analysisCache.set(id, a); return a;
  };
  const chartCache = new Map<string, ChartSpec | null>();
  const savedChartFor = async (analysisId: string) => {
    if (chartCache.has(analysisId)) return chartCache.get(analysisId)!;
    const { data } = await db.from("analytics_charts").select("spec").eq("survey_id", surveyId).eq("analysis_id", analysisId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(1);
    const s = (data?.[0]?.spec as ChartSpec | undefined) ?? null; chartCache.set(analysisId, s); return s;
  };
  let run: Awaited<ReturnType<typeof latestRun>> | null | undefined;
  const theRun = async () => (run === undefined ? (run = await latestRun(db, surveyId)) : run);
  let themes: { id: string; name: string; description?: string }[] | undefined;
  const theThemes = async () => themes ?? (themes = await loadQualRows(db, surveyId).then((q) => codingState(q.coding).state.codebook.themes).catch(() => []));

  const addAnalysis = async (a: { id: string; name: string; definition: AnalysisDefinition }, item: SelectionItem, spec?: ChartSpec | null) => {
    if (!results[a.id]) results[a.id] = await compute(db, surveyId, ctx, { ...a.definition, id: a.id, name: a.name });
    const r = results[a.id] as AnalysisResult & { recommendations?: { type: ChartSpec["type"] }[] };
    const label = item.title?.trim() || researchLabel({ ...a.definition, name: a.name }, naming).label;
    const chart = spec ?? (await savedChartFor(a.id)) ?? { type: r.recommendations?.[0]?.type ?? r.recommendedCharts[0] ?? "bar_vertical", options: {} };
    if (item.note?.trim()) blocks.push({ id: bid("n"), type: "text", title: label, markdown: item.note.trim() });
    blocks.push({ id: bid("c"), type: "chart", title: label, analysisId: a.id, chart: { ...chart, options: { ...(chart.options ?? {}), title: (chart.options as { title?: string } | undefined)?.title ?? label } } });
    if (r.tables[0]) blocks.push({ id: bid("t"), type: "table", title: `${label} — table`, analysisId: a.id, tableId: r.tables[0].id });
    if (opts.interpretations !== false) {
      const pc = planContextFor(def, a.definition);
      const i = interpretResult(a.definition, r, { labelOf: (n) => researchVariable(n, naming).researchLabel, hypotheses: pc.hypotheses, reason: pc.reason, objective: def.research?.objective ?? null });
      blocks.push({ id: bid("i"), type: "text", title: "What it means", markdown: `${i.plain.meaning}\n\n${i.plain.why}\n\nStatistics: ${i.statistical.join(" ")}` });
    }
  };

  for (const item of items) {
    const [category, ...rest] = item.key.split(":");
    const id = rest.join(":");
    try {
      if (["crosstabs", "tests", "models", "correlations"].includes(category)) {
        if (id.startsWith("plan:")) { skipped.push({ key: item.key, reason: "planned but not yet created — apply the plan first" }); continue; }
        const a = await loadAnalysis(id); if (!a) { skipped.push({ key: item.key, reason: "the analysis no longer exists" }); continue; }
        await addAnalysis(a, item);
      } else if (category === "charts") {
        const { data: c } = uuid.test(id) ? await db.from("analytics_charts").select("analysis_id, spec, name").eq("id", id).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle() : { data: null };
        if (!c) { skipped.push({ key: item.key, reason: "the chart no longer exists" }); continue; }
        const a = await loadAnalysis(String(c.analysis_id)); if (!a) { skipped.push({ key: item.key, reason: "the chart's analysis no longer exists" }); continue; }
        await addAnalysis(a, { ...item, title: item.title ?? String(c.name) }, c.spec as ChartSpec);
      } else if (category === "hypotheses") {
        const r = await theRun();
        const v = r?.verdicts.find((x) => x.label === id);
        const text = def.research?.hypotheses[Number(id.replace(/^H/, "")) - 1] ?? v?.text ?? id;
        const word = v ? { supported: "Supported", not_supported: "Not supported", mixed: "Partially supported", inconclusive: "Inconclusive", untested: "Not tested" }[v.corrected?.verdict ?? v.verdict] : "Not tested";
        const ev = (v?.findings ?? []).map((f) => `- ${f.headline} (${evidenceLine(f)})`).join("\n");
        blocks.push({ id: bid("h"), type: "text", title: item.title?.trim() || `${id} — ${word}`, markdown: `${text}\n\n**${word}.** ${v?.reason ?? "The plan has not been run for this hypothesis."}${ev ? `\n\n${ev}` : ""}${item.note?.trim() ? `\n\n${item.note.trim()}` : ""}` });
      } else if (category === "findings") {
        const r = await theRun();
        const f = r?.findings.find((x) => x.id === id) ?? [...(r?.discoveries?.segments ?? []), ...(r?.discoveries?.trends ?? []), ...(r?.discoveries?.anomalies ?? [])].find((x) => x.id === id);
        if (!f) { skipped.push({ key: item.key, reason: "the finding is not in the latest run" }); continue; }
        blocks.push({ id: bid("f"), type: "text", title: item.title?.trim() || f.headline.slice(0, 90), markdown: `${f.headline}${f.detail ? `\n\n${f.detail}` : ""}\n\n${evidenceLine(f)}${item.note?.trim() ? `\n\n${item.note.trim()}` : ""}` });
        const aid = f.analysis.id; const a = aid ? await loadAnalysis(aid) : null;
        if (a && !results[a.id]) { results[a.id] = await compute(db, surveyId, ctx, { ...a.definition, id: a.id, name: a.name }); const chart = (await savedChartFor(a.id)) ?? { type: f.chart ?? results[a.id].recommendedCharts[0] ?? "bar_vertical", options: {} }; blocks.push({ id: bid("c"), type: "chart", title: researchLabel({ ...a.definition, name: a.name }, naming).label, analysisId: a.id, chart }); }
      } else if (category === "themes") {
        if (id.startsWith("discovery:")) { const r = await theRun(); const d = r?.discoveries; const all = d ? [...d.segments, ...d.trends, ...d.anomalies] : []; const f = all[Number(id.slice(10))]; if (!f) { skipped.push({ key: item.key, reason: "the discovery is not in the latest run" }); continue; } blocks.push({ id: bid("d"), type: "text", title: item.title?.trim() || f.headline.slice(0, 90), markdown: `${f.headline}\n\n${evidenceLine(f)}` }); continue; }
        const t = (await theThemes()).find((x) => x.id === id);
        if (!t) { skipped.push({ key: item.key, reason: "the theme no longer exists" }); continue; }
        blocks.push({ id: bid("th"), type: "text", title: item.title?.trim() || t.name, markdown: `${t.description?.trim() || "A theme from the qualitative coding."}${item.note?.trim() ? `\n\n${item.note.trim()}` : ""}` });
      } else if (category === "reports" || category === "dashboards") {
        const { data: rep } = uuid.test(id) ? await db.from("analytics_reports").select("name, kind, definition").eq("id", id).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle() : { data: null };
        if (!rep) { skipped.push({ key: item.key, reason: "the report no longer exists" }); continue; }
        const inner = rep.kind === "dashboard" ? reportForExport(rep.definition as DashboardDefinition & { title: string }) : (rep.definition as ReportDefinition);
        blocks.push({ id: bid("s"), type: "section", title: item.title?.trim() || String(rep.name) });
        for (const b of inner.blocks) {
          if (b.type === "cover") continue;
          blocks.push({ ...b, id: bid("r") } as ReportBlock);
          const aid = "analysisId" in b ? b.analysisId : undefined;
          if (aid && !results[aid]) { const a = await loadAnalysis(aid); if (a) results[a.id] = await compute(db, surveyId, ctx, { ...a.definition, id: a.id, name: a.name }); }
        }
      } else skipped.push({ key: item.key, reason: "not something that can be exported" });
    } catch (e) { skipped.push({ key: item.key, reason: (e as Error).message }); }
  }
  return { report: { title: opts.title, ...(opts.subtitle ? { subtitle: opts.subtitle } : {}), mode: "live", blocks }, results, skipped };
}
