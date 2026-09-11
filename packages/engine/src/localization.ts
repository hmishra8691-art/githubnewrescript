import type { SurveyDefinition, Question, Localization, LanguageConfig, TranslationEntry, AudioAsset, GlossaryEntry, FlowNode } from "@rescript/schema";
import { Localization as LocalizationSchema, LANGUAGE_LIBRARY, languageInfo } from "@rescript/schema";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import type { ResponseState } from "./state.js";

/**
 * LOCALIZATION — the pure half of the multilingual survey.
 *
 *   translatableElements(def)          every respondent-facing string, by stable key
 *   localizeDefinition(def, lang)      the SAME definition with those strings swapped
 *   resolveLanguage(def, signals)      which language a respondent gets
 *   lintLocalization(def)              the QA report, per language
 *   audioFor(def, key, lang)           which recording plays, by the survey's priority
 *
 * The keys are the contract. A translation or a recording is addressed by
 * `q:<questionId>:opt:<code>` — the question's stable id and the option's
 * code — never by "the option that says Strongly agree", so editing the
 * English wording, reordering options, or masking half of them changes
 * nothing about where a translation belongs. Logic, piping, quotas, exports
 * and analytics never see a translated string: they read ids and codes, and
 * `localizeDefinition` changes only text fields — ids, codes, conditions,
 * expressions and settings are the very same objects.
 */

/* --------------------------------------------------------------- keys */

export type TranslatableKind =
  | "survey_title" | "survey_description"
  | "question_text" | "question_instruction" | "question_description" | "question_placeholder"
  | "option" | "option_alt" | "row" | "row_placeholder" | "column" | "column_option" | "column_placeholder"
  | "scale_label" | "validation_message" | "probe_prompt"
  | "page_title" | "end_message" | "quota_message" | "button" | "ui";

export interface TranslatableElement {
  /** the stable address: `q:<qid>:text`, `q:<qid>:opt:<code>`, `flow:<nodeId>:message`, `ui:required`… */
  key: string;
  kind: TranslatableKind;
  /** the source-language text */
  source: string;
  /** what a translator sees: "Q3 · option 2" */
  label: string;
  questionId?: string;
  questionCode?: string;
  code?: string;
  /** a respondent WILL see this; a language is not ready while it is untranslated */
  mandatory: boolean;
  /** an ordering for the editor: survey, then questions in order, then flow, then interface */
  order: number;
}

export const K = {
  surveyTitle: () => "meta:title",
  surveyDescription: () => "meta:description",
  qText: (qid: string) => `q:${qid}:text`,
  qInstruction: (qid: string) => `q:${qid}:instruction`,
  qDescription: (qid: string) => `q:${qid}:description`,
  qPlaceholder: (qid: string) => `q:${qid}:placeholder`,
  opt: (qid: string, code: string | number) => `q:${qid}:opt:${code}`,
  optAlt: (qid: string, code: string | number) => `q:${qid}:optalt:${code}`,
  row: (qid: string, code: string | number) => `q:${qid}:row:${code}`,
  rowPlaceholder: (qid: string, code: string | number) => `q:${qid}:rowph:${code}`,
  col: (qid: string, colId: string) => `q:${qid}:col:${colId}`,
  colPlaceholder: (qid: string, colId: string) => `q:${qid}:colph:${colId}`,
  colOpt: (qid: string, colId: string, code: string | number) => `q:${qid}:col:${colId}:opt:${code}`,
  scale: (qid: string, which: string) => `q:${qid}:scale:${which}`,
  validation: (qid: string, index: number) => `q:${qid}:validation:${index}`,
  probePrompt: (qid: string) => `q:${qid}:probe`,
  pageTitle: (nodeId: string) => `flow:${nodeId}:title`,
  endMessage: (nodeId: string) => `flow:${nodeId}:message`,
  quotaMessage: (quotaId: string) => `quota:${quotaId}:message`,
  button: (which: string) => `branding:buttons:${which}`,
  ui: (id: string) => `ui:${id}`,
};

/* ----------------------------------------------------------- ui strings */

/**
 * WHAT THE RUNTIME ITSELF SAYS — validation and navigation wording that is
 * not authored per question. Each has an English default here; a language's
 * translation of `ui:<id>` replaces it. `{n}`-style parameters are filled
 * after translation, so a translator sees the placeholder and keeps it.
 */
export const UI_STRINGS: { id: string; en: string; hint: string }[] = [
  { id: "required", en: "This question is required.", hint: "shown under a required question left blank" },
  { id: "review_errors", en: "Please review the highlighted questions below.", hint: "page banner when a page cannot be submitted" },
  { id: "review_one", en: "Please review the highlighted question below.", hint: "banner on a follow-up screen" },
  { id: "review_soft", en: "Please check the highlighted answers — you can continue if they are right.", hint: "banner for warnings only" },
  { id: "page_of", en: "Page {n} of {total}", hint: "progress label" },
  { id: "skip_to_questions", en: "Skip to the questions", hint: "keyboard skip link" },
  { id: "other_specify", en: "Please specify", hint: "placeholder of an “Other” text box" },
  { id: "other_required", en: "Please say what “Other” is before continuing.", hint: "validation" },
  { id: "search_options", en: "Search {n} options…", hint: "placeholder of the option filter on long lists" },
  { id: "min_value", en: "Value must be at least {min}.", hint: "validation" },
  { id: "max_value", en: "Value must be at most {max}.", hint: "validation" },
  { id: "min_selections", en: "Select at least {n}.", hint: "validation" },
  { id: "max_selections", en: "Select at most {n}.", hint: "validation" },
  { id: "date_min", en: "Please choose a date on or after {date}.", hint: "validation" },
  { id: "date_max", en: "Please choose a date on or before {date}.", hint: "validation" },
  { id: "date_weekday", en: "That day of the week is not available — please choose another date.", hint: "validation" },
  { id: "range_order", en: "The first value must not be greater than the second.", hint: "validation" },
  { id: "row_required", en: "Please answer for \"{row}\".", hint: "validation, grids" },
  { id: "sum_target", en: "Total must equal {target} (currently {total}).", hint: "validation, allocation" },
  { id: "language", en: "Language", hint: "label of the language selector" },
  { id: "thank_you", en: "Thank you for completing this survey.", hint: "default end-of-survey message when none is written" },
  { id: "screened", en: "Thank you — you do not qualify for this survey.", hint: "default screen-out message" },
  { id: "quota_full", en: "Thank you — this part of the survey is already complete.", hint: "default quota-full message" },
  { id: "terminated", en: "Thank you for your time.", hint: "default termination message" },
  { id: "saving", en: "Saving your answers…", hint: "final save" },
  { id: "loading", en: "Loading survey…", hint: "boot" },
  { id: "resume_note", en: "Welcome back — your earlier answers were kept.", hint: "resume banner" },
];

