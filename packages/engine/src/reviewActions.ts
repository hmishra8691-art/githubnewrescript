import type { SurveyDefinition, FlowNode } from "@rescript/schema";
import { Question } from "@rescript/schema";
import { reviewPages } from "./reviewPage.js";

/**
 * set_review_page — REVIEW YOUR ANSWERS (S5a item 5; audit AQ-12).
 *
 *   page        an existing page (its id, or a question on it) becomes the review page
 *   add         true: a NEW page at the end of the last block (before the end) holding a short text question, made the
 *               review page — the usual "check your answers before you submit"
 *   title       the heading (default "Review your answers")
 *   textLimit   open-end text is cut at this many characters (20–2000, default 200)
 *   exclude     question codes / ids never listed (hidden questions never are)
 *   clear       the page stops being a review page (the page and its questions stay)
 */
export type ReviewAction = { op: "set_review_page"; page?: string; add?: boolean; title?: string; textLimit?: number; exclude?: string[]; clear?: boolean };
export const REVIEW_ACTION_OPS = ["set_review_page"] as const;

export function coerceReviewAction(o: Record<string, unknown>): ReviewAction | string {
  const page = typeof o.page === "string" && o.page.trim() ? o.page.trim().slice(0, 120) : typeof o.target === "string" && o.target.trim() ? o.target.trim().slice(0, 120) : undefined;
  const add = o.add === true || o.create === true;
  if (!page && !add) return "set_review_page needs page (a page id or a question on it) or add: true";
  const a: ReviewAction = { op: "set_review_page", ...(page ? { page } : {}), ...(add ? { add } : {}) };
  if (typeof o.title === "string" && o.title.trim()) a.title = o.title.trim().slice(0, 200);
  if (o.textLimit !== undefined) { const n = Number(o.textLimit); if (!Number.isFinite(n) || n < 20 || n > 2000) return "set_review_page textLimit must be 20–2000"; a.textLimit = Math.round(n); }
  if (Array.isArray(o.exclude)) a.exclude = o.exclude.map(String).slice(0, 500);
  if (o.clear === true) a.clear = true;
  return a;
}

type PageNode = Extract<FlowNode, { type: "page" }>;
class ReviewError extends Error {}
const fail = (m: string): never => { throw new ReviewError(m); };

function allPages(nodes: FlowNode[], out: PageNode[] = []): PageNode[] {
  for (const n of nodes) {
    if (n.type === "page") out.push(n);
    const kids = (n as { children?: FlowNode[] }).children;
    if (Array.isArray(kids)) allPages(kids, out);
    if (n.type === "branch") { for (const b of n.branches) allPages(b.children, out); if (n.otherwise) allPages(n.otherwise, out); }
  }
  return out;
}

export interface ReviewEnv { question(ref: string): Question | undefined; ids(prefix: string): string; newQuestion?(text: string): Question }

export function applyReviewAction(def: SurveyDefinition, a: ReviewAction, env: ReviewEnv): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  const pages = allPages(def.flow);
  let page: PageNode | undefined;
  if (a.add) {
    const blocks = def.flow.filter((n) => n.type === "block" || n.type === "section") as (FlowNode & { children: FlowNode[] })[];
    const host = blocks[blocks.length - 1] ?? fail("add a block first — the review page goes at the end of the last block");
    const qid = env.ids("q");
    const code = `REVIEW${reviewPages(def).length ? reviewPages(def).length + 1 : ""}`;
    if (def.questions.some((q) => q.code === code)) fail(`a question ${code} exists already — name the page to use with page`);
    def.questions.push(Question.parse({ id: qid, code, variableName: code, type: "html", text: "Please check your answers. Use “Change” to correct one, then come back here." }));
    page = { type: "page", id: env.ids("p"), title: a.title ?? "Review your answers", questionIds: [qid] } as PageNode;
    host.children.push(page);
  } else {
    const ref = a.page!;
    page = pages.find((p) => p.id === ref);
    if (!page) { const q = env.question(ref); if (q) page = pages.find((p) => p.questionIds.includes(q.id)); }
    if (!page) fail(`there is no page “${ref}” (pages: ${pages.slice(0, 10).map((p) => p.id).join(", ")})`);
  }
  const pg = page as PageNode & { review?: { enabled?: boolean; title?: string; textLimit?: number; excludeQuestionIds?: string[] } };
  if (a.clear) {
    if (!pg.review) fail(`page ${pg.id} is not a review page`);
    delete pg.review;
    return { description: `page ${pg.id} is no longer a review page`, warnings: [], touched: [] };
  }
  const exclude = a.exclude?.map((r) => env.question(r)?.id ?? fail(`exclude: there is no question “${r}”`));
  pg.review = { enabled: true, ...(pg.review ?? {}), ...(a.title ? { title: a.title } : {}), ...(a.textLimit ? { textLimit: a.textLimit } : {}), ...(exclude ? { excludeQuestionIds: exclude } : {}) };
  const warnings = pg.questionIds.length ? [] : [`page ${pg.id} has no question — it is only shown with at least a text block on it`];
  return { description: `${a.add ? "new page" : "page"} ${pg.id} reviews the answers so far${a.textLimit ? ` (text cut at ${a.textLimit})` : ""}`, warnings, touched: pg.questionIds };
}

export function describeReviewAction(a: ReviewAction): string {
  if (a.clear) return `Stop page ${a.page} reviewing answers`;
  return a.add ? "Add a review-your-answers page" : `Make ${a.page} the review-your-answers page`;
}
