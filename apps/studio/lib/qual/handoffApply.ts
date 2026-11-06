import type { ResearchDesign, SurveyDefinition, Question } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import { addQuestion, createQuestionFromVariant, defaultIds, type IdMinter } from "@rescript/engine";
import { qualHandoff, type HandoffProposal, type QualState, type ThemeSynthesis } from "@rescript/analytics";

/**
 * APPLYING THE HAND-OFF TO THE DEFINITION (platform audit 2026-11-05, capability `mixed_methods`).
 *
 * `qualHandoff` (packages/analytics) proposes; this writes the proposal into the survey the Studio holds, the
 * way the research design editor writes: hypotheses with a detail slot each, research questions, constructs
 * (origin "qualitative", facets kept), and the two question drafts on a page of their own at the end of the
 * flow — the Likert grid over the themes and the "which matters most" item — each built from its variant so
 * it carries every default a hand-made question would. Pure: it mutates the definition it is given and
 * reports what it did, and the Studio runs it inside `s.update` so undo, autosave and the edit lock all apply.
 */

const EMPTY: ResearchDesign = { hypotheses: [], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] };

export function proposeHandoff(def: SurveyDefinition, state: QualState, syntheses: readonly ThemeSynthesis[], opts: { includeAiSuggested?: boolean } = {}): HandoffProposal {
  const r = def.research ?? EMPTY;
  return qualHandoff(state, syntheses, {
    existing: { hypotheses: r.hypotheses, constructs: r.constructs, researchQuestions: r.researchQuestions },
    takenCodes: def.questions.map((q) => q.code),
    includeAiSuggested: opts.includeAiSuggested,
    population: r.population || r.audience?.description || undefined,
  });
}

export interface HandoffApplied { hypotheses: number; researchQuestions: number; constructs: number; questions: number; pageId: string | null }

export function applyHandoff(def: SurveyDefinition, p: HandoffProposal, ids: IdMinter = defaultIds): HandoffApplied {
  const cur: ResearchDesign = def.research ?? { ...EMPTY, hypotheses: [], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] };
  const now = new Date().toISOString();

  cur.hypotheses = [...cur.hypotheses, ...p.hypotheses];
  const details = [...(cur.hypothesisDetails ?? [])];
  while (details.length < cur.hypotheses.length) details.push({});
  cur.hypothesisDetails = details;
  cur.researchQuestions = [...cur.researchQuestions, ...p.researchQuestions];
  cur.constructs = [
    ...cur.constructs,
    ...p.constructs.map((c) => ({ name: c.name, role: c.role, definition: c.definition, questionIds: [] as string[], origin: "qualitative" as const, facets: c.facets })),
  ];
  if (!cur.methodology) cur.methodology = "Mixed methods: a qualitative phase whose themes were handed to this quantitative phase.";
  cur.updatedAt = now;
  def.research = cur;

  let pageId: string | null = null;
  let questions = 0;
  if (p.questions.length) {
    const page = { type: "page" as const, id: ids("p"), title: "Themes from the qualitative phase", questionIds: [] as string[] };
    (def.flow as unknown[]).push(page);
    pageId = page.id;
    const grid = variantRegistry.get("matrix.likert");
    const single = variantRegistry.get("single_select.radio") ?? variantRegistry.get("single_select.dropdown");
    for (const d of p.questions) {
      const v = d.type === "matrix_single" ? grid : single;
      if (!v) continue;
      const q = createQuestionFromVariant(v, { code: d.code, variableName: d.variableName }, ids);
      q.text = d.text;
      q.options = d.options.map((o) => ({ code: o.code, label: o.label, flags: [] })) as Question["options"];
      if (d.rows) q.rows = d.rows.map((r) => ({ code: r.code, label: r.label, flags: [], validation: [], required: false })) as Question["rows"];
      q.settings = { ...q.settings, ...(d.settings ?? {}) } as Question["settings"];
      addQuestion(def, q, { pageId });
      /* the construct of each theme is measured by its row / option here */
      for (const c of cur.constructs) if (c.origin === "qualitative" && p.themes.some((t) => t.name === c.name) && !c.questionIds.includes(q.id)) c.questionIds.push(q.id);
      questions++;
    }
  }
  return { hypotheses: p.hypotheses.length, researchQuestions: p.researchQuestions.length, constructs: p.constructs.length, questions, pageId };
}
