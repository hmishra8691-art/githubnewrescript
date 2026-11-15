# Intelligent analysis engine — planned analyses from one sentence (2026-11-15)

Patch 0159. This extends Intelligent Mode's Ask (Analytics → Ask, and the Ask side panel). It does not replace it:
requests the planner doesn't need still go to the existing readings (cross-tab, test, descriptive, remove, chart,
report).

## What it does

A researcher types, for example:

> Calculate NPS from Q15 and compare it across Gender and Age Groups at 95% confidence

Ask proposes **one** item, "Calculate “NPS — … by Gender, Age group”". Its explanation lists the eight planning
layers as numbered steps (understood · variables · plan · transform · compute · chart · checks · output) and anything
it assumed, e.g. *"Age was grouped into the standard bands 18–24 … 65+ — say other bands to change them."* Nothing is
written until the researcher applies it.

| Request shape | What is planned |
|---|---|
| `NPS of Q15 by gender and age groups at 95%` | NPS analysis, a Promoter/Passive/Detractor class variable, an age-band variable, a tested table per grouping, 100% stacked chart |
| `NPS by age groups under 30, 30-49, 50+` | the named bands instead of the defaults |
| `Top 2 box of Q12 by gender, exclude don't know` | banner cross-tab with a derived top-2-box row; "Don't know" answers removed from the base |
| `CSAT of Q12 by region` | same as top-2 box, and the CSAT assumption is stated |
| `NPS among respondents aware of Alpha` | a derived "Aware of Alpha" flag and a filter on it (not a grouping) |
| `Show brand awareness Q1 across Q5, Q6 and Q7 at 90% confidence` | multi-banner cross-tab, column-proportion tests at α = 0.10 |
| With an analysis open: `now by region` · `add significance testing at 99%` · `exclude don't know` · `change it to a horizontal bar` | an **update** to that analysis — a new saved version |

## Where the derived variables live

`packages/analytics/src/analysisLayer.ts`. Derived variables are stored **on the analysis definition**
(`options.layer`, `options.layerFilter`). On every run they are recomputed from the raw answers, on a copy of the
dataset. Stored responses and the questionnaire are never written. This gives:

- **Reproducibility**: the definition alone recreates the result.
- **Dependency invalidation**: change the source data or the rule and the next run picks it up. Nothing is cached in
  between.
- **De-duplication**: a derived variable is named from a hash of its rule (`_L_<kind>_<source>_<hash>`). The same rule
  always gets the same name, and `normalizeLayer` merges duplicates.
- **Validation**: each variable reports how many respondents were eligible, populated or missing, and any source
  values no rule covered (left without a value, never forced into a group). Cycles are refused. The report is in
  `result.layer`, shown in the result as "Derived variables and filters", and problems go into the warnings.

Kinds: `group_numeric` (bands), `map_codes` (recode / nets / box groups), `nps_class`, `box`, `flag`, `count`, `mean`.

## Statistics

- **NPS across groups** (`analyses/npsCompare.ts`). Each group's NPS has a standard error on the per-respondent
  +100/0/−100 score, using effective n for weighted data. Pairs within one grouping are compared with a two-sample
  z-test, Holm-adjusted. Interval and test at 90/95/99%. **Not tested, and said so:** groups under 30 respondents
  (shown, marked `n<30`), and groups of a multi-choice grouping (a respondent can be in two groups, so the samples are
  not independent).
- **Cross-tabs** use the existing banner engine: column-proportion letters, Holm by default, small-base warnings.
- No significance result is produced where the data cannot support one.

## Trust boundary

The browser sends the proposal back on Apply. `parseSpec` rebuilds every field: allowed kinds only, bounded strings and
lists, confidence ∈ {0.90, 0.95, 0.99}, chart from the catalogue. `validateAskOp` then re-checks against the survey
as it is now: every derived variable's sources must exist, filters must name real variables, duplicates are refused,
and an update's analysis must still exist in this survey. `validateAnalysis` treats an analysis's own layer variables
as known, so these analyses also pass the normal save and run checks.

## Apply and Undo (Studio)

`apps/studio/lib/analyticsAskApply.ts`:

- `add_analysis` creates the analysis and its version-1 history row (like any created analysis).
- `update_analysis` writes version n+1 only if the row is still at version n (optimistic check), and keeps a history
  row.
- Undo restores version n **from the saved history**, never from the browser. It is skipped if the analysis has
  changed again since.

## Not done (honest list)

- The planner is rule-based. The optional model path in Ask does not yet emit `add_analysis` / `update_analysis`.
  Unusual phrasings fall back to the existing readings or come back as a question.
- Metrics planned: NPS, top-/bottom-2 box, CSAT (as top-2 box), CES (as box). Regression, ANOVA and other tests are
  still requested through the existing "test whether … differs by …" reading. They are not part of a planned analysis.
- Weighting is used when the survey has weighting set up. A request cannot create weights.
- Numeric groupings other than age need named bands. Age with no bands uses the stated default.
- "Aware of X" filters look for an awareness question whose answer list contains X exactly.
- Follow-up edits work on NPS and cross-tab analyses.
- Browser-level UI tests for the new item were not run in this patch. Coverage is unit and in-memory-DB tests (below).

## Tests

- `analysisLayer.test.ts`: transformations at respondent level on a hand-counted 12-respondent survey
  (`analyses/knownFixture.ts`).
- `analyses/npsCompare.test.ts`: every table value and the z-test compared with an independent computation.
- `analysisPlanner.test.ts`: sentence → plan → run. Checks NPS by gender (0 / 40, overall 18.2), age bands
  (out-of-band 17 reported), top-2 box with DK excluded (40% / 75%), aware-of-Alpha NPS (80, n = 5), follow-ups,
  duplicates, browser rebuild, and forged sources.
- `apps/studio/lib/analyticsAskApply.test.ts`: create → update (version 2, history) → undo (version 3 restores) →
  second undo skipped; another survey's analysis cannot be changed.
