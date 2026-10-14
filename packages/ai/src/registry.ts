import { validateEndpoint, guardedFetch } from "./netguard.js";
import { redact } from "./provider.js";

/**
 * THE PROVIDER REGISTRY — what a user can connect, and what each needs.
 *
 * One typed entry per provider: its address, how it authenticates, which
 * extra identifiers it takes (and which header carries each), what it can do,
 * and how its models are listed. The settings screen, the validator, the
 * resolver and the connection test all READ this; none of them names a
 * provider. Adding a provider that speaks a protocol we already have is one
 * entry here; one that speaks a new protocol is an entry plus an adapter.
 *
 * ONLY WHAT WORKS IS LISTED. An entry exists when the Studio has an adapter
 * that can call it and a test that proves so; the registry grows with the
 * adapters (chat today; speech-to-text and translation as theirs ship). A
 * model is never advertised as available because we remember its name — it is
 * shown when the provider's own list returned it, or as a SUGGESTION the
 * Test Connection step then confirms against the user's account.
 */

export type Capability = "chat" | "json_schema" | "json_object" | "embeddings" | "vision" | "stt" | "tts" | "translate";
export type ProviderKind = "chat" | "stt" | "translate";
/** the wire protocol an adapter speaks */
export type Protocol = "openai-chat";

export interface ProviderField {
  /** the key in the stored configuration */
  id: "organizationId" | "projectId" | "workspaceId";
  label: string;
  help: string;
  required: boolean;
  /** the request header that carries it */
  header: string;
  /** an identifier's shape — a typo caught on the form, not as a provider error */
  pattern: RegExp;
  example: string;
}

export interface ModelHint {
  id: string;
  label: string;
  capabilities: Capability[];
  /** suited to Intelligent Mode's structured, long-context work — a suggestion the connection test confirms */
  intelligent?: boolean;
}

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  protocol: Protocol;
  /** what the endpoint can do (models differ; see `ModelHint`) */
  capabilities: Capability[];
  /** the provider's own address; users cannot change it unless `customBase` */
  base: string | null;
  customBase: boolean;
  /** how a key is sent when the models are listed (chat uses `Authorization: Bearer` on every provider here) */
  discovery: { path: string; headers: (key: string) => Record<string, string> } | null;
  fields: ProviderField[];
  /** suggestions, not promises */
  hints: ModelHint[];
  docsUrl: string;
  notes?: string;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const ID = /^[A-Za-z0-9_.:-]{3,100}$/;

const chat = (o: Partial<ProviderDef> & Pick<ProviderDef, "id" | "label" | "base" | "docsUrl">): ProviderDef => ({
  kind: "chat", protocol: "openai-chat", capabilities: ["chat", "json_object"], customBase: false,
  discovery: { path: "/models", headers: bearer }, fields: [], hints: [], ...o,
});

export const PROVIDERS: ProviderDef[] = [
  chat({
    id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", docsUrl: "https://platform.openai.com/api-keys",
    capabilities: ["chat", "json_schema", "json_object", "embeddings", "vision", "tts"],
    fields: [
      { id: "organizationId", label: "Organization ID", help: "Only needed if your key belongs to several organizations.", required: false, header: "OpenAI-Organization", pattern: ID, example: "org-…" },
      { id: "projectId", label: "Project ID", help: "Only needed to bill a specific project.", required: false, header: "OpenAI-Project", pattern: ID, example: "proj_…" },
    ],
    hints: [
      { id: "gpt-4.1", label: "GPT-4.1", capabilities: ["chat", "json_schema", "vision"], intelligent: true },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", capabilities: ["chat", "json_schema", "vision"], intelligent: true },
      { id: "gpt-4o", label: "GPT-4o", capabilities: ["chat", "json_schema", "vision"], intelligent: true },
      { id: "gpt-4o-mini", label: "GPT-4o mini", capabilities: ["chat", "json_schema", "vision"], intelligent: true },
    ],
  }),
  chat({
    id: "anthropic", label: "Anthropic", base: "https://api.anthropic.com/v1", docsUrl: "https://console.anthropic.com/settings/keys",
    capabilities: ["chat", "json_schema", "vision"],
    discovery: { path: "/models", headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }) },
    fields: [{ id: "workspaceId", label: "Workspace ID", help: "Needed when your key is not scoped to one workspace (Anthropic then refuses requests that do not name it).", required: false, header: "anthropic-workspace-id", pattern: ID, example: "wrkspc_…" }],
    notes: "Chat only. Anthropic has no speech-to-text or embeddings endpoint.",
  }),
  chat({
    id: "google-gemini", label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", docsUrl: "https://aistudio.google.com/apikey",
    capabilities: ["chat", "json_schema", "json_object", "embeddings", "vision"],
  }),
  chat({ id: "openrouter", label: "OpenRouter", base: "https://openrouter.ai/api/v1", docsUrl: "https://openrouter.ai/keys", notes: "One key for many vendors' models; the model id names the vendor (vendor/model)." }),
  chat({ id: "groq", label: "Groq", base: "https://api.groq.com/openai/v1", docsUrl: "https://console.groq.com/keys" }),
  chat({ id: "mistral", label: "Mistral", base: "https://api.mistral.ai/v1", docsUrl: "https://console.mistral.ai/api-keys", capabilities: ["chat", "json_object", "embeddings"] }),
  chat({ id: "deepseek", label: "DeepSeek", base: "https://api.deepseek.com/v1", docsUrl: "https://platform.deepseek.com/api_keys" }),
  chat({ id: "together", label: "Together AI", base: "https://api.together.xyz/v1", docsUrl: "https://api.together.xyz/settings/api-keys" }),
  chat({ id: "xai", label: "xAI", base: "https://api.x.ai/v1", docsUrl: "https://console.x.ai" }),
  chat({
    id: "openai-compatible", label: "Other (OpenAI-compatible)", base: null, customBase: true, docsUrl: "",
    notes: "Any service that speaks the OpenAI chat-completions protocol at a public https address — a hosted gateway or your own server. The connection test checks what it supports.",
  }),
];

