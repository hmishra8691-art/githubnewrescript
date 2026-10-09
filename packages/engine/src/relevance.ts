import type { Question, SurveyDefinition } from "@rescript/schema";

import { hypothesisCoverage, inferRole } from "./analysisFramework.js";
import { buildDependencyIndex, objectKey, parseObjectKey, type DependencyIndex } from "./dependencyIndex.js";
import { structuredHypotheses, hypothesisConstructs } from "./hypotheses.js";
import { conceptWords, wordingOf } from "./nlSemantics.js";
import { contentWords, placedOrder } from "./nlTargets.js";
import { stripHtmlText } from "./html.js";

/**
 * RESEARCH RELEVANCE (Research Engine audit, Phase 3). Every question
 * scored by what it serves — the hypotheses it measures, the constructs
 * and KPIs it belongs to, the analyses planned on it, the sample it
 * selects, the cuts it provides, the words of the objective it carries —
 * and by what would break without it (logic, quotas, piping, calculations
 * that read it). "Make the questionnaire shorter without losing the
 * important research objectives" is then a removal SET: the questions
 * connected to nothing, lowest first, never one the design or the logic
 * needs, each with its reasons and the impact of removing it.
 */

export type RelevanceTier = "essential" | "supporting" | "unconnected";
export interface QuestionRelevance {
  question: Question;
  score: number;
  tier: RelevanceTier;
  /** why it is kept: "measures H1 through “Price perception”", "selects the sample", "cut: demographic" */
  reasons: string[];
  /** what reads it at run time — removing it would break these */
  readers: string[];
}

const NOT_DATA = new Set(["html", "custom_component", "media_timeline"]);
const RUNTIME_EDGES = new Set(["display", "skip", "validation", "randomization", "carryForward", "listLogic", "listOperation", "mask", "punch", "optionLogic", "piping", "calculation", "quotaCell", "flowCondition", "loopSource", "listFillSource", "listFillGate", "namedExpression"]);

