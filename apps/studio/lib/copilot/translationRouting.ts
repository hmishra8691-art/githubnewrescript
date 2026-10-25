/**
 * WHEN A TRANSLATION IS TOO BIG FOR ONE TURN. — Owner: R4 (2026-10-25).
 *
 * `translationTask.ts` has held the whole batched, resumable translation
 * machine since 2026-10-24 — an inventory, batches, a deterministic per-key
 * check, a write through `recordTranslation`, a completion gate and a resume
 * point — and NOTHING IN PRODUCTION CALLED IT. The copilot still translated
 * inside one turn: it wrote whatever fitted in one model reply and recorded
 * nothing about what did not fit. A 300-string survey came back half
 * translated with no row saying so, and the next turn began again at the
 * first key.
 *
 * This module is the seam. It answers ONE question —
 *
 *     is this translation big enough that one turn is a poor bet?
 *
 * — as a pure predicate with no side effects (`routeTranslation`), and when
 * the answer is yes it creates the task through an injected store
 * (`startBatchedTranslation`). WHEN THE ANSWER IS NO NOTHING CHANGES: the
 * caller keeps today's in-turn path exactly as it is, and this module has
 * written nothing and created nothing.
 *
 * ## The predicate is two named numbers, and nothing else
 *
 *   LARGE_TRANSLATION_KEYS (150)  one turn's honest ceiling in mandatory
 *                                 strings
 *   SEVERAL_LANGUAGES (2)         a second target language is a second
 *                                 deliverable with its own completion gate
 *
 * Each is defended in a sentence at its declaration, and both are
 * overridable per call so the tests can exercise the boundary without a
 * 400-question fixture.
 *
 * THE COUNT IS READ OFF THE SURVEY, NEVER OFF THE SENTENCE. It comes from
 * `translationInventory` (which is `translatableElements`) and `lintLanguage`
 * — so "translate all 600 strings" on a ten-string survey is a small
 * translation, and a terse "ins Deutsche" on a 300-string survey is a task.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not decide that a language is finished. `translationComplete` does,
 * and that is `lintLanguage(def, lang).ready` plus the configured-language
 * rule — the same verdict `checkDeliverable` applies to the task row. There
 * is no second gate here; `batchedTranslationComplete` only runs the one gate
 * once per target language and collects the answers.
 *
 * It does not let a translation reach the survey without the per-key check.
 * `applyTranslationAnswers` is the only write path in this file, its units
 * come from the INVENTORY rather than from its caller, and it goes through
 * `checkTranslationBatch` — so a key that lost a pipe, a `${variable}`, a
 * `{label}` or a question code is refused BY KEY and costs that one key, not
 * the batch. Routing cannot hand the model's answer straight to the survey
 * because there is no function here that would take it.
 *
 * It never calls `taskStoreFor`. The store is a parameter, exactly as it is
 * in `createTranslationTask`.
 */
import { LANGUAGE_LIBRARY, languageInfo, type Localization, type SurveyDefinition, type TranslationEntry } from "@rescript/schema";
import {
  effectiveLocalization,
  languageName,
  lintLanguage,
  surveyLanguages,
  type DeliverableReport,
  type ExecTask,
} from "@rescript/engine";
import { specFromRequest } from "./deliverable.ts";
import type { TaskStore } from "./taskStore.ts";
import {
  DEFAULT_TRANSLATION_BATCH,
  applyTranslationBatch,
  checkTranslationBatch,
  createTranslationTask,
  outstandingUnits,
  translationComplete,
  translationInventory,
  translationResumeFrom,
  type BatchCheck,
  type BatchProblem,
  type TranslationResume,
  type TranslationUnit,
} from "./translationTask.ts";

/* ===================================================== the two thresholds */

