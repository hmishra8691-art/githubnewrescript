import "server-only";
import { supabaseAdmin } from "../admin";
import { mediaDb } from "../mediaRoute";
import { IMPORT_BUCKET, expiryFrom, memorySessionStore, sourceKey, type ImportSession, type SessionStore } from "./sessions";

/**
 * THE IMPORT-SESSION STORE BOUND TO THE STUDIO (I4): `import_sessions` (migration 0080) through the service role,
 * the file in the media store's primary (Cloudflare R2 when configured, else the private Supabase bucket
 * `rescript-imports`). Without a database (the sandbox, a local Studio) the process-wide memory store answers
 * instead, so the same routes work and the browser suites can see history and rollback.
 */
const hasDatabase = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const g = globalThis as unknown as { __rescriptImportMemory?: SessionStore };
export function memoryStore(): SessionStore { return (g.__rescriptImportMemory ??= memorySessionStore()); }

export function importSessionStore(): SessionStore {
  return hasDatabase() ? databaseStore() : memoryStore();
}

type Row = Record<string, unknown>;
const toSession = (r: Row): ImportSession => ({
  id: String(r.id), customerId: (r.customer_id as string | null) ?? null, userId: (r.user_id as string | null) ?? null, surveyId: (r.survey_id as string | null) ?? null,
  into: r.into_mode === "merge" ? "merge" : "new", scope: (r.scope as ImportSession["scope"]) ?? "full",
  fileName: String(r.file_name), format: String(r.format), platform: (r.platform as string | null) ?? null, fingerprint: String(r.fingerprint), sizeBytes: Number(r.size_bytes ?? 0),
  storageProvider: (r.storage_provider as string | null) ?? null, bucket: (r.bucket as string | null) ?? null, storageKey: (r.storage_key as string | null) ?? null,
  sourceExpiresAt: String(r.source_expires_at), status: r.status as ImportSession["status"],
  reportDigest: (r.report_digest ?? {}) as ImportSession["reportDigest"], canonical: r.canonical ?? null, decisions: Array.isArray(r.decisions) ? r.decisions : [],
  priorDefinition: r.prior_definition ?? null, error: (r.error as string | null) ?? null,
  createdAt: String(r.created_at), appliedAt: (r.applied_at as string | null) ?? null, rolledBackAt: (r.rolled_back_at as string | null) ?? null,
});

function databaseStore(): SessionStore {
  const db = supabaseAdmin();
  const objects = mediaDb().stores;
  const LIST = "id, customer_id, user_id, survey_id, into_mode, scope, file_name, format, platform, fingerprint, size_bytes, storage_provider, bucket, storage_key, source_expires_at, status, report_digest, decisions, error, created_at, applied_at, rolled_back_at";
  return {
    kind: "database",
    async create(s, source) {
      const created = new Date();
      const { data, error } = await db.from("import_sessions").insert({
        customer_id: s.customerId, user_id: s.userId, survey_id: s.surveyId, into_mode: s.into, scope: s.scope, file_name: s.fileName.slice(0, 240), format: s.format, platform: s.platform,
        fingerprint: s.fingerprint, size_bytes: s.sizeBytes, status: s.status ?? "analyzed", report_digest: s.reportDigest, canonical: s.canonical, decisions: s.decisions,
        prior_definition: s.priorDefinition, error: s.error, source_expires_at: expiryFrom(created),
      }).select("*").single();
      if (error || !data) throw new Error(error?.message ?? "the import session could not be saved");
      let row = toSession(data as Row);
      if (source) {
        /* the file goes under the organisation's prefix; a failed upload leaves the session without a source — said in its error, never fatal */
        const key = sourceKey(s.customerId, row.id, s.fileName);
        try {
          await objects.primary.put(IMPORT_BUCKET, key, source, { contentType: "application/octet-stream" });
          const { data: up } = await db.from("import_sessions").update({ bucket: IMPORT_BUCKET, storage_key: key, storage_provider: objects.primary.name, updated_at: new Date().toISOString() }).eq("id", row.id).select("*").single();
          if (up) row = toSession(up as Row);
        } catch (e) {
          await db.from("import_sessions").update({ error: `The file was not kept: ${(e as Error).message}`.slice(0, 500) }).eq("id", row.id);
          row = { ...row, error: `The file was not kept: ${(e as Error).message}` };
        }
      }
      return row;
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data } = await db.from("import_sessions").select("*").eq("id", id).maybeSingle();
      return data ? toSession(data as Row) : null;
    },
    async list({ customerId, surveyId, limit = 50 }) {
      let q = db.from("import_sessions").select(LIST).order("created_at", { ascending: false }).limit(Math.min(200, limit));
      q = customerId ? q.eq("customer_id", customerId) : q.is("customer_id", null);
      if (surveyId) q = q.eq("survey_id", surveyId);
      const { data } = await q;
      return ((data ?? []) as Row[]).map((r) => toSession({ ...r, canonical: null, prior_definition: null }));
    },
    async update(id, patch) {
      const row: Row = { updated_at: new Date().toISOString() };
      if (patch.status) row.status = patch.status;
      if (patch.surveyId !== undefined) row.survey_id = patch.surveyId;
      if (patch.appliedAt !== undefined) row.applied_at = patch.appliedAt;
      if (patch.rolledBackAt !== undefined) row.rolled_back_at = patch.rolledBackAt;
      if (patch.decisions) row.decisions = patch.decisions;
      if (patch.error !== undefined) row.error = patch.error;
      const { data } = await db.from("import_sessions").update(row).eq("id", id).select("*").maybeSingle();
      return data ? toSession(data as Row) : null;
    },
    async expired(limit) {
      const { data, error } = await db.rpc("rescript_import_sessions_expired", { p_limit: limit });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), bucket: r.bucket, storageKey: r.storage_key, storageProvider: r.storage_provider }) as unknown as ImportSession);
    },
    async dropSource(s) {
      if (s.storageKey && s.bucket) {
        const store = objects.byName(s.storageProvider) ?? objects.primary;
        await store.remove(s.bucket, [s.storageKey]);
      }
      await db.from("import_sessions").update({ bucket: null, storage_key: null, updated_at: new Date().toISOString() }).eq("id", s.id);
    },
  };
}
