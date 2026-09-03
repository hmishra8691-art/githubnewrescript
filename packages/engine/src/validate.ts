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

  /*
   * Other (specify): selecting it is not an answer until the respondent says
   * what "other" is. A blank specify was reaching the data — enforced here in
   * the engine, so the runtime, the preview and the inspector agree, and so
   * every renderer that shows the box gets it without its own check. The
   * text lives beside the answer under `<id>__other` (see state.ts).
   */
  if (!q.settings.otherSpecifyOptional && !isEmpty(value) && Array.isArray(q.options)) {
    const otherCodes = q.options
      .filter((o) => o.flags?.includes("other_specify"))
      .map((o) => String(o.code));
    if (otherCodes.length > 0) {
      const chosen = (Array.isArray(value) ? value : [value]).map(String);
      if (chosen.some((c) => otherCodes.includes(c))) {
        const answers = ctx.state.answers as Record<string, unknown>;
        const raw =
          (ctx.loop ? answers[`${q.id}@${ctx.loop.code}__other`] : undefined) ??
          answers[`${q.id}__other`];
        const text = typeof raw === "string" ? raw.trim() : raw;
        if (isEmpty(text)) push("Please say what “Other” is before continuing.");
      }
    }
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

  // a from–to pair (numeric range, dual slider): the order has to hold
  if (q.settings.rangePair && value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const codes = (q.rows ?? []).map((r) => String(r.code));
    const lo = v[codes[0] ?? "from"], hi = v[codes[1] ?? "to"];
    if (!isEmpty(lo) && !isEmpty(hi) && Number(lo) > Number(hi)) {
      push("The first value must not be greater than the second.");
    }
  }

  // repeating group: how many entries, and each entry's required fields
  if (q.type === "repeating_group") {
    const entries = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    const filled = entries.filter((e) => e && Object.values(e).some((x) => !isEmpty(x)));
    const min = q.settings.minRepeats ?? (q.required ? 1 : 0);
    if (filled.length < min) push(`Please add at least ${min} ${min === 1 ? "entry" : "entries"}.`);
    if (q.settings.maxRepeats != null && filled.length > q.settings.maxRepeats)
      push(`Please keep to at most ${q.settings.maxRepeats} entries.`);
    filled.forEach((e, i) => {
      for (const r of q.rows ?? []) {
        if (r.required && isEmpty(e[String(r.code)])) push(`Entry ${i + 1}: ${r.label} is required.`, { rowCode: String(r.code) });
      }
    });
  }

  // uploads: count and size
  if (q.type === "upload" && !isEmpty(value)) {
    const files = (Array.isArray(value) ? value : [value]) as { size?: number }[];
    const max = q.settings.maxFiles ?? 1;
    if (files.length > max) push(`Please attach at most ${max} file${max === 1 ? "" : "s"}.`);
    const cap = q.settings.maxSizeMb;
    if (cap != null && files.some((f) => (f?.size ?? 0) > cap * 1024 * 1024))
      push(`Each file must be under ${cap} MB.`);
  }

  // media timeline / annotation: the count rules are the min/max selections
  if ((q.type === "media_timeline" || q.type === "annotation") && !isEmpty(value)) {
    const n = q.type === "media_timeline"
      ? (Array.isArray(value) ? value.length : 0)
      : (((value as { pins?: unknown[] }).pins?.length ?? 0) + ((value as { strokes?: unknown[] }).strokes?.length ?? 0));
    if (q.settings.minSelections != null && n < q.settings.minSelections)
      push(`Please add at least ${q.settings.minSelections}.`);
    if (q.settings.maxSelections != null && n > q.settings.maxSelections)
      push(`Please add at most ${q.settings.maxSelections}.`);
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

  // ---- text / numeric+slider families (variant batch) ----
  // Rich Text stores sanitized HTML in an ordinary `long_text` answer, so the
  // length rules must measure what the respondent actually wrote:
  // "<b>Hi</b>" is two characters to them, not nine. A plain long-text answer
  // holds no tags and is measured exactly as before.
  const LENGTH_KINDS = ["min_length", "max_length"];
  const richTextValue =
    q.type === "long_text" && typeof value === "string" && /<[a-z][\s\S]*>/i.test(value)
      ? htmlToText(value)
      : null;
  if (richTextValue != null) {
    checkScalarRules(
      q.validation.filter((r) => LENGTH_KINDS.includes(r.kind)),
      richTextValue, ctx, (m) => push(m),
    );
  }
  // A from–to pair (Numeric Range, Dual / Range Slider) declares the
  // numeric_bounds capability, but its answer is an object, so the scalar
  // bounds check above never reaches it. Hold each side to the same bounds.
  if (q.settings.rangePair && value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    for (const row of q.rows ?? []) {
      const side = v[String(row.code)];
      if (isEmpty(side)) continue;
      const label = row.label.replace(/<[^>]*>/g, "");
      if (q.settings.minValue != null && Number(side) < q.settings.minValue)
        push(`${label}: must be at least ${q.settings.minValue}.`, { rowCode: String(row.code) });
      if (q.settings.maxValue != null && Number(side) > q.settings.maxValue)
        push(`${label}: must be at most ${q.settings.maxValue}.`, { rowCode: String(row.code) });
    }
  }
  // ---- end variant batch ----

  checkScalarRules(
    q.validation.filter(
      (r) => !["sum_equals", "sum_max", "sum_min"].includes(r.kind)
        // measured above, against the text rather than the markup
        && !(richTextValue != null && LENGTH_KINDS.includes(r.kind)),
    ),
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

  // ranking completeness when required — what "complete" means depends on the
  // ranking mode, so Rank-Top-N isn't held to "rank everything" (which no
  // respondent could ever satisfy)
  if (q.required && (q.type === "ranking" || q.type === "image_ranking") && Array.isArray(value)) {
    const view = effectiveQuestion(q, ctx);
    const mode = q.settings.rankMode ?? "all";
    const target =
      mode === "top_n"
        ? Math.min(q.settings.maxSelections ?? view.options.length, view.options.length)
        : mode === "click"
          ? Math.min(q.settings.minSelections ?? 1, view.options.length)
          : view.options.length;
    if (value.length < target) {
      push(
        mode === "top_n"
          ? `Please rank your top ${target}.`
          : mode === "click"
            ? `Please rank at least ${target} item${target === 1 ? "" : "s"}.`
            : "Please rank all items.",
      );
    }
  }

  // ---- matrix family (variant batch) ----
  /**
   * Constant-sum grid: `settings.rowSum` says every ROW of a cell question
   * allocates `settings.sumTarget` across its columns. Keyed on the setting
   * rather than on a variant id, so the rule belongs to the question, not to
   * one presentation of it.
   *
   * A row nobody has touched is only an error when the question is required
   * — otherwise a respondent who skips an optional grid would be told their
   * empty rows do not add up.
   */
  if (
    (q.type === "composite" || q.type === "custom_table") &&
    q.settings.rowSum &&
    q.settings.sumTarget != null
  ) {
    const view = effectiveQuestion(q, ctx);
    const cells = (value ?? {}) as Record<string, Record<string, unknown>>;
    const cols = view.columns.filter((c) => !c.readOnly && !c.expression);
    const target = q.settings.sumTarget;
    const unit = q.settings.sumUnit ?? "";
    for (const row of view.rows) {
      const rc = String(row.code);
      const label = row.label.replace(/<[^>]*>/g, "");
      const vals = cols.map((c) => cells?.[rc]?.[c.id]);
      const filled = vals.filter((v) => !isEmpty(v));
      const complete = cols.length > 0 && filled.length === cols.length;
      if (!complete) {
        if (q.required) push(`Row “${label}” must total ${target}${unit}.`, { rowCode: rc });
        continue;
      }
      const total = vals.reduce((a: number, b) => a + (Number(b) || 0), 0);
      if (total !== target) push(`Row “${label}” must total ${target}${unit}.`, { rowCode: rc });
    }
  }

  // ---- media family (variant batch) ----
  /*
   * Watch-Time Tracking (media.watch_time) stores its telemetry as
   * `numeric_list` fields, one of which is `completed`. With
   * `settings.requireComplete` the survey is saying "you may not continue
   * until the clip has finished", and that has to be an engine rule: the
   * renderer could otherwise be bypassed by going Back, and the preview and
   * the inspector would disagree with the live interview about whether the
   * page is answerable. Keyed on the setting AND on a `completed` row, so no
   * ordinary numeric list is affected.
   */
  if (
    q.type === "numeric_list" &&
    q.settings.requireComplete &&
    (q.rows ?? []).some((r) => String(r.code) === "completed")
  ) {
    const v = (value ?? {}) as Record<string, unknown>;
    if (Number(v.completed) !== 1) push("Please watch the video to the end.");
  }

  return errors;
}

// ---- text family (variant batch) ----
/**
 * The visible text of a formatted answer, for length measurement only:
 * block ends become spaces so "<p>a</p><p>b</p>" is not measured as "ab",
 * tags are dropped and the handful of entities a rich-text surface produces
 * are decoded back to the one character they stand for.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
// ---- end variant batch ----

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
