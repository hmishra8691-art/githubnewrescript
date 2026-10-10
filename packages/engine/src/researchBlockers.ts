import type { SurveyDefinition } from "@rescript/schema";
import { hypothesisCoverage, reviewAnalysisPlan } from "./analysisFramework.js";

/**
 * RESEARCH-LEVEL CHECKS AS BLOCKERS (Research Engine audit, §F ⑤; Phase 7).
 *
 * The review has always said when a hypothesis is unmeasured, a planned
 * test reads a variable that is gone, a KPI names no variable, a construct
 * has no question. It said so AFTER the change, in the Review tab. When the
 * researcher asks for the research design to be enforced (`research.strict`),
 * the same gaps are BLOCKERS: a change that opens one is refused at the
 * change, with the gap named and the way to close it; the ones that already
 * exist are listed as blockers in the review until they are closed. The
 * checks are the review's own — one definition of each gap — and nothing
 * here writes.
 */
export type ResearchBlockerCode = "unmeasured_construct" | "unlinked_hypothesis" | "dead_plan_reference" | "dead_derived" | "dead_kpi" | "empty_design";
export interface ResearchBlocker {
  code: ResearchBlockerCode;
  message: string;
  questionIds: string[];
  suggestion?: string;
}

/** is the research design enforced? */
export const researchStrict = (def: SurveyDefinition): boolean => def.research?.strict === true;

/** every research-level gap the design has now — the blockers when the design is enforced, the critical research findings otherwise */
export function researchBlockers(def: SurveyDefinition): ResearchBlocker[] {
  const r = def.research;
  if (!r) return [];
  const out: ResearchBlocker[] = [];
  const live = (ids: string[]) => ids.filter((id) => def.questions.some((q) => q.id === id));
  const codeOf = (id: string) => def.questions.find((q) => q.id === id)?.code;
  // a construct on a hypothesis's side with no question that measures it
  for (const c of r.constructs ?? []) {
    if (c.role !== "independent" && c.role !== "dependent" && c.role !== "mediator" && c.role !== "moderator") continue;
    if (live(c.questionIds).length) continue;
    out.push({ code: "unmeasured_construct", message: `The ${c.role} construct “${c.name}” is measured by no question${c.questionIds.length ? ` — the ${c.questionIds.length === 1 ? "question" : "questions"} that measured it ${c.questionIds.length === 1 ? "is" : "are"} gone` : ""}.`, questionIds: [], suggestion: `Add a question that measures ${c.name}${c.definition ? ` (${c.definition})` : ""}, or remove the construct from the design.` });
  }
  // a hypothesis nothing in the survey tests
  for (const h of hypothesisCoverage(def)) {
    if (h.status === "unlinked") out.push({ code: "unlinked_hypothesis", message: `${h.label} (“${h.text.slice(0, 80)}${h.text.length > 80 ? "…" : ""}”) names no construct and no question is tagged with it, so nothing in the survey tests it.`, questionIds: [], suggestion: `Name its constructs in the research design, or tag the questions that measure it with ${h.label}.` });
    else if (h.status === "unmeasured") out.push({ code: "unmeasured_construct", message: `${h.label} cannot be tested: ${h.constructs.filter((c) => !c.measured).map((c) => `“${c.name}”`).join(", ")} ${h.constructs.filter((c) => !c.measured).length === 1 ? "is" : "are"} measured by no question.`, questionIds: [], suggestion: `Add the question that measures ${h.constructs.filter((c) => !c.measured).map((c) => c.name).join(" and ")}.` });
  }
  // a planned analysis or derived variable reading what is not in the survey (the plan review's critical findings)
  for (const i of reviewAnalysisPlan(def)) {
    if (i.level !== "critical") continue;
    if (/^Derived variable\b/.test(i.message)) out.push({ code: "dead_derived", message: i.message, questionIds: i.questionIds, ...(i.suggestion ? { suggestion: i.suggestion } : {}) });
    else if (/not in the survey|but none is/.test(i.message)) out.push({ code: "dead_plan_reference", message: i.message, questionIds: i.questionIds, ...(i.suggestion ? { suggestion: i.suggestion } : {}) });
  }
  // a KPI whose variable is nowhere: not a question, not a derived variable, not a calculation
  const derived = new Set((r.analysisPlan?.derived ?? []).map((d) => d.name));
  const calcs = new Set((def.calculations ?? []).map((c) => c.targetVariable));
  for (const k of r.kpis ?? []) {
    if (!k.variable) continue;
    if (def.questions.some((q) => q.variableName === k.variable || String(q.code) === k.variable) || derived.has(k.variable) || calcs.has(k.variable)) continue;
    out.push({ code: "dead_kpi", message: `The KPI “${k.name}” is read from ${k.variable}, which is not in the survey.`, questionIds: [], suggestion: `Point the KPI at the variable that measures it, or remove it.` });
  }
  // dedupe by message
  const seen = new Set<string>();
  return out.filter((b) => (seen.has(b.message) ? false : (seen.add(b.message), true))).map((b) => ({ ...b, questionIds: [...new Set(b.questionIds.filter((id) => codeOf(id)))] }));
}

/** the blockers a change would open: in `after` and not in `before` — what an enforced design refuses */
export function newResearchBlockers(before: SurveyDefinition, after: SurveyDefinition): ResearchBlocker[] {
  const had = new Set(researchBlockers(before).map((b) => b.message));
  return researchBlockers(after).filter((b) => !had.has(b.message));
}
