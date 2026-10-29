/**
 * WHAT "DONE" MEANS. — Owner: R4 (2026-10-24).
 *
 * A task is `completed` only when every step completed AND the deliverable
 * spec passes. The spec is checked by DETERMINISTIC CODE, never by a model,
 * and it is built out of the validators the platform already has. There is no
 * second validator in this file: every rule below delegates to one of
 *
 *   countRespondentQuestions  packages/engine/src/questionCount.ts:54
 *   lintElementIds            packages/engine/src/elementIds.ts:296
 *   lintSurveyLogic           packages/engine/src/lintLogic.ts:1338
 *   lintStructure             packages/engine/src/lintLogic.ts:1381   (quotas, designs, dead types)
 *   lintLoops                 packages/engine/src/lintLogic.ts:1631
 *   lintVariables             packages/engine/src/variables.ts:991
 *   sameVariableName          packages/engine/src/variableUsage.ts    (B20, 2026-10-23)
 *   lintEmbeddedPiping        packages/engine/src/embeddedPiping.ts:166
 *   lintCalculations          packages/engine/src/dependencies.ts:714
 *   conjointPlanReadiness     packages/engine/src/conjointSuite.ts:107
 *   lintLanguage              packages/engine/src/localization.ts:753
 *   validateActionOutcome     packages/engine/src/actionValidation.ts:66
 *   plannedItemReadiness      packages/analytics/src/planCheck.ts:371
 *   SurveyDefinition          packages/schema/src/survey.ts:740       (import / runtime schema)
 *
 * WHY A SPEC AND NOT A COUNT OF STEPS. A generation that stopped at question
 * 64 of 100 has every step it ever created `completed`. Only the spec knows
 * the request promised 100, so only the spec can say the task is still
 * RUNNING — incomplete, resumable at 65, and emphatically not failed. That
 * distinction is `nextStatusFor` below: a short deliverable keeps the task
 * running; only a terminally classified step failure makes it `failed`.
 */
import { SurveyDefinition as SurveyDefinitionSchema } from "@rescript/schema";
import type { Question, SurveyDefinition } from "@rescript/schema";
import {
  buildVariableDictionary,
  conjointMethodOf,
  conjointPlanReadiness,
  countRespondentQuestions,
  isOutstanding,
  isTerminalFailure,
  lintCalculations,
  lintElementIds,
  lintEmbeddedPiping,
  lintLanguage,
  surveyLanguages,
  lintLoops,
  lintStructure,
  lintSurveyLogic,
  lintVariables,
  sameVariableName,
  taskProgress,
  taskSpend,
  validateActionOutcome,
  type DeliverableReport,
  type DeliverableSpec,
  type ExecStep,
  type ExecTask,
  type SurveyAction,
  type TaskKind,
  type TaskStatus,
} from "@rescript/engine";
import { plannedItemReadiness } from "@rescript/analytics";

/* ============================================================ the exam key */

/**
 * A SCORED EXAM'S ANSWER KEY — deliberately NOT part of `SurveyDefinition`.
 *
 * The runtime serves the published definition verbatim
 * (apps/runtime/app/api/runtime-definition/[versionId]/route.ts →
 * `getCachedVersionDefinition`, packages/quality/src/server.ts:263) and the
 * Runner localises the same object in the browser
 * (apps/runtime/components/Runner.tsx:592). Anything inside the definition is
 * therefore readable by the respondent, with the browser's dev tools and no
 * more. The precedent the schema already sets is the panel signing secret:
 * "sealed in the database (0072), never here" (packages/schema/src/survey.ts).
 *
 * So the key travels beside the definition, never in it, and `examKeyLeaks`
 * is the deterministic gate that proves it: a scored_exam task cannot be
 * `completed` while the served definition carries anything key-shaped.
 */
export interface ExamScoringRule {
  /** marks added for a right answer */
  correct: number;
  /** marks added for a wrong one — negative for negative marking */
  incorrect: number;
  /** marks for a question left blank (normally 0) */
  skipped: number;
}

export interface ExamKeyItem {
  /** the question's stable id in the definition — never its text */
  questionId: string;
  /** the option code that is right */
  correct: string;
  /** the syllabus topic, for the per-topic breakdown */
  topic?: string;
  /** marks for THIS item, when it differs from the rule */
  marks?: number;
}

export interface ExamAnswerKey {
  surveyId: string;
  /** which generation of the exam this key belongs to */
  version?: number;
  rule: ExamScoringRule;
  items: ExamKeyItem[];
}

/** extra inputs a kind needs that the definition does not carry */
export interface DeliverableContext {
  /** a scored exam's key, read from wherever the scoring engine keeps it */
  examKey?: ExamAnswerKey | null;
  /** planned analysis items, for the `analysis` kind */
  analysisItems?: Parameters<typeof plannedItemReadiness>[0][];
  /** variable metadata for `plannedItemReadiness` */
  analysisVariables?: Parameters<typeof plannedItemReadiness>[1];
}

/* ===================================================== the leak scan */

