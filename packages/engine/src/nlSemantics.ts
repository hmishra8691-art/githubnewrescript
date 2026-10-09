import type { Option, Question, SurveyDefinition } from "@rescript/schema";
import { inferRole } from "./analysisFramework.js";
import { listBlocks, listPages } from "./blocks.js";
import { stripHtmlText } from "./html.js";
import { contentWords, placedOrder, resolveQuestionRef, stemWord, type TargetContext } from "./nlTargets.js";

/**
 * SEMANTIC OBJECT RESOLUTION (Research Engine audit, Phase 2).
 *
 * `nlTargets` resolves a question by code, variable, selection or the words
 * of its label. A researcher's sentence names things by what they MEAN:
 *
 *   a population   "respondents under 25", "women", "Brand A users",
 *                  "those who switched"           → a question + a condition
 *   a concept      "brand preference", "age"      → the variable that measures it
 *   a role         "the screener", "demographics" → the questions in that role
 *   a scale        "a 5-point scale", "agree–disagree", "1 to 10" → points + anchors
 *
 * Each resolver here is deterministic and reads only the survey (wording,
 * variable names, constructs, analysis tags, roles, option labels). None of
 * them decides an edit; the recognisers in `nlIntent.ts` do, through the same
 * action gate as the model. Every resolver says HOW it resolved (`via`) so the
 * review card can show it, and returns candidates when several things fit so
 * the researcher is asked instead of guessed at.
 */

/* ------------------------------------------------------------ words */

/**
 * Everyday families of the words a researcher uses for a concept — the
 * question that measures "purchase intent" asks "how likely are you to
 * buy". Shared with the `measures` recogniser in nlIntent.
 */
export const CONCEPT_FAMILIES: string[][] = [
  ["purchase", "buy", "bought", "buying", "order", "shop", "shopp"],
  ["intent", "intention", "intend", "likely", "likelihood", "plan", "consider", "probability"],
  ["satisfaction", "satisfied", "satisfi", "happy", "pleased", "content"],
  ["awareness", "aware", "heard", "familiar", "recognise", "recognize", "know"],
  ["loyalty", "loyal", "recommend", "again", "repeat", "nps"],
  ["usage", "use", "used", "using", "consume"],
  ["price", "cost", "expensive", "cheap", "afford", "pay", "spend", "value"],
  ["age", "old", "year", "born"],
  ["gender", "sex", "male", "female"],
  ["income", "earn", "salary", "household"],
  ["trust", "trustworthy", "reliable", "rely"],
  ["preference", "prefer", "favourite", "favorite", "best"],
  ["brand", "make", "label"],
  ["switch", "switched", "switching", "change", "moved", "left"],
  ["region", "area", "where", "live", "location", "state", "country"],
  ["education", "school", "degree", "qualification"],
  ["frequency", "often", "how often", "times"],
];
export const wordFamily = (w: string): Set<string> => {
  const s = stemWord(w);
  const g = CONCEPT_FAMILIES.find((xs) => xs.some((x) => stemWord(x) === s));
  return new Set([s, ...(g ?? []).map(stemWord)]);
};
const CONCEPT_STOP = new Set(["measure", "measur", "capture", "captur", "asses", "assess", "track", "cover", "relat", "relate", "deal", "concept", "thing", "topic", "our", "my", "their", "study", "survey", "respondent", "respondents", "variable", "respond", "level", "overall", "people", "customer"]);

