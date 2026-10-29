import type { SurveyDefinition, GlossaryEntry } from "@rescript/schema";
import { LANGUAGE_LIBRARY } from "@rescript/schema";
import { translatableElements, effectiveLocalization, textHash, languageDirection, setSourceText, type TranslatableElement, type TranslatableKind } from "./localization.js";
import { placeholdersIn, expectedScripts, scriptCounts } from "./placeholders.js";
import { translationProblem } from "./localizationActions.js";

/**
 * TRANSLATION AS A TASK — the deterministic half (2026-10-25).
 *
 * Production: "सर्वे को उर्दू में ट्रांस्लेट कर दो" on a 78-question survey was ONE model call (163 s timeout), and
 * "translate the first 10 questions into Urdu" came back as prose. A whole survey's wording is hundreds of strings;
 * it is translated as a durable task (apps/studio/lib/tasks/translation.ts) whose every decision that does not need a
 * model is made here, in code:
 *
 *   translationInventory   every respondent-facing string by its stable element key (translatableElements — the
 *                          SAME addressing the runtime's localizeDefinition reads), each one MASKED: piping tokens,
 *                          `${var}`, `[[loop]]`, `{param}`, question codes, HTML tags and attributes, inline
 *                          <script>/<style>, entities, URLs, e-mail addresses and do-not-translate glossary terms
 *                          become `{n}` sentinels the model never sees the inside of
 *   planTranslationBatches adaptive batches (by characters and count), one question's elements kept together,
 *                          identical masked strings translated ONCE (translation memory inside the survey)
 *   unmaskTranslation      every sentinel back exactly once, byte-identical, or the string is refused
 *   validateTranslatedUnit missing / empty / corrupted (sentinels, placeholders, HTML) / untranslated (identical to
 *                          the source when that is not allowed) / wrong script for the language / glossary
 *   translationCoverage    the final completeness check: inventory 100% covered, nothing stale, duplicated within
 *                          a question, corrupted or untranslated; the RTL flag
 *   pendingTranslationKeys resume: only keys without a valid, current translation are (re)translated — a source
 *                          edit after translation invalidates exactly that key (its source hash)
 *   translationTaskActions set_translations (a language version) or replace_wording (the source wording itself)
 *   surveyStructureHash    the survey with every translatable text blanked — logic, piping, scripts, ids and
 *                          codes must hash the same before and after a translation
 */

/* ----------------------------------------------------------- masking */

export const SENTINEL_RE = /\{\s*(\d+)\s*\}/g;
const sentinel = (n: number) => `{${n}}`;

export interface MaskedText { masked: string; tokens: string[] }

interface Span { start: number; end: number }

/** URLs and e-mail addresses — never translated, never "localized" */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'{}]+[^\s<>"'.,;:!?)\]{}]|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/giu;
/** an inline script or style block, an HTML comment, a tag (with its attributes), an entity */
const HTML_RE = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>|&(?:[A-Za-z]+|#\d+|#x[0-9a-fA-F]+);/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lift out everything a translator must not touch. Spans are taken leftmost-longest and never overlap (a pipe inside
 * an attribute stays inside its tag's token). The sentinel is `{n}` — the shape models keep (ICU-style), and safe: every
 * `{word}` in the SOURCE is itself a protected parameter, so any `{n}` left in a masked text is one of ours. (Not `⟦n⟧`:
 * the untrusted-data fence neutraliser rewrites those brackets.)
 */
export function maskText(text: string, opts: { keep?: string[] } = {}): MaskedText {
  const src = String(text ?? "");
  const spans: Span[] = [];
  const take = (re: RegExp) => { for (const m of src.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }); };
  take(HTML_RE);
  take(URL_RE);
  for (const p of placeholdersIn(src)) spans.push({ start: p.start, end: p.end });
  for (const k of opts.keep ?? []) if (k.trim()) take(new RegExp(`(?<![\\p{L}\\p{N}_])${esc(k.trim())}(?![\\p{L}\\p{N}_])`, "giu"));
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const s of spans) { const last = kept[kept.length - 1]; if (last && s.start < last.end) { if (s.end > last.end) last.end = s.end; continue; } kept.push({ ...s }); }
  const tokens: string[] = [];
  let out = "", at = 0;
  for (const s of kept) { out += src.slice(at, s.start); out += sentinel(tokens.length); tokens.push(src.slice(s.start, s.end)); at = s.end; }
  return { masked: out + src.slice(at), tokens };
}