/** Fill `{name}` parameters into a UI string. */
export function fill(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params && params[k] != null ? String(params[k]) : m));
}

/** The UI string `id` in `ui` (a language's translated catalogue), else its English default, with parameters filled. */
export function uiText(ui: Record<string, string> | undefined, id: string, params?: Record<string, unknown>, fallback?: string): string {
  const t = ui?.[id] ?? fallback ?? UI_STRINGS.find((u) => u.id === id)?.en ?? id;
  return fill(t, params);
}

/* ------------------------------------------------------------ elements */

const strip = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function walkFlow(nodes: FlowNode[], visit: (n: FlowNode) => void): void {
  for (const n of nodes ?? []) {
    visit(n);
    const kids = (n as unknown as { children?: FlowNode[]; otherwise?: FlowNode[]; branches?: { children?: FlowNode[] }[] });
    if (kids.children) walkFlow(kids.children, visit);
    if (kids.otherwise) walkFlow(kids.otherwise, visit);
    for (const b of kids.branches ?? []) if (b.children) walkFlow(b.children, visit);
  }
}

/**
 * EVERY RESPONDENT-FACING STRING in the survey, by stable key, in editor
 * order. Includes the interface strings (`ui:*`) with their English defaults,
 * so a language can be complete down to "This question is required."
 */
export function translatableElements(def: SurveyDefinition): TranslatableElement[] {
  const out: TranslatableElement[] = [];
  let order = 0;
  const add = (key: string, kind: TranslatableKind, source: string | undefined, label: string, extra: Partial<TranslatableElement> = {}, mandatory = true) => {
    if (source == null || !String(source).trim()) return;
    out.push({ key, kind, source, label, mandatory, order: order++, ...extra });
  };
  add(K.surveyTitle(), "survey_title", def.meta.title, "Survey title");
  add(K.surveyDescription(), "survey_description", def.meta.description, "Survey description", {}, false);

  for (const q of def.questions) {
    if (q.type === "hidden" || q.type === "embedded_data" || q.type === "calculated") continue;
    const base = { questionId: q.id, questionCode: q.code };
    add(K.qText(q.id), "question_text", q.text, `${q.code} · text`, base);
    add(K.qInstruction(q.id), "question_instruction", q.instruction, `${q.code} · instruction`, base);
    add(K.qDescription(q.id), "question_description", q.description, `${q.code} · description`, base, false);
    add(K.qPlaceholder(q.id), "question_placeholder", q.settings.placeholder, `${q.code} · placeholder`, base, false);
    for (const o of q.options ?? []) {
      add(K.opt(q.id, o.code), "option", o.label, `${q.code} · option ${o.code}`, { ...base, code: String(o.code) });
      add(K.optAlt(q.id, o.code), "option_alt", o.imageAlt, `${q.code} · option ${o.code} image text`, { ...base, code: String(o.code) }, false);
    }
    for (const r of q.rows ?? []) {
      add(K.row(q.id, r.code), "row", r.label, `${q.code} · row ${r.code}`, { ...base, code: String(r.code) });
      add(K.rowPlaceholder(q.id, r.code), "row_placeholder", r.placeholder, `${q.code} · row ${r.code} placeholder`, { ...base, code: String(r.code) }, false);
    }
    for (const c of q.columns ?? []) {
      add(K.col(q.id, c.id), "column", c.label, `${q.code} · column ${c.label}`, { ...base, code: c.id });
      add(K.colPlaceholder(q.id, c.id), "column_placeholder", c.placeholder, `${q.code} · column ${c.label} placeholder`, { ...base, code: c.id }, false);
      for (const o of c.options ?? []) add(K.colOpt(q.id, c.id, o.code), "column_option", o.label, `${q.code} · column ${c.label} · option ${o.code}`, { ...base, code: `${c.id}:${o.code}` });
    }
    const s = q.settings as Record<string, unknown>;
    for (const which of ["npsLeftLabel", "npsRightLabel", "sliderLeftLabel", "sliderRightLabel"] as const) {
      if (typeof s[which] === "string") add(K.scale(q.id, which), "scale_label", s[which] as string, `${q.code} · ${which.replace(/Label$/, "").replace(/([A-Z])/g, " $1").toLowerCase()} label`, base, false);
    }
    (q.validation ?? []).forEach((rule, i) => add(K.validation(q.id, i), "validation_message", rule.message, `${q.code} · validation message ${i + 1}`, base, false));
    if (q.probe?.prompt) add(K.probePrompt(q.id), "probe_prompt", q.probe.prompt, `${q.code} · follow-up wording`, base);
  }

  walkFlow(def.flow as FlowNode[], (n) => {
    const node = n as unknown as { type: string; id: string; title?: string; message?: string; showTitle?: boolean; status?: string };
    if (node.type === "page" && node.title) add(K.pageTitle(node.id), "page_title", node.title, `Page "${node.title}" · title`, {}, node.showTitle !== false);
    else if (node.type !== "page" && node.type !== "end" && node.title && (node.type === "block" || node.type === "section")) add(K.pageTitle(node.id), "page_title", node.title, `Block "${node.title}" · title`, {}, false);
    if (node.type === "end" && node.message) add(K.endMessage(node.id), "end_message", node.message, `End (${node.status}) · message`);
  });
  for (const qt of def.quotas ?? []) if (qt.onFull?.message) add(K.quotaMessage(qt.id), "quota_message", qt.onFull.message, `Quota "${qt.name}" · full message`);

  const b = def.branding?.buttons;
  if (b) {
    add(K.button("next"), "button", b.nextLabel, "Button · Next");
    add(K.button("back"), "button", b.backLabel, "Button · Back");
    add(K.button("submit"), "button", b.submitLabel, "Button · Submit");
  }
  for (const u of UI_STRINGS) add(K.ui(u.id), "ui", u.en, `Interface · ${u.hint}`, {}, ["required", "review_errors", "other_specify", "min_selections", "max_selections", "thank_you"].includes(u.id));
  return out;
}

