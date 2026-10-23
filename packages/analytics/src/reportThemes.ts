import type { ReportTheme } from "./types.js";
import { canonicalJson, hash64 } from "./canonical.js";
import { NAMED_COLORS, parseHex, toHex, contrast, ensureContrast, mix, isDark, distinguishable } from "./story/design.js";

/**
 * REPORT THEMES IN WORDS (2026-10-18, docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md).
 *
 * A report theme is the LOOK of the documents a project hands over — the Word
 * research plan, proposal, SAP and findings report, the findings deck, the
 * in-app report — as explicit tokens a person can read and edit: colours by
 * role, typography and its hierarchy, paragraph and table formatting, the chart
 * palette, spacing, header / footer / logo. It is never the content: a theme
 * cannot add, remove, reword or reorder anything. Reordering sections is a
 * separate STRUCTURE request, honoured only when the words ask for it, and the
 * analysis is neither.
 *
 *   interpretThemeRequest("Apply our premium corporate theme with navy headings,
 *     subtle cyan accents, and clean white backgrounds")
 *     → a patch on the Executive Research preset, a preview, what was understood
 *
 * The reading is deterministic. What it could not place is returned as
 * `unclear` (and `needsModel`), so the Studio may put the leftover words — the
 * look only, never the data — to a configured model, whose answer is kept to
 * the same vocabulary by `sanitizeThemePatch`. Every theme, preset, patched or
 * model-made, passes `enforceTheme`: text, headings and table headers stay
 * readable, accents and chart series stay visible and distinguishable.
 */

export interface ThemeColors {
  primary: string; secondary: string; accent: string;
  /** page and card */
  background: string; surface: string;
  text: string; muted: string; heading: string; border: string;
  tableHeaderBg: string; tableHeaderText: string; tableStripe: string;
}
export interface ThemeSpec {
  v: 1;
  /** a built-in's id ("builtin:healthcare_analytics") or a saved theme's uuid */
  id?: string;
  name: string;
  /** a saved theme's version (each save of the same name is a new version) */
  version?: number;
  description?: string;
  colors: ThemeColors;
  chartPalette: string[];
  typography: {
    /** font family names as Word and PowerPoint know them */
    heading: string; body: string;
    baseSizePt: number; h1Pt: number; h2Pt: number; h3Pt: number;
    headingWeight: "bold" | "regular";
    headingCase: "none" | "upper";
  };
  paragraph: { lineSpacing: number; spaceAfterPt: number };
  table: { style: "grid" | "minimal" | "striped"; headerBold: boolean };
  layout: { density: "compact" | "balanced" | "airy"; titleRule: boolean };
  /** how statistical evidence lines (tests, p-values, bases) read: quiet italics, or clear upright text */
  annotations: { emphasis: "subtle" | "clear" };
  branding: { header?: string; footer?: string; pageNumbers: boolean; logo: { placement: "none" | "header" | "cover"; url?: string } };
}

type Partialish<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Partialish<T[K]>) : T[K] };
export type ThemePatch = Partialish<Omit<ThemeSpec, "v" | "id" | "version">>;

const BASE: Omit<ThemeSpec, "id" | "name" | "description" | "colors" | "chartPalette"> = {
  v: 1,
  typography: { heading: "Calibri", body: "Calibri", baseSizePt: 10.5, h1Pt: 15, h2Pt: 12, h3Pt: 11, headingWeight: "bold", headingCase: "none" },
  paragraph: { lineSpacing: 1.1, spaceAfterPt: 4 },
  table: { style: "grid", headerBold: true },
  layout: { density: "balanced", titleRule: false },
  annotations: { emphasis: "subtle" },
  branding: { pageNumbers: true, logo: { placement: "none" } },
};
const preset = (id: string, name: string, description: string, colors: ThemeColors, chartPalette: string[], over: ThemePatch = {}): ThemeSpec =>
  mergeTheme({ ...structuredClone(BASE), id: `builtin:${id}`, name, version: 1, description, colors, chartPalette } as ThemeSpec, over);

/** The five built-in report themes. Saved themes (per organisation or per person) live in the database (migration 0064). */
export const REPORT_THEMES: readonly ThemeSpec[] = [
  preset("executive_research", "Executive Research", "Navy and gold on white, Calibri, ruled section titles, navy table headers — for leadership readouts.",
    { primary: "#1B2A4A", secondary: "#3E5C8A", accent: "#9A7322", background: "#FFFFFF", surface: "#F4F6F9", text: "#18202D", muted: "#4F5B6B", heading: "#1B2A4A", border: "#D5DBE4", tableHeaderBg: "#1B2A4A", tableHeaderText: "#FFFFFF", tableStripe: "#F4F6F9" },
    ["#1B2A4A", "#9A7322", "#4F7CAC", "#2F7D6D", "#A3485A", "#6E5A9E"], { layout: { titleRule: true } }),
  preset("healthcare_analytics", "Healthcare Analytics", "Restrained deep blue and clinical green, light table headers, clear statistical annotations.",
    { primary: "#1D4E6B", secondary: "#557A95", accent: "#2E7D6B", background: "#FFFFFF", surface: "#F5F9FA", text: "#1C2A33", muted: "#4A5D6B", heading: "#1D4E6B", border: "#CFDCE3", tableHeaderBg: "#E3EEF3", tableHeaderText: "#16405A", tableStripe: "#F5F9FA" },
    ["#1D4E6B", "#2E7D6B", "#6F8FA6", "#8A8A8A", "#5E8B7E", "#9A7A4E"], { annotations: { emphasis: "clear" }, table: { style: "striped" } }),
  preset("brand_performance", "Brand Performance", "Confident crimson and charcoal, Arial, bold chart colours — for brand trackers and funnels.",
    { primary: "#B4232C", secondary: "#374151", accent: "#1F6FB2", background: "#FFFFFF", surface: "#F7F7F8", text: "#1F2329", muted: "#545B66", heading: "#1F2329", border: "#DADDE2", tableHeaderBg: "#1F2329", tableHeaderText: "#FFFFFF", tableStripe: "#F7F7F8" },
    ["#B4232C", "#1F6FB2", "#B87503", "#2E8B57", "#6B4FA0", "#0E7C86"], { typography: { heading: "Arial", body: "Arial" } }),
  preset("consumer_insights", "Consumer Insights", "Fresh teal with an amber accent, striped tables, airy spacing — for shopper and lifestyle studies.",
    { primary: "#0F766E", secondary: "#3F8F86", accent: "#B45309", background: "#FFFFFF", surface: "#F0FAF8", text: "#18242A", muted: "#4B5B60", heading: "#0F5F59", border: "#CBE5E0", tableHeaderBg: "#0F766E", tableHeaderText: "#FFFFFF", tableStripe: "#F0FAF8" },
    ["#0F766E", "#B45309", "#4C6EF5", "#9D174D", "#6B8E23", "#7C6F64"], { table: { style: "striped" }, layout: { density: "airy" } }),
  preset("academic_research", "Academic Research", "Black and deep blue, Cambria, minimal (booktabs-style) tables, compact spacing, clear annotations.",
    { primary: "#1F2A44", secondary: "#4A5568", accent: "#1F4E99", background: "#FFFFFF", surface: "#F7F7F7", text: "#111111", muted: "#444444", heading: "#111111", border: "#BFBFBF", tableHeaderBg: "#FFFFFF", tableHeaderText: "#111111", tableStripe: "#F7F7F7" },
    ["#1F4E99", "#7F7F7F", "#B03A2E", "#2E7D4F", "#8E6C3A", "#5B4E8C"], { typography: { heading: "Cambria", body: "Cambria", h1Pt: 14, h2Pt: 12 }, table: { style: "minimal" }, layout: { density: "compact" }, annotations: { emphasis: "clear" } }),
];