export interface UnmaskResult { text: string; ok: boolean; missing: number[]; duplicated: number[]; unknown: number[] }

/** Put the tokens back. Every sentinel must come back EXACTLY once — none lost, none doubled, none invented. */
export function unmaskTranslation(translated: string, tokens: string[]): UnmaskResult {
  const seen = new Map<number, number>();
  const unknown: number[] = [];
  const text = String(translated ?? "").replace(SENTINEL_RE, (_m, d) => {
    const i = Number(d);
    seen.set(i, (seen.get(i) ?? 0) + 1);
    if (i < 0 || i >= tokens.length) { unknown.push(i); return ""; }
    return tokens[i];
  });
  const missing: number[] = [], duplicated: number[] = [];
  for (let i = 0; i < tokens.length; i++) { const n = seen.get(i) ?? 0; if (n === 0) missing.push(i); else if (n > 1) duplicated.push(i); }
  return { text, ok: !missing.length && !duplicated.length && !unknown.length, missing, duplicated, unknown };
}

/** letters a translator was asked to translate (outside every sentinel) */
const lettersOf = (masked: string) => masked.replace(SENTINEL_RE, " ").replace(/[^\p{L}]/gu, "");

/* ---------------------------------------------------------- inventory */

export interface TranslationUnit {
  key: string;
  kind: TranslatableKind;
  label: string;
  questionId?: string;
  questionCode?: string;
  source: string;
  masked: string;
  tokens: string[];
  /** textHash of the source — a later edit of the source changes it, and invalidates only this key */
  sourceHash: string;
  /** nothing to translate (only numbers, punctuation, tokens): the translation IS the source, no model call */
  copyThrough: boolean;
  mandatory: boolean;
  order: number;
  chars: number;
}

export interface TranslationScope {
  /** question ids in scope (their every element); absent = the whole survey */
  questionIds?: string[];
  /** include survey-level elements (title, end messages, buttons, popups, interface strings) — default: true for the whole survey, false for a question scope */
  surveyLevel?: boolean;
  /** leave out the runtime's interface strings (`ui:*`) — replace-wording mode, which cannot rewrite them */
  excludeUi?: boolean;
}

export interface TranslationInventory {
  units: TranslationUnit[];
  /** protected tokens across the inventory, by what they are */
  protectedTokens: number;
  byKind: Partial<Record<TranslatableKind, number>>;
  /** respondent-facing text this survey has that the language-version system does not carry (said, never hidden) */
  notCovered: string[];
}

/** do-not-translate glossary terms (and their per-language spellings) */
export function keepTerms(glossary: GlossaryEntry[] | undefined, lang?: string): string[] {
  return (glossary ?? []).filter((g) => g.doNotTranslate).flatMap((g) => [g.source, lang ? g.targets?.[lang] ?? "" : ""]).filter((x) => x && x.trim());
}

export function translationInventory(def: SurveyDefinition, scope: TranslationScope = {}): TranslationInventory {
  const loc = effectiveLocalization(def);
  const keep = keepTerms(loc.glossary);
  const ids = scope.questionIds ? new Set(scope.questionIds) : null;
  const surveyLevel = scope.surveyLevel ?? !ids;
  const units: TranslationUnit[] = [];
  const byKind: Partial<Record<TranslatableKind, number>> = {};
  let protectedTokens = 0;
  for (const el of translatableElements(def)) {
    if (ids ? !(el.questionId && ids.has(el.questionId)) && !(surveyLevel && !el.questionId) : !surveyLevel && !el.questionId) continue;
    if (scope.excludeUi && el.kind === "ui") continue;
    const { masked, tokens } = maskText(el.source, { keep });
    protectedTokens += tokens.length;
    byKind[el.kind] = (byKind[el.kind] ?? 0) + 1;
    units.push(unitOf(el, masked, tokens));
  }
  const notCovered: string[] = [];
  const qs = ids ? def.questions.filter((q) => ids.has(q.id)) : def.questions;
  for (const q of qs) {
    const s = q.settings as Record<string, unknown>;
    if (Array.isArray(s.cards) && s.cards.length) notCovered.push(`${q.code}: card texts`);
    if (Array.isArray(s.arms) && s.arms.length) notCovered.push(`${q.code}: experiment arm labels`);
    if (Array.isArray(s.adaptive) && s.adaptive.length) notCovered.push(`${q.code}: adaptive alternative wordings`);
  }
  if (!ids && (def as unknown as { aiInterview?: unknown }).aiInterview) notCovered.push("AI-interview texts (translated by the interview's own languages)");
  return { units, protectedTokens, byKind, notCovered };
}

