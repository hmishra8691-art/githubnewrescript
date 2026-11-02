import type { HypothesisDetail, Question, ResearchConstruct, ResearchDesign, SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import { constructFor, hypothesisConstructs, structuredHypotheses, type StructuredHypothesis } from "./hypotheses.js";
import { stemWord } from "./nlTargets.js";
import { wordFamily } from "./nlSemantics.js";
import { stripHtmlText } from "./html.js";

/**
 * HYPOTHESIS → CONSTRUCTS → QUESTIONS, LINKED IN THE SAME STEP (2026-11-02).
 *
 * ## The problem this closes
 *
 * A hypothesis was recorded as a statement and a reading (`hypotheses.ts`): "Price perception drives switching"
 * → independent "Price perception", dependent "switching". Nothing then made the constructs those sides name, and
 * nothing linked the questions that measure them — so a new hypothesis was "unlinked" until someone added the
 * constructs by hand in the research design and picked their questions one by one. `set_hypothesis` even refused
 * a side naming a construct the design did not have yet. The copilot could pass `constructs[].questions` in
 * `set_research`, but only what the model remembered to list was linked, and a question tagged with a construct
 * (`analysis.construct`) was invisible to the coverage, which reads `constructs[].questionIds` only.
 *
 * ## What happens now
 *
 * `linkHypothesisConstructs(def, …)` runs inside the action that records or restates a hypothesis
 * (`add_hypothesis`, `set_hypothesis`, `set_research`) and on its own as `link_constructs` — so the links are in
 * the same saved change as the hypothesis, never a later step. For each hypothesis:
 *
 *   1. every side of its reading (independent, dependent, mediator, moderator) resolves to a construct of the
 *      design (`constructFor`: the name, else its words as families); a side that names none CREATES one, named
 *      from the side's words, with the side's role and `origin: "hypothesis"` — one per side, never a duplicate;
 *   2. the reading records the construct's name on that side, so the hypothesis now points at it;
 *   3. each construct is matched against the survey's questions — text, code, variable name and row labels —
 *      by word families. CERTAIN (every meaningful word of the construct's name is there; or the question is
 *      already tagged with the construct): linked — `constructs[].questionIds`, the question's
 *      `analysis.construct` when it has none, and the hypothesis label in `analysis.hypotheses`. UNCERTAIN (some
 *      of the words, or a one-word construct that half the questionnaire mentions): listed in the construct's
 *      `review` for a person, never linked;
 *   4. a difference between groups ("women are more satisfied than men") whose group words name the options of
 *      one question records that question and the option codes on each side (`groupOptions`), and links it to a
 *      grouping construct.
 *
 * A question may measure several constructs (many-to-many through `questionIds`); a construct may serve several
 * hypotheses. Running it again changes nothing that is already linked: names are matched before anything is
 * created, links are de-duplicated, and the review list is rebuilt from scratch (minus what a person dismissed).
 */

export interface ConstructLink { construct: string; questionId: string; question: string; why: string }
export interface LinkReport {
  /** constructs created by this pass */
  created: string[];
  /** constructs a hypothesis side resolved to that already existed */
  reused: string[];
  /** links made by this pass (already-existing links are not repeated) */
  linked: ConstructLink[];
  /** uncertain matches left for a person */
  review: ConstructLink[];
  /** per hypothesis: the constructs it now names */
  hypotheses: { label: string; constructs: string[]; groupQuestion?: string }[];
}

type Side = "independent" | "dependent" | "mediator" | "moderator";
const SIDES: Side[] = ["independent", "dependent", "mediator", "moderator"];

/** questions that are shown text or a component, not something answered */
const NOT_MEASURING = new Set(["html", "custom_component", "media_timeline"]);

/* ------------------------------------------------------------ words */

const STOP = new Set(["the", "and", "for", "with", "their", "its", "our", "your", "this", "that", "these", "those", "from", "into", "than", "more", "less", "how", "what", "which", "who", "are", "was", "were", "will", "would", "have", "has", "had", "you", "they", "them", "about", "over", "under", "between", "among", "very", "much", "level", "levels", "degree", "extent", "overall", "general", "total", "score", "scores", "rate", "rating"]);
/** words about WHO, not WHAT: dropped from a construct's required words when anything else remains */
const POPULATION = new Set(["customer", "customers", "respondent", "respondents", "user", "users", "consumer", "consumers", "people", "person", "participant", "participants", "client", "clients", "employee", "employees", "buyer", "buyers", "shopper", "shoppers", "member", "members"]);

const tokens = (s: string): string[] => stripHtmlText(String(s ?? "")).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_]+/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !/^\d+$/.test(w));