/**
 * ONE TURN'S HONEST CEILING, IN MANDATORY STRINGS: 150.
 *
 * A translated string travels twice in a single turn — the source goes up
 * inside the prompt and the translation comes back inside the one JSON reply
 * — and each one carries its stable key with it. At 150 mandatory strings
 * that reply is already tens of thousands of characters of pure text, which
 * is where a single answer starts to be truncated, and a truncated turn
 * loses EVERY key in it because nothing was written down. 150 is also
 * roughly four `DEFAULT_TRANSLATION_BATCH` batches: the smallest amount of
 * work where a resumable row pays for itself, since a task that is one or
 * two batches long is simply a turn with extra bookkeeping. Below the line
 * one turn either succeeds or is cheap to run again; above it, one turn is a
 * bet on not being truncated, and losing that bet costs the researcher the
 * whole translation.
 */
export const LARGE_TRANSLATION_KEYS = 150;

/**
 * A SECOND TARGET LANGUAGE IS A SECOND DELIVERABLE: 2.
 *
 * Languages do not share work. Each one needs every mandatory string of its
 * own, and each one is finished only when `lintLanguage(def, lang).ready`
 * says so — a separate gate, over a separate set of keys, recorded on a
 * separate task. One turn can write at most one language's worth of text
 * before it runs out of reply, so a request naming several languages has
 * always ended with the first language half-written and the rest silently
 * dropped. Two is therefore the line, however small the survey: with two
 * named languages the work becomes one task per language and the second one
 * exists as outstanding work instead of as something nobody recorded.
 */
export const SEVERAL_LANGUAGES = 2;

/* ===================================================== which languages */

export interface ResolvedLanguage {
  /** the code to key translations by — the survey's own spelling where it has one */
  code: string;
  configured: boolean;
  name: string;
}

/**
 * A REQUESTED LANGUAGE AGAINST THE SURVEY'S OWN LIST. `lintLanguage`,
 * `recordTranslation` and every translation key use the code the survey is
 * configured with, so "de-AT" asked of a survey configured for "de" resolves
 * to "de" and a display name never appears anywhere.
 */
export function resolveLanguage(def: SurveyDefinition, wanted: string): ResolvedLanguage {
  const raw = String(wanted ?? "").trim();
  const configured = surveyLanguages(def);
  const exact = configured.find((l) => l.code.toLowerCase() === raw.toLowerCase());
  if (exact) return { code: exact.code, configured: true, name: languageName(exact.code, exact) };
  const base = raw.toLowerCase().split("-")[0];
  const sameBase = configured.find((l) => l.code.toLowerCase().split("-")[0] === base);
  if (sameBase) return { code: sameBase.code, configured: true, name: languageName(sameBase.code, sameBase) };
  /*
   * NOT CONFIGURED — but still an ISO code if the library knows the word, so
   * that "Urdu" is reported as `ur` and a display name never travels (the
   * spec reader's own rule, deliverable.ts: `lintLanguage` and
   * `recordTranslation` key by the code, so a name can never complete).
   */
  const info = languageInfo(raw) ?? LANGUAGE_LIBRARY.find((l) => l.name.toLowerCase() === raw.toLowerCase() || l.nativeName.toLowerCase() === raw.toLowerCase());
  return { code: info?.code ?? raw, configured: false, name: info?.name ?? raw };
}

/**
 * WHICH LANGUAGES A REQUEST IS ABOUT, without becoming a second reader of
 * the request (planPersistence audit L1, 2026-10-25: there is ONE reader,
 * `specFromRequest`, and it yields an ISO code).
 *
 * Two sources, both narrow:
 *   1. `specFromRequest` — the single reader — for the language the sentence
 *      names, which may be one the survey does not serve yet;
 *   2. the survey's OWN configured languages, matched by their English and
 *      native names (three letters or more, so a two-letter code can never
 *      match a stray word). This is not a general language parser: it can
 *      only answer with codes the survey already has.
 *
 * A caller that knows better — the Studio's language picker, a plan item —
 * should pass the codes to `routeTranslation` directly and skip this.
 */
