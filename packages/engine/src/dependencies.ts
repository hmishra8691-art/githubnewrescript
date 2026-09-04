import type {
  Condition,
  ListOperation,
  OptionLogic,
  Question,
  SurveyDefinition,
} from "@rescript/schema";
import { setExprSources } from "./setExpression.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { pipeTokensIn } from "./pipingTokens.js";

/**
 * Dependency tracking (reqs §27, §31–32).
 *
 * Everything that can make a question's content depend on another question —
 * display logic, option-level logic, list logic, list operations,
 * carry-forward, conditional randomization, validation guards and piping
 * tokens — is collected into one graph. The graph powers three things:
 *
 *   • cycle detection, so "Q4 depends on Q5 depends on Q4" is caught in the
 *     editor instead of hanging the runtime;
 *   • targeted recalculation — when an answer changes, only the questions
 *     downstream of it need re-evaluating, not the whole survey;
 *   • the logic linter's forward-reference warnings.
 */

/* ------------------------------------------------------------ flow ordering */

/** Question ids in the order the flow presents them. */
export function questionOrder(def: SurveyDefinition): string[] {
  const out: string[] = [];
  const walk = (nodes: any[]): void => {
    for (const n of nodes ?? []) {
      if (n?.type === "page" && Array.isArray(n.questionIds)) out.push(...n.questionIds);
      if (n?.children) walk(n.children);
      if (n?.branches) for (const b of n.branches) walk(b.children);
      if (n?.otherwise) walk(n.otherwise);
    }
  };
  walk(def.flow as any[]);
  // questions not placed on any page still exist in the definition
  for (const q of def.questions) if (!out.includes(q.id)) out.push(q.id);
  return out;
}

/** Position lookup for "is this a forward reference?" checks. */
export function orderIndex(def: SurveyDefinition): Record<string, number> {
  const idx: Record<string, number> = {};
  questionOrder(def).forEach((id, i) => (idx[id] = i));
  return idx;
}

/* ------------------------------------------------------------ ref harvesting */

/** Every question id a condition tree reads from. */
export function conditionRefs(
  def: SurveyDefinition,
  c: Condition | undefined | null,
  into: Set<string> = new Set(),
): Set<string> {
  if (!c) return into;
  if (c.type === "rule") {
    if (c.source.kind === "question" || c.source.kind === "variable") {
      const q = getQuestionByCodeOrVar(def, c.source.ref);
      if (q) into.add(q.id);
    }
    return into;
  }
  for (const child of c.children) conditionRefs(def, child, into);
  return into;
}

function optionLogicRefs(
  def: SurveyDefinition,
  l: OptionLogic | undefined,
  into: Set<string>,
): void {
  if (!l) return;
  for (const c of [
    l.when,
    l.eligibleWhen,
    l.excludeWhen,
    l.prioritizeWhen,
    l.deprioritizeWhen,
    l.randomizeWhen,
  ]) {
    conditionRefs(def, c, into);
  }
  for (const r of [l.carryForward, l.carryBack]) {
    if (r?.sourceQuestionId) into.add(r.sourceQuestionId);
  }
}

function listOpRefs(def: SurveyDefinition, ops: ListOperation[] | undefined, into: Set<string>): void {
  for (const op of ops ?? []) {
    conditionRefs(def, op.when, into);
    conditionRefs(def, op.where, into);
    for (const s of op.sources ?? []) if (s.questionId) into.add(s.questionId);
  }
}

/** Question ids referenced by piping tokens inside a piece of text. */
export function pipingRefs(def: SurveyDefinition, text: string | undefined, into: Set<string>): void {
  if (!text || !text.includes("{{")) return;
  for (const t of pipeTokensIn(text)) {
    if (t.kind !== "question") continue;
    const q = getQuestionByCodeOrVar(def, t.ref);
    if (q) into.add(q.id);
  }
}