/** the meaningful words of a construct's name, as stems */
function constructWords(name: string): string[] {
  const ws = tokens(name).filter((w) => !STOP.has(w));
  const what = ws.filter((w) => !POPULATION.has(w));
  return [...new Set((what.length ? what : ws).map(stemWord))];
}

const commonPrefix = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/** the same word: equal, or sharing a long stem ("prices"/"price", "perceive"/"perception") */
function literalWord(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 4 && commonPrefix(a, b) >= Math.min(5, Math.min(a.length, b.length)));
}
/** the same word, or a word of the same family ("satisfied" / "happy", "buy" / "purchase") */
function sameWord(a: string, b: string): boolean {
  return literalWord(a, b) || wordFamily(a).has(b) || wordFamily(b).has(a);
}

/** everything a question says about what it measures */
function questionWords(q: Question): string[] {
  const parts = [q.text, q.instruction ?? "", q.code, q.variableName, ...(q.rows ?? []).map((r) => r.label), q.analysis?.construct ?? ""];
  return [...new Set(parts.flatMap(tokens).filter((w) => !STOP.has(w)).map(stemWord))];
}


/** "satisfied" → Satisfaction, "switched" → Switching: the noun a construct is named by (also the research planner's) */
const NOUNS: [RegExp, string][] = [[/^satisf/i, "Satisfaction"], [/^switch/i, "Switching"], [/^aware/i, "Awareness"], [/^loyal/i, "Loyalty"], [/^trust/i, "Trust"], [/^recommend/i, "Likelihood to recommend"], [/^(?:purchase|buying)\s+intent|^intent(?:ion)?\s+to\s+(?:buy|purchase)|^likel\w*\s+to\s+(?:buy|purchase)/i, "Purchase intent"], [/^(?:price|value)\s+percept|^value\s+for\s+money/i, "Price perception"], [/^important|^importance/i, "Importance"]];
export function constructName(side: string): string {
  const t = side.trim().replace(/^(?:the|their|our|a|an)\s+/i, "");
  for (const [re, name] of NOUNS) if (re.test(t)) return name;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
/** "Women are more satisfied than men" → the grouping the comparison needs: gender; else the group's words */
export function groupingName(h: Pick<StructuredHypothesis, "group" | "lower" | "independent">): string {
  const g = `${h.group ?? ""} ${h.lower ?? ""}`.toLowerCase();
  if (/\b(?:women|men|female|male)\b/.test(g)) return "Gender";
  if (/\b(?:younger|older|under|over|aged?|\d+s|millennial|gen z|boomer)\b/.test(g)) return "Age group";
  if (/\b(?:north|south|east|west|urban|rural|region|city|london)\b/.test(g)) return "Region";
  if (/\b(?:customers?|users?|buyers?|owners?|non-)\b/.test(g)) return "Customer status";
  return h.independent ?? h.group ?? "Group";
}
/** a side's words as a NEW construct's name — or nothing when they are too short or too long to name one */
function newConstructName(phrase: string): string | null {
  const t = stripHtmlText(phrase).replace(/[.;:,]+$/, "").replace(/\s+/g, " ").trim();
  const ws = tokens(t).filter((w) => !STOP.has(w));
  if (!ws.length || t.split(" ").length > 8 || t.length > 80) return null;
  return constructName(t);
}

/* ------------------------------------------------------------ groups (a difference between groups) */

const GROUP_WORDS: [RegExp, RegExp][] = [
  [/^(?:women|woman|female|females|ladies|lady|girls?)$/, /\b(?:women|woman|female|females|ladies|lady|girls?|f)\b/],
  [/^(?:men|man|male|males|gentlemen|boys?)$/, /\b(?:men|man|male|males|gentlemen|boys?|m)\b/],
];
/** the option codes of `q` whose labels name `group` */
function optionsNaming(q: Question, group: string): (string | number)[] {
  const g = group.trim().toLowerCase();
  if (!g) return [];
  const special = GROUP_WORDS.find(([who]) => who.test(g));
  const gw = constructWords(g);
  return (q.options ?? []).filter((o) => {
    const label = stripHtmlText(o.label).toLowerCase();
    if (special) return special[1].test(label);
    const lw = tokens(label).map(stemWord);
    return gw.length > 0 && gw.every((w) => lw.some((x) => sameWord(w, x)));
  }).map((o) => o.code);
}

/* ------------------------------------------------------------ the pass */

const ROLE_OF: Record<Side, ResearchConstruct["role"]> = { independent: "independent", dependent: "dependent", mediator: "mediator", moderator: "moderator" };
const CHOICE = new Set(["single_select", "dropdown", "multi_select", "multi_dropdown", "image_select"]);

function ensureResearch(def: SurveyDefinition): ResearchDesign {
  return (def.research ??= { hypotheses: [], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] } as ResearchDesign);
}

