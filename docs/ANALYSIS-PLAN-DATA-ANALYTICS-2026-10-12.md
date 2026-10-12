# Analysis plan ↔ Data Analytics (2026-10-12)

## Root cause
The plan lives in the survey definition (`research.analysisPlan`) and was only *rendered* by
Intelligent → Analysis. Results → Data Analytics never read it: its only bridge was a one-shot
"Create the planned analyses" button in the Analyses rail, which copied items into
`analytics_analyses` once (folder "Planned") with no way to see, edit or re-sync the plan,
no record of whether it had been applied, and no charts/dashboard/report from it. The Project
Overview's "Analysis plan" row linked to the questionnaire tab.

## Data flow now
Plan (definition) → `planItemViews` (vs dictionary, saved analyses, charts, latest run)
→ Apply: `planAnalysisSync` (create / update-in-place / keep refinement / skip invalid)
→ `runPlanFor` (real engine, invalid items excluded, no empty runs stored)
→ `planChartSync` (one chart per planned id, `spec.id = plan:<id>`)
→ `planDashboard` (one dashboard, `plan:<id>` widgets, user layout kept)
→ `reportFromRun` (one findings report, kept if hand-edited unless `replaceReport`)
→ `analytics_plan_applies` (record of every apply + 2-minute concurrency lock).

Identity everywhere is the planned item id (`options.planned`); `options.plannedHash`
distinguishes "the plan changed" (update in place) from "the researcher refined it" (keep).

## Files
- engine `analysisActions.ts`: `update_crosstab`, `update_analysis_test`, `reorder_analysis_plan`
- analytics `planWorkspace.ts` (+ test); `OutputOrigin` on report/dashboard definitions
- studio `lib/analysisPlanCore.ts` (+ test), `lib/analysisPlanService.ts`, `lib/analytics.ts`
- route `GET plan`, `PUT plan` (survey.edit + edit lock + revision guard), `POST plan/apply` (analytics.edit)
- UI `components/analytics/PlanWorkspace.tsx`, Home plan card, Intelligent-mode link, overview row
- migration `0050_analysis_plan_applies.sql`
- browser test `scripts/analysis-plan-test.mjs`; shared fake `scripts/lib/fakeSupabase.mjs`
