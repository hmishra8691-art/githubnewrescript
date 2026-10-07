/**
 * THE CANONICAL SURVEY MODEL — what every source becomes before it becomes Rescript.
 *
 *   Qualtrics QSF ─┐
 *   Decipher XML ──┤
 *   Word / PDF ────┼──► CanonicalSurvey ──► map.ts ──► SurveyDefinition
 *   Excel / CSV ───┤         (this file)      (one mapper, every source)
 *   text ──────────┘
 *
 * An adapter's only job is to read its format into these shapes, keeping the
 * SOURCE's identifiers (QID15, q1, "Country") and saying, for every element,
 * how sure it is. It never builds Rescript objects and never invents what the
 * source does not say: an instruction it cannot read becomes a `raw`
 * expression and an issue, not a guess.
 *
 * The model is deliberately closer to "what a survey IS" than to any one
 * platform: a question has a kind, options with codes, a display condition,
 * skips; the flow is blocks, pages, branches, randomizers, loops, embedded
 * data and ends. Anything a platform has beyond that is carried as `custom`
 * (with its code and the references found in it) so the report can say
 * exactly what was not reproduced.
 */

export type SourceFormat = "qsf" | "decipher" | "docx" | "xlsx" | "csv" | "pdf" | "text" | "json" | "unknown";
export type SourcePlatform = "qualtrics" | "decipher" | "document" | "spreadsheet" | "rescript" | "unknown";

/** how sure the adapter is about one element (UI upgrade §23) */
export type Confidence = "confirmed" | "high" | "review" | "ambiguous" | "unsupported";

export type CanonicalKind =
  | "single" | "multi" | "dropdown" | "multi_dropdown"
  | "text" | "textarea" | "numeric" | "date" | "time" | "email"
  | "matrix_single" | "matrix_multi" | "matrix_text" | "matrix_numeric" | "matrix_dropdown"
  | "ranking" | "slider" | "constant_sum" | "nps" | "stars"
  | "descriptive" | "hidden" | "calculated" | "file_upload" | "hotspot" | "conjoint" | "maxdiff"
  | "unknown";

export interface CanonicalOption {
  /** the source's id for the choice: Qualtrics choice id "3", Decipher row label "r3" */
  sourceId: string;
  /** the code written to the data: a recode value, a Decipher value, a printed number */
  code: string | number;
  label: string;
  exclusive?: boolean;
  otherSpecify?: boolean;
  /** kept in place when options are randomized */
  anchor?: boolean;
  displayLogic?: CExpr;
}

export interface CanonicalRow { sourceId: string; code: string; label: string; displayLogic?: CExpr }

export interface CanonicalValidation {
  kind: "min_value" | "max_value" | "min_length" | "max_length" | "min_selections" | "max_selections" | "integer" | "email" | "phone" | "zip" | "url" | "pattern" | "sum_equals" | "date_min" | "date_max";
  value?: number | string;
  message?: string;
}

/**
 * A condition, source-neutral.
 *
 *   ref      a question (optionally one of its options, rows, columns), an
 *            embedded field, a loop field or a quota — by SOURCE id
 *   op       what is compared: selected / notSelected / eq / ne / gt / … /
 *            answered / unanswered / displayed / contains
 *   group    AND / OR / NOT
 *   raw      source text the adapter could not read — never evaluated,
 *            always reported
 */
export type CExpr =
  | { t: "group"; op: "and" | "or" | "not"; children: CExpr[] }
  | { t: "cmp"; ref: CRef; op: COp; value?: string | number | (string | number)[]; value2?: string | number }
  | { t: "raw"; text: string; language: "qualtrics" | "python" | "javascript" | "text"; refs: string[]; reason: string }
  | { t: "const"; value: boolean };

export type COp =
  | "selected" | "notSelected" | "displayed" | "notDisplayed"
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  | "answered" | "unanswered" | "contains" | "notContains" | "matches" | "in" | "notIn" | "countGte" | "countLte" | "countEq";

