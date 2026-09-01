import type {
  Question,
  Option,
  QuestionRow,
  CarryForward,
  ListLogicRule,
  Randomization,
} from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { getQuestion } from "./state.js";
import { resolvePiping } from "./piping.js";
import { seededShuffle, subSeed, mulberry32 } from "./random.js";

/**
 * The option/row/column presentation pipeline (reqs §4, §7–8, §11–13):
 *
 *   static or carried-forward items
 *     → option-level visibleIf
 *     → list logic (include / exclude / prioritize / deprioritize / remaining)
 *     → sorting (presentation only; programmed order is never modified)
 *     → randomization (conditional sets, N-of-M, anchors, groups)
 *     → piping in labels
 *
 * Everything is computed from the definition + response state, so the editor,
 * runtime, validation and exports all see the same effective question.
 */

export interface EffectiveQuestionView {
  options: Option[];
  rows: QuestionRow[];
  columns: Question["columns"];
}

/* ------------------------------------------------------------ source codes */

type Which = "selected" | "not_selected" | "displayed" | "answered_rows" | "all";

function codesFrom(
  sourceQuestionId: string,
  which: Which,
  ctx: EvalContext,
): (string | number)[] {
  const src = getQuestion(ctx.def, sourceQuestionId);
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

  switch (which) {
    case "selected":
      return selected as (string | number)[];
    case "not_selected": {
      const displayed = effectiveQuestion(src, ctx).options.map((o) => o.code);
      return displayed.filter((c) => !selected.some((s) => String(s) === String(c)));
    }
    case "displayed":
      return effectiveQuestion(src, ctx).options.map((o) => o.code);
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
  const codes = codesFrom(cf.sourceQuestionId, cf.filter, ctx);
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
  return pool.filter((o) =>
    evaluateCondition(cf.where, {
      ...ctx,
      loop: { loopVar: "option", code: String(o.code), label: o.label, index: 0 },
    }),
  );
}

/* -------------------------------------------------------------- list logic */

function applyListLogic<T extends { code: string | number }>(
  rules: ListLogicRule[],
  items: T[],
  ctx: EvalContext,
): T[] {
  let out = items;
  for (const rule of rules) {
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    const codes = codesFrom(rule.sourceQuestionId, rule.which, ctx).map(String);
    const matches = (i: T) => codes.includes(String(i.code));
    switch (rule.action) {
      case "include":
        out = out.filter(matches);
        break;
      case "exclude":
        out = out.filter((i) => !matches(i));
        break;
      case "prioritize":
        out = [...out.filter(matches), ...out.filter((i) => !matches(i))];
        break;
      case "deprioritize":
        out = [...out.filter((i) => !matches(i)), ...out.filter(matches)];
        break;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- sorting */

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

function sortItems<T extends { code: string | number; label: string }>(
  order: NonNullable<Question["settings"]["optionOrder"]> | undefined,
  items: T[],
): T[] {
  if (!order || order === "original") return items;
  const byLabel = (a: T, b: T) =>
    stripHtml(a.label).localeCompare(stripHtml(b.label), undefined, { sensitivity: "base" });
  const num = (x: T) => {
    const n = Number(x.code);
    return Number.isFinite(n) ? n : Number(stripHtml(x.label));
  };
  const sorted = [...items];
  switch (order) {
    case "az": sorted.sort(byLabel); break;
    case "za": sorted.sort((a, b) => byLabel(b, a)); break;
    case "numeric_asc": sorted.sort((a, b) => (num(a) || 0) - (num(b) || 0)); break;
    case "numeric_desc": sorted.sort((a, b) => (num(b) || 0) - (num(a) || 0)); break;
  }
  return sorted;
}

/* ----------------------------------------------------------- randomization */

interface ActiveRandomization {
  method: "shuffle" | "rotate" | "reverse_half" | "none";
  pick?: number;
  groups?: (string | number)[][];
}

/** Resolve the randomization config for this respondent: the first
 *  conditional rule that matches overrides the base settings (req §7–8). */
export function activeRandomization(
  r: Randomization | undefined,
  ctx: EvalContext,
): ActiveRandomization | null {
  if (!r?.enabled) return null;
  let cfg: ActiveRandomization = { method: r.method, pick: r.pick, groups: r.groups };
  for (const rule of r.rules ?? []) {
    if (evaluateCondition(rule.when, ctx)) {
      cfg = {
        method: rule.method ?? cfg.method,
        pick: rule.pick ?? cfg.pick,
        groups: rule.groups ?? cfg.groups,
      };
      break;
    }
  }
  return cfg;
}

const isAnchoredTop = (f?: string[]) => !!f?.includes("anchor_top");
const isAnchoredBottom = (f?: string[]) =>
  !!f?.some((x) => ["anchor_bottom", "none_of_above", "dont_know", "refused"].includes(x));

function randomizeItems<T extends { code: string | number; flags?: string[] }>(
  items: T[],
  cfg: ActiveRandomization,
  seed: number,
): T[] {
  const top = items.filter((i) => isAnchoredTop(i.flags));
  const bottom = items.filter((i) => !isAnchoredTop(i.flags) && isAnchoredBottom(i.flags));
  let middle = items.filter((i) => !top.includes(i) && !bottom.includes(i));
  const originalIndex = new Map(middle.map((i, idx) => [i, idx]));

  if (cfg.groups?.length) {
    const shuffled: T[] = [];
    const used = new Set<T>();
    cfg.groups.forEach((group, gi) => {
      const members = middle.filter((i) => group.some((c) => String(c) === String(i.code)));
      members.forEach((m) => used.add(m));
      shuffled.push(...seededShuffle(members, subSeed(seed, `g${gi}`)));
    });
    shuffled.push(...middle.filter((i) => !used.has(i)));
    middle = shuffled;
  } else if (cfg.method === "shuffle") {
    middle = seededShuffle(middle, seed);
  } else if (cfg.method === "rotate") {
    const k = middle.length ? subSeed(seed, "rot") % middle.length : 0;
    middle = [...middle.slice(k), ...middle.slice(0, k)];
  } else if (cfg.method === "reverse_half") {
    if (mulberry32(subSeed(seed, "rh"))() < 0.5) middle = [...middle].reverse();
  }
  // method "none": keep order (pick below may still subset)

  if (cfg.pick != null && cfg.pick >= 0 && cfg.pick < middle.length) {
    // choose a seeded subset; when not shuffling, keep original relative order
    const chosen = seededShuffle(middle, subSeed(seed, "pick")).slice(0, cfg.pick);
    middle =
      cfg.method === "none"
        ? [...chosen].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))
        : middle.filter((i) => chosen.includes(i));
  }

  return [...top, ...middle, ...bottom];
}

/* --------------------------------------------------------------- pipeline */

export function effectiveQuestion(q: Question, ctx: EvalContext): EffectiveQuestionView {
  const seedKey = ctx.loop ? `@${ctx.loop.code}` : "";

  // --- options
  let options: Option[] = [];
  if (q.carryForward && q.carryForward.into === "options") {
    options = carriedOptions(q.carryForward, ctx);
    if (q.carryForward.keepOwn) options = [...options, ...q.options];
  } else {
    options = [...q.options];
  }
  options = options.filter((o) => evaluateCondition(o.visibleIf, ctx));
  options = applyListLogic(q.listLogic ?? [], options, ctx);
  options = sortItems(q.settings.optionOrder, options);
  if (q.randomization?.enabled && q.randomization.scope === "options") {
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg) options = randomizeItems(options, cfg, subSeed(ctx.state.seed, `rand:${q.id}${seedKey}`));
  }
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
      validation: [],
      required: false,
    }));
    if (q.carryForward.keepOwn) rows = [...rows, ...q.rows];
  } else {
    rows = [...q.rows];
  }
  rows = rows.filter((r) => evaluateCondition(r.visibleIf, ctx));
  if (q.randomization?.enabled && q.randomization.scope === "rows") {
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg) rows = randomizeItems(rows, cfg, subSeed(ctx.state.seed, `randrows:${q.id}${seedKey}`));
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
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg) {
      columns = randomizeItems(
        columns.map((c) => ({ ...c, code: c.id })) as any,
        cfg,
        subSeed(ctx.state.seed, `randcols:${q.id}${seedKey}`),
      ) as any;
    }
  }

  return { options, rows, columns };
}
