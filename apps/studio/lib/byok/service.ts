import { randomUUID } from "node:crypto";
import {
  classifyResponse, discoverModels, guardedFetch, headersFor, isProviderError, platformTarget, providerById, publicCatalog, redact, suggestionsFor, validateConnection,
  type ConnectionConfig, type ConnectionInput, type FieldErrors, type ProviderErrorKind,
} from "@rescript/ai";
import { maskSecret, openSecret, sealSecret, vaultStatus, VaultError } from "./vault.ts";
import { allowPrivateFrom, SUPPORTED_FEATURES } from "./resolve.ts";
import {
  isFeature, MemoryAiStore, viewOf, FEATURES,
  type AiFeature, type AiStore, type CredentialRow, type FallbackEntry, type SettingRow, type TestRecord,
} from "./store.ts";

/**
 * THE ACCOUNT-SIDE SERVICE of user-owned AI providers: what the settings
 * screen reads and writes. Routes are thin; every rule lives here, with the
 * store and the network injected so the rules are testable without either.
 *
 * Rules enforced here, once:
 *   - a key is only ever sealed, masked, or opened for one provider call — it
 *     is never in a return value, an error or a log line;
 *   - a fixed provider's address is the registry's; a custom address passes
 *     the endpoint guard on save, on test, and again on every use;
 *   - a feature's connection, fallbacks and credentials are the ACTING
 *     user's — the store cannot return another user's row;
 *   - nothing is saved as "user-managed" unless it could be used: the vault
 *     is ready, the workspace allows it, the configuration validates.
 */

export interface Deps {
  store: AiStore;
  env?: Record<string, string | undefined>;
  /** the workspace's `ai_byok_allowed` (undefined = allowed) */
  workspaceAllows?: boolean;
  fetcher?: typeof guardedFetch;
  now?: () => number;
}

export type Failure = { ok: false; status: number; code: string; message: string; errors?: FieldErrors };
const fail = (status: number, code: string, message: string, errors?: FieldErrors): Failure => ({ ok: false, status, code, message, ...(errors ? { errors } : {}) });

/* ------------------------------------------------------------- the store */

declare global {
  // eslint-disable-next-line no-var
  var __rescriptAiStore: AiStore | undefined;
}
/** the database when there is one; memory (this process only) when there is not — the sandbox and tests */
export function memoryStore(): AiStore { return (globalThis.__rescriptAiStore ??= new MemoryAiStore()); }

/* ------------------------------------------------------------ validation */

const KEY_SHAPE = /^[\x21-\x7E]{8,400}$/; // printable ASCII, no whitespace: what every provider's keys are
export function cleanKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^Bearer\s+/i, "");
  return KEY_SHAPE.test(t) ? t : null;
}
const labelOf = (v: unknown) => (typeof v === "string" ? v.trim().replace(/[\u0000-\u001f<>]/g, "").slice(0, 60) : "") || null;

function chatConfig(input: unknown, env: Record<string, string | undefined>): { ok: true; config: ConnectionConfig } | { ok: false; errors: FieldErrors } {
  return validateConnection("chat", (input ?? {}) as ConnectionInput, { allowPrivate: allowPrivateFrom(env) });
}

/* ---------------------------------------------------------------- overview */

export async function overview(userId: string, d: Deps) {
  const env = d.env ?? process.env;
  const [creds, settings] = await Promise.all([d.store.listCredentials(userId), d.store.listSettings(userId)]);
  const byId = new Map(creds.map((c) => [c.id, c]));
  const by = new Map(settings.map((s) => [s.feature, s]));
  return {
    vault: vaultStatus(env),
    workspaceAllows: d.workspaceAllows !== false,
    platformFallbackAvailable: !!platformTarget(env),
    catalog: publicCatalog("chat"),
    credentials: creds.map(viewOf),
    features: FEATURES.map((feature) => {
      const s = by.get(feature);
      return {
        feature,
        supported: SUPPORTED_FEATURES.includes(feature),
        mode: s?.mode ?? "platform",
        config: s && s.mode === "user" ? s.config : null,
        credential: s?.credentialId && byId.get(s.credentialId) ? viewOf(byId.get(s.credentialId)!) : null,
        fallbacks: (s?.fallbacks ?? []).map((f) => ({ config: f.config, credential: byId.get(f.credentialId) ? viewOf(byId.get(f.credentialId)!) : null })),
        allowPlatformFallback: !!s?.allowPlatformFallback,
        lastTest: s?.lastTest ?? null,
        updatedAt: s?.updatedAt ?? null,
      };
    }),
  };
}