export interface CRef {
  kind: "question" | "embedded" | "loop" | "quota" | "unknown";
  /** source id: QID15, q3, a field name, a loop field */
  id: string;
  /** a choice's SOURCE id (translated to its code by the mapper) */
  choice?: string;
  /** a matrix row's source id */
  row?: string;
  /** a matrix column's source id */
  col?: string;
}

export type CSkipTarget =
  | { kind: "question"; id: string }
  | { kind: "block"; id: string }
  | { kind: "end_of_block" }
  | { kind: "end"; status: "complete" | "screened" | "quota_full" | "terminated" }
  | { kind: "url"; url: string };

export interface CanonicalSkip { when: CExpr; to: CSkipTarget; label?: string }

export interface CanonicalCustom {
  /** "javascript" (Qualtrics QuestionJS), "python" (Decipher exec / validate / cond), "text" (a document instruction) */
  language: "javascript" | "python" | "qualtrics" | "text";
  code: string;
  /** where it lives: a question id, "flow", a block id */
  location: string;
  /** what it is for, as the source says: "question JavaScript", "exec", "validate", "skip instruction" */
  role: string;
  /** source identifiers found in the code — questions, fields, choices */
  refs: string[];
}

export interface CanonicalQuestion {
  sourceId: string;
  /** the variable/export name the source uses (Qualtrics DataExportTag, Decipher label) */
  variable: string;
  /** a display code when the source has one distinct from the variable (a printed "Q5") */
  code?: string;
  text: string;
  instruction?: string;
  kind: CanonicalKind;
  /** the source's own type words, for the report: "MC/SAVR", "radio", "Select all that apply" */
  sourceType: string;
  options: CanonicalOption[];
  rows: CanonicalRow[];
  required: boolean;
  validation: CanonicalValidation[];
  displayLogic?: CExpr;
  skips: CanonicalSkip[];
  randomizeOptions?: boolean;
  settings?: Record<string, unknown>;
  /** a calculated / hidden question's expression, in the source language */
  expression?: string;
  custom: CanonicalCustom[];
  confidence: Confidence;
  /** why the confidence is what it is */
  notes: string[];
}

export interface CanonicalEmbeddedField {
  name: string;
  source: "url" | "panel" | "static" | "expression";
  value?: string;
  dataType?: "string" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "url";
  /** the source's own description of the field */
  sourceType?: string;
}

/** the survey flow — the architecture, not just the questions (§6) */
export type CFlow =
  | { t: "block"; sourceId: string; title?: string; pages: string[][]; randomizeQuestions?: boolean; displayLogic?: CExpr; loop?: CLoop }
  | { t: "embedded"; sourceId: string; fields: CanonicalEmbeddedField[] }
  | { t: "branch"; sourceId: string; when: CExpr; children: CFlow[]; description?: string }
  | { t: "randomizer"; sourceId: string; show?: number; even?: boolean; children: CFlow[] }
  | { t: "group"; sourceId: string; title?: string; children: CFlow[] }
  | { t: "end"; sourceId: string; status: "complete" | "screened" | "quota_full" | "terminated"; message?: string; redirectUrl?: string }
  | { t: "quota_check"; sourceId: string; quotaIds: string[] }
  | { t: "unsupported"; sourceId: string; sourceType: string; detail: string };

export interface CLoop {
  /** "question": over a question's selected (or displayed / all) choices; "static": over a list */
  kind: "question" | "static";
  questionId?: string;
  filter?: "selected" | "notSelected" | "displayed" | "all";
  items?: { code: string; label: string; fields?: Record<string, string> }[];
  /** names for the reference columns a static loop carries (Qualtrics Loop & Merge fields, Decipher loopvars) */
  fieldNames?: string[];
  loopVar: string;
  randomize?: boolean;
}

export interface CanonicalQuota {
  sourceId: string;
  name: string;
  limit: number;
  when: CExpr;
  onFull: "terminate" | "continue" | "redirect";
  redirectUrl?: string;
  /**
   * A source-platform quota GROUP this quota belongs to (Qualtrics QG). The
   * mapper turns a group into ONE Rescript quota whose cells are its members
   * — the multi-cell quota Rescript already has — instead of dropping it.
   */
  group?: { id: string; name: string };
}

