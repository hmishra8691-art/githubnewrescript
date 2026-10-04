import type { Condition, Question, SurveyDefinition } from "@rescript/schema";
import { stripHtmlText } from "@rescript/engine";

/*
 * QUOTA SHEETS (research-intelligence Phase 4): the Excel or CSV a client or
 * a panel sends — "Gender × Age, 500 completes, these targets" — read into
 * quotas the researcher approves in Changes. Three layouts are recognised:
 *
 *   LONG     one row per cell: dimension columns (Gender, Age…), a target
 *            column (Target / N / Quota / % …), optional Quota/Group and
 *            Label columns; a "Total" row gives the total
 *   MATRIX   a cross-tab: the row dimension down the first column, the
 *            column dimension across the first row, targets in the body,
 *            "Total" rows and columns ignored
 *   LIST     two columns, a label and a number
 *
 * Nothing is guessed: a header that names no question, a value that names
 * no option or range, a target that is not a number — each is an issue by
 * row, and that cell is left out, never approximated.
 */

export interface QuotaSheetCell { label: string; dims: { header: string; value: string }[]; target: number; percent: boolean; row: number }
export interface QuotaSheetQuota { name: string; sheet: string; layout: "long" | "matrix" | "list"; dimensions: string[]; cells: QuotaSheetCell[]; total?: number }
export interface QuotaSheet { quotas: QuotaSheetQuota[]; issues: string[]; /** 0–1: how sure the reader is that this is a quota sheet at all */ confidence: number }

const TARGET_RE = /^(?:target|targets|n|quota|quotas|limit|max(?:imum)?|cap|count|completes?|interviews|sample|required|needed|goal|total|#|number|qty|size|%|percent(?:age)?|share|prop(?:ortion)?)(?:\s*\(?(?:n|%|completes?)\)?)?$/i;
const PERCENT_RE = /%|percent|share|prop/i;
const NAME_RE = /^(?:quota|group|quota ?group|quota name|name|segment)$/i;
const LABEL_RE = /^(?:label|cell|cell label|description|desc)$/i;
const SKIP_RE = /^(?:notes?|comments?|status|achieved|current|actual|remaining|to go|complete[sd]? so far|id)$/i;
const TOTAL_RE = /^(?:total|all|overall|sum|grand total|base)$/i;

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
export function parseTarget(v: string): { value: number; percent: boolean } | null {
  const t = clean(v).replace(/,/g, "");
  if (!t) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*(%)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return { value: n, percent: !!m[2] };
}

function isBlankRow(r: string[]): boolean { return r.every((c) => !clean(c)); }
function headerRowIndex(rows: string[][]): number {
  // the first row with at least two filled cells, one of which looks like a target header
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i].map(clean);
    if (r.filter(Boolean).length >= 2 && r.some((c) => TARGET_RE.test(c)) && !r.every((c) => !c || parseTarget(c))) return i;
  }
  return -1;
}

