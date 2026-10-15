/**
 * THE SETTINGS SCREEN'S LOGIC, with no React and no network: what a draft is,
 * whether it differs from what is saved, what a save sends, and what each
 * feature says about itself. Pure, so every rule the screen shows is tested.
 *
 * Browser-safe on purpose (it imports nothing from the server packages): the
 * screen and the tests use the same functions.
 *
 * What it never does: hold a secret longer than the field it was typed in.
 * `newKey` is the text of a password input; it is sent once with the save and
 * dropped from the draft on success. A saved key is only ever a mask and an id.
 */

export type FeatureId = "intelligent" | "additional" | "stt" | "translation";
export type Kind = "chat" | "stt" | "translate";

export interface CatalogField { id: string; label: string; help: string; required: boolean; example: string }
export interface CatalogHint { id: string; label: string; capabilities: string[]; intelligent?: boolean }
export interface CatalogProvider {
  id: string; label: string; kind: Kind; capabilities: string[]; base: string | null; customBase: boolean; canListModels: boolean;
  docsUrl: string; notes: string | null; family: string; limits: { maxSeconds?: number; maxBytes?: number } | null; fields: CatalogField[]; hints: CatalogHint[];
}
export interface TestRecord { at: string; ok: boolean; code: string; message: string; latencyMs?: number }
export interface CredentialView { id: string; provider: string; label: string | null; mask: string; createdAt: string; rotatedAt: string | null; lastUsedAt: string | null; lastTest: TestRecord | null }
export interface ConnectionConfig {
  provider: string; base: string; model: string; modelSmall?: string; embeddingsModel?: string; visionModel?: string; language?: string; extra: Record<string, string>;
}
export interface FeatureState {
  feature: FeatureId; kind: Kind; supported: boolean; mode: "platform" | "user";
  config: ConnectionConfig | null; credential: CredentialView | null;
  fallbacks: { config: ConnectionConfig; credential: CredentialView | null }[];
  allowPlatformFallback: boolean; lastTest: TestRecord | null; updatedAt: string | null;
}
export interface Overview {
  vault: { ready: boolean; reason?: string | null };
  workspaceAllows: boolean;
  platformFallbackAvailable: boolean; platformSttFallbackAvailable: boolean; platformTranslateFallbackAvailable: boolean;
  catalog: CatalogProvider[]; sttCatalog: CatalogProvider[]; translateCatalog: CatalogProvider[];
  credentials: CredentialView[]; features: FeatureState[];
}

export const FEATURE_META: Record<FeatureId, { title: string; kind: Kind; blurb: string; covers: string[] }> = {
  intelligent: {
    title: "Intelligent Mode", kind: "chat",
    blurb: "The copilot, the plan and workflow assistants, analysis and report writing. Needs a model that follows structured (JSON) instructions.",
    covers: ["Copilot and Intelligent Mode", "Analysis, findings and report drafting", "Logic, quota and import assistants"],
  },
  additional: {
    title: "Other AI features", kind: "chat",
    blurb: "Everything else that asks a language model: rewording, classification, and “My AI model” translation. This connection is also what “My AI model” translation uses.",
    covers: ["Rewording and probing text", "Classification and sentiment", "Translation by “My AI model”"],
  },
  stt: {
    title: "Speech-to-text", kind: "stt",
    blurb: "Voice input in the Studio and transcripts of the media you upload. Interview and respondent recordings stay on the platform.",
    covers: ["Voice input to the copilot", "Media transcripts in your projects"],
  },
  translation: {
    title: "Translation", kind: "translate",
    blurb: "The Translation Manager. Use a translation service on your own key, or your own AI model. A translation service has no model to choose.",
    covers: ["Translation Manager strings"],
  },
};
export const FEATURE_ORDER: FeatureId[] = ["intelligent", "additional", "stt", "translation"];

