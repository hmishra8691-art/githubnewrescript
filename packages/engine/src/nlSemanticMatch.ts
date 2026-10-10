import type { Question, SurveyDefinition } from "@rescript/schema";
import { conceptWords, resolveConcept, resolvePopulation, wordingOf } from "./nlSemantics.js";
import { contentWords, resolveQuestionRef, type TargetContext } from "./nlTargets.js";
import { standardMeasure } from "./nlIntent.js";
import { stripHtmlText } from "./html.js";

/**
 * THE SEMANTIC TIER OF THE INTENT ENGINE (Research Engine audit, §F ①b;
 * Phase 7).
 *
 * The recognisers in `nlIntent.ts` read a sentence by its shape — "make Q5
 * required", "terminate if Q1 < 18". A researcher says the same thing a
 * hundred ways: "the gender question must be answered", "nobody under 18
 * should continue", "put Q7 before Q3", "kick out anyone under 18". This
 * tier reads those by what they MEAN: a lexicon of the ways each intent is
 * phrased (its cues), the object the sentence names resolved by code,
 * wording, concept or population, and the result written as the CANONICAL
 * sentence the recognisers read — "Make Q2 required", "Terminate if Q1 <
 * 18" — which is then interpreted exactly as if the researcher had typed
 * it, through the same action gate. Nothing here applies an edit.
 *
 * Confidence is what decides: one candidate clearly ahead of the rest is
 * read as that candidate (the card says what it was read as); several that
 * fit become ONE clarifying question with the candidates as choices; an
 * object with no readable intent is asked what should happen to it. "Not
 * understood" is reserved for sentences that name nothing the survey has.
 */

export interface SemanticCandidate {
  /** the intent, for the card ("make required") */
  intent: string;
  /** the canonical sentence the recognisers read */
  text: string;
  /** a short label for a choice chip */
  label: string;
  /** 0–1: the cue's strength × how well the object resolved */
  score: number;
  /** how it was read: "“must be answered” → required; “the gender question” → Q2 by its wording" */
  why: string;
}

export interface SemanticReading {
  /** the sentence with its politeness and preamble removed */
  core: string;
  candidates: SemanticCandidate[];
  /** the objects the sentence named, resolved, for the "what should happen to it" question */
  objects: Question[];
}

/* ------------------------------------------------------------ the preamble */

