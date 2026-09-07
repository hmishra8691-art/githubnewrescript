import type { ReportBlock, ReportDefinition, ReportTemplate, TemplateBlock } from "./types.js";

/**
 * PAGES, AND THE SHAPE OF A DELIVERABLE (§36).
 *
 * A report has always been a flat `blocks[]` array rendered as one scroll.
 * That is fine on a screen and wrong everywhere the report actually ends up:
 * printed, saved as PDF, handed round as slides. A deliverable has pages, and
 * where one page ends is an editorial decision — "these three charts belong
 * together, that one gets a page to itself" — which nobody can make on the
 * team's behalf.
 *
 * The pages are DERIVED rather than stored. A `page_break` block marks a
 * boundary and this module groups the flat list around it, which means every
 * report that already exists, every version already published, and both
 * export builders keep working untouched: they see one extra block type they
 * can ignore, while anything that needs pages asks for them here.
 *
 * The alternative — a `pages[]` array of blocks — would have been a migration
 * of stored report definitions, a second shape for the exports to handle, and
 * a breaking change to `analytics_report_versions`, whose whole purpose is to
 * be immutable.
 */

export interface ReportPage {
  /** 1-based, for a footer or a "page N of M" */
  number: number;
  blocks: ReportBlock[];
  /** the section this page falls under, for a running header */
  section?: string;
}

export interface PageOptions {
  /**
   * Start a new page at every section divider.
   *
   * On by default because that is what a section divider means in a printed
   * report — a new part starts on a new leaf — and it is what the PowerPoint
   * export has always done with them (a divider slide). A team that wants a
   * dense on-screen report can turn it off.
   */
  breakOnSection?: boolean;
}

/**
 * Group a report's blocks into pages.
 *
 * The cover always gets its own page. A page break is consumed rather than
 * emitted, and consecutive breaks do not produce empty pages — an author
 * pressing the button twice means "definitely a break", not "give me a blank
 * leaf", and a blank page in a client deliverable reads as a mistake.
 */
export function reportPages(
  blocks: ReportBlock[],
  opts: PageOptions = {},
): ReportPage[] {
  const breakOnSection = opts.breakOnSection !== false;
  const pages: ReportPage[] = [];
  let current: ReportBlock[] = [];
  let section: string | undefined;

  const flush = () => {
    if (!current.length) return;
    pages.push({ number: pages.length + 1, blocks: current, section });
    current = [];
  };

  for (const block of blocks) {
    if (block.type === "page_break") { flush(); continue; }
    if (block.type === "cover") {
      flush();
      pages.push({ number: pages.length + 1, blocks: [block] });
      continue;
    }
    if (block.type === "section") {
      if (breakOnSection) flush();
      section = block.title;
    }
    current.push(block);
  }
  flush();

  // renumber: `flush` numbered as it went, and the cover insert can interleave
  return pages.map((p, i) => ({ ...p, number: i + 1 }));
}

/** Does this report say anything about how the study was run? */
export function methodologyBlock(blocks: ReportBlock[]) {
  return blocks.find((b) => b.type === "methodology") as
    | Extract<ReportBlock, { type: "methodology" }>
    | undefined;
}

/**
 * The methodology as lines of text, for an export that has no layout for it.
 *
 * The standard statistical notes come LAST and only when asked for, because
 * they are claims about the numbers ("bases below 30 are flagged", "letters
 * mark a two-sided z-test at 95%") that are true of how this platform
 * computes — while everything above them is a claim about the study, which
 * only the team can make. Putting the team's own words first is the whole
 * point of the block existing.
 */
export const STANDARD_METHODOLOGY_NOTES = [
  "Percentages are based on valid responses unless stated; bases below 30 are flagged.",
  "Significance letters mark column proportions significantly higher than the lettered column (two-sided z-test, 95%).",
];