/** the words of a phrase that carry meaning, each with its family */
export function conceptWords(phrase: string): { words: string[]; families: Set<string>[] } {
  const words = contentWords(phrase).filter((w) => !CONCEPT_STOP.has(w));
  return { words, families: words.map(wordFamily) };
}
const plain = (s: string | undefined, n = 80): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const NOT_DATA = new Set(["html", "custom_component", "media_timeline"]);
/** a question's wording for matching: its text, its variable name (split), and its grid rows (what a grid measures) */
export const wordingOf = (q: Question): string => `${q.text} ${q.variableName} ${(q.rows ?? []).map((x) => x.label).join(" ")}`;
const asked = (def: SurveyDefinition): Question[] => { const order = placedOrder(def); return def.questions.filter((q) => !NOT_DATA.has(q.type) && order.includes(q.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); };

/* ------------------------------------------------------------ concepts */

export type ConceptVia = "code" | "variable" | "selection" | "construct" | "tag" | "wording";
export interface ConceptMatch { question: Question; via: ConceptVia; /** how many of the phrase's words it carries (wording tier) */ hits: number; why: string }
export type ConceptResult =
  | { ok: true; question: Question; via: ConceptVia; why: string; /** others that fit less well */ alternatives: ConceptMatch[] }
  | { ok: false; reason: string; candidates: ConceptMatch[]; ambiguous: boolean };

/**
 * The variable a concept names. By code or variable name first ("AGE",
 * "Q7"), then the research design (a construct of that name and the
 * questions that measure it, a question tagged with it), then the wording —
 * all of the phrase's words (as families) before some of them. Several
 * questions fitting equally well at the best tier is `ambiguous`: the
 * recogniser asks which.
 */
export function resolveConcept(def: SurveyDefinition, phrase: string, ctx: TargetContext = {}): ConceptResult {
  const p = phrase.trim().replace(/^(?:the|a|an)\s+/i, "").replace(/\s+(?:question|variable|item|measure)$/i, "").trim();
  const direct = resolveQuestionRef(def, p, ctx);
  if (direct.ok && (direct.via === "code" || direct.via === "variable" || direct.via === "selection" || direct.via === "id")) {
    return { ok: true, question: direct.question, via: direct.via === "id" ? "code" : direct.via, why: direct.via === "selection" ? "the selected question" : `named by its ${direct.via}`, alternatives: [] };
  }
  const { words, families } = conceptWords(p);
  if (!words.length) return { ok: false, reason: `“${phrase}” names nothing the survey measures.`, candidates: [], ambiguous: false };
  const score = (text: string) => { const have = new Set(contentWords(text)); return families.filter((f) => [...f].some((x) => have.has(x))).length; };
  const qs = asked(def);
  const byId = new Map(qs.map((q) => [q.id, q]));
  // tier 0: the research design; tier 1: the wording, ranked by how many of the words it carries
  const tiers: ConceptMatch[][] = [[], []];
  // tier 0: the research design — a construct whose name carries every word, and the questions that measure it; a question tagged with the construct
  for (const c of def.research?.constructs ?? []) {
    if (score(`${c.name} ${c.definition ?? ""}`) < families.length) continue;
    for (const id of c.questionIds) { const q = byId.get(id); if (q) tiers[0].push({ question: q, via: "construct", hits: families.length, why: `measures the construct “${c.name}”` }); }
  }
  for (const q of qs) if (q.analysis?.construct && score(q.analysis.construct) >= families.length && !tiers[0].some((m) => m.question.id === q.id)) tiers[0].push({ question: q, via: "tag", hits: families.length, why: `tagged as measuring “${q.analysis.construct}”` });
  for (const q of qs) {
    if (tiers[0].some((m) => m.question.id === q.id)) continue;
    const s = score(wordingOf(q));
    if (!s) continue;
    const have = new Set(contentWords(wordingOf(q)));
    const carried = [...new Set(families.flatMap((f) => [...f].filter((x) => have.has(x))))];
    tiers[1].push({ question: q, via: "wording", hits: s, why: `its wording mentions ${carried.join(", ")}` });
  }
  const best = tiers.find((t) => t.length);
  if (!best) return { ok: false, reason: `No question measures “${p}” — no construct, analysis tag, variable name or wording matches it.`, candidates: [], ambiguous: false };
  // the question carrying the most of the words wins outright only when it carries more than the next one
  const top = Math.max(...best.map((m) => m.hits));
  const winners = best.filter((m) => m.hits === top);
  const rest = [...best.filter((m) => m.hits !== top), ...tiers.filter((t) => t !== best).flat()];
  if (winners.length === 1) return { ok: true, question: winners[0].question, via: winners[0].via, why: winners[0].why, alternatives: rest };
  return { ok: false, reason: `“${p}” could be ${winners.map((m) => `${m.question.code} (${plain(m.question.text, 50)})`).join(" or ")}.`, candidates: winners, ambiguous: true };
}

/* ------------------------------------------------------------ populations */

export interface PopulationResult {
  /** the question the condition reads */
  question: Question;
  /** the expression, in the logic language, that is true for the population */
  expression: string;
  /** the population in words, as resolved: "Q1 (AGE) under 25" */
  words: string;
  via: "age" | "gender" | "option" | "yes_no";
  /** the question was one of several that fit — the others, for a clarifying choice */
  alternatives?: Question[];
}
export type PopulationOutcome = { ok: true; population: PopulationResult } | { ok: false; reason: string; alternatives?: PopulationResult[] } | null;

const PEOPLE = String.raw`(?:respondents?|people|persons?|participants?|anyone|anybody|everyone|everybody|someone|those|users?|customers?|consumers?|buyers?|shoppers?|individuals?|adults?|subjects?|panel(?:l?ists)?|members?|all|any)`;
const NUM = String.raw`(\d{1,3})`;
const numberWord = (s: string): number | null => { const n = Number(s); return Number.isFinite(n) ? n : null; };

/** an option label read as an age band: "18-24" → [18,24], "Under 18" → [0,17], "65+" / "65 or older" → [65, 200] */
function ageBand(label: string): [number, number] | null {
  const t = label.toLowerCase().replace(/years?(?:\s+old)?|yrs?|y\.o\./g, " ").replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,3})\s*(?:-|–|—|to|through)\s*(\d{1,3})$/.exec(t))) return [Number(m[1]), Number(m[2])];
  if ((m = /^(?:under|below|less than|younger than)\s*(\d{1,3})$/.exec(t))) return [0, Number(m[1]) - 1];
  if ((m = /^(?:up to|at most)\s*(\d{1,3})$/.exec(t))) return [0, Number(m[1])];
  if ((m = /^(\d{1,3})\s*(?:\+|or (?:more|older|over|above)|and (?:over|above|older)|plus)$/.exec(t))) return [Number(m[1]), 200];
  if ((m = /^(?:over|above|older than|more than)\s*(\d{1,3})$/.exec(t))) return [Number(m[1]) + 1, 200];
  return null;
}

