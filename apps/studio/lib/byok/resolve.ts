import { headersFor, platformSttTarget, platformTarget, platformTranslateTarget, providerById, sameKeyFamily, validateConnection, type Capability, type ChatScope, type ConnectionConfig, type ProviderKind, type SttScope, type SttTarget, type Target, type TranslateScope, type TranslateTarget } from "@rescript/ai";
import { openSecret, vaultStatus, VaultError } from "./vault.ts";
import type { AiFeature, AiStore, CredentialRow, SettingRow } from "./store.ts";

/**
 * WHOSE AI IS THIS? — the one place that decides.
 *
 * Precedence, and it is the whole rule:
 *
 *   project choice   →   the acting user's choice   →   the platform
 *
 *   - A project that says "platform-managed" gets the platform's AI, whatever
 *     the user has set up for themselves.
 *   - A project that says "user-managed" uses the ACTING user's own
 *     connection (the person pressing the button — never the project owner's
 *     key, never another member's). If they have none, the answer is a
 *     refusal that says so, not the platform's AI.
 *   - With no project choice, the user's own setting decides; with none of
 *     those, the platform.
 *
 * THE RULE THAT MATTERS MORE THAN THE PRECEDENCE: user-managed never silently
 * becomes platform-managed. When a user's connection cannot be used — no
 * credential, a key that cannot be opened, a workspace that forbids it, an
 * invalid saved configuration — the result is `refused`, with a sentence that
 * names what to fix. The platform's AI (and its cost) is reached only through
 * a fallback the user explicitly listed (`allowPlatformFallback`), and then
 * only after their own provider has failed in a way another provider can cure.
 *
 * The decrypted key exists in the returned scope and nowhere else: it is not
 * logged, not returned by any route, and the scope lives for one request.
 */

export type RefusalCode =
  | "byok_blocked"        // the workspace administrator turned user-managed AI off
  | "vault_unavailable"   // this server cannot decrypt (no master key)
  | "no_connection"       // user-managed was chosen but nothing is configured for this feature
  | "credential_missing"  // the saved credential was deleted
  | "credential_unreadable" // it cannot be opened (wrong key / tampered)
  | "invalid_config"      // the saved configuration no longer passes validation
  | "capability_missing"  // the chosen provider cannot do what this feature needs
  | "unsupported_feature"; // user-managed is not available for this feature yet

export type Resolution =
  | { kind: "platform"; reason: "project_platform" | "user_platform" | "default" | "hybrid_capability" }
  | { kind: "user"; source: "user" | "project"; scopeKind: "chat"; scope: ChatScope; credentialId: string; settingUpdatedAt: string; skippedFallbacks: string[] }
  | { kind: "user"; source: "user" | "project"; scopeKind: "stt"; scope: SttScope; credentialId: string; settingUpdatedAt: string; skippedFallbacks: string[] }
  | { kind: "user"; source: "user" | "project"; scopeKind: "translate"; scope: TranslateScope; credentialId: string; settingUpdatedAt: string; skippedFallbacks: string[] }
  | { kind: "refused"; code: RefusalCode; message: string; source: "user" | "project" };

export interface ResolveInput {
  userId: string;
  feature: AiFeature;
  store: AiStore;
  /** the workspace's `ai_byok_allowed` (undefined = allowed) */
  workspaceAllows?: boolean;
  /** the project's own choice, when it has one (decided at project creation) */
  project?: { mode: "platform" | "user" } | null;
  /** what the feature needs from the provider */
  need?: Capability[];
  env?: Record<string, string | undefined>;
}

/** the features whose user-managed connection is implemented: chat (Intelligent Mode, the other AI features), speech-to-text and translation */
export const SUPPORTED_FEATURES: AiFeature[] = ["intelligent", "additional", "stt", "translation"];

/** which kind of provider a feature talks to */
export const providerKindOf = (feature: AiFeature): ProviderKind => (feature === "stt" ? "stt" : feature === "translation" ? "translate" : "chat");

const LABEL: Record<AiFeature, string> = { intelligent: "Intelligent Mode", stt: "speech-to-text", translation: "translation", additional: "the other AI features" };
const MAX_FALLBACKS = 3;
const TOUCH_EVERY_MS = 10 * 60 * 1000;

export const allowPrivateFrom = (env: Record<string, string | undefined> = process.env) => (env.AI_BYOK_ALLOW_PRIVATE_ENDPOINTS ?? "").trim() === "1";

function refuse(code: RefusalCode, message: string, source: "user" | "project"): Resolution { return { kind: "refused", code, message, source }; }

