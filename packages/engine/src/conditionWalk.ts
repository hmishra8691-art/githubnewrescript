import type { Condition, ConditionRule, SurveyDefinition } from "@rescript/schema";

/**
 * EVERY CONDITION IN A SURVEY, AND EVERY RULE INSIDE ONE — ONE WALKER.
 *
 * A survey keeps `Condition` trees in some forty places: display and skip
 * logic, validation gates and checks, option / row / column / group
 * visibility and option logic, masks, punches, list logic and operations,
 * carry-forward filters, probes, randomization rules, adaptive wording, flow
 * node visibility, branches, loops (eligible / invalid / skip / break /
 * aggregates), redirects, display rules, calculations, quota cells, named
 * expressions, list fills, localisation routing, quality rules, AI
 * conversation rules… and a rule can hold ANOTHER condition inside it, in
 * `source.count.where`.
 *
 * Every function that had to visit "all the logic" kept its own list of
 * those fields, and every one of those lists was short: renumbering missed
 * punch, mask, validation-check, flow-node and loop conditions; the option
 * code canonicaliser, the linter, the named-expression usage scan and the
 * cycle check never looked inside a COUNT's `where`. A rule written in a
 * place the list forgot was simply not updated — and pointed at the wrong
 * option after a renumber.
 *
 * So the walk is structural, not a list: anything shaped like a condition
 * node (`type: "rule"` with a source and an operator, or `type: "group"` with
 * an and/or/not op and children) IS a condition, wherever it sits. A new
 * condition-bearing field is covered on the day it is added.
 *
 * Skipped: `branding` and `meta` — presentation and bookkeeping, which hold
 * no survey logic. (`ux` is walked: a UX behaviour's `when` is a condition.)
 */

export const isConditionRule = (x: unknown): x is ConditionRule =>
  !!x && typeof x === "object" && (x as { type?: unknown }).type === "rule"
  && "operator" in (x as object) && "source" in (x as object);

export const isConditionGroup = (x: unknown): x is Extract<Condition, { type: "group" }> =>
  !!x && typeof x === "object" && (x as { type?: unknown }).type === "group"
  && Array.isArray((x as { children?: unknown }).children)
  && ["and", "or", "not"].includes(String((x as { op?: unknown }).op));

export const isConditionNode = (x: unknown): x is Condition => isConditionRule(x) || isConditionGroup(x);

const SKIP_KEYS = new Set(["branding", "meta"]);

/* ------------------------------------------------------------ inside a condition */

export interface RuleVisit {
  /** how deep in groups the rule sits (0 = the root itself is the rule) */
  depth: number;
  /** true for a rule inside a COUNT's `where` — it reads the counted item as `@option` */
  inCountWhere: boolean;
  /** the rule whose count holds this one, when inCountWhere */
  countOwner?: ConditionRule;
}

/**
 * Visit every rule in a tree: through groups of any depth AND into every
 * `source.count.where`, which is a whole condition of its own.
 */
export function forEachRule(
  c: Condition | undefined | null,
  visit: (rule: ConditionRule, at: RuleVisit) => void,
  at: RuleVisit = { depth: 0, inCountWhere: false },
): void {
  if (!c) return;
  if (isConditionGroup(c)) {
    for (const ch of c.children) forEachRule(ch, visit, { ...at, depth: at.depth + 1 });
    return;
  }
  if (!isConditionRule(c)) return;
  visit(c, at);
  const where = c.source?.count?.where;
  if (where) forEachRule(where, visit, { depth: at.depth + 1, inCountWhere: true, countOwner: c });
}

/**
 * Rebuild a tree with every rule passed through `fn` — groups of any depth
 * and every COUNT `where` included. Copy-on-write: an untouched subtree is
 * returned as the same object, so callers can tell whether anything changed.
 */
export function mapRules(
  c: Condition,
  fn: (rule: ConditionRule, at: RuleVisit) => ConditionRule,
  at: RuleVisit = { depth: 0, inCountWhere: false },
): Condition {
  if (isConditionGroup(c)) {
    let changed = false;
    const children = c.children.map((ch) => {
      const n = mapRules(ch, fn, { ...at, depth: at.depth + 1 });
      if (n !== ch) changed = true;
      return n;
    });
    return changed ? { ...c, children } : c;
  }
  if (!isConditionRule(c)) return c;
  let rule = fn(c, at);
  const where = rule.source?.count?.where;
  if (where) {
    const nextWhere = mapRules(where, fn, { depth: at.depth + 1, inCountWhere: true, countOwner: rule });
    if (nextWhere !== where) rule = { ...rule, source: { ...rule.source, count: { ...rule.source.count!, where: nextWhere } } };
  }
  return rule;
}

