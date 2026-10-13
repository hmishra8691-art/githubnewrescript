import type { SurveyDefinition } from "@rescript/schema";
import { def as base, synthRows, spec } from "../analyses/fixture.js";
import { buildDataset } from "../dataset.js";
import { runPlan } from "../findings.js";
import { planStoryReport, type StoryReport } from "./index.js";

/** a small study with a research design, its plan run on the synthetic data, and the story proposed from it — shared by the story tests */
function study(): SurveyDefinition {
  const def = structuredClone(base);
  def.research = {
    objective: "Understand what drives satisfaction and recommendation", population: "Adults 18+", methodology: "Online panel",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: ["Who is most satisfied?"],
    kpis: [{ name: "Satisfaction", variable: "SAT", measure: "top-2-box share", target: "60%", direction: "higher" }, { name: "NPS", variable: "NPS", measure: "NPS" }],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: [], sources: [],
    brief: { client: "Acme Foods", businessQuestion: "Should we keep investing in service?", decision: "whether to fund the 2027 service programme", background: "", stakeholders: [], deliverables: [] },
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }, { id: "x2", rows: ["AWARE"], columns: ["REGION"], priority: 2, hypotheses: [] }],
      tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

const def = study();

export const storyDef = study();
const ds = buildDataset(storyDef, synthRows(400), { spec });
export const storyRun = runPlan(storyDef, ds, { trigger: "manual", now: "2026-10-01T10:00:00Z" }) as never as Parameters<typeof planStoryReport>[1];
export const planStory = (o: Partial<Parameters<typeof planStoryReport>[2]> = {}): StoryReport => planStoryReport(storyDef, storyRun, { sample: { analysed: 400, environment: "LIVE", dataset: "all" }, date: "2026-10-01", runId: "run1", ...o });