/** the age question: numeric, or banded single-select, whose wording or variable says age */
function ageQuestion(def: SurveyDefinition): Question[] {
  const fam = wordFamily("age");
  return asked(def).filter((q) => {
    const words = new Set(contentWords(wordingOf(q)));
    const named = /^(?:AGE|Q?AGE\d*|AGE_?\w*|S?\d*_?AGE)$/i.test(q.variableName) || [...fam].some((x) => words.has(x)) || /\bhow old\b/i.test(stripHtmlText(q.text));
    if (!named) return false;
    if (q.type === "numeric") return true;
    return q.type === "single_select" && (q.options ?? []).some((o) => ageBand(o.label));
  });
}

interface AgeBounds { lo: number | null; hi: number | null; /** the sentence said "over N" / "under N": the bound itself is outside */ loOpen?: boolean; hiOpen?: boolean }
function ageExpression(q: Question, b: AgeBounds): { expression: string; words: string } | string {
  const code = String(q.code);
  // inclusive integer bounds for the bands and the words; the numeric expression keeps the sentence's own comparator
  const lo = b.lo == null ? null : b.loOpen ? b.lo + 1 : b.lo;
  const hi = b.hi == null ? null : b.hiOpen ? b.hi - 1 : b.hi;
  const span = lo != null && hi != null ? `${lo} to ${hi}` : lo != null ? `${lo} and over` : `under ${(hi ?? 0) + 1}`;
  if (q.type === "numeric") {
    const parts = [b.lo != null ? `${code} ${b.loOpen ? ">" : ">="} ${b.lo}` : "", b.hi != null ? `${code} ${b.hiOpen ? "<" : "<="} ${b.hi}` : ""].filter(Boolean);
    return { expression: parts.join(" AND "), words: `${code} (${q.variableName}) ${span}` };
  }
  // banded: every option whose band lies inside the asked range
  const inside = (q.options ?? []).filter((o) => { const b = ageBand(o.label); return !!b && (lo == null || b[0] >= lo) && (hi == null || b[1] <= hi); });
  if (!inside.length) return `${code}'s age bands (${(q.options ?? []).map((o) => o.label).join(", ")}) do not cut at ${span} — no band lies inside it.`;
  // a band straddling the bound cannot be used: say so rather than include or exclude it silently
  const straddle = (q.options ?? []).filter((o) => { const b = ageBand(o.label); return !!b && !inside.includes(o) && ((lo != null && b[0] < lo && b[1] >= lo) || (hi != null && b[1] > hi && b[0] <= hi)); });
  if (straddle.length) return `${code}'s band “${straddle[0].label}” straddles ${span}, so the bands cannot express it exactly — screen on “${inside.map((o) => o.label).join("”, “")}” or change the bands.`;
  return { expression: inside.length === 1 ? `${code} = ${inside[0].code}` : `${code} in [${inside.map((o) => o.code).join(", ")}]`, words: `${code} (${q.variableName}) ${inside.map((o) => `“${o.label}”`).join(", ")}` };
}

