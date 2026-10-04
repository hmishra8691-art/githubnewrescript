# The analysis framework — planned before fieldwork

*Research-intelligence brief, Phase 2 ("Hypothesis → research design, variable classification, analysis framework, methodology intelligence"). Built 2026-10-04 on top of the Intelligent copilot (see INTELLIGENT-COPILOT.md).*

## What it does

Analysis is no longer something that starts after data collection. The definition now carries what each question is for and what the study will run, and the copilot, the Studio and the engine all read and write the same thing:

- **Every question has an analysis definition** (`question.analysis`): its role in the design (dependent, independent, mediator, moderator, control, segmentation, screening, descriptive), how it is measured (nominal, ordinal, interval, ratio, multi, text, rank, allocation, choice, date), how it is reported on its own (frequencies, mean, top-2-box, NPS, MaxDiff scores…), what it is tabulated against, what it is expected to relate to, which modelling it takes part in, which construct it measures and which hypotheses (H1, H2…) it serves. Everything left blank is **inferred** by the engine from the type, the research design's constructs and the question's place in the survey; the Studio shows the inference, marks it as such, and stores only what the researcher sets.
- **The research design has an analysis plan** (`research.analysisPlan`): crosstabs (rows × columns, priority 1–3, the hypotheses each serves), tests (method, outcome, predictors, grouping variable, moderator, mediator), derived variables (mean scores, top boxes) and segments. The engine proposes one from the roles and types; the copilot refines it in words; the researcher edits it by hand.
- **Hypothesis coverage**: each hypothesis is linked to the constructs that name it and the questions that measure them, and reported as testable, measured-but-unplanned, unmeasured or unlinked.
- **Impact analysis**: deleting a question lists what the plan loses (constructs, hypotheses, crosstabs, tests, derived variables, other questions tabulated against it) in the delete dialog and in the copilot's destructive note; the plan is pruned, never left pointing at a deleted question. Renaming a variable follows it into the plan.
- **Checks**: the review reports a plan that no longer fits the survey — dead references, a t-test on three groups, a chi-square on a number, a logistic regression on a five-point outcome, MaxDiff scores on a question that is not a MaxDiff, a hypothesis tag that does not exist, an open text as a dependent variable.
- **Methodology advice**: a deterministic lookup from a stated goal ("which features consumers value most", "what price", "does the ad work", "test three concepts") to the recommended method and the alternatives with their trade-offs — rating, ranking, MaxDiff, conjoint, TURF, Van Westendorp, Gabor–Granger, monadic / sequential monadic, A/B, brand funnel, key drivers, segmentation, NPS — each with the question type that implements it here.
- **The plan runs**: `@rescript/analytics` turns every planned item into the `AnalysisDefinition` it already executes, and Analytics → "Create the planned analyses" creates them in one step once responses exist — hypothesis-linked first, each tagged with its hypotheses, none created twice.

## Where