export function translationTargets(def: SurveyDefinition, request: string): { languages: string[]; unconfigured: string[] } {
  const text = String(request ?? "");
  const source = effectiveLocalization(def).sourceLanguage;
  const languages: string[] = [];
  const unconfigured: string[] = [];
  const named = (word: string): boolean => {
    const w = word.trim();
    if (w.length < 3) return false;
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
  };

  for (const cfg of surveyLanguages(def)) {
    if (cfg.code === source) continue;
    const info = languageInfo(cfg.code);
    const names = [cfg.name, info?.name, info?.nativeName].filter(Boolean) as string[];
    if (names.some(named) && !languages.includes(cfg.code)) languages.push(cfg.code);
  }

  const spec = specFromRequest(text);
  if (spec.kind === "translation" && spec.language) {
    const r = resolveLanguage(def, spec.language);
    if (r.code === source) { /* the source language is not a target */ }
    else if (r.configured) { if (!languages.includes(r.code)) languages.push(r.code); }
    else if (!unconfigured.includes(r.code)) unconfigured.push(r.code);
  }

  return { languages, unconfigured };
}

/* ===================================================== the decision */

export interface LanguageWork {
  language: string;
  name: string;
  /** every mandatory string in the survey — `lintLanguage(def, lang).mandatory` */
  mandatory: number;
  /** mandatory strings this language still needs: missing, outdated, or translated but blocking */
  outstanding: number;
  /** everything still outstanding, optional strings included — what the batches cover */
  outstandingAll: number;
  /** `lintLanguage(def, lang).ready` — the one completion gate, read not re-decided */
  ready: boolean;
  completion: number;
}

export interface TranslationRoute {
  /** true when this translation should become a batched task rather than one turn */
  batched: boolean;
  /** why, in the researcher's words — shown in the reply */
  reason: string;
  /** the inventory size that decided it: mandatory strings still outstanding, across every target language */
  mandatory: number;
  languages: string[];
  /** what each target language still needs */
  work: LanguageWork[];
  /** requested codes the survey does not serve — refused here, never translated */
  unconfigured: string[];
  /** which condition fired */
  trigger: "size" | "languages" | "small" | "nothing" | "none";
  threshold: number;
  languageThreshold: number;
  batchSize: number;
  /** how many batches the task(s) would hold, across every target language */
  batches: number;
  /** how many keys those batches cover, optional strings included */
  keys: number;
}