/**
 * Property names that mean "this is the answer". A definition is walked in
 * full — settings, meta_extensions, calculations, scripts, embedded data —
 * because the definition is served whole.
 */
const KEY_SHAPED = /^(answer_?key|answers?_?key|correct|correct_?answers?|correct_?codes?|correct_?options?|is_?correct|marking_?scheme|marking_?key|scoring_?key|answer_?sheet)$/i;

/** keys of a definition that a respondent never receives are still checked: there are none */
export function examKeyLeaks(def: SurveyDefinition): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (KEY_SHAPED.test(k)) found.push(`${path}.${k} carries an answer key — the respondent is served this definition verbatim, so the key must live outside it.`);
      walk(child, `${path}.${k}`);
    }
  };
  walk(def as unknown, "definition");
  /* a script can smuggle the key as text rather than as a property */
  for (const s of def.scripts ?? []) {
    const body = String((s as { code?: unknown }).code ?? "");
    if (/\banswer_?key\b|\bcorrectAnswer\b|\bmarkingScheme\b/i.test(body)) {
      found.push(`definition.scripts.${s.id ?? s.name ?? "?"} mentions an answer key in its source — a respondent can read every script.`);
    }
  }
  return found;
}

/* ===================================================== exam scoring */

export interface TopicScore {
  topic: string;
  asked: number;
  correct: number;
  incorrect: number;
  skipped: number;
  score: number;
  max: number;
  /** percentage of the topic's maximum actually earned, 0 when the maximum is 0 */
  pct: number;
}

export interface ExamResult {
  asked: number;
  answered: number;
  correct: number;
  incorrect: number;
  skipped: number;
  score: number;
  max: number;
  pct: number;
  byTopic: TopicScore[];
  /** topics scored below `weakBelow`, weakest first */
  weakAreas: string[];
  /** key items whose question is not in the definition (never silently scored) */
  unscored: string[];
}

const blank = (v: unknown): boolean =>
  v == null || v === "" || (Array.isArray(v) && v.filter((x) => x !== "" && x != null).length === 0);

const asCode = (v: unknown): string => {
  if (Array.isArray(v)) { const xs = v.filter((x) => x !== "" && x != null); return xs.length === 1 ? String(xs[0]) : xs.map(String).sort().join("|"); }
  return String(v);
};

/**
 * SCORING IN APPLICATION CODE, from the saved answers and the key — never in
 * the survey, never by a model. `answers` is keyed the way the response state
 * keys them (`answerKey(questionId)` with no loop, i.e. the question id).
 */
export function scoreExam(
  key: ExamAnswerKey,
  answers: Record<string, unknown>,
  opts: { def?: SurveyDefinition; weakBelow?: number } = {},
): ExamResult {
  const weakBelow = opts.weakBelow ?? 50;
  const known = opts.def ? new Set(opts.def.questions.map((q) => q.id)) : null;
  const topics = new Map<string, TopicScore>();
  const unscored: string[] = [];
  let correct = 0, incorrect = 0, skipped = 0, score = 0, max = 0, asked = 0;

  for (const item of key.items) {
    if (known && !known.has(item.questionId)) { unscored.push(item.questionId); continue; }
    asked++;
    const topicName = item.topic ?? "Unclassified";
    const t = topics.get(topicName) ?? topics.set(topicName, { topic: topicName, asked: 0, correct: 0, incorrect: 0, skipped: 0, score: 0, max: 0, pct: 0 }).get(topicName)!;
    const full = item.marks ?? key.rule.correct;
    t.asked++; t.max += full; max += full;
    const given = answers[item.questionId];
    if (blank(given)) { skipped++; t.skipped++; score += key.rule.skipped; t.score += key.rule.skipped; continue; }
    if (asCode(given) === String(item.correct)) { correct++; t.correct++; score += full; t.score += full; continue; }
    incorrect++; t.incorrect++; score += key.rule.incorrect; t.score += key.rule.incorrect;
  }

  const byTopic = [...topics.values()].map((t) => ({ ...t, pct: t.max > 0 ? Math.round((t.score / t.max) * 1000) / 10 : 0 }));
  byTopic.sort((a, b) => a.topic.localeCompare(b.topic));
  const weakAreas = byTopic.filter((t) => t.asked > 0 && t.pct < weakBelow).sort((a, b) => a.pct - b.pct).map((t) => t.topic);
  return {
    asked, answered: correct + incorrect, correct, incorrect, skipped, score, max,
    pct: max > 0 ? Math.round((score / max) * 1000) / 10 : 0,
    byTopic, weakAreas, unscored,
  };
}

/** the researcher-facing report: totals, per-topic breakdown, weak areas */
export function examReportLines(r: ExamResult): string[] {
  const out = [`${r.correct} right, ${r.incorrect} wrong, ${r.skipped} not attempted of ${r.asked} — ${r.score} of ${r.max} marks (${r.pct}%).`];
  for (const t of r.byTopic) out.push(`${t.topic}: ${t.correct}/${t.asked} right, ${t.score} of ${t.max} marks (${t.pct}%).`);
  if (r.weakAreas.length) out.push(`Weakest: ${r.weakAreas.join(", ")}.`);
  if (r.unscored.length) out.push(`${r.unscored.length} key item${r.unscored.length === 1 ? "" : "s"} name a question this survey does not have — not scored.`);
  return out;
}