export function methodologyLines(
  block: Extract<ReportBlock, { type: "methodology" }> | undefined,
  fallback: { survey?: string; generatedBy?: string; generatedAt?: Date } = {},
): string[] {
  const out: string[] = [];
  if (block) {
    if (block.fieldwork?.from || block.fieldwork?.to) {
      const from = block.fieldwork.from ?? "?";
      const to = block.fieldwork.to ?? "?";
      out.push(`Fieldwork: ${from} to ${to}`);
    }
    if (block.sampleFrame) out.push(`Sample: ${block.sampleFrame}`);
    if (block.weighting) out.push(`Weighting: ${block.weighting}`);
    for (const item of block.items ?? []) {
      if (item.label || item.value) out.push(`${item.label}${item.label && item.value ? ": " : ""}${item.value}`);
    }
    if (block.notes) out.push(block.notes);
    if (block.includeStandardNotes !== false) out.push(...STANDARD_METHODOLOGY_NOTES);
    if (out.length) return out;
  }

  /*
   * No block, or an empty one: the boilerplate the export has always
   * produced. Kept exactly so that a report which says nothing about its
   * methodology does not silently lose the slide it used to have.
   */
  const at = fallback.generatedAt ?? new Date();
  if (fallback.survey) out.push(`Survey: ${fallback.survey}`);
  out.push(
    `Generated ${at.toISOString().slice(0, 16).replace("T", " ")} UTC by Rescript Analytics` +
      `${fallback.generatedBy ? ` for ${fallback.generatedBy}` : ""}.`,
  );
  out.push(...STANDARD_METHODOLOGY_NOTES);
  return out;
}

/* ------------------------------------------------------------- templates */

let seq = 0;
/** Ids are per-application, not per-template: two copies of one template must not share block ids. */
function bid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * Turn a template into a report definition.
 *
 * Applying a template to an EXISTING report is deliberately conservative: it
 * lays the template's structure over the report and carries across any block
 * that already points at an analysis, appended in order under the first
 * placeholder that fits. Nobody's finished chart is discarded by choosing a
 * template, because that is the mistake a person makes at four o'clock and
 * cannot undo.
 */
export function applyTemplate(
  template: ReportTemplate,
  existing?: Partial<ReportDefinition>,
): ReportDefinition {
  const keep: ReportBlock[] = (existing?.blocks ?? []).filter(
    (b) =>
      (b.type === "chart" || b.type === "table" || b.type === "kpi") &&
      !!(b as { analysisId?: string }).analysisId,
  );

  const blocks: ReportBlock[] = [];
  const used = new Set<string>();

  for (const t of template.blocks) {
    const fresh = { ...(t as Record<string, unknown>), id: bid(t.type) } as ReportBlock;

    /*
     * A placeholder of a type we already have real content for takes the
     * first unused piece of that content, so a re-template keeps the work.
     */
    if (fresh.type === "chart" || fresh.type === "table" || fresh.type === "kpi") {
      const match = keep.find((k) => k.type === fresh.type && !used.has(k.id));
      if (match) {
        used.add(match.id);
        /*
         * The template's title wins when it has one — that is the point of a
         * house template ("Awareness", not "crosstab of Q3 by region") — and
         * the real block's own title is kept when the template's placeholder
         * had none.
         */
        const title = (fresh as { title?: string }).title || (match as { title?: string }).title;
        blocks.push({ ...match, id: fresh.id, ...(title ? { title } : {}) } as ReportBlock);
        continue;
      }
      /*
       * Nothing to fill it with: keep the placeholder, and keep it VALID.
       *
       * A template block carries no analysis, and the renderer and both
       * exports assume every chart has a spec and every list of analyses is
       * a list. An unfilled placeholder must therefore be an empty block
       * rather than a half-built one — otherwise choosing a template is how
       * the report view crashes, which is exactly the moment a person is
       * least able to guess why.
       */
      const { placeholder, ...rest } = fresh as Record<string, unknown>;
      blocks.push({
        ...rest,
        analysisId: "",
        ...(fresh.type === "chart" ? { chart: (rest.chart as object) ?? { type: "bar_vertical", options: {} } } : {}),
        ...(placeholder ? { title: (rest.title as string) || String(placeholder) } : {}),
      } as ReportBlock);
      continue;
    }
    if (fresh.type === "insights" || fresh.type === "executive_summary") {
      const { placeholder, ...rest } = fresh as Record<string, unknown>;
      blocks.push({
        ...rest,
        analysisIds: (rest.analysisIds as string[]) ?? [],
        ...(placeholder ? { title: (rest.title as string) || String(placeholder) } : {}),
      } as ReportBlock);
      continue;
    }
    blocks.push(fresh);
  }

  /* anything the template had no room for goes at the end rather than nowhere */
  for (const k of keep) if (!used.has(k.id)) blocks.push({ ...k, id: bid(k.type) });

  return {
    title: existing?.title ?? template.name,
    subtitle: existing?.subtitle,
    themeId: existing?.themeId ?? template.themeId ?? null,
    mode: existing?.mode ?? "live",
    blocks,
    viewerSegments: existing?.viewerSegments,
    viewerFilters: existing?.viewerFilters,
    filterId: existing?.filterId ?? null,
    branding: existing?.branding,
    exportDefaults: existing?.exportDefaults ?? template.exportDefaults,
  };
}

