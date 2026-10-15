import { placeholdersIn } from "@rescript/engine";
import type { TranslateItem, TranslateOptions } from "./index.js";

/**
 * THE SHARED PARTS OF TRANSLATION — what every provider, platform or user's own,
 * is held to: one error vocabulary, one placeholder grammar, one glossary rule.
 * Nothing here knows a provider; `translation.ts` (selection, cache, manager)
 * and `translateServices.ts` (the services' wire protocols) both stand on it.
 */

export type TranslationErrorCode = "auth" | "quota" | "rate_limit" | "unsupported_language" | "invalid" | "network" | "timeout" | "unavailable" | "unconfigured";

export class TranslationProviderError extends Error {
  /** what was translated (and paid for) before the failure — the manager keeps it instead of throwing it away */
  partial?: Record<string, string>;
  constructor(public code: TranslationErrorCode, message: string, public retryable: boolean, public status?: number) { super(message); }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable }; }
}

export const FRIENDLY: Record<TranslationErrorCode, string> = {
  auth: "The translation provider rejected the credentials. Check the API key configured on the server.",
  quota: "The translation provider's quota is used up for now. Try again later or raise the quota in the provider console.",
  rate_limit: "The translation provider is rate-limiting requests. The remaining strings will be retried more slowly.",
  unsupported_language: "The translation provider does not support this language pair.",
  invalid: "The provider refused the request — usually a string too long or an unsupported format.",
  network: "The translation provider could not be reached.",
  timeout: "The translation provider took too long to answer.",
  unavailable: "The translation provider is temporarily unavailable.",
  unconfigured: "No translation provider is configured on this server.",
};

/** a failure on the USER'S OWN provider is theirs to fix in Settings — never "ask your administrator" or the server's environment */
export function ownFailure(code: TranslationErrorCode, label: string, status?: number, hint = ""): string {
  const where = "Settings → AI & Integrations → AI Provider Configuration";
  switch (code) {
    case "auth": return `Your translation provider (${label}) rejected the API key${status ? ` (${status})` : ""} — check it in ${where}.${hint}`;
    case "quota": return `Your translation provider (${label}) says this account's quota or credit is used up. Raise the quota or add credit with ${label}.`;
    case "rate_limit": return `${label} is rate-limiting your key right now. The remaining strings will be retried more slowly.`;
    case "unsupported_language": return `${label} does not support this language pair.`;
    case "invalid": return `${label} refused the request — usually a string too long or an unsupported format.`;
    case "network": return `${label} could not be reached from the Studio.`;
    case "timeout": return `${label} took too long to answer.`;
    case "unavailable": return `${label} is temporarily unavailable.`;
    default: return `Your translation provider (${label}) is not set up — check ${where}.`;
  }
}

export const RETRYABLE: Record<TranslationErrorCode, boolean> = { auth: false, quota: true, rate_limit: true, unsupported_language: false, invalid: false, network: true, timeout: true, unavailable: true, unconfigured: false };

/** a failure another provider could cure — the only kind a listed fallback is tried for. A request the provider found malformed is not forwarded. */
export const FALLBACKABLE: ReadonlySet<TranslationErrorCode> = new Set<TranslationErrorCode>(["auth", "quota", "rate_limit", "unsupported_language", "network", "timeout", "unavailable"]);

export interface SupportedLanguage { code: string; name?: string }

export type TranslationAdapterId = "google" | "llm" | "fake" | "deepl" | "azure" | "llm-own";

export interface TranslationAdapter {
  readonly id: TranslationAdapterId;
  readonly name: string;
  configured(): boolean;
  /** the provider's own list, or null when it has none to offer */
  supportedLanguages(): Promise<SupportedLanguage[] | null>;
  /** how this provider spells a library language code, lower-cased, as it appears in `supportedLanguages()` (default: Google's) */
  languageKey?(code: string): string;
  /** translate the given strings; keys map to translations; strings the provider could not handle are absent */
  translate(items: TranslateItem[], opts: TranslateOptions): Promise<Record<string, string>>;
}

/* --------------------------------------------------------- placeholders */

