import type { AnalysisPlan, Condition, FlowNode, Option, OptionMask, PunchRule, Question, SkipRule, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import type { ActionResult } from "./surveyActions.js";
import { buildDependencyIndex, type DependencyIndex } from "./dependencyIndex.js";
import { impactOf, impactReport, type ImpactItem, type ImpactReport, type ImpactChange, type ImpactScope } from "./impact.js";
import { formatCondition } from "./logicExpression.js";
import { setExpressionSummary } from "./setExpression.js";
import { formatPunchExpression } from "./autoPunch.js";
import { listBlocks, listPages } from "./blocks.js";
import { questionOrder } from "./dependencies.js";
import { quotaDiff } from "./quotaActions.js";
import { diffTheme } from "./theme.js";
import { diffUx } from "./ux.js";
import { languageName, movedTranslationKeys, translationImpact } from "./localization.js";
import { stripHtmlText } from "./html.js";

/**
 * THE CHANGE TREE — one record per change, in the words the review screen
 * renders: which question (number, type, text), which option if any, what
 * kind of change, the old value, the new value, the logic it touches, what
 * depends on it, and whether the engine called it destructive.
 *
 * `diffSurveys` answers "what changed?" in summary lines for a chat bubble.
 * The review the brief asks for is a different thing: a table a researcher
 * can scan question by question, open a row of, see the before and after of
 * exactly one field, and read beside it the dependents that notice. That is
 * a list of ITEMS, not of sentences — so this module compares the two
 * definitions object by object (by id, never by position or text) and emits
 * one item per field that differs, grouped afterwards by question, by block
 * and at survey level.
 *
 * Values are always FORMATTED: a condition through `formatCondition`, a mask
 * through `setExpressionSummary`, a punch through `formatPunchExpression`,
 * options as their labels. Raw JSON never reaches `from` / `to`; the trees
 * themselves go in `technical` for the "technical details" expander. The
 * dependents come from `impactOf`, scoped to the object the item is about: a
 * removed option's comparers, a retyped question's readers, a moved
 * question's order, and nothing for a piece of logic that merely changed —
 * its own text is the change.
 */

export type ChangeLevel = "survey" | "block" | "page" | "question" | "option" | "logic" | "flow" | "research" | "analysis" | "language" | "ux";

/** the closed list of categories a change item carries — one or two words, as the review's filter shows them */
export const CHANGE_CATEGORIES = [
  "Question", "Wording", "Question type", "Code", "Variable", "Required", "Options", "Option label", "Option code", "Option value", "Option flags", "Option visibility", "Option order",
  "Rows", "Columns", "Display logic", "Skip logic", "Validation", "Randomization", "Masking", "Punching", "Piping", "Placement", "Page break",
  "Block", "Randomizer", "Branch", "Loop", "Embedded data", "Calculation", "Quota", "Custom code", "Default value", "Analysis", "Research design", "Analysis plan",
  "Language", "Translation", "Survey", "Theme", "Style", "Animation", "Behaviour",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export interface ChangeItem {
  /** stable within a proposal: `${level}:${objectId}:${field}` */
  id: string;
  level: ChangeLevel;
  category: ChangeCategory;
  kind: "added" | "removed" | "modified" | "moved";
  question?: { id: string; code: string; type: string; text: string };
  option?: { code: string | number; label: string; index: number };
  block?: { id: string; title: string };
  /** researcher words: "label", "display logic", "position", … */
  field: string;
  from?: string;
  to?: string;
  /** one more sentence when useful ("moved from position 2 to 5") */
  detail?: string;
  /** what depends on this object / field — from impact.ts; empty when nothing */
  affected: ImpactItem[];
  /** the engine's destructive note when the change removes or rewrites content */
  destructive?: string;
  /** which ActionResult indexes touched this object; [] when unknown */
  actionIndexes: number[];
  status: "proposed";
  /** the before / after fragments for the "technical details" expander */
  technical?: Record<string, unknown>;
}

export interface ChangeTree {
  items: ChangeItem[];
  byQuestion: { question: NonNullable<ChangeItem["question"]>; items: ChangeItem[] }[];
  survey: ChangeItem[];
  blocks: ChangeItem[];
  counts: Record<ChangeLevel, number>;
  impact: ImpactReport;
}

export interface ChangeItemsOptions { results?: ActionResult[]; destructive?: string[]; index?: DependencyIndex }

/* ------------------------------------------------------------ words */

const plain = (s: string | undefined | null, n = 120): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const list = (xs: string[]) => xs.join(" | ");

/** the type as the picker names it ("Radio buttons"), else the base type in words */
function typeWords(q: Pick<Question, "type" | "variant">): string {
  const v = q.variant ? variantRegistry.get(q.variant) : undefined;
  return (v as { label?: string } | undefined)?.label ?? q.type.replace(/_/g, " ");
}
const qRef = (q: Question): NonNullable<ChangeItem["question"]> => ({ id: q.id, code: String(q.code), type: typeWords(q), text: plain(q.text, 120) });

function cond(def: SurveyDefinition, c: Condition | undefined | null): string {
  if (!c) return "";
  try { return formatCondition(def, c, { width: 400 }).replace(/\s+/g, " ").trim(); } catch { return "a condition"; }
}
function maskWords(def: SurveyDefinition, m: OptionMask | undefined): string {
  if (!m) return "";
  const verb = { display: "show only", preselect: "preselect", display_and_preselect: "show and preselect", disable: "disable", remove: "remove" }[m.action] ?? m.action;
  try { return `${verb} ${setExpressionSummary(def, m.expr)}${m.when ? ` when ${cond(def, m.when)}` : ""}`; } catch { return `${verb} a set`; }
}
function punchWords(def: SurveyDefinition, q: Question, p: PunchRule): string {
  try { return formatPunchExpression(def, q, p); } catch { return p.label ?? p.id; }
}
function validationWords(def: SurveyDefinition, v: ValidationRule): string {
  const kind = v.kind.replace(/_/g, " ");
  const value = v.value !== undefined && v.value !== null && typeof v.value !== "object" ? ` ${String(v.value)}` : "";
  return `${kind}${value}${v.check ? ` — invalid when ${cond(def, v.check)}` : ""}${v.when ? ` (only when ${cond(def, v.when)})` : ""}${v.message ? ` “${plain(v.message, 60)}”` : ""}`;
}
function randomizationWords(q: Question): string {
  const r = q.randomization;
  if (!r?.enabled) return "off";
  const scopes = r.scopes?.length ? r.scopes.join(" and ") : r.scope;
  const items = (r.scope === "rows" ? q.rows : r.scope === "columns" ? q.columns : q.options) as { label: string; flags?: string[] }[];
  const anchored = (items ?? []).filter((o) => o.flags?.includes("anchor_top") || o.flags?.includes("anchor_bottom")).map((o) => `“${plain(o.label, 30)}” ${o.flags?.includes("anchor_top") ? "first" : "last"}`);
  return `${scopes} ${r.method === "shuffle" ? "shuffled" : r.method.replace(/_/g, " ")}${r.pick ? `, ${r.pick} shown` : ""}${r.groups?.length ? `, in ${r.groups.length} groups` : ""}${anchored.length ? `, keeps ${anchored.join(", ")}` : ""}${r.rules?.length ? `, ${r.rules.length} conditional rule${r.rules.length === 1 ? "" : "s"}` : ""}`;
}
function skipWords(def: SurveyDefinition, r: SkipRule): string {
  const t = r.target;
  const where = t.kind === "question" ? (def.questions.find((q) => q.id === t.ref)?.code ?? t.ref ?? "?")
    : t.kind === "block" || t.kind === "page" || t.kind === "section" ? `${t.kind} “${(listBlocks(def.flow as unknown[]).find((b) => b.id === t.ref)?.title) ?? t.ref}”`
    : t.kind === "end" ? "the end" : t.kind === "url" ? `${t.ref}` : `out (${String(t.status ?? "terminated").replace(/_/g, " ")})`;
  return `when ${cond(def, r.when)} → ${where}`;
}
function flagWords(o: { flags?: string[] }): string {
  const f = o.flags ?? [];
  return [f.includes("exclusive") ? "exclusive" : "", f.includes("other_specify") ? "with a specify box" : "", f.includes("anchor_top") ? "anchored first" : f.includes("anchor_bottom") ? "anchored last" : "", ...f.filter((x) => !["exclusive", "other_specify", "anchor_top", "anchor_bottom"].includes(x))].filter(Boolean).join(", ") || "none";
}
function optionLogicWords(def: SurveyDefinition, o: Option): string {
  const l = o.logic;
  const parts = [o.visibleIf ? `shown when ${cond(def, o.visibleIf)}` : ""];
  if (l) {
    for (const [name, c] of [["shown when", l.when], ["eligible when", l.eligibleWhen], ["excluded when", l.excludeWhen], ["prioritised when", l.prioritizeWhen], ["deprioritised when", l.deprioritizeWhen], ["randomized when", l.randomizeWhen]] as const) if (c) parts.push(`${name} ${cond(def, c)}`);
    if (l.carryForward?.sourceQuestionId) parts.push(`carried from ${def.questions.find((q) => q.id === l.carryForward!.sourceQuestionId)?.code ?? l.carryForward.sourceQuestionId}`);
  }
  return parts.filter(Boolean).join("; ") || "always shown";
}
function analysisWords(q: Question): string {
  const a = q.analysis;
  if (!a) return "";
  return [a.role ? `role ${a.role}` : "", a.measurement ? `measured as ${a.measurement}` : "", a.construct ? `construct ${a.construct}` : "", a.primary?.length ? `reported as ${a.primary.join(", ").replace(/_/g, " ")}` : "", a.crosstabBy?.length ? `by ${a.crosstabBy.join(", ")}` : "", a.relatedTo?.length ? `related to ${a.relatedTo.join(", ")}` : "", a.modeling?.length ? a.modeling.join(", ").replace(/_/g, " ") : "", a.hypotheses?.length ? a.hypotheses.join(", ") : "", a.notes ? `“${plain(a.notes, 60)}”` : ""].filter(Boolean).join(" · ");
}
const defaultWords = (q: Question): string => { const v = (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue; return v === undefined || v === null ? "" : Array.isArray(v) ? v.map(String).join(", ") : typeof v === "object" ? "a value" : String(v); };

/** the ids kept in order in both sequences — what did NOT move; everything else did */
function stableIds(before: string[], after: string[]): Set<string> {
  const a = before.filter((x) => after.includes(x)), b = after.filter((x) => before.includes(x));
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keep = new Set<string>();
  for (let i = 0, j = 0; i < n && j < m;) { if (a[i] === b[j]) { keep.add(a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return keep;
}

/* ------------------------------------------------------------ the builder */

class Tree {
  readonly items: ChangeItem[] = [];
  private ixBefore?: DependencyIndex;
  private ixAfter?: DependencyIndex;
  constructor(private readonly before: SurveyDefinition, private readonly after: SurveyDefinition, private readonly opts: ChangeItemsOptions) { this.ixBefore = opts.index; }

  /** the dependents of a scope, computed on the side the object still exists on, direct only unless asked */
  affected(side: "before" | "after", scope: ImpactScope, change: ImpactChange, includeIndirect = false): ImpactItem[] {
    try {
      const def = side === "before" ? this.before : this.after;
      const index = side === "before" ? (this.ixBefore ??= buildDependencyIndex(this.before)) : (this.ixAfter ??= buildDependencyIndex(this.after));
      const items = impactOf(def, scope, { change, index }).items;
      return includeIndirect ? items : items.filter((i) => !i.indirect);
    } catch { return []; }
  }

  /** the action results that touched an object, and their destructive notes */
  actions(objectIds: string[]): { indexes: number[]; destructive?: string } {
    const hits = (this.opts.results ?? []).filter((r) => r.ok && r.touched.some((t) => objectIds.includes(t)));
    const notes = hits.map((r) => r.destructive).filter((x): x is string => !!x);
    return { indexes: hits.map((r) => r.index), ...(notes.length ? { destructive: [...new Set(notes)].join("; ") } : {}) };
  }

  /** a destructive note for an object the results do not name: the caller's notes that mention its code */
  noteFor(code: string | undefined, kind: ChangeItem["kind"]): string | undefined {
    if (!code || kind === "added" || this.opts.results?.length) return undefined;
    const re = new RegExp(`(^|[^A-Za-z0-9_])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
    const notes = (this.opts.destructive ?? []).filter((d) => re.test(d));
    return notes.length ? notes.join("; ") : undefined;
  }

  add(item: Omit<ChangeItem, "id" | "status" | "affected" | "actionIndexes"> & { objectId: string; affected?: ImpactItem[]; actionIndexes?: number[] }): ChangeItem {
    const { objectId, ...rest } = item;
    const acts = this.actions([objectId, ...(item.question ? [item.question.id] : []), ...(item.block ? [item.block.id] : [])]);
    // a destructive note only on a change that removes or rewrites: an added option is not what the engine warned about
    const destructive = item.kind === "added" ? undefined : item.destructive ?? acts.destructive ?? this.noteFor(item.question?.code ?? item.block?.title, item.kind);
    const out: ChangeItem = {
      id: `${item.level}:${objectId}:${slug(item.field)}`,
      ...rest,
      affected: item.affected ?? [],
      ...(destructive ? { destructive } : {}),
      actionIndexes: item.actionIndexes ?? acts.indexes,
      status: "proposed",
    };
    // the same object and field twice (a rule found by id and again by position) is one row
    if (this.items.some((x) => x.id === out.id)) out.id = `${out.id}:${this.items.filter((x) => x.id.startsWith(out.id)).length + 1}`;
    this.items.push(out);
    return out;
  }
}

/* ------------------------------------------------------------ questions */

function questionItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const bq = new Map(before.questions.map((q) => [q.id, q]));
  const aq = new Map(after.questions.map((q) => [q.id, q]));
  const blockOf = (def: SurveyDefinition, qid: string) => listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(qid)));
  const orderB = questionOrder(before), orderA = questionOrder(after);
  const stable = stableIds(orderB, orderA);

  for (const q of after.questions) {
    if (bq.has(q.id)) continue;
    const b = blockOf(after, q.id);
    const at = orderA.indexOf(q.id);
    t.add({ objectId: q.id, level: "question", category: "Question", kind: "added", question: qRef(q), field: "question", to: `${typeWords(q)}: ${plain(q.text, 120)}`, detail: `${b?.title ? `in “${b.title}”` : "on no page"}${at >= 0 ? `, position ${at + 1}` : ""}${q.options?.length ? `, ${q.options.length} options` : ""}${q.rows?.length ? `, ${q.rows.length} rows` : ""}`, technical: { after: q } });
  }
  for (const q of before.questions) {
    if (aq.has(q.id)) continue;
    t.add({ objectId: q.id, level: "question", category: "Question", kind: "removed", question: qRef(q), field: "question", from: `${typeWords(q)}: ${plain(q.text, 120)}`, affected: t.affected("before", { questions: [q.id] }, "delete", true), technical: { before: q } });
  }

  for (const q of after.questions) {
    const p = bq.get(q.id);
    if (!p) continue;
    const ref = qRef(q);
    const direct = () => t.affected("after", { questions: [q.id] }, "edit");
    const field = (category: ChangeCategory, name: string, from: string, to: string, extra: Partial<ChangeItem> & { level?: ChangeLevel; affected?: ImpactItem[] } = {}) => {
      if (from === to) return;
      t.add({ objectId: q.id, level: extra.level ?? "question", category, kind: !from ? "added" : !to ? "removed" : "modified", question: ref, field: name, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.technical ? { technical: extra.technical } : {}), affected: extra.affected ?? [] });
    };

    field("Wording", "text", plain(p.text), plain(q.text), { technical: { before: p.text, after: q.text }, affected: direct().filter((i) => i.via === "translation" || i.via === "piping") });
    field("Wording", "instruction", plain(p.instruction), plain(q.instruction), { technical: { before: p.instruction, after: q.instruction } });
    field("Wording", "description", plain(p.description), plain(q.description), { technical: { before: p.description, after: q.description } });
    if (p.type !== q.type || p.variant !== q.variant) field("Question type", "type", typeWords(p), typeWords(q), { affected: t.affected("after", { questions: [q.id] }, "retype"), technical: { before: { type: p.type, variant: p.variant }, after: { type: q.type, variant: q.variant } } });
    field("Code", "code", String(p.code), String(q.code), { affected: t.affected("before", { variables: [String(p.code)] }, "edit") });
    field("Variable", "variable name", p.variableName, q.variableName, { affected: t.affected("before", { variables: [p.variableName] }, "edit") });
    field("Required", "required", p.required ? "required" : "optional", q.required ? "required" : "optional");
    field("Randomization", "randomization", randomizationWords(p), randomizationWords(q), { technical: { before: p.randomization, after: q.randomization } });
    field("Default value", "default value", defaultWords(p), defaultWords(q));
    field("Analysis", "analysis", analysisWords(p), analysisWords(q), { technical: { before: p.analysis, after: q.analysis } });
    field("Custom code", "custom HTML", plain(p.customHtml, 80), plain(q.customHtml, 80), { technical: { before: p.customHtml, after: q.customHtml } });
    field("Custom code", "custom JS", p.customJs ? `${p.customJs.length} characters` : "", q.customJs ? `${q.customJs.length} characters` : "", { technical: { before: p.customJs, after: q.customJs } });
    field("Custom code", "custom CSS", p.customCss ? `${p.customCss.length} characters` : "", q.customCss ? `${q.customCss.length} characters` : "", { technical: { before: p.customCss, after: q.customCss } });

    /* ---- logic: display */
    const dB = cond(before, p.displayLogic), dA = cond(after, q.displayLogic);
    if (dB !== dA) field("Display logic", "display logic", dB, dA, { level: "logic", technical: { before: p.displayLogic, after: q.displayLogic }, affected: dB && !dA ? direct() : [] });
    for (const [name, mB, mA] of [["mask", p.mask, q.mask], ["row mask", p.rowMask, q.rowMask], ["column mask", p.columnMask, q.columnMask]] as const) {
      const a = maskWords(before, mB), b = maskWords(after, mA);
      if (a !== b) field("Masking", name, a, b, { level: "logic", technical: { before: mB, after: mA }, affected: a && !b ? direct() : [] });
    }
    /* ---- logic: skips, one item per rule */
    const sB = new Map((p.skipLogic ?? []).map((r) => [r.id, r])), sA = new Map((q.skipLogic ?? []).map((r) => [r.id, r]));
    (q.skipLogic ?? []).forEach((r, i) => {
      const prev = sB.get(r.id);
      const to = skipWords(after, r), from = prev ? skipWords(before, prev) : "";
      if (from !== to) field("Skip logic", `skip rule ${i + 1}`, from, to, { level: "logic", technical: { before: prev, after: r } });
    });
    (p.skipLogic ?? []).forEach((r, i) => { if (!sA.has(r.id)) field("Skip logic", `skip rule ${i + 1}`, skipWords(before, r), "", { level: "logic", technical: { before: r }, affected: direct() }); });
    /* ---- logic: validation, per rule kind */
    const vB = new Map<string, ValidationRule[]>(), vA = new Map<string, ValidationRule[]>();
    for (const v of p.validation ?? []) vB.set(v.kind, [...(vB.get(v.kind) ?? []), v]);
    for (const v of q.validation ?? []) vA.set(v.kind, [...(vA.get(v.kind) ?? []), v]);
    for (const kind of new Set([...vB.keys(), ...vA.keys()])) {
      const from = (vB.get(kind) ?? []).map((v) => validationWords(before, v)).join("; "), to = (vA.get(kind) ?? []).map((v) => validationWords(after, v)).join("; ");
      if (from !== to) field("Validation", `validation ${kind.replace(/_/g, " ")}`, from, to, { level: "logic", technical: { before: vB.get(kind), after: vA.get(kind) } });
    }
    /* ---- logic: punches, one item per rule */
    const pB = new Map((p.punches ?? []).map((r) => [r.id, r])), pA = new Map((q.punches ?? []).map((r) => [r.id, r]));
    (q.punches ?? []).forEach((r, i) => {
      const prev = pB.get(r.id);
      const to = punchWords(after, q, r as PunchRule), from = prev ? punchWords(before, p, prev as PunchRule) : "";
      if (from !== to) field("Punching", r.label ? `punch rule “${r.label}”` : `punch rule ${i + 1}`, from, to, { level: "logic", technical: { before: prev, after: r } });
    });
    (p.punches ?? []).forEach((r, i) => { if (!pA.has(r.id)) field("Punching", r.label ? `punch rule “${r.label}”` : `punch rule ${i + 1}`, punchWords(before, p, r as PunchRule), "", { level: "logic", technical: { before: r } }); });

    /* ---- placement */
    const bB = blockOf(before, q.id), bA = blockOf(after, q.id);
    const posB = orderB.indexOf(q.id), posA = orderA.indexOf(q.id);
    if ((bB?.id !== bA?.id) || !stable.has(q.id)) {
      const where = (b: ReturnType<typeof blockOf>, pos: number) => `${b?.title ? `“${b.title}”` : b ? "block" : "no page"}${pos >= 0 ? ` #${pos + 1}` : ""}`;
      t.add({ objectId: q.id, level: "question", category: "Placement", kind: "moved", question: ref, field: "position", from: where(bB, posB), to: where(bA, posA), detail: `moved from position ${posB + 1} to ${posA + 1}${bB?.id !== bA?.id ? ` (${bB?.title ? `“${bB.title}”` : "no block"} → ${bA?.title ? `“${bA.title}”` : "no block"})` : ""}`, affected: t.affected("after", { questions: [q.id] }, "move") });
    }

    optionItems(t, before, after, p, q, ref);
    axisItems(t, p, q, ref, "Rows", (x) => (x.rows ?? []).map((r) => ({ code: r.code, label: r.label, flags: r.flags })));
    axisItems(t, p, q, ref, "Columns", (x) => (x.columns ?? []).map((c) => ({ code: c.id, label: c.label })));
  }
}

/* ------------------------------------------------------------ options */

type Item = { id?: string; code: string | number; label: string; flags?: string[] };

/** pairs of before/after options: by id when both have one, else by code; then a lone leftover pair with the same label is a recode */
function pairItems<T extends Item>(xs: T[], ys: T[]): { pairs: [T, T][]; removed: T[]; added: T[]; recoded: [T, T][] } {
  const pairs: [T, T][] = [];
  const usedY = new Set<T>();
  for (const x of xs) {
    const y = (x.id ? ys.find((o) => o.id === x.id && !usedY.has(o)) : undefined) ?? ys.find((o) => String(o.code) === String(x.code) && !usedY.has(o) && (!o.id || !x.id || o.id === x.id));
    if (y) { pairs.push([x, y]); usedY.add(y); }
  }
  const removed = xs.filter((x) => !pairs.some(([a]) => a === x)), added = ys.filter((y) => !usedY.has(y));
  const recoded: [T, T][] = [];
  const norm = (s: string) => plain(s).toLowerCase();
  for (const x of [...removed]) {
    const same = added.filter((y) => norm(y.label) === norm(x.label) && !recoded.some(([, b]) => b === y));
    if (same.length === 1 && removed.filter((r) => norm(r.label) === norm(x.label)).length === 1) { recoded.push([x, same[0]]); removed.splice(removed.indexOf(x), 1); added.splice(added.indexOf(same[0]), 1); }
  }
  return { pairs, removed, added, recoded };
}

function optionItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition, p: Question, q: Question, ref: NonNullable<ChangeItem["question"]>): void {
  const xs = (p.options ?? []) as Option[], ys = (q.options ?? []) as Option[];
  if (!xs.length && !ys.length) return;
  const { pairs, removed, added, recoded } = pairItems(xs, ys);
  const opt = (o: Option, side: Option[]): NonNullable<ChangeItem["option"]> => ({ code: o.code, label: plain(o.label, 80), index: side.indexOf(o) + 1 });
  const scope = (codes: (string | number)[]): ImpactScope => ({ options: [{ questionId: q.id, codes }] });

  for (const o of removed) t.add({ objectId: q.id, level: "option", category: "Options", kind: "removed", question: ref, option: opt(o, xs), field: `option ${o.code}`, from: plain(o.label, 80), affected: t.affected("before", scope([o.code]), "delete"), technical: { before: o } });
  for (const o of added) t.add({ objectId: q.id, level: "option", category: "Options", kind: "added", question: ref, option: opt(o, ys), field: `option ${o.code}`, to: plain(o.label, 80), detail: `at position ${ys.indexOf(o) + 1}${flagWords(o) !== "none" ? `, ${flagWords(o)}` : ""}`, technical: { after: o } });
  for (const [x, y] of [...pairs, ...recoded]) {
    const oRef = opt(y, ys);
    const field = (category: ChangeCategory, name: string, from: string, to: string, affected: ImpactItem[] = [], technical?: Record<string, unknown>, detail?: string) => {
      if (from === to) return;
      t.add({ objectId: q.id, level: "option", category, kind: !from ? "added" : !to ? "removed" : "modified", question: ref, option: oRef, field: name, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(detail ? { detail } : {}), affected, ...(technical ? { technical } : {}) });
    };
    if (String(x.code) !== String(y.code)) field("Option code", `option ${x.code} code`, String(x.code), String(y.code), t.affected("before", scope([x.code]), "recode"));
    field("Option label", `option ${y.code} label`, plain(x.label, 80), plain(y.label, 80), t.affected("before", scope([x.code]), "edit").filter((i) => i.via === "translation"), { before: x.label, after: y.label });
    field("Option value", `option ${y.code} export value`, x.value === undefined ? "" : String(x.value), y.value === undefined ? "" : String(y.value));
    field("Option flags", `option ${y.code} flags`, flagWords(x), flagWords(y));
    const lB = optionLogicWords(before, x), lA = optionLogicWords(after, y);
    if (lB !== lA) field("Option visibility", `option ${y.code} visibility`, lB, lA, lB !== "always shown" && lA === "always shown" ? t.affected("before", scope([x.code]), "edit") : [], { before: { visibleIf: x.visibleIf, logic: x.logic }, after: { visibleIf: y.visibleIf, logic: y.logic } });
  }
  // order: what moved among the options both sides have
  const keyOf = (o: Option) => o.id ?? `code:${o.code}`;
  const keyB = new Map(xs.map((o) => [o, keyOf(o)])), keyA = new Map(ys.map((o) => [o, keyOf(o)]));
  for (const [x, y] of recoded) { keyB.set(x, `pair:${x.code}`); keyA.set(y, `pair:${x.code}`); }
  for (const [x, y] of pairs) { const k = keyB.get(x)!; keyA.set(y, k); }
  const stable = stableIds(xs.map((o) => keyB.get(o)!), ys.map((o) => keyA.get(o)!));
  for (const [x, y] of pairs) {
    if (stable.has(keyB.get(x)!)) continue;
    const from = xs.indexOf(x) + 1, to = ys.indexOf(y) + 1;
    if (from === to) continue;
    t.add({ objectId: q.id, level: "option", category: "Option order", kind: "moved", question: ref, option: opt(y, ys), field: `option ${y.code} position`, from: `#${from}`, to: `#${to}`, detail: `moved from position ${from} to ${to}` });
  }
}

function axisItems(t: Tree, p: Question, q: Question, ref: NonNullable<ChangeItem["question"]>, category: "Rows" | "Columns", pick: (x: Question) => Item[]): void {
  const xs = pick(p), ys = pick(q);
  if (!xs.length && !ys.length) return;
  const word = category === "Rows" ? "row" : "column";
  const { pairs, removed, added } = pairItems(xs, ys);
  for (const o of removed) t.add({ objectId: q.id, level: "option", category, kind: "removed", question: ref, option: { code: o.code, label: plain(o.label, 80), index: xs.indexOf(o) + 1 }, field: `${word} ${o.code}`, from: plain(o.label, 80) });
  for (const o of added) t.add({ objectId: q.id, level: "option", category, kind: "added", question: ref, option: { code: o.code, label: plain(o.label, 80), index: ys.indexOf(o) + 1 }, field: `${word} ${o.code}`, to: plain(o.label, 80) });
  for (const [x, y] of pairs) {
    if (plain(x.label, 80) === plain(y.label, 80)) continue;
    t.add({ objectId: q.id, level: "option", category, kind: "modified", question: ref, option: { code: y.code, label: plain(y.label, 80), index: ys.indexOf(y) + 1 }, field: `${word} ${y.code} label`, from: plain(x.label, 80), to: plain(y.label, 80), technical: { before: x.label, after: y.label } });
  }
}

/* ------------------------------------------------------------ blocks, pages, flow */

function blockItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const blocksB = listBlocks(before.flow as unknown[]), blocksA = listBlocks(after.flow as unknown[]);
  const bIds = new Map(blocksB.map((b) => [b.id, b])), aIds = new Map(blocksA.map((b) => [b.id, b]));
  // a lone page that gained a page break became a `block` container with a new id: that is the same block, not an addition
  for (const b of blocksA) {
    if (bIds.has(b.id) || (b.pages.length === 1 && bIds.has(b.pages[0].node.id))) continue;
    const n = b.pages.reduce((k, p) => k + p.node.questionIds.length, 0);
    t.add({ objectId: b.id, level: "block", category: "Block", kind: "added", block: { id: b.id, title: b.title ?? b.id }, field: "block", to: b.title ?? b.id, detail: `${n} question${n === 1 ? "" : "s"}, ${b.pages.length} page${b.pages.length === 1 ? "" : "s"}` });
  }
  for (const b of blocksB) {
    if (aIds.has(b.id) || blocksA.some((x) => x.pages.some((p) => p.node.id === b.id))) continue;
    t.add({ objectId: b.id, level: "block", category: "Block", kind: "removed", block: { id: b.id, title: b.title ?? b.id }, field: "block", from: b.title ?? b.id, affected: t.affected("before", { blocks: [b.id] }, "delete", true) });
  }
  for (const b of blocksA) {
    const p = bIds.get(b.id);
    if (!p) continue;
    if ((p.title ?? "") !== (b.title ?? "")) t.add({ objectId: b.id, level: "block", category: "Block", kind: "modified", block: { id: b.id, title: b.title ?? b.id }, field: "title", from: p.title ?? "", to: b.title ?? "" });
    const vB = cond(before, (p.node as { visibleIf?: Condition }).visibleIf), vA = cond(after, (b.node as { visibleIf?: Condition }).visibleIf);
    if (vB !== vA) t.add({ objectId: b.id, level: "block", category: "Display logic", kind: !vB ? "added" : !vA ? "removed" : "modified", block: { id: b.id, title: b.title ?? b.id }, field: "shown when", ...(vB ? { from: vB } : {}), ...(vA ? { to: vA } : {}), technical: { before: (p.node as { visibleIf?: Condition }).visibleIf, after: (b.node as { visibleIf?: Condition }).visibleIf } });
  }
}

/** the questions a page break follows: the last question of every page but the survey's last */
function breaksAfter(def: SurveyDefinition): Set<string> {
  const pages = listPages(def.flow as unknown[]).filter((p) => p.node.questionIds.length);
  const out = new Set<string>();
  pages.forEach((p, i) => { if (i < pages.length - 1) out.add(p.node.questionIds[p.node.questionIds.length - 1]); });
  return out;
}

function pageItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const shared = new Set(before.questions.filter((q) => after.questions.some((x) => x.id === q.id)).map((q) => q.id));
  const bB = breaksAfter(before), bA = breaksAfter(after);
  const byId = (def: SurveyDefinition, id: string) => def.questions.find((q) => q.id === id);
  for (const id of bA) if (!bB.has(id) && shared.has(id)) { const q = byId(after, id)!; t.add({ objectId: id, level: "page", category: "Page break", kind: "added", question: qRef(q), field: "page break", to: `after ${q.code}`, detail: `${q.code} ends its page` }); }
  for (const id of bB) if (!bA.has(id) && shared.has(id)) { const q = byId(before, id)!; t.add({ objectId: id, level: "page", category: "Page break", kind: "removed", question: qRef(q), field: "page break", from: `after ${q.code}`, detail: `${q.code} no longer ends its page` }); }
}

function flowItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  type Node = FlowNode & { title?: string; children?: FlowNode[]; branches?: { when: Condition; children: FlowNode[]; label?: string }[]; otherwise?: FlowNode[]; show?: number; source?: { kind: string; questionId?: string; items?: unknown[] }; loopVar?: string };
  const collect = (def: SurveyDefinition): Map<string, Node> => {
    const out = new Map<string, Node>();
    const walk = (ns: FlowNode[]) => { for (const n of ns) { const k = n as Node; if (k.type === "randomizer" || k.type === "branch" || k.type === "loop") out.set(k.id, k); if (k.children) walk(k.children); if (k.branches) for (const b of k.branches) walk(b.children); if (k.otherwise) walk(k.otherwise); } };
    walk(def.flow as FlowNode[]);
    return out;
  };
  const words = (def: SurveyDefinition, n: Node): string => {
    const titles = (ns: FlowNode[] | undefined) => (ns ?? []).map((c) => `“${(c as Node).title ?? c.id}”`).join(", ");
    if (n.type === "randomizer") return `${titles(n.children)}${n.show ? ` — each respondent sees ${n.show}` : ""}`;
    if (n.type === "branch") return `${(n.branches ?? []).map((b) => `${titles(b.children)} when ${cond(def, b.when)}`).join("; else ")}${n.otherwise?.length ? `; otherwise ${titles(n.otherwise)}` : ""}`;
    const src = n.source;
    const over = src?.kind === "question" ? `the answers to ${def.questions.find((q) => q.id === src.questionId)?.code ?? src.questionId}` : src?.kind === "static" ? `${src.items?.length ?? 0} items` : `a ${src?.kind ?? "list"}`;
    return `over ${over}: ${titles(n.children)}`;
  };
  const category = (n: Node): ChangeCategory => (n.type === "randomizer" ? "Randomizer" : n.type === "branch" ? "Branch" : "Loop");
  const nB = collect(before), nA = collect(after);
  for (const [id, n] of nA) if (!nB.has(id)) t.add({ objectId: id, level: "flow", category: category(n), kind: "added", field: n.title ?? n.loopVar ?? n.type, to: words(after, n) });
  for (const [id, n] of nB) if (!nA.has(id)) t.add({ objectId: id, level: "flow", category: category(n), kind: "removed", field: n.title ?? n.loopVar ?? n.type, from: words(before, n) });
}

/* ------------------------------------------------------------ survey-level */

function embeddedItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  type Field = { name: string; source?: string; value?: string; dataType?: string };
  const fields = (def: SurveyDefinition): Field[] => { const out: Field[] = []; const walk = (ns: FlowNode[]) => { for (const n of ns) { if (n.type === "embedded_data") out.push(...(n.fields as Field[])); const k = n as { children?: FlowNode[] }; if (k.children) walk(k.children); } }; walk(def.flow as FlowNode[]); return out; };
  const words = (f: Field) => `${f.source ?? "url"}${f.value ? ` = ${plain(f.value, 60)}` : ""}${f.dataType && f.dataType !== "string" ? ` (${f.dataType})` : ""}`;
  const fB = new Map(fields(before).map((f) => [f.name, f])), fA = new Map(fields(after).map((f) => [f.name, f]));
  const removed = [...fB.values()].filter((f) => !fA.has(f.name)), added = [...fA.values()].filter((f) => !fB.has(f.name));
  // one gone and one new with the same settings is a rename
  if (removed.length === 1 && added.length === 1 && words(removed[0]) === words(added[0])) {
    t.add({ objectId: removed[0].name, level: "survey", category: "Embedded data", kind: "modified", field: "name", from: removed[0].name, to: added[0].name, detail: `renamed — conditions and pipes that read ${removed[0].name} follow it`, affected: t.affected("before", { embedded: [removed[0].name] }, "edit") });
    removed.length = 0; added.length = 0;
  }
  for (const f of added) t.add({ objectId: f.name, level: "survey", category: "Embedded data", kind: "added", field: f.name, to: words(f) });
  for (const f of removed) t.add({ objectId: f.name, level: "survey", category: "Embedded data", kind: "removed", field: f.name, from: words(f), affected: t.affected("before", { embedded: [f.name] }, "delete") });
  for (const [name, f] of fA) { const p = fB.get(name); if (p && words(p) !== words(f)) t.add({ objectId: name, level: "survey", category: "Embedded data", kind: "modified", field: name, from: words(p), to: words(f), affected: t.affected("before", { embedded: [name] }, "edit") }); }
}

function calculationItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const words = (def: SurveyDefinition, c: SurveyDefinition["calculations"][number]) => `${c.targetVariable} = ${c.expression}${c.when ? ` when ${cond(def, c.when)}` : ""}${c.dataType !== "numeric" ? ` (${c.dataType})` : ""}${c.trigger !== "on_page_submit" ? `, ${c.trigger.replace(/_/g, " ")}` : ""}`;
  const cB = new Map(before.calculations.map((c) => [c.id, c])), cA = new Map(after.calculations.map((c) => [c.id, c]));
  for (const c of after.calculations) {
    const p = cB.get(c.id);
    if (!p) { t.add({ objectId: c.id, level: "survey", category: "Calculation", kind: "added", field: c.targetVariable, to: words(after, c), ...(c.label ? { detail: c.label } : {}) }); continue; }
    if (words(before, p) !== words(after, c) || (p.label ?? "") !== (c.label ?? "")) t.add({ objectId: c.id, level: "survey", category: "Calculation", kind: "modified", field: c.targetVariable, from: words(before, p), to: words(after, c), affected: t.affected("before", { calculations: [c.id] }, "edit"), technical: { before: p, after: c } });
  }
  for (const c of before.calculations) if (!cA.has(c.id)) t.add({ objectId: c.id, level: "survey", category: "Calculation", kind: "removed", field: c.targetVariable, from: words(before, c), affected: t.affected("before", { calculations: [c.id] }, "delete", true) });
}

function quotaItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  for (const line of quotaDiff(before, after)) {
    const kind: ChangeItem["kind"] = /^Remove/.test(line) ? "removed" : /^Change/.test(line) ? "modified" : "added";
    const name = /“([^”]+)”/.exec(line)?.[1];
    const quota = name ? [...after.quotas, ...before.quotas].find((q) => q.name === name) : undefined;
    const body = line.replace(/^(?:Add|Remove|Change|Place) (?:quotas? )?/, "").replace(/^“[^”]+”:?\s*/, "").trim();
    t.add({ objectId: quota?.id ?? slug(line), level: "survey", category: "Quota", kind, field: name ? `quota “${name}”` : "quota checks", ...(kind === "removed" ? { from: name ?? body } : kind === "added" ? { to: body || name || line } : { to: body }), technical: { line } });
  }
}

function researchItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const b = before.research, a = after.research;
  if (!b && !a) return;
  const codeOf = (def: SurveyDefinition, id: string) => def.questions.find((q) => q.id === id)?.code ?? id;
  const fields: [string, (d: SurveyDefinition) => string][] = [
    ["objective", (d) => plain(d.research?.objective, 200)],
    ["hypotheses", (d) => (d.research?.hypotheses ?? []).map((h, i) => `H${i + 1} ${plain(h, 80)}`).join("; ")],
    ["population", (d) => plain(d.research?.population, 200)],
    ["methodology", (d) => plain(d.research?.methodology, 200)],
    ["constructs", (d) => (d.research?.constructs ?? []).map((c) => `${c.name} (${c.role})${c.questionIds.length ? `: ${c.questionIds.map((id) => codeOf(d, id)).join(", ")}` : ""}`).join("; ")],
    ["analysis", (d) => (d.research?.analysis ?? []).map((x) => plain(x, 80)).join("; ")],
    ["assumptions", (d) => (d.research?.assumptions ?? []).map((x) => plain(x, 80)).join("; ")],
    ["sources", (d) => (d.research?.sources ?? []).join("; ")],
    /* Phase 8: the brief, field by field, so "the client is Acme" reads as the client and nothing else */
    ["client", (d) => plain(d.research?.brief?.client, 120)],
    ["business question", (d) => plain(d.research?.brief?.businessQuestion, 200)],
    ["decision", (d) => plain(d.research?.brief?.decision, 200)],
    ["background", (d) => plain(d.research?.brief?.background, 200)],
    ["stakeholders", (d) => (d.research?.brief?.stakeholders ?? []).join("; ")],
    ["deadline", (d) => plain(d.research?.brief?.deadline, 80)],
    ["deliverables", (d) => (d.research?.brief?.deliverables ?? []).join("; ")],
  ];
  for (const [name, read] of fields) {
    const from = read(before), to = read(after);
    if (from === to) continue;
    t.add({ objectId: "research", level: "research", category: "Research design", kind: !from ? "added" : !to ? "removed" : "modified", field: name, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }
}

/** the plan's items by what they are, not by their minted id — a re-proposed plan keeps the same tables under new ids */
function planItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const b = before.research?.analysisPlan, a = after.research?.analysisPlan;
  if (!b && !a) return;
  const n = (k: number, w: string, pl = `${w}s`) => `${k} ${k === 1 ? w : pl}`;
  const summary = (p: AnalysisPlan) => `${n(p.crosstabs.length, "crosstab")}, ${n(p.tests.length, "test")}${p.derived.length ? `, ${n(p.derived.length, "derived variable")}` : ""}${p.segments.length ? `, ${n(p.segments.length, "segment")}` : ""}`;
  if (!b && a) { t.add({ objectId: "analysisPlan", level: "analysis", category: "Analysis plan", kind: "added", field: "analysis plan", to: summary(a) }); return; }
  if (b && !a) { t.add({ objectId: "analysisPlan", level: "analysis", category: "Analysis plan", kind: "removed", field: "analysis plan", from: summary(b) }); return; }
  const xtKey = (x: { rows: string[]; columns: string[] }) => `${x.rows.join(" + ")} by ${x.columns.join(" + ")}`;
  const tKey = (x: { method: string; outcome?: string; variables: string[]; groupBy?: string }) => `${x.method.replace(/_/g, " ")}${x.outcome ? ` on ${x.outcome}` : ""}${x.variables.length ? ` with ${x.variables.join(", ")}` : ""}${x.groupBy ? ` across ${x.groupBy}` : ""}`;
  const diff = <T>(field: string, xs: T[], ys: T[], key: (x: T) => string) => {
    const bk = new Set(xs.map(key)), ak = new Set(ys.map(key));
    for (const y of ys) if (!bk.has(key(y))) t.add({ objectId: `plan:${slug(key(y))}`, level: "analysis", category: "Analysis plan", kind: "added", field, to: key(y), technical: { after: y } });
    for (const x of xs) if (!ak.has(key(x))) t.add({ objectId: `plan:${slug(key(x))}`, level: "analysis", category: "Analysis plan", kind: "removed", field, from: key(x), technical: { before: x } });
  };
  diff("crosstab", b!.crosstabs, a!.crosstabs, xtKey);
  diff("test", b!.tests, a!.tests, tKey);
  diff("derived variable", b!.derived, a!.derived, (d) => `${d.name} (${d.kind.replace(/_/g, " ")} of ${d.from.join(", ")})`);
  diff("segment", b!.segments, a!.segments, (s) => `${s.name} by ${s.by.join(", ")}`);
}

function languageItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const b = before.localization, a = after.localization;
  if (!b && !a) return;
  const name = (code: string) => languageName(code, (a?.languages ?? b?.languages ?? []).find((l) => l.code === code));
  const bl = new Set((b?.languages ?? []).map((l) => l.code)), al = new Set((a?.languages ?? []).map((l) => l.code));
  const impact = translationImpact(before, after);
  for (const l of al) if (!bl.has(l)) t.add({ objectId: l, level: "language", category: "Language", kind: "added", field: name(l), to: `${name(l)} (${a!.languages.find((x) => x.code === l)!.status})` });
  for (const l of bl) if (!al.has(l)) t.add({ objectId: l, level: "language", category: "Language", kind: "removed", field: name(l), from: name(l), detail: `${Object.keys(b?.translations?.[l] ?? {}).length} translations go with it` });
  for (const l of new Set([...al, ...bl])) {
    const bc = (b?.languages ?? []).find((x) => x.code === l), ac = (a?.languages ?? []).find((x) => x.code === l);
    if (bc && ac && (bc.status !== ac.status || bc.enabled !== ac.enabled)) t.add({ objectId: l, level: "language", category: "Language", kind: "modified", field: `${name(l)} status`, from: `${bc.status}${bc.enabled ? "" : ", not offered"}`, to: `${ac.status}${ac.enabled ? "" : ", not offered"}` });
    const bt = b?.translations?.[l] ?? {}, at = a?.translations?.[l] ?? {};
    let written = 0, approved = 0, confirmed = 0, removed = 0;
    const touched: string[] = [];
    // a translation that followed its option's recode is neither written nor removed: the impact lists it as moved
    const moved = movedTranslationKeys(bt, at);
    const movedOld = new Set(moved.values());
    for (const [k, tr] of Object.entries(at)) {
      const p = bt[k] ?? (moved.has(k) ? bt[moved.get(k)!] : undefined);
      if (!p || p.text !== tr.text) { if (tr.text.trim() && tr.status !== "not_translated") { written++; touched.push(k); } continue; }
      if (p.sourceHash !== tr.sourceHash && (p.status === "outdated" || tr.status === "edited")) { confirmed++; touched.push(k); continue; }
      if (p.status !== tr.status && (tr.status === "approved" || tr.status === "reviewed")) { approved++; touched.push(k); }
    }
    /*
     * WHAT THE CHANGE DOES TO THIS LANGUAGE'S TRANSLATIONS — which ones go
     * outdated, which new elements need it, which are dropped with their
     * element, which followed a recode — element by element, so the row says
     * "Q7 option 4 — United States", not "7 translations".
     */
    const il = al.has(l) ? impact.languages.find((x) => x.language === l) : undefined;
    if (il) removed = il.dropped.length;
    else for (const k of Object.keys(bt)) if (!at[k] && !movedOld.has(k) && bt[k].text.trim()) removed++;
    const outdated = il?.outdated.length ?? 0, needed = il?.missing.length ?? 0, followed = il?.moved.length ?? 0;
    if (!written && !approved && !confirmed && !removed && !outdated && !needed && !followed) continue;
    const parts = [written ? `${written} written` : "", approved ? `${approved} approved` : "", confirmed ? `${confirmed} confirmed` : "", outdated ? `${outdated} outdated` : "", needed ? `${needed} to translate` : "", removed ? `${removed} ${il ? "dropped" : "removed"}` : "", followed ? `${followed} moved with a recode` : ""].filter(Boolean);
    const codes = [...new Set(touched.map((k) => /^q:([^:]+):/.exec(k)?.[1]).filter((x): x is string => !!x).map((id) => after.questions.find((q) => q.id === id)?.code ?? id))];
    const listed = (what: string, xs: { element: string }[]) => (xs.length ? `${what}: ${xs.slice(0, 8).map((x) => x.element).join("; ")}${xs.length > 8 ? ` and ${xs.length - 8} more` : ""}` : "");
    const elements = il ? [listed("Outdated", il.outdated), listed("To translate", il.missing), listed("Dropped", il.dropped), listed("Moved", il.moved)].filter(Boolean) : [];
    const detail = [codes.length ? `${codes.slice(0, 12).join(", ")}${codes.length > 12 ? ` and ${codes.length - 12} more` : ""}` : "", ...elements].filter(Boolean).join(" · ");
    t.add({ objectId: l, level: "language", category: "Translation", kind: removed && !written && !approved && !confirmed && !outdated && !needed ? "removed" : written && !Object.keys(bt).length ? "added" : "modified", field: `${name(l)} translations`, to: parts.join(", "), ...(detail ? { detail } : {}), technical: { written, approved, confirmed, removed, keys: touched, ...(il ? { impact: { outdated: il.outdated, missing: il.missing, dropped: il.dropped, moved: il.moved, kept: il.kept } } : {}) } });
  }
  if (!same(b?.routing, a?.routing)) t.add({ objectId: "routing", level: "language", category: "Language", kind: "modified", field: "language routing", to: (a?.routing?.order ?? []).join(" → ") || "default" });
  if (!same(b?.glossary ?? [], a?.glossary ?? [])) { const bg = (b?.glossary ?? []).length, ag = (a?.glossary ?? []).length; t.add({ objectId: "glossary", level: "language", category: "Language", kind: ag > bg ? "added" : ag < bg ? "removed" : "modified", field: "glossary", from: `${bg} terms`, to: `${ag} terms` }); }
}

function surveyItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  for (const [field, from, to] of [["title", before.meta.title, after.meta.title], ["description", plain(before.meta.description, 120), plain(after.meta.description, 120)], ["code", before.meta.code, after.meta.code]] as const) {
    if ((from ?? "") === (to ?? "")) continue;
    t.add({ objectId: "meta", level: "survey", category: "Survey", kind: !from ? "added" : !to ? "removed" : "modified", field, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }
  for (const line of diffTheme(before.branding, after.branding)) {
    const at = line.indexOf(": ");
    const field = at > 0 ? line.slice(0, at) : line, rest = at > 0 ? line.slice(at + 2) : "";
    const arrow = rest.indexOf(" → ");
    t.add({ objectId: `theme:${slug(field)}`, level: "ux", category: "Theme", kind: "modified", field, ...(arrow > 0 ? { from: rest.slice(0, arrow), to: rest.slice(arrow + 3) } : { to: rest }) });
  }
  const ux = diffUx(before, after);
  const cat = (kind: string): ChangeCategory => (kind === "style" ? "Style" : kind === "animation" ? "Animation" : "Behaviour");
  for (const x of ux.added) t.add({ objectId: x.id, level: "ux", category: cat(x.kind), kind: "added", field: x.label, to: x.target });
  for (const x of ux.changed) t.add({ objectId: x.id, level: "ux", category: cat(x.kind), kind: "modified", field: x.label, to: x.target });
  for (const x of ux.removed) t.add({ objectId: x.id, level: "ux", category: cat(x.kind), kind: "removed", field: x.label, from: x.target });
}

/** survey-level display rules (the named ones), by id: those targeting a question are that question's logic */
function displayRuleItems(t: Tree, before: SurveyDefinition, after: SurveyDefinition): void {
  const rB = new Map(before.displayRules.map((r) => [r.id, r])), rA = new Map(after.displayRules.map((r) => [r.id, r]));
  const words = (def: SurveyDefinition, r: SurveyDefinition["displayRules"][number]) => `${r.action} ${r.target.kind === "question" ? (def.questions.find((q) => q.id === r.target.ref || q.code === r.target.ref)?.code ?? r.target.ref) : `${r.target.kind} ${r.target.ref}`}${r.target.subRef ? ` ${r.target.subRef}` : ""} when ${cond(def, r.when)}`;
  const target = (def: SurveyDefinition, r: SurveyDefinition["displayRules"][number]) => (r.target.kind === "question" ? def.questions.find((q) => q.id === r.target.ref || q.code === r.target.ref || q.variableName === r.target.ref) : undefined);
  for (const r of after.displayRules) {
    const p = rB.get(r.id);
    const from = p ? words(before, p) : "", to = words(after, r);
    if (from === to) continue;
    const q = target(after, r);
    t.add({ objectId: r.id, level: "logic", category: "Display logic", kind: p ? "modified" : "added", ...(q ? { question: qRef(q) } : {}), field: `display rule${r.label ? ` “${r.label}”` : ""}`, ...(from ? { from } : {}), to, technical: { before: p, after: r } });
  }
  for (const r of before.displayRules) {
    if (rA.has(r.id)) continue;
    const q = target(before, r);
    t.add({ objectId: r.id, level: "logic", category: "Display logic", kind: "removed", ...(q ? { question: qRef(q) } : {}), field: `display rule${r.label ? ` “${r.label}”` : ""}`, from: words(before, r), affected: q ? t.affected("after", { questions: [q.id] }, "edit") : [], technical: { before: r } });
  }
}

/* ------------------------------------------------------------ public */

/**
 * Every change between two definitions as review items, grouped. The
 * `results` of the batch that produced `after` attach action indexes and
 * the engine's destructive notes to the objects they touched; `destructive`
 * alone (no results) is matched to items by the question code it names;
 * `index` is the before-survey's dependency index when the caller has one.
 */
export function changeItems(before: SurveyDefinition, after: SurveyDefinition, opts: ChangeItemsOptions = {}): ChangeTree {
  const t = new Tree(before, after, opts);
  questionItems(t, before, after);
  displayRuleItems(t, before, after);
  blockItems(t, before, after);
  pageItems(t, before, after);
  flowItems(t, before, after);
  embeddedItems(t, before, after);
  calculationItems(t, before, after);
  quotaItems(t, before, after);
  researchItems(t, before, after);
  planItems(t, before, after);
  languageItems(t, before, after);
  surveyItems(t, before, after);

  const items = t.items;
  // questions in the AFTER order, removed ones after them in their old order
  const order = [...questionOrder(after), ...after.questions.map((q) => q.id), ...questionOrder(before), ...before.questions.map((q) => q.id)];
  const groups = new Map<string, { question: NonNullable<ChangeItem["question"]>; items: ChangeItem[] }>();
  for (const it of items) { if (!it.question) continue; const g = groups.get(it.question.id) ?? { question: it.question, items: [] }; g.items.push(it); groups.set(it.question.id, g); }
  const byQuestion = [...groups.values()].sort((a, b) => order.indexOf(a.question.id) - order.indexOf(b.question.id));
  const survey = items.filter((i) => !i.question && !i.block);
  const blocks = items.filter((i) => !i.question && !!i.block);
  const counts: Record<ChangeLevel, number> = { survey: 0, block: 0, page: 0, question: 0, option: 0, logic: 0, flow: 0, research: 0, analysis: 0, language: 0, ux: 0 };
  for (const it of items) counts[it.level]++;
  const impact = impactReport(items.flatMap((i) => i.affected));
  return { items, byQuestion, survey, blocks, counts, impact };
}