/** link `q` to construct `c` (and hypothesis `label`); false when it was already linked */
function link(c: ResearchConstruct, q: Question, label: string): boolean {
  const fresh = !c.questionIds.includes(q.id);
  if (fresh) c.questionIds = [...c.questionIds, q.id];
  const a = (q.analysis ??= { primary: [], crosstabBy: [], modeling: [], relatedTo: [], hypotheses: [] } as NonNullable<Question["analysis"]>);
  if (!a.construct) a.construct = c.name;
  const hs = a.hypotheses ?? [];
  if (!hs.includes(label)) a.hypotheses = [...hs, label];
  if (c.review?.length) c.review = c.review.filter((r) => r.questionId !== q.id);
  return fresh;
}

/** how one question relates to one construct: certain, possible, or not at all */
function match(c: ResearchConstruct, q: Question, cw: string[], label: string): { level: "certain" | "possible"; why: string } | null {
  if (c.questionIds.includes(q.id)) return { level: "certain", why: "already linked" };
  const tagged = q.analysis?.construct?.trim().toLowerCase();
  if (tagged && tagged === c.name.trim().toLowerCase()) return { level: "certain", why: `tagged with the construct “${c.name}”` };
  if (!cw.length) return null;
  const qw = questionWords(q);
  const found = cw.filter((w) => qw.some((x) => sameWord(w, x)));
  if (!found.length) return null;
  /* a family is a hint, not evidence: at least one of the construct's own words must be there as itself */
  if (!cw.some((w) => qw.some((x) => literalWord(w, x)))) return null;
  const servesIt = q.analysis?.hypotheses?.includes(label);
  if (found.length === cw.length) return { level: "certain", why: `its wording carries “${c.name}”` };
  if (servesIt) return { level: "certain", why: `tagged with ${label} and its wording carries ${found.length} of the construct's ${cw.length} words` };
  const ratio = found.length / cw.length;
  return ratio >= 0.5 ? { level: "possible", why: `its wording carries ${found.length} of the ${cw.length} words of “${c.name}”` } : null;
}

export interface LinkOptions {
  /** hypothesis indexes to link (default: every hypothesis) */
  hypotheses?: number[];
  now?: string;
  /** how many questions one construct may claim on word evidence alone before every claim becomes a review (default 6) */
  maxCertain?: number;
}