/* ------------------------------------------------------------ credentials */

/** add a key, or replace the secret of one the user already has (same provider) */
export async function saveCredential(userId: string, input: { provider: string; apiKey: unknown; label?: unknown; credentialId?: string | null }, d: Deps): Promise<{ ok: true; credential: ReturnType<typeof viewOf>; created: boolean } | Failure> {
  const env = d.env ?? process.env;
  const status = vaultStatus(env);
  if (!status.ready) return fail(503, "vault_unavailable", status.reason ?? "Saving your own API key is not enabled on this installation.");
  if (d.workspaceAllows === false) return fail(403, "byok_blocked", "Your workspace administrator has turned off user-managed AI providers.");
  const def = providerById(input.provider);
  if (!def || def.kind !== "chat") return fail(422, "invalid_provider", "Choose a provider from the list.", { provider: "Choose a provider from the list." });
  const key = cleanKey(input.apiKey);
  if (!key) return fail(422, "invalid_key", "That does not look like an API key (it must be 8 or more visible characters with no spaces).", { apiKey: "That does not look like an API key." });
  let existing: CredentialRow | null = null;
  if (input.credentialId) {
    existing = await d.store.getCredential(userId, input.credentialId);
    if (!existing) return fail(404, "not_found", "That saved key was not found.");
    if (existing.provider !== def.id) return fail(422, "provider_mismatch", `That saved key is for a different provider. Add a new key for ${def.label} instead.`);
  }
  const id = existing?.id ?? randomUUID();
  let sealed: { sealed: string; keyId: string };
  try { sealed = sealSecret(key, { userId, credentialId: id }, env); }
  catch (e) { return fail(503, "vault_unavailable", e instanceof VaultError ? e.message : "The key could not be saved."); }
  const now = new Date((d.now ?? Date.now)()).toISOString();
  if (existing) {
    await d.store.updateCredential(userId, id, { sealed: sealed.sealed, keyId: sealed.keyId, mask: maskSecret(key), rotatedAt: now, lastTest: null, ...(input.label !== undefined ? { label: labelOf(input.label) } : {}) });
  } else {
    await d.store.createCredential({ id, userId, provider: def.id, label: labelOf(input.label), sealed: sealed.sealed, mask: maskSecret(key), keyId: sealed.keyId, createdAt: now, rotatedAt: null, lastUsedAt: null, lastTest: null });
  }
  const saved = (await d.store.getCredential(userId, id))!;
  return { ok: true, credential: viewOf(saved), created: !existing };
}

export async function removeCredential(userId: string, id: string, d: Deps): Promise<{ ok: true; provider: string } | Failure> {
  const c = await d.store.getCredential(userId, id);
  if (!c) return fail(404, "not_found", "That saved key was not found.");
  await d.store.deleteCredential(userId, id);
  /* a fallback list that named it loses that entry; a feature that used it is already back on the platform (the store did that) */
  for (const s of await d.store.listSettings(userId)) {
    if (s.fallbacks.some((f) => f.credentialId === id)) await d.store.putSetting({ ...s, fallbacks: s.fallbacks.filter((f) => f.credentialId !== id), updatedAt: new Date().toISOString() });
  }
  return { ok: true, provider: c.provider };
}

/* --------------------------------------------------------------- settings */

export interface SaveInput {
  feature: unknown; mode: unknown; config?: unknown; credentialId?: unknown; apiKey?: unknown; label?: unknown;
  fallbacks?: unknown; allowPlatformFallback?: unknown;
}