function unitOf(el: TranslatableElement, masked: string, tokens: string[]): TranslationUnit {
  return {
    key: el.key, kind: el.kind, label: el.label, ...(el.questionId ? { questionId: el.questionId } : {}), ...(el.questionCode ? { questionCode: el.questionCode } : {}),
    source: el.source, masked, tokens, sourceHash: textHash(el.source), copyThrough: !lettersOf(masked).length, mandatory: el.mandatory, order: el.order, chars: masked.length,
  };
}

/* ------------------------------------------------------------ batches */

export interface BatchPolicy {
  /** a batch closes at this many unique strings … */
  maxItems: number;
  /** … or this many source characters (≈ the output budget: Urdu/Hindi run ~1.3× the English length) */
  maxChars: number;
  /** a batch smaller than this is merged into the previous one when that stays under 1.5× the caps */
  minItems: number;
}
export const DEFAULT_BATCH_POLICY: BatchPolicy = { maxItems: 120, maxChars: 4000, minItems: 40 };

export interface TranslationSegment {
  /** stable id of the masked text — identical strings across the survey are ONE segment, translated once */
  id: string;
  masked: string;
  keys: string[];
  /** what the translator sees for context: "Q3 · option 2" */
  label: string;
  kind: TranslatableKind;
}
/**
 * `keys`: every element key the batch writes — ALL the keys of every segment it owns, so a wording shared across the
 * survey is translated once AND written everywhere by the one batch that owns it (batches never depend on each other,
 * and a re-run of a batch sees exactly the same pending keys and prompt whatever the other batches did meanwhile).
 * `own`: the keys that introduced its segments, in survey order — its position in the survey (for the panel's range).
 */
export interface TranslationBatch { index: number; keys: string[]; own: string[]; segments: number; chars: number }

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Group units into segments (identical masked text = one segment), in inventory order. Copy-through units are left out. */
export function segmentsOf(units: TranslationUnit[]): TranslationSegment[] {
  const by = new Map<string, TranslationSegment>();
  for (const u of units) {
    if (u.copyThrough) continue;
    const m = norm(u.masked);
    const id = `s${textHash(m)}${m.length.toString(36)}`;
    const seg = by.get(id);
    if (seg) seg.keys.push(u.key);
    else by.set(id, { id, masked: m, keys: [u.key], label: u.label, kind: u.kind });
  }
  return [...by.values()];
}

/**
 * ADAPTIVE BATCHES: walk the units in survey order; a batch closes before the next QUESTION that would push it past
 * the item or character cap (a question's elements stay together unless a single question alone exceeds a cap — then
 * it is split at the caps). A segment shared by several questions is translated — and written to every one of its
 * keys — by the batch of its first occurrence, so no batch depends on another. A
 * tail smaller than `minItems` joins the previous batch when that stays reasonable. Deterministic: the same inventory
 * gives the same batches.
 */