/* ===================================================== the invariants */

const errorsOf = (xs: { level: "error" | "warning"; message: string }[]): string[] =>
  xs.filter((i) => i.level === "error").map((i) => i.message);

/**
 * The named invariants a spec may demand. Each one is a lookup into an
 * existing validator; nothing here re-implements a check.
 */
const INVARIANTS: Record<string, (def: SurveyDefinition) => string[]> = {
  schema_valid: (def) => {
    const parsed = SurveyDefinitionSchema.safeParse(def);
    return parsed.success ? [] : parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "definition"}: ${i.message}`);
  },
  ids_unique: (def) => lintElementIds(def),
  logic_resolves: (def) => errorsOf(lintSurveyLogic(def)),
  structure_valid: (def) => errorsOf(lintStructure(def)),
  loops_valid: (def) => errorsOf(lintLoops(def)),
  variables_unique: (def) => lintVariables(def),
  /**
   * B20 (client review 23/10/2026): a variable name keeps the case the
   * programmer typed, and uniqueness is checked REGARDLESS of case, so `Q6a`
   * and `Q6A` can never both exist. `lintVariables` compares exactly; the
   * case rule is `sameVariableName` (variableUsage.ts), applied here over the
   * same dictionary rather than written again.
   */
  variables_unique_ignoring_case: (def) => {
    const out: string[] = [];
    const kept: { name: string; owner: string }[] = [];
    for (const v of buildVariableDictionary(def)) {
      const owner = v.questionId ?? v.questionCode ?? v.responseType ?? v.name;
      const clash = kept.find((k) => k.owner !== owner && sameVariableName(k.name, v.name));
      if (clash && clash.name !== v.name) {
        out.push(`Variables "${clash.name}" and "${v.name}" differ only in case — names are unique regardless of case (B20, 23/10/2026). Rename one.`);
      }
      kept.push({ name: v.name, owner });
    }
    return out;
  },
  /**
   * Every piped Embedded Data reference must resolve WHERE IT RUNS.
   * `lintEmbeddedPiping` raises these at `warning` level because the Studio
   * shows them under the field rather than blocking a save; for a deliverable
   * that promises "the references resolve" they are exactly the unmet
   * requirement, so all of them are reported here.
   */
  embedded_data_resolves: (def) => lintEmbeddedPiping(def).map((i) => i.message),
  calculations_valid: (def) => lintCalculations(def),
};

export const INVARIANT_NAMES: readonly string[] = Object.keys(INVARIANTS);

/** the battery every built survey is held to, whatever else the spec asks */
const SURVEY_BUILD_INVARIANTS = [
  "schema_valid", "ids_unique", "logic_resolves", "structure_valid", "loops_valid",
  "variables_unique", "variables_unique_ignoring_case", "embedded_data_resolves", "calculations_valid",
] as const;

/* ===================================================== design kinds */

const designQuestions = (def: SurveyDefinition, types: string[]): Question[] =>
  (def.questions ?? []).filter((q) => types.includes(q.type));

/**
 * CONJOINT / MAXDIFF COMPLETION IS A STRUCTURE QUESTION, NOT A COUNT. A CBC
 * with "12 questions" means nothing; a CBC with a design whose rows the
 * renderer and the estimator can both read means everything. So conjoint is
 * gated on `conjointPlanReadiness` and MaxDiff on `lintStructure`'s
 * design-reference checks (the design exists, the question points at it, the
 * kinds match) plus the rows the renderer reads.
 */
function conjointProblems(def: SurveyDefinition): { problems: string[]; measured: Record<string, number | string | boolean> } {
  const qs = designQuestions(def, ["conjoint_task", "acbc_task"]);
  const problems: string[] = [];
  if (!qs.length) problems.push("No conjoint question in the survey yet.");
  let ready = 0;
  for (const q of qs) {
    const r = conjointPlanReadiness(def, q);
    if (r.ready) ready++;
    for (const i of r.issues) problems.push(i);
  }
  problems.push(...errorsOf(lintStructure(def)).filter((m) => /design/i.test(m)));
  const methods = qs.map((q) => conjointMethodOf(def, q)?.method ?? "?").join(", ");
  return { problems, measured: { conjointQuestions: qs.length, designsReady: ready, methods } };
}

function maxdiffProblems(def: SurveyDefinition): { problems: string[]; measured: Record<string, number | string | boolean> } {
  const qs = designQuestions(def, ["maxdiff_task"]);
  const problems: string[] = [];
  if (!qs.length) problems.push("No MaxDiff question in the survey yet.");
  /* the design-reference structure checks, from the one place that owns them */
  problems.push(...errorsOf(lintStructure(def)).filter((m) => /design/i.test(m)));
  let withRows = 0;
  for (const q of qs) {
    const ref = (q.settings as { designRef?: string } | undefined)?.designRef;
    const design = ref ? (def.designs ?? []).find((d) => d.id === ref) : undefined;
    const rows = design?.file?.rows?.length ?? 0;
    if (rows > 0) withRows++;
    else if (design) problems.push(`${q.code}'s MaxDiff design “${design.id}” has no rows — generate it before the task is done.`);
  }
  return { problems, measured: { maxdiffQuestions: qs.length, designsWithRows: withRows } };
}

