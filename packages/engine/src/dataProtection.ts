import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { stripHtmlText } from "./html.js";

/**
 * ONCE A SURVEY HAS LIVE RESPONSES, NOTHING THAT HOLDS DATA IS DELETED — IT IS HIDDEN (2026-11-15).
 *
 * A question is a set of columns in the dataset; an option, row or column is a code inside them. Responses already
 * stored are keyed by those ids and codes. Deleting one from the definition does not delete the answers — it deletes
 * the only thing that says what they mean: the variable disappears from the export, cross-tabs lose a row, a
 * historical "3" has no label. So after the first live response a deletion is turned into a HIDE:
 *
 *   a deleted question          comes back in the page it was in, with `settings.hidden` on — not asked any more,
 *                               still a variable, still exported, still labelled
 *   a deleted option / row /    comes back where it was with visibility "always hide" — not offered any more, the
 *   column                      code keeps its label
 *   a code typed over           (the same option, a different code) the code is put back; the new wording is kept
 *
 * Wording, order, logic, new questions and new options are untouched: only removal of something that existed before
 * the edit is reversed. A display-only block (`html`) holds no data and is deleted as asked.
 *
 * This is a pure function of (before, after) so the same rule runs in the editor — where every edit, by hand, by
 * Intelligent Mode, by JSON or by import, passes through one place — and again on the server, which does not trust
 * the editor to have run it.
 */
export type ProtectedKind = "question" | "option" | "row" | "column" | "code";
export interface ProtectedItem {
  kind: ProtectedKind;
  questionId: string;
  questionCode: string;
  /** the option / row code or column id (absent for a question) */
  code?: string;
  /** what it is called, for the message */
  label: string;
}
export interface DataProtectionResult {
  def: SurveyDefinition;
  /** what was put back and hidden (or, for kind "code", put back) */
  restored: ProtectedItem[];
  changed: boolean;
}

/** shown before the hide, and after it — the two messages the editor displays */
export const DATA_PROTECTION_NOTICE =
  "This survey is live and already contains responses. This element cannot be permanently deleted because it may be associated with existing response data. We recommend hiding it instead.";
export const DATA_PROTECTION_DONE = "This element has been hidden successfully. Existing response data has been preserved.";

/** question types that never store an answer */
const DISPLAY_ONLY = new Set(["html"]);
export const holdsData = (q: Pick<Question, "type">): boolean => !DISPLAY_ONLY.has(q.type);

const plain = (s: unknown) => stripHtmlText(String(s ?? "")).trim();

interface PageHit { page: Extract<FlowNode, { type: "page" }>; }
function findPage(nodes: FlowNode[], pred: (p: Extract<FlowNode, { type: "page" }>) => boolean): PageHit | null {
  for (const n of nodes) {
    if (n.type === "page") { if (pred(n)) return { page: n }; continue; }
    const kids: FlowNode[][] = [];
    const anyN = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[] };
    if (Array.isArray(anyN.children)) kids.push(anyN.children);
    if (Array.isArray(anyN.branches)) for (const b of anyN.branches) kids.push(b.children);
    for (const k of kids) { const hit = findPage(k, pred); if (hit) return hit; }
  }
  return null;
}

type Listed = { code?: string | number; id?: string; label?: string; logic?: { visibility?: string } & Record<string, unknown> };
const keyOf = (axis: "options" | "rows" | "columns", item: Listed): string => String(axis === "columns" ? item.id : item.code);

/** put removed members of one list back, hidden; a code typed over an existing member is put back in place */
function protectList(axis: "options" | "rows" | "columns", before: Listed[], after: Listed[], q: Question, out: ProtectedItem[]): Listed[] {
  if (!before.length) return after;
  const beforeKeys = new Set(before.map((x) => keyOf(axis, x)));
  const afterKeys = new Set(after.map((x) => keyOf(axis, x)));
  const missing = before.map((item, index) => ({ item, index })).filter(({ item }) => !afterKeys.has(keyOf(axis, item)));
  if (!missing.length) return after;
  const next = after.map((x) => ({ ...x }));
  const kind: ProtectedKind = axis === "options" ? "option" : axis === "rows" ? "row" : "column";
  /*
   * RECODED, NOT REMOVED: the list is the same length and the member at the same place has the same wording and a
   * code nobody had. That is the old member with its code typed over — putting the member back hidden beside it would show the label
   * twice and leave the answers pointing at the hidden twin.
   */
  const sameLength = before.length === after.length;
  const stillMissing: typeof missing = [];
  for (const m of missing) {
    const twin = next[m.index];
    if (sameLength && twin && !beforeKeys.has(keyOf(axis, twin)) && plain(twin.label) === plain(m.item.label)) {
      if (axis === "columns") twin.id = m.item.id; else twin.code = m.item.code;
      out.push({ kind: "code", questionId: q.id, questionCode: q.code, code: keyOf(axis, m.item), label: plain(twin.label) || keyOf(axis, m.item) });
    } else stillMissing.push(m);
  }
  for (const m of stillMissing) {
    const hidden: Listed = { ...m.item, logic: { ...(m.item.logic ?? {}), visibility: "always_hide" } };
    /* after the nearest earlier member that is still there, so the list reads in its old order */
    let at = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      const j = next.findIndex((x) => keyOf(axis, x) === keyOf(axis, before[i]));
      if (j >= 0) { at = j + 1; break; }
    }
    next.splice(at, 0, hidden);
    out.push({ kind, questionId: q.id, questionCode: q.code, code: keyOf(axis, m.item), label: plain(m.item.label) || keyOf(axis, m.item) });
  }
  return next;
}