/* --------------------------------------------------------------- hash */

/** A short stable hash of a string — for "has the source changed since this was translated / recorded". */
export function textHash(s: string): string {
  let h = 2166136261;
  const t = strip(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ------------------------------------------------------------- config */

export function effectiveLocalization(def: SurveyDefinition): Localization {
  return LocalizationSchema.parse(def.localization ?? {});
}

export const isSource = (loc: Localization, lang: string) => lang === loc.sourceLanguage;

/** Every language the survey has, source first — for selectors and reports. */
export function surveyLanguages(def: SurveyDefinition): LanguageConfig[] {
  const loc = effectiveLocalization(def);
  const src: LanguageConfig = { code: loc.sourceLanguage, locale: loc.sourceLocale, status: "live", enabled: true, format: {}, name: languageName(loc.sourceLanguage) };
  return [src, ...loc.languages.filter((l) => l.code !== loc.sourceLanguage)];
}

export function languageName(code: string, cfg?: LanguageConfig): string {
  if (cfg?.name) return cfg.name;
  const info = languageInfo(code);
  return info ? info.nativeName : code;
}

export function languageDirection(code: string, cfg?: LanguageConfig): "ltr" | "rtl" {
  return cfg?.direction ?? languageInfo(code)?.direction ?? "ltr";
}

/** The BCP-47 tag for a language version: its configured locale, else the library default. */
export function languageLocale(code: string, cfg?: LanguageConfig): string {
  return cfg?.locale ?? languageInfo(code)?.locales[0]?.tag ?? code;
}

/* ------------------------------------------------------------- lookup */

export function translationOf(def: SurveyDefinition, lang: string, key: string): TranslationEntry | undefined {
  return def.localization?.translations?.[lang]?.[key];
}

/** The text a respondent in `lang` sees for `key`: an approved-or-better translation, else the source. */
export function textFor(def: SurveyDefinition, lang: string, key: string, source: string): string {
  const loc = def.localization;
  if (!loc || lang === loc.sourceLanguage) return source;
  const t = loc.translations?.[lang]?.[key];
  if (!t || t.status === "not_translated" || !t.text.trim()) return source;
  return t.text;
}

/** A language's translated interface strings, `id → text` — for `uiText`. */
export function uiStringsFor(def: SurveyDefinition, lang: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of UI_STRINGS) out[u.id] = textFor(def, lang, K.ui(u.id), u.en);
  return out;
}

/* ------------------------------------------------------------ localize */

const cache = new WeakMap<SurveyDefinition, Map<string, SurveyDefinition>>();

/**
 * THE SAME SURVEY, IN `lang`. Every id, code, condition, expression, setting
 * and quota is the same object; only text fields are replaced — from the
 * language's translations where they exist, else left as the source. The
 * result is cached per (definition, language), so re-rendering is free and
 * `localizeDefinition(def, source) === def`.
 */
export function localizeDefinition(def: SurveyDefinition, lang: string | null | undefined): SurveyDefinition {
  const loc = def.localization;
  if (!lang || !loc || lang === loc.sourceLanguage) return def;
  const table = loc.translations?.[lang];
  if (!table || !Object.keys(table).length) return def;
  let perDef = cache.get(def);
  if (!perDef) { perDef = new Map(); cache.set(def, perDef); }
  const hit = perDef.get(lang);
  if (hit) return hit;

  const t = (key: string, source: string | undefined): string | undefined => {
    if (source == null) return source;
    const e = table[key];
    return e && e.status !== "not_translated" && e.text.trim() ? e.text : source;
  };
  const questions = def.questions.map((q): Question => {
    if (q.type === "hidden" || q.type === "embedded_data" || q.type === "calculated") return q;
    const s = q.settings as Record<string, unknown>;
    const settings = { ...q.settings } as Record<string, unknown>;
    if (typeof s.placeholder === "string") settings.placeholder = t(K.qPlaceholder(q.id), s.placeholder);
    for (const which of ["npsLeftLabel", "npsRightLabel", "sliderLeftLabel", "sliderRightLabel"]) if (typeof s[which] === "string") settings[which] = t(K.scale(q.id, which), s[which] as string);
    return {
      ...q,
      text: t(K.qText(q.id), q.text) ?? q.text,
      instruction: t(K.qInstruction(q.id), q.instruction),
      description: t(K.qDescription(q.id), q.description),
      settings: settings as Question["settings"],
      options: (q.options ?? []).map((o) => ({ ...o, label: t(K.opt(q.id, o.code), o.label) ?? o.label, imageAlt: t(K.optAlt(q.id, o.code), o.imageAlt) })),
      rows: (q.rows ?? []).map((r) => ({ ...r, label: t(K.row(q.id, r.code), r.label) ?? r.label, placeholder: t(K.rowPlaceholder(q.id, r.code), r.placeholder) })),
      columns: (q.columns ?? []).map((c) => ({
        ...c,
        label: t(K.col(q.id, c.id), c.label) ?? c.label,
        placeholder: t(K.colPlaceholder(q.id, c.id), c.placeholder),
        options: (c.options ?? []).map((o) => ({ ...o, label: t(K.colOpt(q.id, c.id, o.code), o.label) ?? o.label })),
      })),
      validation: (q.validation ?? []).map((rule, i) => (rule.message ? { ...rule, message: t(K.validation(q.id, i), rule.message) } : rule)),
      probe: q.probe?.prompt ? { ...q.probe, prompt: t(K.probePrompt(q.id), q.probe.prompt) } : q.probe,
    };
  });
  // a node with nothing to translate stays the SAME object — its conditions, ids and children untouched
  const mapFlow = (nodes: FlowNode[]): FlowNode[] => {
    let changed = false;
    const mapped = nodes.map((n) => {
      const node = n as unknown as Record<string, unknown> & { type: string; id: string };
      const out: Record<string, unknown> = { ...node };
      let dirty = false;
      if (typeof node.title === "string") { const v = t(K.pageTitle(node.id), node.title); if (v !== node.title) { out.title = v; dirty = true; } }
      if (node.type === "end" && typeof node.message === "string") { const v = t(K.endMessage(node.id), node.message); if (v !== node.message) { out.message = v; dirty = true; } }
      if (Array.isArray(node.children)) { const v = mapFlow(node.children as FlowNode[]); if (v !== node.children) { out.children = v; dirty = true; } }
      if (Array.isArray(node.otherwise)) { const v = mapFlow(node.otherwise as FlowNode[]); if (v !== node.otherwise) { out.otherwise = v; dirty = true; } }
      if (Array.isArray(node.branches)) {
        let bd = false;
        const bs = (node.branches as { children?: FlowNode[] }[]).map((b) => { if (!b.children) return b; const v = mapFlow(b.children); if (v === b.children) return b; bd = true; return { ...b, children: v }; });
        if (bd) { out.branches = bs; dirty = true; }
      }
      if (dirty) changed = true;
      return (dirty ? out : node) as unknown as FlowNode;
    });
    return changed ? mapped : nodes;
  };
  const localized: SurveyDefinition = {
    ...def,
    meta: { ...def.meta, title: t(K.surveyTitle(), def.meta.title) ?? def.meta.title, description: t(K.surveyDescription(), def.meta.description) },
    questions,
    flow: mapFlow(def.flow as FlowNode[]),
    quotas: (def.quotas ?? []).map((qt) => (qt.onFull?.message ? { ...qt, onFull: { ...qt.onFull, message: t(K.quotaMessage(qt.id), qt.onFull.message) } } : qt)),
    branding: {
      ...def.branding,
      buttons: {
        ...def.branding.buttons,
        nextLabel: t(K.button("next"), def.branding.buttons.nextLabel) ?? def.branding.buttons.nextLabel,
        backLabel: t(K.button("back"), def.branding.buttons.backLabel) ?? def.branding.buttons.backLabel,
        submitLabel: t(K.button("submit"), def.branding.buttons.submitLabel) ?? def.branding.buttons.submitLabel,
      },
    },
  };
  perDef.set(lang, localized);
  return localized;
}

/* -------------------------------------------------------------- routing */

export interface LanguageSignals {
  urlParams?: Record<string, string> | null;
  /** navigator.languages */
  browserLanguages?: readonly string[] | null;
  /** the response's embedded data at start (the invitation's, the panel's, the URL's) */
  embedded?: Record<string, unknown> | null;
  /** a country code, when something upstream knows it */
  country?: string | null;
  /** an explicit choice already made (a stored answer, a selector) */
  chosen?: string | null;
  /** for the `rules` mode */
  ctx?: EvalContext | null;
}

/** The language codes a respondent may actually get: enabled, and live-or-ready (drafts only in preview). */
export function offeredLanguages(def: SurveyDefinition, includeDrafts = false): string[] {
  const loc = effectiveLocalization(def);
  const targets = loc.languages.filter((l) => l.enabled && (includeDrafts || l.status === "live" || l.status === "ready")).map((l) => l.code);
  return [loc.sourceLanguage, ...targets.filter((c) => c !== loc.sourceLanguage)];
}

function matchOffered(candidate: string | null | undefined, offered: string[]): string | null {
  if (!candidate) return null;
  const c = String(candidate).trim().toLowerCase();
  if (!c) return null;
  const exact = offered.find((o) => o.toLowerCase() === c);
  if (exact) return exact;
  const base = c.split(/[-_]/)[0];
  return offered.find((o) => o.toLowerCase().split(/[-_]/)[0] === base) ?? null;
}

/**
 * WHICH LANGUAGE THIS RESPONDENT GETS. The routing order decides precedence;
 * each source is consulted only for a language the survey actually offers. A
 * respondent's explicit choice always wins over detection. Nothing decides →
 * the configured fallback, else the source language.
 */
export function resolveLanguage(def: SurveyDefinition, sig: LanguageSignals, includeDrafts = false): string {
  const loc = effectiveLocalization(def);
  const offered = offeredLanguages(def, includeDrafts);
  if (offered.length === 1) return offered[0];
  const chosen = matchOffered(sig.chosen, offered);
  if (chosen) return chosen;
  const r = loc.routing;
  for (const mode of r.order) {
    let hit: string | null = null;
    switch (mode) {
      case "url": hit = matchOffered(sig.urlParams?.[r.urlParam], offered); break;
      case "embedded": case "invitation": case "panel": hit = matchOffered(sig.embedded?.[r.embeddedField] as string | undefined, offered); break;
      case "country": {
        const country = String(sig.country ?? sig.embedded?.country ?? sig.urlParams?.country ?? "").toUpperCase();
        hit = country ? matchOffered(r.countryMap[country], offered) : null;
        break;
      }
      case "browser": for (const b of sig.browserLanguages ?? []) { hit = matchOffered(b, offered); if (hit) break; } break;
      case "rules": if (sig.ctx) for (const rule of r.rules) { if (evaluateCondition(rule.when, sig.ctx)) { hit = matchOffered(rule.language, offered); if (hit) break; } } break;
      case "respondent": break; // the selector — nothing to detect here
    }
    if (hit) return hit;
  }
  return matchOffered(r.fallback, offered) ?? loc.sourceLanguage;
}

/** The system variable every response carries. */
export const LANGUAGE_VARIABLE = "SURVEY_LANGUAGE";

export function recordLanguage(state: ResponseState, lang: string): void {
  state.embedded[LANGUAGE_VARIABLE] = lang;
}
export function stateLanguage(state: ResponseState): string | null {
  const v = state.embedded?.[LANGUAGE_VARIABLE];
  return typeof v === "string" && v ? v : null;
}

/* ---------------------------------------------------------- formatting */

export interface LocaleFormat { locale: string; decimal?: string; thousands?: string; currency?: string; datePattern?: string; dateStyle?: "short" | "medium" | "long"; timeFormat?: "12h" | "24h" }

export function localeFormatFor(def: SurveyDefinition, lang: string): LocaleFormat {
  const cfg = surveyLanguages(def).find((l) => l.code === lang);
  return { locale: languageLocale(lang, cfg), ...(cfg?.format ?? {}) };
}

export function formatNumber(n: number, f: LocaleFormat, opts: { maximumFractionDigits?: number; style?: "decimal" | "percent" } = {}): string {
  let s: string;
  try { s = new Intl.NumberFormat(f.locale, { maximumFractionDigits: opts.maximumFractionDigits ?? 2, style: opts.style ?? "decimal" }).format(n); }
  catch { s = String(n); }
  if (f.decimal || f.thousands) {
    // rewrite the separators Intl chose into the study's own
    const parts = new Intl.NumberFormat(f.locale).formatToParts(1234.5);
    const dec = parts.find((p) => p.type === "decimal")?.value ?? ".";
    const grp = parts.find((p) => p.type === "group")?.value ?? ",";
    s = s.split("").map((ch) => (ch === dec ? " " : ch === grp ? "" : ch)).join("").replace(/ /g, f.decimal ?? dec).replace(//g, f.thousands ?? grp);
  }
  return s;
}

export function formatCurrency(n: number, f: LocaleFormat, currency?: string): string {
  const cur = currency ?? f.currency ?? "USD";
  try { return new Intl.NumberFormat(f.locale, { style: "currency", currency: cur }).format(n); } catch { return `${cur} ${n}`; }
}

export function formatDate(d: Date | string, f: LocaleFormat): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  if (f.datePattern) {
    const p2 = (x: number) => String(x).padStart(2, "0");
    return f.datePattern.replace(/yyyy/g, String(date.getFullYear())).replace(/MM/g, p2(date.getMonth() + 1)).replace(/dd/g, p2(date.getDate())).replace(/yy/g, String(date.getFullYear()).slice(-2));
  }
  try { return new Intl.DateTimeFormat(f.locale, { dateStyle: f.dateStyle ?? "medium" }).format(date); } catch { return date.toISOString().slice(0, 10); }
}

export function formatTime(d: Date | string, f: LocaleFormat): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  try { return new Intl.DateTimeFormat(f.locale, { timeStyle: "short", hour12: f.timeFormat ? f.timeFormat === "12h" : undefined }).format(date); } catch { return date.toTimeString().slice(0, 5); }
}

