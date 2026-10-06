import type { Condition, GlossaryEntry, LanguageConfig, Localization, SurveyDefinition, TranslationEntry } from "@rescript/schema";
import { LANGUAGE_LIBRARY, LANGUAGE_ROUTING_MODES, LANGUAGE_STATUSES } from "@rescript/schema";
import type { IdMinter } from "./questionOps.js";
import {
  effectiveLocalization, translatableElements, recordTranslation, setTranslationStatus, confirmTranslation, glossaryFor, languageName, languageReady,
  lintLanguage, surveyLanguages, textHash, type TranslatableElement,
} from "./localization.js";
import { stripHtmlText } from "./html.js";
import { placeholderMismatch, wrongScript } from "./placeholders.js";

/**
 * THE LOCALIZATION ACTIONS — how the copilot (and the Studio's own buttons)
 * write the survey's languages, translations, glossary and language routing.
 *
 * Like the survey, UX and analysis actions: a closed vocabulary, a gate that
 * reads the model's JSON into typed actions or refuses them with a reason,
 * and an apply step that resolves every target against the real survey and
 * refuses what would break a respondent's experience. They write
 * `def.localization` (and `deployment.languages`) and nothing else: no
 * action here can change a question, an option code, a condition or a
 * variable — "only the respondent-facing language changes".
 *
 *   add_language / remove_language / set_language_status
 *   set_translations        the model's own translations, element by element;
 *                           a translation that drops a piping token, breaks
 *                           the HTML, empties the text or translates a
 *                           do-not-translate term is refused; an approved
 *                           translation is kept unless overwriteApproved
 *   approve_translations    lock (approve / review) what is there
 *   confirm_translations    an outdated translation still fits the new source
 *   set_language_routing    "US → English, Mexico → Spanish", the URL
 *                           parameter, the order of precedence, the fallback
 *   set_glossary            preferred terms and brand names never translated
 */

export type TranslationTarget = string;
export interface TranslationSpec { target: TranslationTarget; text: string }

export type LocalizationAction =
  | { op: "add_language"; code: string; locale?: string; country?: string; name?: string; notes?: string; enabled?: boolean }
  | { op: "remove_language"; code: string }
  | { op: "set_language_status"; code: string; status?: (typeof LANGUAGE_STATUSES)[number]; enabled?: boolean }
  | { op: "set_translations"; language: string; entries: TranslationSpec[]; status?: "ai" | "edited"; overwriteApproved?: boolean }
  | { op: "approve_translations"; language: string; targets?: TranslationTarget[]; status?: "approved" | "reviewed" }
  | { op: "confirm_translations"; language: string; targets?: TranslationTarget[] }
  | { op: "set_language_routing"; order?: string[]; urlParam?: string; embeddedField?: string; countryMap?: Record<string, string>; rules?: { when: string | Condition; language: string; label?: string }[]; allowSwitch?: boolean; fallback?: string; merge?: boolean }
  | { op: "set_glossary"; entries?: { source: string; targets?: Record<string, string>; doNotTranslate?: boolean; notes?: string }[]; remove?: string[] };

/**
 * Within one batch the language must exist before anything is written into
 * it, the glossary before the translations it checks, the translations
 * before their approval, and a status or the routing last — whatever order
 * the model listed them in. 0 first.
 */
export function localizationRank(op: string): number {
  switch (op) {
    case "add_language": return 0;
    case "set_glossary": return 1;
    case "approve_translations": case "confirm_translations": return 3;
    case "set_language_status": case "set_language_routing": return 4;
    case "remove_language": return 5;
    default: return 2; // set_translations
  }
}

export const LOCALIZATION_ACTION_OPS = [
  "add_language", "remove_language", "set_language_status", "set_translations", "approve_translations", "confirm_translations", "set_language_routing", "set_glossary",
] as const;
const OPS = new Set<string>(LOCALIZATION_ACTION_OPS);
export const isLocalizationOp = (op: string): boolean => OPS.has(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const strs = (v: unknown, max = 60): string[] | undefined => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, max) : undefined);
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const langCode = (v: unknown): string | undefined => { const s = str(v, 12); if (!s) return undefined; const c = s.replace(/_/g, "-"); return LANG_RE.test(c) ? c.split("-")[0].toLowerCase() + (c.includes("-") ? "-" + c.split("-").slice(1).join("-") : "") : undefined; };
const base = (code: string) => code.split("-")[0].toLowerCase();

