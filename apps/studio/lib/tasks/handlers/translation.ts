/**
 * TRANSLATION AS A DURABLE TASK (K3, 2026-10-25; ported onto the base engine 2026-10-29 —
 * docs/TRANSLATION-TASKS-2026-10-29.md).
 *
 * Production: "सर्वे को उर्दू में ट्रांस्लेट कर दो" on a 78-question survey was ONE model call → 163 s timeout;
 * "translate the first 10 questions into Urdu" → "the model answered in words, not changes". A translation request is
 * now planned into small, independently executable, validated steps, whatever its size:
 *
 *   translation.prepare   deterministic: the inventory (every respondent-facing string by stable key, protected
 *                         content masked — packages/engine/src/translationTask.ts), add_language when the version
 *                         does not exist yet, strings with nothing to translate (numbers, pipes only) copied through
 *   translation.batch     one adaptive batch (≤ 120 unique strings / ≤ 4,000 characters, a question's elements
 *                         together), cheapest tier, ONE structured call through ctx.ai; identical strings are one
 *                         segment (translation memory); keys already translated validly (a completed batch replayed
 *                         into the draft, an earlier translation still current) are never sent again; every returned
 *                         string is unmasked + validated (all protected parts byte-identical, non-empty, the
 *                         language's own script, not the source pasted back, options of one question distinct) and
 *                         the failures go to ONE targeted repair step with the reason (≤ 2 rounds); output limit →
 *                         split in halves
 *   translation.verify    deterministic: 100% of the scope covered by current, valid translations (or replaced
 *                         wording), structure hash unchanged, the RTL flag, a short "needs manual review" list; a gap
 *                         is translated here and re-checked (≤ 2 rounds), else the task does NOT complete
 *
 * The output is survey actions (set_translations by element key, with the source hash it was made from — or
 * replace_wording when the researcher asked to replace the wording), applied as one proposal at the end. Handlers are
 * pure w.r.t. persistence (the engine commits) and reach the model only through ctx.ai.
 */
import { createHash } from "node:crypto";
import type { GlossaryEntry, SurveyDefinition } from "@rescript/schema";
import { LANGUAGE_LIBRARY } from "@rescript/schema";
import {
  translationInventory, planTranslationBatches, segmentsOf, checkTranslationBatch, translationCoverage, pendingTranslationKeys, translationTaskActions,
  surveyStructureHash, pseudoTranslate, validateTranslatedUnit, unmaskTranslation, languageFromName, estimateBatchTokens, keepTerms, effectiveLocalization,
  languageName, languageDirection, expectedScripts, fenceUntrusted, UNTRUSTED_DATA_RULE, coerceSurveyActions, applySurveyActions,
  type TranslationScope, type TranslationUnit, type TranslationSegment, type TranslationIssue,
} from "@rescript/engine";
import type { StepContext, StepHandler, StepResult, TaskPlanner, TaskStepSpec, TaskSummary, StepOutput } from "../types.ts";
import { registerStepHandler, registerTaskPlanner, registerCompletionValidator } from "../registry.ts";
import { registerFakeResponder } from "../fakeResponders.ts";
import { spokenLanguages, spokenTranslation } from "../../copilot/spoken.ts";
import { LARGE_TRANSLATION_KEYS, SEVERAL_LANGUAGES } from "../../copilot/translationRouting.ts";
import { translationComplete } from "../../copilot/translationTask.ts";

/* ------------------------------------------------------------ the request */

export type TranslationMode = "version" | "replace";
export interface TranslationRequest {
  /** the first target language (the base's single-language callers) */
  language: string;
  /** every target language named, in the order named — "en français et en arabe" is two deliverables, one task */
  languages: string[];
  mode: TranslationMode;
  /** the question ids in scope — absent: the whole survey */
  questionIds?: string[];
  /** how the scope was said: "the whole survey", "the first 10 questions", "Q3–Q7", "block Brand" */
  scopeLabel: string;
}

/** a word for "translate" in the scripts and transcriptions researchers use */
const TRANSLATE_CUE = /translat\w*|tradu\w*|übersetz\w*|locali[sz]\w*|ترجم\S*|अनुवाद|भाषांतर|ट्रां?स्?\s?लेट\S*|ट्रान्सलेट\S*|ट्रांसलेशन|ट्रांस्लेशन|ترانسلیٹ|ٹرانسلیٹ/iu;
/** asking ABOUT translations, or another localization act — never a translation task */
const NOT_A_TRANSLATION = /\b(?:approve|approval|confirm|routing|route|glossary|remove|delete|status|ready|live|outdated|which languages?|how many|is it|are they)\b|\?\s*$/i;
const REPLACE_CUE = /\b(?:replace|instead|in place|nothing separate|rewrite|change (?:the )?(?:text|wording)|make (?:it|this|the survey|all (?:the )?questions?)\b)|इसे ही|इसी को|इसको ही|बदल दो|बदल कर|ہی\s|بدل دو/iu;
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50 };
const digits = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
const respondentQuestions = (def: SurveyDefinition) => def.questions.filter((q) => q.type !== "hidden" && q.type !== "embedded_data" && q.type !== "calculated");