/** every provider in every catalog, by id */
export function providerIndex(o: Pick<Overview, "catalog" | "sttCatalog" | "translateCatalog">): Map<string, CatalogProvider> {
  return new Map([...o.catalog, ...o.sttCatalog, ...o.translateCatalog].map((p) => [p.id, p]));
}
export const catalogFor = (o: Pick<Overview, "catalog" | "sttCatalog" | "translateCatalog">, kind: Kind): CatalogProvider[] => (kind === "chat" ? o.catalog : kind === "stt" ? o.sttCatalog : o.translateCatalog);

/** a key saved for provider `saved` may be offered to provider `wanted` only within one vendor family */
export function keysFor(o: Pick<Overview, "credentials" | "catalog" | "sttCatalog" | "translateCatalog">, providerId: string): CredentialView[] {
  const idx = providerIndex(o), want = idx.get(providerId);
  if (!want) return [];
  return o.credentials.filter((c) => c.provider === providerId || idx.get(c.provider)?.family === want.family);
}

/* ------------------------------------------------------------------ drafts */

export interface DraftFallback { provider: string; base: string; model: string; extra: Record<string, string>; credentialId: string | null; newKey: string }
export interface Draft {
  mode: "platform" | "user";
  provider: string; base: string; model: string; modelSmall: string; embeddingsModel: string; visionModel: string; language: string;
  extra: Record<string, string>;
  credentialId: string | null;
  /** the text of the key field — never prefilled; sent once with the save, then cleared */
  newKey: string;
  fallbacks: DraftFallback[];
  allowPlatformFallback: boolean;
}

export function emptyDraft(provider = ""): Draft {
  return { mode: "user", provider, base: "", model: "", modelSmall: "", embeddingsModel: "", visionModel: "", language: "", extra: {}, credentialId: null, newKey: "", fallbacks: [], allowPlatformFallback: false };
}

/** the draft that equals what is saved (a platform-managed feature has no connection fields) */
export function draftFromFeature(f: FeatureState): Draft {
  if (f.mode !== "user" || !f.config) return { ...emptyDraft(), mode: "platform" };
  const c = f.config;
  return {
    mode: "user", provider: c.provider, base: c.base ?? "", model: c.model ?? "", modelSmall: c.modelSmall ?? "", embeddingsModel: c.embeddingsModel ?? "", visionModel: c.visionModel ?? "", language: c.language ?? "",
    extra: { ...(c.extra ?? {}) }, credentialId: f.credential?.id ?? null, newKey: "",
    fallbacks: f.fallbacks.map((x) => ({ provider: x.config.provider, base: x.config.base ?? "", model: x.config.model ?? "", extra: { ...(x.config.extra ?? {}) }, credentialId: x.credential?.id ?? null, newKey: "" })),
    allowPlatformFallback: f.allowPlatformFallback,
  };
}

/** picking a provider resets what belongs to the previous one — a key, an address and identifiers never carry across vendors */
export function chooseProvider(d: Draft, def: CatalogProvider | undefined, keys: CredentialView[]): Draft {
  if (!def) return { ...d, provider: "", base: "", model: "", extra: {}, credentialId: null, newKey: "" };
  const reuse = keys.length === 1 ? keys[0].id : null;
  const translate = def.kind === "translate";
  return {
    ...d, provider: def.id, base: def.customBase ? "" : (def.base ?? ""), model: translate ? "" : (def.hints.find((h) => h.intelligent)?.id ?? ""), modelSmall: "", embeddingsModel: "", visionModel: "",
    language: "", extra: {}, credentialId: reuse, newKey: "",
    fallbacks: translate && def.id === "llm" ? [] : d.fallbacks,
  };
}

const norm = (v: string | undefined) => (v ?? "").trim();
const sameExtra = (a: Record<string, string>, b: Record<string, string>) => {
  const k = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const x of k) if (norm(a[x]) !== norm(b[x])) return false;
  return true;
};

