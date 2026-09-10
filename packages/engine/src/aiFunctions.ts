import type { SurveyDefinition, Question } from "@rescript/schema";

/**
 * AI-DERIVED VARIABLES — classification and sentiment as ordinary calculations.
 *
 * ## What this is
 *
 * A researcher who wants an open end coded writes a `calculated` question whose
 * expression is one of two functions:
 *
 *     ai_classify(Q5, "Price|Quality|Service|Other")
 *     ai_sentiment(Q5)
 *
 * That question IS the output variable. It has a code, a variable name, an
 * export column, and can be referenced from display logic, quotas, other
 * calculations and analytics exactly like any other question — because it is
 * one. Nothing new was added to the variable model, the export model, the
 * logic model or the picker. The whole feature is two function names.
 *
 * ## Why the browser does not evaluate these
 *
 * Every other calc function is pure and synchronous, and `runCalculations`
 * runs them in the respondent's browser on every trigger. An AI call is a
 * network round trip to a provider, with a key the browser must never hold.
 * So these two are SERVER-RESOLVED: the runtime asks `/api/session/ai` for
 * them in the same slot List Fill runs — after the page's answers are valid
 * and BEFORE the flow advances, so a display rule or quota on the next page
 * that reads the variable sees the classification rather than a blank. The
 * result is merged into `state.answers` and the ordinary save persists it.
 * The browser's `runCalculations` skips a question whose expression is
 * server-resolved and keeps whatever the server wrote.
 *
 * ## The one rule: the AI call must be the WHOLE expression
 *
 * `if(ai_sentiment(Q5) = "negative", 1, 0)` is refused by lint. Not because it
 * is unreasonable — because it would need the server to resolve the inner
 * call and the browser to finish the outer one, two evaluators splitting one
 * expression. The same result is one line away with no such seam:
 *
 *     Q5_SENT  = ai_sentiment(Q5)
 *     Q5_FLAG  = if(Q5_SENT = "negative", 1, 0)
 *
 * One value, many consumers, through the variable — which is how every other
 * derived value in this platform already composes.
 *
 * ## What the researcher controls
 *
 * Whether AI runs at all: the calculated question exists or it does not, and
 * the provider is configured or it is not. Which question triggers it: the
 * source argument. What it may return: the category list, verbatim. Where it
 * lands: the calculated question's own variable. There is no AI behaviour
 * that is not written in the survey definition, and nothing here changes the
 * programmed flow — a classification is a value, and values do not branch.
 */

export const AI_FUNCTION_NAMES = ["ai_classify", "ai_sentiment"] as const;
export type AiFunctionName = (typeof AI_FUNCTION_NAMES)[number];

export const SENTIMENT_LABELS = ["positive", "neutral", "negative"] as const;

export interface AiCall {
  fn: AiFunctionName;
  /** the question the text comes from — a code, variable name or id */
  sourceRef: string;
  /** ai_classify only: the categories the answer must come from, in order */
  categories?: string[];
}

/*
 * The grammar is deliberately tiny and matched by a regular expression rather
 * than by the calc parser: the point of the rule above is that these
 * expressions have exactly one shape, and a regex that accepts exactly that
 * shape is the rule made executable.
 */
const CALL = /^\s*(ai_classify|ai_sentiment)\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:,\s*"([^"]*)"\s*)?\)\s*$/;

