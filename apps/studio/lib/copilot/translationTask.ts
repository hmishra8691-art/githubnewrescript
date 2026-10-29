/**
 * TRANSLATION AS A REAL TASK KIND — the Studio layer. — Owner: R4 (2026-10-24); thinned onto the engine 2026-10-29.
 *
 * Since 2026-10-29 every decision that does not need a model is made ONCE, in
 * `packages/engine/src/translationTask.ts` (ported from K3): the masked
 * inventory by stable element key (`translationInventory`), the adaptive
 * batches with translation memory (`planTranslationBatches`), the per-unit
 * verdict on what came back (`validateTranslatedUnit`: lost or invented
 * sentinels, placeholders, HTML, an untranslated string, the wrong script, a
 * glossary term), the resume set by source hash (`pendingTranslationKeys`) and
 * the 100 % coverage check (`translationCoverage`). This module adds only what
 * the Studio needs around those and keeps the names the base's callers and
 * tests use:
 *
 *   translationInventory(def, lang)   the engine's inventory with each unit's
 *                                     STATE in `lang` (missing / outdated /
 *                                     invalid / translated), mandatory first
 *   translationBatches(units, size)   the engine's planner capped at `size`
 *                                     unique strings per batch, with the
 *                                     1-based positions the panel shows
 *   checkTranslationBatch(units, …)   the engine's verdict per key, worded for
 *                                     the panel; nothing refused is written
 *   applyTranslationBatch             one write per accepted key through
 *                                     `recordTranslation` (the source hash
 *                                     travels, so a later edit goes stale)
 *   translationComplete(def, lang)    THE ONE GATE: `lintLanguage(def, lang)
 *                                     .ready` + the configured-language rule,
 *                                     and — when a scope is given — the
 *                                     engine's `translationCoverage` over it
 *                                     (100 % of the scope, nothing stale or
 *                                     invalid). The task handler's verify
 *                                     step and the completion validator call
 *                                     this and nothing else.
 *   translationResumeFrom             the first key that is missing, stale,
 *                                     invalid or blocking — never the first
 *                                     key of the language
 *
 * It never calls `taskStoreFor`: the store is injected, so the runner, the
 * route and the tests all supply their own.
 */
import type { GlossaryEntry, Localization, SurveyDefinition, TranslationEntry } from "@rescript/schema";
import {
  effectiveLocalization,
  lintLanguage,
  markOutdated,
  pendingTranslationKeys,
  planTranslationBatches,
  recordTranslation,
  surveyLanguages,
  textHash,
  translationCoverage,
  translationInventory as engineInventory,
  validateTranslatedUnit,
  type DeliverableReport,
  type DeliverableSpec,
  type ExecStep,
  type ExecTask,
  type TranslationScope,
  type TranslationUnit as EngineUnit,
} from "@rescript/engine";
import type { CreateTaskInput, TaskStore } from "./taskStore.ts";

/** the default batch — unique strings per batch; tuneable per task, halved by the runner on a context limit */
export const DEFAULT_TRANSLATION_BATCH = 40;

/* ===================================================== the inventory */

/** `invalid`: text is stored but the engine refuses it (a lost pipe, the wrong script, identical to the source …) */
export type UnitState = "missing" | "outdated" | "invalid" | "translated";

export interface TranslationUnit extends EngineUnit {
  /**
   * THE PROTECTED STRUCTURE of this string — the engine's masked tokens:
   * pipes, variables, loop references, `{word}` parameters, question codes,
   * HTML, scripts, URLs, e-mail addresses and glossary terms. Every one must
   * come back byte-identical; they are listed so a prompt can show them.
   */
  protectedTokens: string[];
  state: UnitState;
}