function readLong(sheet: { name: string; rows: string[][] }, issues: string[]): QuotaSheetQuota[] | null {
  const hi = headerRowIndex(sheet.rows);
  if (hi < 0) return null;
  const header = sheet.rows[hi].map(clean);
  const nameCol = header.findIndex((c) => NAME_RE.test(c));
  // the target column: of the target-like headers (not the quota's name column), the one with the most numbers under it
  const body = sheet.rows.slice(hi + 1);
  const numericUnder = (i: number) => body.filter((r) => parseTarget(clean(r[i] ?? ""))).length;
  const tcol = header.map((c, i) => ({ c, i })).filter(({ c, i }) => c && i !== nameCol && TARGET_RE.test(c)).sort((a, b) => numericUnder(b.i) - numericUnder(a.i) || (TOTAL_RE.test(a.c) ? 1 : 0) - (TOTAL_RE.test(b.c) ? 1 : 0))[0]?.i ?? -1;
  if (tcol < 0) return null;
  const labelCol = header.findIndex((c) => LABEL_RE.test(c));
  const dimCols = header.map((c, i) => ({ c, i })).filter(({ c, i }) => c && i !== tcol && i !== nameCol && i !== labelCol && !SKIP_RE.test(c) && !TARGET_RE.test(c)).map(({ i }) => i);
  if (!dimCols.length && labelCol < 0) return null;
  const percentHeader = PERCENT_RE.test(header[tcol]);
  const byName = new Map<string, QuotaSheetQuota>();
  let total: number | undefined;
  for (let i = hi + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i].map(clean);
    if (isBlankRow(r)) continue;
    const firstText = r.find((c) => c && !parseTarget(c)) ?? "";
    if (TOTAL_RE.test(firstText)) { const t = parseTarget(r[tcol] ?? ""); if (t && !t.percent) total = t.value; continue; }
    const t = parseTarget(r[tcol] ?? "");
    if (!t) { issues.push(`${sheet.name} row ${i + 1}: “${r[tcol] || "—"}” is not a number, so this cell was left out.`); continue; }
    const dims = dimCols.map((c) => ({ header: header[c], value: r[c] })).filter((d) => d.value && !TOTAL_RE.test(d.value));
    const label = (labelCol >= 0 && r[labelCol]) || dims.map((d) => d.value).join(" × ");
    if (!label) { issues.push(`${sheet.name} row ${i + 1}: no label and no dimension values — left out.`); continue; }
    const name = (nameCol >= 0 && r[nameCol]) || sheet.name;
    const q = byName.get(name) ?? { name, sheet: sheet.name, layout: "long" as const, dimensions: dimCols.map((c) => header[c]), cells: [] };
    byName.set(name, q);
    q.cells.push({ label, dims, target: t.value, percent: t.percent || percentHeader, row: i + 1 });
  }
  const out = [...byName.values()].filter((q) => q.cells.length);
  for (const q of out) { q.dimensions = q.dimensions.filter((d) => q.cells.some((c) => c.dims.some((x) => x.header === d))); if (total !== undefined) q.total = total; }
  return out.length ? out : null;
}

function readMatrix(sheet: { name: string; rows: string[][] }, issues: string[]): QuotaSheetQuota[] | null {
  const rows = sheet.rows.filter((r) => !isBlankRow(r)).map((r) => r.map(clean));
  if (rows.length < 3) return null;
  const head = rows[0];
  const colLabels = head.slice(1);
  if (colLabels.filter(Boolean).length < 2 || colLabels.some((c) => c && parseTarget(c))) return null;
  const body = rows.slice(1);
  if (body.some((r) => !r[0] || parseTarget(r[0]))) return null;
  const numericBody = body.every((r) => r.slice(1, colLabels.length + 1).every((c) => !c || parseTarget(c)));
  if (!numericBody) return null;
  // the corner names the dimensions: "Age / Gender", "Age by Gender", "Age × Gender" — else the row dimension alone
  const corner = head[0];
  const parts = corner.split(/\s*(?:\/|×|x|by|\\|vs\.?)\s*/i).map(clean).filter(Boolean);
  const rowDim = parts[0] || "Rows";
  const colDim = parts[1] || "Columns";
  if (!parts[1]) issues.push(`${sheet.name}: the corner cell “${corner || "(empty)"}” names only one dimension — the columns (${colLabels.filter((c) => c && !TOTAL_RE.test(c)).slice(0, 3).join(", ")}…) are matched to a question by their values.`);
  const cells: QuotaSheetCell[] = [];
  let total: number | undefined;
  let percent = false;
  body.forEach((r, ri) => {
    const rowLabel = r[0];
    const isTotalRow = TOTAL_RE.test(rowLabel);
    colLabels.forEach((cl, ci) => {
      if (!cl) return;
      const t = parseTarget(r[ci + 1] ?? "");
      if (!t) return;
      if (isTotalRow && TOTAL_RE.test(cl)) { if (!t.percent) total = t.value; return; }
      if (isTotalRow || TOTAL_RE.test(cl)) return;
      percent = percent || t.percent;
      cells.push({ label: `${rowLabel} × ${cl}`, dims: [{ header: rowDim, value: rowLabel }, { header: colDim, value: cl }], target: t.value, percent: t.percent, row: ri + 2 });
    });
  });
  if (!cells.length) return null;
  return [{ name: sheet.name, sheet: sheet.name, layout: "matrix", dimensions: [rowDim, colDim], cells, ...(total !== undefined ? { total } : {}) }];
}