/* ------------------------------------------------------------- glossary */

/** Glossary entries that apply to `lang`, source term → preferred wording (or the term itself when it must not be translated). */
export function glossaryFor(loc: Localization, lang: string): { source: string; target: string; caseSensitive: boolean }[] {
  return loc.glossary
    .map((g) => ({ source: g.source.trim(), target: g.doNotTranslate ? g.source.trim() : (g.targets[lang] ?? "").trim(), caseSensitive: g.caseSensitive }))
    .filter((g) => g.source && g.target);
}

/**
 * Enforce the glossary on a translated string: a source term that still
 * appears untranslated (brand names, terms the AI left in English) becomes
 * its preferred wording. Whole words only; HTML tags and `{{piping}}` are
 * never touched.
 */
export function applyGlossary(text: string, entries: { source: string; target: string; caseSensitive: boolean }[]): string {
  let out = text;
  for (const g of entries) {
    if (g.source === g.target) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${g.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, g.caseSensitive ? "gu" : "giu");
    out = out.replace(re, (_, pre) => `${pre}${g.target}`);
  }
  return out;
}

/* ------------------------------------------------------------- recording */

export interface RecordOpts { origin?: TranslationEntry["origin"]; status?: TranslationEntry["status"]; by?: string; now?: string }

/**
 * Write one translation, keeping the previous version in the entry's
 * history (newest first, ten kept). The status defaults from the origin — AI
 * → "ai", a person → "edited", an import → "edited" — and a change to an
 * already-approved entry drops it back to "edited": approval is of a text,
 * not of a slot.
 */
