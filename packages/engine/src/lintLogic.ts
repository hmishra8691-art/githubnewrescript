import type {
  ComparisonOperator,
  Condition,
  ListOperation,
  OptionLogic,
  Question,
  SurveyDefinition,
} from "@rescript/schema";
import {
  LIST_VALUE_OPERATORS,
  OPERATORS_BY_KIND,
  TWO_VALUE_OPERATORS,
  VALUELESS_OPERATORS,
  isOptionValueRef,
} from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { PIPE_TOKEN_RE, parsePipeBody } from "./pipingTokens.js";
import { describeCycle, detectLogicCycles, orderIndex } from "./dependencies.js";

/**
 * Logic configuration linting (reqs §30–31).
 *
 * Runs entirely on the definition — no responses needed — so Studio can show
 * problems while the programmer types, and a release check can refuse to
 * deploy a survey whose logic references things that no longer exist.
 */

export interface LogicIssue {
  level: "error" | "warning";
  /** where it was found */
  questionId?: string;
  questionCode?: string;
  optionCode?: string;
  /** dotted path inside the question, e.g. "options[3].logic.eligibleWhen" */
  path: string;
  message: string;
}

/** Which operator family a question's answers belong to. */
export function sourceKindForQuestion(q: Question | undefined): keyof typeof OPERATORS_BY_KIND {
  if (!q) return "any";
  const t = q.type;
  if (["multi_select", "multi_dropdown", "image_select", "matrix_multi"].includes(t)) return "list";
  if (["single_select", "dropdown", "matrix_single", "matrix_dropdown"].includes(t)) return "choice";
  if (["open_text", "long_text", "text_list", "matrix_text"].includes(t)) return "text";
  if (["numeric", "slider", "nps", "numeric_list", "allocation", "matrix_numeric"].includes(t))
    return "numeric";
  if (["ranking", "image_ranking"].includes(t)) return "ranking";
  if (["date", "time"].includes(t)) return "date";
  return "any";
}

/** Operators that make sense for a source question (req §7). */
export function operatorsForQuestion(q: Question | undefined): ComparisonOperator[] {
  const kind = sourceKindForQuestion(q);
  const set = new Set<ComparisonOperator>([
    ...OPERATORS_BY_KIND.any,
    ...(OPERATORS_BY_KIND[kind] ?? []),
  ]);
  // an unknown / open question type shouldn't be artificially restricted
  if (kind === "any") for (const list of Object.values(OPERATORS_BY_KIND)) list.forEach((o) => set.add(o));
  return [...set];
}

function optionCodes(q: Question): Set<string> {
  const s = new Set<string>();
  for (const o of q.options ?? []) s.add(String(o.code));
  for (const r of q.rows ?? []) s.add(String(r.code));
  for (const c of q.columns ?? []) for (const o of c.options ?? []) s.add(String(o.code));
  return s;
}

interface Ctx {
  def: SurveyDefinition;
  q: Question;
  order: Record<string, number>;
  /** the option-level context is available (so `{ $option }` values are legal) */
  perOption: boolean;
  push(issue: Omit<LogicIssue, "questionId" | "questionCode">): void;
}

