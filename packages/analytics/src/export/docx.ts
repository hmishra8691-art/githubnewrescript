import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, PageBreak, LevelFormat, Header, Footer, PageNumber, TabStopType, ImageRun } from "docx";
import type { SurveyDefinition, Question, AnalysisPlan } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import { describeHypothesis, structuredHypotheses, explainPlan, planSampleSize, expectedSample, inferRole, measurementOf, listBlocks, placedOrder, stripHtmlText, conditionSummary, buildAnalysisFramework, METHOD_CHART, MIN_READ_BASE } from "@rescript/engine";
import * as engine from "@rescript/engine";
import type { AnalysisDefinition, AnalysisResult, ResultTable } from "../types.js";
import { advancedNarrative } from "../advancedNarrative.js";
import type { AnalysisRun, Finding } from "../findings.js";
import { reportNarrative } from "../findingsReport.js";
import { deckFromRun, type DeckOptions, type DeckSlide } from "../deck.js";
import { CORRECTION_WORDS } from "../posthoc.js";
import { seriesForChart } from "./shared.js";
import { canonicalJson, hash64 } from "../canonical.js";
import { docStyleOf, type DocStyle, type ThemeSpec, type StructureRequest } from "../reportThemes.js";

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
const PAGE = { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } };

/*
 * THE LOOK (2026-10-18): every helper below reads its colours, fonts and sizes from `S`, the style of the
 * document being built. Without a theme `S` is the documents' standard look, exactly the constants these
 * helpers always had; with one (`opts.theme`) it is that theme's tokens. `themed()` sets it for the
 * synchronous part of a build — every paragraph and table is constructed before the first `await` (the
 * packer's), so two documents built at once cannot see each other's look — and restores it after. Only the
 * look changes: the same helpers are called with the same text in the same order.
 */
let S: DocStyle = docStyleOf(null);
/** an uploaded logo's bytes, for a theme that places it in the page header or on the cover */
export interface DocLogo { data: Uint8Array; type: "png" | "jpg"; width: number; height: number }
const LOGO: { current?: () => ImageRun; cover?: () => ImageRun } = {};
/** the look of research documents: a report theme and, when the theme places one, the uploaded logo */
export interface DocLook { theme?: ThemeSpec | null; logo?: DocLogo | null }
function themed<T>(look: DocLook, build: () => Promise<T>): Promise<T> {
  const prev = S, prevLogo = { ...LOGO };
  S = docStyleOf(look.theme ?? null);
  const place = look.theme?.branding.logo.placement ?? "none";
  const logo = look.logo;
  const run = (h: number) => () => new ImageRun({ type: logo!.type, data: logo!.data, transformation: { width: Math.max(1, Math.round(logo!.width * h / Math.max(1, logo!.height))), height: h } });
  LOGO.current = logo && place === "header" ? run(28) : undefined;
  LOGO.cover = logo && place === "cover" ? run(72) : undefined;
  try { return build(); } finally { S = prev; LOGO.current = prevLogo.current; LOGO.cover = prevLogo.cover; }
}

/** a PNG's or JPEG's own size, read from its header — the logo is placed at its proportions; anything else is not a logo Word can take */
export function logoFromBytes(bytes: Uint8Array): DocLogo | null {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { data: b, type: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { data: b, type: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/*
 * STRUCTURE, ASKED FOR IN WORDS ONLY: "reorganize around the main hypotheses and recommendations" moves whole
 * sections (a Heading 1 and everything under it) — the named ones first, in the order named, the rest after in
 * their own order. The cover stays first. No block is added, dropped or changed.
 */
const STRUCTURE_TITLES: Record<string, RegExp> = {
  summary: /^executive summary$/i, hypotheses: /^the hypotheses$|^hypotheses/i, findings: /^key findings$/i, segments: /^who differs$/i,
  implications: /^what it means$/i, recommendations: /^what to do next$|^recommendations/i, method: /^method/i, caveats: /^caveats$/i,
};
export function reorderSections(blocks: Block[], structure: StructureRequest | null | undefined): Block[] {
  if (!structure?.order.length) return blocks;
  const head: Block[] = [];
  const sections: { title: string; blocks: Block[] }[] = [];
  for (const b of blocks) {
    const t = b instanceof Paragraph ? SECTION_OF.get(b) : undefined;
    if (t !== undefined) sections.push({ title: t, blocks: [b] });
    else if (sections.length) sections[sections.length - 1].blocks.push(b);
    else head.push(b);
  }
  /* a closing note after the last section (the generated-by line) stays last */
  const rank = (title: string) => { const i = structure.order.findIndex((k) => STRUCTURE_TITLES[k]?.test(title)); return i < 0 ? structure.order.length : i; };
  const ordered = sections.map((sec, i) => ({ sec, i, r: rank(sec.title) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.sec);
  return [...head, ...ordered.flatMap((x) => x.blocks)];
}
/** sections kept with their heading, so a structure request can reorder whole sections and nothing else */
const SECTION_OF = new WeakMap<Paragraph, string>();

type Block = Paragraph | Table;
const plain = (s: string | undefined, n = 120) => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const hText = (text: string) => (S.upper ? text.toUpperCase() : text);
const hRun = (text: string, size: number) => new TextRun({ text: hText(text), bold: S.headingBold, size, color: S.heading, ...(S.themed ? { font: S.headingFont } : {}) });
const h1 = (text: string) => { const p = new Paragraph({ children: [hRun(text, S.h1Size)], heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 }, keepNext: true, keepLines: true, ...(S.titleRule ? { border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: S.accent, space: 4 } } } : {}) }); SECTION_OF.set(p, text); return p; };
const h2 = (text: string) => new Paragraph({ children: [hRun(text, S.h2Size)], heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 80 }, keepNext: true, keepLines: true });
const label = (text: string) => new Paragraph({ children: [new TextRun({ text: text.toUpperCase(), bold: true, size: S.themed ? Math.max(14, S.bodySize - 5) : 16, color: S.subtle, characterSpacing: 20 })], spacing: { before: 140, after: 40 }, keepNext: true });
const spacing = (after: number) => (S.themed ? { after: Math.round(after * S.after / 80), line: S.line } : { after });
const body = (text: string) => new Paragraph({ children: [new TextRun({ text, color: S.ink, size: S.bodySize })], spacing: spacing(80) });
const lead = (text: string) => new Paragraph({ children: [new TextRun({ text, color: S.accent, size: S.themed ? S.bodySize + 3 : 24, bold: true })], spacing: spacing(120) });
/* evidence and notes: quiet italics, or — "clear statistical annotations" — upright, darker and full size */
const muted = (text: string) => new Paragraph({ children: [new TextRun({ text, color: S.clearAnnotations ? S.ink : S.subtle, size: S.clearAnnotations ? S.bodySize - 1 : S.themed ? S.bodySize - 2 : 19, italics: !S.clearAnnotations })], spacing: spacing(60) });
const bullet = (text: string) => new Paragraph({ children: [new TextRun({ text, color: S.ink, size: S.bodySize })], numbering: { reference: "rs-bullets", level: 0 }, spacing: spacing(50) });
const numbered = (text: string) => new Paragraph({ children: [new TextRun({ text, color: S.ink, size: S.bodySize })], numbering: { reference: "rs-numbers", level: 0 }, spacing: spacing(50) });
const divider = () => new Paragraph({ text: "", spacing: { after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: S.rule, space: 6 } } });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