export interface TranslationInventory {
  language: string;
  /** the source language the strings are read from */
  sourceLanguage: string;
  units: TranslationUnit[];
  mandatory: number;
  optional: number;
  missing: number;
  outdated: number;
  /** stored but refused by the engine's validator */
  invalid: number;
  /**
   * STRUCTURAL ELEMENTS THAT ARE NOT TEXT and are never sent anywhere: the
   * element keys themselves, the protected tokens inside the strings, and the
   * parts of the definition `translatableElements` deliberately leaves out —
   * scripts, calculations, hidden and embedded-data questions, option CODES,
   * variable names. They must come through byte-identical because nothing
   * ever rewrites them.
   */
  protectedStructure: {
    elementKeys: number;
    tokens: string[];
    excluded: { what: string; count: number }[];
  };
  /** respondent-facing text the language-version system does not carry (said, never hidden) */
  notCovered: string[];
}

const storedState = (entry: TranslationEntry | undefined, sourceHash: string): "missing" | "outdated" | "stored" => {
  if (!entry || entry.status === "not_translated" || !entry.text.trim()) return "missing";
  if (entry.status === "outdated" || (entry.sourceHash && entry.sourceHash !== sourceHash)) return "outdated";
  return "stored";
};

/**
 * WHAT THIS LANGUAGE STILL NEEDS, in editor order, mandatory strings first.
 * The engine's inventory (masked, by stable key, with the source hash) plus
 * each unit's state in `lang` — never a second walk of the definition.
 */
export function translationInventory(def: SurveyDefinition, lang: string, scope: TranslationScope = {}): TranslationInventory {
  const loc = effectiveLocalization(def);
  const table = loc.translations[lang] ?? {};
  const inv = engineInventory(def, scope);
  const pending = new Set(pendingTranslationKeys(def, lang, inv.units));
  const tokens = new Set<string>();
  const units: TranslationUnit[] = inv.units.map((u) => {
    for (const t of u.tokens) tokens.add(t);
    const stored = storedState(table[u.key], u.sourceHash);
    const state: UnitState = stored === "stored" ? (pending.has(u.key) ? "invalid" : "translated") : stored;
    return { ...u, protectedTokens: [...u.tokens], state };
  });
  /* mandatory first, then editor order — a resumed task finishes what blocks a launch before what does not */
  units.sort((a, b) => (a.mandatory === b.mandatory ? a.order - b.order : a.mandatory ? -1 : 1));

  const excluded = [
    { what: "custom scripts", count: (def.scripts ?? []).length },
    { what: "calculations", count: (def.calculations ?? []).length },
    { what: "hidden / calculated / embedded-data questions", count: (def.questions ?? []).filter((q) => q.type === "hidden" || q.type === "calculated" || q.type === "embedded_data").length },
    { what: "option, row and column codes", count: (def.questions ?? []).reduce((n, q) => n + (q.options?.length ?? 0) + (q.rows?.length ?? 0) + (q.columns?.length ?? 0), 0) },
    { what: "variable names", count: (def.questions ?? []).length },
  ].filter((x) => x.count > 0);

  return {
    language: lang,
    sourceLanguage: loc.sourceLanguage,
    units,
    mandatory: units.filter((u) => u.mandatory).length,
    optional: units.filter((u) => !u.mandatory).length,
    missing: units.filter((u) => u.state === "missing").length,
    outdated: units.filter((u) => u.state === "outdated").length,
    invalid: units.filter((u) => u.state === "invalid").length,
    protectedStructure: { elementKeys: units.length, tokens: [...tokens].sort(), excluded },
    notCovered: inv.notCovered,
  };
}

/* ===================================================== the batches */

export interface TranslationBatch {
  index: number;
  /** 1-based positions in the outstanding list, for the panel's "keys 41–80" */
  from: number;
  to: number;
  units: TranslationUnit[];
  /** unique strings the batch sends (identical wordings are translated once) */
  segments: number;
  chars: number;
}

/** what still needs doing: missing, outdated or invalid; mandatory before optional */
export function outstandingUnits(inv: TranslationInventory, opts: { includeOptional?: boolean } = {}): TranslationUnit[] {
  const include = opts.includeOptional !== false;
  return inv.units.filter((u) => u.state !== "translated" && (include || u.mandatory));
}