/**
 * LIFT OUT what must never be translated and put it back afterwards. WHAT
 * that is comes from the engine's one placeholder grammar (`placeholdersIn`,
 * packages/engine/src/placeholders.ts) — the same tokens the engine's lint
 * checks and `set_translations` refuses to lose: `{{Q1}}` pipes, `${brand}`,
 * `[[loop.item]]`, every `{label}`-style parameter, and the question codes
 * (`Q7`, `Q7.R1`) the source names. The marker is a `translate="no"` span (or,
 * for a service that ignores a named tag, `<x>`) with a language-neutral token,
 * which a provider's HTML mode leaves alone and which survives a machine that
 * ignores the attribute; `restore` finds the tokens even if a provider moved
 * or spaced them, and reports when one went missing so the caller can drop
 * that string rather than store a broken one. Every provider goes through this.
 */
/** @deprecated the grammar is the engine's `placeholdersIn`; kept for callers that tested a string against it */
export const PROTECT_RE = /\{\{[^}]+\}\}|\$\{[^}]+\}|\{\w+\}|\[\[[^\]]+\]\]/g;

export type Marker = "span" | "x";
const wrapToken = (marker: Marker, n: number) => (marker === "x" ? `<x>RSV${n}RSV</x>` : `<span translate="no" class="notranslate">RSV${n}RSV</span>`);

export function protectPlaceholders(text: string, marker: Marker = "span"): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  let out = "", at = 0;
  for (const p of placeholdersIn(text)) {
    out += text.slice(at, p.start);
    tokens.push(p.text);
    out += wrapToken(marker, tokens.length - 1);
    at = p.end;
  }
  return { text: out + text.slice(at), tokens };
}

export function restorePlaceholders(translated: string, tokens: string[]): { text: string; complete: boolean } {
  let seen = 0;
  let out = translated.replace(/<(span|x)\b[^>]*>\s*RSV\s*(\d+)\s*RSV\s*<\/\1>|RSV\s*(\d+)\s*RSV/gi, (_m, _t, a, b) => { seen++; const i = Number(a ?? b); return tokens[i] ?? ""; });
  out = out.replace(/\s+([,.;:!?])/g, "$1");
  return { text: out, complete: seen === tokens.length && tokens.every((t) => out.includes(t)) };
}

const HTML_ENTITIES: Record<string, string> = { "&#39;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#34;": '"', "&nbsp;": " " };
/** HTML mode returns entities; a source that had no markup wants plain characters back. */
export function unescapeIfPlain(source: string, translated: string): string {
  if (/<[a-zA-Z][^>]*>/.test(source)) return translated;
  return translated.replace(/&#39;|&quot;|&amp;|&lt;|&gt;|&#34;|&nbsp;/g, (m) => HTML_ENTITIES[m] ?? m);
}

/* ------------------------------------------------------------- glossary */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Glossary terms that must not be translated are wrapped so the provider leaves them; preferred wordings are enforced afterwards. */
export function applyDoNotTranslate(text: string, opts: TranslateOptions, marker: Marker = "span"): string {
  let out = text;
  for (const g of opts.glossary ?? []) {
    if (!g.source.trim() || g.source !== g.target) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${esc(g.source)})(?=$|[^\\p{L}\\p{N}_])`, "giu");
    out = out.replace(re, (_, pre, term) => `${pre}${marker === "x" ? `<x class="rs-dnt">${term}</x>` : `<span translate="no" class="notranslate rs-dnt">${term}</span>`}`);
  }
  return out;
}
export function stripDoNotTranslate(text: string): string {
  return text.replace(/<(span|x)[^>]*rs-dnt[^>]*>([\s\S]*?)<\/\1>/gi, "$2");
}
export function applyGlossaryTargets(text: string, opts: TranslateOptions): string {
  let out = text;
  for (const g of opts.glossary ?? []) {
    if (!g.source.trim() || g.source === g.target || !g.target.trim()) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(g.source)}(?=$|[^\\p{L}\\p{N}_])`, "giu");
    out = out.replace(re, (_, pre) => `${pre}${g.target}`);
  }
  return out;
}

/** Our language code + locale → what Google expects (zh needs its script variant; everything else the base code). */
export function googleLanguageCode(code: string, locale?: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0];
  if (base === "zh") {
    const tag = (locale ?? code).toLowerCase();
    return /tw|hk|hant/.test(tag) ? "zh-TW" : "zh-CN";
  }
  if (base === "fil" || base === "tl") return "tl";
  if (base === "nb" || base === "nn") return "no";
  if (base === "he") return "iw";
  return base;
}