/** language names in French, Spanish, German and Portuguese that the library's English / native names do not cover */
const OTHER_NAMES: Record<string, string> = {
  arabe: "ar", árabe: "ar", arabisch: "ar", anglais: "en", inglés: "en", ingles: "en", englisch: "en", inglês: "en", allemand: "de", alemán: "de", aleman: "de", alemão: "de", espagnol: "es", spanisch: "es", espanhol: "es",
  francais: "fr", francés: "fr", frances: "fr", französisch: "fr", francês: "fr", ourdou: "ur", urdú: "ur", hindi: "hi", portugais: "pt", portugués: "pt", portugiesisch: "pt", italien: "it", italiano: "it", italienisch: "it",
  chinois: "zh", chino: "zh", chinesisch: "zh", japonais: "ja", japonés: "ja", japanisch: "ja", russe: "ru", ruso: "ru", russisch: "ru", turc: "tr", turco: "tr", türkisch: "tr", bengali: "bn", tamoul: "ta", télougou: "te", persan: "fa", farsi: "fa",
};

/** every language a request names, in the order named, the survey's source left out */
export function requestedLanguages(message: string, sourceLanguage = "en"): string[] {
  const found: { code: string; at: number }[] = [];
  for (const l of spokenLanguages(message)) found.push({ code: l.code, at: message.search(new RegExp(l.name, "i")) });
  for (const l of LANGUAGE_LIBRARY) {
    for (const name of [l.name, l.nativeName]) {
      if (!name || name.length < 3) continue;
      const m = new RegExp(`(?<![\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").exec(message);
      if (m) found.push({ code: l.code, at: m.index });
    }
  }
  for (const m of message.matchAll(/(?<![\p{L}])(\p{L}{3,})(?![\p{L}])/gu)) { const c = languageFromName(m[1]) ?? OTHER_NAMES[m[1].toLowerCase()]; if (c && !/^(?:in|to)$/i.test(m[1])) found.push({ code: c, at: m.index ?? 0 }); }
  const codes = [...new Map(found.sort((a, b) => a.at - b.at).map((f) => [f.code, f])).keys()];
  return codes.filter((c) => c !== sourceLanguage);
}

/** the language a request names (not the survey's source, unless it is the only one named) */
export function requestedLanguage(message: string, sourceLanguage = "en"): string | null {
  return requestedLanguages(message, sourceLanguage)[0] ?? null;
}

/** "translate the survey into Urdu", "सर्वे को उर्दू में ट्रांस्लेट कर दो", "translate the first 10 questions into Urdu" → what to do, deterministically */
export function parseTranslationRequest(message: string, survey: unknown): TranslationRequest | null {
  const def = survey as SurveyDefinition | null;
  if (!def || !Array.isArray(def.questions) || !respondentQuestions(def).length) return null;
  const text = String(message ?? "").normalize("NFC");
  if (text.length > 1500) return null;
  const cue = TRANSLATE_CUE.test(text) || spokenTranslation(text) || /\b(?:add|create|make|need|want|build)\b[^.?!]{0,40}\b(?:version|translation)\b/i.test(text) || /\b(?:into|in)\s+\p{L}+\s+(?:version|please)?/iu.test(text) && /\b(?:survey|questions?|questionnaire|it|this|block)\b/i.test(text) && /\b(?:make|put|turn|convert|have|want|need)\b/i.test(text);
  if (!cue) return null;
  if (NOT_A_TRANSLATION.test(text) && !TRANSLATE_CUE.test(text)) return null;
  // a question about the translations ("which strings are untranslated?", "what is outdated in Urdu?") is answered, not run
  if (/^\s*(?:which|what|how|is|are|does|do|show|list|why|when)\b/i.test(text) || /\buntranslated\b|\bnot translated\b/i.test(text)) return null;
  if (/\b(?:approve|confirm|routing|glossary|remove|delete)\b/i.test(text)) return null;
  const source = effectiveLocalization(def).sourceLanguage;
  const languages = requestedLanguages(text, source);
  const language = languages[0];
  if (!language) return null;
  const mode: TranslationMode = REPLACE_CUE.test(text) || (!TRANSLATE_CUE.test(text) && /(?:में|मे)\s+(?:कर|करो|कर दो|करके)|میں\s+(?:کر|کریں)/u.test(text)) ? "replace" : "version";
  // scope
  const qs = respondentQuestions(def);
  const t = digits(text);
  const first = /\b(?:first|initial|top)\s+(\d+|[a-z]+)\s+(?:questions?|qs?)\b|(?:पहले|शुरू के|शुरुआती)\s+(\d+)\s*(?:सवाल|सवालों|प्रश्न|प्रश्नों|क्वेश्चन|questions?)|(?:پہلے|ابتدائی)\s+(\d+)\s*(?:سوال|سوالات)/iu.exec(t);
  if (first) {
    const raw = first[1] ?? first[2] ?? first[3] ?? "";
    const n = /^\d+$/.test(raw) ? Number(raw) : WORD_NUM[raw.toLowerCase()] ?? 0;
    if (n > 0) { const ids = qs.slice(0, n).map((q) => q.id); return { language, languages, mode, questionIds: ids, scopeLabel: `the first ${ids.length} question${ids.length === 1 ? "" : "s"}` }; }
  }
  const range = /\b([A-Z]{1,4})(\d+)\s*(?:-|–|—|to|through|thru|se|से|تا)\s*(?:[A-Z]{1,4})?(\d+)\b/i.exec(t);
  if (range) {
    const a = Number(range[2]), b = Number(range[3]);
    const ids = qs.filter((q) => { const m = /^([A-Za-z]+)(\d+)$/.exec(q.code); return !!m && m[1].toLowerCase() === range[1].toLowerCase() && Number(m[2]) >= Math.min(a, b) && Number(m[2]) <= Math.max(a, b); }).map((q) => q.id);
    if (ids.length) return { language, languages, mode, questionIds: ids, scopeLabel: `${range[1].toUpperCase()}${a}–${range[1].toUpperCase()}${b}` };
  }
  const named = qs.filter((q) => new RegExp(`(?<![\\p{L}\\p{N}_])${q.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(t));
  if (named.length) return { language, languages, mode, questionIds: named.map((q) => q.id), scopeLabel: named.map((q) => q.code).join(", ") };
  const blocks: { title: string; ids: string[] }[] = [];
  const walk = (nodes: unknown[], into: string[] | null) => { for (const n of nodes as { type: string; title?: string; questionIds?: string[]; children?: unknown[] }[]) { if (n.type === "block" || n.type === "section") { const b = { title: n.title ?? "", ids: [] as string[] }; blocks.push(b); walk(n.children ?? [], b.ids); if (into) into.push(...b.ids); } else if (n.type === "page") { if (into) into.push(...(n.questionIds ?? [])); } else if (Array.isArray(n.children)) walk(n.children, into); } };
  walk(def.flow as unknown[], null);
  const block = blocks.find((b) => b.title.trim().length > 2 && new RegExp(`\\b(?:block|section)\\s+["“']?${b.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(text) || (b.title.trim().length > 3 && /\b(?:block|section)\b/i.test(text) && text.toLowerCase().includes(b.title.toLowerCase())));
  if (block?.ids.length) return { language, languages, mode, questionIds: block.ids, scopeLabel: `block “${block.title}”` };
  return { language, languages, mode, scopeLabel: "the whole survey" };
}

const scopeOf = (inp: { questionIds?: string[]; mode?: TranslationMode }): TranslationScope => ({ ...(inp.questionIds ? { questionIds: inp.questionIds } : {}), ...(inp.mode === "replace" ? { excludeUi: true } : {}) });

/* -------------------------------------------------------------- the model */

export const TRANSLATE_BATCH_SCHEMA = {
  name: "rescript_translation_batch",
  schema: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false } },
      review: { type: "array", items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id", "why"], additionalProperties: false } },
    },
    required: ["items", "review"],
    additionalProperties: false,
  },
};

/** the translator's instructions — static per language pair (a cacheable system block) */
export function translatorSystem(source: string, target: string): string {
  const scripts = expectedScripts(target);
  return [
    `You translate survey wording from ${languageName(source)} (${source}) into ${LANGUAGE_LIBRARY.find((l) => l.code === target)?.name ?? target} (${target})${scripts ? `, written in ${scripts.join(" / ")} script` : ""}. You are part of a program: answer ONLY the JSON object {"items":[{"id","text"}],"review":[{"id","why"}]} — never prose.`,
    "Translate EVERY item, one output item per input id. Each {0}, {1} … is a protected placeholder (a pipe, a code, a link, HTML): keep each one exactly once, unchanged, where the grammar of the target language puts it; never add, drop, translate or renumber one.",
    "Write for a questionnaire: natural, polite/formal register, the same meaning; answer options of one question stay distinct; scale labels keep their order and strength; numbers, units and names stay as they are. Never explain, never transliterate into Latin letters, never leave an item in the source language unless it is a proper name.",
    "Put an id in \"review\" (with a few words why) only when the source is genuinely ambiguous for a translator (a word with two meanings and no context, an idiom, a pun); keep that list short.",
    UNTRUSTED_DATA_RULE,
  ].join("\n");
}

/** the batch, as the model reads it: fenced data, one JSON line per unique string, with its context */
export function translatorPrompt(stepId: string, target: string, segs: TranslationSegment[], glossary: GlossaryEntry[], feedback: Record<string, string> = {}): string {
  const lines = segs.map((s, i) => JSON.stringify({ id: String(i + 1), ctx: s.label.slice(0, 60), text: s.masked, ...(feedback[s.id] ? { fix: feedback[s.id].slice(0, 160) } : {}) }));
  const prefer = glossary.filter((g) => !g.doNotTranslate && g.targets?.[target]).map((g) => `"${g.source}" → "${g.targets![target]}"`).slice(0, 40);
  const nonce = createHash("sha256").update(stepId).digest("hex").slice(0, 12);
  return [
    `TARGET_LANGUAGE=${target}`,
    prefer.length ? `Preferred wordings (glossary): ${prefer.join("; ")}` : "",
    Object.keys(feedback).length ? "Some items were refused before; an item's \"fix\" says why — correct exactly that." : "",
    `Translate these ${segs.length} items:`,
    fenceUntrusted(lines.join("\n"), { source: "the survey's own wording", nonce }),
  ].filter(Boolean).join("\n");
}

/** the fake provider's stand-in translator (fake only — registered as a responder, never read with a real provider) */
export function fakeTranslationAnswer(prompt: string): { items: { id: string; text: string }[]; review: { id: string; why: string }[] } | undefined {
  const lang = /TARGET_LANGUAGE=([a-z-]+)/i.exec(prompt)?.[1];
  if (!lang) return undefined;
  const items: { id: string; text: string }[] = [];
  for (const line of prompt.split("\n")) {
    if (!line.startsWith("{\"id\":")) continue;
    try { const o = JSON.parse(line) as { id: string; text: string }; items.push({ id: o.id, text: pseudoTranslate(o.text, lang) }); } catch { /* not ours */ }
  }
  return items.length ? { items, review: [] } : undefined;
}

/* -------------------------------------------------------------- translating */

interface TranslateOutcome { entries: Record<string, string>; hashes: Record<string, string>; issues: TranslationIssue[]; review: { key: string; label: string; why: string }[]; reused: number; sent: number; failure?: { kind: string; message: string; retryAfterMs?: number } }

/** a stored translation of another element with the same masked wording, re-fitted to THIS element's protected parts */
function fromMemory(u: TranslationUnit, other: TranslationUnit, stored: string): string | null {
  let t = stored;
  const order = other.tokens.map((tok, i) => ({ tok, i })).sort((a, b) => b.tok.length - a.tok.length);
  for (const { tok, i } of order) { if (!t.includes(tok)) return null; t = t.split(tok).join(`\u0000${i}\u0000`); }
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, d) => `{${d}}`);
  const un = unmaskTranslation(t, u.tokens);
  return un.ok ? un.text : null;
}

/**
 * Translate `units` (the pending ones) into `lang`: memory first (the same wording translated elsewhere in this
 * survey, validated again for this element), copy-through for strings with nothing to translate, then ONE structured
 * model call for the unique rest. Returns what was validated, and the refusals by key.
 */
async function translateUnits(ctx: StepContext, all: TranslationUnit[], units: TranslationUnit[], lang: string, source: string, mode: TranslationMode, feedback: Record<string, string>): Promise<TranslateOutcome> {
  const draft = ctx.draft as SurveyDefinition;
  const glossary = effectiveLocalization(draft).glossary ?? [];
  const out: TranslateOutcome = { entries: {}, hashes: {}, issues: [], review: [], reused: 0, sent: 0 };
  const rest: TranslationUnit[] = [];
  const table = draft.localization?.translations?.[lang] ?? {};
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const byMasked = new Map<string, TranslationUnit[]>();
  for (const u of all) byMasked.set(norm(u.masked), [...(byMasked.get(norm(u.masked)) ?? []), u]);
  for (const u of units) {
    out.hashes[u.key] = u.sourceHash;
    if (u.copyThrough) { out.entries[u.key] = u.source; continue; }
    if (mode === "version" && !feedback[u.key]) {
      let hit: string | null = null;
      for (const o of byMasked.get(norm(u.masked)) ?? []) {
        if (o.key === u.key) continue;
        const t = table[o.key];
        if (!t || t.status === "not_translated" || t.status === "outdated" || !t.text.trim() || (t.sourceHash && t.sourceHash !== o.sourceHash)) continue;
        const cand = fromMemory(u, o, t.text);
        if (cand && !validateTranslatedUnit(u, cand, lang, glossary)) { hit = cand; break; }
      }
      if (hit) { out.entries[u.key] = hit; out.reused++; continue; }
    }
    rest.push(u);
  }
  if (!rest.length) return out;
  const segs = segmentsOf(rest);
  const segFeedback: Record<string, string> = {};
  for (const s of segs) { const f = s.keys.map((k) => feedback[k]).find(Boolean); if (f) segFeedback[s.id] = f; }
  const est = estimateBatchTokens(segs.reduce((n, s) => n + s.masked.length, 0), segs.length, lang);
  out.sent = segs.length;
  const r = await ctx.ai({
    purpose: "translation.batch", tier: "small", system: translatorSystem(source, lang), prompt: translatorPrompt(ctx.step.id, lang, segs, glossary, segFeedback),
    schema: TRANSLATE_BATCH_SCHEMA, maxTokens: Math.min(16_000, Math.max(800, Math.ceil(est.outputTokens * 1.5) + 200)),
  });
  if (!r.ok) { out.failure = { kind: r.kind, message: r.message, ...(r.retryAfterMs != null ? { retryAfterMs: r.retryAfterMs } : {}) }; return out; }
  const v = (r.value ?? {}) as { items?: { id?: unknown; text?: unknown }[]; review?: { id?: unknown; why?: unknown }[] };
  if (!Array.isArray(v.items)) { out.failure = { kind: "invalid_output", message: "the model answered without the items list" }; return out; }
  const returned: Record<string, string | undefined> = {};
  for (const it of v.items) { const i = Number(it?.id) - 1; if (Number.isInteger(i) && segs[i] && typeof it.text === "string") returned[segs[i].id] = it.text; }
  const check = checkTranslationBatch(rest, segs, returned, lang, glossary);
  Object.assign(out.entries, check.accepted);
  out.issues.push(...check.issues);
  out.review.push(...check.review);
  for (const rv of Array.isArray(v.review) ? v.review.slice(0, 10) : []) {
    const seg = segs[Number(rv?.id) - 1];
    if (seg && typeof rv.why === "string") out.review.push({ key: seg.keys[0], label: seg.label, why: rv.why.slice(0, 120) });
  }
  return out;
}

/** a model failure, as the engine's result: smaller batches for a limit, wait for a transient one, stop for auth/config */
function failureResult(ctx: StepContext, f: NonNullable<TranslateOutcome["failure"]>, keys: string[]): StepResult {
  const half = (): StepResult => {
    const mid = Math.ceil(keys.length / 2);
    const mk = (suffix: string, ks: string[]): TaskStepSpec => ({ ...specOf(ctx), id: `${ctx.step.id}${suffix}`, title: `${ctx.step.title} (${suffix === "a" ? "first" : "second"} half)`, input: { ...ctx.step.input, keys: ks, units: ks.length } });
    return { status: "split", reason: `${f.kind}: ${f.message}`, replaceWith: [mk("a", keys.slice(0, mid)), mk("b", keys.slice(mid))] };
  };
  switch (f.kind) {
    case "output_limit": case "context_limit": return keys.length > 1 ? half() : { status: "failed", reason: `${f.kind}: one string is longer than the model can translate in one answer`, permanent: true };
    case "invalid_output": return ctx.attempt >= 2 && keys.length > 8 ? half() : { status: "retry", reason: `invalid_output: ${f.message}` };
    case "auth": return { status: "blocked", reason: f.message, needs: "auth" };
    case "config": return { status: "blocked", reason: f.message, needs: "config" };
    case "budget": return { status: "blocked", reason: f.message, needs: "budget" };
    default: return { status: "retry", reason: `${f.kind}: ${f.message}`, ...(f.retryAfterMs != null ? { retryAfterMs: f.retryAfterMs } : {}) };
  }
}
const specOf = (ctx: StepContext): TaskStepSpec => ({ id: ctx.step.id, kind: ctx.step.kind, title: ctx.step.title, dependsOn: ctx.step.dependsOn, input: ctx.step.input, ...(ctx.step.parallelGroup ? { parallelGroup: ctx.step.parallelGroup } : {}), ...(ctx.step.modelTier ? { modelTier: ctx.step.modelTier } : {}) });

interface StepInput { language: string; sourceLanguage: string; mode: TranslationMode; questionIds?: string[]; keys: string[]; hashes: Record<string, string>; round?: number; feedback?: Record<string, string>; structureHash?: string; scopeLabel?: string; units?: number; range?: { from: number; to: number } }
const inputOf = (ctx: StepContext) => ctx.step.input as unknown as StepInput;

/** replace mode: the wording is still the one the plan saw, and it does not already read as the target language (a brand name kept as written does) */
function notReplaced(u: TranslationUnit, inp: StepInput): boolean {
  if (u.copyThrough || inp.hashes[u.key] !== u.sourceHash) return false;
  return !!validateTranslatedUnit(u, u.source, inp.language);
}

/** the keys of `keys` still to do in the draft: no current valid translation (version), or wording not yet replaced (replace) */
function stillPending(draft: SurveyDefinition, inp: StepInput, units: TranslationUnit[]): TranslationUnit[] {
  if (inp.mode === "replace") return units.filter((u) => notReplaced(u, inp));
  const p = new Set(pendingTranslationKeys(draft, inp.language, units));
  return units.filter((u) => p.has(u.key));
}

/* ---------------------------------------------------------------- handlers */

const prepareHandler: StepHandler = {
  kind: "translation.prepare",
  async run(ctx) {
    const inp = inputOf(ctx);
    const draft = ctx.draft as SurveyDefinition;
    const inv = translationInventory(draft, scopeOf(inp));
    const actions: Record<string, unknown>[] = [];
    const loc = effectiveLocalization(draft);
    if (inp.mode === "version" && inp.language !== loc.sourceLanguage && !loc.languages.some((l) => l.code === inp.language)) actions.push({ op: "add_language", code: inp.language });
    const copy: Record<string, string> = {}, hashes: Record<string, string> = {};
    if (inp.mode === "version") {
      const pending = new Set(pendingTranslationKeys(draft, inp.language, inv.units));
      for (const u of inv.units) if (u.copyThrough && pending.has(u.key)) { copy[u.key] = u.source; hashes[u.key] = u.sourceHash; }
      actions.push(...translationTaskActions(inp.language, copy, "version", hashes));
    }
    const already = inp.mode === "version" ? inv.units.length - pendingTranslationKeys(draft, inp.language, inv.units).length : 0;
    return { status: "completed", output: {
      actions,
      data: { language: inp.language, mode: inp.mode, scope: inp.scopeLabel, strings: inv.units.length, protectedTokens: inv.protectedTokens, copyThrough: Object.keys(copy).length, alreadyTranslated: already, byKind: inv.byKind, notCovered: inv.notCovered },
      validation: { ok: true, errors: [], warnings: inv.notCovered.length ? [`Not part of a language version (shown in the source wording): ${inv.notCovered.join("; ")}`] : [] },
    } };
  },
};

const batchHandler: StepHandler = {
  kind: "translation.batch",
  async run(ctx) {
    const inp = inputOf(ctx);
    const draft = ctx.draft as SurveyDefinition;
    const all = translationInventory(draft, scopeOf(inp)).units;
    const byKey = new Map(all.map((u) => [u.key, u]));
    const mine = inp.keys.map((k) => byKey.get(k)).filter((u): u is TranslationUnit => !!u);
    const gone = inp.keys.length - mine.length;
    const pending = stillPending(draft, inp, mine);
    if (!pending.length) {
      return { status: "completed", output: { actions: [], data: { translated: 0, reused: mine.length, gone }, validation: { ok: true, errors: [], warnings: gone ? [`${gone} element${gone === 1 ? "" : "s"} no longer in the survey`] : [] } } };
    }
    const r = await translateUnits(ctx, all, pending, inp.language, inp.sourceLanguage, inp.mode, inp.feedback ?? {});
    if (r.failure) return failureResult(ctx, r.failure, pending.map((u) => u.key));
    const actions = translationTaskActions(inp.language, r.entries, inp.mode, r.hashes);
    const round = inp.round ?? 0;
    const output: StepOutput = {
      actions,
      data: { translated: Object.keys(r.entries).length - r.reused, reused: r.reused + (mine.length - pending.length), sent: r.sent, refused: r.issues.length, review: r.review.slice(0, 20), round },
      validation: { ok: true, errors: [], warnings: r.issues.length && round >= 2 ? r.issues.slice(0, 10).map((i) => `${i.label}: ${i.message}`) : [] },
    };
    if (r.issues.length && round < 2) {
      const keys = [...new Set(r.issues.map((i) => i.key))];
      const feedback = Object.fromEntries(r.issues.map((i) => [i.key, `${i.kind}: ${i.message}`]));
      const base = ctx.step.id.replace(/-r\d+$/, "");
      return { status: "repair", output, repair: { id: `${base}-r${round + 1}`, kind: "translation.batch", title: `Fix ${keys.length} refused string${keys.length === 1 ? "" : "s"} (${inp.scopeLabel ?? "batch"})`, dependsOn: [], modelTier: "small", input: { ...inp, keys, round: round + 1, feedback, units: keys.length } as unknown as Record<string, unknown> } };
    }
    return { status: "completed", output };
  },
};

const verifyHandler: StepHandler = {
  kind: "translation.verify",
  async run(ctx) {
    const inp = inputOf(ctx);
    let draft = ctx.draft as SurveyDefinition;
    const units = translationInventory(draft, scopeOf(inp)).units;
    const gapsOf = (d: SurveyDefinition): { keys: string[]; issues: TranslationIssue[] } => {
      if (inp.mode === "replace") {
        const now = new Map(translationInventory(d, scopeOf(inp)).units.map((u) => [u.key, u]));
        const left = [...now.values()].filter((u) => notReplaced(u, inp));
        return { keys: left.map((u) => u.key), issues: [] };
      }
      const cov = translationCoverage(d, inp.language, translationInventory(d, scopeOf(inp)).units);
      return { keys: [...cov.missing, ...cov.stale, ...cov.invalid.map((i) => i.key)], issues: cov.invalid };
    };
    let gaps = gapsOf(draft);
    const actions: Record<string, unknown>[] = [];
    const round = inp.round ?? 0;
    const warnings: string[] = [];
    if (gaps.keys.length && round < 3) {
      // translate the gaps here, then check again on the draft with them applied
      const pend = units.filter((u) => gaps.keys.includes(u.key));
      const fb = Object.fromEntries(gaps.issues.map((i) => [i.key, `${i.kind}: ${i.message}`]));
      const r = await translateUnits(ctx, units, pend, inp.language, inp.sourceLanguage, inp.mode, fb);
      if (r.failure) return failureResult(ctx, r.failure, pend.map((u) => u.key));
      actions.push(...translationTaskActions(inp.language, r.entries, inp.mode, r.hashes));
      const c = coerceSurveyActions(actions);
      const applied = applySurveyActions(draft, c.actions, { now: new Date(0).toISOString() });
      draft = applied.def;
      gaps = gapsOf(draft);
      if (gaps.keys.length && round < 2) {
        return { status: "repair", output: { actions, data: { round, left: gaps.keys.length }, validation: { ok: true, errors: [], warnings: [] } }, repair: { id: `${ctx.step.id.replace(/-r\d+$/, "")}-r${round + 1}`, kind: "translation.verify", title: `Check again after fixing ${gaps.keys.length} string${gaps.keys.length === 1 ? "" : "s"}`, dependsOn: [], modelTier: "small", input: { ...inp, round: round + 1 } as unknown as Record<string, unknown> } };
      }
    }
    // the final word
    const errors: string[] = [];
    const finalUnits = translationInventory(draft, scopeOf(inp)).units;
    let coverage: { total: number; translated: number; percent: number };
    if (inp.mode === "replace") {
      const left = gaps.keys.length;
      const total = finalUnits.length;
      coverage = { total, translated: total - left, percent: total ? Math.floor(((total - left) / total) * 1000) / 10 : 100 };
    } else {
      const cov = translationCoverage(draft, inp.language, finalUnits);
      coverage = { total: cov.total, translated: cov.translated, percent: cov.percent };
    }
    if (gaps.keys.length) errors.push(`${gaps.keys.length} of ${coverage.total} strings are not validly translated: ${gaps.keys.slice(0, 8).join(", ")}${gaps.keys.length > 8 ? " …" : ""}${gaps.issues.length ? ` (${gaps.issues.slice(0, 3).map((i) => `${i.label}: ${i.message}`).join("; ")})` : ""}`);
    const hash = surveyStructureHash(draft);
    if (inp.structureHash && hash !== inp.structureHash) errors.push("Something other than wording changed (logic, codes, piping, scripts or settings) — the translation would alter the survey's structure.");
    // a whole-survey replacement makes the language the source (RTL from it); emitted once, after every element is replaced
    if (inp.mode === "replace" && !inp.questionIds && !errors.length && effectiveLocalization(draft).sourceLanguage !== inp.language) actions.push({ op: "replace_wording", language: inp.language, sourceLanguage: true, entries: [] });
    const loc = effectiveLocalization(draft);
    const rtl = languageDirection(inp.language, loc.languages.find((l) => l.code === inp.language)) === "rtl";
    const review: { key: string; label: string; why: string }[] = [];
    for (const o of Object.values(ctx.deps)) for (const x of ((o.data as { review?: typeof review } | undefined)?.review ?? [])) if (!review.some((y) => y.key === x.key)) review.push(x);
    if (inp.mode === "replace" && !inp.questionIds) warnings.push("The runtime's own interface strings (“This question is required.”, Next) are not survey wording — they follow the source language's built-in texts.");
    return { status: "completed", output: {
      actions,
      data: { language: inp.language, mode: inp.mode, scope: inp.scopeLabel, coverage, rtl, structureHash: hash, review: review.slice(0, 20) },
      validation: { ok: !errors.length, errors, warnings: [...warnings, ...(review.length ? [`${review.length} string${review.length === 1 ? "" : "s"} worth a look by a person (kept as written or ambiguous)`] : [])] },
    } };
  },
};

/* ----------------------------------------------------------------- planner */

/**
 * THE BATCH POLICY: ≤ 120 unique strings and ≤ 4,000 source characters a batch (≈ 1,150 input tokens of text; an Urdu
 * answer of ≈ 3,000–3,500 output tokens — well inside one step's 90 s on the small tier), a question's elements kept
 * together, a tail under 40 strings merged into the previous batch. An output/context limit halves a batch.
 */
export const TRANSLATION_POLICY = { maxItems: 120, maxChars: 4000, minItems: 40 };

/**
 * IS THIS TRANSLATION A TASK? The count is read OFF THE SURVEY, never off the sentence: the strings still to
 * translate in the requested scope (the engine's inventory, pending by source hash), against the base's two named
 * numbers — `LARGE_TRANSLATION_KEYS` (one turn's honest ceiling) and `SEVERAL_LANGUAGES` (a second language is a
 * second deliverable). Past either line the score is 0.95 and the request is a task whatever `estimateTaskSize`
 * says; under both it is 0.5: still THIS planner when the size estimate decides on a task (never the generic one
 * answering a translation in words), and the in-turn path otherwise, exactly as before.
 */
export function translationWork(def: SurveyDefinition, req: TranslationRequest): { pending: number; strings: number; languages: number; large: boolean } {
  const loc = effectiveLocalization(def);
  const inv = translationInventory(def, scopeOf({ ...(req.questionIds ? { questionIds: req.questionIds } : {}), mode: req.mode }));
  let pending = 0;
  for (const lang of req.languages) {
    const exists = loc.languages.some((l) => l.code === lang);
    const todo = req.mode === "version" && exists ? pendingTranslationKeys(def, lang, inv.units) : inv.units.map((u) => u.key);
    pending += todo.length;
  }
  return { pending, strings: inv.units.length, languages: req.languages.length, large: pending >= LARGE_TRANSLATION_KEYS || req.languages.length >= SEVERAL_LANGUAGES };
}

export const translationPlanner: TaskPlanner = {
  id: "translation",
  matches({ message, survey }) {
    const req = parseTranslationRequest(message, survey);
    if (!req) return 0;
    return translationWork(survey as SurveyDefinition, req).large ? 0.95 : 0.5;
  },
  async plan({ message, survey, summary }) {
    const def = survey as SurveyDefinition;
    const req = parseTranslationRequest(message, survey);
    if (!req) throw new Error("validation: not a translation request this planner can plan");
    const loc = effectiveLocalization(def);
    const source = loc.sourceLanguage;
    if (req.languages.every((l) => l === source) && req.mode === "version") throw new Error(`validation: ${languageName(source)} is already the survey's source language`);
    const scope = scopeOf({ ...(req.questionIds ? { questionIds: req.questionIds } : {}), mode: req.mode });
    const inv = translationInventory(def, scope);
    const hashes = Object.fromEntries(inv.units.map((u) => [u.key, u.sourceHash]));
    const order = new Map(inv.units.map((u, i) => [u.key, i]));
    const structureHash = surveyStructureHash(def);
    const steps: TaskStepSpec[] = [];
    const completion: string[] = [];
    const names: string[] = [];
    let batchesInAll = 0;
    for (const language of req.languages) {
      if (language === source && req.mode === "version") continue;
      const exists = loc.languages.some((l) => l.code === language);
      const pendingKeys = new Set(req.mode === "version" && exists ? pendingTranslationKeys(def, language, inv.units) : inv.units.map((u) => u.key));
      const todo = inv.units.filter((u) => pendingKeys.has(u.key) && !u.copyThrough);
      const batches = planTranslationBatches(todo, TRANSLATION_POLICY);
      batchesInAll += batches.length;
      const name = LANGUAGE_LIBRARY.find((l) => l.code === language)?.name ?? language;
      names.push(name);
      const common = { language, sourceLanguage: source, mode: req.mode, ...(req.questionIds ? { questionIds: req.questionIds } : {}), scopeLabel: req.scopeLabel };
      const pre = `tr.${language}`;
      const own: TaskStepSpec[] = [
        { id: `${pre}.prepare`, kind: "translation.prepare", title: `Inventory ${inv.units.length} strings (${req.scopeLabel}) for ${name}`, dependsOn: [], input: { ...common, keys: [], hashes: {}, units: inv.units.length }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } },
        ...batches.map((b): TaskStepSpec => {
          const pos = b.own.map((k) => order.get(k) ?? 0);
          const est = estimateBatchTokens(b.chars, b.segments, language);
          return {
            id: `${pre}.b${String(b.index + 1).padStart(2, "0")}`, kind: "translation.batch", title: `Translate batch ${b.index + 1} of ${batches.length} into ${name} (${b.segments} strings)`,
            dependsOn: [`${pre}.prepare`], parallelGroup: `translate:${language}`, modelTier: "small",
            input: { ...common, keys: b.keys, hashes: Object.fromEntries(b.keys.map((k) => [k, hashes[k]])), units: b.keys.length, range: { from: Math.min(...pos) + 1, to: Math.max(...pos) + 1 } },
            estimate: { ...est, usd: Math.round((est.inputTokens * 0.25 + est.outputTokens * 1.25) / 1e6 * 1e5) / 1e5 },
          };
        }),
      ];
      own.push({ id: `${pre}.verify`, kind: "translation.verify", title: `Check every ${name} string (${inv.units.length}) and the structure`, dependsOn: own.map((s) => s.id), modelTier: "small", input: { ...common, keys: [], hashes, structureHash, units: inv.units.length } });
      steps.push(...own);
      completion.push(`translation:${language}:${req.mode}:${req.questionIds ? `q=${req.questionIds.join(",")}` : "all"}`);
    }
    if (!steps.length) throw new Error("validation: no target language to translate into");
    const list = names.join(", ");
    const what = req.mode === "replace" ? `Replace the wording of ${req.scopeLabel} with ${list}` : `Translate ${req.scopeLabel} into ${list} (${names.length === 1 ? "a language version" : "one language version each"})`;
    const first = req.languages[0];
    const sum: TaskSummary = {
      goal: what,
      deliverables: [...names.map((name) => (req.mode === "replace" ? `${name} wording in place of the source (${inv.units.length} strings)` : `${name} version: ${inv.units.length} strings, 100% covered`)), "a short list of strings for a person to check"],
      constraints: ["codes, variables, logic, piping, scripts and settings unchanged", "every protected token byte-identical", ...req.languages.map((l) => `${LANGUAGE_LIBRARY.find((x) => x.code === l)?.name ?? l} script${languageDirection(l) === "rtl" ? ", right to left" : ""}`)],
      decisions: [req.mode === "replace" ? "replace the source wording (said by the researcher)" : "add a language version (the source wording stays)", `${batchesInAll} batch${batchesInAll === 1 ? "" : "es"} of ≤ ${TRANSLATION_POLICY.maxItems} strings`],
      language: summary?.language ?? first,
      sourceTurnIds: summary?.sourceTurnIds ?? [],
    };
    return { summary: sum, steps, completion };
  },
};

/** the final check on the finished draft: every language's scope 100 % covered (the base's one gate: translationComplete with the scope) */
export function translationCompletion(draft: unknown, completion: string[]): { ok: boolean; errors: string[]; warnings: string[] } | null {
  const lines = completion.filter((c) => /^translation:/.test(c));
  if (!lines.length) return null;
  const def = draft as SurveyDefinition;
  const errors: string[] = [];
  for (const line of lines) {
    const m = /^translation:([a-z-]+):(version|replace):(all|q=(.*))$/.exec(line);
    if (!m) { errors.push(`unreadable completion criterion: ${line}`); continue; }
    if (m[2] === "replace") continue; // checked against the plan's hashes by translation.verify
    const units = translationInventory(def, scopeOf({ ...(m[4] ? { questionIds: m[4].split(",") } : {}), mode: "version" })).units;
    const r = translationComplete(def, m[1], { units });
    if (!r.ok) errors.push(...r.problems.slice(0, 6));
  }
  return { ok: !errors.length, errors, warnings: [] };
}

export function registerTranslationTasks(): void {
  /* idempotent by construction (last registration wins) — no module flag to defeat a test's registry reset */
  registerTaskPlanner(translationPlanner);
  registerStepHandler(prepareHandler);
  registerStepHandler(batchHandler);
  registerStepHandler(verifyHandler);
  registerCompletionValidator("translation", (draft, completion) => translationCompletion(draft, completion));
  registerFakeResponder("translation.", (call) => { const v = fakeTranslationAnswer(call.prompt); return v ? { value: v } : undefined; });
}