export function recordTranslation(loc: Localization, lang: string, key: string, text: string, source: string, opts: RecordOpts = {}): Localization {
  const table = { ...(loc.translations[lang] ?? {}) };
  const prev = table[key];
  const now = opts.now ?? new Date().toISOString();
  const status = opts.status ?? (opts.origin === "ai" ? "ai" : "edited");
  if (prev && prev.text === text && prev.status === status) return loc;
  const history = prev && prev.text.trim() ? [{ text: prev.text, status: prev.status, version: prev.version, updatedAt: prev.updatedAt, updatedBy: prev.updatedBy }, ...prev.history].slice(0, 10) : (prev?.history ?? []);
  table[key] = {
    text, status, origin: opts.origin ?? "manual", sourceHash: textHash(source),
    version: prev ? prev.version + (prev.text === text ? 0 : 1) : 1,
    updatedAt: now, updatedBy: opts.by, reviewedBy: status === "reviewed" || status === "approved" ? opts.by : undefined, history,
  };
  return { ...loc, translations: { ...loc.translations, [lang]: table } };
}

/** Change only the status (review / approve) — a version is not a new text. */
export function setTranslationStatus(loc: Localization, lang: string, key: string, status: TranslationEntry["status"], by?: string): Localization {
  const table = { ...(loc.translations[lang] ?? {}) };
  const prev = table[key];
  if (!prev) return loc;
  table[key] = { ...prev, status, reviewedBy: status === "reviewed" || status === "approved" ? by : prev.reviewedBy, updatedAt: new Date().toISOString() };
  return { ...loc, translations: { ...loc.translations, [lang]: table } };
}