function lintCondition(
  c: Condition | undefined | null,
  path: string,
  ctx: Ctx,
  depth = 0,
): void {
  if (!c) return;
  if (c.type === "group") {
    if (!c.children || c.children.length === 0) {
      /*
       * An empty list at the TOP of a logic tree is the normal starting state
       * of the builder — conditions are added first, and until then there is
       * simply no constraint. Reporting it made "1 logic note" appear the
       * moment a programmer opened the panel, which is the noise this counter
       * exists to avoid. A NESTED empty group is different: inside an OR it
       * would make the whole bracket pass, so it stays an issue.
       */
      if (depth > 0) {
        ctx.push({ level: "warning", path, message: "Empty condition group — it always passes." });
      }
      return;
    }
    c.children.forEach((child, i) => lintCondition(child, `${path}.${c.op}[${i}]`, ctx, depth + 1));
    return;
  }

  const { source, operator } = c;

  if (source.kind === "option" && !ctx.perOption) {
    ctx.push({
      level: "error",
      path,
      message: "“This option” can only be used in option-level logic or a filter operation.",
    });
  }
  if (isOptionValueRef(c.value) && !ctx.perOption) {
    ctx.push({
      level: "error",
      path,
      message: "“This option” can only be compared inside option-level logic or a filter.",
    });
  }

  let src: Question | undefined;
  if (source.kind === "question" || source.kind === "variable") {
    if (!source.ref) {
      ctx.push({ level: "error", path, message: "Condition has no source question selected." });
      return;
    }
    src = getQuestionByCodeOrVar(ctx.def, source.ref);
    const isNamedVariable =
      (ctx.def.calculations ?? []).some((x) => x.targetVariable === source.ref) ||
      (ctx.def.embeddedData ?? []).some((x) => x.name === source.ref);
    if (!src && !isNamedVariable) {
      ctx.push({
        level: "error",
        path,
        message: `References “${source.ref}”, which does not exist in this survey.`,
      });
      return;
    }
    if (src) {
      const here = ctx.order[ctx.q.id] ?? 0;
      const there = ctx.order[src.id] ?? 0;
      if (there > here) {
        ctx.push({
          level: "warning",
          path,
          message: `${src.code} comes after ${ctx.q.code} in the flow — it will be unanswered unless the respondent goes back.`,
        });
      }
      const allowed = operatorsForQuestion(src);
      if (!allowed.includes(operator)) {
        ctx.push({
          level: "error",
          path,
          message: `Operator “${operator}” cannot be used with ${src.code} (${src.type}).`,
        });
      }
      // deleted option codes
      if (!isOptionValueRef(c.value) && (src.options?.length ?? 0) > 0) {
        const codes = optionCodes(src);
        const values = Array.isArray(c.value) ? c.value : [c.value];
        const codeBased =
          ["selected", "notSelected", "eq", "ne", "in", "notIn", "contains", "notContains"].includes(
            operator,
          ) || LIST_VALUE_OPERATORS.includes(operator);
        if (codeBased && sourceKindForQuestion(src) !== "text") {
          for (const v of values) {
            if (v === "" || v === null || v === undefined) continue;
            if (!codes.has(String(v))) {
              ctx.push({
                level: "warning",
                path,
                message: `${src.code} has no option coded “${v}” — it may have been renamed or deleted.`,
              });
            }
          }
        }
      }
      if (source.rowCode && !(src.rows ?? []).some((r) => String(r.code) === String(source.rowCode))) {
        ctx.push({
          level: "warning",
          path,
          message: `${src.code} has no row “${source.rowCode}”.`,
        });
      }
      if (source.columnId && !(src.columns ?? []).some((x) => x.id === source.columnId)) {
        ctx.push({
          level: "warning",
          path,
          message: `${src.code} has no column “${source.columnId}”.`,
        });
      }
    }
  }

  if (!VALUELESS_OPERATORS.includes(operator) && (c.value === undefined || c.value === "")) {
    ctx.push({ level: "warning", path, message: `Operator “${operator}” has no value set.` });
  }
  if (TWO_VALUE_OPERATORS.includes(operator) && (c.value2 === undefined || c.value2 === "")) {
    ctx.push({ level: "warning", path, message: `Operator “${operator}” needs a second value.` });
  }
}

function lintOptionLogic(l: OptionLogic | undefined, path: string, ctx: Ctx): void {
  if (!l) return;
  if (l.visibility === "show_when" && !l.when) {
    ctx.push({ level: "error", path: `${path}.when`, message: "“Show when” has no condition." });
  }
  if (l.visibility === "hide_when" && !l.when) {
    ctx.push({ level: "error", path: `${path}.when`, message: "“Hide when” has no condition." });
  }
  if (l.visibility === "always_show" && l.excludeWhen) {
    ctx.push({
      level: "warning",
      path: `${path}.excludeWhen`,
      message: "“Always show” is overridden by this Exclude When rule.",
    });
  }
  lintCondition(l.when, `${path}.when`, ctx);
  lintCondition(l.eligibleWhen, `${path}.eligibleWhen`, ctx);
  lintCondition(l.excludeWhen, `${path}.excludeWhen`, ctx);
  lintCondition(l.prioritizeWhen, `${path}.prioritizeWhen`, ctx);
  lintCondition(l.deprioritizeWhen, `${path}.deprioritizeWhen`, ctx);
  lintCondition(l.randomizeWhen, `${path}.randomizeWhen`, ctx);

  for (const [name, rule] of [
    ["carryForward", l.carryForward],
    ["carryBack", l.carryBack],
  ] as const) {
    if (!rule) continue;
    const src = ctx.def.questions.find((x) => x.id === rule.sourceQuestionId);
    if (!src) {
      ctx.push({
        level: "error",
        path: `${path}.${name}`,
        message: `${name === "carryForward" ? "Carry forward" : "Carry back"} references a question that no longer exists.`,
      });
      continue;
    }
    const here = ctx.order[ctx.q.id] ?? 0;
    const there = ctx.order[src.id] ?? 0;
    if (name === "carryForward" && there > here) {
      ctx.push({
        level: "warning",
        path: `${path}.${name}`,
        message: `${src.code} comes after ${ctx.q.code} — use Carry Back for a later question.`,
      });
    }
    if (name === "carryBack" && there < here) {
      ctx.push({
        level: "warning",
        path: `${path}.${name}`,
        message: `${src.code} comes before ${ctx.q.code} — Carry Forward is the right rule here.`,
      });
    }
  }
}

