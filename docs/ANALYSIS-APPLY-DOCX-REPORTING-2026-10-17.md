# Analysis Apply, the Word research plan, and reporting (2026-10-17)

Written by the orchestrator from engineer B's report. B could not write files under `docs/`.

## 1. Analysis Apply — root causes

**1. Custom-access members never saw Apply.**

- `app/analytics/page.tsx` decided access from the bare role. For a `custom` member (new today) that grants only `project.read`, so a member with Data Analytics: Edit was told "no analytics access".
- Fix: `GET /api/surveys/[id]/analytics/access` returns the membership's real capabilities. `lib/analyticsAccess.ts` decides from them, and waits while they load instead of refusing.

**2. The builder's Run/Apply disagreed with the runner.**

Disabled for valid setups:

- weighting by rim targets only;
- segment profile by segments only;
- Importance × Performance set in Options.

Enabled for setups the runner refuses (they then "ran" into a page of warnings):

- correlation or reliability with one variable;
- regression with no predictor;
- Van Westendorp with fewer than 4 price questions.

A disabled button never said why.

**3. The validator was stricter than the runner.**

- It refused one-sample tests and options-based gap, brand and segmentation analyses.
- That blocked those items in the Ask panel and in the plan.

**4. The plan editor accepted items that apply then skipped as invalid.**

- Examples: an ANOVA with no grouping, a chi-square on a single variable.

**Fix — one rule.** `packages/analytics/src/planCheck.ts`:

- `analysisReadiness` and `plannedItemReadiness` mirror each runner's minimums and count battery items the way the runners do.
- The builder, the run route (now a 422 that names what is missing), the plan editor and the plan's invalid/skip states all read the same rule.
- The builder footer shows the missing input (`ax-run-missing`).
- About 30 per-method valid/invalid cases are in `packages/analytics/src/applyReadiness.test.ts`.

**The long-red `analysis-framework-test`.**

- Stale expectation: since the plan-retagging change, the top crosstab is correctly Q1×Q2 (H2). The test is updated.
- Related engine fix: a retagged item's reason still named hypotheses it no longer serves (`engine/src/planReads.ts`).

**Verified as already sound:**

- double-click apply (server lock);
- crash recovery;
- error and retry handling;
- list refresh after apply;
- latest-run-wins in the builder.

## 2. Word research plan — where it broke

1. **"Prepare a Word research plan", "update the Word document" and similar went to the model.** It can describe a file but not make one, so the copilot claimed a document with no link.
2. **The sandbox copilot refused the statistical analysis plan** with "no respondents".
3. **Nothing checked a file before offering it.**
4. **The Research tab revoked the download URL after 4 seconds.**

## 3. Word research plan — fixes

**Sentences.**

- New output type `research_plan_docx`, with a document-only recogniser in `engine/src/nlIntent.ts`.
- "Update the Word document" regenerates from the current design.

**One exporter.**

- `buildProposalDocx(def, { edition: "research_plan" })`, aliased `buildResearchPlanDocx`.
- 17 numbered sections in the brief's order. Traceability comes from engine `researchTraceability`, built from the actual survey.
- Every Word document gets:
  - a running header;
  - a "Page X of Y" footer;
  - repeating table headers;
  - rows that do not split;
  - headings kept with their content.
- The proposal's text and numbering are unchanged.

**Validation before any link.**

- `checkDocx` (`packages/analytics/src/export/docxCheck.ts`) reads the ZIP, requires the core parts, checks every XML part is well-formed and every relationship resolves.
- The output route refuses a failing file.
- The client refuses an empty or non-ZIP download.

**File name:** `<SurveyCode>_Research_Plan_<date>.docx`.

**UI.**

- A "Research plan (.docx)" button in the Research tab.
- The sandbox copilot produces the design-only documents.
- Download URLs are kept for 60 seconds.

**Evidence.**

- python-docx opened and re-saved the plan, proposal and SAP. The plan has 17 Heading 1s and 13 tables.
- LibreOffice converted it to a 13-page PDF.
- Special characters are preserved.
- No p-value, percentage or verdict appears in a design-only plan.

