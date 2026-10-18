import "server-only";
import { supabaseAdmin } from "@/lib/admin";
import { dbConfigured, memoryOf, storeWithFallback } from "./durable";
import { MemoryResearchContextStore, type ResearchContext, type ResearchContextStore, type StoredResearchContext, type WorkflowTotals } from "./researchContext";

/**
 * THE RESEARCH CONTEXT'S TABLE (migration 0067, `copilot_research_context`):
 * one row per survey AND owner (the organisation, else the person) — the
 * structured context, the brief it was derived from (so exact passages stay
 * retrievable after a reload), the workflow's measured totals. Written with
 * the service role after the route has checked the caller may use the
 * project; the memory store answers until the migration is applied (and for
 * the sandbox), as the other copilot stores do (./durable).
 *
 * Why a table of its own: the operation log is one capped row per turn, and
 * a research document would change what every later turn retrieves and what
 * the Research panel lists — a context is neither.
 */

const TABLE = "copilot_research_context";

class SupabaseResearchContextStore implements ResearchContextStore {
  durable = true;
  private db = supabaseAdmin();
  async probe(surveyId: string) {
    const { error } = await this.db.from(TABLE).select("survey_id").eq("survey_id", surveyId).limit(1);
    if (error) throw error;
  }
  async get(surveyId: string, owner: string): Promise<StoredResearchContext | null> {
    const { data, error } = await this.db.from(TABLE).select("survey_id, owner_key, context, brief, workflow, updated_at").eq("survey_id", surveyId).eq("owner_key", owner).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { surveyId: data.survey_id, owner: data.owner_key, context: data.context as ResearchContext, brief: data.brief as string, workflow: (data.workflow ?? null) as WorkflowTotals | null, updatedAt: data.updated_at as string };
  }
  async put(rec: Omit<StoredResearchContext, "updatedAt">, meta: { userId?: string | null } = {}): Promise<StoredResearchContext> {
    const updatedAt = new Date().toISOString();
    const { error } = await this.db.from(TABLE).upsert({
      survey_id: rec.surveyId, owner_key: rec.owner, version: rec.context.version, status: rec.context.status,
      context: rec.context, brief: rec.brief, brief_sha256: rec.context.fingerprint.brief, workflow: rec.workflow ?? null,
      created_by: meta.userId ?? null, updated_at: updatedAt,
    }, { onConflict: "survey_id,owner_key" });
    if (error) throw new Error(error.message);
    return { ...rec, updatedAt };
  }
}

export async function researchContextStoreFor(surveyId: string): Promise<ResearchContextStore> {
  return storeWithFallback<ResearchContextStore>({
    memoryOnly: surveyId === "sandbox" || !dbConfigured(),
    durable: () => new SupabaseResearchContextStore(),
    probe: (s) => (s as SupabaseResearchContextStore).probe(surveyId),
    memory: () => new MemoryResearchContextStore(memoryOf<StoredResearchContext>("research_context")),
    what: "the research context table copilot_research_context (apply migration 0067)",
  });
}
