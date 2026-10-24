import type { Option, Question, QuestionColumn, QuestionRow } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import type { AnswerValue } from "./state.js";
import { effectiveQuestion } from "./carryforward.js";
import { resolveOptionValue, type OptionList } from "./optionCodes.js";
import { resolvePipingText } from "./piping.js";
import { isOtherRow, rowOtherCode } from "./otherSpecify.js";

/**
 * A QUESTION'S DEFAULT VALUE (`settings.defaultValue`, set in Properties or by
 * the copilot's `set_default_value`) is the answer the question starts with.
 *
 * It is written into the response the first time the question is shown, and
 * only if the question has no answer yet, so it never overwrites something the
 * respondent typed. It is written ONCE per question: a respondent who clears it
 * and comes back finds it still cleared. The default is read as the question
 * reads answers: a number for a numeric question, text for a text question,
 * option CODES for a choice question (a label or "option 2" is resolved to its
 * code, and only options the question actually shows can be chosen). A piped
 * default (`{{Q1}}`) is read from the answers so far. A default
 * that does not fit the question is ignored rather than stored.
 *
 * PER-FIELD DEFAULTS (2026-10-24, client item A63). Every field a respondent
 * types into can carry its own default / piped value — a Text or Numeric
 * List field (`row.defaultValue`), a Text / Numeric Matrix row's cell
 * (`row.defaultValue`), a Constant Sum amount (`option.defaultValue`), a cell
 * of a composite grid (`row.cellDefaults[columnId]`, falling back to the
 * column's `defaultValue`) and an "Other — specify" box (`otherDefault` on
 * the option or row). They are resolved and written by the same rule: once,
 * into empty fields only, as the field reads its value, and a piped reference
 * that resolves to nothing writes nothing — the respondent never sees `{{…}}`.
 */