function readList(sheet: { name: string; rows: string[][] }, issues: string[]): QuotaSheetQuota[] | null {
  const rows = sheet.rows.filter((r) => !isBlankRow(r)).map((r) => r.map(clean));
  const twoCol = rows.filter((r) => r.filter(Boolean).length >= 2);
  if (twoCol.length < 2) return null;
  const cells: QuotaSheetCell[] = []; let total: number | undefined;
  rows.forEach((r, i) => {
    const label = r.find((c) => c && !parseTarget(c));
    const t = r.map((c) => parseTarget(c)).find((x) => x);
    if (!label || !t) return;
    if (TOTAL_RE.test(label)) { if (!t.percent) total = t.value; return; }
    if (TARGET_RE.test(label)) return;
    cells.push({ label, dims: [], target: t.value, percent: t.percent, row: i + 1 });
  });
  if (cells.length < 2) return null;
  void issues;
  return [{ name: sheet.name, sheet: sheet.name, layout: "list", dimensions: [], cells, ...(total !== undefined ? { total } : {}) }];
}

export function readQuotaSheet(sheets: { name: string; rows: string[][] }[]): QuotaSheet {
  const issues: string[] = [];
  const quotas: QuotaSheetQuota[] = [];
  let score = 0;
  for (const sheet of sheets) {
    if (!sheet.rows.some((r) => !isBlankRow(r))) continue;
    const matrix = readMatrix(sheet, issues);
    if (matrix) { quotas.push(...matrix); score = Math.max(score, 0.8); continue; }
    const long = readLong(sheet, issues);
    if (long) { quotas.push(...long); score = Math.max(score, 0.9); continue; }
    const list = readList(sheet, issues);
    if (list) { quotas.push(...list); score = Math.max(score, 0.5); continue; }
    issues.push(`${sheet.name}: no quota layout recognised (a target column with dimension columns, a cross-tab with targets in the body, or a label + number list).`);
  }
  // several quotas with the same name across sheets stay apart by sheet name
  const seen = new Map<string, number>();
  for (const q of quotas) { const n = (seen.get(q.name) ?? 0) + 1; seen.set(q.name, n); if (n > 1) q.name = `${q.name} (${q.sheet} ${n})`; }
  return { quotas, issues, confidence: quotas.length ? score : 0 };
}

/* ------------------------------------------------------------ to actions */

export interface QuotaSheetMapping {
  /** the create_quota actions, one per sheet quota — only cells that resolved */
  actions: Record<string, unknown>[];
  issues: string[];
  /** header → the question it was matched to (code), for the preview */
  matched: Record<string, string>;
}