/** which parts of a draft differ from what is saved — the screen marks each, and Save is offered only when there is one */
export function changes(d: Draft, saved: Draft): string[] {
  if (d.mode !== saved.mode) return ["mode"];
  if (d.mode === "platform") return [];
  const out: string[] = [];
  if (d.provider !== saved.provider) out.push("provider");
  if (norm(d.base) !== norm(saved.base)) out.push("base");
  if (norm(d.model) !== norm(saved.model)) out.push("model");
  if (norm(d.modelSmall) !== norm(saved.modelSmall)) out.push("modelSmall");
  if (norm(d.embeddingsModel) !== norm(saved.embeddingsModel)) out.push("embeddingsModel");
  if (norm(d.visionModel) !== norm(saved.visionModel)) out.push("visionModel");
  if (norm(d.language) !== norm(saved.language)) out.push("language");
  if (!sameExtra(d.extra, saved.extra)) out.push("extra");
  if (d.credentialId !== saved.credentialId) out.push("key");
  if (d.newKey.trim()) out.push("key");
  if (d.allowPlatformFallback !== saved.allowPlatformFallback) out.push("allowPlatformFallback");
  const a = d.fallbacks, b = saved.fallbacks;
  if (a.length !== b.length || a.some((x, i) => x.provider !== b[i].provider || x.model !== b[i].model || norm(x.base) !== norm(b[i].base) || x.credentialId !== b[i].credentialId || !!x.newKey.trim() || !sameExtra(x.extra, b[i].extra))) out.push("fallbacks");
  return [...new Set(out)];
}
export const isDirty = (d: Draft, saved: Draft) => changes(d, saved).length > 0;

/* ------------------------------------------------------------- validation */

/** quick, local checks so the screen can say what is missing before a round trip; the server's checks are authoritative */
export function problems(d: Draft, def: CatalogProvider | undefined, hasKeyFor: (provider: string) => boolean): Record<string, string> {
  const p: Record<string, string> = {};
  if (d.mode !== "user") return p;
  if (!def) { p.provider = "Choose a provider."; return p; }
  const chatReuse = def.kind === "translate" && def.id === "llm";
  if (def.customBase && !norm(d.base)) p.base = "Enter the provider's address (https://…).";
  if (def.kind !== "translate" && !norm(d.model)) p.model = "Choose or enter a model.";
  for (const f of def.fields) if (f.required && !norm(d.extra[f.id])) p[`extra.${f.id}`] = `${f.label} is required for ${def.label}.`;
  if (!chatReuse && !d.credentialId && !d.newKey.trim()) p.key = "Enter your API key.";
  if (d.newKey.trim() && /\s/.test(d.newKey.trim().replace(/^Bearer\s+/i, ""))) p.key = "An API key has no spaces.";
  d.fallbacks.forEach((f, i) => { if (!f.provider) p[`fallback.${i}.provider`] = "Choose a provider."; else if (!f.credentialId && !f.newKey.trim()) p[`fallback.${i}.key`] = "Enter this fallback's API key."; if (def.kind !== "translate" && f.provider && !norm(f.model)) p[`fallback.${i}.model`] = "Choose or enter a model."; });
  void hasKeyFor;
  return p;
}

/* ----------------------------------------------------------------- saving */

export interface ConfigBody { provider: string; base?: string; model?: string; modelSmall?: string; embeddingsModel?: string; visionModel?: string; language?: string; extra?: Record<string, string> }

function configBody(def: CatalogProvider | undefined, d: { provider: string; base: string; model: string; extra: Record<string, string> } & Partial<Draft>): ConfigBody {
  const body: ConfigBody = { provider: d.provider, extra: Object.fromEntries(Object.entries(d.extra).filter(([, v]) => norm(v))) };
  if (def?.customBase) body.base = norm(d.base);
  if (def?.kind !== "translate") body.model = norm(d.model);
  if (def?.kind === "chat") {
    if (norm(d.modelSmall)) body.modelSmall = norm(d.modelSmall);
    if (norm(d.embeddingsModel)) body.embeddingsModel = norm(d.embeddingsModel);
    if (norm(d.visionModel)) body.visionModel = norm(d.visionModel);
  }
  if (def?.kind === "stt" && norm(d.language)) body.language = norm(d.language);
  return body;
}