function lintListOps(ops: ListOperation[] | undefined, ctx: Ctx): void {
  ops?.forEach((op, i) => {
    const path = `optionPipeline[${i}]`;
    const needsSources = [
      "carry_forward",
      "union",
      "intersect",
      "difference",
      "exclude",
      "remaining",
      "prioritize",
      "deprioritize",
    ].includes(op.kind);
    if (needsSources && (op.sources ?? []).length === 0) {
      ctx.push({
        level: "error",
        path,
        message: `“${op.kind.replace("_", " ")}” needs at least one source question.`,
      });
    }
    if (op.kind === "difference" && (op.sources ?? []).length < 2) {
      ctx.push({
        level: "warning",
        path,
        message: "Difference needs two or more lists to subtract anything.",
      });
    }
    if (op.kind === "filter" && !op.where) {
      ctx.push({ level: "error", path, message: "Filter operation has no condition." });
    }
    for (const s of op.sources ?? []) {
      if (!(ctx.def.questions ?? []).some((x) => x.id === s.questionId)) {
        ctx.push({
          level: "error",
          path,
          message: "Source question no longer exists.",
        });
      } else if ((ctx.order[s.questionId] ?? 0) > (ctx.order[ctx.q.id] ?? 0)) {
        const src = ctx.def.questions.find((x) => x.id === s.questionId)!;
        ctx.push({
          level: "warning",
          path,
          message: `${src.code} comes after ${ctx.q.code} in the flow.`,
        });
      }
    }
    lintCondition(op.when, `${path}.when`, ctx);
    // `where` is evaluated per option
    lintCondition(op.where, `${path}.where`, { ...ctx, perOption: true });
  });
}

function lintPiping(text: string | undefined, path: string, ctx: Ctx): void {
  if (!text || !text.includes("{{")) return;
  for (const m of text.matchAll(PIPE_TOKEN_RE)) {
    const t = parsePipeBody(m[1], m[0]);
    if (!t) {
      ctx.push({ level: "error", path, message: `Malformed piping token ${m[0]}.` });
      continue;
    }
    if (t.kind === "calc") {
      if (!(ctx.def.calculations ?? []).some((c) => c.targetVariable === t.ref))
        ctx.push({ level: "warning", path, message: `No calculation named “${t.ref}”.` });
      continue;
    }
    if (t.kind === "embedded") {
      if (!(ctx.def.embeddedData ?? []).some((e) => e.name === t.ref))
        ctx.push({ level: "warning", path, message: `No embedded data field named “${t.ref}”.` });
      continue;
    }
    if (t.kind !== "question") continue;
    const src = getQuestionByCodeOrVar(ctx.def, t.ref);
    if (!src) {
      ctx.push({ level: "error", path, message: `Pipes from “${t.ref}”, which does not exist.` });
      continue;
    }
    if ((ctx.order[src.id] ?? 0) > (ctx.order[ctx.q.id] ?? 0)) {
      ctx.push({
        level: "warning",
        path,
        message: `Pipes from ${src.code}, which is asked after ${ctx.q.code} — it will be blank.`,
      });
    }
    if (t.rowCode && !(src.rows ?? []).some((r) => String(r.code) === String(t.rowCode))) {
      ctx.push({ level: "warning", path, message: `${src.code} has no row “${t.rowCode}”.` });
    }
  }
}

/**
 * Lint one question's logic configuration.
 *
 * Never throws: Studio calls this during render, and a half-migrated or
 * hand-edited definition must surface as a reported problem rather than
 * taking the whole panel down.
 */
/**
 * Counts that cannot be what they say. The Studio's inputs refuse these now,
 * but a definition can arrive from JSON, an import or an older build, and
 * "select at least -5" must be reported rather than quietly treated as 0.
 */
function lintCounts(q: Question, push: (i: Omit<LogicIssue, "questionId" | "questionCode">) => void): void {
  const st = q.settings ?? {};
  const counts: [string, number | undefined, number][] = [
    ["minSelections", st.minSelections, 0],
    ["maxSelections", st.maxSelections, 1],
    ["listCount", st.listCount, 1],
    ["columnsLayout", st.columnsLayout, 1],
  ];
  for (const [name, v, floor] of counts) {
    if (v == null) continue;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < floor) {
      push({
        level: "error",
        path: `settings.${name}`,
        message: `${name} is ${v} — it must be a whole number of at least ${floor}.`,
      });
    }
  }
  if (st.minSelections != null && st.maxSelections != null && st.minSelections > st.maxSelections) {
    push({
      level: "error",
      path: "settings.minSelections",
      message: `minSelections (${st.minSelections}) is above maxSelections (${st.maxSelections}) — no answer can satisfy both.`,
    });
  }
  const pick = q.randomization?.pick;
  if (pick != null && (!Number.isInteger(pick) || pick < 1)) {
    push({ level: "error", path: "randomization.pick", message: `“show only” is ${pick} — it must be a whole number of at least 1.` });
  }
}