| Where | What |
|---|---|
| `packages/schema/src/analysisPlan.ts` | `QuestionAnalysis`, `AnalysisPlan` (`PlannedCrosstab`, `PlannedTest`, `PlannedDerived`, `PlannedSegment`), the role / measurement / method vocabularies, `hypothesisLabel`. `Question.analysis` and `ResearchDesign.analysisPlan` are optional: an existing survey is unchanged. |
| `packages/engine/src/analysisFramework.ts` | `measurementOf`, `inferRole`, `inferQuestionAnalysis`, `buildAnalysisFramework`, `prioritizeCrosstabs`, `hypothesisCoverage`, `analysisDependencies` / `describeAnalysisImpact`, `pruneAnalysisReferences`, `renameAnalysisReferences`, `reviewAnalysisPlan`, `methodologyAdvice`. |
| `packages/engine/src/analysisActions.ts` | The actions: `set_question_analysis`, `propose_analysis_plan`, `set_analysis_plan`, `add_crosstab` / `remove_crosstab`, `add_analysis_test` / `remove_analysis_test`, `add_derived_variable` / `remove_derived_variable` — gate, apply (every variable resolved against the survey; a method the platform does not run is refused by name), descriptions. Wired into `surveyActions` (ranked after `set_research`, so the questions and constructs exist first), the diff summary ("Plan the analysis: 4 crosstabs, 7 tests", "Plan crosstab: PURCHASE_INT by COUNTRY", "Change Q2: analysis") and `delete_question`'s destructive note. |
| `packages/engine/src/references.ts`, `variableUsage.ts`, `surveyReview.ts` | Delete pruning and the delete dialog's list; rename usages and rewriting; the review's `analysis` / `hypothesis` findings. |
| `packages/analytics/src/planBridge.ts` | `plannedAnalyses`, `crosstabDefinition`, `testDefinition` — the plan as analyses, in the variable order each runner expects (`[outcome, group]` for tests, `[y, …xs]` for regression, `[y, x, m]` for mediation; moderation as an interaction). |
| `apps/studio/components/studio/QuestionAnalysisSection.tsx` | Properties → **Analysis** on every question. |
| `apps/studio/components/intelligent/copilot/AnalysisTab.tsx` | Intelligent → **Analysis**: hypotheses with coverage, the checks, the crosstabs most important first, tests and models, derived variables and segments, every question's role; **Plan the analysis** / **Add the engine's suggestions** / **Re-plan** as proposals through Changes; **Remove…** on planned items (confirmed); the methodology advice for the stated objective. |
| `apps/studio/lib/copilot/prompt.ts`, `outline.ts`, `api/copilot/turn` | The system prompt names the framework; the ANALYSIS GUIDE (vocabulary, which test for which pair, action shapes) goes with analysis turns and generation; the outline carries the roles and the saved plan with ids on those turns. The gate's refusal reasons are now shown on the card. |
| `apps/studio/app/api/surveys/[id]/analytics/[[...path]]/route.ts` | `POST analyses/from-plan` — creates the planned analyses (folder "Planned", tagged with their hypotheses, `options.planned` = the plan item's id so a second press adds only what is new). `AnalysesRail` → **Create the planned analyses**. |

## How the engine plans

From the roles and measurement levels:

- each **outcome** by the segmentation banner (demographics, markets, user groups — set or inferred from names, text and block), priority 1 when a hypothesis names it, otherwise 2; a sample-profile table at priority 3;
- each **nominal / multi-select independent** against each outcome as a table;
- **scale × scale** → correlation, and one regression per outcome on all its scale or binary predictors, a moderator as an interaction and a mediator as a route; a two-category outcome → logistic regression;
- **groups × scale** → t-test (two groups) or ANOVA; **groups × categories** → chi-square;
- what a type demands: MaxDiff scores, conjoint utilities, NPS;
- a **multi-item construct** → reliability and a `<CONSTRUCT>_SCORE` mean; an ordinal outcome → `<VAR>_T2B`.

Hypotheses attach by name: a hypothesis whose text names a construct (or all of its distinctive words) is served by that construct's questions and by every table and test that reads them. A question can also be tagged with a hypothesis directly.

## Principles kept

- **Reasoning is separated from execution.** The model proposes roles and plans in a closed vocabulary; the engine resolves every variable, refuses what cannot run, and the researcher applies. The plan is executed by `@rescript/analytics`, never by the model.
- **Nothing here changes what a respondent is asked.** The analysis actions write `question.analysis` and `research.analysisPlan` only; a proposal of them has an empty structural diff.
- **Human in the loop.** Planning is a proposal in Changes; replacing or removing is destructive and confirmed; inference is shown as inference.

## Tests

- engine `analysisFramework.test.ts` (9): measurement levels, roles, the inferred metadata and the explicit override, the framework (banner, IV × DV, tests by level, one model per outcome, moderator, types, reliability, derived, prioritisation), hypothesis coverage, delete impact and pruning (including the construct's message), rename, the review's findings, the actions (gate, resolution, nothing-else-changes, destructive notes, merge, delete impact), methodology advice. **Mutation-checked: 43 / 43 caught** (three first caught only by the compiler were re-mutated into compiling variants and caught by the tests).
- analytics `planBridge.test.ts` (3): every planned item to a definition in the runner's order, the planned analyses run on synthetic data, the primaries. **10 / 10 caught** (one survivor closed with a test).
- studio `copilot.test.ts` (+1): analysis intent, the guide, the outline's roles and plan, the vocabulary, the gate.
- browser `scripts/analysis-framework-test.mjs` (7): Properties → Analysis inference / set / reset; Intelligent → Analysis proposal → Changes → Apply; confirmed removal; the copilot's actions through the fake provider with a refused method shown by reason; delete dialog and pruning; the review. Mutation-checked against the Studio surfaces (see the session notes).

## Not done

- **Analytics "Create the planned analyses" is tested at the bridge, not in the browser** — the Analytics workspace needs a saved survey with responses, which the sandbox has not.
- The engine's plan does not yet propose **TURF, pricing or brand-funnel** analyses from question patterns (they are in the vocabulary and the copilot can plan them); nor **segmentation (cluster)** from a basis battery.
- A hypothesis is linked to constructs by **name matching**; a hypothesis written without the construct's words needs the questions tagged by hand or by the copilot.
- Phases 3–6 of the brief (translation copilot actions, quota import, automated analysis after fieldwork, reporting) are next.
