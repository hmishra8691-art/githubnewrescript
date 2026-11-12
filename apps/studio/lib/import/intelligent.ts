import { applyDecisions, advanceIntelligentImport, intelligenceView, type CanonicalSurvey, type ClarificationAnswer, type Decision, type IntelligentImport, type ImportScope } from "@rescript/import";
import type { ImportSession } from "./sessions";

/**
 * THE INTELLIGENT IMPORT ON A STORED SESSION (2026-11-13).
 *
 * The session keeps the survey as the source wrote it and every answer the person gave. Answering a clarification
 * re-runs the whole pipeline (packages/import intelligence/pipeline.ts) from that model with ALL the answers so
 * far, so an answer reaches everything that depends on it and the result is validated and tested again — the file
 * is never uploaded twice and an earlier answer is never lost.
 *
 * Answers are stored in the session's `decisions` list as `{ id, type: "answer", choice?, own? }`, beside the
 * structured decisions of the earlier review flow (which are applied first, as before).
 */
export interface StoredAnswer { id: string; type: "answer"; choice?: number; own?: string }

export const isStoredAnswer = (d: unknown): d is StoredAnswer => !!d && typeof d === "object" && (d as { type?: unknown }).type === "answer" && typeof (d as { id?: unknown }).id === "string";

/** clean what a client sent: known shape, bounded text, one answer per question (the last wins) */
export function coerceAnswers(raw: unknown): ClarificationAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Map<string, ClarificationAnswer>();
  for (const a of raw.slice(0, 500)) {
    if (!a || typeof a !== "object") continue;
    const id = typeof (a as { id?: unknown }).id === "string" ? String((a as { id: string }).id).slice(0, 300) : "";
    if (!id) continue;
    const choice = Number.isInteger((a as { choice?: unknown }).choice) ? Number((a as { choice: number }).choice) : undefined;
    const own = typeof (a as { own?: unknown }).own === "string" ? String((a as { own: string }).own).trim().slice(0, 1000) : "";
    if (choice === undefined && !own) continue;
    out.set(id, { id, ...(own ? { own } : { choice }) });
  }
  return [...out.values()];
}

export interface IntelligentRerun { run: IntelligentImport; decisions: unknown[] }

export function intelligentFromSession(s: ImportSession, newAnswers: ClarificationAnswer[], detection: { format: string; platform: string | null; label: string }): IntelligentRerun | { error: string; status: number } {
  if (!s.canonical) return { error: "This import's reconstructed model was not kept, so it cannot be continued — import the file again.", status: 410 };
  if (s.status !== "analyzed") return { error: `This import is already ${s.status.replace("_", " ")}; answer its questions on a new import.`, status: 409 };
  if (s.into !== "new") return { error: "Answering in place is available when the import creates a new survey.", status: 409 };
  const stored = (s.decisions as unknown[]) ?? [];
  const earlier = stored.filter((d) => !isStoredAnswer(d)) as Decision[];
  const answers = new Map(stored.filter(isStoredAnswer).map((a) => [a.id, { id: a.id, ...(a.own ? { own: a.own } : { choice: a.choice }) } as ClarificationAnswer]));
  for (const a of newAnswers) answers.set(a.id, a);
  /* the structured decisions of the earlier review flow come first, exactly as that flow applied them */
  const base = earlier.length ? applyDecisions(s.canonical as CanonicalSurvey, earlier).canonical : (s.canonical as CanonicalSurvey);
  const run = advanceIntelligentImport({
    version: 1, canonical: base, answers: [...answers.values()], scope: s.scope as ImportScope, surveyId: "import_preview",
    detection: { format: detection.format as never, platform: (detection.platform ?? "unknown") as never, importType: "continued", label: detection.label, confidence: "high", reasons: ["continued from the import session"] } as never,
  });
  /* an answer the pipeline refused is not kept */
  const refused = new Set(run.rejected.map((r) => r.id));
  const keep: StoredAnswer[] = [...answers.values()].filter((a) => !refused.has(a.id)).map((a) => ({ id: a.id, type: "answer", ...(a.own ? { own: a.own } : { choice: a.choice }) }));
  return { run, decisions: [...earlier, ...keep] };
}

export { intelligenceView };