/* -------------------------------------------------------------- audio */

/** The recording that plays for `key` in `lang`, by the survey's priority order (human → approved AI → URL by default); null when nothing does. */
export function audioFor(def: SurveyDefinition, key: string, lang: string): AudioAsset | null {
  const loc = def.localization;
  if (!loc) return null;
  const candidates = (loc.audio ?? []).filter((a) => a.elementKey === key && a.language === lang && a.url && (a.kind !== "ai" || a.approved));
  for (const kind of loc.audioPriority ?? ["human", "ai", "url"]) {
    if (kind === "none") return null;
    const hit = candidates.filter((a) => a.kind === kind).sort((a, b) => b.version - a.version)[0];
    if (hit) return hit;
  }
  return null;
}

/** All recordings for an element in a language, newest version first. */
export function audioAssets(def: SurveyDefinition, key: string, lang: string): AudioAsset[] {
  return (def.localization?.audio ?? []).filter((a) => a.elementKey === key && a.language === lang).sort((a, b) => b.version - a.version);
}

/** The text an audio asset should be speaking now — the translation in its language, or the source. */
export function currentTextFor(def: SurveyDefinition, key: string, lang: string): string | null {
  const el = translatableElements(def).find((e) => e.key === key);
  if (!el) return null;
  return textFor(def, lang, key, el.source);
}

/** True when the words changed after this audio was made. */
export function audioStale(def: SurveyDefinition, a: AudioAsset): boolean {
  if (!a.textHash) return false;
  const now = currentTextFor(def, a.elementKey, a.language);
  return now != null && textHash(now) !== a.textHash;
}

/* ---------------------------------------------------------------- QA */

export type LocalizationIssueKind =
  | "missing" | "untranslated" | "stale_source" | "placeholder_mismatch" | "html_mismatch" | "duplicate" | "inconsistent"
  | "overflow" | "empty" | "audio_missing" | "audio_stale" | "audio_unapproved" | "not_approved";

export interface LocalizationIssue {
  language: string;
  kind: LocalizationIssueKind;
  key: string;
  label: string;
  message: string;
  /** an issue that blocks "Ready for live" */
  blocking: boolean;
  questionId?: string;
}

export interface LanguageReport {
  language: string;
  name: string;
  elements: number;
  mandatory: number;
  translated: number;
  approved: number;
  reviewed: number;
  missing: number;
  /** 0–100 over mandatory elements */
  completion: number;
  audio: { elements: number; withAudio: number; missing: number; stale: number; unapproved: number };
  issues: LocalizationIssue[];
  ready: boolean;
}

const PIPE_RE = /\{\{[^}]+\}\}|\{answer\}|\{(?:n|min|max|total|target|date|row)\}/g;
const TAG_RE = /<\/?([a-zA-Z][\w-]*)/g;

const tokens = (s: string) => (s.match(PIPE_RE) ?? []).map((x) => x.replace(/\s+/g, "")).sort();
const tags = (s: string) => (s.match(TAG_RE) ?? []).map((x) => x.toLowerCase()).sort();
const hasLetters = (s: string) => /\p{L}/u.test(strip(s));

/**
 * THE LOCALIZATION QA REPORT for one language: what is missing, what was
 * left in the source language, what changed underneath its translation,
 * placeholders and HTML that no longer match, duplicates, inconsistent
 * renderings of the same source, overflow risks, and the audio that is
 * missing, unapproved or out of date. `ready` is false while any blocking
 * issue remains — a language is not offered live before then.
 */
