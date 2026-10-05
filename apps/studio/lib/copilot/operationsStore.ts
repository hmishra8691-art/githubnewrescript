import "server-only";
import { supabaseAdmin } from "@/lib/admin";
import { dbConfigured, storeWithFallback } from "./durable";
import {
  MemoryOperationStore, fromRow, planUpdate, toRow, withChangeN,
  type OperationFields, type OperationPatch, type OperationRecord, type OperationStore, type OperationSummary, type UpdateResult,
} from "./operations";

/**
 * THE OPERATION HISTORY'S TABLE (migration 0047, `intelligent_operations`),
 * behind the same interface as the memory store in ./operations — and the
 * memory store whenever the table is not there (see ./durable).
 *
 * Written with the service role: the route has already checked that the
 * caller may edit the project (writes) or see it (reads), which is the
 * policy the table's RLS states for reads; no client writes it directly.
 */

const TABLE = "intelligent_operations";
/*
 * The list's columns: everything but the two surveys — up to 4 MB a row,
 * which the History list never shows. `before->>meta` costs a few bytes and
 * says whether a survey was kept (Compare and Restore are offered on that).
 */
const LIST_COLUMNS = "id, survey_id, created_by, created_at, updated_at, change_n, prompt, source, intent, detected, targets, proposed, applied, excluded, failed, warnings, engine_ops, api_calls, status, status_detail, saved_revision, has_before:before->>meta, has_after:after->>meta";
/** Postgres unique_violation: the (survey_id, change_n) index refused a number another request took first */
const UNIQUE_VIOLATION = "23505";

class SupabaseOperationStore implements OperationStore {
  durable = true;
  private db = supabaseAdmin();

  /** the probe: one id, which fails with 42P01 / PGRST205 when the migration has not been applied */
  async probe(surveyId: string) {
    const { error } = await this.db.from(TABLE).select("id").eq("survey_id", surveyId).limit(1);
    if (error) throw error;
  }
  async list(surveyId: string, limit = 200): Promise<OperationSummary[]> {
    const { data, error } = await this.db.from(TABLE).select(LIST_COLUMNS).eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => { const { before: _b, after: _a, ...rest } = fromRow(r as unknown as Record<string, unknown>); return rest; });
  }
  async get(surveyId: string, id: string): Promise<OperationRecord | null> {
    const { data, error } = await this.db.from(TABLE).select("*").eq("survey_id", surveyId).eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? fromRow(data as Record<string, unknown>) : null;
  }
  async create(surveyId: string, fields: OperationFields, meta: { userId: string | null; surveyId: string }): Promise<OperationRecord> {
    const { data, error } = await this.db.from(TABLE).insert({ ...toRow(fields), survey_id: surveyId, created_by: meta.userId }).select("*").single();
    if (error) throw new Error(error.message);
    return fromRow(data as Record<string, unknown>);
  }
  async update(surveyId: string, id: string, patch: OperationPatch): Promise<UpdateResult> {
    const { data: cur, error: e1 } = await this.db.from(TABLE).select("id, status, change_n").eq("survey_id", surveyId).eq("id", id).maybeSingle();
    if (e1) return { ok: false, status: 500, error: e1.message };
    if (!cur) return { ok: false, status: 404, error: "No such operation." };
    const current = { status: cur.status as OperationRecord["status"], changeN: (cur.change_n as number | null) ?? null };
    const plan = planUpdate(current, patch);
    if (!plan.ok) return { ok: false, status: plan.code, error: plan.error };
    const row = { ...toRow(plan.next), updated_at: new Date().toISOString() };
    /*
     * Guarded on the status it was read in: two tabs moving the same record
     * at once (an Apply and a ⌘Z) must not both win. The loser is told, and
     * its client says the record may be behind.
     */
    const write = async (extra: Record<string, unknown>) => {
      const { data, error } = await this.db.from(TABLE).update({ ...row, ...extra }).eq("survey_id", surveyId).eq("id", id).eq("status", current.status).select("*").maybeSingle();
      if (error) return { ok: false as const, conflict: error.code === UNIQUE_VIOLATION, error: error.message };
      if (!data) return { ok: false as const, conflict: false, error: "The operation changed while this update was on its way; reload the history." };
      return { ok: true as const, value: fromRow(data as Record<string, unknown>) };
    };
    if (!plan.assignChangeN) {
      const r = await write({});
      return r.ok ? { ok: true, record: r.value, warnings: plan.warnings } : { ok: false, status: 409, error: r.error };
    }
    const r = await withChangeN(
      async () => {
        const { data, error } = await this.db.from(TABLE).select("change_n").eq("survey_id", surveyId).not("change_n", "is", null).order("change_n", { ascending: false }).limit(1);
        if (error) throw new Error(error.message);
        return (data ?? []).map((x) => x.change_n as number | null);
      },
      (n) => write({ change_n: n }),
    );
    return r.ok ? { ok: true, record: r.value, warnings: plan.warnings } : { ok: false, status: 409, error: r.error };
  }
}

/**
 * The store for one survey's history. `surveyKey` is the memory store's
 * key — the survey id, or "sandbox:<tab key>" for the sandbox, which has no
 * row and therefore no table to be in.
 */
export async function operationStoreFor(surveyId: string): Promise<OperationStore> {
  return storeWithFallback<OperationStore>({
    memoryOnly: surveyId === "sandbox" || !dbConfigured(),
    durable: () => new SupabaseOperationStore(),
    probe: (s) => (s as SupabaseOperationStore).probe(surveyId),
    memory: () => new MemoryOperationStore(),
    what: "the operation history table intelligent_operations (apply migration 0047)",
  });
}