function gridTable(head: string[], rows: string[][], widths?: number[]): Table {
  const total = 9000;
  const ws = widths ?? head.map(() => Math.floor(total / head.length));
  /* a theme's table formatting: grid (every rule), minimal (rules above and below the header only) or striped (alternate rows tinted) */
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const rule = { style: BorderStyle.SINGLE, size: 6, color: S.rule };
  const minimalHead = { top: { style: BorderStyle.SINGLE, size: 10, color: S.ink }, bottom: rule, left: none, right: none };
  const minimalBody = { top: none, bottom: none, left: none, right: none };
  const cell = (text: string, w: number, isHead: boolean, row = 0) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: isHead ? (S.tableStyle === "minimal" && S.themed && S.headFill === "FFFFFF" ? undefined : { type: ShadingType.CLEAR, fill: S.headFill, color: "auto" }) : S.stripe && row % 2 === 1 ? { type: ShadingType.CLEAR, fill: S.stripe, color: "auto" } : undefined,
    ...(S.themed && S.tableStyle === "minimal" ? { borders: isHead ? minimalHead : minimalBody } : {}),
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: isHead && S.headerBold, size: S.themed ? Math.max(14, S.bodySize - 3) : 18, color: isHead ? S.headText : S.ink })] })],
  });
  /* the header row repeats on every page a table runs onto, and no row is split across a page break (2026-10-17) */
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: ws, rows: [new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, ws[i], true)) }), ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((v, i) => cell(v, ws[i] ?? ws[0], false, ri)) }))] });
}
const fmtCell = (v: unknown, type?: string, decimals?: number) => v == null ? "" : typeof v === "number" ? (type === "pct" ? `${v.toFixed(decimals ?? 1)}%` : type === "count" ? String(Math.round(v)) : v.toFixed(decimals ?? 2)) : String(v);
function resultTable(t: ResultTable, maxRows = 20): Table {
  const cols = t.columns.filter((c) => !c.suppressed);
  return gridTable(cols.map((c) => c.label), t.rows.slice(0, maxRows).map((r) => cols.map((c) => { const sig = r[`${c.key}__sig`]; const v = fmtCell(r[c.key], (r.__format as string | undefined) ?? c.type, c.decimals); return sig ? `${v} ${sig}` : v; })));
}
const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);

/**
 * Every document's frame (2026-10-17): one theme (Calibri body, the heading styles Word's navigation pane
 * and table of contents read), a running header with the document's title and a footer with the page
 * number, so a printed or forwarded page always says what it belongs to.
 */
function document(title: string, description: string, children: Block[], frame: { header?: string; footer?: string } = {}): Promise<Buffer> {
  const small = (text: string) => new TextRun({ text, size: 16, color: S.subtle });
  /* a theme's header and footer words stand beside the document's own: "Confidential · <title>", "<footer> · Prepared for …" */
  const headText = S.header ? `${S.header} · ${frame.header ?? title}` : frame.header ?? title;
  const footText = S.footer ? `${S.footer}${frame.footer ? ` · ${frame.footer}` : ""}` : frame.footer ?? "Rescript";
  const header = new Header({ children: [new Paragraph({ children: [...(LOGO.current ? [LOGO.current(), new TextRun({ text: "  ", size: 16 })] : []), small(headText)], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: S.rule, space: 4 } } })] });
  const footer = new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: PAGE.size.width - PAGE.margin.left - PAGE.margin.right }], children: [small(footText), ...(S.pageNumbers ? [new TextRun({ children: ["\tPage ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: S.subtle })] : [])] })] });
  /* a theme declares its look as STYLES too (Normal's font, Heading 1–2's font, size and colour), so Word's style pane and a re-styled copy carry it */
  const themedStyles = S.themed ? {
    heading1: { run: { font: S.headingFont, size: S.h1Size, bold: S.headingBold, color: S.heading }, paragraph: { spacing: { before: 320, after: 120 } } },
    heading2: { run: { font: S.headingFont, size: S.h2Size, bold: S.headingBold, color: S.heading }, paragraph: { spacing: { before: 220, after: 80 } } },
  } : {};
  const doc = new Document({
    creator: "Rescript", title, description,
    ...(S.page ? { background: { color: S.page } } : {}),
    styles: { default: { document: { run: { font: S.bodyFont, size: S.bodySize, color: S.ink }, ...(S.themed ? { paragraph: { spacing: { line: S.line } } } : {}) }, ...themedStyles } },
    numbering: { config: [
      { reference: "rs-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: "rs-numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
    ] },
    sections: [{ properties: { page: PAGE, titlePage: true }, headers: { default: header }, footers: { default: footer }, children }],
  });
  return Packer.toBuffer(doc);
}

function cover(kind: string, title: string, lines: string[]): Block[] {
  return [
    ...(LOGO.cover ? [new Paragraph({ children: [LOGO.cover()], spacing: { before: 600, after: 0 } })] : []),
    new Paragraph({ children: [new TextRun({ text: kind.toUpperCase(), bold: true, size: 18, color: S.accent, characterSpacing: 30 })], spacing: { before: LOGO.cover ? 1600 : 2400, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 44, color: S.heading, ...(S.themed ? { font: S.headingFont } : {}) })], spacing: { after: 240 } }),
    ...lines.filter(Boolean).map((l) => new Paragraph({ children: [new TextRun({ text: l, size: 22, color: S.subtle })], spacing: { after: 60 } })),
    pageBreak(),
  ];
}

/* ------------------------------------------------------------ design facts (DOC-02 / DOC-03) */

/**
 * What the definition says about WHO is asked and HOW MANY, read deterministically so the
 * proposal and the statistical analysis plan print the same facts: the quotas as a sampling
 * design, the screening and termination logic, the consent the questionnaire carries.
 * Nothing is invented — what the definition does not say is reported as not defined.
 */
export interface QuotaDesignRow { quota: string; mode: string; cell: string; who: string; limit: string; target: string; onFull: string }
export function samplingDesign(def: SurveyDefinition): QuotaDesignRow[] {
  const rows: QuotaDesignRow[] = [];
  for (const q of def.quotas ?? []) {
    const onFull = q.onFull?.kind === "redirect" ? "redirect" : q.onFull?.kind === "flag" ? "flag" : q.onFull?.kind === "warn" ? "warn" : "close (screen out)";
    for (const c of q.cells) rows.push({
      quota: q.name, mode: q.mode === "soft" ? "soft" : "hard", cell: c.label, who: conditionSummary(def, c.when) || "everyone",
      limit: c.limitType === "percent" ? `${c.limit}%${q.targetTotal ? ` of ${q.targetTotal}` : ""}` : String(c.limit),
      target: c.target != null ? (c.limitType === "percent" ? `${c.target}%` : String(c.target)) : "—", onFull,
    });
  }
  return rows;
}

export interface ScreeningRule { where: string; condition: string; outcome: string }
const OUTCOME_WORDS: Record<string, string> = { screened: "screened out", quota_full: "quota full", terminated: "terminated", complete: "complete" };
/** every place the survey sends a respondent out before the end: skip rules to a terminate/ending, branches that end, quota checks, failed attention checks */
export function screeningRules(def: SurveyDefinition): ScreeningRule[] {
  const out: ScreeningRule[] = [];
  for (const q of def.questions) {
    for (const r of q.skipLogic ?? []) {
      const t = r.target;
      const ends = t.kind === "terminate" || (t.kind === "end" && t.status && t.status !== "complete");
      if (ends) out.push({ where: `${q.code} — ${plain(q.text, 70)}`, condition: conditionSummary(def, r.when) || "always", outcome: OUTCOME_WORDS[t.status ?? "terminated"] ?? "terminated" });
    }
    if (q.settings?.onFail === "terminate") out.push({ where: `${q.code} — ${plain(q.text, 70)}`, condition: "the attention check is failed", outcome: "terminated" });
  }
  const endsOut = (nodes: unknown[]): string | null => {
    for (const n of nodes as Record<string, unknown>[]) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "end" && n.status && n.status !== "complete") return OUTCOME_WORDS[String(n.status)] ?? "terminated";
      for (const k of ["children", "otherwise"]) if (Array.isArray(n[k])) { const e = endsOut(n[k] as unknown[]); if (e) return e; }
      if (Array.isArray(n.branches)) for (const b of n.branches as { children?: unknown[] }[]) { const e = endsOut(b.children ?? []); if (e) return e; }
    }
    return null;
  };
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as Record<string, unknown>[]) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "branch" && Array.isArray(n.branches)) for (const b of n.branches as { label?: string; when: never; children?: unknown[] }[]) { const e = endsOut(b.children ?? []); if (e) out.push({ where: `Flow — ${(n.title as string | undefined) ?? "branch"}${b.label ? ` · ${b.label}` : ""}`, condition: conditionSummary(def, b.when) || "always", outcome: e }); }
      if (n.type === "quota_check") {
        const kind = (n.onFull as { kind?: string } | undefined)?.kind ?? "terminate";
        if (kind !== "continue") out.push({ where: "Flow — quota check", condition: `a quota is full (${((n.quotaIds as string[]) ?? []).map((id) => def.quotas?.find((q) => q.id === id)?.name ?? id).join(", ") || "all quotas"})`, outcome: kind === "redirect" ? "redirected" : kind === "flag" ? "flagged" : "quota full" });
      }
      for (const k of ["children", "otherwise"]) if (Array.isArray(n[k])) walk(n[k] as unknown[]);
      if (Array.isArray(n.branches)) for (const b of n.branches as { children?: unknown[] }[]) walk(b.children ?? []);
    }
  };
  walk(def.flow as unknown[]);
  return out;
}

