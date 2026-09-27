import type { CanonicalSurvey, CanonicalQuestion, CanonicalOption, CFlow, CanonicalKind, Issue, SourceFormat } from "../canonical.js";
import { readDocument } from "./document.js";
import type { DocBlock } from "./docx.js";

/**
 * A QUESTIONNAIRE AS A TABLE → CANONICAL (§20).
 *
 * No one template is required. The reader finds the header row by the words
 * in it (ID / Variable / Question / Type / Options / Logic / Section /
 * Notes, in the spellings people use), then reads one of the layouts
 * researchers actually write:
 *
 *   wide   one row per question; its options in one cell ("1=Yes; 2=No",
 *          one per line, "Yes | No") or across Option 1…n columns
 *   long   a question row, then its options on the following rows with the
 *          ID / question cells empty (an optional code column beside them)
 *
 * The type column is mapped from the words in it; logic cells are read the
 * same way a Word questionnaire's instructions are — by handing the table,
 * reconstructed as lines, to the document reader, which already knows
 * "ASK IF Q3 = 1". When no header row can be found, the sheet is read as
 * text, top to bottom.
 */

type Col = "id" | "variable" | "text" | "type" | "options" | "code" | "logic" | "section" | "notes" | "required" | "option_n";
const HEADERS: [Col, RegExp][] = [
  ["id", /^(?:q(?:uestion)?\s*(?:id|no\.?|number|#|code)|qid|id|no\.?|#|q#|item)$/i],
  ["variable", /^(?:var(?:iable)?(?:\s*name)?|name|data\s*label|export\s*tag|column)$/i],
  ["text", /^(?:question(?:\s*text)?|text|wording|label|item\s*text|question\s*wording)$/i],
  ["type", /^(?:(?:question|response|answer)?\s*type|format|q\s*type|kind)$/i],
  ["options", /^(?:options?|answers?|choices?|responses?|answer\s*(?:options|list|codes)|response\s*(?:options|list)|codes?\s*(?:and|&)\s*labels?|values?)$/i],
  ["code", /^(?:codes?|value|punch|option\s*code)$/i],
  ["logic", /^(?:logic|routing|skip(?:\s*logic)?|display(?:\s*logic)?|conditions?|filter|base|ask\s*if|instructions?\s*\/\s*logic)$/i],
  ["section", /^(?:section|block|module|part|page|group)$/i],
  ["notes", /^(?:notes?|instructions?|programmer\s*notes?|comments?|prog\s*notes?)$/i],
  ["required", /^(?:required|mandatory|forced?)$/i],
  ["option_n", /^(?:option|answer|choice|response|code)\s*\d+$/i],
];

export function readTable(sheets: { name: string; rows: string[][] }[], meta: { fileName: string; format: SourceFormat; fingerprint: string; title?: string }): CanonicalSurvey {
  const issues: Issue[] = [];
  let best: { sheet: string; rows: string[][]; header: number; cols: Map<number, Col> } | null = null;
  const candidates: string[] = [];
  for (const s of sheets) {
    for (let h = 0; h < Math.min(15, s.rows.length); h++) {
      const cols = new Map<number, Col>();
      s.rows[h].forEach((cell, i) => { const t = cell.trim(); const hit = HEADERS.find(([, re]) => re.test(t)); if (hit) cols.set(i, hit[0]); });
      const kinds = new Set(cols.values());
      if (kinds.has("text") && (kinds.has("id") || kinds.has("variable") || kinds.has("options") || kinds.has("type") || kinds.has("option_n"))) {
        candidates.push(`${s.name} row ${h + 1}`);
        if (!best || cols.size > best.cols.size) best = { sheet: s.name, rows: s.rows, header: h, cols };
        break;
      }
    }
  }
  if (candidates.length > 1) issues.push({ location: candidates.join(", "), type: "ambiguous", severity: "low", message: `More than one sheet looks like a questionnaire (${candidates.join("; ")}); “${best!.sheet}” was read.`, suggestion: "Remove the other sheets, or confirm this is the right one.", autoAttempted: true });
  if (!best) {
    // no header: the sheet as text, top to bottom
    const blocks: DocBlock[] = sheets.flatMap((s) => s.rows.map((r) => r.map((c) => c.trim()).filter(Boolean).join("  "))).filter(Boolean).map((text) => ({ kind: "para" as const, text }));
    const c = readDocument(blocks, meta);
    c.source.platform = "spreadsheet";
    c.issues.unshift({ location: sheets[0]?.name ?? meta.fileName, type: "inferred", severity: "medium", message: "No header row (ID / Question / Type / Options…) was found, so the sheet was read as text, top to bottom.", suggestion: "Add a header row naming the columns for a more exact import.", autoAttempted: true });
    return c;
  }
  const { rows, header, cols } = best;
  const colOf = (k: Col) => [...cols.entries()].filter(([, v]) => v === k).map(([i]) => i);
  const cell = (r: string[], k: Col) => { const i = colOf(k)[0]; return i === undefined ? "" : (r[i] ?? "").trim(); };
  const questions: CanonicalQuestion[] = [];
  const sectionOf = new Map<string, string>();
  const logicLines = new Map<string, string[]>();
  let cur: CanonicalQuestion | null = null;
  let auto = 0;
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some((c) => c.trim())) continue;
    const id = cell(r, "id") || cell(r, "variable");
    const text = cell(r, "text");
    if (id || (text && (!cur || /\?\s*$/.test(text) || text.length > 40) && !cell(r, "code"))) {
      const code = (id || `Q${++auto}`).replace(/\s+/g, "");
      const q: CanonicalQuestion = {
        sourceId: code, variable: cell(r, "variable") || code, code, text: text || code, kind: "unknown", sourceType: cell(r, "type") || "spreadsheet row",
        options: [], rows: [], required: !/^(?:no|n|false|0|optional)$/i.test(cell(r, "required")), validation: [], skips: [], custom: [], confidence: "high", notes: [`${best.sheet} row ${i + 1}`],
      };
      if (!id) q.notes.push("numbered by the import — the row has no ID");
      for (const opt of parseOptionCell(cell(r, "options"))) q.options.push(opt);
      for (const ci of colOf("option_n")) { const v = (r[ci] ?? "").trim(); if (v) q.options.push(...parseOptionCell(v, q.options.length)); }
      const sec = cell(r, "section"); if (sec) sectionOf.set(code, sec);
      const logic = [cell(r, "logic"), cell(r, "notes")].filter(Boolean);
      if (logic.length) logicLines.set(code, logic);
      q.kind = kindFromTypeCell(cell(r, "type"), q);
      if (q.kind === "unknown") q.kind = q.options.length ? "single" : "textarea";
      questions.push(q);
      cur = q;
    } else if (cur) {
      // a long-layout option row: label in the text or options column, code beside it
      const label = cell(r, "options") || text;
      const code = cell(r, "code");
      if (label) {
        const parsed = parseOptionCell(code ? `${code}=${label}` : label, cur.options.length);
        cur.options.push(...parsed);
        if (cur.kind === "textarea" || cur.kind === "unknown") cur.kind = kindFromTypeCell(cur.sourceType, cur) === "unknown" ? "single" : kindFromTypeCell(cur.sourceType, cur);
      }
    }
  }
  /*
   * LOGIC: the document reader already understands "ASK IF Q3 = 1" and
   * "SKIP TO Q10". Hand it the questions, options and logic cells as lines
   * and take its reading of the logic — with the questions' kinds as the
   * table said, not as re-inferred from text.
   */
  const lines: DocBlock[] = [];
  let lastSection = "";
  for (const q of questions) {
    const sec = sectionOf.get(q.sourceId);
    if (sec && sec !== lastSection) { lines.push({ kind: "para", text: `SECTION ${sec.replace(/^(?:section|block)\s*/i, "")}`, style: "heading 2" }); lastSection = sec; }
    for (const l of logicLines.get(q.sourceId) ?? []) if (/^\s*(?:ask|show|display|base|filter)\b/i.test(l)) lines.push({ kind: "para", text: l.replace(/\n/g, " ") });
    lines.push({ kind: "para", text: `${q.sourceId}. ${q.text}` });
    for (const o of q.options) lines.push({ kind: "para", text: `${o.code}. ${o.label}` });
    for (const l of logicLines.get(q.sourceId) ?? []) if (!/^\s*(?:ask|show|display|base|filter)\b/i.test(l)) for (const part of l.split(/\n|(?<=\.)\s+(?=IF\b)/i)) if (part.trim()) lines.push({ kind: "para", text: `[${part.trim()}]` });
  }
  const read = readDocument(lines, { ...meta, title: meta.title ?? best.sheet });
  const readBy = new Map(read.questions.map((q) => [q.sourceId.toUpperCase(), q]));
  for (const q of questions) {
    const r = readBy.get(q.sourceId.toUpperCase());
    if (!r) continue;
    q.displayLogic = r.displayLogic;
    q.skips = r.skips;
    if (r.confidence === "ambiguous") q.confidence = "ambiguous";
    // the document reader's options may carry annotations it understood (exclusive, specify)
    if (r.options.length === q.options.length) q.options = q.options.map((o, i) => ({ ...r.options[i], code: o.code, sourceId: o.sourceId, label: o.label.replace(/\s*\([^)]*\)\s*$/, "") || o.label }));
    if (q.kind === "unknown" || (!q.options.length && r.kind !== "textarea")) q.kind = r.kind;
  }
  const flow: CFlow[] = read.flow.map((f) => (f.t === "block" ? { ...f, pages: f.pages.map((p) => p.map((id) => questions.find((q) => q.sourceId.toUpperCase() === id.toUpperCase())?.sourceId ?? id)) } : f));
  return {
    source: { platform: "spreadsheet", format: meta.format, fileName: meta.fileName, title: meta.title ?? best.sheet, fingerprint: meta.fingerprint },
    questions, flow, embedded: [], quotas: [], custom: [],
    issues: [...issues, ...read.issues.filter((x) => x.type !== "inferred" || !/each question was given its own page/.test(x.message)), { location: `${best.sheet}`, type: "inferred", severity: "info", message: `Read ${questions.length} question${questions.length === 1 ? "" : "s"} from sheet “${best.sheet}”, header on row ${header + 1} (${[...new Set(cols.values())].join(", ")}).`, autoAttempted: true }],
  };
}

