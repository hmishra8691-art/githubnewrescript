import type { Condition, Question, SurveyDefinition } from "@rescript/schema";
import { stripHtmlText } from "./html.js";
import { contentWords, placedOrder, resolveQuestionRef, stemWord, type TargetContext } from "./nlTargets.js";
import { conceptWords, resolveConcept, resolvePopulation, wordFamily, wordingOf, type ConceptMatch } from "./nlSemantics.js";
import { parseLogicExpression } from "./logicExpression.js";
import { inferRole, measurementOf } from "./analysisFramework.js";

/**
 * DATA QUESTIONS (Research Engine audit, Phase 4).
 *
 * "Which groups prefer Brand A?", "what share of women chose Alpha?", "what
 * is the average satisfaction by region?", "does satisfaction differ by
 * gender?", "which brand is most considered?" — questions about the DATA,
 * not the survey. The engine has no data, so it does not answer them; it
 * reads them into a structured query — the variable, the option, the cut,
 * the population — that the analytics layer answers on the dataset, in the
 * Studio, with the numbers and the test. What this reads it reads exactly:
 * a word that could be two questions is a choice, a word that is none is a
 * refusal with the reason; nothing is guessed.
 */
export type DataQueryKind = "share" | "count" | "mean" | "compare" | "prefer" | "top";

export interface DataQuery {
  kind: DataQueryKind;
  /** the variable asked about */
  variable: string;
  /** its question's code, for the words */
  question: string;
  /** an option of that question, for share / count / prefer */
  option?: { code: string; label: string };
  /** the cut(s): the variable(s) to break the answer down by — `prefer` uses every demographic when none is named */
  by?: string[];
  /** the respondents the question is about */
  population?: { condition: Condition; expression: string; words: string };
  /** the question in the engine's words: "the share of Q6 “Alpha” among Q1 (GENDER) = “Female”" */
  words: string;
}

export type DataQuestionOutcome =
  | { ok: true; query: DataQuery; detected: { what: string; value: string }[] }
  | { ok: false; reason: string; ambiguous?: { phrase: string; candidates: Question[]; why: string } }
  | null;