export interface Issue {
  /** where: "QID15", "QID15 · display logic", "Flow · Branch FL_4", "row 12 of Sheet1" */
  location: string;
  /** what kind of problem */
  type: "unsupported" | "custom_logic" | "ambiguous" | "converted" | "renamed" | "dropped" | "inferred" | "reference" | "validation" | "structure" | "parse";
  severity: "high" | "medium" | "low" | "info";
  message: string;
  suggestion?: string;
  /** whether an automatic conversion was attempted */
  autoAttempted: boolean;
  /** the source ids it concerns, for filtering and for the custom-logic selector */
  refs?: string[];
}

export interface CanonicalSurvey {
  source: {
    platform: SourcePlatform;
    format: SourceFormat;
    fileName: string;
    /** the survey's own name */
    title?: string;
    language?: string;
    /** a short stable hash of the file, so a re-import can be recognised (§26) */
    fingerprint: string;
  };
  questions: CanonicalQuestion[];
  flow: CFlow[];
  /** survey-level embedded fields not tied to a flow position (Decipher sample sources, a document's hidden list) */
  embedded: CanonicalEmbeddedField[];
  quotas: CanonicalQuota[];
  /** flow-level custom code (Decipher top-level exec, Qualtrics survey-level JS) */
  custom: CanonicalCustom[];
  issues: Issue[];
}

/** FNV-1a over the bytes, base36 — a fingerprint, not a security hash */
export function fingerprint(bytes: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}-${bytes.length.toString(36)}`;
}

/** every question id a CExpr reads */
export function exprRefs(e: CExpr | undefined, into: Set<string> = new Set()): Set<string> {
  if (!e) return into;
  if (e.t === "group") for (const c of e.children) exprRefs(c, into);
  else if (e.t === "cmp") into.add(e.ref.id);
  else if (e.t === "raw") for (const r of e.refs) into.add(r);
  return into;
}

/** true when some part of the expression could not be read */
export function exprHasRaw(e: CExpr | undefined): boolean {
  if (!e) return false;
  if (e.t === "raw") return true;
  if (e.t === "group") return e.children.some(exprHasRaw);
  return false;
}

/** strip tags and entities for a label */
export function plainText(html: string | undefined | null): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ").replace(/<\/p>\s*<p[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}

/** the counts the preview shows (§14) */
export interface CanonicalStats {
  questions: number;
  blocks: number;
  pages: number;
  pageBreaks: number;
  embeddedFields: number;
  hiddenVariables: number;
  displayLogic: number;
  skipLogic: number;
  branches: number;
  randomizers: number;
  loops: number;
  quotas: number;
  customLogic: number;
  validations: number;
}

export function canonicalStats(c: CanonicalSurvey): CanonicalStats {
  let blocks = 0, pages = 0, breaks = 0, emb = c.embedded.length, branches = 0, rand = 0, loops = 0;
  const walk = (fs: CFlow[]) => {
    for (const f of fs) {
      if (f.t === "block") { blocks++; pages += f.pages.length; breaks += Math.max(0, f.pages.length - 1); if (f.loop) loops++; if (f.randomizeQuestions) rand++; }
      else if (f.t === "embedded") emb += f.fields.length;
      else if (f.t === "branch") { branches++; walk(f.children); }
      else if (f.t === "randomizer") { rand++; walk(f.children); }
      else if (f.t === "group") walk(f.children);
    }
  };
  walk(c.flow);
  let display = 0, skip = 0, custom = c.custom.length, validations = 0;
  for (const q of c.questions) {
    if (q.displayLogic) display++;
    display += q.options.filter((o) => o.displayLogic).length;
    skip += q.skips.length;
    custom += q.custom.length;
    validations += q.validation.length;
  }
  return {
    questions: c.questions.filter((q) => q.kind !== "descriptive").length,
    blocks, pages, pageBreaks: breaks, embeddedFields: emb,
    hiddenVariables: c.questions.filter((q) => q.kind === "hidden" || q.kind === "calculated").length,
    displayLogic: display, skipLogic: skip, branches, randomizers: rand, loops, quotas: c.quotas.length,
    customLogic: custom, validations,
  };
}
