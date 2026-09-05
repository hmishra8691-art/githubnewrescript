/**
 * @rescript/templates — complete, ready-to-open survey definitions.
 *
 * A template is a function of a survey id that returns a parsed
 * `SurveyDefinition`, so the Studio can offer it in "New survey" and a script
 * can write it to a file; both get byte-identical output for the same id.
 */
export { buildMasterDemoSurvey, MASTER_DEMO_TEST_PATHS, BRANDS } from "./masterDemo.js";
export type { DemoTestPath } from "./masterDemo.js";

import { buildMasterDemoSurvey } from "./masterDemo.js";
import type { SurveyDefinition } from "@rescript/schema";

export interface SurveyTemplate {
  key: string;
  name: string;
  description: string;
  build(surveyId: string): SurveyDefinition;
}

export const SURVEY_TEMPLATES: SurveyTemplate[] = [
  {
    key: "master_demo_2026",
    name: "Master Demo — capability showcase",
    description: "120+ programmed questions: every question type, logic, piping, List Fill, loops with references, Conjoint, MaxDiff, quotas, scripts",
    build: buildMasterDemoSurvey,
  },
];

export function findSurveyTemplate(key: string): SurveyTemplate | undefined {
  return SURVEY_TEMPLATES.find((t) => t.key === key);
}

export { simulateRespondent, defaultAnswer } from "./simulate.js";
export type { SimulationOptions, SimulationResult, VisitedPage } from "./simulate.js";
