import type { SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "@rescript/engine";
import type { DocSummary } from "./research";

/**
 * A DOCUMENT CARD INTO THE RESEARCH MODEL (Research Engine audit, Phase 3).
 * The Research tab summarised each uploaded document into objectives,
 * hypotheses, constructs and scales — and left them there. This turns a
 * card into the actions that record what the design does not have yet:
 * the objective when none is recorded, each hypothesis not already stated,
 * each construct not already named (with its definition), the document as
 * a source. Everything goes through the same gate, review and Apply as any
 * proposal; nothing already in the design is touched.
 */
export interface DocMerge {
  actions: SurveyAction[];
  /** what the actions add, for the button and the proposal's label */
  adds: { objective: boolean; hypotheses: number; constructs: number; source: boolean };
  /** nothing new: every item is in the design already */
  empty: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");

export function mergeDocActions(def: SurveyDefinition, doc: { name: string; summary: DocSummary | null }): DocMerge {
  const s = doc.summary;
  const r = def.research;
  const actions: SurveyAction[] = [];
  const adds = { objective: false, hypotheses: 0, constructs: 0, source: false };
  if (!s) return { actions, adds, empty: true };
  const had = new Set((r?.hypotheses ?? []).map(norm));
  const hyps = s.hypotheses.map((h) => h.text.trim()).filter((t) => t && !had.has(norm(t)));
  const hadC = new Set((r?.constructs ?? []).map((c) => norm(c.name)));
  const newConstructs = s.constructs.filter((c) => !hadC.has(norm(c.name)));
  const objective = !r?.objective && s.objectives[0]?.text ? s.objectives[0].text.trim() : undefined;
  const source = !(r?.sources ?? []).some((x) => norm(x) === norm(doc.name));
  if (objective || newConstructs.length || source) {
    actions.push({
      op: "set_research",
      ...(objective ? { objective } : {}),
      ...(newConstructs.length ? { constructs: [...(r?.constructs ?? []).map((c) => ({ name: c.name, role: c.role, ...(c.definition ? { definition: c.definition } : {}), questions: c.questionIds.map((id) => def.questions.find((q) => q.id === id)?.code ?? id) })), ...newConstructs.map((c) => ({ name: c.name, role: "descriptive", ...(c.definition ? { definition: c.definition } : {}) }))] } : {}),
      ...(source ? { sources: [...(r?.sources ?? []), doc.name] } : {}),
    } as SurveyAction);
  }
  for (const text of hyps) actions.push({ op: "add_hypothesis", text } as SurveyAction);
  adds.objective = !!objective; adds.hypotheses = hyps.length; adds.constructs = newConstructs.length; adds.source = source;
  const empty = !objective && !hyps.length && !newConstructs.length;
  return { actions: empty ? [] : actions, adds, empty };
}

/** "the objective, 2 hypotheses and 3 constructs" */
export function describeDocMerge(m: DocMerge): string {
  const parts = [m.adds.objective ? "the objective" : "", m.adds.hypotheses ? `${m.adds.hypotheses} hypothes${m.adds.hypotheses === 1 ? "is" : "es"}` : "", m.adds.constructs ? `${m.adds.constructs} construct${m.adds.constructs === 1 ? "" : "s"}` : ""].filter(Boolean);
  if (!parts.length) return "nothing new — the design has all of it";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
