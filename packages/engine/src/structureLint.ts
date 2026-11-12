/**
 * PAGE STRUCTURE, CHECKED AND REPAIRED (2026-11-12).
 *
 * A survey can be logically right and still be laid out wrongly: a consent question sharing its page with the
 * screener, a choice exercise on the same page as its follow-ups, two concepts of a sequential test on one screen,
 * a funnel stage beside the stage that feeds it. These are rules of the METHOD, not of taste, so they are written
 * once here and used by the quality check (every survey), the action gate (everything Intelligent Mode builds) and
 * the templates' tests.
 *
 *   lintPageStructure(def)   every finding, each marked "auto" (one right repair, which keeps every id, variable,
 *                        answer and rule — only pages are divided, or a setting that must not be there is removed)
 *                        or "ask" (a judgement: the author decides)
 *   fixPageStructure(def)    applies the "auto" repairs; returns what it did and what is left to ask
 *
 * It never forces one question per page: an ordinary page of related questions is left alone. Splitting a page
 * copies its title, display condition and name setting to each part; the first part keeps the page's id (so a skip
 * rule that jumps "to this page" still lands at its start) and its timer.
 */
import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { isConsentQuestion } from "./consent.js";

export type StructureCode =
  | "task_shares_page" | "consent_shares_page" | "consent_automated" | "price_questions_share_page"
  | "stimuli_share_page" | "funnel_shares_page" | "long_page" | "stacked_tasks";

export interface StructureIssue {
  code: StructureCode;
  fix: "auto" | "ask";
  pageId?: string;
  questionIds: string[];
  message: string;
}

type Page = Extract<FlowNode, { type: "page" }>;
const TASK_TYPES = new Set(["conjoint_task", "maxdiff_task", "acbc_task"]);
const SILENT = new Set(["html", "hidden", "calculated", "embedded_data"]);
const PSM = /(^|_)PSM_(TOO_CHEAP|CHEAP|EXPENSIVE|TOO_EXPENSIVE)$/i;
const LONG_PAGE = 8;
const STACKED_TASKS = 4;

const answerable = (q: Question | undefined): q is Question => !!q && !SILENT.has(q.type) && !q.settings?.hidden;
const label = (q: Question) => q.code || q.variableName || q.id;

interface Located { page: Page; siblings: FlowNode[]; parent: FlowNode | null }

function pagesOf(flow: FlowNode[]): Located[] {
  const out: Located[] = [];
  const walk = (nodes: FlowNode[], parent: FlowNode | null) => {
    for (const n of nodes ?? []) {
      if (n.type === "page") out.push({ page: n as Page, siblings: nodes, parent });
      const kids = (n as { children?: FlowNode[] }).children;
      if (Array.isArray(kids)) walk(kids, n);
      for (const b of (n as { branches?: { children?: FlowNode[] }[] }).branches ?? []) if (Array.isArray(b.children)) walk(b.children, n);
      const other = (n as { otherwise?: FlowNode[] }).otherwise;
      if (Array.isArray(other)) walk(other, n);
    }
  };
  walk(flow, null);
  return out;
}

/** how many tasks a design-driven question shows one respondent (one version) */
function taskCount(def: SurveyDefinition, q: Question): number {
  const d = (def.designs ?? []).find((x) => x.id === (q.settings as { designRef?: string }).designRef);
  const rows = (d?.file?.rows ?? []) as Record<string, unknown>[];
  if (!rows.length) return 0;
  const v = rows[0].version;
  return new Set(rows.filter((r) => r.version === v).map((r) => String(r.task))).size;
}

/**
 * Where a page should be divided: the indexes (into questionIds) at which a new page starts, with the finding that
 * asks for each. Empty = the page is fine as it is.
 */
