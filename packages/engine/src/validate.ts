import type { Question, ValidationRule, SurveyDefinition } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { effectiveQuestion } from "./carryforward.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { validateFieldValue } from "./fields.js";

export interface ValidationError {
  questionId: string;
  columnId?: string;
  rowCode?: string;
  message: string;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    return Object.values(v as object).every((x) => isEmpty(x));
  }
  return false;
}

function ruleError(rule: ValidationRule, fallback: string): string {
  return rule.message ?? fallback;
}

function checkScalarRules(
  rules: ValidationRule[],
  value: unknown,
  ctx: EvalContext,
  push: (msg: string) => void,
): void {
  for (const rule of rules) {
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    switch (rule.kind) {
      case "required":
        if (isEmpty(value)) push(ruleError(rule, "This question is required."));
        break;
      case "min_value":
        if (!isEmpty(value) && Number(value) < Number(rule.value))
          push(ruleError(rule, `Value must be at least ${rule.value}.`));
        break;
      case "max_value":
        if (!isEmpty(value) && Number(value) > Number(rule.value))
          push(ruleError(rule, `Value must be at most ${rule.value}.`));
        break;
      case "min_length":
        if (!isEmpty(value) && String(value).length < Number(rule.value))
          push(ruleError(rule, `Please enter at least ${rule.value} characters.`));
        break;
      case "max_length":
        if (!isEmpty(value) && String(value).length > Number(rule.value))
          push(ruleError(rule, `Please enter at most ${rule.value} characters.`));
        break;
      case "min_selections":
        if (Array.isArray(value) && value.length < Number(rule.value))
          push(ruleError(rule, `Select at least ${rule.value}.`));
        break;
      case "max_selections":
        if (Array.isArray(value) && value.length > Number(rule.value))
          push(ruleError(rule, `Select at most ${rule.value}.`));
        break;
      case "pattern":
        try {
          if (!isEmpty(value) && !new RegExp(String(rule.value)).test(String(value)))
            push(ruleError(rule, "Invalid format."));
        } catch { /* bad regex — ignore */ }
        break;
      case "email":
        if (!isEmpty(value) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)))
          push(ruleError(rule, "Please enter a valid email address."));
        break;
      case "integer":
        if (!isEmpty(value) && !Number.isInteger(Number(value)))
          push(ruleError(rule, "Please enter a whole number."));
        break;
      case "custom_expression": {
        const flat = flattenVariables(ctx.def, ctx.state);
        try {
          const ok = evaluateExpression(String(rule.value), {
            resolver: (n) => (n === "value" ? value : flat[n]),
            names: () => Object.keys(flat),
          });
          if (!ok) push(ruleError(rule, "Invalid answer."));
        } catch { /* invalid expression — skip */ }
        break;
      }
      default:
        break;
    }
  }
}