/* ===================================================== the gate */

/**
 * THE ONE GATE ON `completed`. `def` is the survey as the task would leave it.
 * `ok` false with `measured.resumeAt` set means INCOMPLETE and resumable —
 * never failed.
 */
export function checkDeliverable(spec: DeliverableSpec, def: SurveyDefinition, ctx: DeliverableContext = {}): DeliverableReport {
  const problems: string[] = [];
  const measured: Record<string, number | string | boolean> = { kind: spec.kind };

  /* --- the count, where a count is what the request promised ------- */
  const needsCount = spec.questionCount != null && (spec.kind === "survey_build" || spec.kind === "scored_exam" || spec.kind === "other");
  if (needsCount) {
    const built = countRespondentQuestions(def);
    measured.questions = built;
    measured.required = spec.questionCount!;
    if (built < spec.questionCount!) {
      measured.resumeAt = built + 1;
      measured.missing = spec.questionCount! - built;
      problems.push(`${built} of ${spec.questionCount} questions built — ${spec.questionCount! - built} still to generate, resuming at question ${built + 1}.`);
    } else if (built > spec.questionCount!) {
      problems.push(`${built} questions built but ${spec.questionCount} were asked for — remove ${built - spec.questionCount!} before this is done.`);
    }
  }

  /* --- the battery, for anything that builds a questionnaire ------- */
  const battery = new Set<string>(spec.invariants ?? []);
  if (spec.kind === "survey_build" || spec.kind === "scored_exam") for (const n of SURVEY_BUILD_INVARIANTS) battery.add(n);
  if (spec.kind === "conjoint" || spec.kind === "maxdiff" || spec.kind === "translation") battery.add("schema_valid");
  let invariantFailures = 0;
  for (const name of battery) {
    const run = INVARIANTS[name];
    if (!run) { problems.push(`Unknown invariant "${name}" in the deliverable spec — it was not checked.`); continue; }
    let found: string[];
    try { found = run(def); } catch (e) { found = [`${name}: the check could not run (${e instanceof Error ? e.message : "unknown"}).`]; }
    invariantFailures += found.length;
    problems.push(...found);
  }
  measured.invariantFailures = invariantFailures;

  /* --- per kind ---------------------------------------------------- */
  if (spec.kind === "conjoint") {
    const r = conjointProblems(def);
    problems.push(...r.problems);
    Object.assign(measured, r.measured);
  }
  if (spec.kind === "maxdiff") {
    const r = maxdiffProblems(def);
    problems.push(...r.problems);
    Object.assign(measured, r.measured);
  }
  /* conjoint and maxdiff questions inside an ordinary build are still held to their structure */
  if (spec.kind === "survey_build" && (spec.designChecks?.length || designQuestions(def, ["conjoint_task", "acbc_task", "maxdiff_task"]).length)) {
    if (designQuestions(def, ["conjoint_task", "acbc_task"]).length) { const r = conjointProblems(def); problems.push(...r.problems); Object.assign(measured, r.measured); }
    if (designQuestions(def, ["maxdiff_task"]).length) { const r = maxdiffProblems(def); problems.push(...r.problems); Object.assign(measured, r.measured); }
  }

  if (spec.kind === "translation") {
    const lang = spec.language;
    if (!lang) problems.push("The translation task has no target language in its deliverable spec.");
    else if (!surveyLanguages(def).some((l) => l.code === lang)) {
      /*
       * THE GATE THE LIVE PATH USES MUST BE THE STRICT ONE (audit H10).
       * `translationComplete` in translationTask.ts refuses a language the
       * survey does not serve; this branch — the one `taskMirror` actually
       * calls — did not, so a survey configured for `en` with every string
       * translated into `fr` reported the `fr` task COMPLETE. `lintLanguage`
       * answers "ready" for a language nobody will ever be served, which is
       * true and useless on its own.
       */
      measured.language = lang;
      problems.push(`“${lang}” is not one of this survey's languages, so nothing would ever be served in it — add it to the survey's languages first.`);
    } else if (spec.scopedQuestions) {
      /* part of the survey (2026-10-29): the scope's 100 % coverage is the translation family's completion validator's verdict; launch-readiness is not asked of a partial translation */
      measured.language = lang;
      measured.scopedQuestions = spec.scopedQuestions;
    } else {
      const report = lintLanguage(def, lang);
      measured.language = lang;
      measured.mandatory = report.mandatory;
      measured.translated = report.translated;
      measured.missingKeys = report.missing;
      measured.completion = report.completion;
      measured.ready = report.ready;
      if (!report.ready) {
        const blocking = report.issues.filter((i) => i.blocking);
        problems.push(`${report.name}: ${report.completion}% of the mandatory text is translated (${report.mandatory - report.missing} of ${report.mandatory}) — not ready.`);
        for (const i of blocking.slice(0, 20)) problems.push(`${i.key} (${i.label}): ${i.message}`);
        if (blocking.length > 20) problems.push(`… and ${blocking.length - 20} more blocking issues.`);
        const firstMissing = report.issues.find((i) => i.kind === "missing");
        if (firstMissing) measured.resumeKey = firstMissing.key;
      }
    }
  }

  if (spec.kind === "scored_exam") {
    const key = ctx.examKey ?? null;
    const need = spec.keyCoverage ?? spec.questionCount ?? 0;
    measured.keyItems = key?.items.length ?? 0;
    if (!key) problems.push("No answer key was supplied to the deliverable check — a scored exam is not done until its key is in the scoring engine's store.");
    else {
      const byId = new Map((def.questions ?? []).map((q) => [q.id, q]));
      const dangling = key.items.filter((i) => !byId.has(i.questionId));
      if (dangling.length) problems.push(`${dangling.length} key item${dangling.length === 1 ? "" : "s"} name a question this survey does not have (${dangling.slice(0, 5).map((d) => d.questionId).join(", ")}).`);
      const badCode = key.items.filter((i) => {
        const q = byId.get(i.questionId);
        return q && Array.isArray(q.options) && q.options.length > 0 && !q.options.some((o) => String(o.code) === String(i.correct));
      });
      if (badCode.length) problems.push(`${badCode.length} key item${badCode.length === 1 ? "" : "s"} mark an option code the question does not offer (${badCode.slice(0, 5).map((d) => `${d.questionId}=${d.correct}`).join(", ")}).`);
      const dupes = key.items.map((i) => i.questionId).filter((id, i, xs) => xs.indexOf(id) !== i);
      if (dupes.length) problems.push(`The key marks ${new Set(dupes).size} question${new Set(dupes).size === 1 ? "" : "s"} more than once.`);
      if (need > 0 && key.items.length < need) {
        measured.resumeAt = Math.min(Number(measured.resumeAt ?? Infinity), key.items.length + 1);
        problems.push(`The answer key covers ${key.items.length} of ${need} questions — ${need - key.items.length} still to key, resuming at question ${key.items.length + 1}.`);
      }
    }
    const rule = spec.scoring;
    if (!rule) problems.push("No scoring rule in the spec — marks for right, wrong and skipped must be stated before an exam can be marked.");
    else measured.scoring = `${rule.correct}/${rule.incorrect}/${rule.skipped}`;
    const leaks = examKeyLeaks(def);
    measured.keyLeaks = leaks.length;
    problems.push(...leaks);
  }

  if (spec.kind === "analysis" && ctx.analysisItems?.length) {
    let notReady = 0;
    for (const item of ctx.analysisItems) {
      const r = plannedItemReadiness(item, ctx.analysisVariables ?? [], def);
      if (!r.ready) { notReady++; problems.push(...r.missing); }
    }
    measured.analysisItems = ctx.analysisItems.length;
    measured.analysisNotReady = notReady;
  }

  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique, measured };
}