/** one saved connection → a Target (chat), SttTarget (speech) or TranslateTarget (a translation service), or the reason it cannot be one */
async function targetOf(kind: ProviderKind, userId: string, cred: CredentialRow | null, config: unknown, env: Record<string, string | undefined>): Promise<{ ok: true; target: Target | SttTarget | TranslateTarget; config: ConnectionConfig } | { ok: false; code: RefusalCode; message: string }> {
  if (!cred) return { ok: false, code: "credential_missing", message: "The API key saved for this feature was removed. Add it again in Settings → AI & Integrations." };
  const checked = validateConnection(kind, (config ?? {}) as Record<string, unknown>, { allowPrivate: allowPrivateFrom(env) });
  if (!checked.ok) return { ok: false, code: "invalid_config", message: `Your saved provider settings are no longer valid (${Object.values(checked.errors)[0] ?? "check them"}). Review them in Settings → AI & Integrations.` };
  const c = checked.config;
  /* a key is only ever used with a provider of its own vendor family — the OpenAI key saved for chat also serves OpenAI speech, and nothing else */
  if (!sameKeyFamily(cred.provider, c.provider)) return { ok: false, code: "invalid_config", message: "The saved API key belongs to a different provider than the one selected. Review it in Settings → AI & Integrations." };
  const def = providerById(c.provider)!;
  /* "My AI model" has no key of its own — it is the chat connection, resolved above; it is never a translation SERVICE target */
  if (def.protocol === "chat-reuse") return { ok: false, code: "invalid_config", message: "“My AI model” uses your chat connection and cannot be listed as a translation service. Choose a service with its own key." };
  let key: string;
  try { key = openSecret(cred.sealed, { userId, credentialId: cred.id }, env); }
  catch (e) {
    const code = e instanceof VaultError && e.code === "not_configured" ? "vault_unavailable" : "credential_unreadable";
    return { ok: false, code, message: code === "vault_unavailable" ? "Your own API key cannot be used right now: this installation's credential encryption key is not available." : "Your saved API key could not be opened. Enter it again in Settings → AI & Integrations." };
  }
  const protocol = def.protocol === "google-stt" ? "google-stt" : "openai-stt";
  return {
    ok: true, config: c,
    target: {
      provider: c.provider, base: c.base, key, model: c.model, headers: headersFor(def, c.extra), label: `${def.label} · ${c.model}`,
      ...(kind === "chat" ? { ...(c.modelSmall ? { modelSmall: c.modelSmall } : {}), ...(c.embeddingsModel ? { embeddingsModel: c.embeddingsModel } : {}), ...(c.visionModel ? { visionModel: c.visionModel } : {}) }
        : kind === "translate" ? { protocol: def.protocol as TranslateTarget["protocol"], label: def.label }
        : { protocol, ...(def.limits ? { limits: def.limits } : {}), ...(c.language ? { language: c.language } : {}) }),
    },
  };
}

/**
 * Translation by the person's AI model. It is the chat connection they saved
 * under "Other AI features" — its key, model and fallbacks — so that setting
 * must itself be their own provider; if it is not, the answer is a refusal
 * that says so, never the platform's model.
 */
async function viaChat(input: ResolveInput, source: "user" | "project"): Promise<Resolution> {
  const chat = await input.store.getSetting(input.userId, "additional");
  if (chat?.mode !== "user") return refuse("no_connection", "Translation is set to use your AI model, which is the connection saved under “Other AI features” — and that is not set to your own provider. Set it up in Settings → AI & Integrations, or choose a translation service.", source);
  const r = await resolveConnection({ ...input, feature: "additional", project: { mode: "user" }, need: [] });
  if (r.kind === "user") return { ...r, source };
  if (r.kind === "refused") return refuse(r.code, `Translation uses your AI model (“Other AI features”). ${r.message}`, source);
  return refuse("no_connection", "Translation uses your AI model, which is not set to your own provider. Set it up in Settings → AI & Integrations.", source);
}

