import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { guideTextOf, type QualSegment, type QualState, type SourceMeta, type StudyContext } from "@rescript/analytics";
import { loadDefinition } from "@/lib/analytics";
import { allSegments, readSettings, toWorkspace, type QualWorkspace } from "./qualWorkspace";
import { loadRows } from "./qualStore";

/**
 * Everything a synthesis call reads, loaded once: the coding (unredacted — the
 * redaction for the model is applied when the evidence is built, and the view is
 * redacted for the member afterwards), the segments, the sources' titles and
 * sessions, the names list, and the study's objectives, hypotheses and guide.
 */
export interface SynthesisContext { full: QualWorkspace; state: QualState; segments: QualSegment[]; sources: Record<string, SourceMeta>; names: string[]; study: StudyContext; settings: Record<string, unknown>; rows: Awaited<ReturnType<typeof loadRows>> }

export function studyOf(def: { qualStudy?: { objectives?: string[]; sections?: { title?: string; purpose?: string; questions?: { text: string; probes?: string[] }[] }[] } | null; research?: { objective?: string; researchQuestions?: string[]; hypotheses?: string[] } | null } | null | undefined): StudyContext {
  const objectives = def?.qualStudy?.objectives?.length ? def.qualStudy.objectives : [def?.research?.objective, ...(def?.research?.researchQuestions ?? [])].filter((x): x is string => typeof x === "string" && !!x.trim());
  return { objectives: objectives.slice(0, 12).map((x) => String(x).slice(0, 300)), hypotheses: (def?.research?.hypotheses ?? []).slice(0, 12).map((x) => String(x).slice(0, 300)), guideText: guideTextOf(def?.qualStudy ?? null).slice(0, 8000) };
}

export async function synthesisContext(db: SupabaseClient, surveyId: string): Promise<SynthesisContext> {
  const [rows, loaded] = await Promise.all([loadRows(db, surveyId), loadDefinition(db, surveyId).catch(() => null)]);
  const full = toWorkspace(rows, { pii: true });
  const def = loaded && !("error" in loaded) ? loaded.def : null;
  const sources: Record<string, SourceMeta> = {};
  for (const t of full.transcripts) sources[t.id] = { title: t.title, sessionId: t.sessionId };
  const settings = (rows.coding?.settings && typeof rows.coding.settings === "object" ? rows.coding.settings : {}) as Record<string, unknown>;
  return { full, state: full.state, segments: allSegments(full), sources, names: readSettings(rows.coding?.settings).redactNames, study: studyOf(def as never), settings, rows };
}