/** The model's JSON as a typed action, a reason it was refused, or null when the op is not one of ours. */
export function coerceLocalizationAction(op: string, o: Record<string, unknown>): LocalizationAction | string | null {
  switch (op) {
    case "add_language": {
      const raw = langCode(o.code ?? o.language);
      if (!raw) return "add_language needs a language code (de, es-MX, hi)";
      const code = base(raw);
      const locale = str(o.locale, 12) ?? (raw.includes("-") ? raw : undefined);
      return { op, code, ...(locale ? { locale } : {}), ...(str(o.country, 2) ? { country: str(o.country, 2)!.toUpperCase() } : {}), ...(str(o.name, 60) ? { name: str(o.name, 60) } : {}), ...(str(o.notes, 600) ? { notes: str(o.notes, 600) } : {}), ...(typeof o.enabled === "boolean" ? { enabled: o.enabled } : {}) };
    }
    case "remove_language": { const code = langCode(o.code ?? o.language); return code ? { op, code: base(code) } : "remove_language needs a language code"; }
    case "set_language_status": {
      const code = langCode(o.code ?? o.language); if (!code) return "set_language_status needs a language code";
      const status = str(o.status);
      if (status && !(LANGUAGE_STATUSES as readonly string[]).includes(status)) return `“${status}” is not a language status (${LANGUAGE_STATUSES.join(", ")})`;
      if (!status && typeof o.enabled !== "boolean") return "set_language_status needs a status or enabled";
      return { op, code: base(code), ...(status ? { status: status as (typeof LANGUAGE_STATUSES)[number] } : {}), ...(typeof o.enabled === "boolean" ? { enabled: o.enabled } : {}) };
    }
    case "set_translations": {
      const code = langCode(o.language ?? o.lang ?? o.code); if (!code) return "set_translations needs a language";
      const entries = Array.isArray(o.entries ?? o.translations) ? (o.entries ?? o.translations as unknown[]) as unknown[] : [];
      const list: TranslationSpec[] = entries.map((e) => { const x = (e ?? {}) as Record<string, unknown>; const target = str(x.target ?? x.key ?? x.element, 120); const text = typeof x.text === "string" ? x.text.slice(0, 8000) : typeof x.translation === "string" ? x.translation.slice(0, 8000) : undefined; return target && text !== undefined ? { target, text } : null; }).filter((x): x is TranslationSpec => !!x).slice(0, 400);
      if (!list.length) return "set_translations needs entries with target and text";
      const status = str(o.status);
      return { op, language: base(code), entries: list, ...(status === "edited" ? { status: "edited" as const } : {}), ...(o.overwriteApproved === true ? { overwriteApproved: true } : {}) };
    }
    case "approve_translations": case "confirm_translations": {
      const code = langCode(o.language ?? o.lang ?? o.code); if (!code) return `${op} needs a language`;
      const targets = strs(o.targets ?? o.elements, 400);
      if (op === "approve_translations") { const status = str(o.status); return { op, language: base(code), ...(targets ? { targets } : {}), ...(status === "reviewed" ? { status: "reviewed" as const } : {}) }; }
      return { op, language: base(code), ...(targets ? { targets } : {}) };
    }
    case "set_language_routing": {
      const a: LocalizationAction = { op, merge: o.merge !== false };
      const order = strs(o.order ?? o.precedence, 10)?.map((x) => x.toLowerCase());
      if (order) { const bad = order.find((x) => !(LANGUAGE_ROUTING_MODES as readonly string[]).includes(x)); if (bad) return `“${bad}” is not a language-routing mode (${LANGUAGE_ROUTING_MODES.join(", ")})`; a.order = order; }
      if (str(o.urlParam ?? o.url_param, 40)) a.urlParam = str(o.urlParam ?? o.url_param, 40);
      if (str(o.embeddedField ?? o.embedded_field, 60)) a.embeddedField = str(o.embeddedField ?? o.embedded_field, 60);
      const cm = (o.countryMap ?? o.country_map ?? o.countries) as unknown;
      if (cm && typeof cm === "object" && !Array.isArray(cm)) {
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(cm as Record<string, unknown>)) { const c = str(k, 3)?.toUpperCase(); const l = langCode(v); if (c && /^[A-Z]{2}$/.test(c) && l) map[c] = base(l); }
        if (Object.keys(map).length) a.countryMap = map;
      } else if (Array.isArray(cm)) {
        const map: Record<string, string> = {};
        for (const e of cm) { const x = (e ?? {}) as Record<string, unknown>; const c = str(x.country ?? x.code, 3)?.toUpperCase(); const l = langCode(x.language ?? x.lang); if (c && /^[A-Z]{2}$/.test(c) && l) map[c] = base(l); }
        if (Object.keys(map).length) a.countryMap = map;
      }
      if (Array.isArray(o.rules)) a.rules = o.rules.map((r) => { const x = (r ?? {}) as Record<string, unknown>; const l = langCode(x.language ?? x.lang); const when = typeof x.when === "string" ? x.when : x.when && typeof x.when === "object" ? x.when as Condition : undefined; return l && when ? { when, language: base(l), ...(str(x.label, 80) ? { label: str(x.label, 80) } : {}) } : null; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 40);
      if (typeof o.allowSwitch === "boolean") a.allowSwitch = o.allowSwitch;
      if (langCode(o.fallback ?? o.default)) a.fallback = base(langCode(o.fallback ?? o.default)!);
      if (Object.keys(a).length <= 2) return "set_language_routing changes nothing";
      return a;
    }
    case "set_glossary": {
      const entries = Array.isArray(o.entries ?? o.terms) ? ((o.entries ?? o.terms) as unknown[]).map((e) => {
        const x = (e ?? {}) as Record<string, unknown>; const source = str(x.source ?? x.term, 120); if (!source) return null;
        const targets: Record<string, string> = {};
        if (x.targets && typeof x.targets === "object") for (const [k, v] of Object.entries(x.targets as Record<string, unknown>)) { const l = langCode(k); const t = str(v, 200); if (l && t) targets[base(l)] = t; }
        return { source, ...(Object.keys(targets).length ? { targets } : {}), ...(x.doNotTranslate === true || x.keep === true ? { doNotTranslate: true } : {}), ...(str(x.notes, 300) ? { notes: str(x.notes, 300) } : {}) };
      }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 200) : undefined;
      const remove = strs(o.remove, 200);
      if (!entries?.length && !remove?.length) return "set_glossary needs entries or remove";
      return { op, ...(entries?.length ? { entries } : {}), ...(remove?.length ? { remove } : {}) };
    }
    default: return null;
  }
}

