# Intelligent Mode, Phase 6 — an analysis plan that explains itself, findings that read direction, translations that stay intact

*Intelligent Mode upgrade, Phase 6. Built 2026-10-05/06 on Phases 2–5. It answers the brief's §§14–20 (analysis framework, explainability, outputs, findings, translation integrity and impact) and the audit's R17–R19.*

## The analysis framework says why

`explainPlanItem(def, item)` (engine, deterministic, no model) explains any planned crosstab, test, derived variable or segment as the researcher would write it: the **objective** it serves, the **variables** with their type and levels, **why this method** (a t-test and not ANOVA because the grouping has two groups; an ordinal outcome treated as interval and said so; a regression as a driver analysis), the **expected output**, the **required sample** with its rule of thumb and source, and the **limitations** (collinearity for three predictors or more, correlation is not causation, small cells). `explainPlan` does every item. In the Analysis tab each item has **Why?**, and the copilot answers "why are you recommending driver analysis?" from the same function — an answer, not a model call.

**Sample size.** `requiredBase(def, item)` gives each method's base: cells × 30 for a crosstab, 30 per group for a t-test or ANOVA, Green's 50 + 8k for a regression, 10 events per predictor over the rarer outcome for a logistic model (a share above one half is read as its complement). `expectedSample(def)` reads what the study will have: a quota's stated target (the largest targeted quota), else the sum of its cells' maximums, else `research.sampleSize` (new, optional), else nothing. `planSampleSize` gives the largest base and the item that drives it; "what sample size do I need for this plan?" is answered from it. `sampleSizeReview` warns when an item needs more completes than the quotas target, with a remedy (band the variables with more than two groups; fewer predictors).

**Design corrections.**
- A multi-select is never a t-test or ANOVA groupBy (a respondent is in several groups). It becomes a crosstab with each option a column, and the reason says so.
- A banner column that does not fit the sample is banded, not split.
- `monadicDesigns` finds randomizers that show one concept each. If the arm is not recorded, the review offers `create_embedded`. If it is recorded, the plan gets a between-arms test. Questions asked in every arm are tested per arm.

**At the change.** Applying a batch now reviews the plan before and after it. Any plan issue the batch newly caused is added to the outcome's warnings as `Analysis plan: …`, whatever its level. Retyping a grouping variable to open text is reported this way. So is removing an option so that only two groups remain ("a t-test says the same thing more simply"). Issues that already existed are not repeated. The impact report names the plan items that inherit a question's options: "ANOVA SAT by GENDER — its categories are Q1's options, so its groups change" is rated *changes* for a removal and *informs* for a label edit.

`set_research` used to rebuild the design and drop a saved analysis plan. It now keeps it, and records `sampleSize`.

## The plan runs on its own variables

`withPlannedVariables(def, dataset)` (analytics) computes the plan's derived variables and segments as dataset columns before the plan runs, in plan order: mean and sum scores (a matrix expands to its rows), top/bottom box over the source's ordered scale, count, flag, recode/index through the engine's calc evaluator, and segments as one label per combination (those under 30 named in the warnings). Before, a planned test naming `BRAND_TRUST_SCORE` ran on a column that did not exist. The caller's dataset is untouched. `planBridge` uses it.

## Findings read the hypothesis's direction

`hypothesisDirection(text)` reads what a hypothesis claims: positive, negative, a named group higher ("women rate it higher"), a plain difference, or nothing directional. A low-end subject turns the direction round. `matchGroup` finds which of a test's groups the phrase names. A comparison's evidence now carries each group's mean and base (`evidence.groups`). A significant result that goes against the stated direction is no longer counted as support. When every significant result goes the other way, the verdict is **not supported**: "significant, but in the opposite direction (…)". When some agree and some go against it, the verdict is **mixed**. A supported verdict on a directional hypothesis says "in the direction the hypothesis states". The Findings tab shows the direction and how many significant results agree, point the other way, or have no readable direction.

## Translations: one placeholder grammar, scripts, orphans, impact

- **One grammar.** `placeholders.ts` (engine) is the only definition of what a placeholder is: pipes, `${…}`, `[[…]]`, every `{word}` parameter, and the question codes a text names. Validation, the lint and the ai package's translator all use it. `placeholderMismatch` treats the tokens as a multiset: a source code must survive, an extra one is allowed.
- **Wrong script.** `wrongScript` flags a translation where at least 60% of at least 4 counted letters are in a script the language does not use. Names with an inner capital (iPhone), do-not-translate terms and letters inside tokens are not counted. The lint reports `wrong_script`, which does not block.
- **Orphans.** `orphanedTranslations` lists, per language, translations whose element no longer exists. Every batch prunes them with a warning. A recode moves its option's translations, and image text, to the new code, keeping their status. A move needs the same source hash and never overwrites a translation already there.
- **Impact.** `translationImpact(before, after)` gives, per language: outdated, new elements to translate, dropped, moved and kept, with a one-line summary. Only what this change did is counted: a translation already outdated, or an orphan before and after, is not this change's. The Changes review has a Translation row per language. The Languages tab shows the impact of the pending change ("Outdated:", "Dropped:", "Moved with a recode:").

## Tests

- Engine 1649 (`analysisExplain.test.ts` 22, `placeholders.test.ts` 13, plus additions to nlIntent and surveyActions), analytics 130, ai 27, Studio unit 253, typecheck clean, auth-guard audit 0 problems.
- Mutation-checked: the explanation, base and review rules, the outcome-share complement (3/3), placeholders and scripts, orphans and impact, direction and group matching, and the change-time plan feedback (6/6 after two survivors were closed by asserting the impact's severity and that an existing issue is not repeated).
- Browser: `analysis-framework-test` (9), `findings-copilot-test` (7) and `translation-copilot-test` (11) cover Why?, the sample-size answer, direction in the verdicts, wrong script, orphans and the impact panel. The other Intelligent-mode suites were re-run.

## Not done here

- The required bases are rules of thumb with their sources, not power calculations. No effect size is assumed.
- A hypothesis with no readable direction is judged on significance alone, as before. A result whose direction cannot be read (no group means, no sign) counts towards support, and the reason says the direction could not be read.
- Script detection covers the major scripts. A language with no listed script is not judged.