export function defaultAnswerFor(q: Question, ctx: EvalContext): AnswerValue | null {
  const stored = (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue;
  if (stored === undefined || stored === null || stored === "") return null;
  // "static, or {{Q1}} piped" (the Properties field): a piped default is read from the answers so far
  const raw = resolveDefaultText(stored, ctx);
  if (raw === "" || raw === null) return null;
  const model = effectiveResponseModel(q);
  if (model === "numeric") return asNumber(raw);
  if (model === "text") return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  if (model === "single_choice" || model === "multiple_choice") {
    const options = effectiveQuestion(q, ctx).options as OptionList;
    const wanted = Array.isArray(raw) ? raw : model === "multiple_choice" && typeof raw === "string" ? raw.split(/\s*[,;]\s*/).filter(Boolean) : [raw];
    const codes: (string | number)[] = [];
    for (const w of wanted) {
      const r = resolveOptionValue(options, w);
      if (r.kind === "code" && !codes.some((c) => String(c) === String(r.code))) codes.push(r.code);
    }
    if (!codes.length) return null;
    return (model === "multiple_choice" ? codes : codes[0]) as AnswerValue;
  }
  return null;
}

/** A stored default with its piping resolved to PLAIN text; a non-string is returned as it is. */
function resolveDefaultText(stored: unknown, ctx: EvalContext): unknown {
  if (typeof stored !== "string") return stored;
  if (!stored.includes("{{")) return stored;
  try { return resolvePipingText(stored, ctx).trim(); } catch { return ""; }
}

function asNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const NUMERIC_FIELD_TYPES = new Set(["number", "decimal", "integer", "currency", "hours"]);
const NUMERIC_COLUMN_TYPES = new Set(["numeric", "slider"]);
const TEXT_COLUMN_TYPES = new Set(["text", "longtext"]);

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Read one field's default as that field reads its answer: a number, or text. */
function fieldValue(stored: unknown, numeric: boolean, ctx: EvalContext): string | number | null {
  if (!hasValue(stored)) return null;
  const raw = resolveDefaultText(stored, ctx);
  if (!hasValue(raw)) return null;
  if (numeric) return asNumber(raw);
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
}

/**
 * The per-field defaults of a question, resolved: the partial answer map to
 * merge into an empty answer (`{ row: value }`, or `{ row: { col: value } }`
 * for a composite grid), and the "Other — specify" texts by box code.
 * Empty when the question has none — which is every question written before
 * this existed.
 */
export function fieldDefaultsFor(q: Question, ctx: EvalContext): { answer: Record<string, unknown>; others: Record<string, string> } {
  const answer: Record<string, unknown> = {};
  const others: Record<string, string> = {};
  const model = effectiveResponseModel(q);
  const view = effectiveQuestion(q, ctx);
  const rows = (view.rows ?? []) as QuestionRow[];
  const options = (view.options ?? []) as Option[];
  const columns = (view.columns ?? []) as QuestionColumn[];

  const otherText = (stored: unknown): string | null => {
    const v = fieldValue(stored, false, ctx);
    return typeof v === "string" && v !== "" ? v : null;
  };
  for (const o of options) {
    if (o.otherDefault !== undefined && (o.flags ?? []).includes("other_specify")) {
      const t = otherText(o.otherDefault);
      if (t !== null) others[String(o.code)] = t;
    }
  }
  for (const r of rows) {
    if (r.otherDefault !== undefined && isOtherRow(r)) {
      const t = otherText(r.otherDefault);
      if (t !== null) others[rowOtherCode(r.code)] = t;
    }
  }

  if (model === "allocation") {
    for (const o of options) {
      const v = fieldValue(o.defaultValue, true, ctx);
      if (v !== null) answer[String(o.code)] = v;
    }
  } else if (model === "fields") {
    for (const r of rows) {
      const ft = r.fieldType ?? (q.type === "numeric_list" ? "number" : "text");
      const v = fieldValue(r.defaultValue, NUMERIC_FIELD_TYPES.has(ft), ctx);
      if (v !== null) answer[String(r.code)] = v;
    }
  } else if (model === "per_row" && (q.type === "matrix_text" || q.type === "matrix_numeric")) {
    for (const r of rows) {
      const v = fieldValue(r.defaultValue, q.type === "matrix_numeric", ctx);
      if (v !== null) answer[String(r.code)] = v;
    }
  } else if (q.type === "composite" || q.type === "custom_table") {
    for (const r of rows) {
      const cells: Record<string, unknown> = {};
      for (const c of columns) {
        const numeric = NUMERIC_COLUMN_TYPES.has(String(c.responseType));
        if (!numeric && !TEXT_COLUMN_TYPES.has(String(c.responseType))) continue;
        if (c.expression) continue; // a calculated cell has no box to start
        const own = r.cellDefaults?.[c.id];
        const stored = hasValue(own) ? own : c.defaultValue;
        const v = fieldValue(stored, numeric, ctx);
        if (v !== null) cells[c.id] = v;
      }
      if (Object.keys(cells).length) answer[String(r.code)] = cells;
    }
  }
  return { answer, others };
}

/** Does this question carry any default — on itself, a field, a cell or an Other box? */
export function questionHasDefaults(q: Question): boolean {
  if ((q.settings as { defaultValue?: unknown } | undefined)?.defaultValue !== undefined) return true;
  if ((q.options ?? []).some((o) => o.defaultValue !== undefined || o.otherDefault !== undefined)) return true;
  if ((q.rows ?? []).some((r) => r.defaultValue !== undefined || r.otherDefault !== undefined || (r.cellDefaults && Object.keys(r.cellDefaults).length > 0))) return true;
  if ((q.columns ?? []).some((c) => c.defaultValue !== undefined)) return true;
  return false;
}

const APPLIED = "defaultsApplied";

/** fill the defaults of the questions about to be shown; the keys it wrote */
export function applyDefaultValues(questions: Question[], ctx: EvalContext, answerKeyFor: (q: Question) => string): string[] {
  const filled: string[] = [];
  for (const q of questions) {
    if (!questionHasDefaults(q)) continue;
    const key = answerKeyFor(q);
    const meta = (ctx.state.meta ??= {});
    const done = (Array.isArray(meta[APPLIED]) ? meta[APPLIED] : []) as string[];
    if (done.includes(key)) continue;
    const a = ctx.state.answers[key];
    const empty = a === undefined || a === null || a === "" || (Array.isArray(a) && a.length === 0);
    let wrote = false;
    /* the question's own default: the whole answer, only when there is none */
    if (empty && (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue !== undefined) {
      const v = defaultAnswerFor(q, ctx);
      if (v !== null) { ctx.state.answers[key] = v; wrote = true; }
    }
    /* per-field defaults: into the empty cells of a map answer */
    const { answer: fields, others } = fieldDefaultsFor(q, ctx);
    if (Object.keys(fields).length) {
      const current = ctx.state.answers[key];
      const cur: Record<string, unknown> = isRecord(current) ? { ...current } : {};
      let changed = false;
      for (const [row, v] of Object.entries(fields)) {
        if (isRecord(v)) {
          const had = isRecord(cur[row]) ? { ...(cur[row] as Record<string, unknown>) } : {};
          for (const [col, cell] of Object.entries(v)) {
            if (!hasValue(had[col])) { had[col] = cell; changed = true; }
          }
          cur[row] = had;
        } else if (!hasValue(cur[row])) {
          cur[row] = v; changed = true;
        }
      }
      if (changed && (isRecord(current) || empty)) { ctx.state.answers[key] = cur as AnswerValue; wrote = true; }
    }
    /* "Other — specify" boxes: their own keys, beside the answer */
    for (const [code, text] of Object.entries(others)) {
      const k = `${key}__other__${code}`;
      if (hasValue(ctx.state.answers[k])) continue;
      ctx.state.answers[k] = text;
      wrote = true;
    }
    /* once: after a fill, or once the question already held an answer — a default that could not resolve yet is tried again next time */
    if (wrote || !empty) meta[APPLIED] = [...done, key];
    if (wrote) filled.push(key);
  }
  return filled;
}

/**
 * WHICH CONFIGURED DEFAULTS RESOLVE TO NOTHING, right now (2026-10-24, A63) —
 * for the preview / test note under a question. A live respondent never sees
 * this: the field simply starts empty. Each entry names the field and the
 * text as configured, so the programmer can see which pipe is empty.
 */
export interface UnresolvedDefault { field: string; configured: string }
export function unresolvedDefaultsFor(q: Question, ctx: EvalContext): UnresolvedDefault[] {
  if (!questionHasDefaults(q)) return [];
  const out: UnresolvedDefault[] = [];
  const check = (field: string, stored: unknown, numeric: boolean) => {
    if (typeof stored !== "string" || !stored.includes("{{")) return;
    if (fieldValue(stored, numeric, ctx) === null) out.push({ field, configured: stored });
  };
  const model = effectiveResponseModel(q);
  const qDefault = (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue;
  if (typeof qDefault === "string" && qDefault.includes("{{") && defaultAnswerFor(q, ctx) === null) out.push({ field: q.code, configured: qDefault });
  const strip = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, "").trim();
  for (const o of q.options ?? []) {
    if (model === "allocation") check(strip(o.label) || String(o.code), o.defaultValue, true);
    if ((o.flags ?? []).includes("other_specify")) check(`${strip(o.label) || o.code} — other`, o.otherDefault, false);
  }
  for (const r of q.rows ?? []) {
    const name = strip(r.label) || String(r.code);
    if (model === "fields") check(name, r.defaultValue, NUMERIC_FIELD_TYPES.has(r.fieldType ?? (q.type === "numeric_list" ? "number" : "text")));
    if (q.type === "matrix_text" || q.type === "matrix_numeric") check(name, r.defaultValue, q.type === "matrix_numeric");
    if (isOtherRow(r)) check(`${name} — other`, r.otherDefault, false);
    if (q.type === "composite" || q.type === "custom_table") {
      for (const c of q.columns ?? []) {
        const numeric = NUMERIC_COLUMN_TYPES.has(String(c.responseType));
        if (!numeric && !TEXT_COLUMN_TYPES.has(String(c.responseType))) continue;
        const own = r.cellDefaults?.[c.id];
        check(`${name} / ${strip(c.label) || c.id}`, hasValue(own) ? own : c.defaultValue, numeric);
      }
    }
  }
  return out;
}
