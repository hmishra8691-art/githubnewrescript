import type { HypothesisDetail, ResearchConstruct, SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import { stemWord } from "./nlTargets.js";
import { wordFamily } from "./nlSemantics.js";

/**
 * STRUCTURED HYPOTHESES (Research Engine audit, Phase 3).
 *
 * A hypothesis was a string; its direction was regex-read at verdict time
 * and its constructs were linked by name overlap. Now each hypothesis has a
 * READING — type, direction, the construct on each side, the groups of a
 * difference, the effect expected — recorded by the researcher or the
 * copilot (`research.hypothesisDetails[i]`) or, where nothing is recorded,
 * PARSED from the statement here. `structuredHypotheses(def)` merges the two
 * and says which fields were recorded and which parsed, and resolves each
 * side to a construct of the design when one matches.
 *
 * The parser is the one place the words of a hypothesis are read:
 * the analytics verdicts (which side a significant result takes), the
 * coverage (which constructs a hypothesis names) and the dependency graph
 * (Phase 3.2) all read it through here.
 */

export type HypothesisType = NonNullable<HypothesisDetail["type"]>;
export type HypothesisDirectionKind = NonNullable<HypothesisDetail["direction"]>;

export interface ParsedHypothesis {
  type: HypothesisType;
  direction: HypothesisDirectionKind;
  independent?: string;
  dependent?: string;
  moderator?: string;
  mediator?: string;
  /** a difference between groups: the one said to be higher, and the lower one when named */
  group?: string;
  lower?: string;
}

const POSITIVE_VERB = /\b(?:increas(?:e|es|ed|ing)|rais(?:e|es|ed|ing)|driv(?:e|es|ing)|boost(?:s|ed|ing)?|improv(?:e|es|ed|ing)|enhanc(?:e|es|ed|ing)|strengthen(?:s|ed|ing)?|encourag(?:e|es|ed|ing)|promot(?:e|es|ed|ing)|grow(?:s|ing)?|lifts?|positively\s+(?:affects?|influences?|predicts?|relates?|related|associated|correlated)|(?:leads?|contributes?)\s+to\s+(?:more|higher|greater|better|increased)|predicts?\s+(?:more|higher|greater|better))\b/i;
// bare "lower" is a verb only after its subject ("higher prices lower intent"), never as the subject's adjective ("lower prices …", "the lower tier")
const NEGATIVE_VERB = /\b(?:decreas(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|lower(?:s|ed|ing)|(?<=\S\s)(?<!\b(?:the|a|an|with|have|has|had|of|and|or|in|at|to|for)\s)lower(?=\s+\p{L})|hurts?|harm(?:s|ed|ing)?|weaken(?:s|ed|ing)?|discourag(?:e|es|ed|ing)|diminish(?:es|ed|ing)?|suppress(?:es|ed|ing)?|negatively\s+(?:affects?|influences?|predicts?|relates?|related|associated|correlated)|(?:leads?|contributes?)\s+to\s+(?:less|lower|fewer|reduced|decreased)|predicts?\s+(?:less|lower|fewer))\b/iu;
const POSITIVE_ADJ = /\b(?:(?:are|is|be|were|was|being)\s+(?:much\s+|far\s+|significantly\s+)?(?:more|higher|greater|better)|more\s+likely|higher|greater)\b/i;
const NEGATIVE_ADJ = /\b(?:(?:are|is|be|were|was|being)\s+(?:much\s+|far\s+|significantly\s+)?(?:less|lower|fewer|worse)|less\s+likely|lower|fewer)\b/i;
const DIFFERENCE = /\b(?:differ(?:s|ent|ence|ences)?|var(?:y|ies)|affects?|effect\s+of|influences?|impacts?|depends?|related|relationship|associated|association|moderates?|mediates?|correlat\w*|predicts?)\b/i;
const ASSOCIATION = /\b(?:related|relationship|associated|association|correlat\w*|linked|connected)\b/i;
const CAUSAL = /\b(?:increas\w*|rais\w*|driv\w*|boost\w*|improv\w*|enhanc\w*|strengthen\w*|encourag\w*|promot\w*|lifts?|decreas\w*|reduc\w*|lower\w*|hurts?|harm\w*|weaken\w*|discourag\w*|diminish\w*|suppress\w*|affects?|influenc\w*|impacts?|predicts?|causes?|leads?\s+to|contributes?\s+to|determines?|depends?\s+on|results?\s+in)\b/i;
// a subject that is itself the low end ("lower prices", "younger respondents") turns the verb round
const LOW_SUBJECT = /^(?:the\s+)?(?:lower|less|fewer|reduced|decreased|smaller|younger|cheaper|shorter|weaker|poorer)\b/i;
const ARTICLE = /^(?:the|a|an|their|its|our|more|less|higher|lower|greater|fewer|increased|reduced|better|worse)\s+/i;
const clean = (s: string) => s.trim().replace(/^[,;:\s]+|[,;:.\s]+$/g, "").replace(ARTICLE, "").replace(ARTICLE, "").trim();
const cleanGroup = (s: string) => s.trim().replace(/^(?:the|a|an|those|people|respondents)\s+/i, "").replace(/^(?:who\s+are\s+|who\s+)/i, "").replace(/\s+(?:do|does|are|is|did|were|was)$/i, "").trim().toLowerCase();

/**
 * THE READING OF A STATEMENT. Direction as the verdicts always read it
 * (the first verb decides; "A are more X than B" is a difference with A
 * higher; a low-end subject turns the verb round), and now the sides too:
 * "X drives Y" → X independent, Y dependent; "Y depends on X" the other way
 * round; "X mediates the effect of Y on Z" → mediator X; "A are more X than
 * B" → group A, lower B, dependent X.
 */
export function parseHypothesis(text: string): ParsedHypothesis {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (!t) return { type: "descriptive", direction: "none" };
  // mediation and moderation first: they name three things
  const med = /^(.+?)\s+(mediates?|moderates?)\s+(?:the\s+)?(?:effect|relationship|relation|link|association|influence|impact)\s+(?:of|between)\s+(.+?)\s+(?:on|and)\s+(.+)$/i.exec(t);
  if (med) {
    const role = /^mediat/i.test(med[2]) ? "mediator" : "moderator";
    return { type: "causal", direction: "difference", [role]: clean(med[1]), independent: clean(med[3]), dependent: clean(med[4]) };
  }
  // "A are more satisfied than B", "women are happier than men"
  const than = /^(.+?)\s+(?:are|is|were|was|will\s+be|would\s+be|tend\s+to\s+be|feel|score|scores|rate|rates|report|reports)\s+(?:much\s+|far\s+|significantly\s+|slightly\s+|generally\s+)?(more|less|higher|lower|greater|better|worse|fewer|\w+er)\b(.*?)\bthan\s+(.+)$/i.exec(t);
  if (than) {
    const lowWord = /^(?:less|lower|worse|fewer)$/i.test(than[2]);
    const a = cleanGroup(than[1]), b = cleanGroup(than[4]);
    const quality = clean(than[3]) || (/^(?:more|less|higher|lower|greater|fewer)$/i.test(than[2]) ? "" : than[2].toLowerCase());
    return { type: "difference", direction: lowWord ? "negative" : "positive", group: lowWord ? b : a, lower: lowWord ? a : b, ...(quality ? { dependent: quality } : {}) };
  }
  // "X is positively related to Y": an association, before the verbs ("positively related" is also a directional verb phrase)
  const rel = /^(.+?)\s+(?:is|are)\s+(?:(?:positively|negatively|strongly|weakly|closely)\s+)?(?:related|associated|correlated|linked|connected)\s+(?:to|with)\s+(.+)$/i.exec(t);
  if (rel) return { type: "association", direction: /\bnegatively\b/i.test(t) ? "negative" : /\bpositively\b/i.test(t) ? "positive" : "difference", independent: clean(rel[1]), dependent: clean(rel[2]) };
  const at = (re: RegExp) => { const m = re.exec(t); return m ? { i: m.index, len: m[0].length } : null; };
  const pv = at(POSITIVE_VERB), nv = at(NEGATIVE_VERB);
  const verb = pv && (!nv || pv.i <= nv.i) ? { k: "positive" as const, ...pv } : nv ? { k: "negative" as const, ...nv } : null;
  if (verb && verb.i > 0) {
    const subject = t.slice(0, verb.i).trim();
    // the object stops at a second clause ("reduce satisfaction and increase complaints": the first verb decides, its object is the first)
    const object = t.slice(verb.i + verb.len).trim().replace(/\s+(?:and|but|while|whereas)\s+.*$/i, "").replace(/^(?:the\s+)?(?:likelihood|level|degree|amount|rate|chance|probability)\s+of\s+/i, "");
    const direction: HypothesisDirectionKind = LOW_SUBJECT.test(subject) ? (verb.k === "positive" ? "negative" : "positive") : verb.k;
    return { type: "causal", direction, independent: clean(subject), ...(clean(object) ? { dependent: clean(object) } : {}) };
  }
  if (verb) return { type: "causal", direction: verb.k };
  // "satisfaction is higher among women", "intent is lower for first-time buyers"
  const among = /^(.+?)\s+(?:is|are|will\s+be)\s+(?:much\s+|far\s+|significantly\s+)?(higher|lower|greater|more|less|better|worse|stronger|weaker)\s+(?:among|for|in|with|amongst)\s+(.+)$/i.exec(t);
  if (among) {
    const low = /^(?:lower|less|worse|weaker)$/i.test(among[2]);
    return { type: "difference", direction: low ? "negative" : "positive", dependent: clean(among[1]), group: cleanGroup(among[3]), independent: cleanGroup(among[3]) };
  }
  const pa = at(POSITIVE_ADJ), na = at(NEGATIVE_ADJ);
  const adj = pa && (!na || pa.i <= na.i) ? { k: "positive" as const, ...pa } : na ? { k: "negative" as const, ...na } : null;
  if (adj) {
    // "younger respondents are less satisfied": the subject is the group, what follows the comparative is the quality
    const subject = t.slice(0, adj.i).trim();
    const quality = clean(t.slice(adj.i + adj.len).replace(/^\s*(?:likely\s+to\s+)?/i, ""));
    const direction: HypothesisDirectionKind = subject && LOW_SUBJECT.test(subject) ? (adj.k === "positive" ? "negative" : "positive") : adj.k;
    return { type: "difference", direction, ...(subject ? { group: cleanGroup(subject), independent: cleanGroup(subject) } : {}), ...(quality ? { dependent: quality } : {}) };
  }
  // "Y depends on X", "X is related to Y", "X affects Y", "X differs by Y"
  const dep = /^(.+?)\s+depends?\s+(?:on|upon)\s+(.+)$/i.exec(t);
  if (dep) return { type: "causal", direction: "difference", independent: clean(dep[2]), dependent: clean(dep[1]) };
  const eff = /^(.+?)\s+(?:affects?|influences?|impacts?|predicts?|determines?|shapes?|explains?)\s+(.+)$/i.exec(t);
  if (eff) return { type: "causal", direction: "difference", independent: clean(eff[1]), dependent: clean(eff[2]) };
  const by = /^(.+?)\s+(?:differs?|var(?:y|ies))\s+(?:by|between|across|with)\s+(.+)$/i.exec(t);
  if (by) return { type: "difference", direction: "difference", dependent: clean(by[1]), independent: clean(by[2]) };
  if (DIFFERENCE.test(t)) return { type: ASSOCIATION.test(t) ? "association" : CAUSAL.test(t) ? "causal" : "difference", direction: "difference" };
  return { type: "descriptive", direction: "none" };
}

/* ------------------------------------------------------------ the merged reading */

export type HypothesisField = "type" | "direction" | "independent" | "dependent" | "moderator" | "mediator" | "group" | "lower" | "expectedEffect" | "status";
export interface StructuredHypothesis {
  index: number;
  label: string;
  text: string;
  type: HypothesisType;
  direction: HypothesisDirectionKind;
  independent?: string;
  dependent?: string;
  moderator?: string;
  mediator?: string;
  group?: string;
  lower?: string;
  expectedEffect?: HypothesisDetail["expectedEffect"];
  status?: HypothesisDetail["status"];
  note?: string;
  /** where each field came from: recorded by hand or the copilot, or parsed from the statement */
  source: Partial<Record<HypothesisField, "recorded" | "parsed">>;
  /** the design's constructs each side resolves to, by name or by the words of the phrase */
  constructs: { independent?: ResearchConstruct; dependent?: ResearchConstruct; moderator?: ResearchConstruct; mediator?: ResearchConstruct };
}

const words = (s: string) => new Set((s ?? "").toLowerCase().replace(/[_]+/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2).map(stemWord));

/** the construct a phrase names: by its name whole, else every meaningful word of the shorter side carried (as families) by the other */
export function constructFor(def: SurveyDefinition, phrase: string | undefined): ResearchConstruct | undefined {
  if (!phrase) return undefined;
  const cs = def.research?.constructs ?? [];
  const p = phrase.trim().toLowerCase();
  const exact = cs.find((c) => c.name.trim().toLowerCase() === p);
  if (exact) return exact;
  const pw = [...words(phrase)];
  if (!pw.length) return undefined;
  const fams = pw.map(wordFamily);
  const scored = cs.map((c) => {
    const cw = [...words(c.name)];
    if (!cw.length) return { c, s: 0 };
    const cf = cw.map(wordFamily);
    // every word of the construct's name in the phrase, or every word of the phrase in the construct's name
    const nameInPhrase = cf.every((f) => fams.some((g) => [...f].some((x) => g.has(x))));
    const phraseInName = fams.every((g) => cf.some((f) => [...f].some((x) => g.has(x))));
    return { c, s: nameInPhrase ? 2 : phraseInName ? 1 : 0 };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s) ? scored[0].c : undefined;
}

/** every hypothesis of the design with its structured reading: what was recorded, the rest parsed from the words, each side resolved to a construct */
export function structuredHypotheses(def: SurveyDefinition): StructuredHypothesis[] {
  const r = def.research;
  if (!r) return [];
  return r.hypotheses.map((text, index) => {
    const d: HypothesisDetail = r.hypothesisDetails?.[index] ?? {};
    const parsed = parseHypothesis(text);
    const source: StructuredHypothesis["source"] = {};
    const pick = <K extends HypothesisField>(k: K, recorded: StructuredHypothesis[K] | undefined, fromWords: StructuredHypothesis[K] | undefined): StructuredHypothesis[K] | undefined => {
      if (recorded !== undefined && recorded !== null && recorded !== "") { source[k] = "recorded"; return recorded; }
      if (fromWords !== undefined) { source[k] = "parsed"; return fromWords; }
      return undefined;
    };
    const out: StructuredHypothesis = {
      index, label: hypothesisLabel(index), text,
      type: pick("type", d.type, parsed.type)!,
      direction: pick("direction", d.direction, parsed.direction)!,
      source, constructs: {},
    };
    const independent = pick("independent", d.independent, parsed.independent);
    const dependent = pick("dependent", d.dependent, parsed.dependent);
    const moderator = pick("moderator", d.moderator, parsed.moderator);
    const mediator = pick("mediator", d.mediator, parsed.mediator);
    const group = pick("group", d.group, parsed.group);
    const lower = pick("lower", d.lower, parsed.lower);
    const expectedEffect = pick("expectedEffect", d.expectedEffect, undefined);
    const status = pick("status", d.status, undefined);
    if (independent) out.independent = independent;
    if (dependent) out.dependent = dependent;
    if (moderator) out.moderator = moderator;
    if (mediator) out.mediator = mediator;
    if (group) out.group = group;
    if (lower) out.lower = lower;
    if (expectedEffect) out.expectedEffect = expectedEffect;
    if (status) out.status = status;
    if (d.note) out.note = d.note;
    const ci = constructFor(def, independent), cd = constructFor(def, dependent), cm = constructFor(def, moderator), cme = constructFor(def, mediator);
    if (ci) out.constructs.independent = ci;
    if (cd && cd !== ci) out.constructs.dependent = cd;
    if (cm) out.constructs.moderator = cm;
    if (cme) out.constructs.mediator = cme;
    return out;
  });
}

/** the construct names a hypothesis names on any side, resolved — what the coverage and the graph link it to */
export function hypothesisConstructs(h: StructuredHypothesis): ResearchConstruct[] {
  return [h.constructs.independent, h.constructs.dependent, h.constructs.moderator, h.constructs.mediator].filter((c): c is ResearchConstruct => !!c);
}

/** the reading in a line: "causal · positive · Price perception → Switching" */
export function describeHypothesis(h: StructuredHypothesis): string {
  const arrow = h.direction === "positive" ? "→ higher" : h.direction === "negative" ? "→ lower" : h.direction === "difference" ? "↔" : "";
  const sides = h.type === "difference" && h.group ? `${h.group}${h.lower ? ` > ${h.lower}` : " higher"}${h.dependent ? ` on ${h.dependent}` : ""}`
    : h.independent || h.dependent ? `${h.independent ?? "?"} ${arrow || "→"} ${h.dependent ?? "?"}`.replace("→ higher", "↑").replace("→ lower", "↓") : "";
  const extra = [h.moderator ? `moderated by ${h.moderator}` : "", h.mediator ? `via ${h.mediator}` : "", h.expectedEffect ? `${h.expectedEffect} effect` : ""].filter(Boolean).join(", ");
  return [h.type, sides, extra].filter(Boolean).join(" · ");
}