/** the questionnaire's own consent statement (an item whose wording asks for consent), else null */
export function consentOf(def: SurveyDefinition): { code: string; text: string; options: string[] } | null {
  for (const q of def.questions) {
    const text = plain(q.text, 600);
    if (/\b(?:consent|agree to (?:take part|participate)|willing to participate|privacy (?:notice|policy)|terms and conditions)\b/i.test(text)) return { code: String(q.code), text, options: (q.options ?? []).map((o) => plain(o.label, 60)).filter(Boolean) };
  }
  return null;
}

/** the stamp both documents carry: the survey, its version, and a hash of the definition they were read from (DOC-13) */
export function definitionStamp(def: SurveyDefinition): { hash: string; text: string } {
  const { updatedAt: _u, ...meta } = def.meta as Record<string, unknown>;
  const hash = hash64(canonicalJson({ ...def, meta }));
  return { hash, text: `Definition ${hash} · survey ${def.meta.code ?? def.meta.id} v${def.meta.version ?? "1.0"}` };
}

/** what each planned method is, in the words of a methods section */
export const METHOD_WORDS: Record<string, string> = {
  frequencies: "Frequency distribution", mean: "Mean with confidence interval", median: "Median and quartiles", top_box: "Top-box share", nps: "Net Promoter Score (promoters − detractors)",
  crosstab: "Crosstabulation (column percentages; significance between columns)", chi_square: "Pearson chi-square test of independence", t_test: "Independent-samples t-test (Welch)", anova: "One-way analysis of variance",
  mann_whitney: "Mann–Whitney U test", kruskal_wallis: "Kruskal–Wallis test", correlation: "Correlation", regression: "Linear regression", logistic_regression: "Logistic regression",
  factor: "Exploratory factor analysis", reliability: "Scale reliability (Cronbach's α)", cluster: "Cluster analysis", conjoint_utilities: "Conjoint part-worth utilities", maxdiff_scores: "MaxDiff scores",
  turf: "TURF reach analysis", driver_analysis: "Key-driver analysis", text_themes: "Open-text theme coding", ranking_scores: "Ranking scores", allocation_shares: "Allocation shares",
  pricing: "Price sensitivity analysis", brand_funnel: "Brand funnel",
};

/** the building blocks the sibling documents (the statistical analysis plan) are made of */
export const docKit = { h1, h2, label, body, lead, muted, bullet, numbered, divider, pageBreak, gridTable, cover, document, plain, fmt, fmtP, themed };
export type DocBlock = Block;

/* ------------------------------------------------------------ the proposal */

export interface ProposalOptions {
  client?: string; author?: string; date?: string; title?: string; fieldwork?: { from?: string; to?: string }; deliverables?: string[];
  /**
   * `research_plan` (2026-10-17): the WORD RESEARCH PLAN — the same document, read from the same design, with
   * what a plan adds to a proposal: an executive summary, the hypotheses' rationale and the conceptual
   * framework, the methodology, how each question serves the objectives and hypotheses (the traceability
   * matrix), the variables and their scales, the hypothesis tests, the proposed tables and charts, the
   * interpretation framework, the quality-control requirements and the limitations. One exporter, two editions.
   */
  edition?: "proposal" | "research_plan";
  /** the report theme (2026-10-18): the look only — the text, numbering and tables are the same with or without one */
  theme?: ThemeSpec | null;
  logo?: DocLogo | null;
}