export function linkHypothesisConstructs(def: SurveyDefinition, opts: LinkOptions = {}): LinkReport {
  const report: LinkReport = { created: [], reused: [], linked: [], review: [], hypotheses: [] };
  const r = def.research;
  if (!r?.hypotheses.length) return report;
  const which = (opts.hypotheses ?? r.hypotheses.map((_, i) => i)).filter((i) => i >= 0 && i < r.hypotheses.length);
  const maxCertain = opts.maxCertain ?? 6;
  const measuring = def.questions.filter((q) => !NOT_MEASURING.has(q.type));
  const touchedConstructs = new Set<ResearchConstruct>();

  for (const i of which) {
    const label = hypothesisLabel(i);
    const h: StructuredHypothesis = structuredHypotheses(def)[i];
    const details = [...(r.hypothesisDetails ?? [])];
    while (details.length < r.hypotheses.length) details.push({});
    const detail: HypothesisDetail = { ...details[i] };
    const names: string[] = [];

    /* 1–2: a construct per side, created when the design has none for it */
    for (const side of SIDES) {
      const phrase = h[side];
      if (!phrase) continue;
      let c = constructFor(def, phrase);
      if (c) { if (!report.reused.includes(c.name) && !report.created.includes(c.name)) report.reused.push(c.name); }
      else {
        const name = newConstructName(phrase);
        if (!name) continue;
        c = { name, role: ROLE_OF[side], questionIds: [], origin: "hypothesis" } as ResearchConstruct;
        ensureResearch(def).constructs = [...(def.research!.constructs ?? []), c];
        report.created.push(name);
      }
      /* a construct only ever named as descriptive takes the role this hypothesis gives it */
      if (c.role === "descriptive") c.role = ROLE_OF[side];
      /* the reading names the construct when its own words would not find it again (constructFor) — otherwise the words stay as written */
      if (!detail[side] && constructFor(def, phrase)?.name !== c.name) detail[side] = c.name;
      if (!names.includes(c.name)) names.push(c.name);
      touchedConstructs.add(c);
    }

    /* 4: a difference between groups, at the level of the answer options that define them */
    let groupQuestion: Question | undefined;
    if (h.type === "difference" && h.group) {
      const cands = measuring.filter((q) => CHOICE.has(q.type)).map((q) => ({ q, hi: optionsNaming(q, h.group!), lo: h.lower ? optionsNaming(q, h.lower) : [] }))
        .filter((x) => x.hi.length && (!h.lower || x.lo.length) && !x.hi.some((c) => x.lo.includes(c)));
      if (cands.length === 1) {
        const { q, hi, lo } = cands[0];
        groupQuestion = q;
        detail.groupOptions = { questionId: q.id, higher: hi, lower: lo };
        const gname = groupingName(h).slice(0, 80);
        let gc = constructFor(def, q.analysis?.construct ?? gname) ?? (def.research!.constructs ?? []).find((c) => c.questionIds.includes(q.id) && c.role === "independent");
        if (!gc) {
          gc = { name: gname, role: "independent", questionIds: [], origin: "hypothesis", definition: `The groups of ${q.code}: ${hi.join(", ")}${lo.length ? ` vs ${lo.join(", ")}` : ""}` } as ResearchConstruct;
          def.research!.constructs = [...def.research!.constructs, gc];
          report.created.push(gname);
        }
        if (link(gc, q, label)) report.linked.push({ construct: gc.name, questionId: q.id, question: q.code, why: `its answers define the groups (${h.group}${h.lower ? ` / ${h.lower}` : ""})` });
        if (!names.includes(gc.name)) names.push(gc.name);
        if (!detail.independent) detail.independent = gc.name;
      } else if (cands.length > 1) {
        for (const x of cands) {
          const gname = groupingName(h);
          report.review.push({ construct: gname, questionId: x.q.id, question: x.q.code, why: `its answers name the groups, as ${cands.length - 1} other question${cands.length === 2 ? "'s" : "s'"} do` });
        }
      }
    }
    details[i] = detail;
    r.hypothesisDetails = details;

    /* 3: the questions each construct of this hypothesis is measured by */
    for (const name of names) {
      const c = def.research!.constructs.find((x) => x.name === name)!;
      const cw = constructWords(c.name);
      const dismissed = new Set(c.dismissed ?? []);
      const certain: { q: Question; why: string }[] = [];
      const possible: { q: Question; why: string }[] = [];
      for (const q of measuring) {
        if (q === groupQuestion && c.questionIds.includes(q.id)) continue;
        const m = match(c, q, cw, label);
        if (!m) continue;
        if (m.level === "certain") certain.push({ q, why: m.why });
        else if (!dismissed.has(q.id)) possible.push({ q, why: m.why });
      }
      /* a word half the questionnaire carries ("Satisfaction") is not evidence for any one of them */
      const onWordsAlone = certain.filter((x) => /wording carries/.test(x.why) && !c.questionIds.includes(x.q.id));
      if (onWordsAlone.length > maxCertain) {
        for (const x of onWordsAlone) if (!dismissed.has(x.q.id)) possible.push({ q: x.q, why: `${x.why} — but so do ${onWordsAlone.length - 1} other questions` });
      }
      const sure = onWordsAlone.length > maxCertain ? certain.filter((x) => !onWordsAlone.includes(x)) : certain;
      for (const { q, why } of sure) if (link(c, q, label)) report.linked.push({ construct: c.name, questionId: q.id, question: q.code, why });
      const review = possible.filter((x) => !c.questionIds.includes(x.q.id)).map((x) => ({ questionId: x.q.id, reason: x.why }));
      if (review.length) c.review = review; else delete c.review;
      for (const x of review) report.review.push({ construct: c.name, questionId: x.questionId, question: def.questions.find((q) => q.id === x.questionId)?.code ?? x.questionId, why: x.reason });
    }
    report.hypotheses.push({ label, constructs: names, ...(groupQuestion ? { groupQuestion: groupQuestion.code } : {}) });
  }
  if (report.created.length || report.linked.length || touchedConstructs.size) r.updatedAt = opts.now ?? r.updatedAt;
  return report;
}

