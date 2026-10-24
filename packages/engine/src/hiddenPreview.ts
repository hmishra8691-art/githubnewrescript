import type { Question, SurveyDefinition, PunchRule } from "@rescript/schema";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import { resolvePunches, setExprSources, LIST_ACTIONS } from "./setExpression.js";
import { walkPunchChain } from "./punchChain.js";
import { conditionRefs, questionDependencies } from "./dependencies.js";
import { conditionSummary } from "./logicSummary.js";
import { answerKey, lookupAnswer, getQuestion, type LoopContext } from "./state.js";
import { stripHtmlText } from "./html.js";

/**
 * HIDDEN QUESTIONS, SEEN BY THE PROGRAMMER (client brief 19/10/2026, A15 + A66).
 *
 * `settings.hidden` controls RESPONDENT visibility, not programmer
 * visibility. A hidden question is invisible on a live / published link —
 * no text, no options, no empty space, no page of its own — while it keeps
 * running its auto-punch rules, its display / skip / branch logic, its
 * piping and its calculations in the background. In the builder, in the
 * Studio preview, in the runtime's test mode and on a test link the same
 * question IS shown, with a theme that says it is hidden from respondents,
 * and with the result of its auto-punch rules explained.
 *
 * This module holds the three pure pieces the Runner and the renderer share:
 *
 *   1. `revealsHiddenQuestions(mode)` — the one statement of which modes show
 *      hidden questions. The mode comes from the route that served the page
 *      (`/preview` → preview, `/t/…` → test, `/s/…` and every other
 *      respondent entry → live), never from a query parameter a respondent
 *      could set.
 *   2. `explainAutoPunch(def, q, ctx)` — what this question's punch rules did
 *      against the current answers: the status (applied / waiting / failed /
 *      no matching condition), the codes a rule put into the answer (so the
 *      renderer can paint them green and tell them from a manual selection),
 *      and one line per rule for the expandable details.
 *   3. `questionConfigFingerprint(q)` + `invalidateStalePreviewAnswers` — the
 *      stale-preview fix. A preview resumes from the answers it stored in
 *      the tab (lib/resume.ts). When the programmer changes an option, the
 *      Hidden setting or a punch condition and reopens the preview, the
 *      stored answers of exactly the changed questions — and of the punched
 *      questions that read them — are dropped, so the rules recompute from
 *      the new configuration; every other answer is kept. Ordinary
 *      navigation changes no fingerprint, so it clears nothing.
 */

export type RunnerMode = "live" | "test" | "preview";

/**
 * Whether a runtime in `mode` shows `settings.hidden` questions to the person
 * in front of it. Only test and preview do; `respondentView` is the
 * programmer's own "show me what a respondent sees" switch inside a preview
 * (set by the Studio's message, not by the URL), which turns them off again.
 * Anything that is not exactly "test" or "preview" — including an unknown or
 * missing mode — is treated as live: the safe default is to hide.
 */
export function revealsHiddenQuestions(mode: string | null | undefined, respondentView = false): boolean {
  return (mode === "preview" || mode === "test") && !respondentView;
}

/* ------------------------------------------------------------ auto punch */

export type AutoPunchStatus = "applied" | "waiting" | "failed" | "none";

export const AUTO_PUNCH_STATUS_LABEL: Record<AutoPunchStatus, string> = {
  applied: "Auto-Punch Applied",
  waiting: "Waiting for Condition",
  failed: "Auto-Punch Failed",
  none: "No Matching Condition",
};

export const AUTO_PUNCH_STATUS_ICON: Record<AutoPunchStatus, string> = {
  applied: "\u{1F7E2}", // green circle
  waiting: "\u{1F7E1}", // yellow circle
  failed: "\u{1F534}",  // red circle
  none: "⚪",       // white circle
};

export interface AutoPunchRuleDetail {
  ruleId: string;
  label?: string;
  /** IF / ELSE IF / ELSE */
  mode: "if" | "else_if" | "else";
  /** codes of the questions the rule reads (its condition and its source expression) */
  sourceQuestions: string[];
  /** the condition in words; "always" when the rule has none */
  condition: string;
  /** the question the rule fills — this one */
  target: string;
  action: PunchRule["action"];
  /** what the rule selects / sets, as labels (codes when the question has no such option) */
  selected: string[];
  /**
   * The condition's result: TRUE / FALSE when the rule was reached, null when
   * an earlier branch of its IF / ELSE IF chain already matched.
   */
  result: boolean | null;
  status: "applied" | "condition_false" | "not_reached";
}

export interface AutoPunchExplanation {
  status: AutoPunchStatus;
  statusLabel: string;
  statusIcon: string;
  /** codes of this question that a punch rule put into the current answer */
  punchedCodes: string[];
  /** for grids: the codes a rule put into each row's answer, by row code */
  punchedRows: Record<string, string[]>;
  /** "Adidas", "Adidas, Puma", a set value, or "" when nothing is punched */
  selectedAnswer: string;
  /** what the rules WANT selected right now, whether or not the answer holds it */
  expectedCodes: string[];
  rules: AutoPunchRuleDetail[];
}

