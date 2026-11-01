import type { SurveyDefinition, Question, FlowNode } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import type { QuotaCounts } from "./quotas.js";
import { compileFlow, visibleQuestions, visitedPages, seenPages, type RuntimeStep } from "./flow.js";
import { lookupAnswer } from "./state.js";
import { isEmptyAnswer } from "./answers.js";
import { htmlToPlain } from "./piping.js";

/**
 * S5a item 5 — REVIEW YOUR ANSWERS (audit AQ-12): a flow page with `review` set lists what the respondent has
 * answered so far, grouped by section (the page's outermost block / section), each with a "Change" link that jumps
 * back to the page through section navigation's `goToPage` (Back's semantics — VISITED pages only) and a "Return to
 * review" that comes forward again through the same rule (validated, as Next would).
 *
 *   reviewConfig(def, pageId)           the page's review settings, or null
 *   reviewSummary(def, state, pageId)   the groups: only pages on the visited trail (or seen) BEFORE the review page,
 *                                       only questions visible with the current answers, never hidden / calculated /
 *                                       content questions or ones the author excluded; open-end text cut at
 *                                       `textLimit` characters (default 200) with "…"
 *   formatReviewAnswer(q, value, limit) one answer as text: option labels (not codes), grid rows, numbers, files
 */
export interface ReviewItem { questionId: string; code: string; text: string; answer: string; pageId: string; truncated: boolean }
export interface ReviewGroup { id: string; title: string; items: ReviewItem[] }
export interface ReviewConfig { title: string; textLimit: number; exclude: Set<string> }

type PageStep = Extract<RuntimeStep, { kind: "page" }>;
const NOT_REVIEWED = new Set(["html", "hidden", "calculated", "embedded_data", "experiment", "descriptive", "content"]);
export const REVIEW_TEXT_LIMIT = 200;

function findPage(nodes: FlowNode[], id: string): Extract<FlowNode, { type: "page" }> | null {
  for (const n of nodes) {
    if (n.type === "page" && n.id === id) return n;
    const kids = (n as { children?: FlowNode[] }).children;
    if (Array.isArray(kids)) { const f = findPage(kids, id); if (f) return f; }
    if (n.type === "branch") { for (const b of n.branches) { const f = findPage(b.children, id); if (f) return f; } if (n.otherwise) { const f = findPage(n.otherwise, id); if (f) return f; } }
  }
  return null;
}

export function reviewConfig(def: SurveyDefinition, pageId: string): ReviewConfig | null {
  const page = findPage(def.flow, pageId.split("@")[0]);
  const r = (page as { review?: { enabled?: boolean; title?: string; textLimit?: number; excludeQuestionIds?: string[] } } | null)?.review;
  if (!r || r.enabled === false) return null;
  return { title: r.title?.trim() || "Review your answers", textLimit: Math.max(20, Math.min(2000, r.textLimit ?? REVIEW_TEXT_LIMIT)), exclude: new Set(r.excludeQuestionIds ?? []) };
}

/** every review page in the survey (Studio / lint) */
export function reviewPages(def: SurveyDefinition): string[] {
  const out: string[] = [];
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "page" && (n as { review?: { enabled?: boolean } }).review && (n as { review?: { enabled?: boolean } }).review!.enabled !== false) out.push(n.id);
      const kids = (n as { children?: FlowNode[] }).children;
      if (Array.isArray(kids)) walk(kids);
      if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(def.flow);
  return out;
}

const cut = (s: string, n: number) => (s.length > n ? { text: `${s.slice(0, n).trimEnd()}…`, truncated: true } : { text: s, truncated: false });

export function formatReviewAnswer(q: Question, value: unknown, limit = REVIEW_TEXT_LIMIT): { text: string; truncated: boolean } {
  const label = (code: unknown) => {
    const o = (q.options ?? []).find((x) => String(x.code) === String(code));
    return o ? htmlToPlain(o.label) : String(code);
  };
  if (value == null || value === "") return { text: "—", truncated: false };
  if (Array.isArray(value)) {
    if (value.every((v) => v && typeof v === "object" && "url" in (v as object))) return cut(value.map((f) => String((f as { name?: string }).name ?? "file")).join(", "), limit);
    return cut(value.map(label).join(", "), limit);
  }
  if (typeof value === "object") {
    const rows = q.rows ?? [];
    const parts = Object.entries(value as Record<string, unknown>).filter(([, v]) => !isEmptyAnswer(v)).map(([k, v]) => {
      const r = rows.find((x) => String(x.code) === k);
      const rv = Array.isArray(v) ? v.map(label).join(", ") : typeof v === "object" ? JSON.stringify(v) : label(v);
      return `${r ? htmlToPlain(r.label) : k}: ${rv}`;
    });
    return cut(parts.join("; "), limit);
  }
  if (typeof value === "number" || typeof value === "boolean") return { text: (q.options ?? []).length ? label(value) : String(value), truncated: false };
  return cut((q.options ?? []).length ? label(value) : String(value), limit);
}

export function reviewSummary(def: SurveyDefinition, state: ResponseState, reviewPageId: string, quotaCounts: QuotaCounts = {}): ReviewGroup[] {
  const cfg = reviewConfig(def, reviewPageId) ?? { title: "", textLimit: REVIEW_TEXT_LIMIT, exclude: new Set<string>() };
  const steps = compileFlow(def, state, quotaCounts);
  const reviewIdx = steps.findIndex((s) => s.kind === "page" && s.pageId === reviewPageId);
  const trail = new Set([...visitedPages(state), ...seenPages(state)]);
  const containers = new Map<string, string>();
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "block" || n.type === "section") containers.set(n.id, n.title ?? n.id);
      const kids = (n as { children?: FlowNode[] }).children;
      if (Array.isArray(kids)) walk(kids);
      if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(def.flow);
  const groups: ReviewGroup[] = [];
  steps.forEach((s, i) => {
    if (s.kind !== "page" || (reviewIdx >= 0 && i >= reviewIdx) || s.pageId === reviewPageId) return;
    if (!trail.has(s.pageId)) return;
    const step = s as PageStep;
    const secId = step.nodePath.find((id) => containers.has(id)) ?? "_";
    const items: ReviewItem[] = [];
    for (const q of visibleQuestions(def, step, state, quotaCounts)) {
      if (NOT_REVIEWED.has(q.type) || q.settings.hidden || cfg.exclude.has(q.id) || cfg.exclude.has(q.code)) continue;
      const v = lookupAnswer(state.answers, q.id, step.loop ?? null);
      const f = formatReviewAnswer(q, v, cfg.textLimit);
      items.push({ questionId: q.id, code: q.code, text: htmlToPlain(q.text).slice(0, 300), answer: isEmptyAnswer(v) ? "Not answered" : f.text, pageId: step.pageId, truncated: f.truncated });
    }
    if (!items.length) return;
    const g = groups.find((x) => x.id === secId);
    if (g) g.items.push(...items);
    else groups.push({ id: secId, title: secId === "_" ? "Your answers" : containers.get(secId)!, items });
  });
  return groups;
}

export function lintReviewPages(def: SurveyDefinition): string[] {
  const out: string[] = [];
  for (const id of reviewPages(def)) {
    const page = findPage(def.flow, id)!;
    if (!page.questionIds.length) out.push(`review page ${id} has no question — give it a text block ("Please check your answers") so it is shown`);
  }
  return out;
}
