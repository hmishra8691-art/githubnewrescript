export * from "./state.js";
export * from "./random.js";
export * from "./evaluate.js";
export * from "./logicTree.js";
export * from "./logicExpression.js";
export * from "./flatten.js";
export * from "./calc.js";
export * from "./piping.js";
export * from "./pipingTokens.js";
export * from "./placeholders.js";
export * from "./carryforward.js";
export * from "./carryForwardInto.js";
export * from "./displayRules.js";
export * from "./setExpression.js";
export * from "./autoPunch.js";
export * from "./media.js";
export * from "./mediaDisplay.js";
export * from "./legacyMedia.js";
export * from "./analysisFramework.js";
export * from "./advancedMethods.js";
export * from "./advancedIntent.js";
export * from "./analysisActions.js";
export * from "./localizationActions.js";
/* translation as a task — the deterministic half: masked inventory, adaptive batches, validation, coverage (2026-10-29, ported from K3) */
export * from "./translationTask.js";
export * from "./quotaActions.js";
export * from "./listFillActions.js";
export * from "./methodActions.js";
/* assessments: deterministic scoring, the respondent stripping and leak check, and the answer-key actions (K4 2026-10-25, ported 2026-10-29) */
export * from "./assessment.js";
export * from "./assessmentActions.js";
export * from "./optionActions.js";
export * from "./actionValidation.js";
export * from "./impact.js";
export * from "./changeItems.js";
export * from "./optionsPaste.js";
export * from "./dependencies.js";
export * from "./dependencyIndex.js";
export * from "./renumber.js";
export * from "./recode.js";
export * from "./renameCode.js";
export * from "./questionCount.js";
export * from "./lintLogic.js";
export * from "./qualityCheck.js";
export * from "./objectStatus.js";
export * from "./designVersion.js";
export * from "./exactBalance.js";
export * from "./choiceData.js";
export * from "./conjointSuite.js";
export * from "./sampleSource.js";
export * from "./logicSummary.js";
export * from "./logicGraph.js";
export * from "./flow.js";
export * from "./flowTree.js";
export * from "./embedded.js";
export * from "./redirect.js";
export * from "./quotas.js";
export * from "./scale.js";
export * from "./formats.js";
export * from "./dateFormat.js";
export * from "./uploadTypes.js";
export * from "./bucketRules.js";
export * from "./videos.js";
export * from "./cards.js";
export * from "./retireVariants.js";
export * from "./rendererReads.js";
export * from "./validate.js";
export * from "./variables.js";
export * from "./scripts.js";
export * from "./questionTypes.js";
export * from "./inspector.js";
export * from "./versioning.js";
export * from "./fields.js";
export * from "./answers.js";
export * from "./html.js";
export * from "./scopedHtml.js";
export * from "./blocks.js";
export * from "./blockPreview.js";
export * from "./pageBreaks.js";
export * from "./structureOps.js";
export * from "./diagnose.js";
export * from "./questionCreate.js";
export * from "./surveyActions.js";
export * from "./surveyReview.js";
export * from "./ux.js";
export * from "./uxScriptGuard.js";
export * from "./serverValidation.js";
export * from "./sectionNav.js";
export * from "./semanticValidation.js";
export * from "./legacyScripts.js";
export * from "./uxActions.js";
export * from "./optionCodes.js";
export * from "./theme.js";
export * from "./droppedFields.js";
export * from "./tournament.js";
export * from "./adaptive.js";
export * from "./testBuild.js";
export * from "./responseFilter.js";
export * from "./responseImport.js";
export * from "./listFill.js";
export * from "./listFillLint.js";
import "./listFillSettled.js";
export * from "./loops.js";
export * from "./loopDescribe.js";
export * from "./quotaDashboard.js";
export * from "./countCondition.js";
export * from "./elementIds.js";
export * from "./optionGroups.js";
export * from "./calcContext.js";
export * from "./namedExpressions.js";
export * from "./punchChain.js";
export * from "./logicTrace.js";
export * from "./aiFunctions.js";
export * from "./probe.js";
export * from "./geo.js";
export * from "./acbc.js";
export * from "./aiConversation.js";
export * from "./localization.js";
export * from "./otherSpecify.js";
export * from "./formFields.js";
export * from "./gridDisplay.js";
export * from "./visibility.js";
export * from "./hiddenPreview.js";
export * from "./cloneProject.js";
export * from "./gridAxes.js";
export * from "./references.js";
export * from "./questionOps.js";
export * from "./variableUsage.js";
export * from "./namingTemplates.js";
export * from "./derivedNames.js";
export * from "./questionShape.js";
export * from "./interview.js";
export * from "./versionedDictionary.js";
export * from "./logicProposal.js";
export * from "./defaultValue.js";
export * from "./conditionWalk.js";
export * from "./naturalCondition.js";
export * from "./nlTargets.js";
export * from "./nlIntent.js";
export * from "./contextActions.js";
export * from "./hypotheses.js";
export * from "./planReads.js";
export * from "./relevance.js";
export * from "./dataQuestion.js";
export * from "./researchPlanner.js";
export * from "./nlSemanticMatch.js";
export * from "./researchBlockers.js";
export * from "./languageCorpus.js";
export * from "./gridCell.js";
export * from "./conditionCopy.js";
export * from "./optionPopups.js";
export * from "./speechInput.js";
export * from "./listValue.js";
export * from "./smartOperators.js";
export * from "./containsOperator.js";
/* Embedded Data piping, system piping sources, the Insert Piped Text catalog (document 15/10/2026) */
export * from "./systemPipes.js";
export * from "./embeddedPiping.js";
export * from "./pipeCatalog.js";