/** The documents' look before themes existed — what a document without a theme still gets, byte for byte (see `docStyleOf`). */
export const DEFAULT_REPORT_THEME: ThemeSpec = mergeTheme({ ...structuredClone(BASE), id: "builtin:default", name: "Rescript default", version: 1, description: "The documents' standard look.",
  colors: { primary: "#1D4ED8", secondary: "#5F6B7D", accent: "#1D4ED8", background: "#FFFFFF", surface: "#EEF1F6", text: "#16202E", muted: "#5F6B7D", heading: "#16202E", border: "#D5DBE4", tableHeaderBg: "#EEF1F6", tableHeaderText: "#5F6B7D", tableStripe: "#FFFFFF" },
  chartPalette: ["#4F46E5", "#0891B2", "#B45309", "#047857", "#E11D48", "#7C3AED"] } as ThemeSpec, {});

/* ------------------------------------------------------------ names */

/** "the Healthcare Analytics theme" / "healthcare-analytics" → "healthcare analytics" */
export const themeNameKey = (name: string): string => name.toLowerCase().replace(/["“”'’]/g, "").replace(/\btheme\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/^(?:the|our|my|a|an)\s+/, "");

/** a theme by its name among the built-ins and the saved themes (saved first: an organisation may shadow a built-in's name on purpose) */
export function findReportTheme(name: string, saved: readonly ThemeSpec[] = []): ThemeSpec | null {
  const k = themeNameKey(name);
  if (!k) return null;
  return saved.find((t) => themeNameKey(t.name) === k) ?? REPORT_THEMES.find((t) => themeNameKey(t.name) === k || t.id === `builtin:${k.replace(/ /g, "_")}`) ?? null;
}

/* ------------------------------------------------------------ merging and the rules */

export function mergeTheme(base: ThemeSpec, patch: ThemePatch): ThemeSpec {
  const out = structuredClone(base);
  const p = patch as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    const cur = (out as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      const merged: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 === undefined) continue;
        const c2 = merged[k2];
        merged[k2] = v2 && typeof v2 === "object" && !Array.isArray(v2) && c2 && typeof c2 === "object" ? { ...(c2 as object), ...(v2 as object) } : v2;
      }
      (out as unknown as Record<string, unknown>)[k] = merged;
    } else (out as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

export interface ThemeAdjustment { token: string; from: string; to: string; why: string }

const hex = (v: unknown): string | null => (typeof v === "string" && parseHex(v) ? toHex(parseHex(v)!) : null);

/**
 * The rules every theme obeys, whatever was asked: body text 7:1 on the page,
 * headings, muted text and table header text 4.5:1 on what they sit on, accents
 * and chart series 3:1 on the page and distinguishable from one another. A
 * colour that breaks a rule is moved in lightness (its hue kept) and the move is
 * reported — "subtle cyan accents" on white become a darker cyan, and the
 * preview says so.
 */
export function enforceTheme(t: ThemeSpec): { theme: ThemeSpec; adjustments: ThemeAdjustment[] } {
  const theme = structuredClone(t);
  const adj: ThemeAdjustment[] = [];
  const c = theme.colors;
  for (const k of Object.keys(c) as (keyof ThemeColors)[]) c[k] = hex(c[k]) ?? hex(DEFAULT_REPORT_THEME.colors[k])!;
  const fix = (token: keyof ThemeColors, against: string, min: number, why: string) => {
    const was = c[token];
    const now = ensureContrast(was, against, min);
    if (now.toUpperCase() !== was.toUpperCase()) { c[token] = now; adj.push({ token, from: was, to: now, why }); }
  };
  fix("text", c.background, 7, "body text must stay readable on the page (7:1)");
  fix("heading", c.background, 4.5, "headings must stay readable on the page (4.5:1)");
  fix("muted", c.background, 4.5, "secondary text must stay readable (4.5:1)");
  fix("tableHeaderText", c.tableHeaderBg, 4.5, "table header text must stay readable on its fill (4.5:1)");
  fix("primary", c.background, 3, "the primary colour marks rules and the first series (3:1)");
  fix("accent", c.background, 3, "an accent must be visible on the page (3:1)");
  const palette = (theme.chartPalette.length ? theme.chartPalette : DEFAULT_REPORT_THEME.chartPalette).map((x) => hex(x)).filter((x): x is string => !!x).slice(0, 8);
  theme.chartPalette = palette.map((col, i) => {
    const now = ensureContrast(col, c.background, 3);
    if (now.toUpperCase() !== col.toUpperCase()) adj.push({ token: `chartPalette[${i}]`, from: col, to: now, why: "every chart series needs 3:1 against the page" });
    return now;
  });
  for (let i = 1; i < theme.chartPalette.length; i++) {
    for (let j = 0; j < i; j++) {
      if (distinguishable(theme.chartPalette[i], theme.chartPalette[j])) continue;
      const replacement = DEFAULT_REPORT_THEME.chartPalette.map((x) => ensureContrast(x, c.background, 3)).find((x) => theme.chartPalette.every((y) => distinguishable(x, y)));
      if (replacement) { adj.push({ token: `chartPalette[${i}]`, from: theme.chartPalette[i], to: replacement, why: `series ${i + 1} was too close to series ${j + 1} to tell apart` }); theme.chartPalette[i] = replacement; }
      break;
    }
  }
  const ty = theme.typography;
  ty.baseSizePt = clampNum(ty.baseSizePt, 8, 14, 10.5);
  ty.h1Pt = clampNum(ty.h1Pt, ty.baseSizePt + 1, 28, 15);
  ty.h2Pt = clampNum(ty.h2Pt, ty.baseSizePt, ty.h1Pt, 12);
  ty.h3Pt = clampNum(ty.h3Pt, ty.baseSizePt, ty.h2Pt, 11);
  ty.heading = safeFont(ty.heading, "Calibri");
  ty.body = safeFont(ty.body, "Calibri");
  theme.paragraph.lineSpacing = clampNum(theme.paragraph.lineSpacing, 1, 2, 1.1);
  theme.paragraph.spaceAfterPt = clampNum(theme.paragraph.spaceAfterPt, 0, 18, 4);
  if (theme.branding.header) theme.branding.header = theme.branding.header.slice(0, 120);
  if (theme.branding.footer) theme.branding.footer = theme.branding.footer.slice(0, 120);
  return { theme, adjustments: adj };
}
/**
 * THE CONTRAST OF A THEME AS IT STANDS — what the live preview warns about while a theme is edited (#18),
 * before `enforceTheme` moves anything: each rule `enforceTheme` keeps, its ratio now and its minimum.
 */
export function themeContrastReport(t: ThemeSpec): { token: string; against: string; ratio: number; min: number; ok: boolean; why: string }[] {
  const c = t.colors;
  const rows: [keyof ThemeColors, keyof ThemeColors, number, string][] = [
    ["text", "background", 7, "body text on the page"],
    ["heading", "background", 4.5, "headings on the page"],
    ["muted", "background", 4.5, "secondary text on the page"],
    ["tableHeaderText", "tableHeaderBg", 4.5, "table header text on its fill"],
    ["primary", "background", 3, "rules and the first series on the page"],
    ["accent", "background", 3, "accents on the page"],
  ];
  return rows.map(([a, b, min, why]) => {
    const fa = hex(c[a]), fb = hex(c[b]);
    const ratio = fa && fb ? Math.round(contrast(fa, fb) * 100) / 100 : 0;
    return { token: a, against: b, ratio, min, ok: ratio >= min, why };
  });
}

const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
/** a font family name, nothing that could be markup or a path */
const safeFont = (v: unknown, dflt: string) => (typeof v === "string" && /^[A-Za-z0-9 \-]{2,40}$/.test(v.trim()) ? v.trim() : dflt);

/** a theme's look as a hash — what an artifact's fingerprint records, so a document made under another look is a new version (the name, id and version are not the look) */
export function reportThemeHash(t: ThemeSpec): string {
  const { id: _i, name: _n, version: _v, description: _d, ...look } = t;
  void _i; void _n; void _v; void _d;
  return hash64(canonicalJson(look));
}

/* ------------------------------------------------------------ structure (separate from the look) */

export const STRUCTURE_SECTIONS = ["summary", "hypotheses", "findings", "segments", "implications", "recommendations", "method", "caveats"] as const;
export type StructureSection = (typeof STRUCTURE_SECTIONS)[number];
/**
 * A reordering of a project's documents' sections — content unchanged. `order` is the findings report's
 * order asked for in words (2026-10-18); `sections` (2026-10-22, engine item #18) is an explicit order per
 * DOCUMENT FAMILY set by drag and drop / keyboard in the Research tab, applied identically in every export of
 * that family (the findings Word report and the findings deck share one order; the qualitative report and
 * the qualitative deck share another). Section ids are `sectionId(title)`; ids a document does not have are
 * ignored, and sections the order does not name keep their place after the named ones.
 */
export interface StructureRequest { order: StructureSection[]; understood: string; sections?: Partial<Record<DocumentFamily, string[]>> }

export const DOCUMENT_FAMILIES = ["findings", "research_plan", "proposal", "sap", "qual"] as const;
export type DocumentFamily = (typeof DOCUMENT_FAMILIES)[number];

/** a section's stable id: its heading without its number, lower-case, hyphenated ("3. Hypotheses and rationale" → "hypotheses-and-rationale") */
export function sectionId(title: string): string {
  return title.replace(/^\s*\d+[.)]\s*/, "").replace(/\s*\(.*?\)\s*$/, "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** every section each family's documents can have, in their default order (some only appear when the study has them) */
export const DOCUMENT_SECTIONS: Record<DocumentFamily, { id: string; title: string; when?: string }[]> = {
  findings: [
    { id: "executive-summary", title: "Executive summary" },
    { id: "the-hypotheses", title: "The hypotheses" },
    { id: "since-the-last-wave", title: "Since the last wave", when: "a tracker with an earlier wave" },
    { id: "key-findings", title: "Key findings" },
    { id: "advanced-models", title: "Advanced models", when: "advanced analyses were run" },
    { id: "who-differs", title: "Who differs", when: "segment differences were found" },
    { id: "beyond-the-plan", title: "Beyond the plan", when: "findings outside the plan" },
    { id: "what-the-data-says-about-the-methods", title: "What the data says about the methods", when: "method checks apply" },
    { id: "what-it-means", title: "What it means" },
    { id: "what-to-do-next", title: "What to do next" },
    { id: "method", title: "Method" },
    { id: "caveats", title: "Caveats" },
  ],
  research_plan: [
    { id: "executive-summary", title: "Executive summary" },
    { id: "business-context-problem-and-objectives", title: "Business context, problem and objectives" },
    { id: "research-questions-and-kpis", title: "Research questions and KPIs", when: "research questions are recorded" },
    { id: "hypotheses-and-rationale", title: "Hypotheses and rationale" },
    { id: "methodology", title: "Methodology" },
    { id: "questionnaire-and-interview-guide", title: "Questionnaire and interview guide" },
    { id: "how-each-question-serves-the-objectives-and-hypotheses", title: "How each question serves the objectives and hypotheses" },
    { id: "variables-and-scales", title: "Variables and scales" },
    { id: "population-sampling-and-fieldwork", title: "Population, sampling and fieldwork" },
    { id: "analysis-plan", title: "Analysis plan" },
    { id: "hypothesis-tests", title: "Hypothesis tests" },
    { id: "proposed-tables-and-charts", title: "Proposed tables and charts" },
    { id: "expected-outputs-and-interpretation-framework", title: "Expected outputs and interpretation framework" },
    { id: "quality-control-requirements", title: "Quality control requirements" },
    { id: "deliverables", title: "Deliverables" },
    { id: "limitations-assumptions-and-recommendations", title: "Limitations, assumptions and recommendations" },
    { id: "ethics-consent-and-data-protection", title: "Ethics, consent and data protection" },
  ],
  proposal: [
    { id: "background-and-objective", title: "Background and objective" },
    { id: "research-questions-and-kpis", title: "Research questions and KPIs", when: "research questions are recorded" },
    { id: "hypotheses", title: "Hypotheses" },
    { id: "questionnaire", title: "Questionnaire" },
    { id: "sample-and-fieldwork", title: "Sample and fieldwork" },
    { id: "analysis-plan", title: "Analysis plan" },
    { id: "deliverables", title: "Deliverables" },
    { id: "assumptions-and-sources", title: "Assumptions and sources", when: "assumptions or sources are recorded" },
    { id: "ethics-consent-and-data-protection", title: "Ethics, consent and data protection" },
  ],
  sap: [
    { id: "objectives-and-hypotheses", title: "Objectives and hypotheses" },
    { id: "populations-bases-and-dataset-scope", title: "Populations, bases and dataset scope" },
    { id: "variables-and-derived-variables", title: "Variables and derived variables" },
    { id: "planned-analyses", title: "Planned analyses" },
    { id: "statistical-conventions", title: "Statistical conventions" },
    { id: "sample-size", title: "Sample size" },
    { id: "interim-analyses-and-software", title: "Interim analyses and software" },
  ],
  qual: [
    { id: "objectives", title: "Objectives" },
    { id: "key-findings", title: "Key findings", when: "AI insights were made" },
    { id: "method-and-coding", title: "Method and coding" },
    { id: "codebook", title: "Codebook" },
    { id: "themes", title: "Themes" },
    { id: "group-differences", title: "Group differences" },
    { id: "interpretation", title: "Interpretation" },
    { id: "limitations", title: "Limitations" },
    { id: "review-status-and-history", title: "Review status and history" },
  ],
};

/** the words-only order (2026-10-18) of the findings report, as section ids */
const LEGACY_FINDINGS: Record<StructureSection, string> = {
  summary: "executive-summary", hypotheses: "the-hypotheses", findings: "key-findings", segments: "who-differs",
  implications: "what-it-means", recommendations: "what-to-do-next", method: "method", caveats: "caveats",
};

/** the section order a family's documents follow — the explicit one, else (findings) the order asked for in words; null = as built */
export function sectionOrderFor(structure: StructureRequest | null | undefined, family: DocumentFamily): string[] | null {
  const explicit = structure?.sections?.[family];
  if (explicit?.length) return explicit;
  if (family === "findings" && structure?.order?.length) return structure.order.map((k) => LEGACY_FINDINGS[k]).filter(Boolean);
  return null;
}

/**
 * Put sections in an order: the named ones first, in the order named, then the rest in their own order.
 * Generic over what a section is (Word heading blocks, deck slide groups, story scenes) — the same function
 * for every export, which is what makes them agree.
 */
export function orderSections<T>(sections: readonly { id: string; items: T[] }[], order: readonly string[] | null | undefined): { id: string; items: T[] }[] {
  if (!order?.length) return [...sections];
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return sections.map((s, i) => ({ s, i, r: rank(s.id) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.s);
}

/** read a stored / posted section-order map: known families, string ids, de-duplicated */
export function readSectionOrders(x: unknown): Partial<Record<DocumentFamily, string[]>> | undefined {
  if (!x || typeof x !== "object") return undefined;
  const out: Partial<Record<DocumentFamily, string[]>> = {};
  for (const f of DOCUMENT_FAMILIES) {
    const v = (x as Record<string, unknown>)[f];
    if (!Array.isArray(v)) continue;
    const ids = [...new Set(v.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]{1,60}$/.test(s)))].slice(0, 60);
    if (ids.length) out[f] = ids;
  }
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------ reading a request */

export interface ThemeReading {
  intent: "apply_named" | "modify" | "create" | "structure" | "save_as" | "unknown_name" | "none";
  named?: { name: string; found: boolean; id?: string };
  /** the name a theme made from this description would be saved under, unless the person picks another */
  proposedName?: string;
  /** the built-in the look starts from, when the words chose one by feel ("healthcare", "consulting") */
  base?: string;
  patch: ThemePatch;
  /** the theme as it would look: base (named, felt or current) + patch, rules enforced; null for a structure-only or unknown-name request */
  preview: ThemeSpec | null;
  adjustments: ThemeAdjustment[];
  structure?: StructureRequest;
  saveAs?: string;
  understood: string[];
  unclear: string[];
  needsModel: boolean;
  brand?: { requested: boolean; colors: boolean; logo: boolean };
  /** what to ask when the request cannot be done as said */
  question?: string;
}

export interface ThemeContext {
  /** the theme applied to this project now */
  current?: ThemeSpec | null;
  /** the organisation's and the person's saved themes */
  saved?: readonly ThemeSpec[];
  /** brand assets on file (the survey's Branding: its colours and uploaded logo) */
  brand?: { colors: string[]; logoUrl?: string | null } | null;
}

const ADJ = String.raw`(?:(?:subtle|soft|muted|deep|dark|light|clean|bright|bold|rich|pale|warm|cool|crisp|pure|plain|elegant|strong|vivid|gentle)\s+)*`;
const colorWord = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length).map((w) => w.replace(/[-]/g, "[- ]?")).join("|");
const COLOR = String.raw`(#[0-9a-f]{6}|#[0-9a-f]{3}|${colorWord})`;
const resolveColor = (w: string): string | null => {
  const t = w.trim().toLowerCase().replace(/-/g, " ");
  if (t.startsWith("#")) return hex(t);
  return NAMED_COLORS[t] ?? NAMED_COLORS[t.replace(/ /g, "-")] ?? null;
};
const FONT_NAMES: Record<string, string> = { arial: "Arial", helvetica: "Arial", calibri: "Calibri", cambria: "Cambria", georgia: "Georgia", garamond: "Garamond", "times new roman": "Times New Roman", verdana: "Verdana", tahoma: "Tahoma", "segoe ui": "Segoe UI", inter: "Inter", aptos: "Aptos", "source serif": "Source Serif 4", montserrat: "Montserrat" };
const FEEL: [RegExp, string, string][] = [
  [/\b(healthcare|health\s*care|clinical|medical|pharma\w*|hospital|patients?)\b/, "builtin:healthcare_analytics", "a healthcare research look (Healthcare Analytics)"],
  [/\b(academic|scholarly|journal|apa|university|scientific|peer[- ]review\w*|thesis)\b/, "builtin:academic_research", "an academic look (Academic Research)"],
  [/\bbrand\s+(performance|tracking|tracker|health)\b|\bmarketing\s+(report|deck|presentation)\b/, "builtin:brand_performance", "a brand-performance look (Brand Performance)"],
  [/\b(consumer|shopper|lifestyle|retail)\b/, "builtin:consumer_insights", "a consumer-insights look (Consumer Insights)"],
  [/\b(executive|corporate|consulting|board|premium|leadership|c-suite)\b/, "builtin:executive_research", "an executive, corporate look (Executive Research)"],
];
const title = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Read a theme request. Order matters only where words overlap: a named theme
 * first (saved, then built-in), then the feel that picks a base, then colours
 * by role, type, tables, spacing, annotations, branding — each clause listed in
 * `understood` as it was read.
 */
export function interpretThemeRequest(text: string, ctx: ThemeContext = {}): ThemeReading {
  const raw = text.trim();
  const t = ` ${raw.toLowerCase().replace(/[“”"]/g, '"').replace(/\s+/g, " ")} `;
  const understood: string[] = [];
  const say = (s: string) => understood.push(s);
  const patch: ThemePatch = {};
  const colors: Partial<ThemeColors> = {};
  const saved = ctx.saved ?? [];

  /* save as */
  let saveAs: string | undefined;
  const sv = /\bsave\s+(?:it|this|that|the\s+theme|this\s+theme|the\s+look|this\s+look)?\s*as\s+(?:a\s+|the\s+|our\s+|my\s+)?(?:theme\s+)?"?([^".]+?)"?(?:\s+theme)?\s*(?:for\s+(?:the\s+)?(?:team|organi[sz]ation|company|workspace|me|myself))?\s*$/.exec(t);
  if (sv) { saveAs = title(sv[1]).slice(0, 80); say(`save the theme as “${saveAs}”`); }

  /* structure: "keep the content but reorganize around the main hypotheses and recommendations" */
  let structure: StructureRequest | undefined;
  if (/\b(re-?organi[sz]e|restructure|re-?order|rearrange|lead\s+with|open\s+with|start\s+with|put\s+.+\s+first)\b/.test(t)) {
    const keys: StructureSection[] = [];
    const want = (re: RegExp, k: StructureSection) => { const m = re.exec(t); if (m) keys.push(k); return m?.index ?? -1; };
    const at: [number, StructureSection][] = [];
    for (const [re, k] of [[/\bhypothes[ie]s\b/, "hypotheses"], [/\brecommendations?\b|\bnext\s+steps\b/, "recommendations"], [/\b(?:executive\s+)?summary\b/, "summary"], [/\b(?:key\s+)?findings\b/, "findings"], [/\bsegments?\b|\bwho\s+differs\b|\bdemographics?\b/, "segments"], [/\bimplications?\b|\bwhat\s+it\s+means\b/, "implications"], [/\bmethod(?:ology)?\b/, "method"], [/\bcaveats?\b|\blimitations?\b/, "caveats"]] as [RegExp, StructureSection][]) {
      const i = want(re, k); if (i >= 0) at.push([i, k]);
    }
    if (keys.length) {
      const order = at.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      /* the summary stays first unless the words move it */
      if (!order.includes("summary")) order.unshift("summary");
      const words = order.filter((k) => k !== "summary").join(" and ");
      structure = { order, understood: `sections reorganised around ${words}${/\bkeep\s+(?:the\s+)?content\b|\bsame\s+content\b/.test(t) ? " (content kept exactly as it is)" : ""}` };
      say(structure.understood);
    }
  }

  /* a theme by name: "apply the Healthcare Analytics theme", "use our Premium corporate theme" */
  let named: ThemeReading["named"];
  let candidate: string | undefined;
  const nm = /\b(?:apply|use|switch\s+to|change\s+to|go\s+with|pick|choose|make\s+it)\s+(?:the\s+|our\s+|my\s+|a\s+|an\s+)?(.{2,60}?)\s+(?:theme|style|look)\b/.exec(t);
  if (nm) candidate = nm[1].replace(/^(?:new|saved|usual|standard|house)\s+/, "").trim();
  const exact = [...saved, ...REPORT_THEMES].find((th) => t.includes(` ${themeNameKey(th.name)} `) || t.includes(` ${themeNameKey(th.name)} theme`));
  const byCandidate = candidate ? findReportTheme(candidate, saved) : null;
  const hit = byCandidate ?? exact ?? null;
  if (hit) { named = { name: hit.name, found: true, ...(hit.id ? { id: hit.id } : {}) }; say(`the ${hit.name} theme`); }
  else if (candidate && !/^(?:new|custom|different|another|this|that|it|a|the)$/.test(candidate)) named = { name: title(candidate), found: false };

  /* the feel picks a base when no theme was named */
  let base: ThemeSpec | undefined;
  /* a theme's NAME is not a description of it: "the Board Pack theme" is not a board look, "save it as Healthcare 2" not a healthcare one */
  let feelText = t;
  if (sv) feelText = feelText.replace(sv[0], " ");
  /* …unless the "name" is only description: "our premium corporate theme" IS premium and corporate */
  const descriptive = /^(?:(?:premium|corporate|executive|clean|modern|minimal|minimalist|classic|elegant|professional|consulting|healthcare|clinical|medical|academic|scholarly|consumer|bold|dark|light|simple|formal|sleek|crisp|neutral|warm|cool|restrained|muted|research|style|styled)[\s-]*)+$/;
  if (candidate && !hit && !descriptive.test(candidate)) feelText = feelText.replace(candidate, " ");
  if (hit) base = hit;
  else for (const [re, id, words] of FEEL) if (re.test(feelText)) { base = REPORT_THEMES.find((x) => x.id === id); say(words); break; }

  /* colours by role, with their adjectives: "navy headings", "subtle cyan accents", "clean white backgrounds" */
  const roleRe = new RegExp(String.raw`${ADJ}${COLOR}\s+(backgrounds?|backdrops?|pages?|text|body\s+text|type|headings?|titles?|headlines?|accents?|highlights?|table\s+headers?|tables?|charts?|primary)\b`, "g");
  for (const m of t.matchAll(roleRe)) {
    const col = resolveColor(m[1]); if (!col) continue;
    const role = m[2];
    if (/background|backdrop|page/.test(role)) { colors.background = col; colors.surface = isDark(col) ? mix(col, "#FFFFFF", 0.08) : mix(col, "#1B2A4A", 0.04); say(`${m[1]} backgrounds`); }
    else if (/text|type/.test(role)) { colors.text = col; say(`${m[1]} text`); }
    else if (/heading|title|headline/.test(role)) { colors.heading = col; say(`${m[1]} headings`); }
    else if (/accent|highlight/.test(role)) { colors.accent = col; say(`${m[1]} accents${/\bsubtle|soft|muted|gentle\b/.test(m[0]) ? " (used sparingly: rules, highlights, the second series)" : ""}`); }
    else if (/table/.test(role)) { colors.tableHeaderBg = col; colors.tableHeaderText = contrast("#FFFFFF", col) >= 4.5 ? "#FFFFFF" : "#111111"; say(`${m[1]} table headers`); }
    else if (/chart/.test(role)) { patch.chartPalette = [col]; say(`${m[1]} charts`); }
    else { colors.primary = col; say(`${m[1]} as the primary colour`); }
  }
  const pal = new RegExp(String.raw`${COLOR}\s*(?:,|and|&|\+)\s*${COLOR}(?:\s*(?:,|and|&|\+)\s*${COLOR})?\s+(?:palette|chart\s+colou?rs|charts|colou?r\s+scheme|scheme)\b`).exec(t);
  if (pal) { patch.chartPalette = [pal[1], pal[2], pal[3]].filter(Boolean).map((w) => resolveColor(w!)).filter((x): x is string => !!x); say(`a ${[pal[1], pal[2], pal[3]].filter(Boolean).join(", ")} chart palette`); }
  if (/\b(?:white|light)\s+backgrounds?\b/.test(t) && !colors.background) { colors.background = "#FFFFFF"; colors.surface = "#F5F7FA"; say("white backgrounds"); }
  if (/\bdark\s+(?:mode|theme|look|background)s?\b/.test(t) && !colors.background) { colors.background = "#0F1524"; colors.surface = "#172036"; colors.text = "#EEF2FF"; colors.muted = "#A9B4CC"; colors.heading = colors.heading ?? "#FFFFFF"; colors.border = "#2A3654"; colors.tableStripe = "#172036"; say("a dark background (in-app and PowerPoint; Word prints it as the page colour)"); }

  /* restrained colours: the palette eased toward grey, the accent with it */
  if (/\b(restrained|muted|understated|conservative|subdued|sober|calm)\s+(?:colou?rs?|palette|tones?)\b|\bcolou?rs?\s+(?:kept\s+)?(?:restrained|muted|understated)\b/.test(t)) {
    const b = base ?? ctx.current ?? DEFAULT_REPORT_THEME;
    patch.chartPalette = (patch.chartPalette ?? b.chartPalette).map((x) => mix(x, "#7F8A94", 0.28));
    if (!colors.accent) colors.accent = mix(b.colors.accent, "#7F8A94", 0.2);
    say("restrained colours (the chart palette and accent eased toward grey)");
  }

  /* typography */
  const typo: NonNullable<ThemePatch["typography"]> = {};
  for (const [w, f] of Object.entries(FONT_NAMES).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(String.raw`\b${w}\b(?:\s+(headings?|titles?|body|text))?`);
    const m = re.exec(t);
    if (!m) continue;
    if (m[1] && /heading|title/.test(m[1])) typo.heading = f; else if (m[1]) typo.body = f; else { typo.heading = typo.heading ?? f; typo.body = typo.body ?? f; }
    say(`${f}${m[1] ? ` ${m[1]}` : ""}`);
    break;
  }
  if (!typo.heading && /\bserif\s+(?:headings?|titles?)\b|\bserif\b(?!\s*-?\s*free)/.test(t) && !/\bsans[- ]?serif\b/.test(t)) { typo.heading = "Georgia"; say("serif headings (Georgia)"); }
  if (/\bsans[- ]?serif\b/.test(t) && !typo.body) { typo.heading = typo.heading ?? "Calibri"; typo.body = "Calibri"; say("sans-serif type (Calibri)"); }
  if (/\b(larger|bigger)\s+(?:headings?|titles?)\b/.test(t)) { typo.h1Pt = (base ?? ctx.current ?? DEFAULT_REPORT_THEME).typography.h1Pt + 3; say("larger headings"); }
  if (/\b(?:upper\s*case|all\s+caps|capitali[sz]ed)\s+(?:headings?|titles?)\b/.test(t)) { typo.headingCase = "upper"; say("upper-case headings"); }

  /* consulting style: Arial, action titles over a rule, minimal tables, generous space */
  if (/\bconsult(?:ing|ancy)(?:[- ]style)?\b|\bmckinsey|\bbcg\b|\bbain\b/.test(t)) {
    typo.heading = typo.heading ?? "Arial"; typo.body = typo.body ?? "Arial";
    patch.table = { ...(patch.table ?? {}), style: "minimal" };
    patch.layout = { ...(patch.layout ?? {}), titleRule: true, density: "airy" };
    say("a consulting-style layout (Arial, titles over a rule, minimal tables, generous spacing)");
  }
  if (Object.keys(typo).length) patch.typography = typo;

  /* tables, spacing, annotations */
  if (/\b(striped|zebra|banded)\b/.test(t)) { patch.table = { ...(patch.table ?? {}), style: "striped" }; say("striped tables"); }
  else if (/\b(minimal|clean|light|booktabs)\s+tables?\b|\bno\s+(?:table\s+)?grid\s*lines\b/.test(t)) { patch.table = { ...(patch.table ?? {}), style: "minimal" }; say("minimal tables"); }
  else if (/\b(boxed|bordered|grid(?:ded)?)\s+tables?\b/.test(t)) { patch.table = { ...(patch.table ?? {}), style: "grid" }; say("bordered tables"); }
  if (/\b(airy|spacious|generous\s+(?:spacing|white\s*space)|more\s+white\s*space|breathing\s+room)\b/.test(t) && patch.layout?.density !== "airy") { patch.layout = { ...(patch.layout ?? {}), density: "airy" }; say("airy spacing"); }
  if (/\b(compact|dense|tight(?:er)?\s+spacing|less\s+white\s*space)\b/.test(t)) { patch.layout = { ...(patch.layout ?? {}), density: "compact" }; say("compact spacing"); }
  if (/\bclear(?:er)?\s+(?:statistical\s+)?annotations?\b|\bstatistical\s+annotations?\s+(?:clear|visible|prominent)\b|\bshow\s+(?:the\s+)?(?:significance|p[- ]values|bases)\s+clearly\b/.test(t)) { patch.annotations = { emphasis: "clear" }; say("clear statistical annotations (tests, p-values and bases upright and darker, not faint italics)"); }

  /* header / footer */
  const ft = /\bfooter\s+(?:that\s+)?(?:says|saying|reading|reads|with|of|text)?\s*"([^"]{1,80})"/.exec(t) ?? /"([^"]{1,80})"\s+(?:in\s+the\s+|as\s+(?:the\s+)?)?footer\b/.exec(t);
  const hd = /\bheader\s+(?:that\s+)?(?:says|saying|reading|reads|with|of|text)?\s*"([^"]{1,80})"/.exec(t);
  const branding: NonNullable<ThemePatch["branding"]> = {};
  if (ft) { branding.footer = raw.slice(raw.toLowerCase().indexOf(ft[1]), raw.toLowerCase().indexOf(ft[1]) + ft[1].length) || ft[1]; say(`footer “${branding.footer}”`); }
  else if (/\bconfidential\b/.test(t)) { branding.footer = "Confidential"; say("footer “Confidential”"); }
  if (hd) { branding.header = raw.slice(raw.toLowerCase().indexOf(hd[1]), raw.toLowerCase().indexOf(hd[1]) + hd[1].length) || hd[1]; say(`header “${branding.header}”`); }
  if (/\b(?:no|without|hide|remove)\s+page\s+numbers?\b/.test(t)) { branding.pageNumbers = false; say("no page numbers"); }

  /* brand: the survey's own colours and uploaded logo, when they are on file */
  let brand: ThemeReading["brand"];
  const wantsBrand = /\b(?:our|my|the)\s+(?:brand(?:ing)?|corporate\s+colou?rs|brand\s+colou?rs|brand\s+identity)\b|\bbrand(?:ed)?\s+colou?rs\b|\bon[- ]brand\b/.test(t);
  const wantsLogo = /\blogo\b/.test(t) && !/\b(?:no|without|hide|remove)\s+(?:the\s+)?logo\b/.test(t);
  if (wantsBrand || wantsLogo) {
    const bc = (ctx.brand?.colors ?? []).map((x) => hex(x)).filter((x): x is string => !!x);
    const logoUrl = ctx.brand?.logoUrl ?? null;
    brand = { requested: true, colors: wantsBrand && bc.length > 0, logo: wantsLogo && !!logoUrl };
    if (wantsBrand) {
      if (bc.length) {
        colors.primary = colors.primary ?? bc[0]; colors.heading = colors.heading ?? bc[0];
        const acc = bc.find((x, i) => i > 0 && distinguishable(x, bc[0]));
        if (acc) colors.accent = colors.accent ?? acc;
        colors.tableHeaderBg = colors.tableHeaderBg ?? bc[0]; colors.tableHeaderText = contrast("#FFFFFF", bc[0]) >= 4.5 ? "#FFFFFF" : "#111111";
        patch.chartPalette = patch.chartPalette ?? [bc[0], ...(acc ? [acc] : []), ...bc.filter((x) => x !== bc[0] && x !== acc)];
        say(`the brand colours on file (${bc.slice(0, 3).join(", ")})`);
      } else say("brand colours requested — none are on file (set them in Branding)");
    }
    if (wantsLogo) {
      if (logoUrl) { branding.logo = { placement: /\bcover\b/.test(t) ? "cover" : "header", url: logoUrl }; say(`the uploaded logo, in the ${branding.logo.placement === "cover" ? "cover" : "page header"}`); }
      else say("logo requested — no logo is uploaded (add one in Branding)");
    }
  } else if (/\b(?:no|without|hide|remove)\s+(?:the\s+)?logo\b/.test(t)) { branding.logo = { placement: "none" }; say("no logo"); }
  if (Object.keys(branding).length) patch.branding = branding;

  /* a heading colour with no primary given leads the primary too; a new primary repaints a dark table header that followed the old one */
  if (colors.heading && !colors.primary) colors.primary = colors.heading;
  {
    const b = base ?? ctx.current ?? DEFAULT_REPORT_THEME;
    if (colors.primary && !colors.tableHeaderBg && b.colors.tableHeaderBg.toUpperCase() === b.colors.primary.toUpperCase()) { colors.tableHeaderBg = colors.primary; colors.tableHeaderText = contrast("#FFFFFF", colors.primary) >= 4.5 ? "#FFFFFF" : "#111111"; }
  }
  if (colors.accent && !patch.chartPalette) {
    const b = base ?? ctx.current ?? DEFAULT_REPORT_THEME;
    const first = colors.primary ?? b.chartPalette[0];
    patch.chartPalette = [first, colors.accent, ...b.chartPalette.filter((x) => x !== first && x !== colors.accent)].slice(0, 6);
  }
  if (Object.keys(colors).length) patch.colors = colors;

  /* what was not placed */
  const placedStyle = Object.keys(patch).length > 0 || !!base;
  const clauses = raw.split(/[.;,]|\band\b|\bwith\b|\bbut\b/i).map((s) => s.trim()).filter((s) => s.length > 3);
  const known = /(theme|style|look|apply|use|our|keep|content|reorgani|restructure|hypothes|recommend|summary|colou?r|palette|heading|title|accent|background|text|font|serif|sans|table|spacing|airy|compact|layout|annotation|statistic|logo|brand|footer|header|page|consult|executive|corporate|premium|healthcare|clinical|academic|consumer|presentation|restrained|muted|clean|white|navy|cyan|research|report|document|deck|save|name|arial|calibri|cambria|georgia|garamond|times|dark|light|striped|minimal)/i;
  const unclear = clauses.filter((c) => !known.test(c));

  /* the preview */
  let preview: ThemeSpec | null = null;
  let adjustments: ThemeAdjustment[] = [];
  const hasStyle = Object.keys(patch).length > 0;
  let intent: ThemeReading["intent"];
  let question: string | undefined;
  let proposedName: string | undefined;
  if (named && !named.found && !hasStyle && !base && !structure && !saveAs) {
    intent = "unknown_name";
    question = `There is no theme called “${named.name}”. Describe it — colours, headings, fonts, tables — and it can be created and saved under that name.`;
  } else if (saveAs && !hasStyle && !hit && !base) {
    intent = "save_as";
    preview = ctx.current ? enforceTheme(ctx.current).theme : null;
  } else if (structure && !hasStyle && !hit && !base) {
    intent = "structure";
  } else if (hit && !hasStyle) {
    intent = "apply_named";
    ({ theme: preview, adjustments } = enforceTheme(hit));
  } else if (brand && !hasStyle && !base && !hit) {
    intent = "none";
    question = "No brand colours or logo are on file for this project. Add them in Design → Branding (colours and an uploaded logo), then ask again — or describe the colours you want.";
  } else if (hasStyle || base) {
    intent = hit ? "modify" : "create";
    const start = base ?? ctx.current ?? DEFAULT_REPORT_THEME;
    ({ theme: preview, adjustments } = enforceTheme(mergeTheme(start, patch)));
    if (!hit) {
      proposedName = saveAs ?? (named && !named.found ? named.name : undefined) ?? (base ? `${base.name} (custom)` : brand?.colors ? "Brand theme" : "Custom theme");
      preview = { ...preview, name: proposedName };
      delete preview.id; delete preview.version;
      preview.description = raw.slice(0, 240);
    }
    if (saveAs) intent = intent === "create" ? "create" : "modify";
  } else intent = "none";
  const needsModel = raw.length > 0 && !brand && !question && (intent === "none" || (unclear.length > 0 && !placedStyle));
  return {
    intent, ...(named ? { named } : {}), ...(proposedName ? { proposedName } : {}), ...(base && !hit ? { base: base.id } : {}),
    patch, preview, adjustments, ...(structure ? { structure } : {}), ...(saveAs ? { saveAs } : {}), understood, unclear, needsModel, ...(brand ? { brand } : {}), ...(question ? { question } : {}),
  };
}

