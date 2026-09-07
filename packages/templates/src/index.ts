/**
 * @rescript/templates — complete, ready-to-open survey definitions.
 *
 * A template is a function of a survey id that returns a parsed
 * `SurveyDefinition`, so the Studio can offer it in "New survey" and a script
 * can write it to a file; both get byte-identical output for the same id.
 */
export { buildMasterDemoSurvey, MASTER_DEMO_TEST_PATHS, BRANDS } from "./masterDemo.js";
export type { DemoTestPath } from "./masterDemo.js";
export {
  buildNpsSurvey, buildCsatSurvey, buildScreenerSurvey,
  buildBrandTrackerSurvey, buildEmployeeSurvey,
} from "./starters.js";

import { buildMasterDemoSurvey } from "./masterDemo.js";
import {
  buildNpsSurvey, buildCsatSurvey, buildScreenerSurvey,
  buildBrandTrackerSurvey, buildEmployeeSurvey,
} from "./starters.js";
import type { SurveyDefinition } from "@rescript/schema";

export interface SurveyTemplate {
  key: string;
  name: string;
  description: string;
  build(surveyId: string): SurveyDefinition;
}

/**
 * What "New survey" offers. The starters come first because they are what
 * someone starting a study actually wants; the Master Demo is a reference,
 * and reads like one.
 */
export const SURVEY_TEMPLATES: SurveyTemplate[] = [
  {
    key: "nps_relationship",
    name: "Net Promoter Score",
    description: "The score, a reason asked three different ways depending on it, satisfaction by area, and the NPS group as a derived variable",
    build: buildNpsSurvey,
  },
  {
    key: "csat_support",
    name: "Customer satisfaction (support)",
    description: "CSAT, resolution and effort, with a follow-up that appears only when something is unresolved, and an agent-behaviour grid",
    build: buildCsatSurvey,
  },
  {
    key: "screener_quota",
    name: "Screener with quotas",
    description: "Consent, age and security screening that terminates, a category screen, and interlocking age quotas with a quota check",
    build: buildScreenerSurvey,
  },
  {
    key: "brand_tracker",
    name: "Brand tracker (wave)",
    description: "Awareness → consideration → usage → main brand by carry-forward, an image grid, piped satisfaction and a wave captured from the URL",
    build: buildBrandTrackerSurvey,
  },
  {
    key: "employee_engagement",
    name: "Employee engagement",
    description: "eNPS, a randomised engagement grid, tenure and team, and two open ends — with the confidentiality note respondents ask for",
    build: buildEmployeeSurvey,
  },
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

export {
  runTestCase, runSuite, describeSuite, outcomeOf, diffOutcomes,
  checkExpectations, staleReferences, canonicalJson, fingerprint,
} from "./testCases.js";
export type {
  TestCase, TestCaseInput, TestCaseResult, TestExpectations, TestOutcome,
  TestVerdict, OutcomeChange, SuiteResult, SuiteSummary,
} from "./testCases.js";