export function planTranslationBatches(units: TranslationUnit[], policy: Partial<BatchPolicy> = {}): TranslationBatch[] {
  const p = { ...DEFAULT_BATCH_POLICY, ...policy };
  const segs = segmentsOf(units);
  const segOfKey = new Map<string, TranslationSegment>();
  for (const s of segs) for (const k of s.keys) segOfKey.set(k, s);
  // groups: one per question (or one per survey-level unit), in order
  const groups: { keys: string[]; own: string[]; segs: TranslationSegment[]; chars: number }[] = [];
  const placed = new Set<string>();
  let cur: { qid: string | null; keys: string[]; own: string[]; segs: TranslationSegment[]; chars: number } | null = null;
  for (const u of units) {
    const seg = segOfKey.get(u.key);
    if (!seg || placed.has(seg.id)) continue; // a shared wording belongs to the batch of its first occurrence
    const qid = u.questionId ?? null;
    if (!cur || cur.qid !== qid || qid === null) { if (cur) groups.push(cur); cur = { qid, keys: [], own: [], segs: [], chars: 0 }; }
    placed.add(seg.id); cur.segs.push(seg); cur.chars += seg.masked.length; cur.keys.push(...seg.keys); cur.own.push(u.key);
  }
  if (cur) groups.push(cur);
  const batches: TranslationBatch[] = [];
  let b: TranslationBatch | null = null;
  const close = () => { if (b && b.keys.length) batches.push(b); b = null; };
  for (const g of groups) {
    // a single group larger than a cap is cut at the caps
    if (g.segs.length > p.maxItems || g.chars > p.maxChars) {
      close();
      let part: TranslationBatch = { index: 0, keys: [], own: [], segments: 0, chars: 0 };
      g.segs.forEach((s, i) => {
        if (part.segments && (part.segments + 1 > p.maxItems || part.chars + s.masked.length > p.maxChars)) { batches.push(part); part = { index: 0, keys: [], own: [], segments: 0, chars: 0 }; }
        part.segments++; part.chars += s.masked.length;
        part.keys.push(...s.keys); part.own.push(g.own[i]);
      });
      if (part.keys.length) batches.push(part);
      continue;
    }
    const bb = b as TranslationBatch | null;
    if (bb && (bb.segments + g.segs.length > p.maxItems || bb.chars + g.chars > p.maxChars)) close();
    if (!b) b = { index: 0, keys: [], own: [], segments: 0, chars: 0 };
    (b as TranslationBatch).keys.push(...g.keys); (b as TranslationBatch).own.push(...g.own); (b as TranslationBatch).segments += g.segs.length; (b as TranslationBatch).chars += g.chars;
  }
  close();
  // a small tail joins the previous batch when the two together stay under 1.5× the caps
  if (batches.length > 1) {
    const tail = batches[batches.length - 1], prev = batches[batches.length - 2];
    if (tail.segments < p.minItems && prev.segments + tail.segments <= p.maxItems * 1.5 && prev.chars + tail.chars <= p.maxChars * 1.5) {
      prev.keys.push(...tail.keys); prev.own.push(...tail.own); prev.segments += tail.segments; prev.chars += tail.chars; batches.pop();
    }
  }
  return batches.filter((x) => x.keys.length).map((x, i) => ({ ...x, index: i }));
}

/**
 * A rough token estimate for a batch: input = masked chars / 3.5 + per-item JSON + the instructions; output = the
 * input text × 1.4 for a Latin-script target, × 2.6 for another script (Urdu, Hindi, Arabic … cost two to three times
 * the tokens per character in common tokenizers) + the JSON around each item.
 */
export function estimateBatchTokens(chars: number, segments: number, lang?: string): { inputTokens: number; outputTokens: number } {
  const text = Math.ceil(chars / 3.5) + segments * 6;
  const latin = !lang || (expectedScripts(lang) ?? ["Latin"]).includes("Latin");
  return { inputTokens: text + 450, outputTokens: Math.ceil(text * (latin ? 1.4 : 2.6)) + segments * 8 + 40 };
}

/* --------------------------------------------------------- validation */

export type TranslationProblemKind = "missing" | "empty" | "corrupted" | "untranslated" | "wrong_script" | "duplicate" | "stale" | "refused";
export interface TranslationIssue { key: string; label: string; kind: TranslationProblemKind; message: string }