const plain = (s: string | undefined, n = 60): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const code = (q: Question) => String(q.code);
const clean = (s: string) => s.trim().replace(/[?!.]+$/, "").replace(/^["“'‘]+|["”'’]+$/g, "").trim();
const NOT_DATA = new Set(["html", "custom_component", "media_timeline"]);
const asked = (def: SurveyDefinition): Question[] => { const order = placedOrder(def); return def.questions.filter((q) => !NOT_DATA.has(q.type) && order.includes(q.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); };

/* ------------------------------------------------------------ pieces */

/** "… by gender", "… among women", "… for respondents under 25", "… in Q6" peeled off the end, in any order */
function tail(def: SurveyDefinition, text: string): { core: string; by?: string; pop?: string; ref?: string } {
  let core = text;
  let by: string | undefined, pop: string | undefined, ref: string | undefined;
  for (let i = 0; i < 3; i++) {
    let m: RegExpExecArray | null;
    // the population first: "… by region among women" ends in the population, and the cut is what is left
    if (!pop && (m = /^(.+?)\s+(?:among|amongst|within|for)\s+(?:the\s+)?((?:respondents?|people|customers?|users?|those|men|women|males?|females?|anyone|everyone|participants?)\b.*|[^,]+?)$/i.exec(core)) && resolvePopulation(def, m[2]) !== null) { core = m[1]; pop = clean(m[2]); continue; }
    if (!by && (m = /^(.+?)\s+(?:by|across|per|broken\s+down\s+by|split\s+by)\s+([^,]+?)$/i.exec(core)) && !/\b(?:than|differ|vary|different)\b/i.test(m[2])) { core = m[1]; by = clean(m[2]); continue; }
    if (!ref && (m = /^(.+?)\s+(?:in|on|at|for|to)\s+(?:question\s+)?([A-Za-z]{1,4}\d+[A-Za-z0-9_]*|[A-Z][A-Z0-9_]{2,})$/.exec(core)) && resolveQuestionRef(def, m[2]).ok) { core = m[1]; ref = m[2]; continue; }
    break;
  }
  return { core: core.trim(), ...(by ? { by } : {}), ...(pop ? { pop } : {}), ...(ref ? { ref } : {}) };
}

const optionWords = (label: string) => contentWords(label).map(stemWord);
/** the questions with an option whose label carries every word of the phrase */
function optionsNamed(def: SurveyDefinition, phrase: string): { question: Question; option: { code: string; label: string } }[] {
  const want = optionWords(phrase);
  if (!want.length) return [];
  const out: { question: Question; option: { code: string; label: string } }[] = [];
  for (const q of asked(def)) {
    for (const o of q.options ?? []) {
      const have = new Set(optionWords(o.label));
      if (want.every((w) => have.has(w))) { out.push({ question: q, option: { code: String(o.code), label: o.label } }); break; }
    }
  }
  return out;
}

/** how many of the verb's family the question's wording carries: "consider" → "Brands considered" */
const verbHits = (q: Question, verb: string | undefined): number => {
  if (!verb) return 0;
  // the verb's own words (not re-stemmed: "preferred" stems to "preferr", which no family carries) with their families; a wording stem matches when one is a prefix of the other
  const raw = verb.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !/^(?:are|is|was|were|be|been|the|of|to|do|does|did|have|has|had|would|most|more|likely)$/.test(w));
  const fams = raw.map((w) => new Set([stemWord(w), ...wordFamily(w)]));
  const have = [...new Set(contentWords(wordingOf(q)))];
  const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  return fams.filter((f) => [...f].some((x) => have.some((h) => near(x, h)))).length;
};

/** the question an option phrase belongs to — one, or the ones that fit equally (ambiguous), or none */
function optionTarget(def: SurveyDefinition, phrase: string, verb: string | undefined, ref: string | undefined): { ok: true; question: Question; option: { code: string; label: string } } | { ok: false; reason: string; ambiguous?: { phrase: string; candidates: Question[]; why: string } } {
  let hits = optionsNamed(def, phrase);
  if (ref) {
    const r = resolveQuestionRef(def, ref);
    if (r.ok) hits = hits.filter((h) => h.question.id === r.question.id);
    if (!hits.length) return { ok: false, reason: `${ref} has no option “${phrase}”.` };
  }
  if (!hits.length) return { ok: false, reason: `No question has an option “${phrase}” — name the option as the survey words it, or the question (“in Q6”).` };
  if (hits.length === 1) return { ok: true, ...hits[0] };
  const scored = hits.map((h) => ({ h, s: verbHits(h.question, verb) }));
  const top = Math.max(...scored.map((x) => x.s));
  const best = scored.filter((x) => x.s === top);
  if (best.length === 1) return { ok: true, ...best[0].h };
  return { ok: false, reason: `“${phrase}” is an option of ${best.map((x) => `${code(x.h.question)} (${plain(x.h.question.text, 40)})`).join(" and ")}.`, ambiguous: { phrase, candidates: best.map((x) => x.h.question), why: `“${phrase}” is an option of each` } };
}

function concept(def: SurveyDefinition, phrase: string, ctx: TargetContext): { ok: true; question: Question } | { ok: false; reason: string; ambiguous?: { phrase: string; candidates: Question[]; why: string } } {
  const c = resolveConcept(def, phrase, ctx);
  if (c.ok) return { ok: true, question: c.question };
  if (c.ambiguous) return { ok: false, reason: c.reason, ambiguous: { phrase, candidates: c.candidates.map((m: ConceptMatch) => m.question), why: c.reason } };
  return { ok: false, reason: c.reason };
}

function population(def: SurveyDefinition, phrase: string): { ok: true; population: DataQuery["population"] } | { ok: false; reason: string; ambiguous?: { phrase: string; candidates: Question[]; why: string } } {
  const p = resolvePopulation(def, phrase);
  if (!p) return { ok: false, reason: `“${phrase}” is not a population this survey can select — say it as a question's answer (“women”, “respondents under 25”, “those who chose Alpha”).` };
  if (!p.ok) return { ok: false, reason: p.reason, ...(p.alternatives?.length ? { ambiguous: { phrase, candidates: p.alternatives.map((x) => x.question), why: p.reason } } : {}) };
  const parsed = parseLogicExpression(def, p.population.expression);
  if (!parsed.condition) return { ok: false, reason: `The population “${phrase}” reads as ${p.population.expression}, which does not parse: ${parsed.errors[0]?.message ?? "unknown error"}.` };
  return { ok: true, population: { condition: parsed.condition, expression: p.population.expression, words: p.population.words } };
}

const isNumeric = (q: Question) => { const m = measurementOf(q); return m === "interval" || m === "ratio" || m === "ordinal"; };
const isCategorical = (q: Question) => { const m = measurementOf(q); return m === "nominal" || m === "multi" || m === "ordinal"; };

/* ------------------------------------------------------------ the reading */

const PREFER_VERB = String.raw`(prefer|prefers|choose|chooses|chose|pick|picks|select|selects|consider|considers|buy|buys|use|uses|like|likes|recommend|recommends|know|are\s+aware\s+of|is\s+aware\s+of|be\s+aware\s+of|intend\s+to\s+buy|intends\s+to\s+buy|would\s+buy|would\s+choose|would\s+recommend|own|owns|have\s+switched|has\s+switched|switched)`;
const GROUPS = String.raw`(?:(?:demographic|consumer|customer|respondent|user|key|main)\s+)?(?:groups?|segments?|respondents?|people|demographics?|audiences?|customers?|subgroups?|types\s+of\s+(?:respondents?|people|customers?))`;

/** Read a sentence as a data question; null when it is not one. */
export function parseDataQuestion(def: SurveyDefinition, text: string, ctx: TargetContext = {}): DataQuestionOutcome {
  const t = clean(text);
  let m: RegExpExecArray | null;
  const det = (what: string, value: string) => ({ what, value });

  /* which groups prefer Brand A — the option, by every demographic */
  if ((m = new RegExp(String.raw`^(?:which|what)\s+${GROUPS}\s+(?:are\s+(?:the\s+)?(?:most|more)\s+likely\s+to\s+|most\s+(?:often\s+)?|tend\s+to\s+|mostly\s+)?${PREFER_VERB}\s+(.+)$`, "i").exec(t))
    || (m = new RegExp(String.raw`^who\s+(?:is\s+(?:the\s+)?(?:most|more)\s+likely\s+to\s+|mostly\s+|tends?\s+to\s+)?${PREFER_VERB}\s+(.+)$`, "i").exec(t))) {
    const verb = m[1];
    const parts = tail(def, m[2]);
    const o = optionTarget(def, parts.core, verb, parts.ref);
    if (!o.ok) return o;
    const pop = parts.pop ? population(def, parts.pop) : undefined;
    if (pop && !pop.ok) return pop;
    const by = parts.by ? concept(def, parts.by, ctx) : undefined;
    if (by && !by.ok) return by;
    const query: DataQuery = { kind: "prefer", variable: o.question.variableName, question: code(o.question), option: o.option, ...(by && by.ok ? { by: [by.question.variableName] } : {}), ...(pop && pop.ok ? { population: pop.population } : {}),
      words: `which groups ${verb.toLowerCase().replace(/^be\s+aware/, "are aware")} “${o.option.label}” (${code(o.question)})${by && by.ok ? ` — by ${by.question.variableName}` : " — by every demographic"}${pop && pop.ok ? ` among ${pop.population!.words}` : ""}` };
    return { ok: true, query, detected: [det("question", code(o.question)), det("option", o.option.label), ...(by && by.ok ? [det("by", by.question.variableName)] : []), ...(pop && pop.ok ? [det("population", pop.population!.words)] : [])] };
  }

  /* what share / how many chose X */
  if ((m = new RegExp(String.raw`^(?:(what|which)\s+(?:share|percentage|percent|proportion|fraction|%)\s+(?:of\s+(?:the\s+)?(.+?)\s+)?|(how\s+many)\s+(?:(?:of\s+(?:the\s+)?)?(.+?)\s+)?)(?:have\s+|has\s+|had\s+)?(?:${PREFER_VERB}|(said|answered|gave|rated|mentioned|are|is|were|was))\s+(.+)$`, "i").exec(t))) {
    const kind: DataQueryKind = m[3] ? "count" : "share";
    const who = (m[2] ?? m[4] ?? "").trim();
    const parts = tail(def, m[7]);
    // "of women", "of respondents under 25" — the population; "of respondents", "of them" — everyone
    const whoPop = who && !/^(?:respondents?|people|sample|them|customers?|users?|participants?|answers?|those\s+asked)$/i.test(who) ? who : "";
    const pop = parts.pop ? population(def, parts.pop) : whoPop ? population(def, whoPop) : undefined;
    if (pop && !pop.ok) return pop;
    const by = parts.by ? concept(def, parts.by, ctx) : undefined;
    if (by && !by.ok) return by;
    // "how many answered Q6" — the question itself: the count of answers
    const asQ = resolveQuestionRef(def, parts.core);
    if (asQ.ok && (asQ.via === "code" || asQ.via === "variable")) {
      const query: DataQuery = { kind, variable: asQ.question.variableName, question: code(asQ.question), ...(by && by.ok ? { by: [by.question.variableName] } : {}), ...(pop && pop.ok ? { population: pop.population } : {}), words: `${kind === "count" ? "how many" : "what share"} answered ${code(asQ.question)}${pop && pop.ok ? ` among ${pop.population!.words}` : ""}` };
      return { ok: true, query, detected: [det("question", code(asQ.question))] };
    }
    let o = optionTarget(def, parts.core, m[5] ?? m[6], parts.ref);
    if (!o.ok) {
      // "how many have switched brands": the phrase with its verb is a yes/no question whose wording carries every word — its "Yes"
      const phrase = `${(m[5] ?? m[6] ?? "").replace(/^(?:have|has|had)\s+/i, "")} ${parts.core}`.trim();
      const c = resolveConcept(def, phrase, ctx);
      const yes = c.ok ? (c.question.options ?? []).find((x) => /^yes$/i.test(x.label.trim())) : undefined;
      if (c.ok && yes) {
        const have = new Set(contentWords(wordingOf(c.question)));
        const all = conceptWords(phrase).families.every((f) => [...f].some((x) => have.has(x) || [...have].some((h) => h.length >= 4 && x.length >= 4 && (h.startsWith(x) || x.startsWith(h)))));
        if (all) o = { ok: true, question: c.question, option: { code: String(yes.code), label: yes.label } };
      }
    }
    if (!o.ok) return o;
    const query: DataQuery = { kind, variable: o.question.variableName, question: code(o.question), option: o.option, ...(by && by.ok ? { by: [by.question.variableName] } : {}), ...(pop && pop.ok ? { population: pop.population } : {}),
      words: `${kind === "count" ? "how many" : "what share"} chose “${o.option.label}” (${code(o.question)})${by && by.ok ? ` by ${by.question.variableName}` : ""}${pop && pop.ok ? ` among ${pop.population!.words}` : ""}` };
    return { ok: true, query, detected: [det("question", code(o.question)), det("option", o.option.label), ...(by && by.ok ? [det("by", by.question.variableName)] : []), ...(pop && pop.ok ? [det("population", pop.population!.words)] : [])] };
  }

  /* what is the average X [by Y] [among Z] */
  let meanAsk: { word: string; phrase: string; who?: string } | null = null;
  if ((m = /^(?:what(?:'s|\s+is|\s+was)\s+the\s+)?(average|mean|median|typical)\s+(?:score\s+(?:of|on|for)\s+|value\s+of\s+|level\s+of\s+|of\s+)?(.+)$/i.exec(t))) meanAsk = { word: m[1], phrase: m[2] };
  else if ((m = /^how\s+(satisfied|likely|old|happy|often|loyal|confident)\s+(?:are|is|were)\s+(.+?)\s+on\s+average$/i.exec(t))) meanAsk = { word: "average", phrase: m[1], who: m[2] };
  if (meanAsk) {
    const parts = tail(def, meanAsk.phrase);
    const c = concept(def, parts.core, ctx);
    if (!c.ok) return c;
    if (!isNumeric(c.question)) return { ok: false, reason: `${code(c.question)} (“${plain(c.question.text, 40)}”) is ${measurementOf(c.question)} — it has no average. Ask for the share of an answer instead (“what share chose …”).` };
    const who = meanAsk.who && !/^(?:respondents?|people|they|customers?|users?|participants?)$/i.test(meanAsk.who) ? meanAsk.who : "";
    const pop = parts.pop ? population(def, parts.pop) : who ? population(def, who) : undefined;
    if (pop && !pop.ok) return pop;
    const by = parts.by ? concept(def, parts.by, ctx) : undefined;
    if (by && !by.ok) return by;
    const query: DataQuery = { kind: "mean", variable: c.question.variableName, question: code(c.question), ...(by && by.ok ? { by: [by.question.variableName] } : {}), ...(pop && pop.ok ? { population: pop.population } : {}),
      words: `the ${meanAsk.word.toLowerCase() === "median" ? "median" : "average"} of ${c.question.variableName} (${code(c.question)})${by && by.ok ? ` by ${by.question.variableName}` : ""}${pop && pop.ok ? ` among ${pop.population!.words}` : ""}` };
    return { ok: true, query, detected: [det("variable", `${c.question.variableName} (${code(c.question)})`), ...(by && by.ok ? [det("by", by.question.variableName)] : []), ...(pop && pop.ok ? [det("population", pop.population!.words)] : [])] };
  }

  /* does X differ by Y */
  if ((m = /^(?:does|do|is|are)\s+(.+?)\s+(?:differ|vary|change|different|differing|varying|the\s+same|higher|lower)\s+(?:by|across|between|with|among|for|in)\s+(.+)$/i.exec(t))) {
    const parts = tail(def, m[2]);
    const c = concept(def, clean(m[1]), ctx);
    if (!c.ok) return c;
    const by = concept(def, parts.core.replace(/\s+groups?$/i, ""), ctx);
    if (!by.ok) return by;
    if (by.question.id === c.question.id) return { ok: false, reason: `“${m[1]}” and “${parts.core}” both resolve to ${code(c.question)} — a comparison needs the outcome and a different variable to cut it by.` };
    const pop = parts.pop ? population(def, parts.pop) : undefined;
    if (pop && !pop.ok) return pop;
    const query: DataQuery = { kind: "compare", variable: c.question.variableName, question: code(c.question), by: [by.question.variableName], ...(pop && pop.ok ? { population: pop.population } : {}),
      words: `whether ${c.question.variableName} (${code(c.question)}) differs by ${by.question.variableName} (${code(by.question)})${pop && pop.ok ? ` among ${pop.population!.words}` : ""}` };
    return { ok: true, query, detected: [det("variable", `${c.question.variableName} (${code(c.question)})`), det("by", `${by.question.variableName} (${code(by.question)})`), ...(pop && pop.ok ? [det("population", pop.population!.words)] : [])] };
  }

  /* are women more satisfied than men */
  if ((m = /^(?:are|do|is)\s+(.+?)\s+(?:more|less|higher|lower)\s+(?:(?:likely\s+to\s+be\s+)?(\S+(?:\s+\S+)?)\s+)?than\s+(.+)$/i.exec(t))) {
    const a = resolvePopulation(def, clean(m[1])), b = resolvePopulation(def, clean(m[3]));
    if (a?.ok && b?.ok && a.population.question.id === b.population.question.id && m[2]) {
      const c = concept(def, clean(m[2]), ctx);
      if (!c.ok) return c;
      const by = a.population.question;
      const query: DataQuery = { kind: "compare", variable: c.question.variableName, question: code(c.question), by: [by.variableName], words: `whether ${c.question.variableName} (${code(c.question)}) differs between ${a.population.words} and ${b.population.words}` };
      return { ok: true, query, detected: [det("variable", `${c.question.variableName} (${code(c.question)})`), det("by", `${by.variableName} (${code(by)})`), det("groups", `${a.population.words} vs ${b.population.words}`)] };
    }
  }

  /* which brand is most considered / what is the most common answer to Q6 */
  let topAsk: { noun: string; verb: string; rest: string } | null = null;
  if ((m = new RegExp(String.raw`^(?:which|what)\s+(\S+)\s+(?:is|was|gets|got|do\s+people|do\s+respondents)\s+(?:the\s+)?most\s+(?:often\s+|commonly\s+|frequently\s+)?(chosen|selected|preferred|considered|mentioned|common|popular|picked|used|bought|known|recommended|liked)(?:\s+(?:in|for|on|at|to)\s+(.+))?$`, "i").exec(t))) topAsk = { noun: m[1], verb: m[2], rest: m[3] ?? "" };
  else if ((m = /^what(?:'s|\s+is)\s+the\s+most\s+(?:common|popular|frequent|typical)\s+(answer|response|choice|option|brand|reason)(?:\s+(?:to|in|for|on|at)\s+(.+))?$/i.exec(t))) topAsk = { noun: m[1], verb: "common", rest: m[2] ?? "" };
  if (topAsk) {
    const { noun, verb } = topAsk;
    const rest: { core: string; by?: string; pop?: string; ref?: string } = topAsk.rest ? tail(def, topAsk.rest) : { core: "" };
    let q: Question | undefined;
    if (rest.core) { const c = concept(def, rest.core, ctx); if (!c.ok) return c; q = c.question; }
    else {
      // the verb names the question ("most considered" → "Brands considered"), else the noun ("brand")
      const cats = asked(def).filter((qq) => isCategorical(qq) && (qq.options?.length ?? 0) >= 2);
      const byVerb = cats.map((qq) => ({ qq, s: verbHits(qq, verb) })).filter((x) => x.s > 0);
      const top = byVerb.length ? Math.max(...byVerb.map((x) => x.s)) : 0;
      const best = byVerb.filter((x) => x.s === top).map((x) => x.qq);
      if (best.length === 1) q = best[0];
      else if (best.length > 1) return { ok: false, reason: `“most ${verb}” could be ${best.map((x) => `${code(x)} (${plain(x.text, 40)})`).join(" or ")}.`, ambiguous: { phrase: `most ${verb}`, candidates: best, why: `each asks what is ${verb}` } };
      else { const c = concept(def, noun, ctx); if (!c.ok) return { ok: false, reason: `Which question? “${noun}” names nothing the survey asks — say the question (“in Q6”).` }; q = c.question; }
    }
    if (!isCategorical(q)) return { ok: false, reason: `${code(q)} (“${plain(q.text, 40)}”) has no answer categories to count — ask for its average instead.` };
    const pop = rest.pop ? population(def, rest.pop) : undefined;
    if (pop && !pop.ok) return pop;
    const by = rest.by ? concept(def, rest.by, ctx) : undefined;
    if (by && !by.ok) return by;
    const query: DataQuery = { kind: "top", variable: q.variableName, question: code(q), ...(by && by.ok ? { by: [by.question.variableName] } : {}), ...(pop && pop.ok ? { population: pop.population } : {}), words: `the most ${verb} answer to ${code(q)}${by && by.ok ? ` by ${by.question.variableName}` : ""}${pop && pop.ok ? ` among ${pop.population!.words}` : ""}` };
    return { ok: true, query, detected: [det("question", code(q)), ...(by && by.ok ? [det("by", by.question.variableName)] : []), ...(pop && pop.ok ? [det("population", pop.population!.words)] : [])] };
  }
  return null;
}

/** the demographics a `prefer` question is cut by when it names none — the engine's segmentation roles */
export function defaultCuts(def: SurveyDefinition): string[] {
  return asked(def).filter((q) => { const r = inferRole(def, q); const m = measurementOf(q); return (r === "segmentation" || r === "control") && (m === "nominal" || m === "ordinal" || m === "multi"); }).map((q) => q.variableName);
}