type Cut = StructureIssue & { cuts: number[] };
function cutsFor(def: SurveyDefinition, page: Page, byId: Map<string, Question>): Cut[] {
  const ids = page.questionIds;
  const qs = ids.map((id) => byId.get(id));
  const shown = qs.filter(answerable);
  const issues: Cut[] = [];
  /* a question's group starts at the text shown directly above it (its introduction or stimulus) */
  const groupStart = (i: number) => { let s = i; while (s > 0 && qs[s - 1]?.type === "html") s--; return s; };
  const isolate = (i: number): number[] => [groupStart(i), i + 1].filter((c) => c > 0 && c < ids.length);

  qs.forEach((q, i) => {
    if (!answerable(q)) return;
    const others = shown.filter((x) => x.id !== q.id);
    if (TASK_TYPES.has(q.type) && others.length) {
      issues.push({ cuts: isolate(i), code: "task_shares_page", fix: "auto", pageId: page.id, questionIds: [q.id], message: `${label(q)} is a choice exercise and shares its page with ${others.map(label).join(", ")} — an exercise has a page of its own.` });
    } else if (isConsentQuestion(q) && others.length) {
      issues.push({ cuts: isolate(i), code: "consent_shares_page", fix: "auto", pageId: page.id, questionIds: [q.id], message: `${label(q)} asks for consent and shares its page with ${others.map(label).join(", ")} — consent is given on a page of its own, before anything else is asked.` });
    }
  });

  /* Van Westendorp: four separate judgements, one page each */
  const psm = qs.map((q, i) => (q && PSM.test(String(q.variableName ?? q.code ?? "")) ? i : -1)).filter((i) => i >= 0);
  if (psm.length >= 2) {
    issues.push({ cuts: psm.flatMap(isolate), code: "price_questions_share_page", fix: "auto", pageId: page.id, questionIds: psm.map((i) => ids[i]), message: `The price-sensitivity questions (${psm.map((i) => label(qs[i]!)).join(", ")}) share a page — each price judgement is asked on its own page.` });
  }

  /* two stimuli, each followed by its own questions: two concepts on one screen */
  const stimuli: number[] = [];
  qs.forEach((q, i) => {
    if (q?.type !== "html" || (i > 0 && qs[i - 1]?.type === "html")) return;
    let e = i; while (qs[e + 1]?.type === "html") e++;
    if (answerable(qs[e + 1])) stimuli.push(i);
  });
  if (stimuli.length >= 2) {
    /* clear when the texts ARE stimuli (media, or named as a concept / ad / stimulus); two plain notes above two questions is the author's call */
    const isStimulus = (i: number) => /<(img|video|audio|iframe)\b/i.test(String(qs[i]?.text ?? "")) || /(SHOW|CONCEPT|STIM|_AD\b|^AD_)/i.test(String(qs[i]?.code ?? ""));
    issues.push({ cuts: stimuli.slice(1), code: "stimuli_share_page", fix: stimuli.every(isStimulus) ? "auto" : "ask", pageId: page.id, questionIds: stimuli.map((i) => ids[i]), message: `This page shows ${stimuli.length} stimuli, each with its own questions — each stimulus and its questions get a page, so one is judged before the next is seen.` });
  }

  /* a list built from an answer on this same page: the stage that feeds it comes first, on the page before */
  qs.forEach((q, i) => {
    if (!q) return;
    const src = (q.carryForward as { sourceQuestionId?: string } | undefined)?.sourceQuestionId;
    const at = src ? ids.indexOf(src) : -1;
    if (at >= 0 && at < i) {
      issues.push({ cuts: [groupStart(i)].filter((c) => c > 0), code: "funnel_shares_page", fix: "auto", pageId: page.id, questionIds: [q.id], message: `${label(q)} builds its list from ${label(qs[at]!)} on the same page — it moves to the next page, so the list is complete before it is shown.` });
    }
  });

  return issues;
}

