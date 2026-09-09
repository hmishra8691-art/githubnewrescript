import type { Question, ValidationRule, SurveyDefinition } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { effectiveQuestion } from "./carryforward.js";
import { answerKey, lookupAnswer } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { validateFieldValue } from "./fields.js";
import { createScriptCtx, runScript, type ScriptRunResult } from "./scripts.js";
import { resolvePiping } from "./piping.js";

/**
 * Whether a failed check stops the respondent.
 *
 * Everything the engine raises is an "error" unless a rule asks to be a
 * "warning": the page still submits, the message is still shown. That
 * distinction lives here rather than in the runtime so the preview, the
 * inspector and the live interview cannot disagree about what blocks.
 */
export type ValidationSeverity = "error" | "warning";

export interface ValidationError {
  questionId: string;
  columnId?: string;
  rowCode?: string;
  message: string;
  /** absent means "error" — every caller that predates severity still blocks */
  severity?: ValidationSeverity;
}

/** The checks that actually stop the page. */
export function blockingErrors(errors: ValidationError[]): ValidationError[] {
  return errors.filter((e) => (e.severity ?? "error") === "error");
}

/** The checks that are worth saying but must not stop anyone. */
export function warnings(errors: ValidationError[]): ValidationError[] {
  return errors.filter((e) => e.severity === "warning");
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

/** An ISO date, or the name of something in scope that holds one. */
function dateBound(raw: unknown, ctx: EvalContext): number | null {
  if (raw == null || raw === "") return null;
  const direct = Date.parse(String(raw));
  if (!Number.isNaN(direct)) return direct;
  const flat = flattenVariables(ctx.def, ctx.state);
  const resolved = flat[String(raw)];
  if (resolved == null) return null;
  const t = Date.parse(String(resolved));
  return Number.isNaN(t) ? null : t;
}

function asDate(value: unknown): number | null {
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

/**
 * Loose enough for the world's numbering plans, strict enough to catch a
 * typo: digits, with the punctuation people actually type, and at least
 * seven of them. Anything narrower rejects a legitimate foreign number,
 * which is worse than accepting a bad one.
 */
const PHONE_RE = /^[+()\-.\s\d]{7,}$/;

/**
 * One item's validation rules against one value.
 *
 * Exported because count conditions ask the same question of a single grid
 * row or column cell ("how many rows hold an answer that fails their own
 * validation?"). Two implementations of "does this rule accept this value"
 * would drift, and the one that drifted would be the one nobody was looking
 * at.
 */
export function checkScalarRules(
  rules: ValidationRule[],
  value: unknown,
  ctx: EvalContext,
  push: (msg: string, severity: ValidationSeverity) => void,
): void {
  for (const rule of rules) {
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    const sev: ValidationSeverity = rule.severity ?? "error";
    const fail = (m: string) => push(m, sev);
    switch (rule.kind) {
      case "required":
        if (isEmpty(value)) fail(ruleError(rule, "This question is required."));
        break;
      case "min_value":
        if (!isEmpty(value) && Number(value) < Number(rule.value))
          fail(ruleError(rule, `Value must be at least ${rule.value}.`));
        break;
      case "max_value":
        if (!isEmpty(value) && Number(value) > Number(rule.value))
          fail(ruleError(rule, `Value must be at most ${rule.value}.`));
        break;
      case "min_length":
        if (!isEmpty(value) && String(value).length < Number(rule.value))
          fail(ruleError(rule, `Please enter at least ${rule.value} characters.`));
        break;
      case "max_length":
        if (!isEmpty(value) && String(value).length > Number(rule.value))
          fail(ruleError(rule, `Please enter at most ${rule.value} characters.`));
        break;
      case "min_selections":
        if (Array.isArray(value) && value.length < Number(rule.value))
          fail(ruleError(rule, `Select at least ${rule.value}.`));
        break;
      case "max_selections":
        if (Array.isArray(value) && value.length > Number(rule.value))
          fail(ruleError(rule, `Select at most ${rule.value}.`));
        break;
      case "pattern":
        try {
          if (!isEmpty(value) && !new RegExp(String(rule.value)).test(String(value)))
            fail(ruleError(rule, "Invalid format."));
        } catch { /* bad regex — ignore */ }
        break;
      case "email":
        if (!isEmpty(value) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)))
          fail(ruleError(rule, "Please enter a valid email address."));
        break;
      case "phone":
        if (!isEmpty(value) && (!PHONE_RE.test(String(value)) || (String(value).match(/\d/g)?.length ?? 0) < 7))
          fail(ruleError(rule, "Please enter a valid phone number."));
        break;
      case "date_min": {
        const bound = dateBound(rule.value, ctx);
        const got = isEmpty(value) ? null : asDate(value);
        if (bound != null && got != null && got < bound)
          fail(ruleError(rule, `Please choose a date on or after ${new Date(bound).toISOString().slice(0, 10)}.`));
        break;
      }
      case "date_max": {
        const bound = dateBound(rule.value, ctx);
        const got = isEmpty(value) ? null : asDate(value);
        if (bound != null && got != null && got > bound)
          fail(ruleError(rule, `Please choose a date on or before ${new Date(bound).toISOString().slice(0, 10)}.`));
        break;
      }
      case "integer":
        if (!isEmpty(value) && !Number.isInteger(Number(value)))
          fail(ruleError(rule, "Please enter a whole number."));
        break;
      case "custom_expression": {
        const flat = flattenVariables(ctx.def, ctx.state);
        try {
          const ok = evaluateExpression(String(rule.value), {
            resolver: (n) => (n === "value" ? value : flat[n]),
            names: () => Object.keys(flat),
          });
          if (!ok) fail(ruleError(rule, "Invalid answer."));
        } catch { /* invalid expression — skip */ }
        break;
      }
      case "custom_script": {
        /*
         * The rule names a script in `def.scripts`; the script decides. It
         * reads the answer under test as `value` and reports by calling
         * `ctx.error(...)` — the same call an on_validate script makes, so a
         * programmer writes one kind of validation script, not two.
         *
         * Until this existed the kind was accepted by the schema, asserted in
         * a unit test, and fell through `default: break` — so the rule always
         * passed. That is why it is implemented here rather than lint-warned.
         */
        const ref = String(rule.value ?? "");
        const script = ctx.def.scripts.find((s) => s.id === ref || s.name === ref);
        if (!script) break;
        const run: ScriptRunResult = { logs: [], errors: [] };
        const sctx = createScriptCtx(ctx.def, ctx.state, ctx.loop ?? null, run);
        const outcome = runScript(script.code, { ...sctx, value } as never, run);
        for (const e of run.errors) fail(e.message);
        if (outcome.failed) fail(ruleError(rule, "This answer could not be checked."));
        break;
      }
      case "condition": {
        /*
         * The Universal Logic Engine's Condition tree, evaluated as the
         * check itself (condition TRUE => fails), not a gate — `rule.when`
         * above already covers "only run this rule when X." Reuses the
         * exact evaluator every other feature's condition tree goes
         * through, so cross-question, matrix-cell (via a source's
         * rowCode/columnId), COUNT-based, and loop-scoped checks all work
         * here for free — nothing new to evaluate.
         */
        if (rule.check && evaluateCondition(rule.check, ctx)) fail(ruleError(rule, "Invalid answer."));
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
  /*
   * A rule's message is a plain string until it reaches a respondent — piped
   * here, once, the same way question text already is (`resolvePiping`), so
   * "You selected {{Q2.count}} brands" resolves for every rule kind, not
   * just kind:"condition". A message with no `{{` is returned unchanged, so
   * this is a no-op for the vast majority of existing, un-piped messages.
   */
  const push = (message: string, extra?: Partial<ValidationError>) =>
    errors.push({ questionId: q.id, message: resolvePiping(message, ctx), ...extra });

  // implicit required
  if (q.required && isEmpty(value)) {
    push("This question is required.");
  }

  /*
   * ANCHORED MAXDIFF: the follow-up is part of the answer (§17).
   *
   * A set the respondent chose best and worst in, but skipped the anchor on,
   * looks complete — `isEmpty` recurses into the object and finds two values.
   * The anchor would then be missing for that task and the utility scale
   * would be identified by however many respondents happened to answer it,
   * with nothing on screen to say so.
   *
   * Only for a task the respondent actually engaged with: nagging about the
   * anchor on a set they have not touched would put the follow-up before the
   * question it follows. And only for anchored designs, which are new — no
   * existing survey's validation changes.
   */
  if (q.type === "maxdiff_task" && !isEmpty(value) && typeof value === "object") {
    const design = def.designs?.find((d) => d.id === q.settings.designRef);
    if ((design?.config as { anchored?: boolean } | undefined)?.anchored) {
      const tasks = value as Record<string, { best?: unknown; worst?: unknown; anchor?: unknown }>;
      const missing = Object.entries(tasks)
        .filter(([, t]) => t && typeof t === "object" && (t.best != null || t.worst != null) && isEmpty(t.anchor))
        .map(([taskId]) => taskId);
      if (missing.length) {
        push(
          missing.length === 1
            ? `Please also answer the follow-up question for set ${missing[0]}.`
            : `Please also answer the follow-up question for sets ${missing.join(", ")}.`,
        );
      }
    }
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
        // the iteration's own "other" text, then the enclosing iterations',
        // then the plain one — same rule as every other loop-scoped read
        const raw = lookupAnswer(answers as never, `${q.id}__other`, ctx.loop) ??
          answers[`${answerKey(q.id, ctx.loop)}__other`];
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
  /*
   * DATE BOUNDS FROM SETTINGS.
   *
   * `minDate` / `maxDate` / `disabledWeekdays` were enforced only by the date
   * picker, so going Back, resuming a session or posting a crafted save wrote
   * an out-of-range date that every later calculation then trusted. The
   * renderer still narrows what is easy to pick; this is what makes it true.
   */
  if (!isEmpty(value) && (q.type === "date" || q.type === "datetime")) {
    const got = asDate(value);
    const lo = dateBound(q.settings.minDate, ctx);
    const hi = dateBound(q.settings.maxDate, ctx);
    if (got != null && lo != null && got < lo)
      push(`Please choose a date on or after ${new Date(lo).toISOString().slice(0, 10)}.`);
    if (got != null && hi != null && got > hi)
      push(`Please choose a date on or before ${new Date(hi).toISOString().slice(0, 10)}.`);
    const blocked = q.settings.disabledWeekdays;
    if (got != null && blocked?.length && blocked.includes(new Date(got).getUTCDay()))
      push("That day of the week is not available — please choose another date.");
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
    const severity = rule.severity ?? "error";
    if (["sum_equals", "sum_max", "sum_min"].includes(rule.kind) && value && typeof value === "object" && !Array.isArray(value)) {
      const total = Object.values(value as Record<string, unknown>).reduce(
        (a: number, b) => a + (Number(b) || 0),
        0,
      );
      if (rule.kind === "sum_equals" && total !== Number(rule.value))
        push(ruleError(rule, `Total must equal ${rule.value}.`), { severity });
      if (rule.kind === "sum_max" && total > Number(rule.value))
        push(ruleError(rule, `Total must be at most ${rule.value}.`), { severity });
      if (rule.kind === "sum_min" && total < Number(rule.value))
        push(ruleError(rule, `Total must be at least ${rule.value}.`), { severity });
    }

    /*
     * COLUMN TOTALS — the counterpart of `settings.rowSum`.
     *
     * A grid that allocates down a column ("split 100 points across these
     * brands, for each of these occasions") had no rule: the engine could
     * total a row and nothing else, so the check was written by hand in a
     * custom expression or not at all. `ref` names one column; without it
     * every editable column is held to the same total.
     */
    if (rule.kind.startsWith("column_sum") && (q.type === "composite" || q.type === "custom_table")) {
      /*
       * A grid nobody has touched is not a failed total — it is an unanswered
       * optional question, and telling a respondent their empty columns do not
       * add up is the same mistake the row-sum rule already avoids.
       */
      if (isEmpty(value) && !q.required) continue;
      const view = effectiveQuestion(q, ctx);
      const cells = (value ?? {}) as Record<string, Record<string, unknown>>;
      const cols = view.columns.filter((c) => !c.readOnly && !c.expression && (!rule.ref || c.id === rule.ref));
      for (const col of cols) {
        const total = view.rows.reduce((a, r) => a + (Number(cells?.[String(r.code)]?.[col.id]) || 0), 0);
        const label = col.label.replace(/<[^>]*>/g, "");
        const target = Number(rule.value);
        if (rule.kind === "column_sum_equals" && total !== target)
          push(ruleError(rule, `“${label}” must total ${target} (currently ${total}).`), { columnId: col.id, severity });
        if (rule.kind === "column_sum_max" && total > target)
          push(ruleError(rule, `“${label}” must total at most ${target} (currently ${total}).`), { columnId: col.id, severity });
        if (rule.kind === "column_sum_min" && total < target)
          push(ruleError(rule, `“${label}” must total at least ${target} (currently ${total}).`), { columnId: col.id, severity });
      }
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
      richTextValue, ctx, (m, sev) => push(m, { severity: sev }),
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
    (m, sev) => push(m, { severity: sev }),
  );

  // composite: per-column validation over visible rows
  if ((q.type === "composite" || q.type === "custom_table") && q.columns.length) {
    const view = effectiveQuestion(q, ctx);
    const cells = (value ?? {}) as Record<string, Record<string, unknown>>;
    for (const row of view.rows) {
      for (const col of view.columns) {
        const cellValue = cells?.[String(row.code)]?.[col.id];
        if (col.readOnly || col.expression) continue;
        checkScalarRules(col.validation, cellValue, ctx, (m, sev) =>
          push(`${row.label} — ${col.label}: ${m}`, { rowCode: String(row.code), columnId: col.id, severity: sev }),
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
      checkScalarRules(row.validation ?? [], v, ctx, (m, sev) =>
        push(`${label}: ${m}`, { rowCode: rc, severity: sev }),
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
    const value = lookupAnswer(ctx.state.answers, q.id, ctx.loop);
    errors.push(...validateQuestion(def, q, value, ctx));
  }
  return errors;
}