/** the normalised form of a label or phrase for whole-word containment: lower case, one space, no punctuation */
const norm = (s: string) => stripHtmlText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** the option whose label the phrase carries whole ("brand a users" carries "Brand A"); the longest such label wins */
function optionCarried(q: Question, phrase: string): Option | null {
  const p = ` ${norm(phrase)} `;
  const hits = ((q.options ?? []) as Option[]).map((o) => ({ o, l: norm(o.label) })).filter((x) => x.l.length >= 2 && p.includes(` ${x.l} `));
  if (!hits.length) return null;
  hits.sort((a, b) => b.l.length - a.l.length);
  return hits[0].o;
}

/**
 * A population phrase → the question and the condition that selects it.
 * Returns null when the phrase is not one (the caller then reads it as a
 * condition in the logic language, or hands the sentence on).
 */
export function resolvePopulation(def: SurveyDefinition, phrase: string): PopulationOutcome {
  const one = resolveOnePopulation(def, phrase);
  if (one) return one;
  // "respondents under 25 and women", "men or anyone over 65": each part a population, the whole is either of them
  const parts = phrase.trim().replace(/[.!?]+$/, "").split(/\s*(?:,|\band\b|\bor\b|\/)\s*/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const each = parts.map((x) => resolveOnePopulation(def, x));
  if (each.some((x) => !x)) return null;
  const bad = each.find((x) => x && !x.ok);
  if (bad && !bad.ok) return bad;
  const pops = each.map((x) => (x as { ok: true; population: PopulationResult }).population);
  const expression = pops.map((p) => (/\s(?:AND|OR)\s/.test(p.expression) ? `(${p.expression})` : p.expression)).join(" OR ");
  return { ok: true, population: { question: pops[0].question, expression, words: pops.map((p) => p.words).join(", or "), via: pops[0].via, ...(pops.some((p) => p.alternatives?.length) ? { alternatives: pops.flatMap((p) => p.alternatives ?? []) } : {}) } };
}

function resolveOnePopulation(def: SurveyDefinition, phrase: string): PopulationOutcome {
  const t = phrase.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  const low = t.toLowerCase();
  let m: RegExpExecArray | null;
  const AGEWORD = String.raw`(?:(?:who|that|which)\s+(?:are|is)\s+|aged?\s+|of\s+age\s+|whose\s+age\s+is\s+)?`;
  const YEARS = String.raw`(?:\s*(?:years?(?:\s+old)?|yrs?|y\.?o\.?|and\s+over|or\s+over|or\s+older|and\s+above|or\s+above|plus|\+))*`;
  const PEOPLE_OPT = String.raw`(?:${PEOPLE}\s+)?`;
  // ages: "respondents under 25", "people aged 18 to 24", "anyone over 65", "those 18+", "under-25s", "adults aged 18–65"
  const ageForms: [RegExp, (g: string[]) => AgeBounds][] = [
    [new RegExp(String.raw`^${PEOPLE_OPT}${AGEWORD}(?:under|below|younger\s+than|less\s+than)\s+${NUM}${YEARS}$`, "i"), (g) => ({ lo: null, hi: numberWord(g[1]), hiOpen: true })],
    [new RegExp(String.raw`^${PEOPLE_OPT}${AGEWORD}(?:over|above|older\s+than|more\s+than)\s+${NUM}${YEARS}$`, "i"), (g) => ({ lo: numberWord(g[1]), hi: null, loOpen: true })],
    [new RegExp(String.raw`^${PEOPLE_OPT}${AGEWORD}(?:at\s+least|minimum|from)\s+${NUM}${YEARS}$`, "i"), (g) => ({ lo: numberWord(g[1]), hi: null })],
    [new RegExp(String.raw`^${PEOPLE_OPT}${AGEWORD}(?:at\s+most|up\s+to|maximum)\s+${NUM}${YEARS}$`, "i"), (g) => ({ lo: null, hi: numberWord(g[1]) })],
    [new RegExp(String.raw`^${PEOPLE_OPT}${AGEWORD}(?:between\s+)?${NUM}\s*(?:-|–|—|to|and|through)\s*${NUM}${YEARS}$`, "i"), (g) => ({ lo: numberWord(g[1]), hi: numberWord(g[2]) })],
    [new RegExp(String.raw`^${PEOPLE_OPT}${AGEWORD}${NUM}\s*(?:\+|or\s+(?:more|older|over|above)|and\s+(?:over|above|older)|plus)$`, "i"), (g) => ({ lo: numberWord(g[1]), hi: null })],
    [new RegExp(String.raw`^(?:under|below)[-\s]?${NUM}s$`, "i"), (g) => ({ lo: null, hi: numberWord(g[1]), hiOpen: true })],
    [new RegExp(String.raw`^(?:over|above)[-\s]?${NUM}s$`, "i"), (g) => ({ lo: numberWord(g[1]), hi: null, loOpen: true })],
  ];
  for (const [re, read] of ageForms) {
    if (!(m = re.exec(t))) continue;
    const b = read([...m]);
    if (b.lo == null && b.hi == null) return null;
    const loI = b.lo == null ? null : b.loOpen ? b.lo + 1 : b.lo;
    const hiI = b.hi == null ? null : b.hiOpen ? b.hi - 1 : b.hi;
    if (loI != null && hiI != null && loI > hiI) return { ok: false, reason: `“${t}” is an empty range — ${loI} is more than ${hiI}.` };
    const qs = ageQuestion(def);
    if (!qs.length) return { ok: false, reason: `“${t}” is an age, and this survey has no question that asks it (a numeric age, or age bands) — add one first, or name the question: “screen out when Q1 < 25”.` };
    const results: PopulationResult[] = [];
    const problems: string[] = [];
    for (const q of qs) { const e = ageExpression(q, b); if (typeof e === "string") problems.push(e); else results.push({ question: q, expression: e.expression, words: e.words, via: "age" }); }
    if (!results.length) return { ok: false, reason: problems[0] };
    if (results.length > 1) return { ok: true, population: { ...results[0], alternatives: results.slice(1).map((x) => x.question) } };
    return { ok: true, population: results[0] };
  }
  // gender: "women", "female respondents", "men", "males", "respondents who are female"
  if ((m = new RegExp(String.raw`^(?:(?:all|any|the)\s+)?(?:${PEOPLE}\s+)?(?:(?:who|that)\s+(?:are|identify\s+as)\s+)?(?:(women|woman|females?|ladies|girls)|(men|man|males?|gentlemen|boys|guys))(?:\s+(?:respondents?|only|participants?|customers?|users?))?$`, "i").exec(t))) {
    const female = !!m[1];
    const genderQs = asked(def).filter((q) => q.type === "single_select" && (/^(?:GENDER|SEX|Q?GEN\d*)$/i.test(q.variableName) || /\b(?:gender|sex)\b/i.test(stripHtmlText(q.text))));
    if (!genderQs.length) return { ok: false, reason: `“${t}” names a gender, and this survey has no gender question — add one, or name the question and option.` };
    const results: PopulationResult[] = [];
    for (const q of genderQs) {
      const opt = (q.options ?? []).find((o) => (female ? /^(?:female|woman|women|f)$/i : /^(?:male|man|men|m)$/i).test(o.label.trim()));
      if (opt) results.push({ question: q, expression: `${q.code} = ${opt.code}`, words: `${q.code} (${q.variableName}) = “${opt.label}”`, via: "gender" });
    }
    if (!results.length) return { ok: false, reason: `${genderQs[0].code} has no option for ${female ? "female" : "male"} (its options are ${(genderQs[0].options ?? []).map((o) => `“${o.label}”`).join(", ")}).` };
    return { ok: true, population: { ...results[0], ...(results.length > 1 ? { alternatives: results.slice(1).map((x) => x.question) } : {}) } };
  }
  // "those who switched", "people who have switched brands", "respondents who said yes to Q5": a yes/no question whose wording carries the verb
  if ((m = new RegExp(String.raw`^(?:${PEOPLE}\s+)?(?:who|that|which)\s+(?:have\s+|has\s+|had\s+|did\s+|do\s+|does\s+)?(.+)$`, "i").exec(t)) && !/\b(?:said|answered|chose|selected|picked|ticked|responded)\b/i.test(m[1])) {
    const { words } = conceptWords(m[1].replace(/\b(?:not|never|n't)\b/g, ""));
    const negated = /\b(?:not|never|n't)\b/i.test(m[1]);
    if (words.length) {
      const fams = words.map(wordFamily);
      const yesNo = asked(def).filter((q) => q.type === "single_select" && (q.options ?? []).some((o) => /^yes$/i.test(o.label.trim())) && (q.options ?? []).some((o) => /^no$/i.test(o.label.trim())));
      const scored = yesNo.map((q) => { const have = new Set(contentWords(wordingOf(q))); return { q, s: fams.filter((f) => [...f].some((x) => have.has(x))).length }; }).filter((x) => x.s === fams.length);
      if (scored.length) {
        const mk = (q: Question): PopulationResult => { const yes = (q.options ?? []).find((o) => /^yes$/i.test(o.label.trim()))!; const no = (q.options ?? []).find((o) => /^no$/i.test(o.label.trim()))!; const o = negated ? no : yes; return { question: q, expression: `${q.code} = ${o.code}`, words: `${q.code} (${q.variableName}) = “${o.label}”`, via: "yes_no" }; };
        return { ok: true, population: { ...mk(scored[0].q), ...(scored.length > 1 ? { alternatives: scored.slice(1).map((x) => x.q) } : {}) } };
      }
    }
  }
  // "Brand A users", "iPhone owners", "those who prefer Brand A", "people who chose Brand B", "those in the North": an option label carried whole by the phrase
  {
    const core = low.replace(new RegExp(String.raw`^(?:${PEOPLE}\s+)?(?:(?:who|that|which)\s+)?`, "i"), "").trim();
    if (core) {
      const hits: { q: Question; o: Option }[] = [];
      for (const q of asked(def)) {
        if (!["single_select", "multi_select", "dropdown"].includes(q.type)) continue;
        const o = optionCarried(q, core);
        if (o) hits.push({ q, o });
      }
      if (hits.length) {
        const longest = Math.max(...hits.map((h) => norm(h.o.label).length));
        const best = hits.filter((h) => norm(h.o.label).length === longest);
        // among questions carrying the same label, the one whose wording shares the phrase's verb ("prefer" → "Which brand do you prefer?")
        const verb = /\b(prefer|use|own|drink|buy|bought|like|choose|chose|switch|shop|visit|watch|drive)\w*/i.exec(core)?.[1];
        const shares = (q: Question) => !!verb && [...wordFamily(verb)].some((x) => new Set(contentWords(wordingOf(q))).has(x));
        const ranked = [...best.filter((h) => shares(h.q)), ...best.filter((h) => !shares(h.q))];
        const mk = (h: { q: Question; o: Option }): PopulationResult => ({ question: h.q, expression: `${h.q.code} = ${h.o.code}`, words: `${h.q.code} (${h.q.variableName}) = “${h.o.label}”`, via: "option" });
        return { ok: true, population: { ...mk(ranked[0]), ...(ranked.length > 1 ? { alternatives: ranked.slice(1).map((h) => h.q) } : {}) } };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------ structural roles */

export type StructuralRole = "screener" | "demographics" | "selection" | "all";
export interface RoleResult { role: StructuralRole; label: string; questions: Question[]; via: string }

/** "the screener", "the demographics section", "this question", "the whole survey" → the questions meant */
export function resolveRole(def: SurveyDefinition, phrase: string, ctx: TargetContext = {}): RoleResult | null {
  const t = phrase.trim().toLowerCase().replace(/[.!?]+$/, "");
  const qs = asked(def);
  if (/^(?:the\s+)?(?:screener|screening|screen[-\s]?out|qualif(?:ication|ier|ying))(?:\s+(?:questions?|section|block|part|page|criteria|logic))?$/.test(t) || /^(?:the\s+)?(?:screening|screener)\s+(?:questions?|section|block)$/.test(t)) {
    const blocks = listBlocks(def.flow as unknown[]);
    const inScreenerBlock = new Set(blocks.filter((b) => /\b(?:screen|qualif|eligib)/i.test(b.title ?? "")).flatMap((b) => b.pages.flatMap((p) => p.node.questionIds)));
    const terminates = (q: Question) => (q.skipLogic ?? []).some((s) => s.target.kind === "terminate" || s.target.status === "screened");
    const byRole = qs.filter((q) => q.analysis?.role === "screening" || inferRole(def, q) === "screening" || terminates(q) || inScreenerBlock.has(q.id));
    if (byRole.length) return { role: "screener", label: "the screener", questions: byRole, via: byRole.some((q) => q.analysis?.role === "screening") ? "questions in the screening role" : byRole.some((q) => inScreenerBlock.has(q.id)) ? "the block named like a screener, and any question that terminates" : "questions that terminate" };
    const first = listPages(def.flow as unknown[])[0];
    const firstQs = first ? first.node.questionIds.map((id) => qs.find((q) => q.id === id)).filter((q): q is Question => !!q) : [];
    if (firstQs.length) return { role: "screener", label: "the screener", questions: firstQs, via: "no question has the screening role — the first page stands in" };
    return null;
  }
  if (/^(?:the\s+)?(?:demographics?|demographic\s+(?:questions?|section|block|profile)|profil(?:e|ing)(?:\s+(?:questions?|section|block))?|classification(?:\s+(?:questions?|section))?|about[-\s]you(?:\s+section)?|background(?:\s+(?:questions?|section))?)$/.test(t)) {
    const byRole = qs.filter((q) => inferRole(def, q) === "segmentation" && q.type !== "open_text" && q.type !== "text");
    if (!byRole.length) return null;
    return { role: "demographics", label: "the demographics", questions: byRole, via: byRole.some((q) => q.analysis?.role === "segmentation") ? "questions in the segmentation role" : "questions whose variable, wording or block says age, gender, region, income, education…" };
  }
  if (/^(?:this|that|the\s+selected|the\s+current|selected|current)(?:\s+(?:question|one|item))?$/.test(t)) {
    const sel = resolveQuestionRef(def, phrase, ctx);
    return sel.ok ? { role: "selection", label: sel.question.code ? `${sel.question.code}` : "this question", questions: [sel.question], via: "the selected question" } : null;
  }
  if (/^(?:the\s+)?(?:whole|entire|full|complete)?\s*(?:survey|questionnaire|study|instrument)$/.test(t) || /^(?:all|every)\s+(?:the\s+)?questions?$/.test(t)) {
    return { role: "all", label: "the whole survey", questions: qs, via: "every question in the flow" };
  }
  // a block by its title ("the brand section")
  const block = listBlocks(def.flow as unknown[]).find((b) => b.title && new RegExp(String.raw`^(?:the\s+)?${b.title.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\s+(?:block|section|questions?))?$`).test(t));
  if (block) {
    const ids = new Set(block.pages.flatMap((p) => p.node.questionIds));
    return { role: "all", label: `block “${block.title}”`, questions: qs.filter((q) => ids.has(q.id)), via: `the block titled “${block.title}”` };
  }
  return null;
}

/* ------------------------------------------------------------ scales */

export type ScaleKind = "agreement" | "satisfaction" | "likelihood" | "importance" | "quality" | "frequency" | "numeric" | "yes_no" | "nps";
export interface ScaleDescription { kind: ScaleKind; points: number; start?: number; labels?: string[]; low?: string; high?: string; /** "5-point agreement scale" */ name: string }

const ANCHORS: Record<Exclude<ScaleKind, "numeric" | "yes_no" | "nps">, { 5: string[]; 7: string[]; low: string; high: string }> = {
  agreement: { 5: ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"], 7: ["Strongly disagree", "Disagree", "Somewhat disagree", "Neither agree nor disagree", "Somewhat agree", "Agree", "Strongly agree"], low: "Strongly disagree", high: "Strongly agree" },
  satisfaction: { 5: ["Very dissatisfied", "Dissatisfied", "Neither satisfied nor dissatisfied", "Satisfied", "Very satisfied"], 7: ["Very dissatisfied", "Dissatisfied", "Somewhat dissatisfied", "Neither satisfied nor dissatisfied", "Somewhat satisfied", "Satisfied", "Very satisfied"], low: "Very dissatisfied", high: "Very satisfied" },
  likelihood: { 5: ["Very unlikely", "Unlikely", "Neither likely nor unlikely", "Likely", "Very likely"], 7: ["Very unlikely", "Unlikely", "Somewhat unlikely", "Neither likely nor unlikely", "Somewhat likely", "Likely", "Very likely"], low: "Very unlikely", high: "Very likely" },
  importance: { 5: ["Not at all important", "Slightly important", "Moderately important", "Very important", "Extremely important"], 7: ["Not at all important", "Low importance", "Slightly important", "Neutral", "Moderately important", "Very important", "Extremely important"], low: "Not at all important", high: "Extremely important" },
  quality: { 5: ["Very poor", "Poor", "Fair", "Good", "Excellent"], 7: ["Very poor", "Poor", "Below average", "Average", "Above average", "Good", "Excellent"], low: "Very poor", high: "Excellent" },
  frequency: { 5: ["Never", "Rarely", "Sometimes", "Often", "Always"], 7: ["Never", "Very rarely", "Rarely", "Sometimes", "Often", "Very often", "Always"], low: "Never", high: "Always" },
};
const WORD_NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 };

/** "a 5-point scale", "7 point agree-disagree scale", "scale of 1 to 10", "likert", "yes/no", "0–10 likelihood to recommend" → points and anchors, or null */
export function parseScale(phrase: string): ScaleDescription | null {
  const t = phrase.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/^(?:an?|the)\s+/, "");
  if (!/\b(?:scale|likert|point|pt|points|yes\s*\/\s*no|yes[-\s]or[-\s]no|nps|net\s+promoter)\b/.test(t) && !/^\d+\s*(?:-|–|to)\s*\d+$/.test(t)) return null;
  const kind: ScaleKind | null = /\bagree|likert|agreement\b/.test(t) ? "agreement" : /satisf/.test(t) ? "satisfaction" : /likel|intent|probab/.test(t) ? "likelihood" : /import/.test(t) ? "importance" : /quality|excellent|poor\b/.test(t) ? "quality" : /frequen|often/.test(t) ? "frequency" : /\bnps\b|net\s+promoter|recommend/.test(t) ? "nps" : /yes\s*\/\s*no|yes[-\s]or[-\s]no|yes\s*-\s*no/.test(t) ? "yes_no" : null;
  if (kind === "yes_no") return { kind, points: 2, labels: ["Yes", "No"], name: "yes/no" };
  let points: number | null = null;
  let start: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven)[\s-]*(?:point|pt|points)\b/.exec(t))) points = WORD_NUMBERS[m[1]] ?? Number(m[1]);
  else if ((m = /(?:from|of)?\s*(\d+)\s*(?:-|–|—|to|through)\s*(\d+)/.exec(t))) { start = Number(m[1]); points = Number(m[2]) - Number(m[1]) + 1; }
  if (kind === "nps") return { kind, points: 11, start: 0, low: "Not at all likely", high: "Extremely likely", name: "0–10 likelihood to recommend (NPS)" };
  if (!points) { if (kind === "agreement" || kind === "satisfaction" || kind === "likelihood" || kind === "importance" || kind === "quality" || kind === "frequency") points = 5; else return null; }
  if (points < 2 || points > 11) return null;
  if (kind) {
    const a = ANCHORS[kind];
    const labels = points === 5 ? a[5] : points === 7 ? a[7] : undefined;
    return { kind, points, ...(start !== undefined ? { start } : {}), ...(labels ? { labels } : { low: a.low, high: a.high }), name: `${points}-point ${kind} scale` };
  }
  // numeric, with the anchors the sentence may carry: "1 = not at all, 10 = extremely"
  const anchors = /(?:where\s+|with\s+|,\s*)?(?:(\d+)\s*(?:=|is|means|being)\s*["“]?([^,"”]+?)["”]?)\s*(?:,|and|to|;)\s*(?:(\d+)\s*(?:=|is|means|being)\s*["“]?([^,"”]+?)["”]?)\s*$/.exec(t);
  const low = anchors ? anchors[2].trim() : undefined;
  const high = anchors ? anchors[4].trim() : undefined;
  const lh = low && high ? (Number(anchors![1]) <= Number(anchors![3]) ? { low, high } : { low: high, high: low }) : {};
  return { kind: "numeric", points, ...(start !== undefined ? { start } : {}), ...lh, name: `${start !== undefined ? `${start}–${start + points - 1}` : `${points}-point`} scale` };
}

/** the options a scale description produces, the way `update_question.scale` builds them — for "already so" checks and previews */
export function scaleLabels(s: ScaleDescription): string[] {
  const start = s.start ?? (s.points === 11 ? 0 : 1);
  return Array.from({ length: s.points }, (_, i) => s.labels?.[i] ?? (i === 0 && s.low ? s.low : i === s.points - 1 && s.high ? s.high : String(start + i)));
}