const PREAMBLE = [
  /^(?:please|kindly|pls|plz)\s+/i,
  /^(?:can|could|would|will|may)\s+(?:you|we|u)\s+(?:please\s+|pls\s+)?/i,
  /^(?:i|we)(?:\s+would|'d|’d)\s+(?:like|love|want)\s+(?:you\s+)?(?:to\s+)?/i,
  /^(?:i|we)\s+(?:want|need|wish)\s+(?:you\s+)?(?:to\s+)?/i,
  /^(?:let'?s|lets)\s+/i,
  /^(?:go\s+ahead\s+and|just|simply|now|next|also|then)\s+/i,
  /^(?:make\s+sure\s+(?:that\s+)?|ensure\s+(?:that\s+)?|see\s+to\s+it\s+that\s+)/i,
  /^(?:is\s+it\s+possible\s+to|would\s+it\s+be\s+possible\s+to|i'?d\s+like\s+to)\s+/i,
];
const TRAILER = [/\s+(?:please|pls|plz|thanks|thank\s+you|thx|ta)\s*$/i, /\s+(?:for\s+me|if\s+you\s+can|if\s+possible|when\s+you\s+can)\s*$/i];

/** "could you please make Q5 required, thanks" → "make Q5 required" */
export function stripPreamble(text: string): string {
  let t = text.trim().replace(/[.!?]+$/, "").trim();
  for (let i = 0; i < 3; i++) for (const re of PREAMBLE) t = t.replace(re, "");
  for (const re of TRAILER) t = t.replace(re, "");
  t = t.replace(/[,.!?]+$/, "").trim();
  return t || text.trim();
}

/* ------------------------------------------------------------ the lexicon */

type Slot = "question" | "questions" | "option" | "condition" | "pair" | "place" | "quoted" | "concept" | "none";
interface Template {
  intent: string;
  /** phrasings of the intent; the first group is the cue's words (removed to leave the object), the strength per pattern */
  cues: { re: RegExp; strength: number }[];
  slot: Slot;
  /** the canonical sentence from the resolved parts */
  canonical: (p: Parts) => string | null;
  /** a sentence is this intent only if it does NOT also say this */
  unless?: RegExp;
}
interface Parts { q?: Question; q2?: Question; qs?: Question[]; code: (q: Question) => string; cond?: string; quoted?: string; rest: string; concept?: string; place?: string; on?: boolean }

const Q = (q: Question) => String(q.code);
/** the question, or the questions, a part names — "Q2, Q3" when several were named */
const names = (p: Parts): string | null => (p.qs && p.qs.length > 1 ? p.qs.map(p.code).join(", ") : p.q ? p.code(p.q) : null);
const ALL = /^(?:everything|all(?:\s+(?:of\s+them|of\s+it|questions|the\s+questions))?|every\s+question|each\s+question|the\s+(?:whole|entire)\s+(?:survey|questionnaire)|all\s+questions)$/i;
const LESS = String.raw`(?:under|below|younger\s+than|less\s+than|lower\s+than|smaller\s+than|beneath|<)`;
const MORE = String.raw`(?:over|above|older\s+than|more\s+than|greater\s+than|higher\s+than|bigger\s+than|exceeds?|>)`;

const TEMPLATES: Template[] = [
  { intent: "make required", slot: "question", cues: [
    { re: /\b(?:must|has\s+to|have\s+to|needs?\s+to|should)\s+be\s+(?:answered|filled(?:\s+in)?|completed|mandatory|required|compulsory)\b/i, strength: 1 },
    { re: /\b(?:can'?t|cannot|can\s+not|shouldn'?t|should\s+not|mustn'?t|must\s+not|not\s+(?:be\s+)?(?:allowed|able)\s+to)\s+(?:be\s+)?(?:(?:able|allowed|permitted)\s+to\s+)?(?:skip(?:ped)?|leave\s+(?:it\s+|them\s+)?(?:blank|empty|out)|miss(?:ed)?|bypass)\b/i, strength: 1 },
    { re: /\b(?:compulsory|mandatory|obligatory|required|a\s+must|non-?optional|not\s+optional)\b/i, strength: 0.8 },
    { re: /\b(?:force|oblige|compel)\s+(?:an?\s+)?(?:answer|response)\b/i, strength: 0.9 },
  ], unless: /\b(?:optional|not\s+required|doesn'?t|don'?t|needn'?t|no\s+need|if|when|unless|only)\b/i, canonical: (p) => { const n = names(p); return n ? `Make ${n} required` : null; } },
  { intent: "make optional", slot: "question", cues: [
    { re: /\b(?:optional|voluntary|skippable|not\s+(?:required|mandatory|compulsory)|non-?mandatory|can\s+be\s+(?:skipped|left\s+(?:blank|empty))|may\s+(?:be\s+)?skip(?:ped)?|(?:don'?t|doesn'?t|do\s+not|does\s+not|need\s+not|needn'?t)\s+(?:need\s+to\s+|have\s+to\s+)?(?:answer|be\s+answered|be\s+filled|be\s+completed))\b/i, strength: 1 },
  ], canonical: (p) => { const n = names(p); return n ? `Make ${n} optional` : null; } },
  { intent: "delete", slot: "question", cues: [
    { re: /\b(?:get\s+rid\s+of|take\s+out|take\s+away|throw\s+(?:out|away)|scrap|bin|axe|cut|kill|eliminate|drop|discard|remove|delete|erase|strip\s+out|do\s+away\s+with|lose)\b/i, strength: 0.9 },
    { re: /\b(?:we\s+)?(?:don'?t|do\s+not)\s+(?:need|want)\b/i, strength: 0.8 },
    { re: /\b(?:is|are)\s+(?:not\s+needed|unnecessary|redundant|surplus|pointless)\b/i, strength: 0.8 },
  ], unless: /\b(?:option|choice|answer|logic|skip|page\s+break|translation|from)\b/i, canonical: (p) => { const n = names(p); return n ? `Delete ${n}` : null; } },
  { intent: "randomize options", slot: "question", cues: [
    { re: /\b(?:randomi[sz]e|shuffle|rotate|scramble|mix\s+up|jumble|random(?:i[sz]ed)?\s+order|in\s+(?:a\s+)?random\s+order)\b/i, strength: 1 },
  ], canonical: (p) => { const n = names(p); return n ? `Randomize the options of ${n}` : null; } },
  { intent: "own page", slot: "question", cues: [
    { re: /\b(?:on\s+(?:its|their|a)\s+own\s+page|(?:on|onto)\s+a\s+(?:separate|new|fresh)\s+(?:page|screen)|by\s+itself|alone\s+on\s+(?:a|the)\s+(?:page|screen)|page\s+break\s+before)\b/i, strength: 1 },
  ], canonical: (p) => (p.q ? `Put ${p.code(p.q)} on its own page` : null) },
  { intent: "move before", slot: "pair", cues: [
    { re: /\b(?:before|ahead\s+of|in\s+front\s+of|above|earlier\s+than|prior\s+to)\b/i, strength: 0.9 },
  ], unless: /\b(?:if|when|unless|only)\b/i, canonical: (p) => (p.q && p.q2 ? `Move ${p.code(p.q)} before ${p.code(p.q2)}` : null) },
  { intent: "move after", slot: "pair", cues: [
    { re: /\b(?:after|behind|below|later\s+than|following|underneath|beneath)\b/i, strength: 0.9 },
  ], unless: /\b(?:if|when|unless|only|page\s+break)\b/i, canonical: (p) => (p.q && p.q2 ? `Move ${p.code(p.q)} after ${p.code(p.q2)}` : null) },
  { intent: "duplicate", slot: "question", cues: [
    { re: /\b(?:duplicate|clone|copy|replicate|another\s+(?:one\s+)?(?:like|of)|a\s+second\s+copy\s+of)\b/i, strength: 1 },
  ], unless: /\b(?:option|to\s+(?:a\s+)?(?:block|page)|paste|translation)\b/i, canonical: (p) => (p.q ? `Duplicate ${p.code(p.q)}` : null) },
  { intent: "terminate", slot: "condition", cues: [
    { re: /\b(?:kick\s+out|screen\s+out|throw\s+out|disqualify|exclude|reject|terminate|end\s+the\s+survey\s+for|stop\s+the\s+survey\s+for|bounce|turn\s+away|not\s+(?:be\s+)?(?:eligible|allowed\s+(?:in|through))|(?:should(?:n'?t| not)|must\s+not|can'?t|cannot)\s+(?:continue|proceed|go\s+(?:on|further|any\s+further)|take\s+(?:part|the\s+survey)|carry\s+on|be\s+allowed\s+to\s+continue)|is\s+not\s+(?:eligible|qualified)|do\s+not\s+qualify|doesn'?t\s+qualify|don'?t\s+qualify)\b/i, strength: 1 },
    { re: /\b(?:nobody|no\s+one|none)\b.*\b(?:should|can|may|gets?\s+to|is\s+allowed\s+to|are\s+allowed\s+to)\s+(?:continue|proceed|go\s+on|take\s+part|carry\s+on|be\s+in|qualify)\b/i, strength: 1 },
  ], unless: /\b(?:exclude|remove|delete|drop|take\s+out)\s+(?:the\s+|this\s+|that\s+)?\S+(?:\s+\S+)?\s+(?:question|block|page|option)\b/i, canonical: (p) => (p.cond ? `Terminate if ${p.cond}` : null) },
  { intent: "show only if", slot: "condition", cues: [
    { re: /\b(?:only\s+(?:show|ask|display|appear|visible|see|present)|(?:show|ask|display|present)\s+.*\bonly\b|only\s+(?:to|for|when|if)\b|(?:appears?|shown|asked|visible|displayed)\s+(?:only\s+)?(?:when|if|to|for)\b|relevant\s+only|restrict\s+.*\bto\b)/i, strength: 0.9 },
  ], unless: /\b(?:terminate|screen\s+out|option|randomi|translat)\b/i, canonical: (p) => (p.q && p.cond ? `Show ${p.code(p.q)} only if ${p.cond}` : null) },
  { intent: "hide if", slot: "condition", cues: [
    { re: /\b(?:hide|skip|suppress|don'?t\s+(?:show|ask|display)|do\s+not\s+(?:show|ask|display)|not\s+(?:shown|asked|displayed)|leave\s+out|omit)\b/i, strength: 0.9 },
  ], unless: /\b(?:terminate|screen\s+out|option|only|page\s+break|skip\s+to)\b/i, canonical: (p) => (p.q && p.cond ? `Hide ${p.code(p.q)} if ${p.cond}` : null) },
  { intent: "add option", slot: "option", cues: [
    { re: /\b(?:add|include|insert|append|put|introduce|offer|give|allow|need|needs|want|wants|missing|lacks|should\s+have|also\s+have)\b.*\b(?:option|choice|answer|category|alternative|response|box|value|level)\b/i, strength: 0.9 },
    { re: /\b(?:option|choice|answer|category|alternative|response)\b.*\b(?:add|include|insert|append|missing|needed|wanted)\b/i, strength: 0.8 },
    { re: /\b(?:add|include|insert|append|put)\s+["“'‘][^"”'’]+["”'’]\s+(?:to|in|into|on|under)\b/i, strength: 0.9 },
  ], unless: /\b(?:remove|delete|drop|randomi|other\s+\(?please\s+specify|text\s+box)\b/i, canonical: (p) => (p.q && p.quoted ? `Add option ${JSON.stringify(p.quoted)} to ${p.code(p.q)}` : null) },
  { intent: "remove option", slot: "option", cues: [
    { re: /\b(?:remove|delete|drop|take\s+out|get\s+rid\s+of|scrap|lose|kill|cut)\b.*\b(?:option|choice|answer|category|alternative|response|value|level)\b/i, strength: 0.9 },
    { re: /\b(?:option|choice|answer|category|alternative|response)\b.*\b(?:remove|delete|drop|go(?:es)?|unnecessary|not\s+needed)\b/i, strength: 0.8 },
  ], canonical: (p) => (p.q && p.quoted ? `Remove option ${JSON.stringify(p.quoted)} from ${p.code(p.q)}` : null) },
  { intent: "crosstab", slot: "pair", cues: [
    { re: /\b(?:cross-?tab(?:ulat(?:e|ion))?\s+(?:of\s+)?|(?:down|out)\s+by|broken\s+(?:down|out)\s+by|split\s+(?:up\s+)?by|cut\s+by|banner(?:ed)?\s+by|tabulated?\s+(?:by|against)|against|versus|vs\.?)\b/i, strength: 0.9 },
    { re: /\b(?:by|across)\b/i, strength: 0.6 },
  ], unless: /\b(?:test|significan|t-?test|anova|chi|correlat|regress|move|before|after|page|option|if|when|terminate)\b/i, canonical: (p) => (p.q && p.q2 ? `Plan a crosstab of ${p.q.variableName} by ${p.q2.variableName}` : null) },
  { intent: "test difference", slot: "pair", cues: [
    { re: /\b(?:test|significan(?:t|ce)|t-?test|anova|chi-?square|correlat(?:e|ion)|differ(?:s|ence)?|vary|varies|related\s+to|relationship|associated|depend(?:s|ent)\s+on|compare[sd]?(?=.*\b(?:between|across|by|versus|vs|among)\b)|comparison\s+of)\b/i, strength: 0.9 },
  ], unless: /\b(?:crosstab|cross-?tab|banner|logic|move|option|terminate|translat|plan\s+the\s+analysis)\b/i, canonical: (p) => (p.q && p.q2 ? `Test whether ${p.q.variableName} differs by ${p.q2.variableName}` : null) },
  { intent: "what depends", slot: "question", cues: [
    { re: /\b(?:what\s+(?:breaks|happens|changes|goes\s+wrong|would\s+break)|what\s+(?:depends|relies|is\s+based|hangs)\s+on|(?:is|are)\s+(?:used|referenced|read)\s+(?:by|anywhere|elsewhere)|impact\s+of|consequences\s+of|if\s+.*\b(?:goes|is\s+removed|is\s+deleted|gets\s+deleted|were\s+deleted|disappears)\b|affects?\s+what|who\s+uses)\b/i, strength: 1 },
  ], canonical: (p) => (p.q ? `What depends on ${p.code(p.q)}?` : null) },
  { intent: "objective", slot: "quoted", cues: [
    { re: /\b(?:objective|goal|aim|purpose)\s+(?:of\s+(?:the|this)\s+(?:study|survey|research)\s+)?(?:is|should\s+be|:)\b/i, strength: 1 },
    { re: /\b(?:the\s+study|this\s+survey|the\s+research|this\s+research|the\s+survey)\s+(?:is\s+about|aims?\s+to|wants?\s+to|sets?\s+out\s+to|is\s+meant\s+to|is\s+designed\s+to|exists\s+to)\b/i, strength: 0.9 },
  ], unless: /^(?:hide|show|make|set|mark|delete|remove|drop|add|create|insert|move|put|randomi[sz]e|terminate|skip|rename|change|translate|ask|plan|test)\b/i, canonical: (p) => (p.quoted ? `Set the research objective to ${JSON.stringify(p.quoted)}` : null) },
  { intent: "hypothesis", slot: "quoted", cues: [
    { re: /\b(?:hypothesi[sz]e|hypothesis|we\s+(?:expect|think|believe|assume|suspect|predict|anticipate)|my\s+(?:guess|hunch|bet)\s+is|i\s+(?:expect|think|believe|suspect|predict))\b/i, strength: 1 },
  ], unless: /\b(?:test|crosstab|delete|remove|which|what|how\s+many)\b/i, canonical: (p) => (p.quoted ? `Add hypothesis: ${p.quoted}` : null) },
  { intent: "measure concept", slot: "concept", cues: [
    { re: /\b(?:measure|capture|gauge|assess|ask\s+about|a\s+question\s+(?:on|about|for)|cover|track|find\s+out\s+(?:about\s+)?(?:their|the|how)|we\s+(?:need|want|should)\s+(?:to\s+know|a\s+question\s+on|something\s+on))\b/i, strength: 0.9 },
  ], unless: /\b(?:crosstab|test|by|against|delete|remove|option)\b/i, canonical: (p) => (p.concept && standardMeasure(p.concept) ? `Add a question to measure ${p.concept}` : null) },
];

/* ------------------------------------------------------------ the parts */

const FILLER = /\b(?:the|a|an|this|that|these|those|my|our|your|its|their|respondents?|people|users?|anyone|anybody|everyone|everybody|someone|nobody|no\s+one|question|questions|item|q|break|split|cut|compare|show|see|give|tabulate|run|do|is|are|was|were|want|need|let|me|us|put|move|place|test|check|whether|if|please|can|could|we|i|you|it|them|to|of|for|in|on|at|by|with|from|add|include|insert|append|remove|delete|drop|option|options|choice|choices|answer|answers|category|categories)\b/gi;

/** the object phrase: the sentence without the cue, without filler, without a trailing condition */
function objectPhrase(core: string, cue: RegExp): string {
  return core.replace(cue, " ").replace(/\b(?:if|when|unless|where|whenever|for|to|of|from|in|on|at|so|that|then|also|too|now|as\s+well)\b\s*$/i, "").replace(/\s+/g, " ").trim().replace(/^[,:\-–—\s]+|[,:\-–—\s]+$/g, "");
}

/** a question from a phrase: by code or variable (typos included), by its wording, by the concept it measures */
export function fuzzyQuestion(def: SurveyDefinition, phrase: string, ctx: TargetContext): { q: Question; why: string; sure: boolean; /** the others that fit as well, when the phrase is ambiguous */ alternatives?: Question[] } | null {
  // a code or variable anywhere in the phrase names the question outright ("see if Q2 goes", "the AGE one")
  for (const w of phrase.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
    const q = def.questions.find((x) => String(x.code).toLowerCase() === w.toLowerCase() || x.variableName.toLowerCase() === w.toLowerCase());
    if (q && (/\d/.test(w) || w.length >= 3)) return { q, why: `named as ${w}`, sure: true };
  }
  const p = phrase.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (!p) return null;
  const direct = resolveQuestionRef(def, p, ctx);
  if (direct.ok) return { q: direct.question, why: direct.via === "selection" ? "the selected question" : direct.via === "text" ? `“${p}” is in its wording` : `named as ${direct.via === "code" ? String(direct.question.code) : direct.question.variableName}`, sure: true };
  if (!direct.ok && direct.candidates.length === 1 && !direct.ambiguous) { const q = def.questions.find((x) => x.id === direct.candidates[0].id); if (q) return { q, why: `“${p}” read as ${String(q.code)}`, sure: false }; }
  if (!direct.ok && direct.ambiguous && direct.candidates.length >= 2) { const qs = direct.candidates.map((c) => def.questions.find((x) => x.id === c.id)).filter((x): x is Question => !!x); if (qs.length >= 2) return { q: qs[0], why: `“${p}” fits ${qs.map((x) => String(x.code)).join(" or ")}`, sure: false, alternatives: qs.slice(1) }; }
  const concept = resolveConcept(def, p, ctx);
  /* a wording match counts only when the wording carries EVERY word of the phrase — "car colour" is not the car-brand question because it says "car" */
  const { families } = conceptWords(p);
  const full = (q: Question) => { const have = new Set(contentWords(wordingOf(q))); return families.every((f) => [...f].some((x) => have.has(x))); };
  if (concept.ok && (concept.via !== "wording" || full(concept.question))) return { q: concept.question, why: `“${p}” → ${String(concept.question.code)} (${concept.why})`, sure: concept.via !== "wording" || concept.alternatives.length === 0 };
  if (!concept.ok && concept.ambiguous && concept.candidates.length >= 2) { const qs = concept.candidates.map((c) => c.question).filter((q) => full(q)); if (qs.length >= 2) return { q: qs[0], why: `“${p}” fits ${qs.map((x) => String(x.code)).join(" or ")}`, sure: false, alternatives: qs.slice(1) }; if (qs.length === 1) return { q: qs[0], why: `“${p}” → ${String(qs[0].code)}`, sure: false }; }
  // a population in words names the question it is read from ("women", "under 25")
  const pop = resolvePopulation(def, p);
  if (pop && pop.ok) return { q: pop.population.question, why: `“${p}” → ${String(pop.population.question.code)} (${pop.population.words})`, sure: !pop.population.alternatives?.length };
  // a code or variable with a typo inside a longer phrase ("gendr")
  for (const w of p.split(/\s+/)) {
    if (w.length < 3) continue;
    const r = resolveQuestionRef(def, w, ctx);
    if (r.ok && r.via !== "text") return { q: r.question, why: `“${w}” read as ${String(r.question.code)}`, sure: true };
    if (!r.ok && r.candidates.length === 1 && w.length >= 4 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) { const q = def.questions.find((x) => x.id === r.candidates[0].id); if (q && near(w.toUpperCase(), [String(q.code).toUpperCase(), q.variableName.toUpperCase()])) return { q, why: `“${w}” read as ${String(q.code)} (a typo of ${q.variableName})`, sure: false }; }
  }
  return null;
}
/** every question a phrase names by code or variable, in the order named */
export function namedQuestions(def: SurveyDefinition, phrase: string): Question[] {
  const out: Question[] = [];
  for (const w of phrase.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
    const q = def.questions.find((x) => String(x.code).toLowerCase() === w.toLowerCase() || x.variableName.toLowerCase() === w.toLowerCase());
    if (q && (/\d/.test(w) || w.length >= 3) && !out.includes(q)) out.push(q);
  }
  return out;
}
/** one edit away, for a name of four letters or more */
function near(w: string, names: string[]): boolean {
  return names.some((n) => { if (Math.abs(n.length - w.length) > 1) return false; let i = 0, j = 0, d = 0; while (i < w.length && j < n.length) { if (w[i] === n[j]) { i++; j++; continue; } d++; if (d > 1) return false; if (w.length > n.length) i++; else if (n.length > w.length) j++; else { i++; j++; } } return d + (w.length - i) + (n.length - j) <= 1; });
}

/**
 * A condition in words → the form the logic parser reads: "age is under 18"
 * → "AGE < 18", "anyone under 18" → the first numeric question compared,
 * "gender is female" → "GENDER = Female", "they said no to Q4" → "Q4 = No".
 * A condition already in that form passes through.
 */
export function conditionInWords(def: SurveyDefinition, text: string, ctx: TargetContext): string | null {
  let t = text.trim().replace(/^(?:if|when|unless|where|whenever|for|to)\s+/i, "").replace(/^(?:anyone|anybody|everyone|everybody|someone|somebody|people|respondents?|those|nobody|no\s+one|all|any|the\s+ones?|participants?)\s+(?:who\s+)?(?:(?:is|are|was|were)\s+)?/i, "").replace(/^(?:who|that)\s+/i, "").replace(/^(?:is|are|was|were|'s|'re)\s+/i, "").trim();
  if (!t) return null;
  if (/[<>=!]/.test(t)) return t;
  let m: RegExpExecArray | null;
  const num = String.raw`(\d+(?:\.\d+)?)`;
  const qOf = (phrase: string): Question | null => fuzzyQuestion(def, phrase, ctx)?.q ?? null;
  const numericQ = (): Question | null => def.questions.find((q) => q.type === "numeric" && /\b(?:age|old|year)\b/i.test(`${q.variableName} ${stripHtmlText(q.text)}`)) ?? def.questions.find((q) => q.type === "numeric") ?? null;
  const at = (q: Question) => q.variableName;
  // "<X> is under 18" / "under 18" / "younger than 18"
  if ((m = new RegExp(String.raw`^(?:(.+?)\s+(?:is|are)\s+)?${LESS}\s+${num}(?:\s+years?(?:\s+old)?)?$`, "i").exec(t))) { const q = m[1] ? qOf(m[1]) : numericQ(); return q ? `${at(q)} < ${m[2]}` : null; }
  if ((m = new RegExp(String.raw`^(?:(.+?)\s+(?:is|are)\s+)?${MORE}\s+${num}(?:\s+years?(?:\s+old)?)?$`, "i").exec(t))) { const q = m[1] ? qOf(m[1]) : numericQ(); return q ? `${at(q)} > ${m[2]}` : null; }
  if ((m = new RegExp(String.raw`^(?:(.+?)\s+(?:is|are)\s+)?(?:at\s+least|minimum|min|no\s+less\s+than|\d*\s*or\s+more|not\s+${LESS})\s*${num}`, "i").exec(t))) { const q = m[1] ? qOf(m[1]) : numericQ(); return q ? `${at(q)} >= ${m[2]}` : null; }
  if ((m = new RegExp(String.raw`^(?:(.+?)\s+(?:is|are)\s+)?(?:at\s+most|maximum|max|no\s+more\s+than|up\s+to|not\s+${MORE})\s*${num}`, "i").exec(t))) { const q = m[1] ? qOf(m[1]) : numericQ(); return q ? `${at(q)} <= ${m[2]}` : null; }
  if ((m = new RegExp(String.raw`^${num}\s+(?:or\s+(?:more|older|over|above)|\+|and\s+(?:over|above|older))$`, "i").exec(t))) { const q = numericQ(); return q ? `${at(q)} >= ${m[1]}` : null; }
  if ((m = new RegExp(String.raw`^${num}\s+(?:or\s+(?:less|younger|under|below)|and\s+(?:under|below|younger))$`, "i").exec(t))) { const q = numericQ(); return q ? `${at(q)} <= ${m[1]}` : null; }
  // a compound: each side read on its own, joined as said ("age under 18 or over 65" → "AGE < 18 OR AGE > 65")
  const join = /\s+\b(and|or)\b\s+/i.exec(t);
  if (join && !/^(?:between|from)\b/i.test(t)) {
    const sides = t.split(/\s+\b(?:and|or)\b\s+/i);
    const read = sides.map((x) => conditionInWords(def, x, ctx));
    return read.every((x): x is string => !!x) ? read.join(` ${join[1].toUpperCase()} `) : null;
  }
  // "<X> is not Y" / "<X> isn't Y"
  if ((m = /^(.+?)\s+(?:is\s+not|isn'?t|are\s+not|aren'?t|does\s+not\s+equal|!=|<>|is\s+other\s+than|is\s+anything\s+but)\s+(.+)$/i.exec(t))) { const q = qOf(m[1]); return q ? `${at(q)} != ${value(q, m[2])}` : null; }
  // "<X> is Y" / "<X> = Y" / "<X> equals Y" / "they said Y to X" / "answered Y at X"
  if ((m = /^(.+?)\s+(?:is|are|equals?|was|were|=|says?|said|selected|chose|picked|answered|answers)\s+(.+)$/i.exec(t))) { const q = qOf(m[1]); if (q) return `${at(q)} = ${value(q, m[2])}`; }
  if ((m = /^(?:they\s+|someone\s+|respondents?\s+)?(?:said|say|answered|answers|selected|chose|picked|ticked|choose)\s+(.+?)\s+(?:to|at|on|in|for)\s+(.+)$/i.exec(t))) { const q = qOf(m[2]); if (q) return `${at(q)} = ${value(q, m[1])}`; }
  // a population in words the semantics layer knows ("women", "Brand A users")
  const pop = resolvePopulation(def, t);
  if (pop && pop.ok && pop.population.expression) return pop.population.expression;
  // a bare "female" / "male": the question whose option it is
  const opt = optionOwner(def, t);
  if (opt) return `${at(opt.q)} = ${JSON.stringify(opt.label)}`;
  return null;
}
/** an option label as the logic reads it: quoted when it is a label, bare when it is a number */
function value(q: Question, raw: string): string {
  const v = raw.trim().replace(/^["“'‘]|["”'’]$/g, "").replace(/\s+(?:years?(?:\s+old)?)$/i, "");
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return v;
  const o = (q.options ?? []).find((x) => stripHtmlText(x.label).toLowerCase() === v.toLowerCase()) ?? (q.options ?? []).find((x) => stripHtmlText(x.label).toLowerCase().startsWith(v.toLowerCase()));
  return JSON.stringify(o ? stripHtmlText(o.label) : v);
}
function optionOwner(def: SurveyDefinition, word: string): { q: Question; label: string } | null {
  const w = word.toLowerCase().trim();
  for (const q of def.questions) for (const o of q.options ?? []) { const l = stripHtmlText(o.label); if (l.toLowerCase() === w) return { q, label: l }; }
  return null;
}

/* ------------------------------------------------------------ the reading */

const quotedIn = (s: string): string | undefined => /["“]([^"”]+)["”]/.exec(s)?.[1] ?? /['‘]([^'’]{2,})['’]/.exec(s)?.[1];

/** every reading of a sentence this tier can give, best first */
export function semanticReading(def: SurveyDefinition, text: string, ctx: TargetContext = {}): SemanticReading {
  const core = stripPreamble(text);
  const candidates: SemanticCandidate[] = [];
  const objects: Question[] = [];
  const seen = new Set<string>();
  const add = (c: SemanticCandidate) => { const k = c.text.toLowerCase(); if (seen.has(k)) { const i = candidates.findIndex((x) => x.text.toLowerCase() === k); if (candidates[i].score < c.score) candidates[i] = c; return; } seen.add(k); candidates.push(c); };
  for (const tpl of TEMPLATES) {
    if (tpl.unless?.test(core)) continue;
    for (const cue of tpl.cues) {
      const m = cue.re.exec(core);
      if (!m) continue;
      const rest = objectPhrase(core, cue.re);
      const parts: Parts = { code: Q, rest };
      let objScore = 0;
      let why = `“${m[0].trim()}” → ${tpl.intent}`;
      if (tpl.slot === "question") {
        if (ALL.test(rest.trim().replace(/^(?:make|set|mark|turn|keep|have|let|leave)\s+/i, ""))) { parts.qs = def.questions.filter((q) => !["html", "custom_component", "media_timeline"].includes(q.type)); if (!parts.qs.length) continue; parts.q = parts.qs[0]; objScore = 1; why += `; “${rest.trim()}” → every question`; }
        else {
          const several = namedQuestions(def, rest);
          if (several.length > 1) { parts.qs = several; parts.q = several[0]; objScore = 1; why += `; ${several.map(Q).join(", ")} named`; }
          else {
            const f = fuzzyQuestion(def, rest, ctx);
            if (!f) continue;
            parts.q = f.q; objScore = f.sure ? 1 : 0.7; why += `; ${f.why}`;
            for (const alt of f.alternatives ?? []) { const t2 = tpl.canonical({ ...parts, q: alt, qs: undefined }); if (t2) add({ intent: tpl.intent, text: t2, label: t2, score: Math.round(cue.strength * 0.6 * 100) / 100, why: `${why} — or ${String(alt.code)}` }); }
            if (f.alternatives?.length) objScore = 0.6;
          }
        }
      } else if (tpl.slot === "pair") {
        /* the two sides are what stands before and after the cue ("Q7 | before | Q3", "satisfaction | down by | gender"); a side the cue leaves empty is split on a joining word */
        const sep = new RegExp(String.raw`\s+(?:${["by", "across", "against", "versus", "vs\\.?", "before", "after", "ahead\\s+of", "in\\s+front\\s+of", "behind", "above", "below", "and", "with", "between", "to"].join("|")})\s+`, "i");
        let sides = [core.slice(0, m.index), core.slice(m.index + m[0].length)].map((x) => objectPhrase(x, /$^/).trim()).filter(Boolean);
        if (sides.length < 2) sides = rest.split(sep).map((x) => x.trim()).filter(Boolean);
        if (sides.length < 2) continue;
        const a = fuzzyQuestion(def, sides[0], ctx), b = fuzzyQuestion(def, sides[sides.length - 1], ctx);
        if (!a || !b || a.q.id === b.q.id) continue;
        parts.q = a.q; parts.q2 = b.q; objScore = a.sure && b.sure ? 1 : 0.7; why += `; ${a.why}; ${b.why}`;
      } else if (tpl.slot === "condition") {
        const condText = /\b(?:if|when|unless|whenever|where|for|to)\s+(.+)$/i.exec(core)?.[1] ?? (tpl.intent === "terminate" ? rest : null);
        const condRaw = tpl.intent === "terminate" ? (/\b(?:if|when|unless|whenever|where)\s+(.+)$/i.exec(core)?.[1] ?? /\b(?:nobody|no\s+one|none)\s+(.+?)\s+(?:should|can|may|gets?|is|are)\b/i.exec(core)?.[1] ?? rest) : condText;
        if (!condRaw) continue;
        const cond = conditionInWords(def, condRaw, ctx);
        if (!cond) continue;
        parts.cond = cond;
        if (tpl.intent !== "terminate") {
          const head = core.replace(/\b(?:if|when|unless|whenever|where)\s+.+$/i, "");
          const f = fuzzyQuestion(def, objectPhrase(head, cue.re), ctx);
          if (!f) continue;
          parts.q = f.q; why += `; ${f.why}`;
          objScore = f.sure ? 1 : 0.7;
        } else objScore = 1;
        why += `; condition “${condRaw.trim()}” → ${cond}`;
      } else if (tpl.slot === "option") {
        const quoted = quotedIn(core);
        const labelled = quoted ?? /\b(?:option|choice|answer|category|alternative|response)\s+(?:called\s+|named\s+|labell?ed\s+|for\s+)?([A-Z][\w'’&/-]*(?:\s+[A-Za-z][\w'’&/-]*){0,3})\b/.exec(core)?.[1] ?? /\b(?:an?\s+)([A-Z][\w'’&/-]*(?:\s+[A-Za-z][\w'’&/-]*){0,3})\s+(?:option|choice|answer|category|alternative|response)\b/.exec(core)?.[1];
        if (!labelled) continue;
        const target = core.replace(quoted ? new RegExp(`["“'‘]${quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["”'’]`) : labelled, " ");
        const f = fuzzyQuestion(def, objectPhrase(target, cue.re).replace(/\b(?:option|choice|answer|category|alternative|response|box|value|level)s?\b/gi, " "), ctx);
        if (!f) continue;
        parts.q = f.q; parts.quoted = labelled.trim(); objScore = f.sure ? 1 : 0.7; why += `; the option “${labelled.trim()}”; ${f.why}`;
        for (const alt of f.alternatives ?? []) { const t2 = tpl.canonical({ ...parts, q: alt }); if (t2) add({ intent: tpl.intent, text: t2, label: t2, score: Math.round(cue.strength * 0.6 * 100) / 100, why: `${why} — or ${String(alt.code)}` }); }
        if (f.alternatives?.length) objScore = 0.6;
      } else if (tpl.slot === "quoted") {
        const after = core.slice((m.index ?? 0) + m[0].length).replace(/^[\s:,-]+/, "").replace(/^(?:that\s+|to\s+)/i, "").trim();
        const body = quotedIn(core) ?? (tpl.intent === "hypothesis" && /\bhypothesis\b/i.test(m[0]) ? after : after);
        if (!body || body.split(/\s+/).length < 2) continue;
        parts.quoted = body.charAt(0).toUpperCase() + body.slice(1);
        objScore = 0.9;
      } else if (tpl.slot === "concept") {
        const concept = rest.replace(/^(?:their|the|our|how|what|whether)\s+/i, "").trim();
        if (!concept || concept.split(/\s+/).length > 6) continue;
        parts.concept = concept; objScore = 0.8;
      }
      const sentence = tpl.canonical(parts);
      if (!sentence) continue;
      add({ intent: tpl.intent, text: sentence, label: sentence, score: Math.round(cue.strength * objScore * 100) / 100, why });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  // the objects named, for a sentence with no readable intent
  const bare = core.replace(FILLER, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length <= 2;
  if (bare) {
    for (const q of def.questions) { const codeRe = new RegExp(`\\b${String(q.code)}\\b|\\b${q.variableName}\\b`, "i"); if (codeRe.test(core) && !objects.includes(q)) objects.push(q); }
    if (!objects.length) { const f = fuzzyQuestion(def, core, ctx); if (f && (f.sure || f.alternatives?.length)) objects.push(f.q, ...(f.alternatives ?? [])); }
  }
  return { core, candidates, objects };
}

/** what a named question can have done to it, when the sentence says nothing readable about it */
export function objectChoices(q: Question): { label: string; text: string }[] {
  const c = String(q.code);
  const out = [{ label: "Make it required", text: `Make ${c} required` }, { label: "Make it optional", text: `Make ${c} optional` }, { label: "Put it on its own page", text: `Put ${c} on its own page` }, { label: "Delete it", text: `Delete ${c}` }, { label: "What depends on it?", text: `What depends on ${c}?` }];
  if (q.options?.length) out.splice(2, 0, { label: "Randomize its options", text: `Randomize the options of ${c}` });
  return out;
}