## 4. Reporting

- **From a sentence.** `reportBriefFromText` (`packages/analytics/src/reportBuilder.ts`) turns e.g. "premium executive report with hypothesis-wise findings, brand comparison charts, demographic segments …" into the report builder's settings: audience, tone, sections and theme (premium → Midnight). It lists asks it cannot honour: video, forecasts, causal claims.
- **Drafted from executed analyses only** (`draftReport`):
  - A hypothesis with no executed analysis is "Untested".
  - Evidence is labelled statistical or descriptive, never causal.
  - A section the data cannot fill is not drawn; a note says which analysis to add.
  - Recommendations come only from the gated interpretation step.
  - A test checks that no number appears that the results do not contain.
- **The copilot's reporting guide** (`apps/studio/lib/copilot/reportingGuide.ts`) is wired into the prompt. It is sent for document, report and chart requests (`reportingIntent`) and lives in the cached prefix. It says the model cannot make files and never states numbers an analysis did not produce.

## 5. Not done

- **Copilot plan actions with missing inputs are still accepted at action time.** Data Analytics marks them invalid and names the missing role; refusing them up front belongs with the plan-action code.
- **After a page reload, the copilot card loses its download link.** The file lives only in the page; asking again regenerates it.
- **The requested report theme is suggested in a note, not applied,** because themes are stored records.
- **python-docx shows unstyled paragraphs' style as None.** The `docx` library cannot declare a default "Normal" style. Word and LibreOffice open the files normally.

## 6. Follow-up, 2026-10-18 (browser-suite pass)

- **The access check now always settles.**
  - Before: a custom member's page waited until the access request resolved, so a failed request left it waiting for ever.
  - Now: the page settles within 6 s on the role-based answer it gave before. That covers a failed request, a non-OK answer, an answer with no capabilities, and a request that runs past 6 s (it is aborted). The server still enforces every capability.
  - Code: `analyticsPermissions(role, caps, { settled })` in `apps/studio/lib/analyticsAccess.ts`, with a unit test.
- **The earlier `ax-place-explore` / `ax-workspace` timeouts were not the access gate.**
  - The mocked suites answer `access` with a 404 or `{items: []}`, and owners never wait.
  - They came from the shared dev server recompiling ("Loading chunk app/analytics/page failed", first loads of 12–15 s).
  - Re-run on a settled server: `analytics-audit-test` 22/22 and `analytics-navigation-test` 14/14.
- **Apply was posted twice on a double click** (a real defect). Two clicks inside one render both saw `applying` false; the second request then hit the server's lock and came back as a 409 error. `PlanWorkspace.apply` now guards with a ref.
- **`analytics-test` conjoint check:** the simulator table was not removed.
  - The conjoint audit (`choice.ts`, 2026-10-17) retitled it "Share-of-preference simulation (from the aggregate logit)", which labels it as an aggregate-model simulation.
  - The test regex now matches that title. Result: 92/92.
- **Traceability source:** the Word research plan uses the engine's exported `researchTraceability` (the "Traceability matrix" table and the trace status words), not the fallback mapping.

## Files

- `packages/analytics/src/planCheck.ts`
- `packages/analytics/src/applyReadiness.test.ts`
- `packages/analytics/src/export/docx.ts`
- `packages/analytics/src/export/docxCheck.ts`
- `packages/analytics/src/reportBuilder.ts`
- analytics route and components (builder, plan editor, Ask panel, report builder dialog)
- `apps/studio/app/analytics/page.tsx`
- `apps/studio/lib/analyticsAccess.ts`
- `apps/studio/app/api/surveys/[id]/analytics/[[...path]]/route.ts` (the `access` branch and the run route's readiness check)
- `ResearchDocuments.tsx`
- `useCopilot.ts` `makeOutput`
- engine `nlIntent.ts` (output recogniser) and `planReads.ts`
- `apps/studio/lib/copilot/reportingGuide.ts`
- `scripts/analysis-apply-test.mjs`
- `scripts/research-plan-docx-test.mjs`
- `scripts/analysis-framework-test.mjs`