export const providerById = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id);
export const providersOf = (kind: ProviderKind): ProviderDef[] => PROVIDERS.filter((p) => p.kind === kind);

/** what the settings screen is told about the catalog: everything but functions */
export function publicCatalog(kind: ProviderKind) {
  return providersOf(kind).map((p) => ({
    id: p.id, label: p.label, kind: p.kind, capabilities: p.capabilities, base: p.base, customBase: p.customBase,
    canListModels: !!p.discovery, docsUrl: p.docsUrl, notes: p.notes ?? null,
    fields: p.fields.map((f) => ({ id: f.id, label: f.label, help: f.help, required: f.required, example: f.example })),
    hints: p.hints,
  }));
}

/* --------------------------------------------------------------- validation */

export interface ConnectionInput {
  provider?: unknown; base?: unknown; model?: unknown; modelSmall?: unknown; embeddingsModel?: unknown; visionModel?: unknown;
  extra?: unknown;
}
export interface ConnectionConfig {
  provider: string; base: string; model: string; modelSmall?: string; embeddingsModel?: string; visionModel?: string;
  /** the registry's optional identifiers, by field id */
  extra: Record<string, string>;
}
export type FieldErrors = Partial<Record<"provider" | "base" | "model" | "modelSmall" | "embeddingsModel" | "visionModel" | "extra", string>> & Record<string, string>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

/**
 * A configuration the user typed, checked against the registry and made
 * canonical. A fixed provider's address is the registry's — whatever was sent
 * is ignored, so a tampered form cannot aim a "known" provider elsewhere.
 * Only a custom provider's address comes from the user, and then it must pass
 * the endpoint guard.
 */
export function validateConnection(kind: ProviderKind, input: ConnectionInput, opts: { allowPrivate?: boolean } = {}): { ok: true; config: ConnectionConfig } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const def = typeof input.provider === "string" ? providerById(input.provider) : undefined;
  if (!def || def.kind !== kind) { errors.provider = "Choose a provider from the list."; return { ok: false, errors }; }
  let base = def.base ?? "";
  if (def.customBase) {
    const chk = validateEndpoint(String(input.base ?? ""), { allowPrivate: opts.allowPrivate });
    if (!chk.ok) errors.base = chk.message; else base = chk.base;
  }
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) errors.model = "Choose or enter a model."; else if (!MODEL_ID.test(model)) errors.model = "That model name has characters a model id never contains.";
  const optionalModel = (k: "modelSmall" | "embeddingsModel" | "visionModel") => {
    const v = typeof input[k] === "string" ? (input[k] as string).trim() : "";
    if (v && !MODEL_ID.test(v)) errors[k] = "That model name has characters a model id never contains.";
    return v || undefined;
  };
  const modelSmall = optionalModel("modelSmall"), embeddingsModel = optionalModel("embeddingsModel"), visionModel = optionalModel("visionModel");
  const extra: Record<string, string> = {};
  const given = input.extra && typeof input.extra === "object" ? input.extra as Record<string, unknown> : {};
  for (const f of def.fields) {
    const v = typeof given[f.id] === "string" ? (given[f.id] as string).trim() : "";
    if (!v) { if (f.required) errors[`extra.${f.id}`] = `${f.label} is required for ${def.label}.`; continue; }
    if (!f.pattern.test(v)) errors[`extra.${f.id}`] = `That does not look like a ${f.label} (for example ${f.example}).`; else extra[f.id] = v;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, config: { provider: def.id, base, model, ...(modelSmall ? { modelSmall } : {}), ...(embeddingsModel ? { embeddingsModel } : {}), ...(visionModel ? { visionModel } : {}), extra } };
}

