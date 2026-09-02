import type { SurveyDefinition } from "@rescript/schema";

/**
 * How many questions a survey actually asks.
 *
 * Used by the Survey Project Dashboard, and mirrored in SQL by
 * `rescript_question_count` (supabase/migrations/0002) so the database can
 * count without shipping definitions to the app. The two must agree, so the
 * rule lives here in prose as well as in code:
 *
 *   • Page breaks and every other flow construct are NOT questions. They live
 *     in `definition.flow`, never in `definition.questions`, so they are
 *     excluded structurally rather than by name.
 *   • Display-only and derived elements are not questions: `html` blocks,
 *     `hidden` variables, `calculated` variables and `embedded_data` captures.
 *     A respondent is never asked them.
 *   • A question that sits on no page can never be shown, so it does not
 *     count — unless the survey has no pages at all yet, in which case the
 *     programmer is mid-build and the honest answer is what they have written.
 *   • Questions are counted across ALL pages, at any nesting depth: inside
 *     blocks, sections, loops, randomisers and branch arms.
 */
const NON_QUESTION_TYPES = new Set(["html", "hidden", "calculated", "embedded_data"]);

/** Ids of every question placed on a page, at any depth of the flow tree. */
export function placedQuestionIds(def: Pick<SurveyDefinition, "flow">): Set<string> {
  const placed = new Set<string>();
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes as Record<string, unknown>[]) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "page" && Array.isArray(n.questionIds)) {
        for (const id of n.questionIds as unknown[]) placed.add(String(id));
      }
      if (Array.isArray(n.children)) walk(n.children);
      if (Array.isArray(n.otherwise)) walk(n.otherwise);
      if (Array.isArray(n.branches)) {
        for (const b of n.branches as Record<string, unknown>[]) walk(b?.children);
      }
    }
  };
  walk((def as { flow?: unknown }).flow);
  return placed;
}

export function countRespondentQuestions(def: unknown): number {
  const d = def as { questions?: { id?: string; type?: string }[] };
  const questions = Array.isArray(d?.questions) ? d.questions : [];
  if (questions.length === 0) return 0;
  const placed = placedQuestionIds(def as SurveyDefinition);
  return questions.filter(
    (q) =>
      !NON_QUESTION_TYPES.has(String(q?.type)) &&
      (placed.size === 0 || placed.has(String(q?.id))),
  ).length;
}

/** Per-page counts, for a breakdown like "Page 1 → 10, Page 2 → 8". */
export function questionsPerPage(def: unknown): { pageId: string; title?: string; count: number }[] {
  const d = def as { questions?: { id?: string; type?: string }[]; flow?: unknown };
  const byId = new Map((d?.questions ?? []).map((q) => [String(q.id), q]));
  const out: { pageId: string; title?: string; count: number }[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes as Record<string, unknown>[]) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "page" && Array.isArray(n.questionIds)) {
        const count = (n.questionIds as unknown[]).filter((id) => {
          const q = byId.get(String(id));
          return q && !NON_QUESTION_TYPES.has(String(q.type));
        }).length;
        out.push({ pageId: String(n.id), title: n.title as string | undefined, count });
      }
      if (Array.isArray(n.children)) walk(n.children);
      if (Array.isArray(n.otherwise)) walk(n.otherwise);
      if (Array.isArray(n.branches)) {
        for (const b of n.branches as Record<string, unknown>[]) walk(b?.children);
      }
    }
  };
  walk(d?.flow);
  return out;
}