/* ------------------------------------------------------------ targets */

/**
 * A translation target as the model (or a person) names it, resolved to an
 * element key: `Q5` (the text), `Q5.instruction`, `Q5.option:2` (by code or
 * label), `Q5.row:r1`, `Q5.column:<id or label>`, `Q5.column:<id>.option:2`,
 * `Q5.scale:low|high`, `Q5.validation:1`, `Q5.probe`, `meta:title`,
 * `meta:description`, `end:<node id>`, `block:<title>` (its title),
 * `button:next`, `ui:required` — or an element key itself.
 */
export function resolveTranslationTarget(def: SurveyDefinition, elements: TranslatableElement[], target: string, question: (ref: string) => { id: string; code: string } | undefined): TranslatableElement | undefined {
  const t = target.trim();
  const byKey = elements.find((e) => e.key === t);
  if (byKey) return byKey;
  const low = t.toLowerCase();
  if (low === "title" || low === "meta:title" || low === "survey title") return elements.find((e) => e.key === "meta:title");
  if (low === "description" || low === "meta:description") return elements.find((e) => e.key === "meta:description");
  const m = /^(?:q(?:uestion)?:)?([A-Za-z_][A-Za-z0-9_]*)(?:[.:](.+))?$/.exec(t);
  if (!m) return undefined;
  const [, ref, partRaw] = m;
  const prefix = ref.toLowerCase();
  if (prefix === "ui" && partRaw) return elements.find((e) => e.key === `ui:${partRaw}`);
  if (prefix === "button" && partRaw) return elements.find((e) => e.key === `branding:buttons:${partRaw.toLowerCase()}`);
  if (prefix === "end" && partRaw) return elements.find((e) => e.key === `flow:${partRaw}:message`) ?? elements.filter((e) => e.kind === "end_message")[partRaw === "complete" ? 0 : -1];
  if (prefix === "block" || prefix === "page") { const want = (partRaw ?? "").toLowerCase(); return elements.find((e) => e.kind === "page_title" && (e.key === `flow:${partRaw}:title` || stripHtmlText(e.source).toLowerCase() === want)); }
  const q = question(ref);
  if (!q) return undefined;
  const mine = elements.filter((e) => e.questionId === q.id);
  const part = (partRaw ?? "text").trim();
  const pl = part.toLowerCase();
  if (pl === "text" || pl === "question") return mine.find((e) => e.kind === "question_text");
  if (pl === "instruction" || pl === "instructions") return mine.find((e) => e.kind === "question_instruction");
  if (pl === "description") return mine.find((e) => e.kind === "question_description");
  if (pl === "placeholder") return mine.find((e) => e.kind === "question_placeholder");
  if (pl === "probe") return mine.find((e) => e.kind === "probe_prompt");
  const sub = /^(option|opt|choice|row|column|col|scale|validation|optalt|alt)\s*[:=]?\s*(.+)$/i.exec(part);
  if (!sub) return undefined;
  const [, kindRaw, valueRaw] = sub;
  const kind = kindRaw.toLowerCase(), value = valueRaw.trim();
  const byCodeOrLabel = (k: TranslatableElement["kind"]) => mine.find((e) => e.kind === k && e.code !== undefined && e.code.toLowerCase() === value.toLowerCase()) ?? mine.find((e) => e.kind === k && stripHtmlText(e.source).toLowerCase() === value.toLowerCase());
  if (kind === "option" || kind === "opt" || kind === "choice") return byCodeOrLabel("option");
  if (kind === "optalt" || kind === "alt") return byCodeOrLabel("option_alt");
  if (kind === "row") return byCodeOrLabel("row");
  if (kind === "column" || kind === "col") {
    const co = /^(.+?)[.:]\s*(?:option|opt)\s*[:=]?\s*(.+)$/i.exec(value);
    if (co) return mine.find((e) => e.kind === "column_option" && e.code?.toLowerCase() === `${co[1]}:${co[2]}`.toLowerCase()) ?? mine.find((e) => e.kind === "column_option" && e.code?.toLowerCase().endsWith(`:${co[2].toLowerCase()}`) && e.label.toLowerCase().includes(co[1].toLowerCase()));
    return byCodeOrLabel("column");
  }
  if (kind === "scale") { const w = value.toLowerCase(); return mine.find((e) => e.kind === "scale_label" && (e.key.toLowerCase().endsWith(`:${w}`) || (w === "low" || w === "left" ? /leftlabel$/i.test(e.key) : /rightlabel$/i.test(e.key)))); }
  if (kind === "validation") return mine.find((e) => e.kind === "validation_message" && e.key.endsWith(`:validation:${Number(value) - 1}`));
  return undefined;
}