export async function saveSetting(userId: string, input: SaveInput, d: Deps): Promise<{ ok: true; feature: AiFeature; mode: "platform" | "user"; provider?: string; model?: string; credentialSaved?: boolean } | Failure> {
  const env = d.env ?? process.env;
  if (!isFeature(input.feature)) return fail(422, "invalid_feature", "Unknown AI feature.");
  const feature = input.feature;
  const now = new Date((d.now ?? Date.now)()).toISOString();

  if (input.mode === "platform") {
    await d.store.putSetting({ userId, feature, mode: "platform", config: {}, credentialId: null, fallbacks: [], allowPlatformFallback: false, lastTest: null, updatedAt: now });
    return { ok: true, feature, mode: "platform" };
  }
  if (input.mode !== "user") return fail(422, "invalid_mode", "Choose the platform's AI or your own provider.");
  if (!SUPPORTED_FEATURES.includes(feature)) return fail(422, "unsupported_feature", "Using your own provider is not available for this feature yet.");
  if (d.workspaceAllows === false) return fail(403, "byok_blocked", "Your workspace administrator has turned off user-managed AI providers.");
  const status = vaultStatus(env);
  if (!status.ready) return fail(503, "vault_unavailable", status.reason ?? "Saving your own API key is not enabled on this installation.");

  const checked = chatConfig(input.config, env);
  if (!checked.ok) return fail(422, "invalid_config", "Some settings need attention.", checked.errors);
  const config = checked.config;

  /* the credential: a new/replacement key typed now, or one already saved (and then it must be this user's and this provider's) */
  let credentialId = typeof input.credentialId === "string" ? input.credentialId : null;
  let credentialSaved = false;
  if (input.apiKey !== undefined && input.apiKey !== "" && input.apiKey !== null) {
    const r = await saveCredential(userId, { provider: config.provider, apiKey: input.apiKey, label: input.label, credentialId }, d);
    if (!r.ok) return r;
    credentialId = r.credential.id; credentialSaved = true;
  } else {
    const prior = await d.store.getSetting(userId, feature);
    if (!credentialId && prior?.credentialId) {
      const priorCred = await d.store.getCredential(userId, prior.credentialId);
      if (priorCred && priorCred.provider === config.provider) credentialId = priorCred.id;
    }
    const c = credentialId ? await d.store.getCredential(userId, credentialId) : null;
    if (!c) return fail(422, "key_required", "Enter your API key.", { apiKey: "Enter your API key." });
    if (c.provider !== config.provider) return fail(422, "provider_mismatch", "That saved key is for a different provider. Enter the key for the provider you selected.", { apiKey: "Enter a key for this provider." });
  }

  const fallbacks: FallbackEntry[] = [];
  const raw = Array.isArray(input.fallbacks) ? input.fallbacks : [];
  if (raw.length > 3) return fail(422, "too_many_fallbacks", "You can list up to three fallback providers.");
  for (const f of raw as { credentialId?: unknown; config?: unknown }[]) {
    const fc = typeof f?.credentialId === "string" ? await d.store.getCredential(userId, f.credentialId) : null;
    if (!fc) return fail(422, "invalid_fallback", "A fallback provider's saved key was not found.");
    const fv = chatConfig(f.config, env);
    if (!fv.ok) return fail(422, "invalid_fallback", `A fallback provider's settings need attention: ${Object.values(fv.errors)[0]}`, fv.errors);
    if (fc.provider !== fv.config.provider) return fail(422, "provider_mismatch", "A fallback's saved key belongs to a different provider than the one selected.");
    if (fc.id === credentialId && fv.config.model === config.model) return fail(422, "invalid_fallback", "A fallback must differ from the primary connection.");
    if (fallbacks.some((x) => x.credentialId === fc.id && x.config.model === fv.config.model)) return fail(422, "invalid_fallback", "The same fallback is listed twice.");
    fallbacks.push({ credentialId: fc.id, config: fv.config });
  }
  const allowPlatformFallback = input.allowPlatformFallback === true;

  const prior = await d.store.getSetting(userId, feature);
  const unchanged = prior && prior.credentialId === credentialId && JSON.stringify(prior.config) === JSON.stringify(config) && !credentialSaved;
  await d.store.putSetting({ userId, feature, mode: "user", config, credentialId, fallbacks, allowPlatformFallback, lastTest: unchanged ? prior!.lastTest : null, updatedAt: now });
  return { ok: true, feature, mode: "user", provider: config.provider, model: config.model, credentialSaved };
}

