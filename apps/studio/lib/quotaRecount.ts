import "server-only";
import type { SurveyDefinition } from "@rescript/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchesResponseCondition } from "@rescript/engine";
import { loadQualityDefinition } from "./qualityDef";

/**
 * Quota counts, recomputed from the responses that exist.
 *
 * The counters used to be incremented once per completion and never looked at
 * again, so an edited, imported or deleted response left them wrong for good —
 * a deleted male respondent still filled a male quota cell. The dataset is the
 * truth; a counter is a cache of it. Every operation that changes the dataset
 * calls this, and it replaces one environment's counts in a single
 * transaction (`rescript_replace_quota_counts`), so nothing observes a
 * half-recounted state.
 *
 * Per environment, always: `is_test` is part of the counter's key, so a test
 * run can never make a live quota look full.
 *
 * The cells are decided by the SAME condition evaluator the runtime routes
 * with (`matchesResponseCondition` → `evaluateCondition`), which is why
 * "Generate quota from current data" and the live counting agree.
 */

export interface QuotaRecountResult {
  environment: "TEST" | "LIVE";
  /** responses that were counted (finished, not deleted) */
  responses: number;
  counts: Record<string, Record<string, number>>;
  cells: number;
}

const CHUNK = 1000;

/** Which statuses occupy a quota cell. A screen-out or a terminate never does. */
const COUNTED_STATUSES = ["complete"];

export async function recountQuotas(
  db: SupabaseClient,
  def: SurveyDefinition | undefined,
  surveyId: string,
  isTest: boolean,
): Promise<QuotaRecountResult> {
  let definition = def;
  if (!definition) {
    const loaded = await loadQualityDefinition(db, surveyId);
    if (!("def" in loaded)) throw new Error(loaded.error);
    definition = loaded.def;
  }
  const counts: Record<string, Record<string, number>> = {};
  const cells: { quotaId: string; cellId: string; count: number }[] = [];
  let responses = 0;

  if (definition.quotas.length) {
    for (let start = 0; ; start += CHUNK) {
      const { data, error } = await db
        .from("responses")
        .select("session_id, respondent_id, status, answers, calculated, embedded, flags, seed, started_at")
        .eq("survey_id", surveyId)
        .eq("is_test", isTest)
        .in("status", COUNTED_STATUSES)
        .is("deleted_at", null)
        .order("started_at", { ascending: true })
        .range(start, start + CHUNK - 1);
      if (error) throw new Error(error.message);
      const chunk = data ?? [];
      for (const row of chunk) {
        responses++;
        for (const quota of definition.quotas) {
          for (const cell of quota.cells) {
            if (!matchesResponseCondition(definition, cell.when, row as never)) continue;
            counts[quota.id] = counts[quota.id] ?? {};
            counts[quota.id][cell.id] = (counts[quota.id][cell.id] ?? 0) + 1;
          }
        }
      }
      if (chunk.length < CHUNK) break;
    }
    for (const [quotaId, byCell] of Object.entries(counts)) {
      for (const [cellId, count] of Object.entries(byCell)) cells.push({ quotaId, cellId, count });
    }
  }

  // one transaction: the old counts of THIS environment out, these in
  const { error } = await db.rpc("rescript_replace_quota_counts", { p_survey: surveyId, p_test: isTest, p_cells: cells });
  if (error) throw new Error(error.message);
  console.info("[rescript:quota] recount", JSON.stringify({ surveyId, environment: isTest ? "TEST" : "LIVE", responses, cells: cells.length }));
  return { environment: isTest ? "TEST" : "LIVE", responses, counts, cells: cells.length };
}

/**
 * "Generate quota from current data" — the cells a researcher would have had
 * to type, read off the dataset.
 *
 * For each question offered, one cell per distinct answer value with the
 * number of responses that gave it, as an ordinary `Condition` (`selected`),
 * so the generated quota is indistinguishable from a hand-built one and the
 * runtime routes on it without knowing where it came from.
 */
export interface GeneratedQuotaCell { id: string; label: string; count: number; when: unknown; limit: number }

export async function generateQuotaFromData(
  db: SupabaseClient,
  def: SurveyDefinition,
  surveyId: string,
  isTest: boolean,
  questionIds: string[],
): Promise<{ environment: "TEST" | "LIVE"; responses: number; questions: { questionId: string; code: string; label: string; cells: GeneratedQuotaCell[] }[] }> {
  const questions = def.questions.filter((q) => questionIds.includes(q.id));
  if (!questions.length) throw new Error("no questions selected");
  const tally = new Map<string, Map<string, number>>();
  for (const q of questions) tally.set(q.id, new Map());
  let responses = 0;

  for (let start = 0; ; start += CHUNK) {
    const { data, error } = await db
      .from("responses")
      .select("answers")
      .eq("survey_id", surveyId)
      .eq("is_test", isTest)
      .in("status", COUNTED_STATUSES)
      .is("deleted_at", null)
      .range(start, start + CHUNK - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    for (const row of chunk) {
      responses++;
      const answers = (row.answers ?? {}) as Record<string, unknown>;
      for (const q of questions) {
        const v = answers[q.id];
        if (v === undefined || v === null || v === "") continue;
        const bucket = tally.get(q.id)!;
        // a multi-select respondent belongs to every group they chose
        for (const one of Array.isArray(v) ? v : [v]) {
          const key = String(one);
          bucket.set(key, (bucket.get(key) ?? 0) + 1);
        }
      }
    }
    if (chunk.length < CHUNK) break;
  }

  const out = questions.map((q) => {
    const bucket = tally.get(q.id)!;
    const cells: GeneratedQuotaCell[] = [...bucket.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({
        id: `qc_${q.id}_${code}`.replace(/[^A-Za-z0-9_]/g, "_"),
        label: `${q.code}: ${q.options?.find((o) => String(o.code) === code)?.label ?? code}`,
        count,
        limit: count,
        when: { type: "rule", source: { kind: "question", ref: q.id }, operator: "selected", value: code },
      }));
    return { questionId: q.id, code: q.code, label: q.text ?? q.code, cells };
  });
  return { environment: isTest ? "TEST" : "LIVE", responses, questions: out };
}
