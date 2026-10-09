import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, PageBreak, LevelFormat } from "docx";
import type { SurveyDefinition, Question } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import { describeHypothesis, structuredHypotheses, explainPlan, planSampleSize, expectedSample, inferRole, measurementOf, listBlocks, placedOrder, stripHtmlText } from "@rescript/engine";
import type { AnalysisResult, ResultTable } from "../types.js";
import type { AnalysisRun, Finding } from "../findings.js";
import { reportNarrative } from "../findingsReport.js";
import { deckFromRun, type DeckOptions, type DeckSlide } from "../deck.js";
import { CORRECTION_WORDS } from "../posthoc.js";
import { seriesForChart } from "./shared.js";

/**
 * WORD DOCUMENTS (Research Engine audit, Phase 5) — the two client-ready
 * documents the audit found missing, on the same `docx` library the
 * questionnaire export uses:
 *
 *   • the RESEARCH PROPOSAL / DESIGN DOCUMENT, from the survey and its
 *     research design alone: objective, research questions, hypotheses
 *     with their readings and the constructs that measure them, the
 *     questionnaire's structure and length, the sample and the base the
 *     plan needs, the analysis plan with its reasons, deliverables,
 *     assumptions and sources;
 *   • the FINDINGS REPORT, from a run: the executive summary, the verdicts,
 *     the findings with their evidence and the groups behind them, what
 *     was found beyond the plan, the data advice, what it means, what to do
 *     next, the method and the caveats.
 *
 * Every sentence is the engine's, from the design or the run; a model's
 * narrative, when one passed the gate, replaces the summary, the
 * implications and the recommendations. Nothing is drawn: a chart's data
 * goes in as a table, which Word readers can read and reuse.
 */
const INK = "16202E", SUBTLE = "5F6B7D", ACCENT = "1D4ED8", RULE = "D5DBE4", HEAD_FILL = "EEF1F6";
const PAGE = { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } };

type Block = Paragraph | Table;
const plain = (s: string | undefined, n = 120) => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const h1 = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true, size: 30, color: INK })], heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 } });
const h2 = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true, size: 24, color: INK })], heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 80 } });
const label = (text: string) => new Paragraph({ children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 16, color: SUBTLE, characterSpacing: 20 })], spacing: { before: 140, after: 40 } });
const body = (text: string) => new Paragraph({ children: [new TextRun({ text, color: INK, size: 21 })], spacing: { after: 80 } });
const lead = (text: string) => new Paragraph({ children: [new TextRun({ text, color: ACCENT, size: 24, bold: true })], spacing: { after: 120 } });
const muted = (text: string) => new Paragraph({ children: [new TextRun({ text, color: SUBTLE, size: 19, italics: true })], spacing: { after: 60 } });
const bullet = (text: string) => new Paragraph({ children: [new TextRun({ text, color: INK, size: 21 })], numbering: { reference: "rs-bullets", level: 0 }, spacing: { after: 50 } });
const numbered = (text: string) => new Paragraph({ children: [new TextRun({ text, color: INK, size: 21 })], numbering: { reference: "rs-numbers", level: 0 }, spacing: { after: 50 } });
const divider = () => new Paragraph({ text: "", spacing: { after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } } });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

function gridTable(head: string[], rows: string[][], widths?: number[]): Table {
  const total = 9000;
  const ws = widths ?? head.map(() => Math.floor(total / head.length));
  const cell = (text: string, w: number, isHead: boolean) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: isHead ? { type: ShadingType.CLEAR, fill: HEAD_FILL, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: isHead, size: 18, color: isHead ? SUBTLE : INK })] })],
  });
  return new Table({ width: { size: total, type: WidthType.DXA }, rows: [new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, ws[i], true)) }), ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, ws[i] ?? ws[0], false)) }))] });
}
const fmtCell = (v: unknown, type?: string, decimals?: number) => v == null ? "" : typeof v === "number" ? (type === "pct" ? `${v.toFixed(decimals ?? 1)}%` : type === "count" ? String(Math.round(v)) : v.toFixed(decimals ?? 2)) : String(v);
function resultTable(t: ResultTable, maxRows = 20): Table {
  const cols = t.columns.filter((c) => !c.suppressed);
  return gridTable(cols.map((c) => c.label), t.rows.slice(0, maxRows).map((r) => cols.map((c) => { const sig = r[`${c.key}__sig`]; const v = fmtCell(r[c.key], (r.__format as string | undefined) ?? c.type, c.decimals); return sig ? `${v} ${sig}` : v; })));
}
const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);