/**
 * THE ENGINE'S ADAPTIVE BATCHES capped at `size` unique strings: a question's
 * elements stay together, an identical wording is sent once and written to
 * every key that carries it, a string with nothing to translate (numbers,
 * tokens only) is left out — it is copied through, never sent.
 */
export function translationBatches(units: TranslationUnit[], size = DEFAULT_TRANSLATION_BATCH, maxChars = Number.MAX_SAFE_INTEGER): TranslationBatch[] {
  const n = Math.max(1, Math.floor(size));
  const byKey = new Map(units.map((u) => [u.key, u]));
  const position = new Map(units.map((u, i) => [u.key, i + 1]));
  return planTranslationBatches(units, { maxItems: n, maxChars, minItems: 1 }).map((b) => {
    const ps = b.keys.map((k) => position.get(k) ?? 0).filter(Boolean);
    return { index: b.index, from: Math.min(...ps), to: Math.max(...ps), units: b.keys.map((k) => byKey.get(k)!).filter(Boolean), segments: b.segments, chars: b.chars };
  });
}

/** one step row per batch, ready for `TaskStore.create` / `TaskStore.revise` */
export function translationSteps(batches: TranslationBatch[], planVersion = 1, taskSeed = "t"): Omit<ExecStep, "taskId" | "retryCount">[] {
  return batches.map((b) => ({
    stepId: `tr-${b.index + 1}`,
    planVersion,
    dependsOn: [],
    status: "pending" as const,
    title: `Translate keys ${b.from}–${b.to}`,
    batchSize: b.units.length,
    inputRef: `keys ${b.from}-${b.to}`,
    idempotencyKey: `${taskSeed}:tr:${planVersion}:${b.units[0]?.key ?? b.index}:${b.units.length}`,
  }));
}

/* ===================================================== what came back */

export interface BatchProblem {
  key: string;
  label: string;
  kind: "empty" | "placeholder" | "unknown_key" | "missing" | "untranslated" | "wrong_script";
  message: string;
}

export interface BatchCheck {
  ok: boolean;
  accepted: { key: string; text: string; source: string }[];
  problems: BatchProblem[];
  /** keys the model did not answer at all */
  missingKeys: string[];
  /** keys whose answer broke the protected structure, is untranslated, or is in the wrong script */
  invalidKeys: string[];
}

/**
 * DETERMINISTIC CHECK OF ONE BATCH, before a single character is written —
 * the engine's `validateTranslatedUnit` per key, worded for the panel. A
 * translation that lost a pipe, a `{label}`, a `[[loop.item]]`, a question
 * code or an HTML tag, one still in the source language or in the wrong
 * script for `lang`, is refused by key; the rest of the batch is still
 * written, so a bad key costs one key and not forty.
 */
export function checkTranslationBatch(units: readonly TranslationUnit[], answered: Record<string, string>, lang = "", glossary: GlossaryEntry[] = []): BatchCheck {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const accepted: BatchCheck["accepted"] = [];
  const problems: BatchProblem[] = [];
  const invalidKeys: string[] = [];

  for (const [key, raw] of Object.entries(answered ?? {})) {
    const unit = byKey.get(key);
    if (!unit) {
      problems.push({ key, label: key, kind: "unknown_key", message: `“${key}” is not a key in this batch — it was not written.` });
      continue;
    }
    const text = String(raw ?? "");
    const issue = validateTranslatedUnit(unit, text, lang, glossary);
    if (!issue) { accepted.push({ key, text, source: unit.source }); continue; }
    invalidKeys.push(key);
    const kind: BatchProblem["kind"] = issue.kind === "empty" ? "empty" : issue.kind === "untranslated" ? "untranslated" : issue.kind === "wrong_script" ? "wrong_script" : "placeholder";
    const tail = kind === "placeholder" ? " Ids, piping, placeholders, HTML and scripts must come through byte-identical." : "";
    problems.push({ key, label: unit.label, kind, message: `${unit.label}: ${issue.message}.${tail}` });
  }

  const missingKeys = units.filter((u) => !(u.key in (answered ?? {}))).map((u) => u.key);
  for (const k of missingKeys) {
    const u = byKey.get(k)!;
    problems.push({ key: k, label: u.label, kind: "missing", message: `${u.label}: no translation came back for this key.` });
  }

  return { ok: problems.length === 0, accepted, problems, missingKeys, invalidKeys };
}

