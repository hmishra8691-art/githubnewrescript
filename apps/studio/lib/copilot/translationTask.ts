/**
 * TRANSLATION AS A REAL TASK KIND. — Owner: R4 (2026-10-24).
 *
 * The copilot could already ask a model for translations, but it did so as
 * one turn against one prompt: nothing enumerated what had to be translated,
 * nothing batched it, nothing wrote the result through the localization
 * store, and nothing decided when the language was DONE. The primitives for
 * all four already existed and the copilot's translation path used none of
 * them:
 *
 *   translatableElements  packages/engine/src/localization.ts:212
 *                         every respondent-facing string, by stable key, with
 *                         `mandatory` saying which ones a language is not
 *                         ready without
 *   placeholderMismatch   packages/engine/src/placeholders.ts:93
 *                         the ONE placeholder grammar: pipes, `${…}`,
 *                         `[[…]]`, `{word}` parameters and question codes must
 *                         come back byte-identical
 *   recordTranslation     packages/engine/src/localization.ts:609
 *                         one write, with the source hash and the status, and
 *                         the previous text kept in history
 *   markOutdated          packages/engine/src/localization.ts:631
 *                         a source edited after its translation
 *   lintLanguage          packages/engine/src/localization.ts:753
 *                         per-language completion over the MANDATORY strings,
 *                         the blocking issue list, and `ready`
 *
 * This module is the task layer over them: an inventory, batches of a
 * tuneable size, a deterministic check of what came back, a write through
 * `recordTranslation`, a completion gate that is `lintLanguage(def, lang).ready`
 * and nothing else, and a resume point at the first missing or invalid key.
 *
 * It never calls `taskStoreFor`: the store is injected, so the runner, the
 * route and the tests all supply their own.
 */
import type { Localization, SurveyDefinition, TranslationEntry } from "@rescript/schema";
import {
  effectiveLocalization,
  lintLanguage,
  markOutdated,
  placeholderKeys,
  placeholderMismatch,
  recordTranslation,
  surveyLanguages,
  textHash,
  translatableElements,
  type DeliverableReport,
  type DeliverableSpec,
  type ExecStep,
  type ExecTask,
  type TranslatableElement,
} from "@rescript/engine";
import type { CreateTaskInput, TaskStore } from "./taskStore.ts";

/** the default batch — tuneable per task, halved by the runner on a context limit */
export const DEFAULT_TRANSLATION_BATCH = 40;

/* ===================================================== the inventory */

export type UnitState = "missing" | "outdated" | "translated";