/** How deeply groups nest (a rule is 0; a group of rules is 1; count wheres count too). */
export function conditionDepth(c: Condition | undefined | null): number {
  if (!c) return 0;
  if (isConditionGroup(c)) return 1 + Math.max(0, ...c.children.map(conditionDepth));
  if (isConditionRule(c) && c.source?.count?.where) return 1 + conditionDepth(c.source.count.where);
  return 0;
}

/**
 * An empty group is no constraint (see `isVacuousCondition`). Everything that
 * reasons ABOUT a condition — the diagnoser, the printer, the trace — must
 * read it the way the evaluator does, so they all start from the tree with
 * the vacuous parts taken out. `null` means "no constraint at all".
 */
export function stripVacuous(c: Condition | undefined | null): Condition | null {
  if (!c) return null;
  if (!isConditionGroup(c)) return c;
  const kids = c.children.map(stripVacuous).filter((k): k is Condition => k !== null);
  if (!kids.length) return null;
  return kids.length === c.children.length && kids.every((k, i) => k === c.children[i]) ? c : { ...c, children: kids };
}

/**
 * A condition that is a CONSTANT — always true or always false — written as a
 * real rule (`(1) = 1` / `(0) = 1`: a calc expression compared with 1).
 *
 * An empty group is not a constant: it is VACUOUS ("not configured yet") and
 * the evaluator skips it, so `NOT(empty)` is vacuous too, not false. Anything
 * that has to mean "never" (an importer's `False`, a Qualtrics block that is
 * not in the Survey Flow) or a deliberate "always" on a rule that is skipped
 * when unconfigured (a skip, a terminate) uses this instead.
 */
export function constantCondition(value: boolean): Condition {
  return { type: "rule", source: { kind: "expr", ref: value ? "1" : "0" }, operator: "eq", value: 1 } as unknown as Condition;
}

/** `true` / `false` for a condition made by `constantCondition`, else `null`. */
export function constantValueOf(c: Condition | undefined | null): boolean | null {
  if (!c || !isConditionRule(c)) return null;
  const r = c as unknown as { source?: { kind?: string; ref?: unknown }; operator?: string; value?: unknown };
  if (r.source?.kind !== "expr" || r.operator !== "eq" || r.value !== 1) return null;
  const ref = String(r.source.ref ?? "").trim();
  return ref === "1" ? true : ref === "0" ? false : null;
}

/* ------------------------------------------------------------ across a survey */

export interface ConditionLocation {
  /** dotted path from the definition root, e.g. "questions[3].skipLogic[0].when" */
  path: string;
  /** the question it belongs to, when it belongs to one */
  questionId?: string;
  /** words for a person: "Q5 skip logic", "flow · Block 2 visibility", "quota “Age” cell" */
  where: string;
}

const FIELD_WORDS: Record<string, string> = {
  displayLogic: "display logic", skipLogic: "skip logic", validation: "validation", punches: "auto punch",
  mask: "mask", rowMask: "row mask", columnMask: "column mask", listLogic: "list logic",
  optionPipeline: "list operation", carryForward: "carry-forward filter", randomization: "randomization rule",
  probe: "follow-up probe", optionGroups: "option group", adaptive: "adaptive wording",
  quotas: "quota", displayRules: "display rule", calculations: "calculation", namedExpressions: "named expression",
  listFills: "list fill", localization: "language routing", quality: "quality rule", aiConversation: "AI conversation rule",
  branches: "branch", eligibleIf: "loop eligibility", invalidIf: "loop invalid rule", skipIf: "loop skip rule",
  breakIf: "loop break rule", visibleIf: "visibility", aggregates: "loop aggregate", fields: "embedded field",
  scripts: "custom script", customScripts: "custom script", behaviors: "UX behaviour",
};

interface WalkCtx { question?: { id: string; code: string }; owner?: string; field?: string }

/** "Q5 skip logic", "quota “Age” cell", "page “Intro” visibility" — owner, then field, never the same words twice */
function whereText(ctx: WalkCtx, key: string): string {
  const field = FIELD_WORDS[key] ?? ctx.field ?? key;
  if (!ctx.owner) return field;
  return ctx.owner.includes(field) ? ctx.owner : `${ctx.owner} ${field}`;
}