/* ------------------------------------------------------------ a model's answer, kept to the vocabulary */

export const THEME_PATCH_INSTRUCTIONS = `Read a request for the LOOK of research documents (Word reports, PowerPoint decks) into a JSON patch. Answer with JSON only, with only these keys, each optional: {"colors": {"primary","secondary","accent","background","surface","text","muted","heading","border","tableHeaderBg","tableHeaderText","tableStripe": "#RRGGBB"}, "chartPalette": ["#RRGGBB", …up to 8], "typography": {"heading","body": a common font family name such as Calibri, Arial, Cambria, Georgia, Garamond; "baseSizePt": 8–14, "h1Pt": 10–28, "h2Pt": 9–24, "headingWeight": "bold"|"regular", "headingCase": "none"|"upper"}, "table": {"style": "grid"|"minimal"|"striped"}, "layout": {"density": "compact"|"balanced"|"airy", "titleRule": boolean}, "annotations": {"emphasis": "subtle"|"clear"}}. Include only what the request asks for. Never add, remove, reword or reorder content, never mention data or numbers — this is the look only.`;

export function sanitizeThemePatch(input: unknown): ThemePatch {
  const o = (input ?? {}) as Record<string, unknown>;
  const out: ThemePatch = {};
  if (o.colors && typeof o.colors === "object") {
    const c: Partial<ThemeColors> = {};
    for (const k of Object.keys(DEFAULT_REPORT_THEME.colors) as (keyof ThemeColors)[]) { const v = hex((o.colors as Record<string, unknown>)[k]); if (v) c[k] = v; }
    if (Object.keys(c).length) out.colors = c;
  }
  if (Array.isArray(o.chartPalette)) { const xs = o.chartPalette.map(hex).filter((x): x is string => !!x).slice(0, 8); if (xs.length >= 2) out.chartPalette = xs; }
  if (o.typography && typeof o.typography === "object") {
    const t = o.typography as Record<string, unknown>; const ty: NonNullable<ThemePatch["typography"]> = {};
    const f = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9 \-]{2,40}$/.test(v.trim()) ? v.trim() : undefined);
    if (f(t.heading)) ty.heading = f(t.heading); if (f(t.body)) ty.body = f(t.body);
    for (const k of ["baseSizePt", "h1Pt", "h2Pt", "h3Pt"] as const) if (typeof t[k] === "number" && (t[k] as number) >= 8 && (t[k] as number) <= 28) ty[k] = t[k] as number;
    if (t.headingWeight === "bold" || t.headingWeight === "regular") ty.headingWeight = t.headingWeight;
    if (t.headingCase === "none" || t.headingCase === "upper") ty.headingCase = t.headingCase;
    if (Object.keys(ty).length) out.typography = ty;
  }
  if (o.table && typeof o.table === "object" && ["grid", "minimal", "striped"].includes((o.table as Record<string, unknown>).style as string)) out.table = { style: (o.table as { style: "grid" }).style };
  if (o.layout && typeof o.layout === "object") {
    const l = o.layout as Record<string, unknown>; const ly: NonNullable<ThemePatch["layout"]> = {};
    if (l.density === "compact" || l.density === "balanced" || l.density === "airy") ly.density = l.density;
    if (typeof l.titleRule === "boolean") ly.titleRule = l.titleRule;
    if (Object.keys(ly).length) out.layout = ly;
  }
  if (o.annotations && typeof o.annotations === "object" && ["subtle", "clear"].includes((o.annotations as Record<string, unknown>).emphasis as string)) out.annotations = { emphasis: (o.annotations as { emphasis: "clear" }).emphasis };
  return out;
}