/** The research proposal / design document, from the survey and its research design. */
export function buildProposalDocx(def: SurveyDefinition, opts: ProposalOptions = {}): Promise<Buffer> {
  return themed(opts, () => proposalDocx(def, opts));
}
async function proposalDocx(def: SurveyDefinition, opts: ProposalOptions): Promise<Buffer> {
  const r = def.research;
  const b = r?.brief;
  const client = opts.client ?? b?.client;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const title = opts.title ?? (r?.objective ? plain(r.objective, 90) : b?.businessQuestion ? plain(b.businessQuestion, 90) : def.meta.title);
  const out: Block[] = [];
  const rp = opts.edition === "research_plan";
  /* numbered sections: a running counter, so the proposal's numbers are what they always were and the plan's extra sections number themselves */
  let sec = 0;
  const H1 = (t: string) => h1(`${++sec}. ${t}`);
  out.push(...cover(rp ? "Research plan" : "Research proposal", title, [client ? `Prepared for ${client}` : "", `${date}${opts.author ? ` · ${opts.author}` : ""}`, `Survey: ${def.meta.title}${rp && def.meta.code ? ` (${def.meta.code})` : ""}${def.meta.version ? ` v${def.meta.version}` : ""}`, b?.deadline ? `Findings due ${b.deadline}` : ""]));
  const rpPlan = rp ? (r?.analysisPlan ?? buildAnalysisFramework(def, { now: "" })) : null;
  /* the trace reads the plan this document prints — the saved one, else the one derived from the design — so its rows and the tests section agree */
  const trace = rp ? traceOf(r?.analysisPlan ? def : { ...def, research: { ...r!, analysisPlan: rpPlan! } } as SurveyDefinition) : null;
  if (rp) out.push(...researchPlanSummary(def, H1, rpPlan!, trace));

  out.push(H1(rp ? "Business context, problem and objectives" : "Background and objective"));
  /* Phase 8: the brief opens the document — the client's question and the decision are what the objective serves */
  if (b?.background) out.push(label("Background"), body(b.background));
  if (b?.businessQuestion) out.push(label("Business question"), lead(b.businessQuestion));
  if (b?.decision) out.push(label("Decision this research informs"), body(b.decision));
  if (b?.stakeholders.length) out.push(label("Stakeholders"), body(b.stakeholders.join(", ")));
  if (b?.businessQuestion || b?.decision || b?.background) out.push(label("Research objective"));
  out.push(r?.objective ? lead(r.objective) : muted("No research objective is recorded yet — record it in the research design."));
  if (r?.population) out.push(label("Population"), body(r.population));
  if (r?.methodology) out.push(label("Methodology"), body(r.methodology));
  if (r?.audience?.description) out.push(label("Audience"), body(`${r.audience.description}${r.audience.characteristics.length ? ` — ${r.audience.characteristics.join(", ")}` : ""}${r.audience.literacy ? ` (${r.audience.literacy} language)` : ""}`));

  if (r?.researchQuestions.length || r?.kpis.length) {
    out.push(H1("Research questions and KPIs"));
    for (const q of r?.researchQuestions ?? []) out.push(numbered(q));
    if (r?.kpis.length) { out.push(label("KPIs")); out.push(gridTable(["KPI", "Variable", "Measure", "Target"], r.kpis.map((k) => [k.name, k.variable ?? "", k.measure ?? "", k.target != null ? `${k.target}${k.direction ? ` (${k.direction} is better)` : ""}` : k.direction ? `${k.direction} is better` : ""]), [2600, 1800, 2600, 2000])); }
  }

  const hyps = structuredHypotheses(def);
  out.push(H1(rp ? "Hypotheses and rationale" : "Hypotheses"));
  if (!hyps.length) out.push(muted("No hypotheses are recorded."));
  else if (rp) out.push(...hypothesisRationale(def, hyps, trace));
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

  if (rp) out.push(...conceptualFramework(def, hyps, H1));
  out.push(H1(rp ? "Questionnaire and interview guide" : "Questionnaire"));
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

  if (rp) out.push(...traceabilitySection(def, H1, trace), ...variablesSection(def, H1));
  out.push(H1(rp ? "Population, sampling and fieldwork" : "Sample and fieldwork"));
  const size = planSampleSize(def);
  const exp = expectedSample(def);
  if (r?.population) out.push(body(`Population: ${r.population}.`));
  out.push(body(`${r?.sampleSize ? `Target sample: ${r.sampleSize} completes. ` : ""}${exp ? `Expected sample from the ${exp.source}: ${exp.n} — ${exp.note}. ` : ""}${size.minimum ? `The analysis plan needs at least ${size.minimum} completes${size.driver ? ` (${size.driver.title}: ${size.driver.requiredBase.note})` : ""}.` : ""}`.trim() || "No sample size is recorded."));
  if (size.items.length) out.push(gridTable(["Analysis", "Minimum base", "Why"], size.items.slice(0, 12).map((i) => [i.title, String(i.minimum), i.note]), [3400, 1400, 4200]));
  if (opts.fieldwork?.from || opts.fieldwork?.to) out.push(body(`Fieldwork: ${opts.fieldwork.from ?? "—"} to ${opts.fieldwork.to ?? "—"}.`));
  if (b?.deadline) out.push(body(`Findings due: ${b.deadline}.`));

  /* DOC-02: the sampling design, the screening, the timeline — each from the definition, each saying so when the definition is silent */
  out.push(h2("Sampling design"));
  const design = samplingDesign(def);
  if (!design.length) out.push(muted("No quotas are defined: respondents are taken as they come (natural fall-out), so the sample is not controlled for its composition. Define quotas — or weight the data to known population targets — if the findings are to be read as representative."));
  else {
    const hard = (def.quotas ?? []).filter((q) => q.mode !== "soft").length;
    out.push(body(`Quota sample: ${(def.quotas ?? []).length} quota${(def.quotas ?? []).length === 1 ? "" : "s"} (${hard} hard, ${(def.quotas ?? []).length - hard} soft), ${design.length} cell${design.length === 1 ? "" : "s"}. A hard quota closes a cell once its maximum is reached; the respondent is screened out and the interview is not counted.`));
    out.push(gridTable(["Quota", "Cell", "Who", "Maximum", "Target", "When full"], design.map((d) => [`${d.quota} (${d.mode})`, d.cell, d.who, d.limit, d.target, d.onFull]), [1900, 1500, 2600, 1000, 900, 1100]));
  }
  out.push(h2("Screening and eligibility"));
  if (r?.population) out.push(body(`Eligible population: ${r.population}.`));
  const screens = screeningRules(def);
  const screenerQs = def.questions.filter((q) => inferRole(def, q) === "screening");
  if (screenerQs.length) out.push(body(`Screener questions: ${screenerQs.map((q) => q.code).join(", ")}.`));
  if (!screens.length) out.push(muted("No screening or termination logic is programmed: every respondent who starts the survey is treated as eligible. If the population is narrower than the panel, add screener questions that end the interview for those who do not qualify."));
  else out.push(gridTable(["Where", "When", "What happens"], screens.map((x) => [x.where, x.condition, x.outcome]), [3600, 3600, 1800]));
  out.push(h2("Timeline"));
  const tbd = (v?: string) => v ?? "[to be agreed]";
  out.push(gridTable(["Phase", "Dates", "Notes"], [
    ["Questionnaire sign-off", "[to be agreed]", "Client approves the questionnaire and the research design"],
    ["Programming and testing", "[to be agreed]", `${asked.length} questions; test the survey in the preview and a soft launch before the full field`],
    ["Fieldwork", opts.fieldwork?.from || opts.fieldwork?.to ? `${tbd(opts.fieldwork?.from)} to ${tbd(opts.fieldwork?.to)}` : "[to be agreed]", `${r?.sampleSize ? `Target ${r.sampleSize} completes` : exp ? `Expected ${exp.n} completes` : "Target sample not yet set"}; quality checks run during field`],
    ["Data cleaning and delivery of data", "[to be agreed]", "After the close of fieldwork: removal of flagged interviews, final dataset"],
    ["Analysis and findings", b?.deadline ? `by ${b.deadline}` : "[to be agreed]", "Topline at the first readable base, the findings report at target"],
  ], [2600, 2200, 4200]));
  if (!(opts.fieldwork?.from || opts.fieldwork?.to) && !b?.deadline) out.push(muted("The survey has no fieldwork dates and the brief no deadline, so the dates above are placeholders to fill in."));

  const savedPlan = !!r?.analysisPlan;
  out.push(H1(`Analysis plan${savedPlan ? "" : " (derived from the design — not yet saved)"}`));
  if (!savedPlan) out.push(muted("No analysis plan has been saved for this survey. The analyses below were derived by the engine from the questionnaire and the hypotheses; they change when the questionnaire does. Save the plan in the Analysis tab to fix it."));
  const plan = explainPlan(def);
  if (!plan.length) out.push(muted("No analysis follows from the design yet."));
  else out.push(gridTable(["Analysis", "Serves", "Why this method", "Output", "Base"], plan.slice(0, 30).map((x) => [x.title, x.hypotheses.map((h) => h.label).join(", ") || x.objective.slice(0, 40), x.why, x.expectedOutput, `${x.requiredBase.minimum}`]), [2200, 900, 2900, 2200, 800]));

  if (rp) out.push(...hypothesisTests(def, H1, rpPlan!, hyps), ...tablesAndCharts(def, H1, rpPlan!), ...interpretationFramework(def, H1, rpPlan!), ...qualityControl(def, H1));
  out.push(H1("Deliverables"));
  for (const d of opts.deliverables ?? (b?.deliverables.length ? b.deliverables : null) ?? ["Topline findings at the first readable base (30 completes), run automatically", "The findings report with the verdict on each hypothesis, at target and at the end of fieldwork", "The findings presentation, with the key findings, who differs, and what to do next", "The data: respondent-level export (SPSS, Excel, CSV) with the variable dictionary"]) out.push(bullet(d));

  if (rp) out.push(...limitationsSection(def, H1, trace));
  else if (r?.assumptions.length || r?.sources.length) {
    out.push(H1("Assumptions and sources"));
    for (const a of r?.assumptions ?? []) out.push(bullet(a));
    if (r?.sources.length) { out.push(label("Sources")); for (const s of r.sources) out.push(bullet(s)); }
  }

  /* DOC-02: ethics and consent — the questionnaire's own consent statement, else the standard one, labelled as such */
  out.push(H1("Ethics, consent and data protection"));
  const consent = consentOf(def);
  if (consent) {
    out.push(body(`The questionnaire carries its own consent statement (${consent.code}): “${consent.text}”${consent.options.length ? ` Respondents answer: ${consent.options.join(" / ")}.` : ""}`));
  } else {
    out.push(muted("The questionnaire has no consent statement yet; the standard statement below applies and a consent page should be added before fieldwork."));
  }
  for (const line of [
    "Participation is voluntary. Respondents are told who is conducting the research, its subject and the approximate length before they begin, and may stop at any time without giving a reason.",
    "Answers are confidential and reported only in aggregate; no individual respondent is identified to the client unless they have separately agreed to it.",
    "Personal data are collected only where the research needs them, stored securely, kept for no longer than the project requires and handled in line with the applicable data-protection law (GDPR where it applies) and the ESOMAR/MRS codes of conduct.",
    ...(/\b(?:child|children|minor|teen|under\s*1[68]|aged?\s*1[0-7]\b)/i.test(`${r?.population ?? ""} ${r?.audience?.description ?? ""}`) ? ["The population includes minors: verifiable consent from a parent or guardian is obtained before the child is interviewed."] : []),
  ]) out.push(bullet(line));
  out.push(divider());
  out.push(muted(`${definitionStamp(def).text} · generated ${date}`));
  return document(`${title} — ${rp ? "research plan" : "research proposal"}`, `${rp ? "Research plan" : "Research proposal"} for ${def.meta.title}`, out, { header: `${def.meta.title}${def.meta.code ? ` (${def.meta.code})` : ""} — ${rp ? "Research plan" : "Research proposal"}`, footer: `${client ? `Prepared for ${client} · ` : ""}${date}` });
}

