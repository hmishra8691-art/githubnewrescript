import type { Condition, ListFill, SurveyDefinition } from "@rescript/schema";
import type { LogicIssue } from "./lintLogic.js";
import { dependencyGraph } from "./dependencies.js";
import { referencedNames } from "./embedded.js";
import { setExprListFillIds } from "./setExpression.js";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * LIST FILL LINT — the checks that are about a List Fill as a whole.
 *
 *   circular    a list whose inputs depend on its own output: its source (or
 *               count, `runWhen`, an `eligibleWhen`) reads a question it
 *               writes as an answer, a question whose options it masks
 *               (`LISTFILL(<it>)`), its own `LISTFILL_<NAME>_*` variables, or
 *               — through other questions and lists — any of those. Such a
 *               list re-decides itself from its own result: on a page revisit
 *               it would chase its own tail, and in a sample-counted list
 *               every chase gives back and re-claims slots.
 *   dangling    a source question / List Fill / destination question that does
 *               not exist (the "List Fill" quality area promised this check)
 *   duplicate   two lists writing the SAME question's answer, or one list
 *               writing one question twice, or two lists with the same name
 *               (their LISTFILL_<NAME>_* variables collide)
 *   inert       `least_filled` without sample-level counting (no counts → only
 *               the tie-break decides)
 */