/** Validate the answer of one question against all its rules. */
export function validateQuestion(
  def: SurveyDefinition,
  q: Question,
  value: unknown,
  ctx: EvalContext,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const push = (message: string, extra?: Partial<ValidationError>) =>
    errors.push({ questionId: q.id, message, ...extra });

  // implicit required
  if (q.required && isEmpty(value)) {
    push("This question is required.");
  }

  // bounds from settings
  if (!isEmpty(value) && (q.type === "numeric" || q.type === "slider" || q.type === "nps")) {
    if (q.settings.minValue != null && Number(value) < q.settings.minValue)
      push(`Value must be at least ${q.settings.minValue}.`);
    if (q.settings.maxValue != null && Number(value) > q.settings.maxValue)
      push(`Value must be at most ${q.settings.maxValue}.`);
  }
  if (Array.isArray(value)) {
    if (q.settings.minSelections != null && value.length < q.settings.minSelections && !isEmpty(value))
      push(`Select at least ${q.settings.minSelections}.`);
    if (q.settings.maxSelections != null && value.length > q.settings.maxSelections)
      push(`Select at most ${q.settings.maxSelections}.`);
  }

  // allocation sum
  if (q.type === "allocation" && q.settings.sumTarget != null && !isEmpty(value)) {
    const total = Object.values((value as Record<string, unknown>) ?? {}).reduce(
      (a: number, b) => a + (Number(b) || 0),
      0,
    );
    if (total !== q.settings.sumTarget)
      push(`Total must equal ${q.settings.sumTarget}${q.settings.sumUnit ?? ""} (currently ${total}).`);
  }

  // sum_* rules for allocation-like values
  for (const rule of q.validation) {
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    if (["sum_equals", "sum_max", "sum_min"].includes(rule.kind) && value && typeof value === "object" && !Array.isArray(value)) {
      const total = Object.values(value as Record<string, unknown>).reduce(
        (a: number, b) => a + (Number(b) || 0),
        0,
      );
      if (rule.kind === "sum_equals" && total !== Number(rule.value))
        push(ruleError(rule, `Total must equal ${rule.value}.`));
      if (rule.kind === "sum_max" && total > Number(rule.value))
        push(ruleError(rule, `Total must be at most ${rule.value}.`));
      if (rule.kind === "sum_min" && total < Number(rule.value))
        push(ruleError(rule, `Total must be at least ${rule.value}.`));
    }
  }

  checkScalarRules(
    q.validation.filter((r) => !["sum_equals", "sum_max", "sum_min"].includes(r.kind)),
    value,
    ctx,
    (m) => push(m),
  );

  // composite: per-column validation over visible rows
  if ((q.type === "composite" || q.type === "custom_table") && q.columns.length) {
    const view = effectiveQuestion(q, ctx);
    const cells = (value ?? {}) as Record<string, Record<string, unknown>>;
    for (const row of view.rows) {
      for (const col of view.columns) {
        const cellValue = cells?.[String(row.code)]?.[col.id];
        if (col.readOnly || col.expression) continue;
        checkScalarRules(col.validation, cellValue, ctx, (m) =>
          push(`${row.label} — ${col.label}: ${m}`, { rowCode: String(row.code), columnId: col.id }),
        );
        if (col.min != null && !isEmpty(cellValue) && Number(cellValue) < col.min)
          push(`${row.label} — ${col.label}: minimum ${col.min}.`, { rowCode: String(row.code), columnId: col.id });
        if (col.max != null && !isEmpty(cellValue) && Number(cellValue) > col.max)
          push(`${row.label} — ${col.label}: maximum ${col.max}.`, { rowCode: String(row.code), columnId: col.id });
      }
    }
  }

  // form-style lists: per-field type + validation (reqs §3–5)
  if ((q.type === "text_list" || q.type === "numeric_list") && q.rows.length > 0) {
    const view = effectiveQuestion(q, ctx);
    const vals = (value ?? {}) as Record<string, unknown>;
    for (const row of view.rows) {
      const rc = String(row.code);
      const v = typeof vals === "object" && !Array.isArray(vals) ? vals[rc] : undefined;
      const label = row.label.replace(/<[^>]*>/g, "");
      if ((row.required || (q.required && !q.rows.some((r) => r.required))) && isEmpty(v)) {
        push(`${label}: this field is required.`, { rowCode: rc });
        continue;
      }
      if (!isEmpty(v)) {
        const ft = row.fieldType ?? (q.type === "numeric_list" ? "number" : "text");
        const typeErr = validateFieldValue(ft, v);
        if (typeErr) push(`${label}: ${typeErr}`, { rowCode: rc });
      }
      checkScalarRules(row.validation ?? [], v, ctx, (m) =>
        push(`${label}: ${m}`, { rowCode: rc }),
      );
    }
  }

  // matrix: required means every visible row answered
  if (q.required && q.type.startsWith("matrix")) {
    const view = effectiveQuestion(q, ctx);
    const rowsAnswered = (value ?? {}) as Record<string, unknown>;
    for (const row of view.rows) {
      if (isEmpty(rowsAnswered[String(row.code)]))
        push(`Please answer for "${row.label}".`, { rowCode: String(row.code) });
    }
  }

  // ranking completeness when required
  if (q.required && (q.type === "ranking" || q.type === "image_ranking") && Array.isArray(value)) {
    const view = effectiveQuestion(q, ctx);
    if (value.length < view.options.length)
      push("Please rank all items.");
  }

  return errors;
}

/** Validate all visible questions on a page. */
export function validatePage(
  def: SurveyDefinition,
  questions: Question[],
  ctx: EvalContext,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const q of questions) {
    const loopKey = ctx.loop ? `${q.id}@${ctx.loop.code}` : q.id;
    const value = ctx.state.answers[loopKey] ?? ctx.state.answers[q.id];
    errors.push(...validateQuestion(def, q, value, ctx));
  }
  return errors;
}