/** The Word research plan: the proposal's research-plan edition (one exporter — see `ProposalOptions.edition`). */
export function buildResearchPlanDocx(def: SurveyDefinition, opts: Omit<ProposalOptions, "edition"> = {}): Promise<Buffer> {
  return buildProposalDocx(def, { ...opts, edition: "research_plan" });
}

/* ------------------------------------------------------------ the research plan edition (2026-10-17) */

/**
 * D's traceability matrix (`researchTraceability`, engine), read through the namespace so this document
 * builds — with its own question mapping — on an engine that does not export it yet. Everything in it
 * comes from the study as configured; nothing is a finding.
 */
interface TraceLike {
  rows: { id: string; kind: string; statement: string; status: string; interpretation: string; questions: { code: string }[]; analyses: { title: string }[]; constructs: { name: string; role: string; measured: boolean }[]; visualisations: string[]; limitations: string[]; reading?: string; objective?: string }[];
  questions: { id: string; code: string; variable: string; text: string; level: string; role: string; serves: string[] }[];
  gaps: { severity: string; message: string; suggestion?: string }[];
  summary: string;
}
interface Trace { t: TraceLike; statusWords: Record<string, string> }
function traceOf(def: SurveyDefinition): Trace | null {
  const e = engine as unknown as Record<string, unknown>;
  const fn = e.researchTraceability;
  if (typeof fn !== "function") return null;
  try {
    const t = (fn as (d: SurveyDefinition) => TraceLike)(def);
    if (!t || !Array.isArray(t.rows) || !Array.isArray(t.questions)) return null;
    return { t, statusWords: (e.TRACE_STATUS_WORDS as Record<string, string> | undefined) ?? {} };
  } catch { return null; }
}

type H1Fn = (t: string) => Paragraph;
type Hyp = ReturnType<typeof structuredHypotheses>[number];
const mWords = (m: string) => METHOD_WORDS[m] ?? m.replace(/_/g, " ");
const chartWords = (c: string | undefined) => (c ? c.replace(/_/g, " ") : "table");
const NOT_DATA = new Set(["html", "custom_component", "media_timeline"]);
const dataQuestions = (def: SurveyDefinition): Question[] => { const order = placedOrder(def); return def.questions.filter((q) => order.includes(q.id) && !NOT_DATA.has(q.type)); };
const planItems = (plan: AnalysisPlan) => [...plan.tests.map((t) => ({ id: t.id, method: t.method as string, hypotheses: t.hypotheses, reads: [t.outcome, t.groupBy, ...t.variables, t.moderator, t.mediator].filter((v): v is string => !!v) })), ...plan.crosstabs.map((x) => ({ id: x.id, method: "crosstab", hypotheses: x.hypotheses, reads: [...x.rows, ...x.columns] }))];
const readsQuestion = (q: Question, names: readonly string[]) => names.includes(q.variableName) || names.includes(String(q.code)) || names.includes(q.id);