/**
 * ONE STEP'S OWN OUTPUT, checked before it counts as done — the same check the
 * action layer runs when a researcher applies an action by hand
 * (`validateActionOutcome`). Errors mean the step did not deliver.
 */
export function stepOutcomeProblems(before: SurveyDefinition, after: SurveyDefinition, action: SurveyAction, touched: string[]): { status: "valid" | "invalid"; errors: string[] } {
  const issues = validateActionOutcome(before, after, action, touched);
  const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
  return { status: errors.length ? "invalid" : "valid", errors };
}

/* ===================================================== resume & status */

export interface ResumePoint {
  /** what the unit is, in the task kind's own terms */
  unit: "question" | "key" | "step";
  /** the 1-based item the next slice starts at */
  at: number | string;
  remaining: number;
  why: string;
}

/** where a short deliverable picks up — null when nothing is missing */
export function resumePoint(report: DeliverableReport): ResumePoint | null {
  const m = report.measured ?? {};
  if (typeof m.resumeKey === "string") {
    return { unit: "key", at: m.resumeKey, remaining: Number(m.missingKeys ?? 0), why: report.problems[0] ?? "untranslated keys remain" };
  }
  if (typeof m.resumeAt === "number" && Number.isFinite(m.resumeAt)) {
    const remaining = Number(m.missing ?? (typeof m.required === "number" ? m.required - Number(m.questions ?? 0) : 0));
    return { unit: "question", at: m.resumeAt, remaining, why: report.problems[0] ?? "the deliverable is short" };
  }
  return null;
}

/**
 * THE STATUS A TASK TAKES AFTER A SLICE. An unmet deliverable is `running`,
 * not `failed`: questions 1–64 stand and the next slice starts at 65. Only a
 * terminally classified step failure — auth, config, permanent — makes a task
 * `failed`, and even then every completed step is preserved.
 */