export function lintQuestionLogic(def: SurveyDefinition, q: Question): LogicIssue[] {
  try {
    return lintQuestionLogicUnsafe(def, q);
  } catch (err) {
    return [{
      level: "error",
      questionId: q?.id,
      questionCode: q?.code,
      path: "definition",
      message: `This question could not be analysed: ${(err as Error)?.message ?? err}`,
    }];
  }
}

function lintQuestionLogicUnsafe(def: SurveyDefinition, q: Question): LogicIssue[] {
  const issues: LogicIssue[] = [];
  const order = orderIndex(def);
  lintCounts(q, (i) => issues.push({ ...i, questionId: q.id, questionCode: q.code }));
  const base = (perOption: boolean): Ctx => ({
    def,
    q,
    order,
    perOption,
    push: (i) => issues.push({ ...i, questionId: q.id, questionCode: q.code }),
  });
  const ctx = base(false);
  const optCtx = base(true);

  lintCondition(q.displayLogic, "displayLogic", ctx);
  (q.skipLogic ?? []).forEach((r, i) => lintCondition(r.when, `skipLogic[${i}].when`, ctx));
  (q.validation ?? []).forEach((v, i) => lintCondition(v.when, `validation[${i}].when`, ctx));
  (q.randomization?.rules ?? []).forEach((r, i) =>
    lintCondition(r.when, `randomization.rules[${i}].when`, ctx),
  );

  if (q.carryForward) {
    if (!def.questions.some((x) => x.id === q.carryForward!.sourceQuestionId)) {
      issues.push({
        level: "error",
        questionId: q.id,
        questionCode: q.code,
        path: "carryForward",
        message: "Carry-forward source question no longer exists.",
      });
    }
    lintCondition(q.carryForward.where, "carryForward.where", optCtx);
  }
  (q.listLogic ?? []).forEach((r, i) => {
    if (!def.questions.some((x) => x.id === r.sourceQuestionId)) {
      issues.push({
        level: "error",
        questionId: q.id,
        questionCode: q.code,
        path: `listLogic[${i}]`,
        message: "List logic source question no longer exists.",
      });
    }
    lintCondition(r.when, `listLogic[${i}].when`, ctx);
  });

  lintListOps(q.optionPipeline, ctx);

  q.options?.forEach((o, i) => {
    const push = (issue: Omit<LogicIssue, "questionId" | "questionCode">) =>
      issues.push({ ...issue, questionId: q.id, questionCode: q.code, optionCode: String(o.code) });
    const oc: Ctx = { ...optCtx, push };
    lintCondition(o.visibleIf, `options[${i}].visibleIf`, oc);
    lintOptionLogic(o.logic, `options[${i}].logic`, oc);
    lintPiping(o.label, `options[${i}].label`, oc);
  });
  q.rows?.forEach((r, i) => {
    const push = (issue: Omit<LogicIssue, "questionId" | "questionCode">) =>
      issues.push({ ...issue, questionId: q.id, questionCode: q.code, optionCode: String(r.code) });
    const rc: Ctx = { ...optCtx, push };
    lintCondition(r.visibleIf, `rows[${i}].visibleIf`, rc);
    lintOptionLogic(r.logic, `rows[${i}].logic`, rc);
    lintPiping(r.label, `rows[${i}].label`, rc);
  });
  q.columns?.forEach((c, i) => {
    lintCondition(c.visibleIf, `columns[${i}].visibleIf`, ctx);
    c.options?.forEach((o, j) => lintOptionLogic(o.logic, `columns[${i}].options[${j}].logic`, optCtx));
  });

  lintPiping(q.text, "text", ctx);
  lintPiping(q.instruction, "instruction", ctx);
  lintPiping(q.description, "description", ctx);

  return issues;
}

/** Lint the whole survey, including circular dependencies (req §31). */
export function lintSurveyLogic(def: SurveyDefinition): LogicIssue[] {
  const issues: LogicIssue[] = [];
  for (const q of def.questions ?? []) issues.push(...lintQuestionLogic(def, q));
  try {
    for (const cycle of detectLogicCycles(def)) {
      issues.push({
        level: "error",
        questionId: cycle[0],
        questionCode: def.questions.find((q) => q.id === cycle[0])?.code,
        path: "dependencies",
        message: describeCycle(def, cycle),
      });
    }
  } catch {
    /* an unanalysable graph is already reported per question */
  }
  return issues;
}