const norm = (s: string) => stripHtmlText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** the question a column header names: by code, variable, exact text, then by distinctive words of the text */
export function matchQuestion(def: SurveyDefinition, header: string, hint?: string[]): Question | undefined {
  const h = norm(header);
  if (!h) return undefined;
  const asked = def.questions.filter((q) => !["html", "hidden", "calculated", "embedded_data", "custom_component"].includes(q.type));
  const words = h.split(" ").filter((w) => w.length > 2);
  const scored = asked.map((q) => {
    const direct = String(q.code).toLowerCase() === h || q.variableName.toLowerCase() === h || norm(q.variableName).replace(/ /g, "") === h.replace(/ /g, "");
    const exactText = norm(q.text) === h;
    const text = `${norm(q.text)} ${norm(q.variableName)} ${norm(q.instruction ?? "")}`;
    const hits = words.filter((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "u").test(text) || text.includes(w)).length;
    // the values decide: a question whose options ARE the sheet's values is the one, over a question that merely shares the header's name
    const optionHits = hint?.length ? hint.filter((v) => (q.options ?? []).some((o) => norm(o.label) === norm(v))).length : 0;
    const score = (direct ? 2 : 0) + (exactText ? 1.5 : 0) + hits / Math.max(1, words.length) + (optionHits ? 2 + optionHits / hint!.length : 0);
    return { q, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return undefined;
  if (scored.length > 1 && scored[0].score === scored[1].score) return undefined; // a tie is no match
  return scored[0].score >= 0.5 ? scored[0].q : undefined;
}

/** "18-24", "18–24", "18 to 24", "55+", "65 and over", "under 18", "<18", "18 or younger" → a numeric rule; null when it is not a range */
export function parseRange(v: string): { min?: number; max?: number } | null {
  const t = clean(v).toLowerCase().replace(/years?( old)?|yrs?|y\.o\./g, "").replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)\s*(?:-|–|—|to|through|thru)\s*(\d+)$/.exec(t))) return { min: Number(m[1]), max: Number(m[2]) };
  if ((m = /^(\d+)\s*(?:\+|and (?:over|above|older|up)|or (?:more|older|over|above))$/.exec(t))) return { min: Number(m[1]) };
  if ((m = /^(?:over|above|more than|older than|>)\s*(\d+)$/.exec(t))) return { min: Number(m[1]) + 1 };
  if ((m = /^(?:>=|at least|minimum|min)\s*(\d+)$/.exec(t))) return { min: Number(m[1]) };
  if ((m = /^(?:under|below|less than|younger than|<)\s*(\d+)$/.exec(t))) return { max: Number(m[1]) - 1 };
  if ((m = /^(?:<=|up to|at most|maximum|max)\s*(\d+)$/.exec(t))) return { max: Number(m[1]) };
  if ((m = /^(\d+)\s*(?:and (?:under|below|younger)|or (?:less|younger|under|below))$/.exec(t))) return { max: Number(m[1]) };
  return null;
}

function ruleFor(def: SurveyDefinition, q: Question, value: string): Condition | string {
  const options = q.options ?? [];
  const v = norm(value);
  const choice = ["single_select", "dropdown", "image_select", "multi_select", "multi_dropdown"].includes(q.type);
  const multi = q.type === "multi_select" || q.type === "multi_dropdown";
  if (choice) {
    // one option by label or code, or several joined with / , & +
    const parts = value.split(/\s*(?:\/|,|&|\+| or | and )\s*/i).map(clean).filter(Boolean);
    const hits = parts.map((p) => options.find((o) => norm(o.label) === norm(p)) ?? options.find((o) => String(o.code).toLowerCase() === p.toLowerCase()) ?? options.find((o) => norm(o.label).startsWith(norm(p)) && norm(p).length >= 3));
    if (hits.every((h) => h)) {
      const codes = hits.map((h) => h!.code);
      return codes.length === 1
        ? { type: "rule", source: { kind: "question", ref: q.id }, operator: multi ? "selected" : "eq", value: codes[0] } as Condition
        : { type: "rule", source: { kind: "question", ref: q.id }, operator: multi ? "containsAny" : "in", value: codes } as Condition;
    }
    // a range of numeric-looking option labels ("18-24" against options 18-24 / 25-34) was tried above; a range over coded ages is not a choice
    return `${q.code} has no option “${value}” (its options are ${options.map((o) => stripHtmlText(o.label)).join(", ")})`;
  }
  if (["numeric", "slider", "nps"].includes(q.type)) {
    const r = parseRange(value);
    if (!r) { const n = parseTarget(value); if (n && !n.percent) return { type: "rule", source: { kind: "question", ref: q.id }, operator: "eq", value: n.value } as Condition; return `“${value}” is not a range ${q.code} understands (18–24, 55+, under 18)`; }
    if (r.min !== undefined && r.max !== undefined) return { type: "rule", source: { kind: "question", ref: q.id }, operator: "between", value: r.min, value2: r.max } as Condition;
    if (r.min !== undefined) return { type: "rule", source: { kind: "question", ref: q.id }, operator: "gte", value: r.min } as Condition;
    return { type: "rule", source: { kind: "question", ref: q.id }, operator: "lte", value: r.max } as Condition;
  }
  if (q.type === "open_text") return { type: "rule", source: { kind: "question", ref: q.id }, operator: "eq", value } as Condition;
  void v;
  return `${q.code} is a ${q.type.replace(/_/g, " ")} question — a quota cannot be set on it from a sheet`;
}