export function nextStatusFor(task: Pick<ExecTask, "steps" | "status">, report: DeliverableReport): TaskStatus {
  if (task.status === "cancelled") return "cancelled";
  const terminal = task.steps.find((s) => s.status === "failed" && s.failureKind && isTerminalFailure(s.failureKind));
  if (terminal) return "failed";
  const stepsDone = !task.steps.some(isOutstanding);
  if (stepsDone && report.ok) return "completed";
  return "running";
}

/* ===================================================== the spec, read */

const NUMBER_WORDS: Record<string, number> = { ten: 10, twenty: 20, twenty_five: 25, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };

const KIND_PATTERNS: [TaskKind, RegExp][] = [
  ["scored_exam", /\b(exam|mock test|test paper|question paper|upsc|neet|gate|quiz with (?:an )?answer key|answer key|negative marking|scored test)\b/i],
  ["translation", /\b(translat\w+|localis\w+|localiz\w+)\b/i],
  ["conjoint", /\b(conjoint|cbc|acbc|choice[- ]based|discrete choice)\b/i],
  ["maxdiff", /\b(max[- ]?diff|best[- ]?worst)\b/i],
  ["analysis", /\b(analysis plan|crosstabs?|significance test|run the analysis)\b/i],
];

/*
 * Name → ISO code. `lintLanguage` and `recordTranslation` key everything by
 * the code, so a spec carrying a display name can never complete. Urdu was
 * missing, which is the language the brief's own acceptance test C uses
 * (audit, 2026-10-25); the rest of the subcontinental and CJK set is filled
 * in at the same time so the next one is not a surprise either.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  hindi: "hi", urdu: "ur", spanish: "es", french: "fr", german: "de", portuguese: "pt", italian: "it", dutch: "nl",
  arabic: "ar", japanese: "ja", korean: "ko", russian: "ru", polish: "pl", turkish: "tr", thai: "th",
  vietnamese: "vi", indonesian: "id", malay: "ms", tamil: "ta", telugu: "te", bengali: "bn", marathi: "mr",
  gujarati: "gu", kannada: "kn", malayalam: "ml", punjabi: "pa", odia: "or", assamese: "as", nepali: "ne",
  sinhala: "si", burmese: "my", khmer: "km", lao: "lo", filipino: "fil", tagalog: "fil", swahili: "sw",
  hebrew: "he", persian: "fa", farsi: "fa", greek: "el", czech: "cs", hungarian: "hu", romanian: "ro",
  swedish: "sv", norwegian: "nb", danish: "da", finnish: "fi", ukrainian: "uk", chinese: "zh", mandarin: "zh",
};

/**
 * READ A SPEC OFF THE REQUEST at task-creation time. Deterministic and
 * conservative: it asserts only what the sentence actually promised, because
 * a spec that invents a requirement blocks a task that was in fact finished.
 * The caller's `hint` (from the plan, or from the Studio) always wins.
 */
export function specFromRequest(request: string, hint: Partial<DeliverableSpec> = {}): DeliverableSpec {
  const text = String(request ?? "");
  let kind: TaskKind = hint.kind ?? "survey_build";
  if (!hint.kind) for (const [k, re] of KIND_PATTERNS) if (re.test(text)) { kind = k; break; }

  const spec: DeliverableSpec = { kind };

  const count = text.match(/\b(\d{1,4})\s*(?:-|\s)?\s*(?:mcqs?|questions?|items?|q(?:s)?)\b/i)
    ?? text.match(/\b(?:a|an)\s+(ten|twenty|thirty|forty|fifty|hundred)\s*[- ]?\s*(?:question|item)\b/i);
  if (count) {
    const raw = count[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw.toLowerCase()];
    if (n && n > 0 && n <= 2000) spec.questionCount = n;
  }

  if (kind === "translation") {
    const code = text.match(/\b(?:into|to|in)\s+([A-Za-z]{2,})\b/i);
    const named = code ? LANGUAGE_NAMES[code[1].toLowerCase()] : undefined;
    const iso = text.match(/\b(?:lang(?:uage)?\s*[:=]\s*)([a-z]{2}(?:-[A-Za-z]{2,4})?)\b/);
    if (named) spec.language = named;
    else if (iso) spec.language = iso[1];
  }

  if (kind === "scored_exam") {
    if (spec.questionCount) spec.keyCoverage = spec.questionCount;
    const neg = text.match(/(?:minus|-|negative(?:\s+marking)?(?:\s+of)?\s*)(\d+(?:\.\d+)?)\s*(?:marks?|mark)?\s*(?:for|per)?\s*(?:each\s*)?(?:wrong|incorrect)/i);
    const pos = text.match(/(\d+(?:\.\d+)?)\s*marks?\s*(?:for|per)\s*(?:each\s*)?(?:right|correct)/i);
    if (pos || neg || /negative marking/i.test(text)) {
      spec.scoring = {
        correct: pos ? Number(pos[1]) : 1,
        incorrect: neg ? -Math.abs(Number(neg[1])) : /negative marking/i.test(text) ? -0.25 : 0,
        skipped: 0,
      };
    }
  }

  if (kind === "conjoint" || kind === "maxdiff") spec.designChecks = ["design_rows", "design_reference"];
  if (kind === "survey_build" || kind === "scored_exam") spec.invariants = [...SURVEY_BUILD_INVARIANTS];

  return { ...spec, ...hint, kind };
}

