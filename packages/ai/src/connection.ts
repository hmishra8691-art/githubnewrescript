import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { guardedFetch } from "./netguard.js";

/**
 * WHOSE PROVIDER IS THIS CALL GOING TO? — the per-request connection scope.
 *
 * Every function in this package used to read ONE provider out of
 * `process.env` at call time: the installation's. A user-owned provider
 * (their own key, their own model) needs the same functions to talk to a
 * DIFFERENT provider for one request, without changing the ~40 call sites'
 * signatures and — more importantly — without any call site being able to
 * forget to say whose provider it is.
 *
 * So the choice rides in an AsyncLocalStorage scope, exactly as usage
 * reporting does (`collectUsage`). The Studio's one billing door
 * (`meteredAi`/`meteredStt`/`meteredTranslation`) resolves the acting user's
 * configuration and runs the work inside `withAiScope(scope, fn)`. Inside the
 * scope:
 *
 *   - the base URL, key, model, extra headers and fallbacks come from the
 *     scope, and the installation's environment is NOT consulted — a user's
 *     provider never receives the platform's workspace id or headers, and a
 *     user's failure never falls through to the platform's key or the
 *     operator's fallback provider;
 *   - requests go through `guardedFetch` (SSRF-safe, pinned, no redirects);
 *   - `aiIdentity()` names the connection (a hash, never the key), so every
 *     cache, in-flight share and memory keyed on a request can include it and
 *     one user's answer is never served to another.
 *
 * Outside a scope nothing changes: the environment is the provider.
 */

/** one place a request can go */
export interface Target {
  /** registry id: openai, anthropic, google-gemini, openai-compatible… (`platform` for the installation's own) */
  provider: string;
  /** API base URL, no trailing slash */
  base: string;
  /** the credential — in memory for this request only, never logged, never returned */
  key: string;
  model: string;
  modelSmall?: string;
  embeddingsModel?: string | null;
  visionModel?: string;
  /** extra headers the provider needs (workspace, organization, project…), already whitelisted */
  headers?: Record<string, string>;
  /** the installation's own provider, offered as a last resort the user explicitly allowed */
  platform?: boolean;
  /** shown in the usage record, e.g. "OpenAI · gpt-4.1" */
  label?: string;
}

export type ConnectionSource = "user" | "project" | "platform";

export interface ChatScope extends Target {
  source: ConnectionSource;
  /** tried in order after this one fails in a way another provider can cure — and nowhere else */
  fallbacks: Target[];
  /** speech output model (OpenAI-compatible `/audio/speech`) */
  ttsModel?: string;
}

export interface SttTarget {
  provider: string;
  base: string;
  key: string;
  model: string;
  headers?: Record<string, string>;
  platform?: boolean;
  label?: string;
}
export interface SttScope extends SttTarget {
  source: ConnectionSource;
  fallbacks: SttTarget[];
  /** the user's preferred language / transcription hint */
  language?: string;
}

export interface AiScope {
  chat?: ChatScope;
  stt?: SttScope;
  /** the operator allowed private endpoints in the SERVER environment (never a user input) */
  allowPrivate?: boolean;
}

const store = new AsyncLocalStorage<AiScope>();

/** Run `fn` with this scope. Nested scopes replace the outer one for the features they name. */
export function withAiScope<T>(scope: AiScope, fn: () => Promise<T>): Promise<T> {
  const outer = store.getStore();
  return store.run({ ...outer, ...scope, allowPrivate: scope.allowPrivate ?? outer?.allowPrivate }, fn);
}

export function currentAiScope(): AiScope | undefined {
  return store.getStore();
}

const short = (h: string) => h.slice(0, 16);
const hashKey = (key: string) => createHash("sha256").update(`rescript-ai-identity\0${key}`).digest("hex");

/** a stable name for a connection that contains no secret: provider, address, model and a hash of the key */
export function identityOf(t: { provider: string; base: string; key: string; model: string }): string {
  return short(createHash("sha256").update(`${t.provider}\0${t.base}\0${t.model}\0${hashKey(t.key)}`).digest("hex"));
}

/** "platform" outside a scope, else the connection's identity — include it in every cache and in-flight key */
export function aiIdentity(kind: "chat" | "stt" = "chat"): string {
  const s = store.getStore()?.[kind];
  return s ? `${kind}:${s.source}:${identityOf(s)}` : "platform";
}

/** are we inside a user's connection (chat or stt)? — the guard, the header rules and the fallback rules all key on this */
export function scopedProvider(kind: "chat" | "stt" = "chat"): boolean {
  const s = store.getStore()?.[kind];
  return !!s && s.source !== "platform";
}

/**
 * `fetch` for the provider this call is going to: the installation's, through
 * the platform `fetch`; a user's, through the endpoint guard.
 */
export function aiFetch(kind: "chat" | "stt", url: string, init: RequestInit): Promise<Response> {
  if (scopedProvider(kind)) return guardedFetch(url, init, { allowPrivate: store.getStore()?.allowPrivate });
  return fetch(url, init);
}

/** a connection's secret-free summary: safe to log and to return */
export function describeScope(kind: "chat" | "stt" = "chat"): { source: ConnectionSource; provider: string; model: string; label?: string } | null {
  const s = store.getStore()?.[kind];
  return s ? { source: s.source, provider: s.provider, model: s.model, ...(s.label ? { label: s.label } : {}) } : null;
}