/*
 * The survey's own logic check also carries the piped Embedded Data warnings
 * (2026-10-17). Registered here, after every module has loaded, because
 * importing embeddedPiping from lintLogic changes the package's module load
 * order and breaks the piping ↔ carryforward initialisation.
 */
import { registerSurveyLint as __registerSurveyLint } from "./lintLogic.js";
import { lintEmbeddedPiping as __lintEmbeddedPiping } from "./embeddedPiping.js";
import type { ObjectKey as __ObjectKey } from "./dependencyIndex.js";
__registerSurveyLint((def) => __lintEmbeddedPiping(def).map((i) => ({
  level: "warning" as const, questionCode: "Flow", path: `flow.${i.nodeId}.fields.${i.field}`, message: i.message, objectKey: `flowNode:${i.nodeId}` as __ObjectKey,
})));
export * from "./capabilities.js";
export * from "./capabilityRegistry.js";
export * from "./mediaActions.js";
export * from "./logicScriptActions.js";
export * from "./researchActions.js";
export * from "./qualActions.js";
/* F2 2026-10-22: qualitative synthesis requests in words (summaries, insights, comparisons, reels, double-coding, ask, auto-coding, group sessions) */
export * from "./qualIntent.js";
/* G2 2026-10-22: live human-moderated sessions scheduled in words (zoned times, segments) */
export * from "./liveSchedule.js";
export * from "./aiInterviewSafety.js";
export * from "./aiModerator.js";
export * from "./aiInterviewStudy.js";
export * from "./aiInterviewActions.js";
export * from "./aiModeratorEval.js";
/* G1 2026-10-22: AI interviews in every language, voice conversation with barge-in, realtime */
export * from "./aiInterviewMessages.js";
export * from "./aiInterviewWords.js";
export * from "./aiInterviewLanguages.js";
export * from "./aiInterviewLocalize.js";
export * from "./aiInterviewVoice.js";
export * from "./aiInterviewRealtime.js";
export * from "./researchSuitability.js";
export * from "./researchTraceability.js";
export * from "./researchValidation.js";
/* prompt-injection audit (2026-10-18): untrusted text in prompts — fences, the scanner, the provenance gate */
export * from "./untrusted.js";
export * from "./provenance.js";
/* production intents (2026-10-18): a calculation written in the condition language spelling (GRID.R1, IF … THEN … ELSE) */
export * from "./calcRewrite.js";
/* engine items 11–14 (2026-10-22): the plan-item readiness rule at action time; refused MaxDiff / conjoint designs corrected or explained; script structure */
export * from "./planItemGate.js";
export * from "./methodRepair.js";
export * from "./scriptAst.js";
export * from "./codeGate.js";
export * from "./scriptWrites.js";
export * from "./logicSandbox.js";
/* S1c: live script-error telemetry — the shared collector shape, the save route's sanitiser and the Studio aggregate */
export * from "./scriptHealth.js";
export * from "./scriptExplain.js";
export * from "./scriptAudit.js";
export * from "./uxDuplicates.js";
/* panel recruitment and alerts (2026-10-22, G3): presets, signed redirects, alert routing / redaction / rendering, the connect_panel / configure_alerts actions */
export * from "./panels.js";
export * from "./notifyEvents.js";
export * from "./integrationActions.js";
/* durable execution state: the task and step types the copilot runner persists (2026-10-24) */
export * from "./execPlan.js";
/* plan first or one turn — the deterministic size estimate (2026-10-29, ported from K1) */
export * from "./taskEstimate.js";
/* large generation as a plan of small steps, and the structured deliverable check (2026-10-29, ported from K2) */
export * from "./deliverableValidation.js";
export * from "./generationPlan.js";