/**
 * The sheet as create_quota actions against THIS survey: every header a
 * question, every value an option or a range, every target a number — the
 * rest reported by row and left out.
 */
export function quotaSheetActions(def: SurveyDefinition, sheet: QuotaSheet, opts: { onFull?: "terminate" | "flag"; mode?: "hard" | "soft" } = {}): QuotaSheetMapping {
  const actions: Record<string, unknown>[] = [];
  const issues: string[] = [...sheet.issues];
  const matched: Record<string, string> = {};
  const existing = new Set(def.quotas.map((q) => q.name.trim().toLowerCase()));
  for (const q of sheet.quotas) {
    // the headers → questions, helped by the values under each
    const questions = new Map<string, Question | null>();
    for (const h of q.dimensions) {
      const values = [...new Set(q.cells.flatMap((c) => c.dims.filter((d) => d.header === h).map((d) => d.value)))];
      const hit = matchQuestion(def, h, values);
      questions.set(h, hit ?? null);
      if (hit) matched[h] = String(hit.code); else issues.push(`${q.sheet}: no question matches the column “${h}” — name it like the question's code, variable or text (${def.questions.slice(0, 6).map((x) => x.code).join(", ")}…).`);
    }
    const cells: Record<string, unknown>[] = [];
    for (const c of q.cells) {
      if (!c.dims.length) {
        // a list: the label itself must name an option of some question, or a range of a numeric one
        const candidates = def.questions.map((cand) => ({ cand, r: ruleFor(def, cand, c.label) })).filter((x) => typeof x.r !== "string" && (x.cand.options?.some((o) => norm(o.label) === norm(c.label)) || parseRange(c.label)));
        if (candidates.length !== 1) { issues.push(`${q.sheet} row ${c.row}: “${c.label}” ${candidates.length ? "matches more than one question" : "names no option of any question"} — add a column with the question.`); continue; }
        cells.push({ label: c.label, when: candidates[0].r, ...(c.percent ? { percent: c.target } : { limit: c.target }) });
        continue;
      }
      const rules: Condition[] = []; let bad = false;
      for (const d of c.dims) {
        const qq = questions.get(d.header);
        if (!qq) { bad = true; break; }
        const r = ruleFor(def, qq, d.value);
        if (typeof r === "string") { issues.push(`${q.sheet} row ${c.row}: ${r} — the cell “${c.label}” was left out.`); bad = true; break; }
        rules.push(r);
      }
      if (bad) continue;
      cells.push({ label: c.label, when: rules.length === 1 ? rules[0] : { type: "group", op: "and", children: rules }, ...(c.percent ? { percent: c.target } : { limit: c.target }) });
    }
    if (!cells.length) { issues.push(`${q.sheet}: none of the ${q.cells.length} cells of “${q.name}” could be matched to the survey, so no quota was made from it.`); continue; }
    const percent = cells.some((c) => c.percent !== undefined);
    const sum = q.cells.filter((c) => !c.percent).reduce((s, c) => s + c.target, 0);
    const total = q.total ?? (percent ? undefined : sum);
    if (percent && total === undefined) { issues.push(`${q.sheet}: “${q.name}” gives percentages but no total — add a Total row, or tell the copilot the number of completes.`); continue; }
    let name = q.name;
    if (existing.has(name.toLowerCase())) name = `${name} (imported)`;
    actions.push({ op: "create_quota", name, cells, ...(total !== undefined ? { total } : {}), ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.onFull ? { onFull: opts.onFull } : {}) });
    if (cells.length < q.cells.length) issues.push(`${q.sheet}: ${q.cells.length - cells.length} of ${q.cells.length} cells of “${q.name}” were left out (see above).`);
  }
  return { actions, issues, matched };
}