/* ------------------------------------------------------------ checks */

const TAG_RE = /<\/?([a-zA-Z][\w-]*)/g;
const tagsOf = (s: string) => (s.match(TAG_RE) ?? []).map((x) => x.toLowerCase()).sort();

/**
 * Why a proposed translation of `source` cannot be stored — null when it can.
 *
 * The placeholders are the ONE grammar of placeholders.ts — the same tokens
 * the lint checks and the provider path protects — so `{label}` is kept like
 * `{{Q1}}`, and a question code the source names ("see Q7") must still be
 * there. A translation written in a script `lang` does not use (Russian in
 * Latin letters, Japanese without kana or kanji, the English pasted back
 * into Hindi) is refused: ≥ 60% of at least 4 letters out of place, judged
 * on the letters outside protected tokens, do-not-translate terms and the
 * source's own capitalised names, so "Miures" and "iPhone" in a Russian
 * sentence are fine.
 */
export function translationProblem(source: string, text: string, glossary: GlossaryEntry[], lang: string): string | null {
  if (!text.trim()) return "the translation is empty";
  if (/\p{L}/u.test(stripHtmlText(source)) && !/\p{L}/u.test(stripHtmlText(text))) return "the translation has no words in it";
  const pm = placeholderMismatch(source, text);
  if (pm) return `the piping / placeholders must be kept exactly — the source has ${pm.source.length ? pm.source.join(" ") : "none"}, the translation has ${pm.translation.length ? pm.translation.join(" ") : "none"}${pm.missing.length ? ` (${pm.missing.join(" ")} ${pm.missing.length === 1 ? "is" : "are"} missing)` : ""}`;
  if ((text.match(/</g) ?? []).length !== (text.match(/>/g) ?? []).length || /<[^>]*$/.test(text)) return "the HTML in the translation is unbalanced";
  const ta = tagsOf(source), tb = tagsOf(text);
  if (ta.join("|") !== tb.join("|")) return `the HTML tags must match the source (${ta.length ? ta.join(" ") : "none"})`;
  for (const g of glossary) {
    if (!g.doNotTranslate) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${g.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, g.caseSensitive ? "u" : "iu");
    if (re.test(stripHtmlText(source)) && !re.test(stripHtmlText(text))) return `“${g.source}” is a term that is never translated (glossary) and must appear as written`;
  }
  const keep = glossary.filter((g) => g.doNotTranslate).flatMap((g) => [g.source, g.targets?.[lang] ?? ""]).filter(Boolean);
  const ws = wrongScript(source, text, lang, { keep });
  if (ws) return `the translation is written in ${ws.script} script, but ${languageName(lang)} is written in ${ws.expected.join(" / ")} — ${Math.round(ws.share * 100)}% of its letters are not; is it still in the source language, or transliterated?`;
  return null;
}