export interface TranslationUnit {
  key: string;
  kind: TranslatableElement["kind"];
  label: string;
  source: string;
  mandatory: boolean;
  order: number;
  questionId?: string;
  questionCode?: string;
  /**
   * THE PROTECTED STRUCTURE of this string — pipes, variables, loop
   * references, `{word}` parameters and the question codes the source names.
   * Every one must come back byte-identical; they are listed separately so a
   * prompt can show them and `checkTranslationBatch` can refuse what lost one.
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
}

const stateOf = (entry: TranslationEntry | undefined, source: string): UnitState => {
  if (!entry || entry.status === "not_translated" || !entry.text.trim()) return "missing";
  if (entry.status === "outdated" || (entry.sourceHash && entry.sourceHash !== textHash(source))) return "outdated";
  return "translated";
};

/**
 * WHAT THIS LANGUAGE STILL NEEDS, in editor order, mandatory strings first.
 * Built from `translatableElements` — never from a second walk of the
 * definition.
 */
export function translationInventory(def: SurveyDefinition, lang: string): TranslationInventory {
  const loc = effectiveLocalization(def);
  const table = loc.translations[lang] ?? {};
  const elements = translatableElements(def);
  const tokens = new Set<string>();
  const units: TranslationUnit[] = elements.map((el) => {
    const protectedTokens = placeholderKeys(el.source);
    for (const t of protectedTokens) tokens.add(t);
    return {
      key: el.key,
      kind: el.kind,
      label: el.label,
      source: el.source,
      mandatory: el.mandatory,
      order: el.order,
      ...(el.questionId ? { questionId: el.questionId } : {}),
      ...(el.questionCode ? { questionCode: el.questionCode } : {}),
      protectedTokens,
      state: stateOf(table[el.key], el.source),
    };
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
    protectedStructure: { elementKeys: units.length, tokens: [...tokens].sort(), excluded },
  };
}

/* ===================================================== the batches */

export interface TranslationBatch {
  index: number;
  /** 1-based positions in the outstanding list, for the panel's "keys 41–80" */
  from: number;
  to: number;
  units: TranslationUnit[];
}

/** what still needs doing: missing first, then outdated; mandatory before optional */
export function outstandingUnits(inv: TranslationInventory, opts: { includeOptional?: boolean } = {}): TranslationUnit[] {
  const include = opts.includeOptional !== false;
  return inv.units.filter((u) => u.state !== "translated" && (include || u.mandatory));
}

export function translationBatches(units: TranslationUnit[], size = DEFAULT_TRANSLATION_BATCH): TranslationBatch[] {
  const n = Math.max(1, Math.floor(size));
  const out: TranslationBatch[] = [];
  for (let i = 0; i < units.length; i += n) {
    out.push({ index: out.length, from: i + 1, to: Math.min(i + n, units.length), units: units.slice(i, i + n) });
  }
  return out;
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
  kind: "empty" | "placeholder" | "unknown_key" | "missing";
  message: string;
}

export interface BatchCheck {
  ok: boolean;
  accepted: { key: string; text: string; source: string }[];
  problems: BatchProblem[];
  /** keys the model did not answer at all */
  missingKeys: string[];
  /** keys whose answer broke the protected structure */
  invalidKeys: string[];
}

/**
 * DETERMINISTIC CHECK OF ONE BATCH, before a single character is written.
 * A translation that lost a pipe, a `{label}`, a `[[loop.item]]` or a
 * question code is refused by key; the rest of the batch is still written,
 * so a bad key costs one key and not forty.
 */
export function checkTranslationBatch(units: readonly TranslationUnit[], answered: Record<string, string>): BatchCheck {
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
    if (!text.trim()) {
      problems.push({ key, label: unit.label, kind: "empty", message: `${unit.label}: the translation is empty.` });
      invalidKeys.push(key);
      continue;
    }
    const pm = placeholderMismatch(unit.source, text);
    if (pm) {
      problems.push({
        key, label: unit.label, kind: "placeholder",
        message: `${unit.label}: the protected structure differs — source has ${pm.source.length ? pm.source.join(" ") : "none"}, the translation has ${pm.translation.length ? pm.translation.join(" ") : "none"}${pm.missing.length ? ` (missing ${pm.missing.join(" ")})` : ""}${pm.extra.length ? ` (invented ${pm.extra.join(" ")})` : ""}. Ids, piping, placeholders and scripts must come through byte-identical.`,
      });
      invalidKeys.push(key);
      continue;
    }
    accepted.push({ key, text, source: unit.source });
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

/** a source string edited after its translation goes `outdated`, never silently kept */
export function refreshOutdated(def: SurveyDefinition): Localization {
  return markOutdated(def);
}

/* ===================================================== done, and where to resume */

/**
 * THE COMPLETION GATE, and the only one: `lintLanguage(def, lang).ready`.
 * Nothing here decides for itself that a language is finished, and the
 * blocking issues come through verbatim so the panel can say which keys are
 * short.
 */
export function translationComplete(def: SurveyDefinition, lang: string): DeliverableReport {
  const configured = surveyLanguages(def).some((l) => l.code === lang);
  const r = lintLanguage(def, lang);
  const blocking = r.issues.filter((i) => i.blocking);
  const problems: string[] = [];
  if (!configured) problems.push(`“${lang}” is not one of this survey's languages — add it before the translation can be complete.`);
  if (!r.ready) {
    problems.push(`${r.name}: ${r.mandatory - r.missing} of ${r.mandatory} mandatory strings translated (${r.completion}%).`);
    for (const i of blocking) problems.push(`${i.key} (${i.label}): ${i.message}`);
  }
  const missingKeys = r.issues.filter((i) => i.kind === "missing").map((i) => i.key);
  return {
    ok: problems.length === 0 && r.ready,
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
      ...(missingKeys.length ? { resumeKey: missingKeys[0], missingKeys: missingKeys.length } : {}),
    },
  };
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
  const inv = translationInventory(def, lang);
  const outstanding = outstandingUnits(inv);
  const blockedKeys = new Set(lintLanguage(def, lang).issues.filter((i) => i.blocking && i.kind !== "missing").map((i) => i.key));
  const invalid = inv.units.filter((u) => u.state === "translated" && blockedKeys.has(u.key));
  const queue = [...outstanding, ...invalid].sort((a, b) => (a.mandatory === b.mandatory ? a.order - b.order : a.mandatory ? -1 : 1));
  const first = queue[0];
  if (!first) return null;
  const position = queue.indexOf(first) + 1;
  return {
    key: first.key,
    label: first.label,
    position,
    batchIndex: Math.floor((position - 1) / Math.max(1, Math.floor(size))),
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