/** the report in a sentence, for an action's description and a toast */
export function describeLinks(rep: LinkReport): string {
  const parts: string[] = [];
  if (rep.created.length) parts.push(`construct${rep.created.length === 1 ? "" : "s"} created: ${rep.created.join(", ")}`);
  if (rep.linked.length) parts.push(`${rep.linked.length} question link${rep.linked.length === 1 ? "" : "s"} (${[...new Set(rep.linked.map((l) => `${l.question} → ${l.construct}`))].slice(0, 6).join("; ")}${rep.linked.length > 6 ? "; …" : ""})`);
  if (rep.review.length) parts.push(`${rep.review.length} possible link${rep.review.length === 1 ? "" : "s"} to review`);
  const unmeasured = rep.hypotheses.flatMap((h) => h.constructs);
  if (!parts.length && unmeasured.length) parts.push("constructs and links already in place");
  return parts.join("; ");
}

/** a person's answer to a review entry: link it, or dismiss it for good */
export function resolveConstructReview(def: SurveyDefinition, constructName: string, questionId: string, decision: "link" | "dismiss"): boolean {
  const c = def.research?.constructs.find((x) => x.name === constructName);
  const q = def.questions.find((x) => x.id === questionId);
  if (!c || !q) return false;
  c.review = (c.review ?? []).filter((r) => r.questionId !== questionId);
  if (!c.review.length) delete c.review;
  if (decision === "dismiss") { c.dismissed = [...new Set([...(c.dismissed ?? []), questionId])]; return true; }
  if (!c.questionIds.includes(q.id)) c.questionIds = [...c.questionIds, q.id];
  const a = (q.analysis ??= { primary: [], crosstabBy: [], modeling: [], relatedTo: [], hypotheses: [] } as NonNullable<Question["analysis"]>);
  if (!a.construct) a.construct = c.name;
  /* the hypotheses that name this construct on a side — recorded, or resolved from their words */
  const labels = structuredHypotheses(def).filter((h) => hypothesisConstructs(h).some((x) => x.name === c.name) || h.independent === c.name).map((h) => h.label);
  a.hypotheses = [...new Set([...(a.hypotheses ?? []), ...labels])];
  return true;
}
