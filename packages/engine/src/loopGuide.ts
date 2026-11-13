import type { SurveyDefinition } from "@rescript/schema";
import { loopNodes, questionIdsInLoop, type LoopFlowNode } from "./loopModel.js";
import { effectiveCount, effectiveOrder, possibleLoopItems } from "./loops.js";
import { questionOrder } from "./dependencies.js";
import { conditionSummary } from "./logicSummary.js";
import { stripHtmlText } from "./html.js";

/**
 * A LOOP, IN A RESEARCHER'S WORDS (2026-11-13).
 *
 * A loop node carries a dozen settings — a source of seven kinds, three rules, a count, an order, a reference table,
 * aggregates, a re-evaluation policy — and its editor showed all of them at once under their programming names
 * ("CONTINUE", "BREAK / UNTIL", "resolve the item list"). Nothing on the screen said what the loop would actually DO.
 *
 * The node and how it runs are unchanged (loops.ts). This module reads a loop and answers three questions the editor
 * could not:
 *
 *   loopPlainSummary   what will happen, as sentences: "Repeats 3 questions once for each brand the respondent chose
 *                      at Q2 — at most 5 of them, in random order."
 *   loopChecks         what is wrong or unfinished, in plain language, each with what to do: the list is empty, the
 *                      question it reads comes after the loop, nothing is inside it yet …
 *   loopExtras         which of the less common settings are in use — so the editor can keep them folded away
 *                      when they are not, and open when they are
 *   suggestLoopSource  the loop a researcher most likely means, to start from: the nearest earlier multi-select
 */
export interface LoopCheck {
  level: "problem" | "warning" | "tip";
  message: string;
  /** which part of the editor fixes it */
  where: "source" | "inside" | "count" | "order" | "rules" | "details" | "totals";
}