/** Everything one question depends on. */
export function questionDependencies(def: SurveyDefinition, q: Question): Set<string> {
  const into = new Set<string>();

  conditionRefs(def, q.displayLogic, into);
  for (const r of q.skipLogic ?? []) conditionRefs(def, r.when, into);
  for (const v of q.validation ?? []) conditionRefs(def, v.when, into);
  for (const r of q.randomization?.rules ?? []) conditionRefs(def, r.when, into);

  if (q.carryForward) {
    into.add(q.carryForward.sourceQuestionId);
    conditionRefs(def, q.carryForward.where, into);
  }
  for (const r of q.listLogic ?? []) {
    into.add(r.sourceQuestionId);
    conditionRefs(def, r.when, into);
  }
  listOpRefs(def, q.optionPipeline, into);

  /*
   * A mask and a punch rule both READ other questions, so they are edges in
   * the same graph — which is what makes `detectLogicCycles` refuse
   * "Q5 masks Q6, Q6 masks Q5" without a second cycle detector (req §31).
   */
  if (q.mask) {
    for (const id of setExprSources(q.mask.expr)) into.add(id);
    conditionRefs(def, q.mask.when, into);
  }
  for (const rule of q.punches ?? []) {
    for (const id of setExprSources(rule.source)) into.add(id);
    conditionRefs(def, rule.when, into);
  }

  for (const o of q.options ?? []) {
    conditionRefs(def, o.visibleIf, into);
    optionLogicRefs(def, o.logic, into);
    pipingRefs(def, o.label, into);
  }
  for (const r of q.rows ?? []) {
    conditionRefs(def, r.visibleIf, into);
    optionLogicRefs(def, r.logic, into);
    pipingRefs(def, r.label, into);
    for (const v of r.validation ?? []) conditionRefs(def, v.when, into);
  }
  for (const c of q.columns ?? []) {
    conditionRefs(def, c.visibleIf, into);
    if (c.carryForward) {
      into.add(c.carryForward.sourceQuestionId);
      conditionRefs(def, c.carryForward.where, into);
    }
    for (const o of c.options ?? []) {
      conditionRefs(def, o.visibleIf, into);
      optionLogicRefs(def, o.logic, into);
    }
    for (const v of c.validation ?? []) conditionRefs(def, v.when, into);
  }

  pipingRefs(def, q.text, into);
  pipingRefs(def, q.instruction, into);
  pipingRefs(def, q.description, into);
  pipingRefs(def, q.customHtml, into);

  into.delete(q.id); // self-reference is not a dependency
  return into;
}

/** questionId → the question ids it reads from. */
export function dependencyGraph(def: SurveyDefinition): Record<string, string[]> {
  const g: Record<string, string[]> = {};
  for (const q of def.questions) {
    g[q.id] = [...questionDependencies(def, q)].filter((id) =>
      def.questions.some((x) => x.id === id),
    );
  }
  return g;
}

/** questionId → the question ids that read from it (reverse graph). */
export function dependentsGraph(def: SurveyDefinition): Record<string, string[]> {
  const rev: Record<string, string[]> = {};
  for (const q of def.questions) rev[q.id] = [];
  for (const [qid, deps] of Object.entries(dependencyGraph(def))) {
    for (const d of deps) (rev[d] ??= []).push(qid);
  }
  return rev;
}

/**
 * Everything downstream of a changed answer, transitively (req §32).
 * Feed this to a re-render instead of recomputing the whole survey.
 */
export function dependentsOf(
  def: SurveyDefinition,
  questionId: string,
  rev = dependentsGraph(def),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([questionId]);
  const queue = [...(rev[questionId] ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(rev[id] ?? []));
  }
  return out;
}

/**
 * Circular dependency detection (req §31). Returns every cycle found, each
 * as the list of question ids that form it, so the editor can name them:
 * "Circular dependency detected between Q4 and Q5."
 */