export function lintPageStructure(def: SurveyDefinition): StructureIssue[] {
  const byId = new Map((def.questions ?? []).map((q) => [q.id, q]));
  const out: StructureIssue[] = [];
  for (const { page, parent } of pagesOf(def.flow as FlowNode[])) {
    const issues = cutsFor(def, page, byId);
    /* the parts of a page directly inside a randomizer would be shuffled apart: that repair is the author's (wrap them in a block) */
    const inRandomizer = parent?.type === "randomizer";
    for (const { cuts, ...i } of issues) out.push(inRandomizer && cuts.length && i.fix === "auto" ? { ...i, fix: "ask", message: `${i.message} (The page sits directly in a randomizer: put its parts in a block so they stay together.)` } : i);
    const shown = page.questionIds.map((id) => byId.get(id)).filter(answerable);
    const always = shown.filter((q) => !q.displayLogic);
    if (always.length > LONG_PAGE && !issues.length) {
      out.push({ code: "long_page", fix: "ask", pageId: page.id, questionIds: always.map((q) => q.id), message: `The page “${page.title || page.id}” asks ${always.length} questions at once (${always.slice(0, 4).map(label).join(", ")}…) — consider dividing it by topic.` });
    }
  }
  for (const q of def.questions ?? []) {
    if (isConsentQuestion(q) && q.type !== "hidden" && !q.settings?.hidden) {
      const st = (q.settings ?? {}) as { defaultValue?: unknown; autoNext?: boolean; singleOption?: string };
      const what = [q.punches?.length ? "auto-punch rules" : "", st.defaultValue !== undefined && st.defaultValue !== null && st.defaultValue !== "" ? "a default answer" : "", st.autoNext === true ? "auto-next" : ""].filter(Boolean);
      if (what.length) out.push({ code: "consent_automated", fix: "auto", questionIds: [q.id], message: `${label(q)} asks for consent but has ${what.join(" and ")} — consent is never selected or left automatically, so ${what.length === 1 ? "it is" : "they are"} removed.` });
    }
    if ((q.type === "conjoint_task" || q.type === "maxdiff_task") && (q.settings as { taskPaging?: string }).taskPaging === "all") {
      const n = taskCount(def, q);
      if (n > STACKED_TASKS) out.push({ code: "stacked_tasks", fix: "ask", questionIds: [q.id], message: `${label(q)} shows all ${n} tasks stacked on one page (taskPaging "all") — one task at a time is easier to answer, above all on a phone.` });
    }
  }
  return out;
}

export interface StructureFixResult { def: SurveyDefinition; applied: StructureIssue[]; ask: StructureIssue[] }

/** apply the "auto" repairs (optionally only those `only` accepts); the input is not modified */
export function fixPageStructure(input: SurveyDefinition, only?: (i: StructureIssue) => boolean): StructureFixResult {
  const def = structuredClone(input) as SurveyDefinition;
  const byId = new Map((def.questions ?? []).map((q) => [q.id, q]));
  const taken = new Set<string>();
  const collect = (nodes: FlowNode[]) => { for (const n of nodes ?? []) { taken.add(n.id); const k = (n as { children?: FlowNode[] }).children; if (k) collect(k); for (const b of (n as { branches?: { children?: FlowNode[] }[] }).branches ?? []) if (b.children) collect(b.children); const o = (n as { otherwise?: FlowNode[] }).otherwise; if (o) collect(o); } };
  collect(def.flow as FlowNode[]);
  const mint = (base: string) => { for (let n = 2; ; n++) { const id = `${base}_${n}`; if (!taken.has(id)) { taken.add(id); return id; } } };
  const applied: StructureIssue[] = [];
  const ask: StructureIssue[] = [];

  for (const { page, siblings, parent } of pagesOf(def.flow as FlowNode[])) {
    if (parent?.type === "randomizer") continue;
    const wanted = cutsFor(def, page, byId).filter((i) => i.fix === "auto" && i.cuts.length && (!only || only(i)));
    if (!wanted.length) continue;
    const marks = [0, ...[...new Set(wanted.flatMap((i) => i.cuts))].sort((a, b) => a - b), page.questionIds.length];
    const parts: Page[] = [];
    for (let k = 0; k + 1 < marks.length; k++) {
      const ids = page.questionIds.slice(marks[k], marks[k + 1]);
      if (!ids.length) continue;
      const { timer, review, ...rest } = page as Page & { timer?: unknown; review?: unknown };
      parts.push(parts.length === 0 ? ({ ...page, questionIds: ids } as Page) : ({ ...rest, id: mint(page.id), questionIds: ids } as Page));
      void timer; void review;
    }
    siblings.splice(siblings.indexOf(page), 1, ...parts);
    applied.push(...wanted.map(({ cuts, ...i }) => { void cuts; return i; }));
  }

  for (const i of lintPageStructure(def)) {
    if (i.code === "consent_automated" && (!only || only(i))) {
      const q = byId.get(i.questionIds[0]);
      if (q) {
        delete (q as { punches?: unknown }).punches;
        const st = q.settings as Record<string, unknown>;
        delete st.defaultValue; delete st.autoNext;
        applied.push(i);
      }
    } else if (i.fix === "ask" && !ask.some((a) => a.code === i.code && a.pageId === i.pageId && a.questionIds.join() === i.questionIds.join())) ask.push(i);
  }
  return { def, applied, ask };
}