/* ---------------------------------------------------------- test + models */

const rateLog = new Map<string, number[]>();
/** the probe endpoints reach out over the network on a user's say-so: bounded per user */
export function probeAllowed(userId: string, now = Date.now(), limit = 12, windowMs = 60_000): boolean {
  const recent = (rateLog.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) { rateLog.set(userId, recent); return false; }
  recent.push(now); rateLog.set(userId, recent);
  if (rateLog.size > 5000) for (const k of rateLog.keys()) { if (!rateLog.get(k)!.some((t) => now - t < windowMs)) rateLog.delete(k); }
  return true;
}

const SAY: Record<ProviderErrorKind, { code: string; message: string }> = {
  auth: { code: "auth", message: "The provider rejected the API key. Check that it is correct, active and for this provider." },
  forbidden: { code: "forbidden", message: "The key is valid but not permitted to use this model or endpoint (check the project, organization or workspace it belongs to)." },
  not_found: { code: "model_not_found", message: "The provider does not know this model or address. Check the model name (and the base URL for a custom provider)." },
  rate_limited: { code: "rate_limited", message: "The provider is rate-limiting this key right now. The key itself works; try again shortly." },
  quota_exhausted: { code: "quota", message: "The provider says this account has no credit or has reached its spending limit. Add credit with the provider." },
  overloaded: { code: "overloaded", message: "The provider is overloaded right now. Try again in a moment." },
  server: { code: "provider_error", message: "The provider had an internal error. Try again in a moment." },
  network: { code: "unreachable", message: "The provider could not be reached from the Studio." },
  timeout: { code: "timeout", message: "The provider did not answer in time." },
  bad_request: { code: "bad_request", message: "The provider refused the request. The model may not support chat, or a setting is wrong." },
  busy: { code: "busy", message: "Too many requests in flight; try again." },
};

async function secretFor(userId: string, input: { apiKey?: unknown; credentialId?: unknown }, provider: string, d: Deps): Promise<{ ok: true; key: string; credential: CredentialRow | null } | Failure> {
  const env = d.env ?? process.env;
  const typed = input.apiKey !== undefined && input.apiKey !== "" && input.apiKey !== null ? cleanKey(input.apiKey) : undefined;
  if (typed === null) return fail(422, "invalid_key", "That does not look like an API key.", { apiKey: "That does not look like an API key." });
  if (typed) return { ok: true, key: typed, credential: null };
  const id = typeof input.credentialId === "string" ? input.credentialId : null;
  const c = id ? await d.store.getCredential(userId, id) : null;
  if (!c) return fail(422, "key_required", "Enter your API key.", { apiKey: "Enter your API key." });
  if (c.provider !== provider) return fail(422, "provider_mismatch", "That saved key is for a different provider.");
  try { return { ok: true, key: openSecret(c.sealed, { userId, credentialId: c.id }, env), credential: c }; }
  catch { return fail(409, "credential_unreadable", "Your saved API key could not be opened. Enter it again."); }
}

export interface TestInput { config?: unknown; apiKey?: unknown; credentialId?: unknown; feature?: unknown }