export function lintListFills(def: SurveyDefinition): LogicIssue[] {
  const issues: LogicIssue[] = [];
  const lists = def.listFills ?? [];
  if (!lists.length) return issues;
  const nameOf = (lf: ListFill) => lf.name ?? lf.id;
  const varKey = (lf: ListFill) => `LISTFILL_${nameOf(lf).toUpperCase()}_`;
  const push = (i: number, level: LogicIssue["level"], path: string, message: string) =>
    issues.push({ level, questionCode: `List Fill ${nameOf(lists[i])}`, path: `listFills[${i}].${path}`, message, objectKey: `listFill:${lists[i].id}` as LogicIssue["objectKey"] });

  /* ---------------------------------------------------- what each list produces */
  // question id → the lists that decide it (answer destination, or a mask/row/column mask on LISTFILL(list))
  const producedBy = new Map<string, Set<string>>();
  const produce = (qid: string, lfId: string) => (producedBy.get(qid) ?? producedBy.set(qid, new Set()).get(qid)!).add(lfId);
  for (const lf of lists) {
    for (const d of lf.destinations ?? []) if (d.write === "answer" && d.questionId) produce(d.questionId, lf.id);
  }
  for (const q of def.questions ?? []) {
    for (const m of [q.mask, q.rowMask, q.columnMask]) {
      if (!m) continue;
      for (const id of setExprListFillIds(m.expr)) produce(q.id, id);
    }
  }
  const byVar = (name: string): ListFill | undefined => lists.find((l) => name.toUpperCase().startsWith(varKey(l)));

  /* ---------------------------------------------------- what each list reads */
  const qGraph = dependencyGraph(def);
  const reads = (lf: ListFill): { questions: Set<string>; lists: Set<string>; masked: Set<string> } => {
    const questions = new Set<string>();
    const listIds = new Set<string>();
    // questions read for their OPTIONS (a `displayed` source): a mask on them is an input too
    const masked = new Set<string>();
    const name = (n: string) => {
      const q = getQuestionByCodeOrVar(def, n);
      if (q) { questions.add(q.id); return; }
      const l = byVar(n);
      if (l) { listIds.add(l.id); return; }
      const calc = (def.calculations ?? []).find((c) => c.targetVariable === n);
      if (calc) for (const m of referencedNames(calc.expression)) name(m);
    };
    const cond = (c: Condition | undefined | null): void => {
      if (!c) return;
      if (c.type === "rule") {
        const src = c.source as { kind: string; ref?: string };
        if (src.kind === "expr" && src.ref) for (const m of referencedNames(src.ref)) name(m);
        else if (src.ref && ["question", "variable", "calculation", "embedded"].includes(src.kind)) name(src.ref);
        return;
      }
      for (const ch of c.children ?? []) cond(ch);
    };
    const s = lf.source;
    if (s.kind === "question") {
      questions.add(s.questionId);
      if (s.take !== "all") masked.add(s.questionId);
    } else if (s.kind === "listFill") listIds.add(s.listFillId);
    else if (s.kind === "calculation" || s.kind === "embedded") name(s.ref);
    const c = lf.selection.count;
    if (c.kind === "question") questions.add(c.questionId);
    if (c.kind === "calculation") name(c.ref);
    cond(lf.runWhen);
    for (const o of lf.options ?? []) cond(o.eligibleWhen);
    // and everything those questions depend on, transitively
    const stack = [...questions];
    while (stack.length) {
      const id = stack.pop()!;
      for (const dep of qGraph[id] ?? []) if (!questions.has(dep)) { questions.add(dep); stack.push(dep); }
    }
    return { questions, lists: listIds, masked };
  };

  /* ---------------------------------------------------- list → list edges */
  const edges = new Map<string, Map<string, string>>(); // from → (to → why)
  lists.forEach((lf) => {
    const r = reads(lf);
    const out = new Map<string, string>();
    for (const l of r.lists) out.set(l, l === lf.id ? `reads its own LISTFILL_${nameOf(lf).toUpperCase()}_* result` : `reads List Fill ${nameOf(lists.find((x) => x.id === l) ?? lf)}`);
    for (const qid of r.questions) {
      for (const p of producedBy.get(qid) ?? []) {
        const q = def.questions.find((x) => x.id === qid);
        const isMaskOnly = !(lists.find((x) => x.id === p)?.destinations ?? []).some((d) => d.write === "answer" && d.questionId === qid);
        // a mask only changes which options a question SHOWS: it matters to a source read as `displayed`/`selected`, or to anything reading it downstream
        if (isMaskOnly && qid === (lf.source.kind === "question" ? lf.source.questionId : "") && !r.masked.has(qid)) continue;
        if (!out.has(p)) out.set(p, `reads ${q?.code ?? qid}, which ${isMaskOnly ? "is masked by" : "is written by"} ${p === lf.id ? "this list" : `List Fill ${nameOf(lists.find((x) => x.id === p)!)}`}`);
      }
    }
    edges.set(lf.id, out);
  });

  /* ---------------------------------------------------- cycles */
  /** the shortest path start → … → start, or null */
  const findCycle = (start: string): string[] | null => {
    const prev = new Map<string, string>();
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of edges.get(n)?.keys() ?? []) {
        if (m === start) {
          const path = [n];
          let cur = n;
          while (cur !== start) { cur = prev.get(cur)!; path.unshift(cur); }
          return [...path, start];
        }
        if (seen.has(m)) continue;
        seen.add(m);
        prev.set(m, n);
        queue.push(m);
      }
    }
    return null;
  };
  const reported = new Set<string>();
  lists.forEach((lf, i) => {
    const ring = findCycle(lf.id);
    if (!ring) return;
    const key = [...new Set(ring)].sort().join("|");
    if (reported.has(key)) return;
    reported.add(key);
    const label = (id: string) => nameOf(lists.find((x) => x.id === id)!);
    const hops: string[] = [];
    for (let k = 0; k + 1 < ring.length; k++) hops.push(`${label(ring[k])} ${edges.get(ring[k])?.get(ring[k + 1]) ?? "depends on it"}`);
    push(i, "error", "source",
      `Circular List Fill: ${hops.join("; ")}. A List Fill cannot be decided from its own result — take the source from a question it does not fill or mask.`);
  });

  /* ---------------------------------------------------- dangling, duplicates, inert */
  const names = new Map<string, number>();
  lists.forEach((lf, i) => {
    const s = lf.source;
    if (s.kind === "question" && !def.questions.some((q) => q.id === s.questionId)) push(i, "error", "source.questionId", `Its source question ${s.questionId} does not exist — the list will allocate nothing.`);
    if (s.kind === "listFill" && !lists.some((l) => l.id === s.listFillId)) push(i, "error", "source.listFillId", `Its source List Fill ${s.listFillId} does not exist — the list will allocate nothing.`);
    const seenDest = new Set<string>();
    (lf.destinations ?? []).forEach((d, j) => {
      if (!d.questionId) return;
      if (!def.questions.some((q) => q.id === d.questionId)) push(i, "error", `destinations[${j}].questionId`, `Destination ${d.questionId} does not exist.`);
      if (d.write !== "answer") return;
      if (seenDest.has(d.questionId)) push(i, "error", `destinations[${j}].questionId`, `Writes the answer of ${def.questions.find((q) => q.id === d.questionId)?.code ?? d.questionId} twice — only the last write survives.`);
      seenDest.add(d.questionId);
      const others = lists.filter((o) => o !== lf && (o.destinations ?? []).some((od) => od.write === "answer" && od.questionId === d.questionId));
      if (others.length && lists.indexOf(others[0]) > i) push(i, "error", `destinations[${j}].questionId`, `${def.questions.find((q) => q.id === d.questionId)?.code ?? d.questionId} is written by this list and by ${others.map(nameOf).join(", ")} — whichever runs last overwrites the other.`);
    });
    const n = nameOf(lf).toUpperCase();
    if (names.has(n)) push(i, "error", "name", `Another List Fill is also named ${nameOf(lf)} — their LISTFILL_${n}_* variables collide. Rename one.`);
    names.set(n, i);
    if (lf.selection.method === "least_filled" && !lf.tracking.sampleLevel) push(i, "warning", "selection.method", "Least filled needs “count across the sample” — without it every count is 0 and the tie-break alone decides.");
  });
  return issues;
}
