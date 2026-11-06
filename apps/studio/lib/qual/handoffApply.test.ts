import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import type { QualState } from "@rescript/analytics";
import { applyHandoff, proposeHandoff } from "./handoffApply.ts";

/* THE MIXED-METHODS HAND-OFF, applied (platform audit 2026-11-05). */

const fixtureState = (): QualState => ({
  codebook: {
    version: 3, method: "inductive",
    themes: [{ id: "th1", name: "Cost and value", status: "human_reviewed" }, { id: "th2", name: "Service problems", status: "human_reviewed" }],
    codes: [
      { id: "c1", name: "Price rise", definition: "the price went up", themeId: "th1", status: "human_reviewed", origin: "inductive" },
      { id: "c2", name: "Willing to pay", definition: "accepts paying more", themeId: "th1", status: "human_reviewed", origin: "inductive" },
      { id: "c3", name: "Support", definition: "customer support experience", themeId: "th2", status: "human_reviewed", origin: "inductive" },
    ],
    relationships: [],
  },
  excerpts: [
    { id: "x1", codeId: "c1", sourceKind: "transcript", sourceId: "src1", segmentId: "t2", charStart: 0, charEnd: 5, quote: "price", coder: "ai", status: "human_reviewed" },
    { id: "x4", codeId: "c3", sourceKind: "transcript", sourceId: "src2", segmentId: "t5", charStart: 0, charEnd: 7, quote: "support", coder: "ai", status: "human_reviewed" },
  ],
});

const survey = () => SurveyDefinition.parse({
  meta: { id: "mm", code: "MM", title: "Mixed", version: "1" },
  questions: [{ id: "q1", code: "QUAL_THEMES", variableName: "QUAL_THEMES", type: "open_text", text: "already taken" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  research: { objective: "why customers churn", population: "broadband customers", hypotheses: ["H0 something else"], hypothesisDetails: [{}], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] },
});

test("the proposal reads the design's population and the taken codes; applying writes hypotheses, constructs and a page of questions that measure them", () => {
  const def = survey();
  const p = proposeHandoff(def, fixtureState(), []);
  assert.match(p.hypotheses[0], /among broadband customers/);
  assert.equal(p.questions[0].code, "QUAL_THEMES_2", "the code already in the survey is avoided");
  let n = 0;
  const r = applyHandoff(def, p, (prefix) => `${prefix}_t${++n}`);
  assert.deepEqual(r, { hypotheses: 2, researchQuestions: 2, constructs: 2, questions: 2, pageId: "p_t1" });
  const research = def.research!;
  assert.equal(research.hypotheses.length, 3);
  assert.equal(research.hypothesisDetails.length, 3, "one detail slot per hypothesis");
  assert.equal(research.constructs[0].origin, "qualitative");
  assert.deepEqual(research.constructs[0].facets, ["Price rise", "Willing to pay"]);
  assert.match(research.methodology!, /Mixed methods/);
  const page = (def.flow as { type: string; id: string; questionIds?: string[]; title?: string }[]).find((n) => n.id === "p_t1")!;
  assert.equal(page.title, "Themes from the qualitative phase");
  assert.equal(page.questionIds!.length, 2);
  const grid = def.questions.find((q) => q.code === "QUAL_THEMES_2")!;
  assert.equal(grid.type, "matrix_single");
  assert.equal(grid.variant, "matrix.likert");
  assert.deepEqual(grid.rows.map((r) => r.label), ["Cost and value", "Service problems"]);
  assert.equal(grid.options.length, 5);
  const top = def.questions.find((q) => q.code === "QUAL_THEME_TOP")!;
  assert.equal(top.type, "single_select");
  for (const c of research.constructs.filter((x) => x.origin === "qualitative")) assert.deepEqual(c.questionIds, [grid.id, top.id], "each construct is measured by both new questions");
  // the result still parses as a survey
  const parsed = SurveyDefinition.safeParse(def);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  // run again: nothing new to hand over
  const again = proposeHandoff(def, fixtureState(), []);
  assert.equal(again.themes.length, 0);
});
