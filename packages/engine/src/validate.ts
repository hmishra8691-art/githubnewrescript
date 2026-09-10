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
import { geoAnswered, geoProblems } from "./geo.js";

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
  /**
   * WHICH ITERATION failed, when the question sits inside a loop (§28).
   *
   * Until this existed the iteration was identifiable only by which page the
   * error happened to appear on — fine for a respondent looking at that page,
   * useless everywhere else: a test-mode report, a data-quality review or a
   * scripted check saw ten identical "Rating must be 1-5" errors with nothing
   * to say which brand each belonged to. Absent for a question outside any
   * loop, so nothing that predates it changes.
   */
  loop?: { loopId: string; loopVar: string; itemCode: string; itemLabel: string; index: number };
}

/** The checks that actually stop the page. */
export function blockingErrors(errors: ValidationError[]): ValidationError[] {
  return errors.filter((e) => (e.severity ?? "error") === "error");
}

/** The checks that are worth saying but must not stop anyone. */
export function warnings(errors: ValidationError[]): ValidationError[] {
  return errors.filter((e) => e.severity === "warning");
}

/*
 * Whitespace is not an answer. A respondent who types a space into a required
 * open end has told us nothing, and every research platform treats that as
 * blank — so `required` must reject it rather than accept a string that will
 * arrive in the data file as " ". Trimming here rather than at each call site
 * covers scalars, array members and grid cells at once, since every emptiness
 * question in this file comes through this one function.
 */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    return Object.values(v as object).every((x) => isEmpty(x));
  }
  return false;
}

function ruleError(rule: ValidationRule, fallback: string): string {
  return rule.message ?? fallback;
}

/**
 * True when this question is built from a set of items (options, rows or
 * columns) and the pipeline has left it with none of them — so there is
 * nothing on screen for the respondent to choose.
 *
 * Deliberately compares the EFFECTIVE view against the AUTHORED question: a
 * question that never had items (open text, numeric, date, upload) returns
 * false and keeps its ordinary requiredness. Only a question that had items
 * and lost them all — an empty mask, a carry-forward from an unanswered
 * source, a List Fill that allocated nothing — is treated as unanswerable.
 */