const strip = (s: unknown) => stripHtmlText(String(s ?? "")).trim();

function optionLabel(q: Question, code: unknown): string {
  const c = String(code);
  const o = q.options?.find((x) => String(x.code) === c);
  if (o) return strip(o.label) || c;
  const r = q.rows?.find((x) => String(x.code) === c);
  if (r) return strip(r.label) || c;
  return c;
}

function codesIn(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" || typeof v === "number").map(String);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

function answered(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * What this question's auto-punch rules did against the answers so far.
 *
 * Returns null for a question with no answer-side punch rule (list actions —
 * show / hide / enable / disable — shape the option list and are explained by
 * the option pipeline, not here). Pure: reads `ctx.state`, writes nothing;
 * the punching itself is `applyPunches`, run by the flow interpreter.
 */
export function explainAutoPunch(def: SurveyDefinition, q: Question, ctx: EvalContext, loop: LoopContext | null = ctx.loop ?? null): AutoPunchExplanation | null {
  const answerRules = (q.punches ?? []).filter((r) => !LIST_ACTIONS.has(r.action));
  if (!answerRules.length) return null;

  const steps = walkPunchChain(answerRules, (r) => {
    try { return evaluateCondition(r.when, ctx); } catch { return false; }
  });

  let result: ReturnType<typeof resolvePunches> | null = null;
  try { result = resolvePunches(q, ctx); } catch { result = null; }

  const current = ctx.state.answers[answerKey(q.id, loop)];
  const currentCodes = codesIn(current);
  const expected = (result?.setValue ?? result?.select ?? []).map(String);
  const punchedCodes = expected.filter((c) => currentCodes.includes(c));

  const punchedRows: Record<string, string[]> = {};
  const expectedRows: Record<string, string[]> = {};
  if (result?.cells.length && current && typeof current === "object" && !Array.isArray(current)) {
    const obj = current as Record<string, unknown>;
    for (const cell of result.cells) {
      const row = String(cell.row);
      const want = (cell.setValue ?? cell.select).map(String);
      if (!want.length) continue;
      (expectedRows[row] ??= []).push(...want);
      const have = cell.column
        ? codesIn((obj[row] as Record<string, unknown> | undefined)?.[cell.column])
        : codesIn(obj[row]);
      const hit = want.filter((c) => have.includes(c));
      if (hit.length) (punchedRows[row] ??= []).push(...hit);
    }
  } else if (result?.cells.length) {
    for (const cell of result.cells) {
      const want = (cell.setValue ?? cell.select).map(String);
      if (want.length) (expectedRows[String(cell.row)] ??= []).push(...want);
    }
  }

  const anyApplied = steps.some((s) => s.applied);
  const expectsSomething = expected.length > 0 || Object.keys(expectedRows).length > 0;
  const allPresent = expected.every((c) => currentCodes.includes(c))
    && Object.entries(expectedRows).every(([row, want]) => want.every((c) => (punchedRows[row] ?? []).includes(c)));

  let status: AutoPunchStatus;
  if (!anyApplied) {
    /* no rule holds: are its sources even answered yet? */
    const sources = new Set<string>();
    for (const r of answerRules) {
      conditionRefs(def, r.when, sources);
      for (const id of setExprSources(r.source, undefined, def)) sources.add(id);
    }
    sources.delete(q.id);
    const unanswered = [...sources].some((id) => !answered(lookupAnswer(ctx.state.answers, id, loop)));
    status = unanswered ? "waiting" : "none";
  } else if (result?.clear && !expectsSomething) {
    status = answered(current) ? "failed" : "applied";
  } else if (!expectsSomething) {
    /* a rule held but names no code of this question (unmatched source codes) */
    status = "failed";
  } else {
    status = allPresent ? "applied" : "failed";
  }

  const rules: AutoPunchRuleDetail[] = steps.map((s) => {
    const r = s.rule;
    const sources = new Set<string>();
    conditionRefs(def, r.when, sources);
    for (const id of setExprSources(r.source, undefined, def)) sources.add(id);
    sources.delete(q.id);
    const selected = r.action === "clear"
      ? []
      : r.source.kind === "codes"
        ? r.source.codes.map((c) => (r.action === "set_value" && !q.options?.length ? String(c) : optionLabel(q, c)))
        : [...setExprSources(r.source, undefined, def)].map((id) => `the answer of ${getQuestion(def, id)?.code ?? id}`);
    return {
      ruleId: r.id,
      ...(r.label ? { label: r.label } : {}),
      mode: r.mode ?? "if",
      sourceQuestions: [...sources].map((id) => getQuestion(def, id)?.code ?? id),
      condition: (r.mode ?? "if") === "else" && !r.when ? "otherwise" : (conditionSummary(def, r.when) || "always"),
      target: q.code,
      action: r.action,
      selected,
      result: s.reached ? s.held : null,
      status: s.applied ? "applied" : s.reached ? "condition_false" : "not_reached",
    };
  });

  const selectedAnswer = punchedCodes.length
    ? punchedCodes.map((c) => (q.options?.length || q.rows?.length ? optionLabel(q, c) : c)).join(", ")
    : Object.entries(punchedRows).map(([row, codes]) => `${optionLabel(q, row)}: ${codes.map((c) => optionLabel(q, c)).join(", ")}`).join("; ");

  return {
    status,
    statusLabel: AUTO_PUNCH_STATUS_LABEL[status],
    statusIcon: AUTO_PUNCH_STATUS_ICON[status],
    punchedCodes,
    punchedRows,
    selectedAnswer,
    expectedCodes: expected,
    rules,
  };
}

/* ------------------------------------------------------ fingerprints (A66) */

/** FNV-1a over a string, as 8 hex digits — short enough to store per question in sessionStorage. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** JSON with sorted keys, so the same configuration always prints the same. */
function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/**
 * The part of a question's configuration that decides WHAT ITS ANSWER MAY
 * HOLD and HOW IT IS FILLED — not how it looks. A label edit, a new
 * instruction or a colour does not invalidate a stored preview answer; a
 * changed option code, a different punch target or condition, a Hidden /
 * Read-only switch, a default value, a carry-forward or mask does.
 */
export function questionConfigFingerprint(q: Question): string {
  const s = (q.settings ?? {}) as Record<string, unknown>;
  const shape = {
    type: q.type,
    variant: q.variant ?? null,
    hidden: !!s.hidden,
    readOnly: !!s.readOnly,
    defaultValue: s.defaultValue ?? null,
    expression: s.expression ?? null,
    options: (q.options ?? []).map((o) => ({ code: String(o.code), flags: o.flags ?? [] })),
    rows: (q.rows ?? []).map((r) => String(r.code)),
    columns: (q.columns ?? []).map((c) => ({ id: c.id, responseType: c.responseType, options: (c.options ?? []).map((o) => String(o.code)) })),
    punches: q.punches ?? [],
    displayLogic: q.displayLogic ?? null,
    carryForward: q.carryForward ?? null,
    mask: q.mask ?? null,
    rowMask: q.rowMask ?? null,
    columnMask: q.columnMask ?? null,
    listLogic: q.listLogic ?? [],
    optionPipeline: q.optionPipeline ?? null,
  };
  return fnv1a(stable(shape));
}

/** One fingerprint per question, by id — what the preview stores beside its answers. */
export function configFingerprints(def: SurveyDefinition): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of def.questions) out[q.id] = questionConfigFingerprint(q);
  return out;
}

