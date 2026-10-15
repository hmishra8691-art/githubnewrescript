import type { ConnectionConfig } from "@rescript/ai";

/**
 * WHERE USERS' AI CHOICES AND KEYS ARE KEPT (migration 0054).
 *
 * EVERY method takes the acting user's id and filters on it — there is no
 * "get credential by id" that is not also "…of this user". A route cannot
 * forget the ownership check because the store has no way to skip it: asking
 * for someone else's credential returns what asking for one that does not
 * exist returns.
 *
 * Two implementations behind one interface: the database (service role; RLS on
 * the tables has no policies, so this is the only way in) and memory, for the
 * `/sandbox`, for installations without a database, and for tests.
 */

export type AiFeature = "intelligent" | "stt" | "translation" | "additional";
export const FEATURES: AiFeature[] = ["intelligent", "stt", "translation", "additional"];
export const isFeature = (v: unknown): v is AiFeature => typeof v === "string" && (FEATURES as string[]).includes(v);

export interface TestRecord { at: string; ok: boolean; /** machine word: ok, auth, model_not_found, rate_limited, quota, unreachable, invalid_endpoint, … */ code: string; message: string; latencyMs?: number }

export interface CredentialRow {
  id: string; userId: string; provider: string; label: string | null;
  /** the envelope-encrypted secret — never leaves the server */
  sealed: string;
  /** "sk-proj-••••••••6789" — the only form a screen ever sees */
  mask: string;
  keyId: string; createdAt: string; rotatedAt: string | null; lastUsedAt: string | null; lastTest: TestRecord | null;
}
/** what a screen may be told about a credential: everything but the secret */
export type CredentialView = Omit<CredentialRow, "sealed" | "keyId" | "userId">;
export const viewOf = (c: CredentialRow): CredentialView => ({ id: c.id, provider: c.provider, label: c.label, mask: c.mask, createdAt: c.createdAt, rotatedAt: c.rotatedAt, lastUsedAt: c.lastUsedAt, lastTest: c.lastTest });

export interface FallbackEntry { credentialId: string; config: ConnectionConfig }

export interface SettingRow {
  userId: string; feature: AiFeature;
  mode: "platform" | "user";
  /** provider, address, model, identifiers — no secret */
  config: ConnectionConfig | Record<string, never>;
  credentialId: string | null;
  fallbacks: FallbackEntry[];
  allowPlatformFallback: boolean;
  lastTest: TestRecord | null;
  updatedAt: string;
}

export interface AiStore {
  listCredentials(userId: string): Promise<CredentialRow[]>;
  getCredential(userId: string, id: string): Promise<CredentialRow | null>;
  createCredential(row: CredentialRow): Promise<void>;
  updateCredential(userId: string, id: string, patch: Partial<Pick<CredentialRow, "label" | "sealed" | "mask" | "keyId" | "rotatedAt" | "lastUsedAt" | "lastTest">>): Promise<boolean>;
  /** deletes the credential; settings that used it fall back to "platform" mode with no credential — never to another credential */
  deleteCredential(userId: string, id: string): Promise<boolean>;
  listSettings(userId: string): Promise<SettingRow[]>;
  getSetting(userId: string, feature: AiFeature): Promise<SettingRow | null>;
  putSetting(row: SettingRow): Promise<void>;
  deleteSetting(userId: string, feature: AiFeature): Promise<boolean>;
  /** EVERY credential of every user, a page at a time — for the operator's key-rotation tool only; no route calls it */
  listCredentialsPage(offset: number, limit: number): Promise<CredentialRow[]>;
}

/* ------------------------------------------------------------------ memory */