/** a short, capitalised word or an acronym copied as is — a brand or product name; kept, but listed for review */
export function brandLike(masked: string): boolean {
  const words = masked.replace(SENTINEL_RE, " ").match(/\p{L}[\p{L}\p{N}'’&.-]*/gu) ?? [];
  return words.length > 0 && words.length <= 3 && words.every((w) => /^\p{Lu}/u.test(w) || /^[\p{Lu}\p{N}]{2,6}$/u.test(w));
}

/**
 * Is `text` an acceptable translation of `unit` into `lang`? Null when it is; else what is wrong. `text` is the
 * UNMASKED translation (the caller unmasks first and reports a lost sentinel as corrupted).
 */
export function validateTranslatedUnit(unit: Pick<TranslationUnit, "key" | "label" | "source" | "masked" | "copyThrough">, text: string | undefined | null, lang: string, glossary: GlossaryEntry[] = []): TranslationIssue | null {
  const at = (kind: TranslationProblemKind, message: string): TranslationIssue => ({ key: unit.key, label: unit.label, kind, message });
  if (text == null) return at("missing", "no translation returned");
  if (!String(text).trim()) return at("empty", "the translation is empty");
  if (unit.copyThrough) return norm(text) === norm(unit.source) ? null : at("corrupted", "a string with nothing to translate must stay exactly as it is");
  if (norm(text) === norm(unit.source)) {
    const exp = expectedScripts(lang);
    const letters = scriptCounts(lettersOf(unit.masked));
    const sameScript = !!exp && letters.letters > 0 && Object.keys(letters.counts).every((s) => exp.includes(s as never));
    if (!brandLike(unit.masked) && lettersOf(unit.masked).length > 3 && !sameScript) return at("untranslated", "identical to the source text — still in the source language");
  }
  const problem = translationProblem(unit.source, text, glossary, lang);
  if (problem) return at(/script/.test(problem) ? "wrong_script" : /piping|placeholder|HTML/.test(problem) ? "corrupted" : "refused", problem);
  // the protected content must come back byte-identical: compare the source's token multiset with the translation's
  const keep = keepTerms(glossary, lang);
  const a = maskText(unit.source, { keep }).tokens.slice().sort(), b = maskText(text, { keep }).tokens.slice().sort();
  const bag = new Map<string, number>();
  for (const t of b) bag.set(t, (bag.get(t) ?? 0) + 1);
  for (const t of a) { const n = bag.get(t) ?? 0; if (!n) return at("corrupted", `a protected part changed or went missing: ${t.slice(0, 60)}`); bag.set(t, n - 1); }
  return null;
}

export interface BatchCheck {
  /** key → the validated, unmasked translation */
  accepted: Record<string, string>;
  issues: TranslationIssue[];
  /** kept as written (brand-like / identical) — fine to store, listed for a person to glance at */
  review: { key: string; label: string; why: string }[];
}

/**
 * CHECK A BATCH THE MODEL (OR PROVIDER) ANSWERED: `returned` maps SEGMENT id → masked translation. Each key of each
 * segment is unmasked with ITS OWN tokens (identical masked text, different pipes), then validated. Within a
 * question, two options / rows / columns that are different in the source but identical in the translation are a
 * `duplicate` (respondents could not tell them apart) — both are refused.
 */
export function checkTranslationBatch(units: TranslationUnit[], segments: TranslationSegment[], returned: Record<string, string | undefined>, lang: string, glossary: GlossaryEntry[] = []): BatchCheck {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const accepted: Record<string, string> = {};
  const issues: TranslationIssue[] = [];
  const review: BatchCheck["review"] = [];
  for (const seg of segments) {
    const raw = returned[seg.id];
    for (const key of seg.keys) {
      const u = byKey.get(key);
      if (!u) continue;
      if (raw == null) { issues.push({ key, label: u.label, kind: "missing", message: "no translation returned" }); continue; }
      const un = unmaskTranslation(raw, u.tokens);
      if (!un.ok) { issues.push({ key, label: u.label, kind: "corrupted", message: `protected parts ${[...un.missing.map((i) => `{${i}} lost`), ...un.duplicated.map((i) => `{${i}} doubled`), ...un.unknown.map((i) => `{${i}} invented`)].join(", ")}` }); continue; }
      const issue = validateTranslatedUnit(u, un.text, lang, glossary);
      if (issue) { issues.push(issue); continue; }
      accepted[key] = un.text.trim();
      if (norm(un.text) === norm(u.source) && !u.copyThrough) review.push({ key, label: u.label, why: "kept as written (a name or code?)" });
    }
  }
  for (const i of duplicateIssues(byKey, accepted)) { delete accepted[i.key]; issues.push(i); }
  return { accepted, issues, review };
}

/** within one question, options / rows / columns that differ in the source but read the same translated */
function duplicateIssues(byKey: Map<string, Pick<TranslationUnit, "key" | "label" | "kind" | "questionId" | "source">>, texts: Record<string, string>): TranslationIssue[] {
  const groups = new Map<string, string[]>();
  for (const [key, text] of Object.entries(texts)) {
    const u = byKey.get(key);
    if (!u?.questionId || !["option", "row", "column", "column_option"].includes(u.kind)) continue;
    const g = `${u.questionId}|${u.kind === "column_option" ? key.replace(/:opt:[^:]+$/, "") : u.kind}|${norm(text).toLowerCase()}`;
    groups.set(g, [...(groups.get(g) ?? []), key]);
  }
  const out: TranslationIssue[] = [];
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const sources = new Set(keys.map((k) => norm(byKey.get(k)!.source).toLowerCase()));
    if (sources.size < 2) continue;
    for (const k of keys) out.push({ key: k, label: byKey.get(k)!.label, kind: "duplicate", message: "the same translation as another answer of this question — respondents could not tell them apart" });
  }
  return out;
}

/* ------------------------------------------------------- completeness */

export interface TranslationCoverage {
  language: string;
  total: number;
  translated: number;
  /** 0–100 over the scope */
  percent: number;
  missing: string[];
  stale: string[];
  invalid: TranslationIssue[];
  rtl: boolean;
  complete: boolean;
}

/** the stored translation of `key` in `lang`, when it is there, current (source hash) and not empty */
function storedCurrent(def: SurveyDefinition, lang: string, u: TranslationUnit): { text: string } | "missing" | "stale" {
  const t = def.localization?.translations?.[lang]?.[u.key];
  if (!t || t.status === "not_translated" || !t.text.trim()) return "missing";
  if (t.status === "outdated" || (t.sourceHash && t.sourceHash !== u.sourceHash)) return "stale";
  return { text: t.text };
}

/**
 * THE FINAL CHECK over a language version: every unit of the scope has a current, valid translation; none is stale
 * (its source changed after it was translated), corrupted, untranslated, in the wrong script or duplicated inside a
 * question. `complete` only when all of that holds — never a false success.
 */
export function translationCoverage(def: SurveyDefinition, lang: string, units: TranslationUnit[]): TranslationCoverage {
  const glossary = effectiveLocalization(def).glossary ?? [];
  const missing: string[] = [], stale: string[] = [];
  const invalid: TranslationIssue[] = [];
  const texts: Record<string, string> = {};
  for (const u of units) {
    const s = storedCurrent(def, lang, u);
    if (s === "missing") { missing.push(u.key); continue; }
    if (s === "stale") { stale.push(u.key); continue; }
    const issue = validateTranslatedUnit(u, s.text, lang, glossary);
    if (issue) { invalid.push(issue); continue; }
    texts[u.key] = s.text;
  }
  // duplicates within a question, over what is stored
  for (const i of duplicateIssues(new Map(units.map((u) => [u.key, u])), texts)) { invalid.push(i); delete texts[i.key]; }
  const translated = Object.keys(texts).length;
  const total = units.length;
  const cfg = effectiveLocalization(def).languages.find((l) => l.code === lang);
  return { language: lang, total, translated, percent: total ? Math.floor((translated / total) * 1000) / 10 : 100, missing, stale, invalid, rtl: languageDirection(lang, cfg) === "rtl", complete: translated === total };
}

/**
 * RESUME: the keys that still need a translation — no current valid one stored. A batch whose keys are all covered
 * (it completed before an interruption) has nothing pending and is never sent again.
 */
export function pendingTranslationKeys(def: SurveyDefinition, lang: string, units: TranslationUnit[]): string[] {
  const glossary = effectiveLocalization(def).glossary ?? [];
  const out: string[] = [];
  for (const u of units) {
    const s = storedCurrent(def, lang, u);
    if (s === "missing" || s === "stale" || validateTranslatedUnit(u, s.text, lang, glossary)) out.push(u.key);
  }
  return out;
}

/* ------------------------------------------------------------ actions */

/**
 * set_translations entries (by element key) → actions of ≤ 400 entries (the gate's cap); replace mode → replace_wording.
 * `hashes` (key → textHash of the source that was translated) lets the apply step tell a translation of words the
 * element no longer has (the source was edited meanwhile) from a current one.
 */
export function translationTaskActions(lang: string, entries: Record<string, string>, mode: "version" | "replace" = "version", hashes: Record<string, string> = {}): Record<string, unknown>[] {
  const list = Object.entries(entries).map(([target, text]) => ({ target, text, ...(hashes[target] ? { sourceHash: hashes[target] } : {}) }));
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    out.push(mode === "replace" ? { op: "replace_wording", language: lang, entries: chunk } : { op: "set_translations", language: lang, entries: chunk, status: "ai" });
  }
  return out;
}

