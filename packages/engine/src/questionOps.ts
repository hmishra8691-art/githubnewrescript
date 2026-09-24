import type { Question, SurveyDefinition } from "@rescript/schema";
import { listPages } from "./blocks.js";
import { pruneReferencesTo, type QuestionReference } from "./references.js";
import { usedNames, copyNames } from "./variableUsage.js";

/**
 * QUESTION OPERATIONS — add, duplicate, remove, move — as engine functions.
 *
 * These were inline closures in the Studio's Questions panel. That was fine
 * while one panel edited questions. It stops being fine the moment a second
 * environment (a grid, a canvas, a command palette, an AI proposal) needs to
 * add a question too, because the second copy of "push the question, splice
 * its id into the page, mint names nothing else uses, re-mint every element
 * id inside it" is the one that forgets a step.
 *
 * So each operation lives here once. They MUTATE THE DEFINITION THEY ARE
 * GIVEN and return what a caller needs to know: the Studio's store hands
 * every edit a fresh structured clone and takes it back, so an in-place
 * mutator is what fits — a function that returned a new definition would be
 * cloned twice per keystroke. Outside the store, clone first.
 *
 * Ids come from the caller. The Studio has an id generator whose shape its
 * browser tests recognise; the engine must not invent a second one, so every
 * operation that mints an id takes the generator as a parameter.
 */

export type IdMinter = (prefix: string) => string;

let seq = 0;
/** The same shape as the Studio's `uid`, for callers that have no generator of their own. */
export const defaultIds: IdMinter = (prefix) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/* ------------------------------------------------------------ helpers */

type PageNode = { id: string; questionIds: string[] };

function pageOf(def: SurveyDefinition, questionId: string): { node: PageNode; index: number } | null {
  const all = listPages(def.flow as unknown[]);
  const pi = all.findIndex((p) => (p.node as PageNode).questionIds.includes(questionId));
  if (pi < 0) return null;
  const node = all[pi].node as PageNode;
  return { node, index: node.questionIds.indexOf(questionId) };
}

/**
 * A COPY IS A NEW QUESTION, AND EVERY ID INSIDE IT IS NEW TOO.
 *
 * Duplicating used to re-mint the question's own id and then deep-clone
 * everything under it, so the copy's options, rows, columns, punches, skip
 * rules and option groups carried the ORIGINAL's element ids. Two questions
 * then claimed the same option id — the identity the element registry, the
 * live canvas, per-element analytics and option-level logic all key on.
 * Codes and labels are meant to be shared by a copy; ids are exactly the
 * thing that must not be.
 */
export function reidentifyQuestion(copy: Record<string, unknown>, ids: IdMinter = defaultIds): void {
  const mint = (el: unknown, prefix: string) => {
    if (el && typeof el === "object" && typeof (el as { id?: unknown }).id === "string") {
      (el as { id: string }).id = ids(prefix);
    }
  };
  for (const [axis, prefix] of [["options", "opt"], ["rows", "row"], ["columns", "col"]] as const) {
    for (const el of ((copy[axis] as unknown[]) ?? [])) {
      mint(el, prefix);
      /* a cell grid's column carries its own option list */
      for (const o of (((el as { options?: unknown[] })?.options) ?? [])) mint(o, "opt");
    }
  }
  for (const key of ["punches", "skipLogic", "optionGroups", "validation", "listLogic", "optionPipeline"]) {
    for (const el of ((copy[key] as unknown[]) ?? [])) mint(el, "r");
  }
}

/**
 * A deep copy of `q` with a fresh id, a code and variable name nothing in
 * `taken` uses (which it then adds to `taken`, so a caller copying several
 * questions in one go shares one set), and fresh element ids throughout.
 * Does NOT add it to the definition — `duplicateQuestion` does.
 */
export function cloneQuestion(q: Question, taken: Set<string>, ids: IdMinter = defaultIds): Question {
  const copy = structuredClone(q);
  copy.id = ids("q");
  /*
   * The suffix is chosen against the whole survey, not appended blindly.
   * `${code}_COPY` unconditionally meant duplicating the same question twice
   * produced two questions sharing a code and a variable name — a blocking
   * problem at the publish gate, which surfaced as "changes could not be
   * saved" rather than as anything to do with duplication.
   */
  const named = copyNames(taken, q);
  copy.code = named.code;
  copy.variableName = named.variableName;
  reidentifyQuestion(copy as unknown as Record<string, unknown>, ids);
  return copy;
}