export function protectCollectedData(before: SurveyDefinition, after: SurveyDefinition): DataProtectionResult {
  const restored: ProtectedItem[] = [];
  const afterIds = new Set(after.questions.map((q) => q.id));
  const removed = before.questions.filter((q) => holdsData(q) && !afterIds.has(q.id));
  let listsChanged = false;

  /* options, rows and columns of the questions that are still there */
  const questions = after.questions.map((q) => {
    const was = before.questions.find((x) => x.id === q.id);
    if (!was || !holdsData(was)) return q;
    let next = q;
    for (const axis of ["options", "rows", "columns"] as const) {
      const a = (was[axis] ?? []) as Listed[], b = (q[axis] ?? []) as Listed[];
      const fixed = protectList(axis, a, b, q, restored);
      if (fixed !== b) { next = { ...next, [axis]: fixed } as Question; listsChanged = true; }
    }
    return next;
  });

  if (!removed.length && !listsChanged) return { def: after, restored, changed: false };
  const def: SurveyDefinition = { ...after, questions, flow: structuredClone(after.flow) };

  /* deleted questions: back in their page, hidden */
  const usedPageIds = new Set<string>();
  const collect = (nodes: FlowNode[]) => { for (const n of nodes) { usedPageIds.add((n as { id: string }).id); const a = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[] }; if (a.children) collect(a.children); if (a.branches) for (const b of a.branches) collect(b.children); } };
  collect(def.flow);
  for (const q of removed) {
    const hidden: Question = { ...q, settings: { ...q.settings, hidden: true } } as Question;
    const index = before.questions.findIndex((x) => x.id === q.id);
    /* near where it was in the question list (the editor's flow-order pass settles the exact place) */
    let at = def.questions.length;
    for (let i = index - 1; i >= 0; i--) { const j = def.questions.findIndex((x) => x.id === before.questions[i].id); if (j >= 0) { at = j + 1; break; } }
    if (index === 0) at = 0;
    def.questions.splice(at, 0, hidden);

    const home = findPage(before.flow, (p) => p.questionIds.includes(q.id))?.page;
    const target = home ? findPage(def.flow, (p) => p.id === home.id)?.page : null;
    if (home && target) {
      const order = home.questionIds;
      let pos = 0;
      for (let i = order.indexOf(q.id) - 1; i >= 0; i--) { const j = target.questionIds.indexOf(order[i]); if (j >= 0) { pos = j + 1; break; } }
      target.questionIds.splice(pos, 0, q.id);
    } else {
      /* its page was deleted with it: the page comes back (holding only what must be kept), before the survey's end */
      let id = home?.id ?? `kept_${q.id}`;
      const again = findPage(def.flow, (p) => p.id === id)?.page;
      if (again) again.questionIds.push(q.id);
      else {
        if (usedPageIds.has(id)) id = `kept_${q.id}`;
        usedPageIds.add(id);
        const page = { ...(home ? structuredClone(home) : { type: "page" as const }), id, questionIds: [q.id] } as FlowNode;
        const end = def.flow.findIndex((n) => n.type === "end");
        def.flow.splice(end >= 0 ? end : def.flow.length, 0, page);
      }
    }
    restored.push({ kind: "question", questionId: q.id, questionCode: q.code, label: plain(q.text).slice(0, 80) || q.code });
  }
  return { def, restored, changed: true };
}

/** one line saying what was kept, for the notice ("Q3 and option 2 of Q5 …") */
export function describeProtected(items: ProtectedItem[]): string {
  const say = (i: ProtectedItem) =>
    i.kind === "question" ? `question ${i.questionCode}`
    : i.kind === "code" ? `the code ${i.code} of “${i.label}” in ${i.questionCode} (put back)`
    : `${i.kind} “${i.label}” (${i.code}) of ${i.questionCode}`;
  const parts = items.slice(0, 6).map(say);
  if (items.length > 6) parts.push(`${items.length - 6} more`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