export class MemoryAiStore implements AiStore {
  private creds = new Map<string, CredentialRow>();
  private settings = new Map<string, SettingRow>();
  async listCredentials(userId: string) { return [...this.creds.values()].filter((c) => c.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => ({ ...c })); }
  async getCredential(userId: string, id: string) { const c = this.creds.get(id); return c && c.userId === userId ? { ...c } : null; }
  async createCredential(row: CredentialRow) { this.creds.set(row.id, { ...row }); }
  async updateCredential(userId: string, id: string, patch: Partial<CredentialRow>) { const c = this.creds.get(id); if (!c || c.userId !== userId) return false; this.creds.set(id, { ...c, ...patch, id: c.id, userId: c.userId }); return true; }
  async deleteCredential(userId: string, id: string) {
    const c = this.creds.get(id); if (!c || c.userId !== userId) return false;
    this.creds.delete(id);
    for (const [k, s] of this.settings) if (s.userId === userId && s.credentialId === id) this.settings.set(k, { ...s, mode: "platform", credentialId: null, config: {}, updatedAt: new Date().toISOString() });
    return true;
  }
  async listSettings(userId: string) { return [...this.settings.values()].filter((s) => s.userId === userId).map((s) => ({ ...s })); }
  async getSetting(userId: string, feature: AiFeature) { const s = this.settings.get(`${userId}|${feature}`); return s ? { ...s } : null; }
  async putSetting(row: SettingRow) { this.settings.set(`${row.userId}|${row.feature}`, { ...row }); }
  async deleteSetting(userId: string, feature: AiFeature) { return this.settings.delete(`${userId}|${feature}`); }
  async listCredentialsPage(offset: number, limit: number) { return [...this.creds.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(offset, offset + limit).map((c) => ({ ...c })); }
}

/* ---------------------------------------------------------------- database */

/** the slice of the Supabase client this file uses — typed loosely so the store has no hard dependency on it */
type Db = { from(table: string): any };

const credFromDb = (r: any): CredentialRow => ({ id: r.id, userId: r.user_id, provider: r.provider, label: r.label ?? null, sealed: r.sealed, mask: r.mask, keyId: r.key_id, createdAt: r.created_at, rotatedAt: r.rotated_at ?? null, lastUsedAt: r.last_used_at ?? null, lastTest: r.last_test ?? null });
const settingFromDb = (r: any): SettingRow => ({ userId: r.user_id, feature: r.feature, mode: r.mode, config: r.config ?? {}, credentialId: r.credential_id ?? null, fallbacks: Array.isArray(r.fallbacks) ? r.fallbacks : [], allowPlatformFallback: !!r.allow_platform_fallback, lastTest: r.last_test ?? null, updatedAt: r.updated_at });

/**
 * The tables are not there (migration 0054 has not been applied to this database) or the API has not seen them yet.
 * Not a fault of the request: the feature is simply not installed, and everything that does not need it must carry on.
 */
export class AiStoreUnavailable extends Error {
  constructor(op: string, detail?: string) { super(`ai store ${op}: the user AI tables are not available (migration 0054 not applied?)${detail ? ` — ${detail}` : ""}`); this.name = "AiStoreUnavailable"; }
}
export const isMissingTable = (message: string | undefined | null): boolean => /relation .*(user_ai_|customers).* does not exist|could not find the (table|'[^']+' column)|schema cache|column .*ai_byok_allowed.* does not exist|42P01|PGRST205/i.test(message ?? "");

export class SupabaseAiStore implements AiStore {
  private db: Db;
  constructor(db: Db) { this.db = db; }
  private fail(op: string, error: { message?: string; code?: string } | null): never {
    if (isMissingTable(`${error?.message ?? ""} ${error?.code ?? ""}`)) throw new AiStoreUnavailable(op, error?.message);
    throw new Error(`ai store ${op} failed${error?.message ? `: ${error.message}` : ""}`);
  }
  async listCredentials(userId: string) {
    const { data, error } = await this.db.from("user_ai_credentials").select("*").eq("user_id", userId).order("created_at");
    if (error) this.fail("list credentials", error);
    return (data ?? []).map(credFromDb);
  }
  async getCredential(userId: string, id: string) {
    const { data, error } = await this.db.from("user_ai_credentials").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) this.fail("get credential", error);
    return data ? credFromDb(data) : null;
  }
  async createCredential(c: CredentialRow) {
    const { error } = await this.db.from("user_ai_credentials").insert({ id: c.id, user_id: c.userId, provider: c.provider, label: c.label, sealed: c.sealed, mask: c.mask, key_id: c.keyId, created_at: c.createdAt, rotated_at: c.rotatedAt, last_used_at: c.lastUsedAt, last_test: c.lastTest });
    if (error) this.fail("create credential", error);
  }
  async updateCredential(userId: string, id: string, p: Partial<CredentialRow>) {
    const row: Record<string, unknown> = {};
    if ("label" in p) row.label = p.label; if ("sealed" in p) row.sealed = p.sealed; if ("mask" in p) row.mask = p.mask; if ("keyId" in p) row.key_id = p.keyId;
    if ("rotatedAt" in p) row.rotated_at = p.rotatedAt; if ("lastUsedAt" in p) row.last_used_at = p.lastUsedAt; if ("lastTest" in p) row.last_test = p.lastTest;
    const { data, error } = await this.db.from("user_ai_credentials").update(row).eq("id", id).eq("user_id", userId).select("id");
    if (error) this.fail("update credential", error);
    return (data ?? []).length > 0;
  }
  async deleteCredential(userId: string, id: string) {
    const own = await this.getCredential(userId, id);
    if (!own) return false;
    /* settings that named it go back to the platform's AI explicitly, so no feature is left pointing at nothing (the FK would null it, but the MODE must change too) */
    const { error: e1 } = await this.db.from("user_ai_settings").update({ mode: "platform", credential_id: null, config: {}, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("credential_id", id);
    if (e1) this.fail("reset settings", e1);
    const { error } = await this.db.from("user_ai_credentials").delete().eq("id", id).eq("user_id", userId);
    if (error) this.fail("delete credential", error);
    return true;
  }
  async listCredentialsPage(offset: number, limit: number) {
    const { data, error } = await this.db.from("user_ai_credentials").select("*").order("id").range(offset, offset + limit - 1);
    if (error) this.fail("list credentials page", error);
    return (data ?? []).map(credFromDb);
  }
  async listSettings(userId: string) {
    const { data, error } = await this.db.from("user_ai_settings").select("*").eq("user_id", userId);
    if (error) this.fail("list settings", error);
    return (data ?? []).map(settingFromDb);
  }
  async getSetting(userId: string, feature: AiFeature) {
    const { data, error } = await this.db.from("user_ai_settings").select("*").eq("user_id", userId).eq("feature", feature).maybeSingle();
    if (error) this.fail("get setting", error);
    return data ? settingFromDb(data) : null;
  }
  async putSetting(s: SettingRow) {
    const { error } = await this.db.from("user_ai_settings").upsert({ user_id: s.userId, feature: s.feature, mode: s.mode, config: s.config, credential_id: s.credentialId, fallbacks: s.fallbacks, allow_platform_fallback: s.allowPlatformFallback, last_test: s.lastTest, updated_at: s.updatedAt }, { onConflict: "user_id,feature" });
    if (error) this.fail("save setting", error);
  }
  async deleteSetting(userId: string, feature: AiFeature) {
    const { data, error } = await this.db.from("user_ai_settings").delete().eq("user_id", userId).eq("feature", feature).select("feature");
    if (error) this.fail("delete setting", error);
    return (data ?? []).length > 0;
  }
}
