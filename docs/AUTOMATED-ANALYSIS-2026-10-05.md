# Automated analysis after fieldwork — the plan runs itself, the findings are read, the hypotheses judged

*Research-intelligence brief, Phase 5 ("Automated analysis, crosstabs and visualisation after fieldwork"). Built 2026-10-05 on the analysis framework (ANALYSIS-FRAMEWORK-2026-10-04.md), the analytics package (ANALYTICS-RESEARCH-STUDIO.md) and the Intelligent copilot.*

## What it does

Phase 2 wrote the analysis plan before fieldwork and `@rescript/analytics` could already run every planned item as an analysis — but results were recomputed on request, never kept; nothing judged a hypothesis; nothing ran by itself; and the copilot could see no results at all. Now:

- **Findings are read from the results, structurally.** `findingsFor(definition, result)` reads each result's tests (p-values, effect sizes), a regression's coefficient table (estimate, standardized β or odds ratio, p — the intercept left out, each term resolved back to its variable), a correlation table (r, p), the NPS KPI, the reliability table — never the insight sentences — and produces findings with their evidence (`test`, `statistic`, `p`, `effect`, `n`, direction) and a strength on the usual scales (Cramér's V / r / β 0.1–0.3–0.5, Cohen's d 0.2–0.5–0.8, η² 0.01–0.06–0.14, odds ratios). A crosstab gives one finding per banner variable, with the largest gap as detail; a base under 30 adds the caution to every finding; an empty base is an "inconclusive" placeholder, not a finding. `rankFindings` puts significant and strong first.
- **Hypotheses get verdicts.** `hypothesisVerdicts(def, items)` judges each H1, H2… from the findings of the analyses planned for it: **supported** (every planned test significant), **not supported** (none), **mixed** (some), **inconclusive** (base under 30, or only descriptives planned — with what to add), **untested** (nothing planned) — each with its reason, quoting the finding. A crosstab tagged with a hypothesis may have several banner variables: a banner's finding counts as evidence only when the hypothesis names that variable, a planned test pairs the same two variables, or it is the crosstab's only banner — otherwise it is shown as context, not judged.
- **A run is the whole plan on one dataset.** `runPlan(def, dataset, { trigger, items })` executes every planned analysis (saved refinements in the Analytics "Planned" folder replace the engine's definition by planned id), collects the findings strongest first, the verdicts, the caveats, and the chart each result is best shown as. `compactRun` strips the results (recomputed when a result is opened in Analytics), and that is what is stored and sent around; `briefText` is the run in a few lines for the copilot.
- **The plan runs by itself.** `nextMilestone(done, { completes, target, fieldEnd })` names the fieldwork milestone reached and not yet run for — the first readable base (30 completes), halfway to the suppliers' target, the target, the end of the field window — once each. The hourly cron `/api/cron/analysis-runs` checks every live survey whose definition carries a plan (unless `analysisPlan.autoRun` is false), runs the plan for a due milestone and stores it in `analytics_runs` (migration 0046). `POST analytics/plan/run` runs it on request; `GET analytics/plan/latest` returns the latest run and the milestone due; `GET analytics/plan/runs` the history. Each run is audited (`analytics.plan_run`).
- **The copilot answers from the numbers.** A question about what the data showed (`findingsIntent`: "what did we find?", "did H1 hold?", "is the gender difference significant?", "what drives satisfaction?") brings the FINDINGS GUIDE and, in the outline, the latest run's brief — verdicts, then findings with test, p, effect and base — which the Studio sends with every turn once a run exists; an analysis turn carries it too. The guide binds the model to the run: quote the test and p, name the effect size and its strength, give the base; a verdict is the run's; no run means "nothing has been run yet", a question the plan does not answer means "not tested" plus the analysis action that would test it. The model never computes or invents a number.
- **Intelligent → Findings.** Each hypothesis with its verdict and reason (an untested one offers **Plan a test**, through the copilot's analysis actions); the findings strongest first with their evidence, a significant-only toggle, the caveats; the run's trigger, time and base, the milestone due, **Run the plan now** / **Run again**, **Ask the copilot to narrate**, **Open in Analytics**.

## Where

| Where | What |
|---|---|
| `packages/analytics/src/findings.ts` | `Finding`, `findingsFor`, `strengthOf`, `rankFindings`; `HypothesisVerdict`, `hypothesisVerdicts`; `AnalysisRun`, `RunItem`, `runPlan`, `compactRun`, `briefText`; `Milestone`, `nextMilestone`. |
| `packages/schema/src/analysisPlan.ts` | `AnalysisPlan.autoRun?: boolean` (on unless false). |
| `supabase/migrations/0046_analytics_runs.sql` | `analytics_runs` (trigger, environment, n, dataset, computed_at, findings, verdicts, items, warnings, survey_version) with the members' read policy. |
| `apps/studio/lib/analytics.ts` | `runPlanFor` (one dataset for the plan, saved "Planned" refinements, the compact run stored), `latestRun`, `listRuns`, `dueMilestone` (completes, the suppliers' target, the project's field window, the runs made). |
| `apps/studio/app/api/surveys/[id]/analytics/[[...path]]/route.ts` | `GET plan/latest`, `GET plan/runs`, `POST plan/run`. |
| `apps/studio/app/api/cron/analysis-runs/route.ts` + `vercel.json` | The hourly milestone runner (CRON_SECRET, 45 s budget, 200 surveys). |
| `packages/access/src/audit.ts` | `analytics.plan_run`. |
| `apps/studio/lib/copilot/prompt.ts`, `outline.ts`, `api/copilot/turn` | `COPILOT_FINDINGS_GUIDE`, `findingsIntent`; the run's brief in the outline on findings and analysis turns (`briefText`), "none yet" without one; the route reads `analysisRun` from the body. |
| `apps/studio/components/intelligent/copilot/useCopilot.ts` | `analysisRun` from `plan/latest` (and a test seam), `runPlanNow`, `runDue`; the brief (verdicts, top 40 findings) sent with every turn. |
| `apps/studio/components/intelligent/copilot/FindingsTab.tsx` | Intelligent → **Findings**. |

## Principles kept

- **Reasoning is separated from execution.** The Studio runs the analyses and reads the findings deterministically; the model narrates what the run says and is told, in the guide, to report no number the run does not contain.
- **Human in the loop.** A run is kept, never acted on: a verdict changes no plan; "Plan a test" and the copilot's answers go through the proposal pipeline; the researcher runs the plan or lets the milestones do it.
- **Nothing duplicated.** The analyses are the package's own runners; the results are the Analytics workspace's results; the stored run holds only what the results do not keep (findings, verdicts, the chart choice); the counts, target and field window come from fieldwork's own tables.

## Tests

- analytics `findings.test.ts` (4): findings from every result kind on the synthetic data (the planted gender effect, the null region effect, satisfaction driving NPS and age not, the NPS and the reliability, the crosstab per banner with the gap, the strength scales, the ranking); the small base and the empty base; the verdicts (supported / not supported / mixed / untested, the banner rule, the low-base and descriptive-only inconclusives), the brief and the compact form; the milestones.
- studio `copilot.test.ts` (+1): the intent, the brief in the outline with and without a run, the guide, the vocabulary.
- browser `scripts/findings-copilot-test.mjs` (6): the tab without a run; a run (computed by the real package on the synthetic data) through the seam → verdicts, findings, toggle, badge; "Plan a test" through the copilot into Changes; the turn route with and without the run; the routes' refusals.
- **Mutation checks**: analytics `findings.ts` 37 / 37 (9 first survivors closed with tests — negative drivers and correlations, the η² scale, the reliability bands, the ranking of a non-significant headline number, a hypothesis served by a crosstab alone, the brief's tags); Studio prompt/outline 6 / 6; Studio surfaces through the browser suite 11 / 11 (route, Findings tab, badge, seam).

## Not done

- **Charts are chosen, not drawn, in the Findings tab** — each finding names the chart its result is best shown as; the picture is the Analytics workspace's (`Open in Analytics`). A findings report with the charts drawn is Phase 6.
- **The plan's derived variables and segments** are still not computed by the run (the bridge does not turn them into analyses).
- **The browser suite cannot run `plan/run`** — it needs a saved survey with responses; the service is covered by the pure `runPlan` tests and shares `buildFor`/`runAnalysis` with the tested `run` route.
- Phase 6 of the brief (reporting) is next.