/* ===================================================== the panel's view */

export interface ExecutionRow {
  stepId: string;
  title: string;
  status: ExecStep["status"];
  /** "12 questions", "40 keys" — the step's own unit, when it has one */
  size: number | null;
  sizeUsed: number | null;
  validation: "unchecked" | "valid" | "invalid";
  problems: string[];
  failureKind?: ExecStep["failureKind"];
  failureMessage?: string;
  retryCount: number;
  inputRef?: string;
  seconds: number | null;
}

export type ExecutionPhase = "planning" | "building" | "validating" | "recovering" | "needs attention" | "done" | "cancelled";

export interface ExecutionEstimate {
  known: boolean;
  /** what the panel prints; when `known` is false this says WHY there is no estimate */
  text: string;
  seconds?: number;
}

export interface ExecutionView {
  status: TaskStatus;
  phase: ExecutionPhase;
  headline: string;
  rows: ExecutionRow[];
  total: number;
  completed: number;
  remaining: number;
  failed: number;
  running: number;
  blocked: number;
  currentStep: ExecutionRow | null;
  /** the item range the current step is working on, when its step says so */
  itemRange: { from: number; to: number } | null;
  validation: { checked: number; invalid: number; problems: string[] };
  recovery: { retrying: number; attention: boolean; message: string | null };
  spend: { tokensIn: number; tokensOut: number; tokensCached: number; charge: number; real: boolean };
  estimate: ExecutionEstimate;
  durable: boolean;
  durabilityNote: string | null;
  report: DeliverableReport | null;
  resume: ResumePoint | null;
}

const RANGE_RE = /(\d+)\s*(?:-|–|to|…|\.\.)\s*(\d+)/;

/**
 * The item range a step is working on — "questions 65-80", "keys 41–80".
 * Read from `inputRef` where there is one and from the step's TITLE
 * otherwise, because `redactForClient` (taskStore.ts) does not carry
 * `inputRef` to the browser and the panel must still be able to say which
 * items are in flight.
 */
/*
 * L2 (audit, 2026-10-25): `inputRef` may be the reconciliation envelope,
 * `{"v":1,"objects":[…],"fp":"…"}`. Running a range regex over that turned an
 * object named "2024-2025 wave" into "items 2024–2025". An envelope is
 * structure, not prose: it is skipped, and only the title is read.
 */