export interface RouteOptions {
  /** override LARGE_TRANSLATION_KEYS — for tests, and for an operator who knows their model */
  threshold?: number;
  /** override SEVERAL_LANGUAGES */
  languageThreshold?: number;
  batchSize?: number;
  /** false translates only what blocks a launch; the default includes optional strings */
  includeOptional?: boolean;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const andList = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * THE QUEUE A RESUMED TRANSLATION WORKS THROUGH, and the one
 * `translationResumeFrom` points into: what is missing or outdated, plus what
 * is translated but blocking (a lost placeholder, two options with the same
 * words), mandatory strings first and then editor order.
 */
function translationQueue(def: SurveyDefinition, lang: string, includeOptional: boolean): TranslationUnit[] {
  const inv = translationInventory(def, lang);
  const outstanding = outstandingUnits(inv, { includeOptional });
  const blocked = new Set(lintLanguage(def, lang).issues.filter((i) => i.blocking && i.kind !== "missing").map((i) => i.key));
  const invalid = inv.units.filter((u) => u.state === "translated" && blocked.has(u.key) && (includeOptional || u.mandatory));
  return [...outstanding, ...invalid].sort((a, b) => (a.mandatory === b.mandatory ? a.order - b.order : a.mandatory ? -1 : 1));
}

/**
 * DECIDE, WITHOUT SIDE EFFECTS. Nothing here reads the request text, writes a
 * row, or touches the store: given the survey and the target codes it returns
 * the verdict, the number that produced it, and the sentence to show.
 */
export function routeTranslation(def: SurveyDefinition, languages: readonly string[], opts: RouteOptions = {}): TranslationRoute {
  const threshold = Math.max(1, Math.floor(opts.threshold ?? LARGE_TRANSLATION_KEYS));
  const languageThreshold = Math.max(1, Math.floor(opts.languageThreshold ?? SEVERAL_LANGUAGES));
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_TRANSLATION_BATCH));
  const includeOptional = opts.includeOptional !== false;
  const source = effectiveLocalization(def).sourceLanguage;

  const seen = new Set<string>();
  const targets: string[] = [];
  const unconfigured: string[] = [];
  for (const wanted of languages ?? []) {
    const r = resolveLanguage(def, wanted);
    if (!r.code || r.code === source) continue;
    if (!r.configured) { if (!unconfigured.includes(r.code)) unconfigured.push(r.code); continue; }
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    targets.push(r.code);
  }

  const work: LanguageWork[] = targets.map((lang) => {
    const report = lintLanguage(def, lang);
    const queue = translationQueue(def, lang, includeOptional);
    return {
      language: lang,
      name: report.name,
      mandatory: report.mandatory,
      outstanding: queue.filter((u) => u.mandatory).length,
      outstandingAll: queue.length,
      ready: report.ready,
      completion: report.completion,
    };
  });

  const mandatory = work.reduce((n, w) => n + w.outstanding, 0);
  const keys = work.reduce((n, w) => n + w.outstandingAll, 0);
  const batches = work.reduce((n, w) => n + Math.ceil(w.outstandingAll / batchSize), 0);
  const bySize = mandatory >= threshold;
  const byLanguages = targets.length >= languageThreshold;
  const batched = keys > 0 && (bySize || byLanguages);
  const trigger: TranslationRoute["trigger"] = !targets.length ? "none" : keys === 0 ? "nothing" : bySize ? "size" : byLanguages ? "languages" : "small";

  const names = work.map((w) => w.name);
  const reason =
    trigger === "none"
      ? unconfigured.length
        ? `${andList(unconfigured.map((c) => `“${c}”`))} ${unconfigured.length === 1 ? "is not one of" : "are not among"} this survey's languages, so nothing would ever be served in ${unconfigured.length === 1 ? "it" : "them"} — add ${unconfigured.length === 1 ? "it" : "them"} to the survey's languages first.`
        : "No target language to translate into — nothing was routed."
      : trigger === "nothing"
        ? `${andList(names)} ${names.length === 1 ? "is" : "are"} already translated — every string is written, so there is nothing to batch.`
        : trigger === "size"
          ? `${names[0]} needs ${plural(mandatory, "mandatory string", "mandatory strings")}, past the ${threshold} one turn can finish without truncating — so it runs as a resumable task of ${plural(batches, "batch", "batches")} of up to ${batchSize} keys, and a turn that stops short carries on where it left off.`
          : trigger === "languages"
            ? `${andList(names)} — ${plural(targets.length, "target language", "target languages")}, each finished only when its own completion check passes. One turn can write only one of them, so this runs as a resumable task per language: ${plural(batches, "batch", "batches")}, ${plural(keys, "key", "keys")} in all.`
            : `${names[0]} needs ${plural(mandatory, "mandatory string", "mandatory strings")}, under the ${threshold} that makes a translation worth batching — it stays in this turn, exactly as before.`;

  return { batched, reason, mandatory, languages: targets, work, unconfigured, trigger, threshold, languageThreshold, batchSize, batches, keys };
}

/* ===================================================== the next batch */

export interface NextTranslationBatch {
  language: string;
  /** the keys to ask for, in order — mandatory strings first */
  units: TranslationUnit[];
  /** where this batch starts, from `translationResumeFrom` */
  resume: TranslationResume | null;
  /** everything still outstanding in this language, this batch included */
  remaining: number;
}

/**
 * THE NEXT BATCH, RECOMPUTED FROM THE SURVEY AS IT STANDS NOW — which is
 * what makes a batched translation resumable at all.
 *
 * The step rows are a budget, not a work queue: "keys 41–80" was true of the
 * outstanding list at the moment the task was created, and that list shrinks
 * as keys are written. Reading the batch back off the row would therefore
 * drift. Reading it off the CURRENT inventory cannot: the first unit of the
 * batch is always the first key that is missing, outdated or blocking, which
 * is exactly `translationResumeFrom`.
 */
