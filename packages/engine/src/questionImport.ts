import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { listPages } from "./blocks.js";
import { cloneQuestion, type IdMinter } from "./questionOps.js";
import { usedNames } from "./variableUsage.js";
import { mapConditionRoots } from "./conditionWalk.js";
import { remapConditionReferences, type ReferenceMap } from "./conditionCopy.js";
import { pruneReferencesToMany } from "./references.js";

/**
 * REUSE ACROSS SURVEYS — THE LIBRARY INSERT (audit plan #5, 2026-11-07).
 *
 * Any survey can be a library: pick pages (or single questions) from it and they are copied into this one as a new
 * block, page grouping kept. What makes it safe rather than a JSON paste:
 *
 *   - every question gets a fresh id and a code / variable name nothing here uses (the duplicate rule, `cloneQuestion`);
 *   - rules BETWEEN the copied questions follow the copies (Q2 shown if Q1 = 1 still reads the copied Q1);
 *   - piped references `{{Q1}}` follow a renamed code;
 *   - a rule naming a question that was NOT copied is removed and listed — it would otherwise read a question this
 *     survey does not have (or, worse, a different question that happens to share an id).
 */
export interface ImportResult {
  def: SurveyDefinition;
  /** source question id → new question id */
  idMap: Record<string, string>;
  /** source code → new code, only where it had to change */
  renamed: Record<string, string>;
  /** rules dropped because they named a question that was not copied, in words */
  dropped: string[];
  blockId: string | null;
  count: number;
}

const randomIds: IdMinter = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function importQuestions(
  target: SurveyDefinition,
  source: SurveyDefinition,
  pick: { pageIds?: string[]; questionIds?: string[]; blockTitle?: string },
  ids: IdMinter = randomIds,
): ImportResult {
  const def = structuredClone(target);
  /* what to copy, grouped by the page it sits on in the source (single questions share one page) */
  const pages = listPages(source.flow as unknown[]).map((p) => p.node as { id: string; title?: string; questionIds: string[] });
  const groups: { title?: string; questionIds: string[] }[] = [];
  const wantPages = new Set(pick.pageIds ?? []);
  const wantQs = new Set(pick.questionIds ?? []);
  for (const p of pages) {
    if (wantPages.has(p.id)) groups.push({ title: p.title, questionIds: p.questionIds.filter((id) => source.questions.some((q) => q.id === id)) });
  }
  const loose = source.questions.filter((q) => wantQs.has(q.id) && !groups.some((g) => g.questionIds.includes(q.id))).map((q) => q.id);
  if (loose.length) groups.push({ questionIds: loose });
  const order = groups.flatMap((g) => g.questionIds);
  if (!order.length) return { def, idMap: {}, renamed: {}, dropped: [], blockId: null, count: 0 };

  const taken = usedNames(def);
  const idMap: Record<string, string> = {};
  const renamed: Record<string, string> = {};
  const columns: Record<string, Record<string, string>> = {};
  const copies: Question[] = [];
  for (const id of order) {
    const q = source.questions.find((x) => x.id === id)!;
    const copy = cloneQuestion(q, taken, ids);
    /* cloneQuestion names a duplicate Q1_COPY; across surveys the original code is kept when it is free */
    if (!def.questions.some((x) => x.code === q.code) && copy.code !== q.code && ![...copies].some((c) => c.code === q.code)) {
      taken.delete(copy.code); taken.delete(copy.variableName);
      if (!def.questions.some((x) => x.variableName === q.variableName)) { copy.code = q.code; copy.variableName = q.variableName; }
      taken.add(copy.code); taken.add(copy.variableName);
    }
    idMap[q.id] = copy.id;
    if (copy.code !== q.code) renamed[q.code] = copy.code;
    const cm: Record<string, string> = {};
    (q.columns ?? []).forEach((c, i) => { const n = copy.columns?.[i]?.id; if (n && n !== c.id) cm[c.id] = n; });
    columns[q.id] = cm;
    copies.push(copy);
  }

  /* rules between the copies follow the copies (resolved against the SOURCE, where those ids and codes mean something) */
  const map: ReferenceMap = { questions: idMap, columns };
  const holder = { ...source, questions: copies } as SurveyDefinition;
  const remapped = mapConditionRoots(holder, (c) => remapConditionReferences(c, map, source).value).questions;

  /* piping follows a renamed code */
  const pipe = (s: string | undefined) => {
    if (!s || !Object.keys(renamed).length) return s;
    return s.replace(/\{\{\s*([A-Za-z_][\w]*)/g, (m, code: string) => (renamed[code] ? m.replace(code, renamed[code]) : m));
  };
  for (const q of remapped) {
    q.text = pipe(q.text) ?? q.text;
    for (const o of q.options ?? []) o.label = pipe(o.label) ?? o.label;
    for (const r of q.rows ?? []) r.label = pipe(r.label) ?? r.label;
  }

  def.questions.push(...remapped);
  /* a new block of pages, mirroring the source grouping, before the survey's closing end nodes */
  const blockId = ids("blk");
  const children: FlowNode[] = groups.map((g, i) => ({ type: "page", id: ids("p"), ...(g.title ? { title: g.title } : groups.length > 1 ? { title: `Page ${i + 1}` } : {}), questionIds: g.questionIds.map((x) => idMap[x]!) }) as unknown as FlowNode);
  const block = { type: "block", id: blockId, title: pick.blockTitle || `Imported from ${source.meta.title || source.meta.code}`, children } as unknown as FlowNode;
  let at = def.flow.length;
  while (at > 0 && (def.flow[at - 1] as { type: string }).type === "end") at--;
  def.flow.splice(at, 0, block);

  /* a rule that still names a source question nobody copied reads nothing here — remove it and say so */
  const external = new Set<string>();
  const ownIds = new Set(target.questions.map((q) => q.id));
  const scan = JSON.stringify(remapped);
  for (const q of source.questions) if (!idMap[q.id] && !ownIds.has(q.id) && scan.includes(`"${q.id}"`)) external.add(q.id);
  const dropped = external.size
    ? pruneReferencesToMany(def, [...external]).map((r) => `${r.where} — ${r.effect}`)
    : [];
  return { def, idMap, renamed, dropped, blockId, count: remapped.length };
}