const ENVELOPE = /^\s*\{\s*"v"\s*:/;

export function itemRangeOf(step: { inputRef?: string; title?: string } | null | undefined): { from: number; to: number } | null {
  const ref = step?.inputRef && !ENVELOPE.test(step.inputRef) ? step.inputRef : undefined;
  const m = step ? RANGE_RE.exec(ref ?? step.title ?? "") : null;
  if (!m) return null;
  const from = Number(m[1]), to = Number(m[2]);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? { from, to } : null;
}

/**
 * THE FIELDS THE PANEL READS, and no more. Written as a structural type
 * rather than `ExecStep` so the client's redacted step
 * (`ClientStep`, taskStore.ts — no `taskId`, no `idempotencyKey`, no
 * `output`) is accepted unchanged: the panel must not need the fields the
 * server refuses to send it.
 */
export type StepRow =
  Pick<ExecStep, "stepId" | "status" | "retryCount">
  & Partial<Pick<ExecStep, "title" | "batchSize" | "batchSizeUsed" | "validation" | "failureKind" | "failureMessage" | "inputRef" | "usage" | "startedAt" | "finishedAt">>;

export interface TaskView {
  status: TaskStatus;
  steps: readonly StepRow[];
  report?: DeliverableReport;
  deliverable?: DeliverableSpec;
}

const rowOf = (s: StepRow): ExecutionRow => ({
  stepId: s.stepId,
  title: s.title ?? s.stepId,
  status: s.status,
  size: s.batchSize ?? null,
  sizeUsed: s.batchSizeUsed ?? null,
  validation: s.validation?.status ?? "unchecked",
  problems: s.validation?.errors ?? [],
  ...(s.failureKind ? { failureKind: s.failureKind } : {}),
  ...(s.failureMessage ? { failureMessage: s.failureMessage } : {}),
  retryCount: s.retryCount,
  ...(s.inputRef ? { inputRef: s.inputRef } : {}),
  seconds: s.startedAt != null && s.finishedAt != null && s.finishedAt >= s.startedAt ? Math.round((s.finishedAt - s.startedAt) / 100) / 10 : null,
});

/**
 * THE EXECUTION PANEL'S WHOLE TRUTH, computed from the persisted rows and
 * nothing else. Every number here is a count of rows; there is no number the
 * panel may show that this function did not derive from a row, which is what
 * keeps the panel from animating progress that is not happening.
 */
export function executionView(
  task: TaskView,
  opts: { durable?: boolean; now?: number } = {},
): ExecutionView {
  const durable = opts.durable !== false;
  /* `taskProgress` / `taskSpend` read only `status` and `usage`; the cast is what
     lets the same two counters serve the server's rows and the client's redacted ones. */
  const counted = { steps: task.steps as unknown as ExecStep[] };
  const p = taskProgress(counted);
  const rows = task.steps.map(rowOf);
  const spendRaw = taskSpend(counted);
  const spendReal = task.steps.some((s) => s.usage && (s.usage.tokensIn != null || s.usage.tokensOut != null || s.usage.charge != null));

  const running = task.steps.find((s) => s.status === "running");
  const retrying = task.steps.filter((s) => s.status === "retrying");
  const failedSteps = task.steps.filter((s) => s.status === "failed");
  const terminal = failedSteps.filter((s) => s.failureKind && isTerminalFailure(s.failureKind));
  const next = task.steps.find((s) => s.status === "pending" || s.status === "retrying" || s.status === "running");
  const current = running ?? retrying[0] ?? next ?? null;
  const currentRow = current ? rowOf(current) : null;

  const invalid = task.steps.filter((s) => s.validation?.status === "invalid");
  const checked = task.steps.filter((s) => s.validation && s.validation.status !== "unchecked").length;
  const report = task.report ?? null;
  const resume = report ? resumePoint(report) : null;

  /* PHASE. A failed batch is never success: `recovering` while a retry is
     possible, `needs attention` once it is not. */
  let phase: ExecutionPhase;
  if (task.status === "cancelled") phase = "cancelled";
  else if (terminal.length) phase = "needs attention";
  else if (failedSteps.length || retrying.length) phase = "recovering";
  else if (task.status === "completed") phase = "done";
  else if (p.total === 0) phase = "planning";
  else if (p.completed === p.total) phase = "validating";
  else phase = "building";

  const remaining = p.total - p.completed;

  /* THE TIME ESTIMATE, only where one is defensible — the fieldwork panel's
     rule (packages/analytics/src/fieldwork.ts:283): when the inputs are not
     there, say what is missing, never a number. */
  const timed = task.steps.filter((s) => s.status === "completed" && s.startedAt != null && s.finishedAt != null && s.finishedAt > s.startedAt);
  let estimate: ExecutionEstimate;
  if (p.total === 0) estimate = { known: false, text: "No steps yet — nothing to estimate." };
  else if (remaining === 0) estimate = { known: false, text: "Nothing left to run." };
  else if (terminal.length) estimate = { known: false, text: "Stopped — no estimate while a step needs attention." };
  else if (timed.length < 2) estimate = { known: false, text: `${p.completed} of ${p.total} steps done. No time estimate until two steps have finished.` };
  else {
    const per = timed.reduce((t, s) => t + (s.finishedAt! - s.startedAt!), 0) / timed.length;
    const seconds = Math.round((per * remaining) / 1000);
    estimate = { known: true, seconds, text: `About ${seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`} left at ${Math.round(per / 100) / 10}s a step.` };
  }

  const headline = phase === "needs attention"
    ? `${terminal.length} step${terminal.length === 1 ? "" : "s"} cannot continue — ${terminal[0].failureMessage ?? "see the rows below"}`
    : phase === "recovering"
      ? `${failedSteps.length + retrying.length} step${failedSteps.length + retrying.length === 1 ? "" : "s"} being retried — ${p.completed} of ${p.total} done`
      : phase === "done"
        ? `All ${p.total} steps done and the deliverable checked.`
        : phase === "validating"
          ? report && !report.ok ? (report.problems[0] ?? "The deliverable is not complete yet.") : "Every step is done — checking the deliverable."
          : phase === "planning"
            ? "Planning — no steps yet."
            : `${p.completed} of ${p.total} steps done${currentRow ? ` · ${currentRow.title}` : ""}`;

  return {
    status: task.status,
    phase,
    headline,
    rows,
    total: p.total,
    completed: p.completed,
    remaining,
    failed: p.failed,
    running: p.running,
    blocked: p.blocked,
    currentStep: currentRow,
    itemRange: itemRangeOf(current),
    validation: { checked, invalid: invalid.length, problems: invalid.flatMap((s) => s.validation?.errors ?? []).slice(0, 20) },
    recovery: {
      retrying: retrying.length,
      attention: terminal.length > 0,
      message: terminal.length
        ? `${terminal[0].title ?? terminal[0].stepId}: ${terminal[0].failureMessage ?? "this step cannot succeed as written"}`
        : failedSteps.length
          ? `${failedSteps[0].title ?? failedSteps[0].stepId}: ${failedSteps[0].failureMessage ?? "failed"} — retrying.`
          : null,
    },
    spend: { ...spendRaw, real: spendReal },
    estimate,
    durable,
    durabilityNote: durable ? null : "This run is held in this server's memory only — the task tables are not in place yet, so a restart or another server loses it. Ask an administrator to apply the migration.",
    report,
    resume,
  };
}