/** which hypotheses (and plan items) each question serves — from the trace when there is one, else from the design's own links */
function questionServes(def: SurveyDefinition, plan: AnalysisPlan, trace: Trace | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (trace) {
    /* the matrix lists what a question serves by hypothesis, research question and construct, and by plan item id — a reader gets the first three and a count of the rest */
    const titles = new Map(planItems(plan).map((it) => [it.id, it]));
    for (const q of trace.t.questions) {
      const named = q.serves.filter((x) => !titles.has(x));
      const items = q.serves.filter((x) => titles.has(x)).length;
      out.set(q.id, [...named, ...(items ? [`${items} planned ${items === 1 ? "analysis" : "analyses"}`] : [])]);
    }
    return out;
  }
  const hyps = structuredHypotheses(def);
  for (const q of dataQuestions(def)) {
    const s = new Set<string>(q.analysis?.hypotheses ?? []);
    for (const h of hyps) if (Object.values(h.constructs).some((c) => c?.questionIds.includes(q.id))) s.add(h.label);
    for (const it of planItems(plan)) if (readsQuestion(q, it.reads)) for (const h of it.hypotheses) s.add(h);
    out.set(q.id, [...s].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  }
  return out;
}

function researchPlanSummary(def: SurveyDefinition, H1: H1Fn, plan: AnalysisPlan, trace: Trace | null): Block[] {
  const r = def.research;
  const qs = dataQuestions(def);
  const minutes = Math.max(1, Math.round(qs.length / 4));
  const hyps = structuredHypotheses(def);
  const target = r?.analysisPlan?.sampleSize?.target ?? r?.sampleSize ?? expectedSample(def)?.n;
  const out: Block[] = [H1("Executive summary")];
  out.push(lead(r?.objective ?? r?.brief?.businessQuestion ?? def.meta.title));
  out.push(body(`This plan sets out how “${plain(def.meta.title, 80)}” will answer the objective: ${hyps.length ? `${hyps.length} hypothes${hyps.length === 1 ? "is" : "es"} ` : "no recorded hypotheses (the analysis is exploratory) "}tested through ${plan.tests.length} planned test${plan.tests.length === 1 ? "" : "s"} and ${plan.crosstabs.length} crosstab${plan.crosstabs.length === 1 ? "" : "s"}, on ${target ? `a target of ${target} completes` : "a sample size not yet recorded"}${r?.population ? ` from ${r.population}` : ""}. The questionnaire has ${qs.length} question${qs.length === 1 ? "" : "s"} (about ${minutes} minute${minutes === 1 ? "" : "s"}).`));
  if (hyps.length) { out.push(label("Hypotheses")); for (const h of hyps) out.push(bullet(`${h.label}: ${plain(h.text, 160)}`)); }
  if (trace) {
    const blocking = trace.t.gaps.filter((g) => g.severity === "blocking").length, warn = trace.t.gaps.filter((g) => g.severity === "warning").length;
    out.push(label("Readiness"), body(`${trace.t.summary}${blocking || warn ? ` ${blocking} blocking gap${blocking === 1 ? "" : "s"} and ${warn} warning${warn === 1 ? "" : "s"} are listed under Limitations and recommendations.` : ""}`));
  }
  out.push(muted("No data has been collected for this plan to report on: every statement below is the design, and every hypothesis is untested until the analysis plan runs on the completes."));
  return out;
}

function hypothesisRationale(def: SurveyDefinition, hyps: Hyp[], trace: Trace | null): Block[] {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const rows = hyps.map((h) => {
    const qs = [...new Set(Object.values(h.constructs).filter(Boolean).flatMap((c) => c!.questionIds.map((id) => byId.get(id)?.code).filter(Boolean)))];
    const tagged = def.questions.filter((q) => q.analysis?.hypotheses?.includes(h.label)).map((q) => q.code);
    const sides = [h.independent, h.dependent].filter(Boolean);
    const rationale = h.note ? plain(h.note, 220) : sides.length === 2 ? `Links ${h.independent} to ${h.dependent}${h.moderator ? `, moderated by ${h.moderator}` : ""}${h.mediator ? `, through ${h.mediator}` : ""}. No rationale is recorded — add a note to the hypothesis.` : "No rationale is recorded — add a note to the hypothesis.";
    const row = trace?.t.rows.find((x) => x.id === h.label);
    const status = row ? (trace!.statusWords[row.status] ?? row.status.replace(/_/g, " ")) : "Planned — not yet tested";
    return [h.label, plain(h.text, 200), describeHypothesis(h), rationale, [...new Set([...qs, ...tagged])].join(", ") || "—", status];
  });
  return [gridTable(["", "Hypothesis", "Type and reading", "Rationale", "Measured by", "Status"], rows, [500, 2200, 1600, 2400, 1000, 1300])];
}

function conceptualFramework(def: SurveyDefinition, hyps: Hyp[], H1: H1Fn): Block[] {
  const r = def.research;
  const out: Block[] = [h2("Conceptual framework")];
  const links = hyps.filter((h) => h.independent || h.dependent);
  if (!links.length) out.push(muted("The hypotheses do not name the constructs they link, so no framework can be drawn from them yet."));
  for (const h of links) out.push(bullet(`${h.label}: ${h.independent ?? "?"} → ${h.dependent ?? "?"}${h.moderator ? ` (moderated by ${h.moderator})` : ""}${h.mediator ? ` (through ${h.mediator})` : ""}${h.direction && h.direction !== "none" ? ` · expected ${h.direction}` : ""}`));
  const unlinked = (r?.constructs ?? []).filter((c) => !links.some((h) => [h.independent, h.dependent, h.moderator, h.mediator].some((x) => x && x.toLowerCase() === c.name.toLowerCase())));
  if (unlinked.length) out.push(muted(`Constructs measured but named by no hypothesis: ${unlinked.map((c) => c.name).join(", ")}.`));
  out.push(H1("Methodology"));
  const qs = dataQuestions(def);
  out.push(r?.methodology ? body(r.methodology) : muted("No methodology is recorded in the research design; the default below describes how the survey is programmed. Record the methodology so this section states it."));
  out.push(gridTable(["Aspect", "In this study"], [
    ["Design", r?.methodology ? plain(r.methodology, 120) : "Quantitative, cross-sectional survey (default — not recorded)"],
    ["Data collection", "Self-completion questionnaire programmed and fielded in Rescript"],
    ["Length", `${qs.length} questions in ${listBlocks(def.flow as unknown[]).length} sections, about ${Math.max(1, Math.round(qs.length / 4))} minutes`],
    ["Languages", def.localization?.languages.length ? [def.localization.sourceLanguage, ...def.localization.languages.map((l) => (typeof l === "string" ? l : (l as { code?: string }).code ?? ""))].filter(Boolean).join(", ") : "Source language only"],
  ], [2600, 6400]));
  return out;
}

function codingOf(q: Question, cap = 6): string {
  const o = q.options ?? [];
  if (o.length) return `${o.slice(0, cap).map((x) => `${x.code} = ${plain(x.label, 24)}`).join("; ")}${o.length > cap ? `; … (${o.length} in all)` : ""}`;
  if (/text/.test(q.type)) return "open text";
  if (/numeric|number|slider/.test(q.type)) return "number";
  return q.type.replace(/_/g, " ");
}

function traceabilitySection(def: SurveyDefinition, H1: H1Fn, trace: Trace | null): Block[] {
  const plan = def.research?.analysisPlan ?? buildAnalysisFramework(def, { now: "" });
  const serves = questionServes(def, plan, trace);
  const out: Block[] = [H1("How each question serves the objectives and hypotheses")];
  out.push(body("Every placed question, the hypotheses it serves and its analytic role, read from the research design, the questions' analysis tags and the analysis plan. A question that serves no hypothesis is profiling, screening or descriptive — or a candidate to cut."));
  const qs = dataQuestions(def);
  out.push(gridTable(["Code", "Question", "Variable", "Serves", "Role"], qs.map((q) => {
    const role = inferRole(def, q);
    const s = serves.get(q.id) ?? [];
    return [String(q.code), plain(q.text, 80), q.variableName, s.length ? s.join(", ") : role === "screening" ? "eligibility (screening)" : role === "segmentation" ? "sample profile / segments" : "the objective (descriptive)", role];
  }), [800, 3600, 1500, 1700, 1400]));
  if (trace && trace.t.rows.length) {
    out.push(h2("Traceability matrix"));
    out.push(muted("Objective → hypothesis → constructs → questions → analysis → visualisation → interpretation. Status words describe the plan, never a result."));
    out.push(gridTable(["Hypothesis / question", "Constructs", "Questions", "Analysis", "Chart", "Status"], trace.t.rows.map((row) => [
      `${row.id}: ${plain(row.statement, 110)}`,
      row.constructs.map((c) => `${c.name}${c.measured ? "" : " (not measured)"}`).join(", ") || "—",
      row.questions.map((q) => q.code).join(", ") || "none",
      row.analyses.map((a) => a.title).join("; ") || "none planned",
      row.visualisations.map(chartWords).join(", ") || "—",
      trace.statusWords[row.status] ?? row.status.replace(/_/g, " "),
    ]), [2300, 1400, 900, 2200, 1000, 1200]));
  }
  return out;
}

function variablesSection(def: SurveyDefinition, H1: H1Fn): Block[] {
  const qs = dataQuestions(def);
  return [H1("Variables and scales"), body("The variable each question writes to the dataset, its type, its level of measurement and how its answers are coded — what every table and test in this plan reads."),
    gridTable(["Variable", "Question", "Type", "Level", "Scale / coding"], qs.map((q) => [q.variableName, `${q.code} — ${plain(q.text, 60)}`, q.type.replace(/_/g, " "), measurementOf(q), codingOf(q)]), [1400, 2900, 1300, 1000, 2400])];
}

function hypothesisTests(def: SurveyDefinition, H1: H1Fn, plan: AnalysisPlan, hyps: Hyp[]): Block[] {
  const alpha = plan.alpha ?? 0.05;
  const correction = plan.multipleComparisons ?? "holm";
  const corrWords = (CORRECTION_WORDS as Record<string, string>)[correction] ?? correction;
  const out: Block[] = [H1("Hypothesis tests")];
  out.push(body(`Each hypothesis is decided by the planned analyses that read both of its sides, at α = ${alpha} (two-sided), with ${corrWords} correction within each hypothesis's family of tests${plan.multipleComparisons ? "" : " (default)"}. A result is reported with its test statistic, p-value, effect size and base.`));
  if (!hyps.length) { out.push(muted("No hypotheses are recorded, so nothing is tested against a prediction; the planned analyses describe and explore.")); return out; }
  const items = planItems(plan);
  out.push(gridTable(["", "Test(s)", "Reads", "Decision rule"], hyps.map((h) => {
    const mine = items.filter((it) => it.hypotheses.includes(h.label));
    const inferential = mine.filter((it) => !["frequencies", "mean", "median", "top_box", "nps", "text_themes", "ranking_scores", "allocation_shares", "turf", "brand_funnel", "pricing", "maxdiff_scores", "conjoint_utilities", "factor", "reliability", "cluster"].includes(it.method));
    const rule = !mine.length ? "Not testable as planned: no analysis in the plan reads both sides of it. Add one (see Recommendations)."
      : !inferential.length || h.type === "descriptive" ? "Descriptive: read as a level, share or ranking with its confidence interval; no significance test decides it."
      : `Supported if p < ${alpha} after correction in the predicted direction${h.expectedEffect ? `, with at least a ${h.expectedEffect} effect` : ""}; not supported otherwise; inconclusive when a group has fewer than ${MIN_READ_BASE} respondents.`;
    return [h.label, [...new Set(mine.map((it) => mWords(it.method)))].join("; ") || "—", [...new Set(mine.flatMap((it) => it.reads))].join(", ") || "—", rule];
  }), [500, 2400, 2000, 4100]));
  return out;
}

function tablesAndCharts(def: SurveyDefinition, H1: H1Fn, plan: AnalysisPlan): Block[] {
  const explained = explainPlan(def, plan);
  const methodOf = new Map(planItems(plan).map((it) => [it.id, it.method]));
  const out: Block[] = [H1("Proposed tables and charts")];
  if (!explained.length) { out.push(muted("No analysis follows from the design yet, so no table or chart is proposed.")); return out; }
  out.push(body("One table and one chart per planned analysis, chosen from the method and the variables' level of measurement. When the data exist, the chart is confirmed from the result's own structure; a chart that cannot be drawn is replaced by its table and the report says why."));
  out.push(gridTable(["Analysis", "Serves", "Table", "Chart", "Min. base"], explained.slice(0, 40).map((x) => {
    const m = methodOf.get(x.id) ?? "";
    return [x.title, x.hypotheses.map((h) => h.label).join(", ") || "profile", plain(x.expectedOutput, 110), chartWords((METHOD_CHART as Record<string, string>)[m]), String(x.requiredBase.minimum)];
  }), [2300, 900, 3300, 1600, 900]));
  if (explained.length > 40) out.push(muted(`… and ${explained.length - 40} more planned analyses.`));
  return out;
}

function interpretationFramework(def: SurveyDefinition, H1: H1Fn, plan: AnalysisPlan): Block[] {
  const between = plan.tests.some((t) => /between-arms/.test(t.reason ?? ""));
  const out: Block[] = [H1("Expected outputs and interpretation framework")];
  out.push(label("Outputs"));
  for (const o of ["Topline at the first readable base (30 completes), run automatically", "The findings report: a verdict on each hypothesis, the key findings with their evidence, who differs, caveats", "The findings presentation for the audience chosen", "The respondent-level data with the variable dictionary"]) out.push(bullet(o));
  out.push(label("Three kinds of evidence, never mixed"));
  out.push(bullet("Descriptive — a level, share or ranking with its base and confidence interval. It says what is, not why."));
  out.push(bullet("Statistical — a difference or association that a planned test finds unlikely under chance, at the plan's α and correction, read together with its effect size."));
  out.push(bullet(between ? "Causal — only for the between-arms comparisons, where respondents were randomly assigned to what they saw; everything else is association." : "Causal — not claimed: respondents are not randomly assigned to what is compared, so a significant association is reported as association, never as cause."));
  out.push(label("Verdicts"));
  for (const v of ["Supported — the planned test is significant after correction, in the predicted direction.", "Not supported — the test is not significant, or the effect runs the other way.", "Mixed — the analyses serving the hypothesis disagree.", `Inconclusive — the base is too small to read (fewer than ${MIN_READ_BASE} in a group), or the analysis could not run.`, "Untested — no executed analysis serves it. An untested hypothesis is labelled as such, never reported as a finding."]) out.push(bullet(v));
  return out;
}

function qualityControl(def: SurveyDefinition, H1: H1Fn): Block[] {
  const q = def.quality;
  const checks = def.questions.filter((x) => x.attentionCheck || x.settings?.onFail === "terminate");
  const out: Block[] = [H1("Quality control requirements")];
  out.push(gridTable(["Control", "In this survey", "Source"], [
    ["Response-quality engine", q?.enabled === false ? "Off" : `On, ${q?.strictness ?? "standard"} strictness`, q ? "survey settings" : "default"],
    ["Attention checks", checks.length ? checks.map((x) => x.code).join(", ") : "None programmed", checks.length ? "questionnaire" : "add one before fieldwork"],
    ["Screening and terminations", `${screeningRules(def).length} rule${screeningRules(def).length === 1 ? "" : "s"}`, "questionnaire logic"],
    ["Quotas", (def.quotas ?? []).length ? `${(def.quotas ?? []).length} quota${(def.quotas ?? []).length === 1 ? "" : "s"}` : "None", "quota definitions"],
    ["Custom quality rules", String(q?.customRules?.length ?? 0), "survey settings"],
  ], [2600, 3900, 2500]));
  out.push(label("Before fieldwork"));
  for (const c of ["Every route through the questionnaire tested in the preview, including each screen-out and quota-full ending", "A soft launch (about a tenth of the target sample) checked for drop-off, timings and data before the full field", "Test interviews kept in the test environment and never in the analysed data"]) out.push(bullet(c));
  out.push(label("During and after fieldwork"));
  for (const c of ["Speeders (well under the median interview length), straight-liners on grids, duplicates and nonsensical open ends flagged by the quality engine and removed under the data-cleaning plan", "Quota progress and the sample profile checked against the targets daily", "Every result read on the clean, live dataset, with its base shown"]) out.push(bullet(c));
  return out;
}

function limitationsSection(def: SurveyDefinition, H1: H1Fn, trace: Trace | null): Block[] {
  const r = def.research;
  const out: Block[] = [H1("Limitations, assumptions and recommendations")];
  out.push(label("Assumptions"));
  if (r?.assumptions.length) for (const a of r.assumptions) out.push(bullet(a)); else out.push(muted("No assumptions are recorded in the research design."));
  out.push(label("Limitations"));
  const size = planSampleSize(def);
  const target = r?.sampleSize ?? expectedSample(def)?.n;
  for (const l of [
    "Answers are self-reported: they measure what respondents say, which can differ from what they do.",
    "A single cross-sectional survey shows associations at one point in time; it does not establish cause and effect.",
    ...(!(def.quotas ?? []).length ? ["No quotas are defined, so the sample's composition is not controlled; findings describe the people who answered unless the data are weighted to the population."] : []),
    ...(target && size.minimum > target ? [`The target sample (${target}) is below what the plan needs (${size.minimum}); some planned analyses will be reported as low-base.`] : []),
  ]) out.push(bullet(l));
  out.push(label("Recommendations"));
  const recs = [
    /* the gaps in words a reader acts on: a suggestion written for the copilot (action names, JSON) is left out and the gap's own message stands */
    ...(trace ? trace.t.gaps.slice(0, 12).map((g) => `${g.severity === "blocking" ? "Before fieldwork: " : ""}${g.suggestion && !/[{}"]|\b[a-z]+_[a-z_]+\b/.test(g.suggestion) ? g.suggestion : g.message}`) : []),
    ...(!r?.analysisPlan ? ["Save the analysis plan (Intelligent mode → Analysis) so this document is read from a fixed plan rather than one derived from the questionnaire."] : []),
    ...(structuredHypotheses(def).some((h) => !h.note) ? ["Record the rationale of each hypothesis, so the plan says why it is expected."] : []),
  ];
  if (recs.length) for (const x of [...new Set(recs)]) out.push(bullet(x)); else out.push(muted("No gaps were found between the objective, the hypotheses, the questions and the analysis plan."));
  if (r?.sources.length) { out.push(label("Sources")); for (const s of r.sources) out.push(bullet(s)); }
  return out;
}

/* ------------------------------------------------------------ the findings report */

export interface FindingsDocxOptions extends Omit<DeckOptions, "results"> {
  author?: string;
  /** the results by analysis id, so the groups and the chart data can be tabled */
  results?: Record<string, AnalysisResult>;
  /** the report theme (2026-10-18): the look only */
  theme?: ThemeSpec | null;
  logo?: DocLogo | null;
  /** a reordering of the sections asked for in words — content unchanged */
  structure?: StructureRequest | null;
}

type RunForDocx = Parameters<typeof deckFromRun>[1];

/** The findings report as a Word document, from a run. */
export function buildFindingsDocx(def: SurveyDefinition, run: RunForDocx, opts: FindingsDocxOptions = {}): Promise<Buffer> {
  return themed(opts, () => findingsDocx(def, run, opts));
}
async function findingsDocx(def: SurveyDefinition, run: RunForDocx, opts: FindingsDocxOptions): Promise<Buffer> {
  const deck = deckFromRun(def, run, { ...opts, results: opts.results });
  const narrative = reportNarrative(def, run as never);
  const date = (opts.date ?? run.computedAt).slice(0, 10);
  const title = opts.title ?? deck.title;
  const out: Block[] = [];
  out.push(...cover("Findings report", title, [(opts.client ?? def.research?.brief?.client) ? `Prepared for ${opts.client ?? def.research?.brief?.client}` : "", `${run.n} ${run.environment.toLowerCase()} completes · ${run.trigger.replace(/_/g, " ")} · ${date}`, opts.author ?? ""]));

  out.push(h1("Executive summary"));
  const summary = deck.slides.find((s): s is Extract<DeckSlide, { type: "summary" }> => s.type === "summary")!;
  out.push(lead(summary.headline));
  if (opts.narrative?.summary?.length) for (const b of opts.narrative.summary) out.push(bullet(b));
  else out.push(body(narrative.summary));

  out.push(h1("The hypotheses"));
  if (!run.verdicts.length) out.push(muted("No hypotheses are recorded in the research design."));
  else out.push(gridTable(["", "Hypothesis", "Verdict", "Why"], run.verdicts.map((v) => [v.label, v.text, `${v.verdict.replace(/_/g, " ")}${v.corrected ? ` (${v.corrected.verdict.replace(/_/g, " ")} once corrected)` : ""}`, `${v.reason}${v.corrected ? ` ${v.corrected.note}` : ""}`]), [600, 2700, 1500, 4200]));

  /* Phase 8: what moved since the last wave — the KPI table, the findings that changed, the verdicts that changed */
  const wave = deck.slides.find((s): s is Extract<DeckSlide, { type: "wave_change" }> => s.type === "wave_change");
  if (wave) {
    out.push(h1("Since the last wave"));
    out.push(body(run.since?.summary ?? wave.since));
    if (wave.kpis.length) out.push(gridTable(["KPI", "Last wave", "This wave", "Change", ""], wave.kpis.map((k) => [k.name, k.from, k.to, `${k.delta}${k.significant === true ? " (significant)" : k.significant === false ? " (not significant)" : ""}`, k.verdict === "unknown" ? "" : k.verdict]), [3000, 1500, 1500, 2200, 1000]));
    for (const c of wave.changes) out.push(bullet(c));
    for (const v of wave.verdicts) out.push(bullet(v));
    if (run.since?.gone.length) out.push(muted(`No longer found: ${run.since.gone.map((g) => g.headline).join("; ")}`));
  }

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
  /*
   * THE ADVANCED MODELS (2026-10-22): each executed HB, latent class, SEM, bootstrapped mediation, ω or Gabor–Granger
   * result, read by the engine — its plain-language summary, its diagnostics with a status, its caveats, and its key
   * table (the SEM's paths as the path diagram's table) — numbers only from the result itself.
   */
  const advanced = (run.items ?? []).map((it) => {
    const item = it as { definition: AnalysisDefinition; result?: AnalysisResult };
    const result = item.result ?? (item.definition.id ? opts.results?.[item.definition.id] : undefined);
    return result ? { def: item.definition, result, n: advancedNarrative(item.definition, result, { objective: def.research?.objective, hypotheses: (def.research?.hypotheses ?? []).map((text, i) => ({ label: `H${i + 1}`, text })), verdicts: run.verdicts }) } : null;
  }).filter((x): x is { def: AnalysisDefinition; result: AnalysisResult; n: NonNullable<ReturnType<typeof advancedNarrative>> } => !!x?.n);
  if (advanced.length) {
    out.push(h1("Advanced models"));
    for (const a of advanced) {
      out.push(h2(a.n.title));
      for (const s of a.n.summary) out.push(bullet(s));
      if (a.n.diagnostics.length) out.push(gridTable(["Diagnostic", "Value", "Reading"], a.n.diagnostics.map((d) => [d.label, d.value, `${d.status === "ok" ? "OK" : d.status === "caution" ? "Caution" : "Fails"}${d.note ? ` — ${d.note}` : ""}`]), [2800, 2600, 3600]));
      const key = ["hb_importance", "hb_shares", "lca_sizes", "sem_structural", "mediation_bootstrap", "omega", "gg"].map((id) => a.result.tables.find((t) => t.id === id)).find(Boolean);
      if (key && a.n.valid) out.push(resultTable(key));
      for (const c of a.n.caveats) out.push(muted(`Caveat: ${c}`));
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
  if (opts.structure?.order.length) {
    const closing = out.splice(out.length - 2, 2);
    return document(`${title} — findings report`, `Findings report for ${def.meta.title}`, [...reorderSections(out, opts.structure), ...closing]);
  }
  return document(`${title} — findings report`, `Findings report for ${def.meta.title}`, out);
}