/** a stored or sent theme, read defensively: anything unknown dropped, every rule enforced — null when it is not a theme at all */
export function readThemeSpec(input: unknown): ThemeSpec | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim() || !o.colors || typeof o.colors !== "object") return null;
  const patch = sanitizeThemePatch(o);
  const base = mergeTheme(DEFAULT_REPORT_THEME, patch);
  const b = (o.branding ?? {}) as Record<string, unknown>;
  const logo = (b.logo ?? {}) as Record<string, unknown>;
  base.branding = {
    pageNumbers: b.pageNumbers !== false,
    ...(typeof b.header === "string" && b.header.trim() ? { header: b.header.trim().slice(0, 120) } : {}),
    ...(typeof b.footer === "string" && b.footer.trim() ? { footer: b.footer.trim().slice(0, 120) } : {}),
    logo: { placement: logo.placement === "header" || logo.placement === "cover" ? logo.placement : "none", ...(typeof logo.url === "string" && logo.url.length < 400_000 ? { url: logo.url } : {}) },
  };
  if (o.table && typeof o.table === "object" && typeof (o.table as Record<string, unknown>).headerBold === "boolean") base.table.headerBold = (o.table as { headerBold: boolean }).headerBold;
  const para = (o.paragraph ?? {}) as Record<string, unknown>;
  if (typeof para.lineSpacing === "number") base.paragraph.lineSpacing = para.lineSpacing;
  if (typeof para.spaceAfterPt === "number") base.paragraph.spaceAfterPt = para.spaceAfterPt;
  const { theme } = enforceTheme({ ...base, name: o.name.trim().slice(0, 80), ...(typeof o.id === "string" ? { id: o.id } : {}), ...(typeof o.version === "number" ? { version: o.version } : {}), ...(typeof o.description === "string" ? { description: o.description.slice(0, 240) } : {}) });
  return theme;
}