/* -------------------------------------------------------- languages */

/** a language as a person names it — "Urdu", "urdu", "اردو", "उर्दू", "ur", "Deutsch" — to its library code */
export function languageFromName(name: string): string | null {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  const SPOKEN: Record<string, string> = { "उर्दू": "ur", "اردو": "ur", "हिंदी": "hi", "हिन्दी": "hi", "मराठी": "mr", "ہندی": "hi", "عربی": "ar", "अरबी": "ar", "فارسی": "fa", "बंगाली": "bn", "तमिल": "ta", "तेलुगु": "te", "गुजराती": "gu", "पंजाबी": "pa", "پنجابی": "pa", "कन्नड़": "kn", "मलयालम": "ml", "अंग्रेज़ी": "en", "अंग्रेजी": "en", "इंग्लिश": "en" };
  if (SPOKEN[n]) return SPOKEN[n];
  const hit = LANGUAGE_LIBRARY.find((l) => l.code.toLowerCase() === n || l.name.toLowerCase() === n || l.nativeName.toLowerCase() === n);
  return hit ? hit.code : null;
}

/* ---------------------------------------------------- structure hash */

/**
 * THE SURVEY WITHOUT ITS WORDS: every translatable text blanked, the localization and timestamps dropped, then hashed. Logic,
 * piping, scripts, ids, codes, variables, quotas and settings must give the same hash before and after a
 * translation — a language version must not move anything else.
 */