/* ------------------------------------------------------------ operations */

/**
 * Add an already-built question to the survey and place it on a page.
 *
 * `at.pageId` + `at.index` puts it at that position; a missing or unknown
 * page appends to the LAST page — the Questions panel's rule, kept because
 * a question that exists but sits on no page is invisible to respondents
 * and easy to lose. Returns the page it landed on, or null when the survey
 * has no pages at all (the question is still added, unplaced).
 */
export function addQuestion(
  def: SurveyDefinition,
  q: Question,
  at: { pageId?: string; index?: number } = {},
): { pageId: string | null; index: number } {
  def.questions.push(q);
  const pages = listPages(def.flow as unknown[]);
  const target = (at.pageId && pages.find((p) => (p.node as PageNode).id === at.pageId)) || pages[pages.length - 1];
  if (!target) return { pageId: null, index: -1 };
  const node = target.node as PageNode;
  const index = at.pageId && target.node.id === at.pageId && at.index !== undefined
    ? Math.max(0, Math.min(at.index, node.questionIds.length))
    : node.questionIds.length;
  node.questionIds.splice(index, 0, q.id);
  return { pageId: node.id, index };
}

/**
 * Duplicate one question in place: the copy goes directly after the original
 * on the same page. Returns the copy, or null when `id` is not a question.
 */
export function duplicateQuestion(def: SurveyDefinition, id: string, ids: IdMinter = defaultIds): Question | null {
  const q = def.questions.find((x) => x.id === id);
  if (!q) return null;
  const copy = cloneQuestion(q, usedNames(def), ids);
  def.questions.push(copy);
  const where = pageOf(def, id);
  if (where) where.node.questionIds.splice(where.index + 1, 0, copy.id);
  return copy;
}

/**
 * Remove a question AND everything that named it, in one step.
 *
 * `pruneReferencesTo` is the same function the delete dialog previews with,
 * so what the programmer was shown is what happens. Returns that list, so a
 * caller can label the undo entry or a toast with it. Removing an unknown id
 * is a no-op that returns [].
 */
export function removeQuestion(def: SurveyDefinition, id: string): QuestionReference[] {
  if (!def.questions.some((q) => q.id === id)) return [];
  const refs = pruneReferencesTo(def, id);
  def.questions = def.questions.filter((q) => q.id !== id);
  for (const p of listPages(def.flow as unknown[])) {
    const node = p.node as PageNode;
    node.questionIds = node.questionIds.filter((x) => x !== id);
  }
  return refs;
}

/**
 * Move a question one step within its page; at the page's edge it crosses
 * into the adjacent page (to its end when moving up, its start when moving
 * down). Returns false when there is nowhere to go.
 */
export function moveQuestionBy(def: SurveyDefinition, id: string, dir: -1 | 1): boolean {
  const all = listPages(def.flow as unknown[]);
  const pi = all.findIndex((p) => (p.node as PageNode).questionIds.includes(id));
  if (pi < 0) return false;
  const ids = (all[pi].node as PageNode).questionIds;
  const k = ids.indexOf(id);
  const t = k + dir;
  if (t >= 0 && t < ids.length) {
    [ids[k], ids[t]] = [ids[t], ids[k]];
    return true;
  }
  const adj = all[pi + dir];
  if (!adj) return false;
  ids.splice(k, 1);
  const adjIds = (adj.node as PageNode).questionIds;
  if (dir === -1) adjIds.push(id); else adjIds.unshift(id);
  return true;
}

/**
 * Move a question to an exact position on a page. `index` is clamped; the
 * question is removed from wherever it was first. Returns false when the
 * question or the page does not exist.
 */
export function moveQuestionTo(def: SurveyDefinition, id: string, pageId: string, index: number): boolean {
  if (!def.questions.some((q) => q.id === id)) return false;
  const pages = listPages(def.flow as unknown[]);
  const target = pages.find((p) => (p.node as PageNode).id === pageId);
  if (!target) return false;
  for (const p of pages) {
    const node = p.node as PageNode;
    node.questionIds = node.questionIds.filter((x) => x !== id);
  }
  const node = target.node as PageNode;
  node.questionIds.splice(Math.max(0, Math.min(index, node.questionIds.length)), 0, id);
  return true;
}