function document(title: string, description: string, children: Block[]): Promise<Buffer> {
  const doc = new Document({
    creator: "Rescript", title, description,
    numbering: { config: [
      { reference: "rs-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: "rs-numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
    ] },
    sections: [{ properties: { page: PAGE }, children }],
  });
  return Packer.toBuffer(doc);
}

function cover(kind: string, title: string, lines: string[]): Block[] {
  return [
    new Paragraph({ children: [new TextRun({ text: kind.toUpperCase(), bold: true, size: 18, color: ACCENT, characterSpacing: 30 })], spacing: { before: 2400, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 44, color: INK })], spacing: { after: 240 } }),
    ...lines.filter(Boolean).map((l) => new Paragraph({ children: [new TextRun({ text: l, size: 22, color: SUBTLE })], spacing: { after: 60 } })),
    pageBreak(),
  ];
}

/* ------------------------------------------------------------ the proposal */

export interface ProposalOptions { client?: string; author?: string; date?: string; title?: string; fieldwork?: { from?: string; to?: string }; deliverables?: string[] }

/** The research proposal / design document, from the survey and its research design. */
export async function buildProposalDocx(def: SurveyDefinition, opts: ProposalOptions = {}): Promise<Buffer> {
  const r = def.research;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const title = opts.title ?? (r?.objective ? plain(r.objective, 90) : def.meta.title);
  const out: Block[] = [];
  out.push(...cover("Research proposal", title, [opts.client ? `Prepared for ${opts.client}` : "", `${date}${opts.author ? ` · ${opts.author}` : ""}`, `Survey: ${def.meta.title}${def.meta.version ? ` v${def.meta.version}` : ""}`]));

  out.push(h1("1. Background and objective"));
  out.push(r?.objective ? lead(r.objective) : muted("No research objective is recorded yet — record it in the research design."));
  if (r?.population) out.push(label("Population"), body(r.population));
  if (r?.methodology) out.push(label("Methodology"), body(r.methodology));
  if (r?.audience?.description) out.push(label("Audience"), body(`${r.audience.description}${r.audience.characteristics.length ? ` — ${r.audience.characteristics.join(", ")}` : ""}${r.audience.literacy ? ` (${r.audience.literacy} language)` : ""}`));

  if (r?.researchQuestions.length || r?.kpis.length) {
    out.push(h1("2. Research questions and KPIs"));
    for (const q of r?.researchQuestions ?? []) out.push(numbered(q));
    if (r?.kpis.length) { out.push(label("KPIs")); out.push(gridTable(["KPI", "Variable", "Measure", "Target"], r.kpis.map((k) => [k.name, k.variable ?? "", k.measure ?? "", k.target != null ? `${k.target}${k.direction ? ` (${k.direction} is better)` : ""}` : k.direction ? `${k.direction} is better` : ""]), [2600, 1800, 2600, 2000])); }
  }

  const hyps = structuredHypotheses(def);
  out.push(h1(`${r?.researchQuestions.length || r?.kpis.length ? 3 : 2}. Hypotheses`));
  if (!hyps.length) out.push(muted("No hypotheses are recorded."));
  else {
    const byId = new Map(def.questions.map((q) => [q.id, q]));
    out.push(gridTable(["", "Hypothesis", "Reading", "Measured by", "Effect"], hyps.map((h) => {
      const qs = [...new Set(Object.values(h.constructs).filter(Boolean).flatMap((c) => c!.questionIds.map((id) => byId.get(id)?.code).filter(Boolean)))];
      const tagged = def.questions.filter((q) => q.analysis?.hypotheses?.includes(h.label)).map((q) => q.code);
      return [h.label, h.text, describeHypothesis(h), [...new Set([...qs, ...tagged])].join(", ") || "—", h.expectedEffect ?? "—"];
    }), [600, 3300, 2300, 1900, 900]));
  }
  if (r?.constructs.length) {
    out.push(h2("Constructs"));
    out.push(gridTable(["Construct", "Role", "Definition", "Questions"], r.constructs.map((c) => [c.name, c.role, c.definition ?? "", c.questionIds.map((id) => def.questions.find((q) => q.id === id)?.code ?? id).join(", ")]), [2200, 1400, 3400, 2000]));
  }

  let n = (r?.researchQuestions.length || r?.kpis.length ? 3 : 2) + 1;
  out.push(h1(`${n++}. Questionnaire`));
  const order = placedOrder(def);
  const asked = def.questions.filter((q) => order.includes(q.id) && !["html", "custom_component", "media_timeline"].includes(q.type));
  const minutes = Math.max(1, Math.round(asked.length / 4));
  out.push(body(`${asked.length} questions in ${listBlocks(def.flow as unknown[]).length} sections — about ${minutes} minute${minutes === 1 ? "" : "s"} at four questions a minute.`));
  for (const b of listBlocks(def.flow as unknown[])) {
    const qs = b.pages.flatMap((p) => p.node.questionIds.map((id: string) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && !["html", "custom_component", "media_timeline"].includes(q.type)));
    if (!qs.length) continue;
    out.push(label(`${b.title ?? "Section"} · ${qs.length} question${qs.length === 1 ? "" : "s"}`));
    out.push(gridTable(["Code", "Question", "Type", "Role"], qs.map((q) => [String(q.code), plain(q.text, 90), `${q.type.replace(/_/g, " ")} (${measurementOf(q)})`, inferRole(def, q)]), [800, 4800, 1900, 1500]));
  }

  out.push(h1(`${n++}. Sample and fieldwork`));
  const size = planSampleSize(def);
  const exp = expectedSample(def);
  if (r?.population) out.push(body(`Population: ${r.population}.`));
  out.push(body(`${r?.sampleSize ? `Target sample: ${r.sampleSize} completes. ` : ""}${exp ? `Expected sample from the ${exp.source}: ${exp.n} — ${exp.note}. ` : ""}${size.minimum ? `The analysis plan needs at least ${size.minimum} completes${size.driver ? ` (${size.driver.title}: ${size.driver.requiredBase.note})` : ""}.` : ""}`.trim() || "No sample size is recorded."));
  if (size.items.length) out.push(gridTable(["Analysis", "Minimum base", "Why"], size.items.slice(0, 12).map((i) => [i.title, String(i.minimum), i.note]), [3400, 1400, 4200]));
  if (opts.fieldwork?.from || opts.fieldwork?.to) out.push(body(`Fieldwork: ${opts.fieldwork.from ?? "—"} to ${opts.fieldwork.to ?? "—"}.`));

  out.push(h1(`${n++}. Analysis plan`));
  const plan = explainPlan(def);
  if (!plan.length) out.push(muted("No analysis follows from the design yet."));
  else out.push(gridTable(["Analysis", "Serves", "Why this method", "Output", "Base"], plan.slice(0, 30).map((x) => [x.title, x.hypotheses.map((h) => h.label).join(", ") || x.objective.slice(0, 40), x.why, x.expectedOutput, `${x.requiredBase.minimum}`]), [2200, 900, 2900, 2200, 800]));

  out.push(h1(`${n++}. Deliverables`));
  for (const d of opts.deliverables ?? ["Topline findings at the first readable base (30 completes), run automatically", "The findings report with the verdict on each hypothesis, at target and at the end of fieldwork", "The findings presentation, with the key findings, who differs, and what to do next", "The data: respondent-level export (SPSS, Excel, CSV) with the variable dictionary"]) out.push(bullet(d));

  if (r?.assumptions.length || r?.sources.length) {
    out.push(h1(`${n++}. Assumptions and sources`));
    for (const a of r?.assumptions ?? []) out.push(bullet(a));
    if (r?.sources.length) { out.push(label("Sources")); for (const s of r.sources) out.push(bullet(s)); }
  }
  return document(`${title} — research proposal`, `Research proposal for ${def.meta.title}`, out);
}