export async function resolveConnection(input: ResolveInput): Promise<Resolution> {
  const { userId, feature, store } = input;
  const env = input.env ?? process.env;
  if (input.project?.mode === "platform") return { kind: "platform", reason: "project_platform" };

  const projectWantsUser = input.project?.mode === "user";
  const source: "user" | "project" = projectWantsUser ? "project" : "user";
  const setting: SettingRow | null = await store.getSetting(userId, feature);
  const userWantsUser = setting?.mode === "user";
  if (!projectWantsUser && !userWantsUser) return { kind: "platform", reason: setting ? "user_platform" : "default" };

  /* from here on the answer is a connection or a refusal — never the platform */
  if (!SUPPORTED_FEATURES.includes(feature)) return refuse("unsupported_feature", `Using your own provider is not available for ${LABEL[feature]} yet.`, source);
  if (input.workspaceAllows === false) return refuse("byok_blocked", "Your workspace administrator has turned off user-managed AI providers. Ask them to enable it, or use the platform's AI.", source);
  if (!userWantsUser || !setting) return refuse("no_connection", `This project uses your own AI provider, but you have not set one up for ${LABEL[feature]}. Add it in Settings → AI & Integrations.`, source);
  /* translation by "My AI model": no key of its own — it is the chat connection saved under the other AI features, asked to translate */
  if (feature === "translation" && (setting.config as { provider?: unknown } | null)?.provider === "llm") return viaChat(input, source);
  if (!vaultStatus(env).ready) return refuse("vault_unavailable", "Your own API key cannot be used right now: this installation's credential encryption key is not available.", source);
  if (!setting.credentialId) return refuse("no_connection", `You chose your own provider for ${LABEL[feature]} but no API key is saved. Add it in Settings → AI & Integrations.`, source);

  const kind = providerKindOf(feature);
  const primary = await targetOf(kind, userId, await store.getCredential(userId, setting.credentialId), setting.config, env);
  if (!primary.ok) return refuse(primary.code, primary.message, source);
  const def = providerById(primary.config.provider)!;
  for (const need of input.need ?? []) {
    if (def.capabilities.includes(need)) continue;
    /* HYBRID: the user allowed the platform as a backstop, so what their provider cannot do (speech synthesis, say) is done by the platform, and billed as the platform's */
    if (setting.allowPlatformFallback && (providerKindOf(feature) === "stt" ? platformSttTarget(env) : platformTarget(env))) return { kind: "platform", reason: "hybrid_capability" };
    return refuse("capability_missing", `${def.label} cannot be used for this: it does not support ${need.replace("_", " ")}. Choose a provider that does, or allow the platform's AI as a backstop in Settings → AI & Integrations.`, source);
  }

  const fallbacks: (Target | SttTarget | TranslateTarget)[] = [];
  const skipped: string[] = [];
  for (const f of (setting.fallbacks ?? []).slice(0, MAX_FALLBACKS)) {
    const t = await targetOf(kind, userId, await store.getCredential(userId, f.credentialId), f.config, env);
    if (t.ok) fallbacks.push(t.target); else skipped.push(t.message); // a broken fallback is skipped and reported — never replaced by something the user did not choose
  }
  if (setting.allowPlatformFallback) { const p = kind === "stt" ? platformSttTarget(env) : kind === "translate" ? platformTranslateTarget() : platformTarget(env); if (p) fallbacks.push(p); }

  const cred = await store.getCredential(userId, setting.credentialId);
  if (cred && (!cred.lastUsedAt || Date.now() - Date.parse(cred.lastUsedAt) > TOUCH_EVERY_MS)) void store.updateCredential(userId, cred.id, { lastUsedAt: new Date().toISOString() }).catch(() => undefined);

  const common = { kind: "user" as const, source, credentialId: setting.credentialId, settingUpdatedAt: setting.updatedAt, skippedFallbacks: skipped };
  if (kind === "stt") return { ...common, scopeKind: "stt", scope: { ...(primary.target as SttTarget), source, fallbacks: fallbacks as SttTarget[] } };
  if (kind === "translate") return { ...common, scopeKind: "translate", scope: { ...(primary.target as TranslateTarget), source, fallbacks: fallbacks as TranslateTarget[] } };
  return { ...common, scopeKind: "chat", scope: { ...(primary.target as Target), source, fallbacks: fallbacks as Target[] } };
}

/** what a screen may be told about a resolution: who provides the AI and why — never a key, a header or a fallback's credential */
export type ResolutionView =
  | { kind: "platform"; reason: Extract<Resolution, { kind: "platform" }>["reason"] }
  | { kind: "user"; source: "user" | "project"; provider: string; model: string; label: string | null; fallbacks: number; platformBackstop: boolean }
  | { kind: "refused"; code: RefusalCode; message: string };

export function viewOfResolution(r: Resolution): ResolutionView {
  if (r.kind === "platform") return { kind: "platform", reason: r.reason };
  if (r.kind === "refused") return { kind: "refused", code: r.code, message: r.message };
  return { kind: "user", source: r.source, provider: r.scope.provider, model: r.scope.model, label: r.scope.label ?? null, fallbacks: r.scope.fallbacks.length, platformBackstop: r.scope.fallbacks.some((f) => f.platform) };
}