/* ------------------------------------------------------------ one look, every format */

/**
 * The in-app report's and PowerPoint deck's theme (`ReportTheme`, which the
 * report renderer, `buildPptx`, `buildDeckPptx` and `buildXlsx` already read).
 */
export function themeToReportTheme(t: ThemeSpec): ReportTheme {
  const c = t.colors;
  return {
    ...(t.id && !t.id.startsWith("builtin:") ? { id: t.id } : {}),
    name: t.name,
    colors: { primary: c.primary, secondary: c.secondary, accent: c.accent, background: c.background, text: c.text, subtle: c.muted, palette: t.chartPalette.slice(0, 10) },
    fontFamily: `${t.typography.body}, system-ui, sans-serif`,
    headingFontFamily: `${t.typography.heading}, system-ui, sans-serif`,
    ...(t.branding.header ? { header: t.branding.header } : {}),
    ...(t.branding.footer ? { footer: t.branding.footer } : {}),
    ...(t.branding.logo.placement !== "none" && t.branding.logo.url?.startsWith("data:") ? { logoUrl: t.branding.logo.url } : {}),
    cover: { background: c.primary, textColor: contrast("#FFFFFF", c.primary) >= 4.5 ? "#ffffff" : "#111827", layout: "left" },
    chart: { gridLines: t.table.style !== "minimal", dataLabels: true },
    typography: { baseSize: Math.round(t.typography.baseSizePt + 1.5), titleSize: Math.round(t.typography.h1Pt + 1) },
  };
}