/** Parse an expression that is entirely one AI call, or return null. */
export function parseAiCall(expression: string | undefined | null): AiCall | null {
  if (!expression) return null;
  const m = CALL.exec(expression);
  if (!m) return null;
  const fn = m[1] as AiFunctionName;
  const sourceRef = m[2];
  if (fn === "ai_classify") {
    const categories = (m[3] ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    return { fn, sourceRef, categories };
  }
  return { fn, sourceRef };
}

/** Does this expression need the server? */
export function isServerResolvedExpression(expression: string | undefined | null): boolean {
  return parseAiCall(expression) !== null;
}

/** Does this expression MENTION an AI function anywhere — including nested, which lint refuses? */
export function mentionsAiFunction(expression: string | undefined | null): boolean {
  return !!expression && /\bai_(classify|sentiment)\s*\(/.test(expression);
}

export interface ServerResolvedQuestion {
  question: Question;
  call: AiCall;
  /** the source question, resolved by code, variable name or id */
  source: Question | null;
}

/** Every calculated question the server must evaluate, with its call parsed. */
export function serverResolvedQuestions(def: SurveyDefinition): ServerResolvedQuestion[] {
  const out: ServerResolvedQuestion[] = [];
  for (const q of def.questions) {
    if (q.type !== "calculated") continue;
    const call = parseAiCall(q.settings.expression);
    if (!call) continue;
    out.push({ question: q, call, source: findByRef(def, call.sourceRef) });
  }
  return out;
}

function findByRef(def: SurveyDefinition, ref: string): Question | null {
  return def.questions.find((q) => q.code === ref || q.variableName === ref || q.id === ref) ?? null;
}

/**
 * Problems a programmer can fix, in words. Run from the calculations lint so
 * they appear where the other calculation problems do.
 */
export function lintAiCalls(def: SurveyDefinition): string[] {
  const problems: string[] = [];
  for (const q of def.questions) {
    if (q.type !== "calculated" || !q.settings.expression) continue;
    const expr = q.settings.expression;
    const call = parseAiCall(expr);
    if (!call) {
      if (mentionsAiFunction(expr)) {
        problems.push(
          `${q.code}: an AI function must be the whole expression. Put ai_…(…) in its own calculated question and reference that question here.`,
        );
      }
      continue;
    }
    const src = findByRef(def, call.sourceRef);
    if (!src) {
      problems.push(`${q.code}: ${call.fn}() reads ${call.sourceRef}, which is not a question in this survey.`);
    } else if (!["open_text", "long_text", "text_list"].includes(src.type)) {
      problems.push(`${q.code}: ${call.fn}() reads ${src.code}, which is ${src.type}, not an open end. AI functions classify text.`);
    }
    if (call.fn === "ai_classify") {
      if (!call.categories || call.categories.length < 2) {
        problems.push(`${q.code}: ai_classify needs at least two categories, separated by |, e.g. ai_classify(${call.sourceRef}, "Price|Quality|Other").`);
      } else {
        const dup = call.categories.find((c, i) => call.categories!.indexOf(c) !== i);
        if (dup) problems.push(`${q.code}: ai_classify lists “${dup}” twice.`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------- pure provider pieces */

/**
 * Match a model's label to the programmer's list — VERBATIM first, then
 * case-insensitive, else nothing. A label the analyst did not define is worse
 * than a blank cell, so this never returns a near-miss or invents an Other.
 */
export function pickCategory(label: unknown, categories: string[]): string | null {
  if (typeof label !== "string") return null;
  return categories.find((c) => c === label)
    ?? categories.find((c) => c.toLowerCase() === label.trim().toLowerCase())
    ?? null;
}

/** Normalise a model's sentiment label to one of the three, else null. */
export function pickSentiment(label: unknown): string | null {
  const l = typeof label === "string" ? label.trim().toLowerCase() : "";
  return (SENTIMENT_LABELS as readonly string[]).includes(l) ? l : null;
}

/**
 * THE FAKE PROVIDER — deterministic, keyless, and honest about being fake.
 *
 * Selected only by the explicit env value `AI_API_URL=fake:`; never a silent
 * fallback. It exists so the browser suite can prove the whole path — Studio
 * expression → resolution before the page turns → variable in display logic →
 * export — and so a developer can watch the feature work locally. The
 * category whose own words appear in the text wins; ties go to the earlier
 * category; nothing matching falls to the LAST category, which by convention
 * is the programmer's "Other".
 */
export function fakeClassify(text: string, categories: string[]): string | null {
  if (!categories.length) return null;
  const t = text.toLowerCase();
  let best: { c: string; score: number } | null = null;
  for (const c of categories) {
    const words = c.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const score = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? categories[categories.length - 1];
}

const FAKE_POS = ["good", "great", "love", "excellent", "happy", "easy", "fast", "helpful", "recommend", "satisfied"];
const FAKE_NEG = ["bad", "poor", "hate", "terrible", "slow", "expensive", "difficult", "broken", "disappointed", "worst", "never"];
export function fakeSentiment(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  const p = FAKE_POS.filter((w) => t.includes(w)).length, n = FAKE_NEG.filter((w) => t.includes(w)).length;
  return p > n ? "positive" : n > p ? "negative" : "neutral";
}