export interface StaleInvalidation {
  /** question ids whose own configuration changed (or that no longer exist) */
  changed: string[];
  /** every question whose stored answer was dropped: the changed ones plus the punched questions that read them */
  invalidated: string[];
  /** the answer keys removed */
  removedKeys: string[];
}

/**
 * DROP EXACTLY THE PREVIEW ANSWERS THE NEW CONFIGURATION MAKES STALE.
 *
 * `previous` is the fingerprint map stored with the snapshot; `def` is the
 * definition the preview is now running. A question whose fingerprint
 * differs — or that was deleted — loses its stored answer (every key of it:
 * the bare id, loop-scoped `id@…` keys and the `id__other…` / `id__comment`
 * side keys). So does every punched question whose rules read a changed
 * question, transitively, because its stored value was derived from the old
 * configuration: the flow's prefill and `punchDerivedQuestions` then write
 * the new value on the next evaluation. Nothing else is touched — unrelated
 * answers are what the programmer typed and are kept.
 *
 * A snapshot with no fingerprints at all (written before this existed)
 * invalidates nothing: there is no evidence anything changed. The caller
 * stores the current fingerprints with the next checkpoint.
 *
 * Mutates and returns `answers`.
 */
export function invalidateStalePreviewAnswers(
  def: SurveyDefinition,
  answers: Record<string, unknown>,
  previous: Record<string, string> | null | undefined,
): StaleInvalidation {
  const none: StaleInvalidation = { changed: [], invalidated: [], removedKeys: [] };
  if (!previous || typeof previous !== "object") return none;
  const now = configFingerprints(def);
  const changed = new Set<string>();
  for (const [id, fp] of Object.entries(previous)) {
    if (now[id] === undefined || now[id] !== fp) changed.add(id);
  }
  if (!changed.size) return none;

  /* the punched questions downstream of a change, until nothing new is reached */
  const invalid = new Set(changed);
  const punched = def.questions.filter((q) => q.punches?.length);
  const deps = new Map(punched.map((q) => [q.id, questionDependencies(def, q)]));
  for (let pass = 0; pass <= punched.length; pass++) {
    let grew = false;
    for (const q of punched) {
      if (invalid.has(q.id)) continue;
      const d = deps.get(q.id)!;
      if ([...invalid].some((id) => d.has(id))) { invalid.add(q.id); grew = true; }
    }
    if (!grew) break;
  }

  const removedKeys: string[] = [];
  for (const key of Object.keys(answers)) {
    for (const id of invalid) {
      if (key === id || key.startsWith(`${id}__`) || key.startsWith(`${id}@`)) {
        delete answers[key];
        removedKeys.push(key);
        break;
      }
    }
  }
  return { changed: [...changed], invalidated: [...invalid], removedKeys };
}