/** Preferred glossary wordings the translation does not use — a warning, not a refusal. */
export function glossaryMisses(source: string, text: string, loc: Localization, lang: string): string[] {
  const out: string[] = [];
  for (const g of glossaryFor(loc, lang)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${g.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, g.caseSensitive ? "u" : "iu");
    if (re.test(stripHtmlText(source)) && !new RegExp(g.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), g.caseSensitive ? "u" : "iu").test(stripHtmlText(text))) out.push(`“${g.source}” → “${g.target}”`);
  }
  return out;
}

/* ------------------------------------------------------------ applying */

export interface LocalizationEnv {
  question(ref: string): { id: string; code: string } | undefined;
  condition(input: string | Condition): Condition;
  ids: IdMinter;
  now: string;
  by?: string;
}
export interface LocalizationApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };

function locOf(def: SurveyDefinition): Localization {
  const loc = effectiveLocalization(def);
  def.localization = loc;
  return loc;
}
function langOrFail(def: SurveyDefinition, code: string, what: string): LanguageConfig | "source" {
  const loc = effectiveLocalization(def);
  if (code === loc.sourceLanguage) return "source";
  const cfg = surveyLanguages(def).find((l) => l.code === code);
  if (!cfg) fail(`${what}: the survey has no ${languageName(code)} (${code}) version — add the language first (add_language)`);
  return cfg!;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function applyLocalizationAction(def: SurveyDefinition, a: LocalizationAction, env: LocalizationEnv): LocalizationApplied {
  const warnings: string[] = [];
  switch (a.op) {
    case "add_language": {
      const loc = locOf(def);
      if (a.code === loc.sourceLanguage) fail(`${languageName(a.code)} is the survey's source language`);
      const known = LANGUAGE_LIBRARY.find((l) => l.code === a.code);
      if (!known && !/^[a-z]{2,3}$/.test(a.code)) fail(`“${a.code}” is not a language code`);
      const existing = loc.languages.find((l) => l.code === a.code);
      const locale = a.locale ?? known?.locales.find((l) => !a.country || l.country === a.country)?.tag;
      if (existing) {
        Object.assign(existing, { ...(locale ? { locale } : {}), ...(a.country ? { country: a.country } : {}), ...(a.name ? { name: a.name } : {}), ...(a.notes ? { notes: a.notes } : {}), ...(a.enabled !== undefined ? { enabled: a.enabled } : {}) });
        return { description: `${languageName(a.code, existing)} version updated`, warnings, touched: [] };
      }
      const cfg: LanguageConfig = { code: a.code, ...(locale ? { locale } : {}), ...(a.country ? { country: a.country } : {}), ...(a.name ? { name: a.name } : {}), direction: known?.direction ?? "ltr", status: "draft", enabled: a.enabled ?? true, format: {}, ...(a.notes ? { notes: a.notes } : {}) };
      loc.languages = [...loc.languages, cfg];
      if (!loc.translations[a.code]) loc.translations = { ...loc.translations, [a.code]: {} };
      const langs = def.deployment?.languages ?? [];
      if (def.deployment && !langs.includes(a.code)) def.deployment.languages = [...langs, a.code];
      const n = translatableElements(def).filter((e) => e.mandatory).length;
      return { description: `Added ${languageName(a.code, cfg)}${locale ? ` (${locale})` : ""} as a draft language — ${plural(n, "element")} to translate`, warnings, touched: [] };
    }
    case "remove_language": {
      const loc = locOf(def);
      if (a.code === loc.sourceLanguage) fail("the source language cannot be removed");
      const cfg = loc.languages.find((l) => l.code === a.code) ?? fail(`the survey has no ${languageName(a.code)} version`);
      const n = Object.keys(loc.translations[a.code] ?? {}).length;
      loc.languages = loc.languages.filter((l) => l.code !== a.code);
      const { [a.code]: _gone, ...rest } = loc.translations; void _gone;
      loc.translations = rest;
      loc.audio = (loc.audio ?? []).filter((x) => x.language !== a.code);
      if (def.deployment?.languages) def.deployment.languages = def.deployment.languages.filter((l) => l !== a.code);
      return { description: `Removed the ${languageName(a.code, cfg!)} version`, destructive: `Removes the ${languageName(a.code, cfg!)} version${n ? ` and its ${plural(n, "translation")}` : ""}${cfg!.status === "live" ? " — it is LIVE" : ""}`, warnings, touched: [] };
    }
    case "set_language_status": {
      const loc = locOf(def);
      const cfg = loc.languages.find((l) => l.code === a.code) ?? fail(`the survey has no ${languageName(a.code)} version`);
      if (a.status && (a.status === "ready" || a.status === "live") && !languageReady(def, a.code)) {
        const blocking = lintLanguage(def, a.code).issues.filter((i) => i.blocking);
        fail(`${languageName(a.code, cfg!)} cannot be ${a.status}: ${plural(blocking.length, "blocking issue")} — ${[...new Set(blocking.map((i) => i.kind.replace(/_/g, " ")))].join(", ")}`);
      }
      if (a.status) cfg!.status = a.status;
      if (a.enabled !== undefined) cfg!.enabled = a.enabled;
      return { description: `${languageName(a.code, cfg!)}: ${[a.status, a.enabled === undefined ? "" : a.enabled ? "offered to respondents" : "not offered"].filter(Boolean).join(", ")}`, warnings, touched: [] };
    }
    case "set_translations": {
      let loc = locOf(def);
      langOrFail(def, a.language, "set_translations") === "source" && fail(`${languageName(a.language)} is the source language — edit the question text itself`);
      const elements = translatableElements(def);
      const glossary = loc.glossary ?? [];
      let written = 0, kept = 0;
      const touched = new Set<string>();
      const refused: string[] = [];
      for (const e of a.entries) {
        const el = resolveTranslationTarget(def, elements, e.target, env.question);
        if (!el) { refused.push(`${e.target}: not a translatable element of this survey`); continue; }
        const prev = loc.translations[a.language]?.[el.key];
        if (prev && (prev.status === "approved" || prev.status === "reviewed") && !a.overwriteApproved && prev.sourceHash === textHash(el.source)) { kept++; continue; }
        const problem = translationProblem(el.source, e.text, glossary, a.language);
        if (problem) { refused.push(`${el.label}: ${problem}`); continue; }
        const misses = glossaryMisses(el.source, e.text, loc, a.language);
        if (misses.length) warnings.push(`${el.label} (${a.language}): the glossary prefers ${misses.join(", ")}`);
        loc = recordTranslation(loc, a.language, el.key, e.text, el.source, { origin: "ai", status: a.status ?? "ai", by: env.by, now: env.now });
        written++;
        if (el.questionId) touched.add(el.questionId);
      }
      def.localization = loc;
      if (!written && refused.length) fail(refused.join("; "));
      if (refused.length) warnings.push(...refused.map((r) => `Not translated — ${r}`));
      const approvedKept = kept ? ` (${plural(kept, "approved translation")} kept — ask to overwrite them if you mean to)` : "";
      return { description: `${languageName(a.language)}: ${plural(written, "translation")} written${approvedKept}`, warnings, touched: [...touched] };
    }
    case "approve_translations": case "confirm_translations": {
      let loc = locOf(def);
      langOrFail(def, a.language, a.op) === "source" && fail(`${languageName(a.language)} is the source language`);
      const elements = translatableElements(def);
      const picked = a.targets ? a.targets.map((t) => resolveTranslationTarget(def, elements, t, env.question) ?? fail(`${t}: not a translatable element of this survey`)) : elements;
      let n = 0;
      for (const el of picked) {
        const t = loc.translations[a.language]?.[el.key];
        if (!t || t.status === "not_translated" || !t.text.trim()) continue;
        if (a.op === "confirm_translations") { if (t.status === "outdated" || t.sourceHash !== textHash(el.source)) { loc = confirmTranslation(loc, a.language, el.key, el.source, env.by); n++; } continue; }
        const status: TranslationEntry["status"] = a.status ?? "approved";
        if (t.status === status) continue;
        if (t.status === "outdated") { warnings.push(`${el.label} (${a.language}) is outdated — confirmed as fitting the new source before approval`); loc = confirmTranslation(loc, a.language, el.key, el.source, env.by); }
        loc = setTranslationStatus(loc, a.language, el.key, status, env.by); n++;
      }
      def.localization = loc;
      return { description: a.op === "confirm_translations" ? `${languageName(a.language)}: ${plural(n, "outdated translation")} confirmed` : `${languageName(a.language)}: ${plural(n, "translation")} ${a.status ?? "approved"}${(a.status ?? "approved") === "approved" ? " (locked)" : ""}`, warnings, touched: [] };
    }
    case "set_language_routing": {
      const loc = locOf(def);
      const offered = new Set([loc.sourceLanguage, ...loc.languages.map((l) => l.code)]);
      const check = (l: string, what: string) => { if (!offered.has(l)) fail(`${what} names ${languageName(l)} (${l}), which the survey does not have — add the language first`); };
      const r = { ...loc.routing };
      const changed: string[] = [];
      if (a.order) { r.order = a.order as typeof r.order; changed.push(`precedence ${a.order.join(" → ")}`); }
      if (a.urlParam) { r.urlParam = a.urlParam; changed.push(`URL parameter ?${a.urlParam}=`); }
      if (a.embeddedField) { r.embeddedField = a.embeddedField; changed.push(`embedded field ${a.embeddedField}`); }
      if (a.countryMap) {
        for (const [c, l] of Object.entries(a.countryMap)) check(l, `country ${c}`);
        r.countryMap = a.merge === false ? a.countryMap : { ...r.countryMap, ...a.countryMap };
        changed.push(Object.entries(a.countryMap).map(([c, l]) => `${c} → ${languageName(l)}`).join(", "));
        if (!r.order.includes("country")) { r.order = [...r.order.filter((m) => m !== "browser" && m !== "respondent"), "country", ...r.order.filter((m) => m === "browser" || m === "respondent")] as typeof r.order; warnings.push("Country routing was added to the precedence order, before browser detection and the respondent's own choice."); }
      }
      if (a.rules) {
        const rules = a.rules.map((x) => { check(x.language, "a routing rule"); return { id: env.ids("langrule"), when: env.condition(x.when), language: x.language, ...(x.label ? { label: x.label } : {}) }; });
        r.rules = a.merge === false ? rules : [...r.rules, ...rules];
        changed.push(plural(rules.length, "routing rule"));
        if (!r.order.includes("rules")) r.order = [...r.order.filter((m) => m !== "browser" && m !== "respondent"), "rules", ...r.order.filter((m) => m === "browser" || m === "respondent")] as typeof r.order;
      }
      if (a.allowSwitch !== undefined) { r.allowSwitch = a.allowSwitch; changed.push(a.allowSwitch ? "respondents may switch language" : "no language switcher"); }
      if (a.fallback) { check(a.fallback, "the fallback"); r.fallback = a.fallback; changed.push(`fallback ${languageName(a.fallback)}`); }
      loc.routing = r;
      return { description: `Language routing: ${changed.join("; ")}`, warnings, touched: [] };
    }
    case "set_glossary": {
      const loc = locOf(def);
      let list = [...(loc.glossary ?? [])];
      let added = 0, updated = 0, removed = 0;
      for (const src of a.remove ?? []) { const before = list.length; list = list.filter((g) => g.source.toLowerCase() !== src.toLowerCase()); removed += before - list.length; }
      for (const e of a.entries ?? []) {
        const cur = list.find((g) => g.source.toLowerCase() === e.source.toLowerCase());
        if (cur) { cur.targets = { ...cur.targets, ...(e.targets ?? {}) }; if (e.doNotTranslate !== undefined) cur.doNotTranslate = e.doNotTranslate; if (e.notes) cur.notes = e.notes; updated++; }
        else { list.push({ id: env.ids("gloss"), source: e.source, targets: e.targets ?? {}, scope: "project", caseSensitive: false, doNotTranslate: e.doNotTranslate ?? false, ...(e.notes ? { notes: e.notes } : {}) }); added++; }
      }
      loc.glossary = list;
      return { description: `Glossary: ${[added && `${plural(added, "term")} added`, updated && `${plural(updated, "term")} updated`, removed && `${plural(removed, "term")} removed`].filter(Boolean).join(", ") || "unchanged"}`, ...(removed ? { destructive: `Removes ${plural(removed, "glossary term")}` } : {}), warnings, touched: [] };
    }
  }
}

export function describeLocalizationAction(a: LocalizationAction): string {
  switch (a.op) {
    case "add_language": return `Add ${languageName(a.code)}`;
    case "remove_language": return `Remove the ${languageName(a.code)} version`;
    case "set_language_status": return `${languageName(a.code)}: ${a.status ?? (a.enabled ? "offered" : "not offered")}`;
    case "set_translations": return `Translate ${a.entries.length} element${a.entries.length === 1 ? "" : "s"} into ${languageName(a.language)}`;
    case "approve_translations": return `${a.status === "reviewed" ? "Review" : "Approve"} the ${languageName(a.language)} translations${a.targets ? ` of ${a.targets.length} element${a.targets.length === 1 ? "" : "s"}` : ""}`;
    case "confirm_translations": return `Confirm the outdated ${languageName(a.language)} translations`;
    case "set_language_routing": return "Set the language routing";
    case "set_glossary": return "Change the glossary";
  }
}

/* ------------------------------------------------------------ impact */

/**
 * WHAT A PROPOSAL DOES TO THE TRANSLATIONS. After the actions ran, every
 * translation whose source text changed is marked outdated (its text is kept
 * and still shown — better than the source language — until it is
 * re-translated or confirmed), and the count is reported so the researcher
 * is asked, not surprised: "7 translations (de, es) are now outdated".
 */
export function outdateTranslations(def: SurveyDefinition): { outdated: number; languages: string[]; keys: string[] } {
  const loc = def.localization;
  if (!loc || !Object.keys(loc.translations ?? {}).length) return { outdated: 0, languages: [], keys: [] };
  const elements = translatableElements(def);
  const langs = new Set<string>(); const keys: string[] = [];
  let outdated = 0;
  for (const [lang, table] of Object.entries(loc.translations)) {
    for (const el of elements) {
      const t = table[el.key];
      if (!t || t.status === "not_translated" || t.status === "outdated" || !t.sourceHash || !t.text.trim()) continue;
      if (t.sourceHash !== textHash(el.source)) { table[el.key] = { ...t, status: "outdated" }; outdated++; langs.add(lang); keys.push(el.key); }
    }
  }
  return { outdated, languages: [...langs], keys };
}