/**
 * The templates the platform ships with.
 *
 * A template feature whose library is empty on the first day is a feature
 * nobody uses on the first day. These are the three deliverable shapes a
 * research team actually produces, written out so that "apply a template" has
 * something to do before anyone has authored one.
 *
 * `builtIn` marks them: they are not rows in anybody's workspace, cannot be
 * edited in place, and a team that wants a house version saves a copy.
 */
export const BUILT_IN_REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: "builtin:topline",
    name: "Topline",
    description: "A cover, the headline numbers, and the methodology. What goes out the day fieldwork closes.",
    builtIn: true,
    blocks: [
      { id: "t1", type: "cover", title: "Topline results", subtitle: "Prepared for {client}" },
      { id: "t2", type: "kpi", placeholder: "Headline measure" },
      { id: "t3", type: "chart", placeholder: "The question the study was commissioned to answer" },
      { id: "t4", type: "text", markdown: "**What we are seeing.** Two or three sentences, before anybody scrolls." },
      { id: "t5", type: "page_break" },
      { id: "t6", type: "methodology", title: "Methodology", includeStandardNotes: true },
    ],
  },
  {
    id: "builtin:full",
    name: "Full report",
    description: "Cover, executive summary, a section per topic, then sample and methodology at the back.",
    builtIn: true,
    blocks: [
      { id: "f1", type: "cover", title: "{study}", subtitle: "Prepared for {client}" },
      { id: "f2", type: "executive_summary", title: "Executive summary", text: "" },
      { id: "f3", type: "page_break" },
      { id: "f4", type: "section", title: "The market" },
      { id: "f5", type: "chart", placeholder: "Market context" },
      { id: "f6", type: "table", placeholder: "By segment" },
      { id: "f7", type: "section", title: "The brand" },
      { id: "f8", type: "chart", placeholder: "Awareness" },
      { id: "f9", type: "chart", placeholder: "Consideration" },
      { id: "f10", type: "section", title: "What to do about it" },
      { id: "f11", type: "insights", title: "Findings" },
      { id: "f12", type: "text", markdown: "**Recommendations.**\n\n1. \n2. \n3. " },
      { id: "f13", type: "page_break" },
      { id: "f14", type: "section", title: "Appendix" },
      { id: "f15", type: "methodology", title: "Methodology", includeStandardNotes: true },
    ],
  },
  {
    id: "builtin:tracker",
    name: "Tracker wave",
    description: "The same shape every wave, so this wave is comparable with the last one at a glance.",
    builtIn: true,
    blocks: [
      { id: "w1", type: "cover", title: "{study} — wave {n}", subtitle: "{fieldwork dates}" },
      { id: "w2", type: "kpi", placeholder: "The tracked measure, this wave" },
      { id: "w3", type: "chart", placeholder: "Trend over waves" },
      { id: "w4", type: "text", markdown: "**Movement since last wave.** What changed, and whether it is significant." },
      { id: "w5", type: "page_break" },
      { id: "w6", type: "section", title: "Detail" },
      { id: "w7", type: "table", placeholder: "This wave by segment" },
      { id: "w8", type: "chart", placeholder: "Secondary measures" },
      { id: "w9", type: "page_break" },
      { id: "w10", type: "methodology", title: "Methodology", includeStandardNotes: true },
    ],
  },
];

/** A template's structure in words, for a picker. */
export function describeTemplate(t: ReportTemplate): string {
  const counts = new Map<string, number>();
  for (const b of t.blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  const pages = t.blocks.filter((b) => b.type === "page_break").length + 1;
  const order = ["cover", "executive_summary", "section", "chart", "table", "kpi", "insights", "text", "methodology"];
  const parts = order
    .filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k.replace("_", " ")}${counts.get(k)! > 1 ? "s" : ""}`);
  return `${pages} page${pages === 1 ? "" : "s"} — ${parts.join(", ")}`;
}

/** Placeholder blocks still waiting for an analysis, so a report can say it is unfinished. */
export function unfilledBlocks(blocks: ReportBlock[]): ReportBlock[] {
  return blocks.filter(
    (b) =>
      (b.type === "chart" || b.type === "table" || b.type === "kpi") &&
      !(b as { analysisId?: string }).analysisId,
  );
}

export type { TemplateBlock };