/* ------------------------------------------------------------ the findings report */

export interface FindingsDocxOptions extends Omit<DeckOptions, "results"> {
  author?: string;
  /** the results by analysis id, so the groups and the chart data can be tabled */
  results?: Record<string, AnalysisResult>;
}

type RunForDocx = Parameters<typeof deckFromRun>[1];

/** The findings report as a Word document, from a run. */
export async function buildFindingsDocx(def: SurveyDefinition, run: RunForDocx, opts: FindingsDocxOptions = {}): Promise<Buffer> {
  const deck = deckFromRun(def, run, { ...opts, results: opts.results });
  const narrative = reportNarrative(def, run as never);
  const date = (opts.date ?? run.computedAt).slice(0, 10);
  const title = opts.title ?? deck.title;
  const out: Block[] = [];
  out.push(...cover("Findings report", title, [opts.client ? `Prepared for ${opts.client}` : "", `${run.n} ${run.environment.toLowerCase()} completes · ${run.trigger.replace(/_/g, " ")} · ${date}`, opts.author ?? ""]));

  out.push(h1("Executive summary"));
  const summary = deck.slides.find((s): s is Extract<DeckSlide, { type: "summary" }> => s.type === "summary")!;
  out.push(lead(summary.headline));
  if (opts.narrative?.summary?.length) for (const b of opts.narrative.summary) out.push(bullet(b));
  else out.push(body(narrative.summary));

  out.push(h1("The hypotheses"));
  if (!run.verdicts.length) out.push(muted("No hypotheses are recorded in the research design."));
  else out.push(gridTable(["", "Hypothesis", "Verdict", "Why"], run.verdicts.map((v) => [v.label, v.text, `${v.verdict.replace(/_/g, " ")}${v.corrected ? ` (${v.corrected.verdict.replace(/_/g, " ")} once corrected)` : ""}`, `${v.reason}${v.corrected ? ` ${v.corrected.note}` : ""}`]), [600, 2700, 1500, 4200]));

  out.push(h1("Key findings"));
  const keys = deck.slides.filter((s): s is Extract<DeckSlide, { type: "key_finding" }> => s.type === "key_finding" && !s.beyond);
  if (!keys.length) out.push(muted("No planned test reached significance on this base."));
  for (const k of keys) {
    out.push(h2(k.title));
    out.push(body(k.soWhat));
    out.push(muted(k.evidence));
    const result = k.analysisId ? opts.results?.[k.analysisId] : undefined;
    if (result) {
      const groups = result.tables.find((t) => t.id === "groups");
      if (groups) out.push(resultTable(groups));
      else {
        const series = seriesForChart(result, k.chart);
        if (series.length && series[0].labels.length) out.push(gridTable(["", ...series.map((s) => s.name)], series[0].labels.map((l, i) => [l, ...series.map((s) => fmtCell(s.values[i], s.meta?.pct ? "pct" : "number", 1))])));
        else if (result.tables[0]) out.push(resultTable(result.tables[0]));
      }
    }
  }
  const segs = deck.slides.filter((s): s is Extract<DeckSlide, { type: "segment_comparison" }> => s.type === "segment_comparison");
  if (segs.length) {
    out.push(h1("Who differs"));
    for (const s of segs) { out.push(h2(s.title)); out.push(body(s.differs)); out.push(gridTable(["Group", s.measure, "n"], s.groups.map((g) => [g.label, g.value, String(g.n)]), [4000, 3000, 2000])); }
  }
  const d = run.discoveries;
  if (d && (d.segments.length || d.trends.length || d.anomalies.length)) {
    out.push(h1("Beyond the plan"));
    out.push(body(d.summary));
    for (const f of [...d.segments, ...d.trends] as Finding[]) out.push(bullet(`${f.headline}${f.evidence.groups?.length ? ` — ${f.evidence.groups.map((g) => `${g.label} ${fmt(g.mean)} (n = ${g.n})`).join(", ")}` : ""}`));
    if (d.anomalies.length) { out.push(label("Data anomalies")); for (const f of d.anomalies) out.push(bullet(f.headline)); }
  }
  if (run.advice?.length) {
    out.push(h1("What the data says about the methods"));
    out.push(gridTable(["Analysis", "Checks", "Recommended"], run.advice.map((a) => [a.name, a.checks.map((c) => c.message).join(" "), a.recommended ? `${a.recommended.label} — ${a.recommended.reason}` : "—"]), [2200, 4300, 2500]));
  }
  const imp = deck.slides.find((s): s is Extract<DeckSlide, { type: "implications" }> => s.type === "implications");
  if (imp) { out.push(h1("What it means")); for (const b of imp.bullets) out.push(bullet(b)); }
  const rec = deck.slides.find((s): s is Extract<DeckSlide, { type: "recommendations" }> => s.type === "recommendations");
  if (rec) { out.push(h1("What to do next")); for (const b of rec.items) out.push(numbered(b)); }

  out.push(h1("Method"));
  const method = deck.slides.find((s): s is Extract<DeckSlide, { type: "method" }> => s.type === "method")!;
  out.push(gridTable(["", ""], method.items.map((i) => [i.label, i.value]), [3000, 6000]));
  out.push(body(`Planned analyses: ${run.items.filter((it) => !it.adaptedFrom).map((it) => it.definition.name).join("; ")}.`));
  if (run.corrections) out.push(body(run.corrections.summary));
  const findingsAll = run.findings.filter((f) => f.kind !== "inconclusive" && f.kind !== "low_base");
  if (findingsAll.length) {
    out.push(h2("Every finding"));
    out.push(gridTable(["Finding", "Test", "p", "Adjusted", "Effect", "n"], findingsAll.slice(0, 40).map((f) => [f.headline, (f.evidence.test ?? f.analysis.kind).replace(/_/g, " "), fmtP(f.evidence.p), f.evidence.adjusted ? `${fmtP(f.evidence.adjusted.p)} (${CORRECTION_WORDS[f.evidence.adjusted.method]})` : "", f.evidence.effect ? `${f.evidence.effect.name} = ${fmt(f.evidence.effect.value)}` : "", String(f.evidence.n)]), [3600, 1300, 900, 1300, 1200, 700]));
  }
  const cav = deck.slides.find((s): s is Extract<DeckSlide, { type: "caveats" }> => s.type === "caveats" && s.title === "Caveats");
  if (cav || narrative.caveats) { out.push(h1("Caveats")); for (const b of cav?.bullets ?? run.warnings) out.push(bullet(b)); }
  out.push(divider());
  out.push(muted(`Generated by Rescript from the analysis run of ${date}. Every number in this document is from that run.`));
  return document(`${title} — findings report`, `Findings report for ${def.meta.title}`, out);
}