export function lintLanguage(def: SurveyDefinition, lang: string): LanguageReport {
  const loc = effectiveLocalization(def);
  const cfg = surveyLanguages(def).find((l) => l.code === lang);
  const elements = translatableElements(def);
  const table = loc.translations[lang] ?? {};
  const issues: LocalizationIssue[] = [];
  const bySource = new Map<string, Set<string>>();
  const byTranslation = new Map<string, string[]>();
  let translated = 0, approved = 0, reviewed = 0, missing = 0;
  const mandatory = elements.filter((e) => e.mandatory);
  const source = lang === loc.sourceLanguage;

  for (const el of elements) {
    const t = table[el.key];
    const has = !!t && t.status !== "not_translated" && t.text.trim().length > 0;
    if (source) { translated++; approved++; continue; }
    if (!has) {
      if (el.mandatory) { missing++; issues.push({ language: lang, kind: "missing", key: el.key, label: el.label, message: `No ${cfg?.name ?? lang} text yet.`, blocking: true, questionId: el.questionId }); }
      continue;
    }
    translated++;
    if (t.status === "approved") approved++;
    if (t.status === "reviewed" || t.status === "approved") reviewed++;
    const tx = t.text;
    if (!hasLetters(tx) && hasLetters(el.source)) issues.push({ language: lang, kind: "empty", key: el.key, label: el.label, message: "The translation has no words in it.", blocking: el.mandatory, questionId: el.questionId });
    else if (strip(tx) === strip(el.source) && hasLetters(el.source) && strip(el.source).length > 2 && !/^\{\{[^}]+\}\}$/.test(strip(el.source)) && !/^[\d\s.,%$€£+-]+$/.test(strip(el.source)))
      issues.push({ language: lang, kind: "untranslated", key: el.key, label: el.label, message: "Identical to the source text — still in the original language?", blocking: false, questionId: el.questionId });
    if (t.sourceHash && t.sourceHash !== textHash(el.source)) issues.push({ language: lang, kind: "stale_source", key: el.key, label: el.label, message: "The source text was edited after this was translated.", blocking: el.mandatory, questionId: el.questionId });
    const a = tokens(el.source), b = tokens(tx);
    if (a.join("|") !== b.join("|")) issues.push({ language: lang, kind: "placeholder_mismatch", key: el.key, label: el.label, message: `Piping / placeholders differ: source has ${a.length ? a.join(" ") : "none"}, translation has ${b.length ? b.join(" ") : "none"}.`, blocking: true, questionId: el.questionId });
    const ta = tags(el.source), tb = tags(tx);
    if (ta.join("|") !== tb.join("|")) issues.push({ language: lang, kind: "html_mismatch", key: el.key, label: el.label, message: "HTML tags differ from the source — formatting may break.", blocking: false, questionId: el.questionId });
    if (/<[^>]*$/.test(tx) || (tx.match(/</g) ?? []).length !== (tx.match(/>/g) ?? []).length) issues.push({ language: lang, kind: "html_mismatch", key: el.key, label: el.label, message: "Unbalanced HTML in the translation.", blocking: true, questionId: el.questionId });
    if (strip(tx).length > 40 && strip(tx).length > strip(el.source).length * 2.2 && (el.kind === "option" || el.kind === "button" || el.kind === "column" || el.kind === "scale_label")) issues.push({ language: lang, kind: "overflow", key: el.key, label: el.label, message: `Much longer than the source (${strip(tx).length} vs ${strip(el.source).length} characters) — may overflow its control.`, blocking: false, questionId: el.questionId });
    if (t.status === "ai" || t.status === "edited") issues.push({ language: lang, kind: "not_approved", key: el.key, label: el.label, message: `${t.status === "ai" ? "AI translation" : "Edited"} — not reviewed yet.`, blocking: false, questionId: el.questionId });
    const src = strip(el.source).toLowerCase(), tr = strip(tx).toLowerCase();
    if (!bySource.has(src)) bySource.set(src, new Set());
    bySource.get(src)!.add(tr);
    if (el.questionId && (el.kind === "option" || el.kind === "row" || el.kind === "column")) {
      const dk = `${el.questionId}|${el.kind}|${tr}`;
      byTranslation.set(dk, [...(byTranslation.get(dk) ?? []), el.key]);
    }
  }
  if (!source) {
    for (const [, keys] of byTranslation) if (keys.length > 1) {
      const el = elements.find((e) => e.key === keys[0])!;
      issues.push({ language: lang, kind: "duplicate", key: keys[0], label: el.label, message: `${keys.length} options of ${el.questionCode} share the same translation — respondents cannot tell them apart.`, blocking: true, questionId: el.questionId });
    }
    for (const [src, set] of bySource) if (set.size > 1 && src.length > 2) {
      const el = elements.find((e) => strip(e.source).toLowerCase() === src)!;
      issues.push({ language: lang, kind: "inconsistent", key: el.key, label: el.label, message: `"${strip(el.source).slice(0, 40)}" is translated ${set.size} different ways across the survey.`, blocking: false, questionId: el.questionId });
    }
  }

  // audio: every element that has a translation (or the source) may carry a recording; missing is informational unless voice is on
  const spoken = elements.filter((e) => e.kind === "question_text" || e.kind === "option" || e.kind === "row" || e.kind === "question_instruction" || e.kind === "end_message");
  let withAudio = 0, stale = 0, unapproved = 0;
  for (const el of spoken) {
    const assets = audioAssets(def, el.key, lang);
    if (!assets.length) continue;
    withAudio++;
    for (const a of assets) {
      if (audioStale(def, a)) { stale++; issues.push({ language: lang, kind: "audio_stale", key: el.key, label: el.label, message: `Translation changed — the existing ${a.kind === "human" ? "recording" : a.kind === "ai" ? "AI audio" : "audio"} may be outdated.`, blocking: false, questionId: el.questionId }); }
      if (a.kind === "ai" && !a.approved) { unapproved++; issues.push({ language: lang, kind: "audio_unapproved", key: el.key, label: el.label, message: "AI-generated audio not yet approved — it will not play.", blocking: false, questionId: el.questionId }); }
    }
  }
  const anyAudio = (loc.audio ?? []).some((a) => a.language === lang);
  if (anyAudio) for (const el of spoken.filter((e) => e.kind === "question_text")) if (!audioAssets(def, el.key, lang).length) issues.push({ language: lang, kind: "audio_missing", key: el.key, label: el.label, message: "No audio for this question in this language.", blocking: false, questionId: el.questionId });

  const completion = source ? 100 : mandatory.length ? Math.round(((mandatory.length - missing) / mandatory.length) * 100) : 100;
  return {
    language: lang, name: languageName(lang, cfg), elements: elements.length, mandatory: mandatory.length, translated, approved, reviewed, missing, completion,
    audio: { elements: spoken.length, withAudio, missing: anyAudio ? spoken.filter((e) => e.kind === "question_text").length - spoken.filter((e) => e.kind === "question_text" && audioAssets(def, e.key, lang).length).length : 0, stale, unapproved },
    issues, ready: source || !issues.some((i) => i.blocking),
  };
}