export function nextTranslationBatch(
  def: SurveyDefinition,
  language: string,
  opts: { size?: number; includeOptional?: boolean } = {},
): NextTranslationBatch | null {
  const size = Math.max(1, Math.floor(opts.size ?? DEFAULT_TRANSLATION_BATCH));
  const includeOptional = opts.includeOptional !== false;
  const queue = translationQueue(def, language, includeOptional);
  if (!queue.length) return null;
  return {
    language,
    units: queue.slice(0, size),
    resume: translationResumeFrom(def, language, size),
    remaining: queue.length,
  };
}

/* ===================================================== the one write path */

export interface AppliedTranslationBatch {
  /** the localization to store — the definition is the caller's to re-parse */
  localization: Localization;
  written: number;
  /** the deterministic verdict on what came back, key by key */
  check: BatchCheck;
  /** the keys that were NOT written, and why — one bad key costs one key */
  refused: BatchProblem[];
  ok: boolean;
}

/**
 * WRITE WHAT CAME BACK, THROUGH THE CHECK — the only way a translation
 * reaches the survey from this module.
 *
 * The units are looked up in the INVENTORY, not taken from the caller, so a
 * caller cannot widen what counts as a valid answer; `checkTranslationBatch`
 * then refuses, per key, anything that lost a pipe, a `${variable}`, a
 * `{label}` or a question code, and `applyTranslationBatch` writes only the
 * keys that survived — with their source text, so the entry carries its hash
 * and goes outdated by itself when the source is edited later.
 *
 * `keys` is the batch that was ASKED for; a key in it that came back empty or
 * not at all is reported as a problem rather than quietly forgotten. When it
 * is left out, only what was answered is judged.
 */