/**
 * The body of `PUT /api/account/ai` for a draft. Fallback keys typed into the
 * screen are saved first (see `fallbackKeysToSave`) and arrive here already
 * given an id through `fallbackIds`.
 */
export function saveBody(feature: FeatureId, d: Draft, idx: Map<string, CatalogProvider>, fallbackIds: (string | null)[] = []) {
  if (d.mode === "platform") return { feature, mode: "platform" as const };
  const def = idx.get(d.provider);
  return {
    feature, mode: "user" as const,
    config: configBody(def, d),
    ...(d.newKey.trim() ? { apiKey: d.newKey.trim() } : {}),
    ...(d.credentialId ? { credentialId: d.credentialId } : {}),
    fallbacks: d.fallbacks.map((f, i) => ({ credentialId: fallbackIds[i] ?? f.credentialId, config: configBody(idx.get(f.provider), f) })),
    allowPlatformFallback: d.allowPlatformFallback,
  };
}

/** the typed keys of fallback providers: saved through the credentials route before the setting names them */
export function fallbackKeysToSave(d: Draft): { index: number; provider: string; apiKey: string }[] {
  return d.fallbacks.map((f, index) => ({ index, provider: f.provider, apiKey: f.newKey.trim() })).filter((x) => x.apiKey);
}

/** the body of `POST /api/account/ai/test` for the draft as it stands, with a typed key or a saved one */
export function testBody(feature: FeatureId, d: Draft, idx: Map<string, CatalogProvider>) {
  const def = idx.get(d.provider);
  return {
    feature, config: configBody(def, d),
    ...(d.newKey.trim() ? { apiKey: d.newKey.trim() } : d.credentialId ? { credentialId: d.credentialId } : {}),
  };
}

/* -------------------------------------------------------------- wording */

export function modeWords(f: FeatureState, idx: Map<string, CatalogProvider>): { headline: string; detail: string } {
  if (f.mode !== "user" || !f.config) return { headline: "Platform AI", detail: "Provided and billed by the platform." };
  const def = idx.get(f.config.provider);
  const label = def?.label ?? f.config.provider;
  if (def?.kind === "translate" && def.id === "llm") return { headline: "Your own AI model", detail: "Translates with the connection saved under Other AI features." };
  const detail = def?.kind === "translate" ? `${label} · your own key` : `${label} · ${f.config.model} · your own key`;
  return { headline: "Your own provider", detail };
}

/** the one-line state of a connection test, in words */
export function testWords(t: TestRecord | null | undefined): { tone: "ok" | "bad" | "none"; text: string } {
  if (!t) return { tone: "none", text: "Not tested yet" };
  return { tone: t.ok ? "ok" : "bad", text: t.ok ? "Last test passed" : `Last test failed — ${t.message}` };
}

/** whether the platform's AI may be listed as a last resort for this kind of feature */
export function platformBackstopAvailable(o: Pick<Overview, "platformFallbackAvailable" | "platformSttFallbackAvailable" | "platformTranslateFallbackAvailable">, kind: Kind): boolean {
  return kind === "chat" ? o.platformFallbackAvailable : kind === "stt" ? o.platformSttFallbackAvailable : o.platformTranslateFallbackAvailable;
}

/** why a feature cannot be switched to the person's own provider right now, or null */
export function blockedReason(o: Pick<Overview, "vault" | "workspaceAllows">, f: Pick<FeatureState, "supported">): string | null {
  if (!o.workspaceAllows) return "Your workspace administrator has turned off user-managed AI providers.";
  if (!o.vault.ready) return o.vault.reason ?? "Saving your own API key is not enabled on this installation.";
  if (!f.supported) return "Using your own provider is not available for this feature yet.";
  return null;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
}