function ownerOf(node: Record<string, unknown>, ctx: WalkCtx, key: string, index?: number): WalkCtx {
  // a question
  if (typeof node.code === "string" && typeof node.variableName === "string" && typeof node.id === "string") {
    return { question: { id: node.id, code: node.code }, owner: node.code };
  }
  // an option / row (inside a question)
  if (ctx.question && (key === "options" || key === "rows") && node.code != null) {
    return { ...ctx, owner: `${ctx.question.code} ${key === "options" ? "option" : "row"} ${String(node.code)}` };
  }
  if (ctx.question && key === "columns" && typeof node.id === "string") {
    return { ...ctx, owner: `${ctx.question.code} column ${node.id}` };
  }
  // a flow node, a quota, a named thing
  if (!ctx.question && typeof node.type === "string" && typeof node.id === "string" && ["page", "block", "section", "branch", "loop", "randomizer", "redirect", "quota_check", "embedded_data", "end"].includes(node.type)) {
    const title = typeof node.title === "string" && node.title.trim() ? node.title.trim() : node.id;
    return { ...ctx, owner: `${node.type === "page" ? "page" : node.type} “${title}”` };
  }
  if (typeof node.name === "string" && node.name.trim() && !ctx.question) {
    return { ...ctx, owner: `${FIELD_WORDS[key] ?? key} “${node.name.trim()}”` };
  }
  if (index != null && !ctx.question && FIELD_WORDS[key]) return { ...ctx, owner: `${FIELD_WORDS[key]} ${index + 1}` };
  return ctx;
}

/**
 * Visit every ROOT condition in a definition (a tree, not the rules inside it
 * — combine with `forEachRule` for those). Roots are found structurally, so
 * nothing is missed; a condition inside another condition (a group's child,
 * a COUNT's `where`) is part of its root, not a root of its own.
 */
export function forEachConditionRoot(
  def: SurveyDefinition,
  visit: (c: Condition, loc: ConditionLocation) => void,
): void {
  const walk = (node: unknown, path: string, ctx: WalkCtx, key: string): void => {
    if (!node || typeof node !== "object") return;
    if (isConditionNode(node)) {
      visit(node, { path, questionId: ctx.question?.id, where: whereText(ctx, key) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((x, i) => {
        const next = x && typeof x === "object" && !Array.isArray(x) ? ownerOf(x as Record<string, unknown>, ctx, key, i) : ctx;
        walk(x, `${path}[${i}]`, { ...next, field: FIELD_WORDS[key] ?? ctx.field }, key);
      });
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!path && SKIP_KEYS.has(k)) continue;
      if (!v || typeof v !== "object") continue;
      const next = !Array.isArray(v) ? ownerOf(v as Record<string, unknown>, ctx, k) : ctx;
      walk(v, path ? `${path}.${k}` : k, { ...next, field: FIELD_WORDS[k] ?? ctx.field }, k);
    }
  };
  walk(def, "", {}, "");
}

/**
 * Rebuild a definition with every root condition passed through `fn`.
 * Copy-on-write along the changed paths only; the input is never mutated, and
 * when nothing changes the very same object comes back.
 */
export function mapConditionRoots(
  def: SurveyDefinition,
  fn: (c: Condition, loc: ConditionLocation) => Condition,
): SurveyDefinition {
  const walk = (node: unknown, path: string, ctx: WalkCtx, key: string): unknown => {
    if (!node || typeof node !== "object") return node;
    if (isConditionNode(node)) {
      return fn(node, { path, questionId: ctx.question?.id, where: whereText(ctx, key) });
    }
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((x, i) => {
        const next = x && typeof x === "object" && !Array.isArray(x) ? ownerOf(x as Record<string, unknown>, ctx, key, i) : ctx;
        const n = walk(x, `${path}[${i}]`, { ...next, field: FIELD_WORDS[key] ?? ctx.field }, key);
        if (n !== x) changed = true;
        return n;
      });
      return changed ? out : node;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((!path && SKIP_KEYS.has(k)) || !v || typeof v !== "object") { out[k] = v; continue; }
      const next = !Array.isArray(v) ? ownerOf(v as Record<string, unknown>, ctx, k) : ctx;
      const n = walk(v, path ? `${path}.${k}` : k, { ...next, field: FIELD_WORDS[k] ?? ctx.field }, k);
      if (n !== v) changed = true;
      out[k] = n;
    }
    return changed ? out : node;
  };
  return walk(def, "", {}, "") as SurveyDefinition;
}

/** Every rule in a definition, wherever its tree sits, count wheres included. */
export function forEachRuleInSurvey(
  def: SurveyDefinition,
  visit: (rule: ConditionRule, loc: ConditionLocation, at: RuleVisit) => void,
): void {
  forEachConditionRoot(def, (c, loc) => forEachRule(c, (r, at) => visit(r, loc, at)));
}