export function applyTranslationAnswers(
  def: SurveyDefinition,
  language: string,
  answered: Record<string, string>,
  opts: { keys?: readonly string[]; origin?: "ai" | "manual" | "import"; status?: TranslationEntry["status"]; by?: string; now?: string } = {},
): AppliedTranslationBatch {
  const inv = translationInventory(def, language);
  const byKey = new Map(inv.units.map((u) => [u.key, u]));
  const asked = opts.keys?.length ? opts.keys : Object.keys(answered ?? {});
  const units: TranslationUnit[] = [];
  for (const k of asked) { const u = byKey.get(k); if (u && !units.includes(u)) units.push(u); }
  const check = checkTranslationBatch(units, answered ?? {});
  const { localization, written } = applyTranslationBatch(effectiveLocalization(def), language, check.accepted, {
    origin: opts.origin ?? "ai",
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { localization, written, check, refused: check.problems, ok: check.ok };
}

/* ===================================================== done, per language */

export interface BatchedTranslationReport {
  ok: boolean;
  problems: string[];
  byLanguage: Record<string, DeliverableReport>;
}

/**
 * THE ONE GATE, ONCE PER LANGUAGE. This adds no rule of its own: every
 * verdict is `translationComplete`, which is `lintLanguage(def, lang).ready`
 * plus the configured-language refusal, and which is the same check
 * `checkDeliverable` runs against each task row.
 */
export function batchedTranslationComplete(def: SurveyDefinition, languages: readonly string[]): BatchedTranslationReport {
  const byLanguage: Record<string, DeliverableReport> = {};
  const problems: string[] = [];
  for (const lang of languages) {
    const r = translationComplete(def, lang);
    byLanguage[lang] = r;
    problems.push(...r.problems);
  }
  return { ok: languages.length > 0 && problems.length === 0, problems, byLanguage };
}

/* ===================================================== start the task */

export interface StartBatchedTranslationInput {
  surveyId: string;
  def: SurveyDefinition;
  /** the target codes; unconfigured ones are refused, never translated */
  languages: readonly string[];
  /** what the researcher asked, verbatim — stored on the task */
  request: string;
  customerId?: string;
  createdBy?: string;
  batchSize?: number;
  includeOptional?: boolean;
  threshold?: number;
  languageThreshold?: number;
  /** attach to the survey's open translation task instead of adding a second row (default true) */
  reuseOpen?: boolean;
  /** a route already decided elsewhere — pass it to avoid deciding twice */
  route?: TranslationRoute;
}

export interface BatchedTranslation {
  /** the verdict this task was created under */
  route: TranslationRoute;
  /** the task the reply links to: the first target language's */
  task: ExecTask;
  /**
   * ONE TASK PER TARGET LANGUAGE. A `DeliverableSpec` carries ONE `language`
   * and `checkDeliverable` gates on that one, so a single row covering three
   * languages would report itself complete when one of them was done. A row
   * each keeps every language on the one honest gate.
   */
  tasks: ExecTask[];
  /** language code → the id of the task that holds it */
  byLanguage: Record<string, string>;
  /** languages that joined a task that already existed, rather than a new row */
  reused: string[];
  /** where each language picks up — the first key that is missing, outdated or blocking */
  resumeAt: Record<string, TranslationResume | null>;
  /**
   * The step rows created, across every language — a BUDGET, not the work
   * queue: `createTranslationTask` plans one row per batch of what is
   * MISSING or OUTDATED, while `nextTranslationBatch` also re-queues a key
   * that has text but is blocking (a lost placeholder, two options that read
   * the same). A language carrying such keys is therefore planned a row or
   * two short, and when the rows run out with the gate still unmet the task
   * stays `running` with its blocking issues named rather than reporting
   * itself done.
   */
  steps: number;
  /** the keys those batches cover: everything outstanding, blocking keys included */
  keys: number;
  /** the sentence for the reply */
  reason: string;
}

/**
 * CREATE THE TASK WHEN THE ROUTE SAYS BATCHED — through the injected store,
 * never `taskStoreFor`.
 *
 * Returns null when the route says this is a small translation (the caller
 * then does exactly what it does today) and when there is nothing left to
 * translate. Nothing is written in either case.
 *
 * A survey's open translation task is joined rather than duplicated: the
 * store can only offer the newest open task per survey (`openFor`), so at
 * most one target language can be matched that way, and the rest get their
 * own rows. Each row's steps are built from the CURRENT inventory, so a
 * rerun of a half-finished language plans only the keys that are still
 * outstanding.
 */
export async function startBatchedTranslation(store: TaskStore, input: StartBatchedTranslationInput): Promise<BatchedTranslation | null> {
  const route = input.route ?? routeTranslation(input.def, input.languages, {
    ...(input.threshold != null ? { threshold: input.threshold } : {}),
    ...(input.languageThreshold != null ? { languageThreshold: input.languageThreshold } : {}),
    ...(input.batchSize != null ? { batchSize: input.batchSize } : {}),
    ...(input.includeOptional != null ? { includeOptional: input.includeOptional } : {}),
  });
  if (!route.batched) return null;

  const open = input.reuseOpen === false ? null : await store.openFor(input.surveyId).catch(() => null);
  const tasks: ExecTask[] = [];
  const byLanguage: Record<string, string> = {};
  const reused: string[] = [];
  const resumeAt: Record<string, TranslationResume | null> = {};

  for (const lang of route.languages) {
    resumeAt[lang] = translationResumeFrom(input.def, lang, route.batchSize);
    const existing = open && open.kind === "translation" && open.deliverable.language === lang ? open : null;
    if (existing) {
      tasks.push(existing);
      byLanguage[lang] = existing.id;
      reused.push(lang);
      continue;
    }
    const task = await createTranslationTask(store, {
      surveyId: input.surveyId,
      def: input.def,
      language: lang,
      request: input.request,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      batchSize: route.batchSize,
      ...(input.includeOptional != null ? { includeOptional: input.includeOptional } : {}),
    });
    /* null means this language had nothing outstanding — no row for work that does not exist */
    if (!task) continue;
    tasks.push(task);
    byLanguage[lang] = task.id;
  }

  if (!tasks.length) return null;
  return {
    route,
    task: tasks[0],
    tasks,
    byLanguage,
    reused,
    resumeAt,
    steps: tasks.reduce((n, t) => n + t.steps.filter((s) => s.status !== "tombstoned").length, 0),
    keys: route.keys,
    reason: route.reason,
  };
}