function hasNoAnswerableItems(q: Question, ctx: EvalContext): boolean {
  const authoredItems = q.options.length + q.rows.length;
  if (authoredItems === 0) return false;
  const view = effectiveQuestion(q, ctx);
  // A grid needs both axes; a flat list needs only its options.
  if (q.rows.length > 0 && view.rows.length === 0) return true;
  if (q.options.length > 0 && view.options.length === 0) return true;
  if (q.columns.length > 0 && view.columns.length === 0) return true;
  return false;
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
  /*
   * The iteration this check is running in, attached to every error the
   * question raises. Taken from `ctx.loop` — the innermost enclosing
   * iteration, which is the one the question is actually being asked in —
   * rather than from anything the rule itself has to declare, so every rule
   * kind gets it for free and none of them had to change.
   */
  const iteration: ValidationError["loop"] | undefined = ctx.loop
    ? {
        loopId: ctx.loop.loopId ?? "",
        loopVar: ctx.loop.loopVar,
        itemCode: ctx.loop.code,
        itemLabel: ctx.loop.label,
        index: ctx.loop.index,
      }
    : undefined;
  const push = (message: string, extra?: Partial<ValidationError>) =>
    errors.push({
      questionId: q.id,
      message: resolvePiping(message, ctx),
      ...(iteration ? { loop: iteration } : {}),
      ...extra,
    });

  /*
   * Implicit required — but never on a question the respondent cannot answer.
   *
   * A mask, a carry-forward or a List Fill that resolves to nothing leaves an
   * option-bearing question on the page with an empty list. Requiring an
   * answer there is an unanswerable blocking page: the respondent is told to
   * answer, and has nothing to answer with. The three masking cases (§M156-158
   * — empty source, zero rows, zero columns) all land here, so the guard is on
   * the *effective* item collection rather than on any one mask field.
   *
   * `hasNoAnswerableItems` is false for types that legitimately have no items
   * (open text, numeric, date), so requiredness on those is untouched.
   */
  if (q.required && isEmpty(value) && !hasNoAnswerableItems(q, ctx)) {
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

  /*
   * DESIGN TASKS — one answer per task of the design. `required` means every
   * task answered: a chosen alternative (CBC), a best AND a worst (MaxDiff),
   * or a menu decision (MBC — a non-empty set of items, or the explicit
   * "nothing"). Menu tasks also honour the design's min/max selections.
   */
  if (q.type === "conjoint_task" && q.required && !hasNoAnswerableItems(q, ctx)) {
    const design = def.designs.find((d) => d.id === q.settings.designRef);
    const rows = (design?.file?.rows ?? []) as Record<string, unknown>[];
    if (rows.length) {
      const tasks = [...new Set(rows.map((r) => String(r.task)))];
      const vals = (value ?? {}) as Record<string, unknown>;
      // a menu with a required base: an empty tick-list is "just the base", a decision; without one it is no decision
      const requiredOn = (t: string) => rows.filter((r) => String(r.task) === t && Number(r.required) === 1).length;
      const missing = tasks.filter((t) => {
        const v = vals[t];
        if (design?.kind === "menu") return !Array.isArray(v) || (v.length === 0 && requiredOn(t) === 0);
        return v == null || v === "";
      });
      if (missing.length && !isEmpty(value)) push(`Please answer ${missing.length === 1 ? `task ${missing[0]}` : `every task (${missing.length} left)`}.`);
      if (design?.kind === "menu") {
        const cfg = (design.config ?? {}) as { minSelections?: number; maxSelections?: number };
        for (const t of tasks) {
          const v = vals[t];
          if (!Array.isArray(v) || v.includes("none")) continue;
          // the limits count the whole bundle, required items included — the same count the renderer shows
          const picked = v.filter((x) => x !== "none").length + requiredOn(t);
          if (cfg.minSelections && picked < cfg.minSelections) push(`Task ${t}: please pick at least ${cfg.minSelections} item${cfg.minSelections === 1 ? "" : "s"}.`);
          if (cfg.maxSelections && picked > cfg.maxSelections) push(`Task ${t}: please pick at most ${cfg.maxSelections} item${cfg.maxSelections === 1 ? "" : "s"}.`);
        }
      }
    }
  }

  // geo: "answered" depends on the mode (geo.ts); then radius bounds and coordinate sanity
  if (q.type === "geo") {
    if (q.required && !geoAnswered(q, value) && !hasNoAnswerableItems(q, ctx)) {
      if (isEmpty(value)) { /* the generic required message above already fired */ }
      else push(q.settings.geoMode === "address" ? "Please enter or choose an address." : "Please place the pin on the map.");
    }
    for (const m of geoProblems(q, value)) push(m);
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

  /*
   * MATRIX: per-row rules, and the question's own scalar rules applied per
   * cell (§V092 "each rating must be 1-5", §V094 required cell, §V098).
   *
   * A matrix answer is an object keyed by row, so a rule like `min_value`
   * written at question level was handed that whole object, `Number({...})`
   * gave NaN, and the rule silently passed — while the properties panel went
   * on offering min/max for `matrix_numeric` as though it worked. Per-row
   * rules had the same fate from the other direction: the canvas wrote
   * `row.validation` for any matrix, and only `text_list`/`numeric_list` ever
   * read it back.
   *
   * Both are answered here by running the SAME `checkScalarRules` per cell
   * that every other shape already uses — no matrix-specific rule engine, so
   * a kind added anywhere works here too. Rows come from `effectiveQuestion`,
   * so a masked-away row is exempt, which is what §V099 asks for.
   */
  if (q.type.startsWith("matrix") && q.rows.length > 0) {
    const view = effectiveQuestion(q, ctx);
    const cells = (value ?? {}) as Record<string, unknown>;
    /*
     * Cell-scoped kinds only. `required` is handled per row just above, and
     * the selection-count and aggregate kinds are about the answer as a
     * whole — running those per cell would report the same failure once per
     * row.
     */
    const cellKinds = q.validation.filter((r) =>
      !["required", "min_selections", "max_selections", "sum_equals", "sum_max", "sum_min",
        "column_sum_equals", "column_sum_max", "column_sum_min"].includes(r.kind));
    for (const row of view.rows) {
      const rc = String(row.code);
      const cell = cells?.[rc];
      const label = row.label.replace(/<[^>]*>/g, "");
      if (cellKinds.length && !isEmpty(cell)) {
        checkScalarRules(cellKinds, cell, ctx, (m, sev) =>
          push(`${label}: ${m}`, { rowCode: rc, severity: sev }),
        );
      }
      checkScalarRules(row.validation ?? [], cell, ctx, (m, sev) =>
        push(`${label}: ${m}`, { rowCode: rc, severity: sev }),
      );
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