/** the request headers a configuration's identifiers become — a closed set named by the registry, never free text */
export function headersFor(def: ProviderDef, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of def.fields) if (extra[f.id]) out[f.header.toLowerCase()] = extra[f.id];
  return out;
}

/* ----------------------------------------------------------------- models */

export interface ModelInfo { id: string; label: string; capabilities: Capability[]; intelligent: boolean; source: "provider" | "suggestion" }

/** capability tags a model id implies — a hint for the picker; the connection test is what confirms */
export function inferCapabilities(id: string): Capability[] {
  const s = id.toLowerCase();
  if (/embed/.test(s)) return ["embeddings"];
  if (/whisper|transcribe|\bstt\b|speech-to-text/.test(s)) return ["stt"];
  if (/(^|[-_/])tts([-_/]|$)|text-to-speech/.test(s)) return ["tts"];
  if (/dall-e|image|imagen|moderation|rerank|guard|realtime|audio|video|sora/.test(s)) return [];
  const caps: Capability[] = ["chat"];
  if (/gpt-4|gpt-5|o\d|claude|gemini|llama|mistral|mixtral|qwen|deepseek|grok/.test(s)) caps.push("json_object");
  if (/vision|gpt-4|gpt-5|claude|gemini|pixtral|llava/.test(s)) caps.push("vision");
  return caps;
}

export function suggestionsFor(def: ProviderDef): ModelInfo[] {
  return def.hints.map((h) => ({ id: h.id, label: h.label, capabilities: h.capabilities, intelligent: !!h.intelligent, source: "suggestion" as const }));
}

export interface DiscoverResult { ok: boolean; models: ModelInfo[]; reason?: "unsupported" | "auth" | "forbidden" | "unreachable" | "invalid_endpoint" | "unexpected" | "timeout" | "rate_limited"; message?: string }

/**
 * Ask the provider which models this key can use. A failure is a reason the
 * screen can say in words, never the provider's body. The list is the
 * provider's own, so what it names exists for THIS key.
 */
export async function discoverModels(def: ProviderDef, base: string, key: string, headers: Record<string, string>, opts: { allowPrivate?: boolean; timeoutMs?: number; fetcher?: typeof guardedFetch } = {}): Promise<DiscoverResult> {
  if (!def.discovery) return { ok: false, models: suggestionsFor(def), reason: "unsupported", message: `${def.label} does not offer a model list; enter the model name.` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const r = await (opts.fetcher ?? guardedFetch)(`${base}${def.discovery.path}`, { method: "GET", signal: ctrl.signal, headers: { ...headers, ...def.discovery.headers(key) } }, { allowPrivate: opts.allowPrivate, maxResponseBytes: 4 * 1024 * 1024 });
    if (r.status === 401) return { ok: false, models: [], reason: "auth", message: "The provider rejected the API key." };
    if (r.status === 403) return { ok: false, models: [], reason: "forbidden", message: "The provider refused this key permission to list models." };
    if (r.status === 429) return { ok: false, models: [], reason: "rate_limited", message: "The provider is rate-limiting this key right now." };
    if (r.status === 404 || r.status === 405) return { ok: false, models: suggestionsFor(def), reason: "unsupported", message: "This provider does not list its models; enter the model name." };
    if (!r.ok) return { ok: false, models: [], reason: "unexpected", message: "The provider could not list its models." };
    const j = (await r.json().catch(() => null)) as { data?: unknown } | null;
    const rows = Array.isArray(j?.data) ? j!.data as { id?: unknown; display_name?: unknown }[] : Array.isArray(j) ? j as { id?: unknown }[] : null;
    if (!rows) return { ok: false, models: [], reason: "unexpected", message: "The provider's model list was not in a format the Studio reads." };
    const hint = new Map(def.hints.map((h) => [h.id, h]));
    const models = rows.filter((m): m is { id: string; display_name?: unknown } => typeof m?.id === "string" && !!m.id).slice(0, 500).map((m) => {
      const id = m.id.replace(/^models\//, "");
      const h = hint.get(id);
      const caps = h?.capabilities ?? inferCapabilities(id);
      return { id, label: typeof m.display_name === "string" && m.display_name ? m.display_name : h?.label ?? id, capabilities: caps, intelligent: !!h?.intelligent || (caps.includes("chat") && caps.includes("json_object")), source: "provider" as const };
    }).sort((a, b) => Number(b.capabilities.includes("chat")) - Number(a.capabilities.includes("chat")) || a.id.localeCompare(b.id));
    return { ok: true, models };
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "AbortError") return { ok: false, models: [], reason: "timeout", message: "The provider did not answer in time." };
    if (name === "EndpointRefused") return { ok: false, models: [], reason: "invalid_endpoint", message: redact((e as Error).message, 200) };
    return { ok: false, models: [], reason: "unreachable", message: "The provider could not be reached." };
  } finally { clearTimeout(timer); }
}