/** One tiny real request to the configured model, to say in words whether this connection works. The provider's own text never reaches the caller. */
export async function testConnection(userId: string, input: TestInput, d: Deps): Promise<{ ok: true; result: TestRecord & { jsonMode?: boolean; model: string; provider: string } } | Failure> {
  const env = d.env ?? process.env;
  if (d.workspaceAllows === false) return fail(403, "byok_blocked", "Your workspace administrator has turned off user-managed AI providers.");
  if (!probeAllowed(userId, (d.now ?? Date.now)())) return fail(429, "too_many_tests", "Too many connection tests. Wait a minute and try again.");
  const checked = chatConfig(input.config, env);
  if (!checked.ok) return fail(422, "invalid_config", "Some settings need attention.", checked.errors);
  const config = checked.config, def = providerById(config.provider)!;
  const secret = await secretFor(userId, input, config.provider, d);
  if (!secret.ok) return secret;

  const fetcher = d.fetcher ?? guardedFetch;
  const headers = { "content-type": "application/json", ...headersFor(def, config.extra), authorization: `Bearer ${secret.key}` };
  const started = (d.now ?? Date.now)();
  const ask = async (body: Record<string, unknown>) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const r = await fetcher(`${config.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: config.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }], ...body }), signal: ctrl.signal }, { allowPrivate: allowPrivateFrom(env), maxResponseBytes: 1024 * 1024 });
      const text = await r.text();
      return { status: r.status, headers: r.headers, text };
    } finally { clearTimeout(t); }
  };
  let record: TestRecord & { jsonMode?: boolean };
  const at = new Date((d.now ?? Date.now)()).toISOString();
  try {
    const a = await ask({});
    if (a.status >= 200 && a.status < 300) {
      let json: boolean | undefined;
      if (input.feature === "intelligent" || input.feature === undefined) {
        const b = await ask({ response_format: { type: "json_object" }, messages: [{ role: "user", content: 'Reply with a JSON object: {"ok": true}' }] }).catch(() => null);
        json = !!b && b.status >= 200 && b.status < 300;
      }
      record = { at, ok: true, code: "ok", message: json === false ? "The connection works. This model did not accept JSON mode, so structured Intelligent Mode answers may be less reliable." : "The connection works.", latencyMs: (d.now ?? Date.now)() - started, ...(json === undefined ? {} : { jsonMode: json }) };
    } else {
      const e = classifyResponse(a.status, a.headers, a.text);
      const s = SAY[e.kind];
      record = { at, ok: false, code: s.code, message: s.message, latencyMs: (d.now ?? Date.now)() - started };
    }
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "AbortError") record = { at, ok: false, code: "timeout", message: SAY.timeout.message };
    else if (name === "EndpointRefused") record = { at, ok: false, code: "invalid_endpoint", message: redact((e as Error).message, 200) };
    else if (isProviderError(e)) record = { at, ok: false, ...SAY[e.kind] };
    else record = { at, ok: false, code: "unreachable", message: SAY.network.message };
  }
  const { jsonMode, ...stored } = record;
  if (secret.credential) await d.store.updateCredential(userId, secret.credential.id, { lastTest: stored }).catch(() => undefined);
  if (typeof input.feature === "string" && isFeature(input.feature)) {
    const s = await d.store.getSetting(userId, input.feature);
    if (s && s.mode === "user" && s.credentialId === secret.credential?.id) await d.store.putSetting({ ...s, lastTest: stored }).catch(() => undefined);
  }
  return { ok: true, result: { ...record, model: config.model, provider: config.provider } };
}

export async function modelsFor(userId: string, input: { provider?: unknown; base?: unknown; apiKey?: unknown; credentialId?: unknown; extra?: unknown }, d: Deps) {
  const env = d.env ?? process.env;
  if (d.workspaceAllows === false) return fail(403, "byok_blocked", "Your workspace administrator has turned off user-managed AI providers.");
  const def = typeof input.provider === "string" ? providerById(input.provider) : undefined;
  if (!def || def.kind !== "chat") return fail(422, "invalid_provider", "Choose a provider from the list.", { provider: "Choose a provider from the list." });
  /* models are listed before a model is chosen: validate the address and identifiers with a placeholder model */
  const checked = chatConfig({ provider: def.id, base: input.base, model: "placeholder", extra: input.extra }, env);
  if (!checked.ok) { const { model: _m, ...rest } = checked.errors; if (Object.keys(rest).length) return fail(422, "invalid_config", "Some settings need attention.", rest as FieldErrors); }
  const base = checked.ok ? checked.config.base : def.base ?? "";
  const extra = checked.ok ? checked.config.extra : {};
  if (!probeAllowed(userId, (d.now ?? Date.now)())) return fail(429, "too_many_tests", "Too many requests. Wait a minute and try again.");
  const secret = await secretFor(userId, input, def.id, d);
  if (!secret.ok) return { ...secret, ...{ suggestions: suggestionsFor(def) } } as Failure;
  const r = await discoverModels(def, base, secret.key, headersFor(def, extra), { allowPrivate: allowPrivateFrom(env), fetcher: d.fetcher });
  return { ok: true as const, discovered: r.ok, reason: r.reason ?? null, message: r.message ?? null, models: r.models, suggestions: r.ok ? [] : suggestionsFor(def) };
}