export function detectLogicCycles(def: SurveyDefinition): string[][] {
  const graph = dependencyGraph(def);
  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done
  const stack: string[] = [];

  const visit = (id: string): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      const at = stack.indexOf(id);
      const cycle = stack.slice(at);
      const key = [...cycle].sort().join("|");
      if (!seenCycle.has(key)) {
        seenCycle.add(key);
        cycles.push(cycle);
      }
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dep of graph[id] ?? []) visit(dep);
    stack.pop();
    state.set(id, 2);
  };

  for (const q of def.questions) visit(q.id);
  return cycles;
}

/** Convenience: cycles rendered with question codes. */
export function describeCycle(def: SurveyDefinition, cycle: string[]): string {
  const codes = cycle.map((id) => def.questions.find((q) => q.id === id)?.code ?? id);
  return `Circular dependency detected between ${codes.join(" → ")} → ${codes[0]}.`;
}

/* ------------------------------------------------------------ blocks */

export interface BlockDependencies {
  /** the block's own questions, in order */
  questions: Question[];
  /** earlier (out-of-block) questions the block reads — display logic, piping, masks, punches, branch conditions … */
  dependsOn: Question[];
  /** ids referenced that are not questions in this survey (dangling) */
  unknown: string[];
}

/**
 * What "Preview block" needs to know before it can start the real runtime at
 * a block: which questions outside the block the block's behaviour depends
 * on. A block whose display logic reads Q1, whose text pipes Q2, whose options
 * are masked by Q3 or whose enclosing branch tests Q4 cannot be previewed
 * faithfully with those unanswered — so the preview offers to set test values
 * for exactly these.
 *
 * The block is a flow node id: a `block` container, a lone `page`, or a
 * `section`. Every page under it counts. Conditions on the block itself, on
 * its pages and on every container between it and the flow root are included;
 * the block's own questions are not (answering them is what the preview is for).
 */
export function blockDependencies(def: SurveyDefinition, blockId: string): BlockDependencies {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const inBlock: string[] = [];
  const refs = new Set<string>();

  // the containers around the block, so branch / loop / block conditions count
  const path: any[] = [];
  let found: any = null;
  const find = (nodes: any[]): boolean => {
    for (const n of nodes ?? []) {
      if (n?.id === blockId) { found = n; return true; }
      path.push(n);
      const kids = [
        ...(n?.children ?? []),
        ...((n?.branches ?? []).flatMap((b: any) => b.children ?? [])),
        ...(n?.otherwise ?? []),
      ];
      if (kids.length && find(kids)) return true;
      path.pop();
    }
    return false;
  };
  find(def.flow as any[]);
  if (!found) return { questions: [], dependsOn: [], unknown: [] };

  for (const container of path) {
    conditionRefs(def, container.visibleIf, refs);
    for (const b of container.branches ?? []) conditionRefs(def, b.when, refs);
    if (container.type === "loop" && container.source?.kind === "question") refs.add(container.source.questionId);
  }

  const collect = (n: any) => {
    conditionRefs(def, n?.visibleIf, refs);
    if (n?.type === "page") inBlock.push(...(n.questionIds ?? []));
    for (const b of n?.branches ?? []) { conditionRefs(def, b.when, refs); for (const c of b.children ?? []) collect(c); }
    for (const c of n?.children ?? []) collect(c);
    for (const c of n?.otherwise ?? []) collect(c);
  };
  collect(found);

  const questions = inBlock.map((id) => byId.get(id)).filter((q): q is Question => !!q);
  for (const q of questions) for (const d of questionDependencies(def, q)) refs.add(d);

  const own = new Set(inBlock);
  const dependsOn: Question[] = [];
  const unknown: string[] = [];
  const order = orderIndex(def);
  for (const id of refs) {
    if (own.has(id)) continue;
    const q = byId.get(id);
    if (q) dependsOn.push(q); else unknown.push(id);
  }
  dependsOn.sort((a, b) => (order[a.id] ?? 1e9) - (order[b.id] ?? 1e9));
  return { questions, dependsOn, unknown };
}