/**
 * WRITE A CHECKED BATCH through `recordTranslation` — one call per key, with
 * the SOURCE text so the entry carries its hash and goes stale by itself when
 * the source is edited later.
 */
export function applyTranslationBatch(
  loc: Localization,
  lang: string,
  accepted: readonly { key: string; text: string; source: string }[],
  opts: { origin?: "ai" | "manual" | "import"; status?: TranslationEntry["status"]; by?: string; now?: string } = {},
): { localization: Localization; written: number } {
  let next = loc;
  let written = 0;
  for (const a of accepted) {
    const before = next;
    next = recordTranslation(next, lang, a.key, a.text, a.source, {
      origin: opts.origin ?? "ai",
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.by ? { by: opts.by } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (next !== before) written++;
  }
  return { localization: next, written };
}

/** a source string edited after its translation goes `outdated`, never silently kept (the inventory's state already reads the hash; this stamps the rows) */
export function refreshOutdated(def: SurveyDefinition): Localization {
  return markOutdated(def);
}

/* ===================================================== done, and where to resume */

/**
 * THE COMPLETION GATE, and the only one — two questions, one place:
 *
 *   no `units`     is the LANGUAGE ready to be served? `lintLanguage(def,
 *                  lang).ready` (every mandatory string) plus the
 *                  configured-language rule — the base's verdict, what
 *                  `checkDeliverable` asks of a whole-survey task
 *   with `units`   is the SCOPE done? A task asked for "the first ten
 *                  questions" (or the whole survey) passes the scope's units
 *                  and the engine's `translationCoverage` must find 100 % of
 *                  them current and valid — nothing missing, stale, corrupted,
 *                  untranslated, in the wrong script or duplicated within a
 *                  question. Readiness is still measured and reported, but a
 *                  partial scope is not asked to make the language ready.
 *
 * Nothing here decides for itself that a language is finished, and the issues
 * come through verbatim so the panel can say which keys are short.
 */
export function translationComplete(def: SurveyDefinition, lang: string, opts: { units?: readonly EngineUnit[] } = {}): DeliverableReport {
  const configured = surveyLanguages(def).some((l) => l.code === lang);
  const r = lintLanguage(def, lang);
  const blocking = r.issues.filter((i) => i.blocking);
  const problems: string[] = [];
  if (!configured) problems.push(`“${lang}” is not one of this survey's languages — add it before the translation can be complete.`);
  const coverage = opts.units ? translationCoverage(def, lang, [...opts.units]) : null;
  if (!r.ready && !coverage) {
    problems.push(`${r.name}: ${r.mandatory - r.missing} of ${r.mandatory} mandatory strings translated (${r.completion}%).`);
    for (const i of blocking) problems.push(`${i.key} (${i.label}): ${i.message}`);
  }
  const missingKeys = r.issues.filter((i) => i.kind === "missing").map((i) => i.key);
  if (coverage && !coverage.complete) {
    problems.push(`${r.name}: ${coverage.translated} of ${coverage.total} strings in scope have a current, valid translation (${coverage.percent}%).`);
    for (const k of coverage.missing.slice(0, 20)) problems.push(`${k}: no translation.`);
    for (const k of coverage.stale.slice(0, 20)) problems.push(`${k}: its source text changed after it was translated.`);
    for (const i of coverage.invalid.slice(0, 20)) problems.push(`${i.key} (${i.label}): ${i.message}`);
    const more = coverage.missing.length + coverage.stale.length + coverage.invalid.length - Math.min(20, coverage.missing.length) - Math.min(20, coverage.stale.length) - Math.min(20, coverage.invalid.length);
    if (more > 0) problems.push(`… and ${more} more.`);
  }
  const firstGap = coverage ? coverage.missing[0] ?? coverage.stale[0] ?? coverage.invalid[0]?.key : undefined;
  return {
    ok: problems.length === 0 && (coverage ? coverage.complete : r.ready),
    problems,
    measured: {
      language: lang,
      name: r.name,
      elements: r.elements,
      mandatory: r.mandatory,
      translated: r.translated,
      missing: r.missing,
      completion: r.completion,
      blocking: blocking.length,
      ready: r.ready,
      ...(missingKeys.length ? { resumeKey: missingKeys[0], missingKeys: missingKeys.length } : firstGap ? { resumeKey: firstGap } : {}),
      ...(coverage ? { scope: coverage.total, covered: coverage.translated, coverage: coverage.percent, stale: coverage.stale.length, invalid: coverage.invalid.length, rtl: coverage.rtl } : {}),
    },
  };
}

/**
 * THE QUEUE A RESUMED TRANSLATION WORKS THROUGH: what is missing, outdated or
 * refused by the engine's validator, plus what is translated but blocking
 * for `lintLanguage` (two options with the same words), mandatory strings
 * first and then editor order.
 */
export function translationQueue(def: SurveyDefinition, lang: string, includeOptional = true): TranslationUnit[] {
  const inv = translationInventory(def, lang);
  const outstanding = outstandingUnits(inv, { includeOptional });
  const blocked = new Set(lintLanguage(def, lang).issues.filter((i) => i.blocking && i.kind !== "missing").map((i) => i.key));
  const invalid = inv.units.filter((u) => u.state === "translated" && blocked.has(u.key) && (includeOptional || u.mandatory));
  return [...outstanding, ...invalid].sort((a, b) => (a.mandatory === b.mandatory ? a.order - b.order : a.mandatory ? -1 : 1));
}

export interface TranslationResume {
  /** the first key that is missing or no longer valid */
  key: string;
  label: string;
  /** its 1-based position in the outstanding list */
  position: number;
  /** the batch that key falls in, at this batch size */
  batchIndex: number;
  remaining: number;
  reason: "missing" | "outdated" | "invalid";
}

/**
 * WHERE A RESUMED TRANSLATION PICKS UP: the first key that is missing, stale
 * or blocked by a QA issue — never the first key of the language.
 */
export function translationResumeFrom(def: SurveyDefinition, lang: string, size = DEFAULT_TRANSLATION_BATCH): TranslationResume | null {
  const queue = translationQueue(def, lang);
  const first = queue[0];
  if (!first) return null;
  return {
    key: first.key,
    label: first.label,
    position: 1,
    batchIndex: 0,
    remaining: queue.length,
    reason: first.state === "missing" ? "missing" : first.state === "outdated" ? "outdated" : "invalid",
  };
}

/* ===================================================== the task itself */

export interface TranslationTaskInput {
  surveyId: string;
  def: SurveyDefinition;
  language: string;
  request: string;
  customerId?: string;
  createdBy?: string;
  batchSize?: number;
  includeOptional?: boolean;
}

/** the deliverable spec a translation task is held to */
export function translationSpec(language: string): DeliverableSpec {
  return { kind: "translation", language, invariants: ["schema_valid"] };
}

/**
 * CREATE THE TASK through an injected store — never `taskStoreFor`, so the
 * runner, the route and the tests all decide for themselves where the rows
 * live. Returns null when there is nothing left to translate.
 */
export async function createTranslationTask(store: TaskStore, input: TranslationTaskInput): Promise<ExecTask | null> {
  const inv = translationInventory(input.def, input.language);
  const units = outstandingUnits(inv, { includeOptional: input.includeOptional });
  if (!units.length) return null;
  const batches = translationBatches(units, input.batchSize ?? DEFAULT_TRANSLATION_BATCH);
  if (!batches.length) return null; // only copy-through strings outstanding: nothing a model is needed for
  const create: CreateTaskInput = {
    surveyId: input.surveyId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    kind: "translation",
    request: input.request,
    deliverable: translationSpec(input.language),
    steps: translationSteps(batches, 1, input.surveyId),
  };
  return store.create(create);
}