/** the Word documents' style tokens — hex without '#', sizes in half-points, spacing in twentieths of a point */
export interface DocStyle {
  ink: string; heading: string; subtle: string; accent: string; rule: string; headFill: string; headText: string; stripe: string | null; page: string | null;
  bodyFont: string; headingFont: string; bodySize: number; h1Size: number; h2Size: number; headingBold: boolean; upper: boolean;
  after: number; line: number; tableStyle: ThemeSpec["table"]["style"]; headerBold: boolean; clearAnnotations: boolean; titleRule: boolean;
  header?: string; footer?: string; pageNumbers: boolean;
  /** true when this is a theme (styles.xml then declares the heading styles); false for the documents' standard look, which stays exactly as it was */
  themed: boolean;
  name: string;
}
const bare = (h: string) => h.replace("#", "").toUpperCase();
export function docStyleOf(t: ThemeSpec | null | undefined): DocStyle {
  if (!t) return { ink: "16202E", heading: "16202E", subtle: "5F6B7D", accent: "1D4ED8", rule: "D5DBE4", headFill: "EEF1F6", headText: "5F6B7D", stripe: null, page: null, bodyFont: "Calibri", headingFont: "Calibri", bodySize: 21, h1Size: 30, h2Size: 24, headingBold: true, upper: false, after: 80, line: 240, tableStyle: "grid", headerBold: true, clearAnnotations: false, titleRule: false, pageNumbers: true, themed: false, name: DEFAULT_REPORT_THEME.name };
  const c = t.colors;
  const dens = t.layout.density === "airy" ? 1.5 : t.layout.density === "compact" ? 0.7 : 1;
  return {
    ink: bare(c.text), heading: bare(c.heading), subtle: bare(c.muted), accent: bare(c.accent), rule: bare(c.border),
    headFill: bare(c.tableHeaderBg), headText: bare(c.tableHeaderText), stripe: t.table.style === "striped" ? bare(c.tableStripe) : null,
    page: c.background.toUpperCase() === "#FFFFFF" ? null : bare(c.background),
    bodyFont: t.typography.body, headingFont: t.typography.heading,
    bodySize: Math.round(t.typography.baseSizePt * 2), h1Size: Math.round(t.typography.h1Pt * 2), h2Size: Math.round(t.typography.h2Pt * 2),
    headingBold: t.typography.headingWeight === "bold", upper: t.typography.headingCase === "upper",
    after: Math.round(t.paragraph.spaceAfterPt * 20 * dens), line: Math.round(240 * t.paragraph.lineSpacing),
    tableStyle: t.table.style, headerBold: t.table.headerBold, clearAnnotations: t.annotations.emphasis === "clear", titleRule: t.layout.titleRule,
    ...(t.branding.header ? { header: t.branding.header } : {}), ...(t.branding.footer ? { footer: t.branding.footer } : {}),
    pageNumbers: t.branding.pageNumbers, themed: true, name: t.name,
  };
}

/** "Executive Research · navy headings on white · Calibri · grid tables · balanced spacing" */
export function describeReportTheme(t: ThemeSpec): string {
  const c = t.colors;
  return `${t.name} · ${c.heading} headings, ${c.accent} accents on ${c.background} · ${t.typography.heading}${t.typography.heading !== t.typography.body ? ` / ${t.typography.body}` : ""} · ${t.table.style} tables · ${t.layout.density} spacing${t.annotations.emphasis === "clear" ? " · clear statistical annotations" : ""}${t.branding.logo.placement !== "none" ? ` · logo in the ${t.branding.logo.placement}` : ""}`;
}
