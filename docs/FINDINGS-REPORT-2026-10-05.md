# The findings report — the run written up, drafted by itself, exported through what exists

*Research-intelligence brief, Phase 6 ("Reporting"). Built 2026-10-05 on the automated analysis (AUTOMATED-ANALYSIS-2026-10-05.md) and the Analytics workspace's reports, publishing and exports (ANALYTICS-RESEARCH-STUDIO.md, GETTING-IT-OUT-PHASE6.md). This closes the six phases of the brief.*

## What it does

The workspace already had reports — blocks (cover, executive summary, text, chart, table, insights, panel grid, page break, methodology), templates, publishing with frozen snapshots, read-only shares, and PowerPoint / Excel builders. What it did not have was a report that writes itself from what the study found. Now:

- **A report from a run.** `reportFromRun(def, run, { analysisIdFor, client, fieldwork, sampleFrame })` turns an analysis run into a `ReportDefinition`: a cover (the research objective, the completes, the milestone, the date, the client); an **executive summary** whose text is assembled from the run — how many analyses on how many completes, the verdicts counted, the strongest findings in their own words, the small-base caution — over the analyses with significant findings; **the hypotheses** as a text block, each with its verdict and reason; a **section per hypothesis** that has analyses (verdict as subtitle, the reason, each planned analysis drawn as a chart block of the type the run chose and captioned with its findings — significant first — and an insights block over them); **other findings** outside the hypotheses; the **methodology** (completes, the run, the planned analyses, the significance conventions, the project's fieldwork dates and sample frame); the **caveats**. Every chart points at a saved analysis — the same result the researcher opens in Analytics — or is a placeholder to fill when none is saved. `reportNarrative` is the same assembly as text for the copilot; `reportAnalysisIds` lists the analyses an export needs.
- **Drafted into the workspace.** `draftFindingsReport` saves the plan's analyses first (`ensurePlannedAnalyses`, now shared with "Create the planned analyses"), reads the project's client and field dates, builds the report and stores it in `analytics_reports` as a live draft — to edit block by block in Reports, publish (a frozen version), share, and export as PowerPoint or Excel through the existing builders (the generated report exports unchanged; tested).
- **Drafted by itself.** When the hourly milestone cron runs the plan at `target_reached` or `field_end`, it drafts the report from that run as well, unless `analysisPlan.autoReport` is false. `POST analytics/plan/report` drafts one on request (from the latest run or a given run id); audited as `analytics.report_created`.
- **In the copilot.** A request to write (the client report, an executive summary, a debrief) is a findings question: the FINDINGS GUIDE now says how to write — what the study set out to learn, what the data showed (each verdict with its test, p and base), what it means — from the run only, and to point at **Draft the report** for the structured deck rather than invent slides. Intelligent → Findings gained **The report**: **Draft the report** (from the latest run), the link to open it in Reports once drafted, **Draft the executive summary in words** (the copilot, with the run in its context), and what the automatic draft does.

## Where

| Where | What |
|---|---|
| `packages/analytics/src/findingsReport.ts` | `reportNarrative`, `reportFromRun`, `reportAnalysisIds`, `findingLine`; `RunLike`, `ReportOptions`. |
| `packages/schema/src/analysisPlan.ts` | `AnalysisPlan.autoReport?: boolean`. |
| `apps/studio/lib/analytics.ts` | `ensurePlannedAnalyses` (shared), `draftFindingsReport`, `runById`. |
| `apps/studio/app/api/surveys/[id]/analytics/[[...path]]/route.ts` | `POST plan/report`; `analyses/from-plan` on the shared helper. |
| `apps/studio/app/api/cron/analysis-runs/route.ts` | The automatic draft at target / field end. |
| `apps/studio/lib/copilot/prompt.ts` | `findingsIntent` covers writing requests; the guide's writing paragraph. |
| `apps/studio/components/intelligent/copilot/useCopilot.ts`, `FindingsTab.tsx` | `draftReport`, `lastReport`; **The report** section. |

## Principles kept

- **Nothing written freely.** Every sentence in the draft is assembled from the run's verdicts and findings — their words, their numbers; the model writes prose only when asked, from the same run, and is told where the structured report comes from.
- **Human in the loop.** The report is a draft in Reports; publishing, sharing and exporting are the researcher's existing acts.
- **Nothing duplicated.** The report is the workspace's own `ReportDefinition`; the charts are saved analyses; the exports are the existing builders; the plan's analyses are created by the one helper both paths use.

## Tests

- analytics `findingsReport.test.ts` (3): the narrative (counts, strongest finding, small base, nothing significant); the report's shape block by block (cover subtitle, summary over the significant analyses, sections and verdicts, charts in order with the run's types and captions, insights, methodology rows, caveats, placeholders when nothing is saved, the pages); a real PowerPoint export of the generated report with the run's results. **Mutation-checked: 18 / 18** (4 first survivors closed with tests).
- studio `copilot.test.ts` (findings test extended): writing requests as findings intents, the guide's writing paragraph. **2 / 2.**
- browser `scripts/findings-copilot-test.mjs` (+1 check): the report section (draft disabled in the sandbox, the automatic-draft note, the executive summary through the copilot), the report built from the same run with saved analyses behind every chart and its export. **4 / 4 against the Studio surfaces.**

## Not done

- **The draft is not rendered to PDF here** — the workspace's PDF is the browser's print, as before; PowerPoint and Excel are the file exports.
- **`draftFindingsReport` is covered by the pure report tests and the shared helper**, not by a browser run (it needs a saved survey with responses and a database).
- The report does not yet carry **weighting** or the **sample frame** unless the project records them (the methodology block takes them when given).

## The brief, closed

Phase 1 (the Intelligent copilot and research design) → Phase 2 (the analysis framework planned before fieldwork) → Phase 3 (translation intelligence) → Phase 4 (quota intelligence and the quota sheet) → Phase 5 (the plan runs itself, findings and verdicts) → Phase 6 (the report drafted from the run). Each phase a commit, each with its unit, browser and mutation checks; the model reasons, the engine executes, the researcher approves, and nothing is stored twice.
