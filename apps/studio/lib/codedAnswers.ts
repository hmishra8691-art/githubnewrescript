import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyDefinition } from "@rescript/schema";
import { codedVariables, type CodedSegment, type CodedVariables, type QualCodebook, type QualExcerpt } from "@rescript/analytics";

/**
 * Q7 — CODED ANSWERS ON THE DATASET: the qualitative workspace's coding of open-ended answers (typed, voice and
 * recorded-video transcripts added as an "open-ended answers" source) read into variables for tables
 * (packages/analytics codedVariables.ts). The stamp is what the dataset cache keys on, so a new code or a new coded
 * source changes the columns on the next read. A database without the qualitative tables (migration 0065) simply
 * has no coded columns.
 */
export interface CodingStamp { version: number; sources: string[] }

export async function codingStamp(db: SupabaseClient, surveyId: string): Promise<CodingStamp | null> {
  try {
    const [c, t] = await Promise.all([
      db.from("qual_codings").select("version").eq("survey_id", surveyId).maybeSingle(),
      db.from("qual_transcripts").select("id").eq("survey_id", surveyId).eq("source", "open_ends"),
    ]);
    if (c.error || t.error || !c.data || !(t.data ?? []).length) return null;
    return { version: Number((c.data as { version: number }).version) || 0, sources: ((t.data ?? []) as { id: string }[]).map((r) => r.id).sort() };
  } catch { return null; }
}

export async function loadCodedVariables(db: SupabaseClient, surveyId: string, def: SurveyDefinition): Promise<CodedVariables | null> {
  try {
    const [c, t] = await Promise.all([
      db.from("qual_codings").select("codebook, excerpts").eq("survey_id", surveyId).maybeSingle(),
      db.from("qual_transcripts").select("id, segments").eq("survey_id", surveyId).eq("source", "open_ends").limit(50),
    ]);
    if (c.error || t.error || !c.data) return null;
    const segments: CodedSegment[] = [];
    for (const row of (t.data ?? []) as { id: string; segments: unknown }[]) {
      for (const s of Array.isArray(row.segments) ? (row.segments as { id?: string; responseId?: string; questionId?: string }[]) : []) {
        if (s && s.id && s.responseId && s.questionId) segments.push({ segmentId: String(s.id), responseId: String(s.responseId), questionId: String(s.questionId) });
      }
    }
    const coding = c.data as { codebook: QualCodebook; excerpts: QualExcerpt[] };
    return codedVariables(def, { codebook: coding.codebook ?? { version: 0, method: "inductive", codes: [], themes: [], relationships: [] }, excerpts: Array.isArray(coding.excerpts) ? coding.excerpts : [] }, segments);
  } catch { return null; }
}
