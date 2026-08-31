import type { Question, Option, QuestionRow, CarryForward } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { getQuestion } from "./state.js";
import { resolvePiping } from "./piping.js";
import { seededShuffle, subSeed } from "./random.js";

/**
 * Dynamic option pass-through / carry-forward (requirement §4) and
 * per-question effective display model:
 *  - carry-forward selected/not-selected/displayed options from any earlier question
 *  - option-level visibleIf conditions
 *  - randomization with anchors and groups
 *  - piping inside option labels
 */

export interface EffectiveQuestionView {
  options: Option[];
  rows: QuestionRow[];
  columns: Question["columns"];
}

function sourceCodes(cf: CarryForward, ctx: EvalContext): (string | number)[] {
  const src = getQuestion(ctx.def, cf.sourceQuestionId);
  if (!src) return [];
  const loopKey = ctx.loop ? `${src.id}@${ctx.loop.code}` : null;
  const answer =
    (loopKey ? ctx.state.answers[loopKey] : undefined) ?? ctx.state.answers[src.id];
  const selected = Array.isArray(answer)
    ? answer
    : answer == null
      ? []
      : typeof answer === "object"
        ? Object.keys(answer)
        : [answer as string | number];

  const displayed = effectiveQuestion(src, ctx).options.map((o) => o.code);

  switch (cf.filter) {
    case "selected":
      return selected as (string | number)[];
    case "not_selected":
      return displayed.filter((c) => !selected.some((s) => String(s) === String(c)));
    case "displayed":
      return displayed;
    case "answered_rows": {
      if (answer && typeof answer === "object" && !Array.isArray(answer)) {
        return Object.entries(answer as Record<string, unknown>)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k]) => k);
      }
      return selected as (string | number)[];
    }
    case "all":
    default:
      return src.options.map((o) => o.code);
  }
}

function carriedOptions(cf: CarryForward, ctx: EvalContext): Option[] {
  const src = getQuestion(ctx.def, cf.sourceQuestionId);
  if (!src) return [];
  const codes = sourceCodes(cf, ctx);
  const pool: Option[] = codes.map((code) => {
    const opt = src.options.find((o) => String(o.code) === String(code));
    const row = src.rows.find((r) => String(r.code) === String(code));
    return (
      opt ?? {
        code,
        label: row?.label ?? String(code),
        flags: [],
      }
    );
  });
  if (!cf.where) return pool;
  // per-option filter: expose the option code as loop-like variable "option"
  return pool.filter((o) =>
    evaluateCondition(cf.where, {
      ...ctx,
      loop: { loopVar: "option", code: String(o.code), label: o.label, index: 0 },
    }),
  );
}

function applyRandomization(q: Question, options: Option[], ctx: EvalContext): Option[] {
  const r = q.randomization;
  if (!r?.enabled || r.scope !== "options") return options;
  const anchorTop = options.filter((o) => o.flags?.includes("anchor_top"));
  const anchorBottom = options.filter(
    (o) =>
      o.flags?.includes("anchor_bottom") ||
      o.flags?.includes("none_of_above") ||
      o.flags?.includes("dont_know") ||
      o.flags?.includes("refused"),
  );
  const middle = options.filter((o) => !anchorTop.includes(o) && !anchorBottom.includes(o));
  const seed = subSeed(ctx.state.seed, `rand:${q.id}${ctx.loop ? `@${ctx.loop.code}` : ""}`);
  let shuffled: Option[];
  if (r.groups?.length) {
    // shuffle inside declared groups, keep group order
    shuffled = [];
    const used = new Set<Option>();
    for (const [gi, group] of r.groups.entries()) {
      const members = middle.filter((o) => group.some((c) => String(c) === String(o.code)));
      members.forEach((m) => used.add(m));
      shuffled.push(...seededShuffle(members, subSeed(seed, `g${gi}`)));
    }
    shuffled.push(...middle.filter((o) => !used.has(o)));
  } else if (r.method === "reverse_half") {
    shuffled = subSeed(seed, "rh") % 2 === 0 ? middle : [...middle].reverse();
  } else if (r.method === "rotate") {
    const k = middle.length ? subSeed(seed, "rot") % middle.length : 0;
    shuffled = [...middle.slice(k), ...middle.slice(0, k)];
  } else {
    shuffled = seededShuffle(middle, seed);
  }
  return [...anchorTop, ...shuffled, ...anchorBottom];
}

/**
 * Compute what a question actually displays for the current respondent:
 * carry-forward resolved, visibleIf filtered, randomized, labels piped.
 */
export function effectiveQuestion(q: Question, ctx: EvalContext): EffectiveQuestionView {
  // --- options
  let options: Option[] = [];
  if (q.carryForward && q.carryForward.into === "options") {
    options = carriedOptions(q.carryForward, ctx);
    if (q.carryForward.keepOwn) options = [...options, ...q.options];
  } else {
    options = [...q.options];
  }
  options = options.filter((o) => evaluateCondition(o.visibleIf, ctx));
  options = applyRandomization(q, options, ctx);
  options = options.map((o) =>
    o.label.includes("{{") ? { ...o, label: resolvePiping(o.label, ctx) } : o,
  );

  // --- rows
  let rows: QuestionRow[] = [];
  if (q.carryForward && q.carryForward.into === "rows") {
    rows = carriedOptions(q.carryForward, ctx).map((o) => ({
      code: o.code,
      label: o.label,
      flags: [],
    }));
    if (q.carryForward.keepOwn) rows = [...rows, ...q.rows];
  } else {
    rows = [...q.rows];
  }
  rows = rows.filter((r) => evaluateCondition(r.visibleIf, ctx));
  if (q.randomization?.enabled && q.randomization.scope === "rows") {
    const seed = subSeed(ctx.state.seed, `randrows:${q.id}`);
    rows = seededShuffle(rows, seed);
  }
  rows = rows.map((r) =>
    r.label.includes("{{") ? { ...r, label: resolvePiping(r.label, ctx) } : r,
  );

  // --- columns (composite / matrix)
  let columns = q.columns.filter((c) => evaluateCondition(c.visibleIf, ctx));
  columns = columns.map((c) => {
    let col = c;
    if (c.carryForward) {
      const carried = carriedOptions(c.carryForward, ctx);
      col = { ...c, options: c.carryForward.keepOwn ? [...carried, ...c.options] : carried };
    }
    if (col.options.some((o) => o.visibleIf)) {
      col = { ...col, options: col.options.filter((o) => evaluateCondition(o.visibleIf, ctx)) };
    }
    if (col.label.includes("{{")) col = { ...col, label: resolvePiping(col.label, ctx) };
    return col;
  });
  if (q.randomization?.enabled && q.randomization.scope === "columns") {
    const seed = subSeed(ctx.state.seed, `randcols:${q.id}`);
    columns = seededShuffle(columns, seed);
  }

  return { options, rows, columns };
}