export function lintLocalization(def: SurveyDefinition): LanguageReport[] {
  return surveyLanguages(def).map((l) => lintLanguage(def, l.code));
}

/** May this language be marked Ready / Live? The QA verdict, in one boolean. */
export function languageReady(def: SurveyDefinition, lang: string): boolean {
  return lintLanguage(def, lang).ready;
}

/** Studio-level problems, in words — for the Logic check. */
export function lintLocalizationSummary(def: SurveyDefinition): string[] {
  const loc = def.localization;
  if (!loc || !loc.languages.length) return [];
  const out: string[] = [];
  for (const r of lintLocalization(def)) {
    if (r.language === loc.sourceLanguage) continue;
    const cfg = loc.languages.find((l) => l.code === r.language);
    if ((cfg?.status === "live" || cfg?.status === "ready") && !r.ready) out.push(`${r.name}: marked ${cfg.status} but ${r.issues.filter((i) => i.blocking).length} blocking localization issue${r.issues.filter((i) => i.blocking).length === 1 ? "" : "s"} remain (${r.missing} missing).`);
    if (r.audio.stale) out.push(`${r.name}: ${r.audio.stale} audio file${r.audio.stale === 1 ? "" : "s"} recorded before the translation changed.`);
  }
  const dup = loc.languages.map((l) => l.code).filter((c, i, a) => a.indexOf(c) !== i);
  for (const d of new Set(dup)) out.push(`Language "${d}" is listed twice.`);
  return out;
}

/* ------------------------------------------------------- import / export */

export interface TranslationRow {
  elementKey: string;
  questionId: string;
  questionCode: string;
  element: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translation: string;
  status: string;
  audioUrl: string;
}

/** The translation table as rows — one per (element, target language) — for Excel / CSV / JSON export. */
export function translationRows(def: SurveyDefinition, languages?: string[]): TranslationRow[] {
  const loc = effectiveLocalization(def);
  const langs = languages ?? loc.languages.map((l) => l.code).filter((c) => c !== loc.sourceLanguage);
  const out: TranslationRow[] = [];
  for (const el of translatableElements(def)) for (const lang of langs) {
    const t = loc.translations[lang]?.[el.key];
    out.push({
      elementKey: el.key, questionId: el.questionId ?? "", questionCode: el.questionCode ?? "", element: el.label, sourceLanguage: loc.sourceLanguage, targetLanguage: lang,
      sourceText: el.source, translation: t?.text ?? "", status: t?.status ?? "not_translated", audioUrl: audioFor(def, el.key, lang)?.url ?? "",
    });
  }
  return out;
}

/** Apply imported rows: only rows whose element key still exists; blank translations are ignored; a changed text becomes "edited" from an import. */
export function applyTranslationRows(def: SurveyDefinition, rows: { elementKey: string; targetLanguage: string; translation: string; status?: string; audioUrl?: string }[], by?: string): { localization: Localization; applied: number; skipped: number } {
  let loc = effectiveLocalization(def);
  const elements = new Map(translatableElements(def).map((e) => [e.key, e]));
  let applied = 0, skipped = 0;
  for (const r of rows) {
    const el = elements.get(r.elementKey);
    const lang = (r.targetLanguage ?? "").trim();
    if (!el || !lang || !r.translation?.trim() || lang === loc.sourceLanguage) { skipped++; continue; }
    const status = (["ai", "edited", "reviewed", "approved"] as const).includes(r.status as never) ? (r.status as TranslationEntry["status"]) : "edited";
    loc = recordTranslation(loc, lang, el.key, r.translation, el.source, { origin: "import", status, by });
    if (!loc.languages.some((l) => l.code === lang)) loc = { ...loc, languages: [...loc.languages, { code: lang, status: "draft", enabled: true, format: {} }] };
    if (r.audioUrl?.trim() && !loc.audio.some((a) => a.elementKey === el.key && a.language === lang && a.url === r.audioUrl!.trim())) {
      loc = { ...loc, audio: [...loc.audio, { id: `au_${Math.random().toString(36).slice(2, 10)}`, elementKey: el.key, language: lang, kind: "url", url: r.audioUrl.trim(), version: 1, approved: true, createdAt: new Date().toISOString(), textHash: textHash(r.translation) }] };
    }
    applied++;
  }
  return { localization: loc, applied, skipped };
}

/* ------------------------------------------------------------- library */

/** Search the language library: by name, native name, code or country. */
export function searchLanguages(query: string): typeof LANGUAGE_LIBRARY {
  const q = query.trim().toLowerCase();
  if (!q) return LANGUAGE_LIBRARY;
  return LANGUAGE_LIBRARY.filter((l) => l.name.toLowerCase().includes(q) || l.nativeName.toLowerCase().includes(q) || l.code === q || l.locales.some((x) => x.countryName.toLowerCase().includes(q) || x.tag.toLowerCase() === q || x.name.toLowerCase().includes(q)));
}