const FILTER_WORDS: Record<string, string> = {
  selected: "the respondent chose", notSelected: "the respondent did not choose", displayed: "the respondent was shown",
  all: "listed", eligible: "that pass this loop's own rule", invalid: "that are not valid answers",
};
const AXIS_WORDS: Record<string, string> = { options: "answer", rows: "row", columns: "column" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const codeOf = (def: SurveyDefinition, id: string) => def.questions.find((q) => q.id === id)?.code ?? null;
const countWords = (v: unknown, def: SurveyDefinition): string => {
  if (typeof v === "number") return String(v);
  const ref = (v as { kind?: string; ref?: string } | undefined)?.ref;
  return ref ? `the number in ${codeOf(def, ref) ?? ref}` : "a number";
};

/** what the loop repeats FOR — "each brand the respondent chose at Q2" */
export function loopSourceWords(def: SurveyDefinition, node: LoopFlowNode): string {
  const s = node.source;
  switch (s.kind) {
    case "question": {
      const code = codeOf(def, s.questionId);
      if (!code) return "each answer of a question that no longer exists";
      return `each ${AXIS_WORDS[s.dimension ?? "options"]} ${FILTER_WORDS[s.filter ?? "selected"]} at ${code}`;
    }
    case "static": return s.items.length ? `each of ${plural(s.items.length, "item")} in its own list (${s.items.slice(0, 3).map((i) => i.label || i.code).join(", ")}${s.items.length > 3 ? "…" : ""})` : "each item of its own list";
    case "count": return typeof s.count === "number" ? `${plural(s.count, "time")}` : `as many times as ${countWords(s.count, def)}`;
    case "listFill": { const lf = def.listFills.find((x) => x.id === s.listFillId); return `each item given to this respondent by the list “${lf?.name ?? s.listFillId ?? "?"}”`; }
    case "design": { const d = def.designs.find((x) => x.id === s.designId); return `each task of the design “${d?.name ?? s.designId}”`; }
    case "variable": return `each item of the list held in ${s.ref || "a variable"}`;
    case "setExpression": return "each answer in a combination of questions";
    default: return "each item";
  }
}

export function loopPlainSummary(def: SurveyDefinition, node: LoopFlowNode): string[] {
  const inside = questionIdsInLoop(node);
  const what = inside.length ? `Repeats ${inside.length === 1 ? `the question ${codeOf(def, inside[0]) ?? ""}`.trim() : `${inside.length} questions (${inside.slice(0, 4).map((id) => codeOf(def, id)).filter(Boolean).join(", ")}${inside.length > 4 ? "…" : ""})`}` : "Repeats what is inside it";
  const src = loopSourceWords(def, node);
  const lines: string[] = [];
  const count = effectiveCount(node), order = effectiveOrder(node);
  const many =
    count.mode === "exact" ? ` — exactly ${countWords(count.value, def)} of them`
    : count.mode === "max" ? ` — at most ${countWords(count.value, def)} of them`
    : count.mode === "min" ? ` — only when there are at least ${countWords(count.value, def)}`
    : "";
  const how =
    order.kind === "random" ? ", in random order"
    : order.kind === "weightedRandom" ? `, in random order weighted by ${order.column ?? "an item detail"}`
    : order.kind === "selection" ? ", in the order the respondent chose them"
    : order.kind === "priority" ? `, sorted by ${order.column ?? "an item detail"} (${order.direction === "desc" ? "highest" : "lowest"} first)`
    : order.kind === "custom" ? ", in an order set by hand"
    : "";
  lines.push(node.source.kind === "count" ? `${what} ${src}.` : `${what} once for ${src}${many}${how}.`);
  if (node.eligibleIf) lines.push(`Only for items where ${conditionSummary(def, node.eligibleIf)}.`);
  if (node.skipIf) lines.push(`Leaves an item out when ${conditionSummary(def, node.skipIf)}.`);
  if (node.breakIf) lines.push(`Stops repeating once ${conditionSummary(def, node.breakIf)}.`);
  if (node.resolveSource === "once") lines.push("The list is fixed when the respondent first reaches the loop.");
  const totals = node.aggregates ?? [];
  if (totals.length) lines.push(`Afterwards it works out ${plural(totals.length, "total")} across the rounds (${totals.slice(0, 3).map((a) => a.name).join(", ")}${totals.length > 3 ? "…" : ""}).`);
  return lines;
}

export function loopChecks(def: SurveyDefinition, node: LoopFlowNode): LoopCheck[] {
  const out: LoopCheck[] = [];
  const s = node.source;
  const inside = questionIdsInLoop(node);
  if (!inside.length) out.push({ level: "warning", where: "inside", message: "Nothing is inside this loop yet. Add or drag in the questions that should be asked each time." });
  if (s.kind === "question") {
    const q = def.questions.find((x) => x.id === s.questionId);
    if (!q) out.push({ level: "problem", where: "source", message: "The question this loop reads no longer exists. Choose another question." });
    else {
      const axis = s.dimension ?? "options";
      const list = axis === "rows" ? q.rows : axis === "columns" ? q.columns : q.options;
      if (!(list?.length)) out.push({ level: "problem", where: "source", message: `${q.code} has no ${AXIS_WORDS[axis]}s to repeat for. Choose a question with a list of answers.` });
      const order = questionOrder(def);
      const at = order.indexOf(q.id);
      const firstInside = Math.min(...inside.map((id) => order.indexOf(id)).filter((i) => i >= 0), Infinity);
      if (inside.includes(q.id)) out.push({ level: "problem", where: "source", message: `${q.code} is inside this loop, so its answers are not known when the loop starts. Move ${q.code} before the loop.` });
      else if (at >= 0 && firstInside !== Infinity && at > firstInside && (s.filter ?? "selected") !== "all") out.push({ level: "problem", where: "source", message: `${q.code} is asked after this loop, so the respondent has not answered it yet when the loop starts. Move ${q.code} before the loop, or repeat for every answer listed.` });
      if (q.type === "single_select" && (s.filter ?? "selected") === "selected") out.push({ level: "tip", where: "source", message: `${q.code} takes one answer, so this loop runs once. Use a multiple-choice question to repeat for several items.` });
    }
  }
  if (s.kind === "static") {
    if (!s.items.length) out.push({ level: "problem", where: "source", message: "The list is empty. Add the items to repeat for." });
    const codes = s.items.map((i) => i.code.trim());
    if (codes.some((c) => !c)) out.push({ level: "problem", where: "source", message: "An item has no code. Every item needs a short code (1, 2, 3 … is fine)." });
    if (new Set(codes).size !== codes.length) out.push({ level: "problem", where: "source", message: "Two items share a code. Give each item its own code so their answers stay apart." });
    if (s.items.some((i) => !i.label.trim())) out.push({ level: "warning", where: "source", message: "An item has no name. Its name is what {{loop.label}} shows in the questions." });
  }
  if (s.kind === "count" && typeof s.count === "number" && s.count < 1) out.push({ level: "problem", where: "source", message: "The number of times is less than 1, so the loop never runs." });
  if (s.kind === "listFill" && !def.listFills.some((x) => x.id === s.listFillId)) out.push({ level: "problem", where: "source", message: "The list this loop reads has not been set up. Create it in List Fill, or choose another source." });
  if (s.kind === "design" && !def.designs.some((x) => x.id === s.designId)) out.push({ level: "problem", where: "source", message: "The design this loop reads does not exist. Choose a design, or another source." });
  if (s.kind === "variable" && !s.ref.trim()) out.push({ level: "problem", where: "source", message: "Name the variable that holds the list." });
  const order = effectiveOrder(node);
  const cols = node.references?.columns ?? [];
  if ((order.kind === "priority" || order.kind === "weightedRandom") && (!order.column || !cols.some((c) => c.name === order.column))) out.push({ level: "problem", where: "order", message: "The order uses an item detail that is not chosen (or was removed). Pick the detail to sort by, or choose another order." });
  const count = effectiveCount(node);
  if (count.mode !== "all" && typeof count.value === "number" && count.value < 1) out.push({ level: "problem", where: "count", message: "The number of items is less than 1, so the loop never runs." });
  const possible = possibleLoopItems(def, node);
  if (possible && count.mode === "min" && typeof count.value === "number" && count.value > possible.length) out.push({ level: "problem", where: "count", message: `The loop needs at least ${count.value} items but its list only has ${possible.length}, so it can never run.` });
  if (possible && count.mode === "exact" && typeof count.value === "number" && count.value > possible.length) out.push({ level: "warning", where: "count", message: `The loop asks for exactly ${count.value} items but its list only has ${possible.length}.` });
  for (const a of node.aggregates ?? []) {
    if (!a.questionRef) { out.push({ level: "problem", where: "totals", message: `The total “${a.name}” has no question chosen.` }); continue; }
    const q = def.questions.find((x) => x.code === a.questionRef || x.id === a.questionRef);
    if (q && !inside.includes(q.id)) out.push({ level: "warning", where: "totals", message: `The total “${a.name}” reads ${q.code}, which is not inside this loop, so there is nothing to add up across rounds.` });
  }
  for (const c of cols) if (c.required && possible) {
    const missing = possible.filter((i) => { const v = node.references?.values?.[i.code]?.[c.name]; return (!c.source || c.source.kind === "static") && (v === undefined || v === null || v === ""); });
    if (missing.length) out.push({ level: "warning", where: "details", message: `The item detail “${c.name}” is required but empty for ${plural(missing.length, "item")} (${missing.slice(0, 3).map((i) => stripHtmlText(i.label) || i.code).join(", ")}${missing.length > 3 ? "…" : ""}).` });
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.loopVar)) out.push({ level: "problem", where: "details", message: "The loop needs a short name made of letters, digits or underscores (it is used in piping, e.g. {{brand.label}})." });
  else if (loopNodes(def).some((l) => l.node.id !== node.id && l.node.loopVar === node.loopVar)) out.push({ level: "warning", where: "details", message: `Another loop is also named “${node.loopVar}”. Give each loop its own name so their data columns stay apart.` });
  return out;
}

