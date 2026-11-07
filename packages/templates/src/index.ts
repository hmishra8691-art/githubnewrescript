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
import { buildPricingPsmSurvey, buildPriceLadderSurvey, buildSequentialMonadicSurvey, buildBrandFunnelSurvey, buildAdTestSurvey } from "./methods.js";
export { buildMethodSurvey, buildPricingPsmSurvey, buildPriceLadderSurvey, buildSequentialMonadicSurvey, buildBrandFunnelSurvey, buildAdTestSurvey } from "./methods.js";

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
  /* S5c: research-method starters — the same blocks add_method_template inserts, with their analysis-plan items */
  {
    key: "pricing_psm",
    name: "Price sensitivity (Van Westendorp + Newton–Miller–Smith)",
    description: "The four price questions, purchase likelihood at the respondent's own cheap and expensive price, and the planned pricing analysis (range, OPP, IPP, NMS trial and revenue optimum)",
    build: buildPricingPsmSurvey,
  },
  {
    key: "price_ladder",
    name: "Adaptive Gabor–Granger price ladder",
    description: "One price at a time — up after yes, down after no — storing the highest price accepted, with the planned demand and revenue curves",
    build: buildPriceLadderSurvey,
  },
  {
    key: "sequential_monadic",
    name: "Sequential monadic concept test",
    description: "Every respondent rates every concept in a Williams-balanced order (stored per respondent), with the planned within-respondent comparison and order-effect check",
    build: buildSequentialMonadicSurvey,
  },
  {
    key: "brand_funnel",
    name: "Brand funnel (unaided → aided → consideration → purchase → preference)",
    description: "Top-of-mind coded by the AI classification, then the aided funnel by carry-forward, with the planned funnel and conversion analysis",
    build: buildBrandFunnelSurvey,
  },
  {
    key: "ad_test",
    name: "Ad test (forced exposure)",
    description: "The ad must play to the end, then likeability, unaided (AI-coded) and aided recall, a diagnostics grid and purchase intent — analyses planned",
    build: buildAdTestSurvey,
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

export { buildScaleSurvey } from "./scale.js";
export { simulateRespondent, defaultAnswer } from "./simulate.js";
export type { SimulationOptions, SimulationResult, VisitedPage, AnswerContext, AnswerFn } from "./simulate.js";
export { generatePopulation, sampleAnswer, targetedAnswers } from "./generate.js";
export type {
  GenerateOptions, GeneratedRespondent, GenerationReport, GenerationIssue, IssueKind, Coverage,
} from "./generate.js";

export {
  runTestCase, runSuite, describeSuite, outcomeOf, diffOutcomes,
  checkExpectations, staleReferences, canonicalJson, fingerprint,
} from "./testCases.js";
export type {
  TestCase, TestCaseInput, TestCaseResult, TestExpectations, TestOutcome,
  TestVerdict, OutcomeChange, SuiteResult, SuiteSummary,
} from "./testCases.js";
export { productionTest, startingCounts } from "./productionTest.js";
export type { ProductionTestOptions, ProductionTestReport, ProductionQuotaCell, QuotaFill } from "./productionTest.js";
export { explorePaths, comparePaths, summarizePaths } from "./paths.js";
export type { PathExploration, PathComparison, ElementReach } from "./paths.js";