/** "1=Yes; 2=No" · "Yes\nNo" · "Yes | No | Don't know" · "1 Yes, 2 No" */
export function parseOptionCell(cellText: string, offset = 0): CanonicalOption[] {
  const t = cellText.trim();
  if (!t) return [];
  const parts = t.includes("\n") ? t.split(/\n+/) : /[;|]/.test(t) ? t.split(/\s*[;|]\s*/) : /^\s*\d+\s*[=.)-]\s*\S/.test(t) && /,\s*\d+\s*[=.)-]/.test(t) ? t.split(/\s*,\s*(?=\d+\s*[=.)-])/) : t.split(/\s*,\s*/).length > 1 && t.length < 200 ? t.split(/\s*,\s*/) : [t];
  return parts.map((p) => p.trim()).filter(Boolean).map((p, i) => {
    const m = /^(\d{1,3}|[a-zA-Z])\s*(?:=|\.|\)|:|-|–)\s*(.+)$/.exec(p) ?? /^(\d{1,3})\s+(.+)$/.exec(p);
    const code = m ? m[1] : String(offset + i + 1);
    return { sourceId: code, code: /^\d+$/.test(code) ? Number(code) : code, label: (m ? m[2] : p).trim() };
  });
}

function kindFromTypeCell(typeCell: string, q: CanonicalQuestion): CanonicalKind {
  const t = typeCell.toLowerCase();
  if (!t) return "unknown";
  if (/multi|check\s*box|select all|mr\b|multiple/.test(t)) return /grid|matrix/.test(t) ? "matrix_multi" : "multi";
  if (/grid|matrix|likert|table/.test(t)) return "matrix_single";
  if (/drop\s*down|select box|list box/.test(t)) return "dropdown";
  if (/single|radio|sr\b|choice|closed|sc\b/.test(t)) return "single";
  if (/nps|net promoter/.test(t)) return "nps";
  if (/rank/.test(t)) return "ranking";
  if (/slider/.test(t)) return "slider";
  if (/numeric|number|integer|int\b|count|age/.test(t)) return "numeric";
  if (/e-?mail/.test(t)) return "email";
  if (/date/.test(t)) return "date";
  if (/constant sum|allocation|sum/.test(t)) return "constant_sum";
  if (/hidden|dummy|computed|derived/.test(t)) return /comput|deriv/.test(t) ? "calculated" : "hidden";
  if (/info|text block|intro|descriptive|display|statement|html/.test(t)) return "descriptive";
  if (/long|essay|paragraph|multi[\s-]*line|verbatim/.test(t)) return "textarea";
  if (/open|text|string|oe\b/.test(t)) return "text";
  void q;
  return "unknown";
}