/** the less common settings that are in use (and how many), so the editor can keep them out of the way when they are not */
export function loopExtras(node: LoopFlowNode): { rules: number; details: number; totals: number; fixedList: boolean; total: number } {
  const rules = [node.eligibleIf, node.skipIf, node.breakIf, node.invalidIf].filter(Boolean).length;
  const details = node.references?.columns.length ?? 0;
  const totals = node.aggregates?.length ?? 0;
  const fixedList = node.resolveSource === "once";
  return { rules, details, totals, fixedList, total: rules + details + totals + (fixedList ? 1 : 0) };
}

/** the loop a researcher most likely means: the nearest multiple-choice question asked before this point */
export function suggestLoopSource(def: SurveyDefinition, beforeQuestionId?: string): LoopFlowNode["source"] {
  const order = questionOrder(def);
  const cut = beforeQuestionId ? order.indexOf(beforeQuestionId) : order.length;
  const earlier = (cut >= 0 ? order.slice(0, cut) : order).map((id) => def.questions.find((q) => q.id === id)).filter((q): q is SurveyDefinition["questions"][number] => !!q);
  const multi = [...earlier].reverse().find((q) => q.type === "multi_select" && q.options.length >= 2);
  if (multi) return { kind: "question", questionId: multi.id, filter: "selected" };
  return { kind: "static", items: [{ code: "1", label: "" }, { code: "2", label: "" }] };
}

/**
 * The source a loop that was JUST placed in the flow should start from: the
 * nearest multi-select asked before it ("repeat for every brand they
 * picked" is what most loops are). Returns null when nothing earlier fits —
 * the caller then keeps the empty typed list, exactly as before.
 */
export function suggestLoopSourceInFlow(def: SurveyDefinition, flow: unknown[], loopId: string): LoopFlowNode["source"] | null {
  const before: string[] = [];
  let found = false;
  const walk = (nodes: any[]): void => {
    for (const n of nodes ?? []) {
      if (found) return;
      if (n?.id === loopId) { found = true; return; }
      if (n?.type === "page" && Array.isArray(n.questionIds)) before.push(...n.questionIds);
      if (n?.children) walk(n.children);
      if (n?.branches) for (const b of n.branches) walk(b.children);
      if (n?.otherwise) walk(n.otherwise);
    }
  };
  walk(flow as any[]);
  if (!found) return null;
  for (let i = before.length - 1; i >= 0; i--) {
    const q = def.questions.find((x) => x.id === before[i]);
    if (q && q.type === "multi_select" && q.options.length >= 2) return { kind: "question", questionId: q.id, filter: "selected" };
  }
  return null;
}