export function surveyStructureHash(def: SurveyDefinition): string {
  const copy = JSON.parse(JSON.stringify(def)) as SurveyDefinition;
  for (const el of translatableElements(copy)) setSourceText(copy, el.key, "");
  delete (copy as { localization?: unknown }).localization;
  if (copy.deployment) delete (copy.deployment as { languages?: unknown }).languages;
  delete (copy as { updatedAt?: unknown }).updatedAt;
  // timestamps are bookkeeping, not structure (a legacy script migrated into a behaviour on load is stamped anew each time)
  const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).filter((k) => k !== "createdAt" && k !== "updatedAt").sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v);
  const s = JSON.stringify(stable(copy));
  let h1 = 2166136261, h2 = 5381;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 16777619); h2 = (Math.imul(h2, 33) ^ c) >>> 0; }
  return `${(h1 >>> 0).toString(36)}${h2.toString(36)}`;
}

/* ------------------------------------------------------ the fake seam */

const SCRIPT_BASE: Record<string, number[]> = {
  // 26 letters of the target script, a → z (Arabic-script letters for Urdu / Arabic / Persian)
  Arabic: [0x627, 0x628, 0x67e, 0x62a, 0x679, 0x62b, 0x62c, 0x686, 0x62d, 0x62e, 0x62f, 0x688, 0x630, 0x631, 0x691, 0x632, 0x698, 0x633, 0x634, 0x635, 0x636, 0x637, 0x638, 0x639, 0x63a, 0x641],
  Devanagari: Array.from({ length: 26 }, (_, i) => 0x915 + i),
  Cyrillic: Array.from({ length: 26 }, (_, i) => 0x430 + i),
  Hebrew: Array.from({ length: 26 }, (_, i) => 0x5d0 + (i % 27)),
  Greek: Array.from({ length: 26 }, (_, i) => 0x3b1 + (i % 25)),
  Bengali: Array.from({ length: 26 }, (_, i) => 0x995 + (i % 23)),
  Tamil: [0xb95, 0xb99, 0xb9a, 0xb9e, 0xb9f, 0xba3, 0xba4, 0xba8, 0xbaa, 0xbae, 0xbaf, 0xbb0, 0xbb2, 0xbb5, 0xbb4, 0xbb3, 0xbb1, 0xba9, 0xb9c, 0xbb7, 0xbb8, 0xbb9, 0xb85, 0xb86, 0xb87, 0xb88],
  Han: Array.from({ length: 26 }, (_, i) => 0x4e00 + i * 7),
  Hangul: Array.from({ length: 26 }, (_, i) => 0xac00 + i * 28),
};

/**
 * A DETERMINISTIC STAND-IN TRANSLATION for the fake provider and tests (never used with a real provider): the masked
 * text's letters are mapped one to one onto letters of the language's own script (so a "translated" Urdu string is in
 * Arabic script, passes the script check, and two different source strings stay different), sentinels untouched.
 * A Latin-script language gets a `[xx] ` prefix instead.
 */
export function pseudoTranslate(masked: string, lang: string): string {
  const scripts = expectedScripts(lang) ?? ["Latin"];
  const base = SCRIPT_BASE[scripts[0]];
  if (!base) return `[${lang}] ${masked}`;
  const parts = masked.split(/(\{\s*\d+\s*\})/g);
  return parts.map((p, i) => (i % 2 ? p : p.replace(/[A-Za-z]/g, (ch) => String.fromCodePoint(base[(ch.toLowerCase().charCodeAt(0) - 97) % base.length])))).join("");
}