/** every placed data question with its relevance, in flow order */
export function questionRelevance(def: SurveyDefinition, opts: { index?: DependencyIndex } = {}): QuestionRelevance[] {
  const ix = opts.index ?? buildDependencyIndex(def);
  const r = def.research;
  const order = placedOrder(def);
  const qs = def.questions.filter((q) => !NOT_DATA.has(q.type) && order.includes(q.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const hyps = structuredHypotheses(def);
  const constructOf = new Map<string, string[]>();
  for (const c of r?.constructs ?? []) for (const id of c.questionIds) constructOf.set(id, [...(constructOf.get(id) ?? []), c.name]);
  const plan = r?.analysisPlan;
  const planUse = new Map<string, string[]>();
  const note = (v: string, what: string) => planUse.set(v, [...(planUse.get(v) ?? []), what]);
  for (const x of plan?.crosstabs ?? []) for (const v of [...x.rows, ...x.columns]) note(v, `crosstab ${x.rows.join("+")} by ${x.columns.join("+")}`);
  for (const t of plan?.tests ?? []) for (const v of [t.outcome, t.groupBy, t.moderator, t.mediator, ...t.variables].filter((x): x is string => !!x)) note(v, `${t.method.replace(/_/g, " ")}${t.outcome ? ` on ${t.outcome}` : ""}`);
  for (const d of plan?.derived ?? []) for (const v of d.from) note(v, `derived variable ${d.name}`);
  for (const s of plan?.segments ?? []) for (const v of s.by) note(v, `segment “${s.name}”`);
  // the objective and the research questions, as word families
  const goal = conceptWords(`${r?.objective ?? ""} ${(r?.researchQuestions ?? []).join(" ")}`);
  const goalHas = (q: Question) => { const have = new Set(contentWords(wordingOf(q))); return goal.families.filter((f) => [...f].some((x) => have.has(x))).length; };
  return qs.map((q) => {
    const reasons: string[] = [];
    let score = 0;
    let essential = false;
    // hypotheses: tagged, or through a construct on one of its sides
    const mine = constructOf.get(q.id) ?? [];
    for (const h of hyps) {
      const tagged = q.analysis?.hypotheses?.includes(h.label);
      const via = hypothesisConstructs(h).filter((c) => mine.includes(c.name)).map((c) => c.name);
      if (!tagged && !via.length) continue;
      essential = true; score += 4;
      reasons.push(`measures ${h.label}${via.length ? ` through “${via[0]}”` : " (tagged)"}`);
    }
    for (const c of mine) { score += 2; if (!reasons.some((x) => x.includes(`“${c}”`))) reasons.push(`measures the construct “${c}”`); }
    for (const k of r?.kpis ?? []) if (k.variable && k.variable.toLowerCase() === q.variableName.toLowerCase()) { essential = true; score += 4; reasons.push(`KPI “${k.name}”`); }
    const uses = planUse.get(q.variableName) ?? [];
    if (uses.length) { score += 2; reasons.push(`in the analysis plan (${[...new Set(uses)].slice(0, 2).join(", ")}${uses.length > 2 ? ", …" : ""})`); }
    const role = inferRole(def, q);
    const terminates = (q.skipLogic ?? []).some((s) => s.target.kind === "terminate" || s.target.status === "screened");
    if (role === "screening" || terminates) { essential = true; score += 3; reasons.push(terminates ? "selects the sample (it screens out)" : "a screening question"); }
    else if (role === "segmentation") { score += 2; reasons.push("a cut of the results (demographic)"); }
    const g = goalHas(q);
    if (g) { score += Math.min(2, g); reasons.push(`its wording carries the objective's words`); }
    // what reads it at run time
    const readers = [...new Set(ix.usedBy(objectKey("question", q.id)).filter((e) => RUNTIME_EDGES.has(e.kind)).map((e) => { const n = ix.nodes.get(e.from); const { kind } = parseObjectKey(e.from); return `${n?.code ?? e.from}${kind === "question" || kind === "quota" || kind === "calculation" ? "" : ""} — ${e.label.replace(/^.*? — /, "")}`; }))];
    // the tier is what the DESIGN makes of it; being read by logic holds a question back from removal but does not make it relevant
    const tier: RelevanceTier = essential ? "essential" : score > 0 ? "supporting" : "unconnected";
    if (readers.length) score += 1;
    return { question: q, score, tier, reasons, readers };
  });
}

export interface RemovalSet {
  /** the questions to remove, least relevant first */
  remove: QuestionRelevance[];
  /** connected to nothing, but read by logic — removable only with that logic */
  held: QuestionRelevance[];
  /** what stays, and why, for the researcher's reading */
  kept: QuestionRelevance[];
  /** the target the sentence set, when it did: questions, or minutes */
  target?: { questions?: number; minutes?: number };
  /** the target could not be met without touching the essential questions */
  short?: string;
}

/** about how many questions a minute of a questionnaire holds, for "shorten to N minutes" */
export const QUESTIONS_PER_MINUTE = 4;

/**
 * THE REMOVAL SET for "make it shorter": first every unconnected question
 * that nothing reads, lowest score first; then — only when a target asks
 * for more — the supporting questions, lowest first; never an essential
 * one. A question read by logic is held back and listed, so the researcher
 * removes the logic first or keeps the question.
 */
export function removalSet(def: SurveyDefinition, target: { questions?: number; minutes?: number } = {}): RemovalSet {
  const all = questionRelevance(def);
  const byScore = (a: QuestionRelevance, b: QuestionRelevance) => a.score - b.score || placedOrder(def).indexOf(b.question.id) - placedOrder(def).indexOf(a.question.id);
  const free = all.filter((x) => x.tier === "unconnected" && !x.readers.length).sort(byScore);
  const held = all.filter((x) => x.tier === "unconnected" && x.readers.length);
  const remove: QuestionRelevance[] = [...free];
  const want = target.questions ?? (target.minutes ? Math.max(1, Math.round(target.minutes * QUESTIONS_PER_MINUTE)) : undefined);
  let short: string | undefined;
  if (want !== undefined) {
    const supporting = all.filter((x) => x.tier === "supporting" && !x.readers.length).sort(byScore);
    while (all.length - remove.length > want && supporting.length) remove.push(supporting.shift()!);
    if (all.length - remove.length > want) short = `${all.length - remove.length} questions remain after removing every unconnected and supporting one — the rest measure a hypothesis, a KPI or the sample and are not proposed.`;
  }
  const removing = new Set(remove.map((x) => x.question.id));
  return { remove, held, kept: all.filter((x) => !removing.has(x.question.id)), ...(Object.keys(target).length ? { target } : {}), ...(short ? { short } : {}) };
}

/** the relevance report in a line: "8 essential, 3 supporting, 2 unconnected (Q8, Q10)" */
export function relevanceSummary(all: QuestionRelevance[]): string {
  const n = (t: RelevanceTier) => all.filter((x) => x.tier === t);
  const u = n("unconnected");
  return `${n("essential").length} essential, ${n("supporting").length} supporting, ${u.length} unconnected${u.length ? ` (${u.map((x) => x.question.code).join(", ")})` : ""}`;
}

/** what a question's label reads in a relevance list */
export const relevanceLine = (x: QuestionRelevance): string => `${stripHtmlText(x.question.text).replace(/\s+/g, " ").trim().slice(0, 60)} — ${x.reasons.length ? x.reasons.join("; ") : "connected to nothing in the research design"}${x.readers.length ? ` · read by ${x.readers.join(", ")}` : ""}`;



/* ------------------------------------------------------------ coverage of a generated survey (Phase 3) */

export interface CoverageReport {
  /** every hypothesis with its coverage status */
  hypotheses: { label: string; text: string; status: "testable" | "partly" | "unmeasured" | "unlinked" }[];
  /** hypotheses no question measures (unmeasured or unlinked) */
  unmeasured: string[];
  /** data questions connected to no hypothesis, construct, plan item or KPI — screeners and demographics excepted */
  unconnected: Question[];
  ok: boolean;
  summary: string;
}

/**
 * IS A GENERATED SURVEY CONNECTED? Every hypothesis measured (a construct
 * with a question, or a tagged question) and every question serving
 * something — a hypothesis, a construct, the plan, a KPI — or the sample
 * (a screener) or the cuts (a demographic). The generation gate reads it
 * on the clone before the proposal is shown, and asks the model once to
 * connect what is loose.
 */
export function coverageReport(def: SurveyDefinition): CoverageReport {
  const hyps = hypothesisCoverage(def).map((h) => ({ label: h.label, text: h.text, status: h.status }));
  const unmeasured = hyps.filter((h) => h.status === "unmeasured" || h.status === "unlinked").map((h) => h.label);
  const rel = questionRelevance(def);
  // (a demographic is a supporting cut, never unconnected; a screener is essential)
  const unconnected = rel.filter((x) => x.tier === "unconnected").map((x) => x.question);
  const ok = !unmeasured.length && !unconnected.length;
  const summary = ok
    ? `${hyps.length ? `every hypothesis measured (${hyps.map((h) => h.label).join(", ")})` : "no hypotheses"}; every question serves the design or the sample`
    : [unmeasured.length ? `${unmeasured.join(", ")} ${unmeasured.length === 1 ? "has" : "have"} no question that measures ${unmeasured.length === 1 ? "it" : "them"}` : "", unconnected.length ? `${unconnected.map((q) => q.code).join(", ")} ${unconnected.length === 1 ? "serves" : "serve"} no hypothesis, construct, plan item or KPI` : ""].filter(Boolean).join("; ");
  return { hypotheses: hyps, unmeasured, unconnected, ok, summary };
}
