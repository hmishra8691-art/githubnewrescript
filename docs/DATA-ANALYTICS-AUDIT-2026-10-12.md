# Data Analytics audit — 2026-10-12

Scope: the Data Analytics module (analysis plan → Analysis tab → reports → sharing / runtime → exports), plus the
intelligent reporting and Intelligent Mode additions asked for in the brief. This was an audit and repair, not a
redesign: the authoring / runtime separation, the single catch-all analytics route, the `analytics_*` tables and the
existing export formats are unchanged. **No migration is required.**

Commits (cloud repo, not pushed — only the user pushes): `98653c2` (phases 2–3: export, snapshot, state, charts),
`54ed717` (plan review), `37f9704` (report builder + animated story), and the phase 5 commit (Ask tab).

## 1. Root causes

| Symptom in the brief | Root cause | Fix |
|---|---|---|
| Export failed (500) `Cannot read properties of undefined (reading 'flatMap')` | `insights` / `executive_summary` blocks saved without `analysisIds` (the "all analyses" default) were read unguarded by the PPTX builder, the compute step, the findings report and the viewer. | One helper, `blockRefs` (`reportAnalysisIds`, `summaryAnalysisIds`), answers "which analyses does this block read" everywhere; saved reports are normalised on PUT; the export route checks there is data, builds inside a guard, validates the file and returns a sentence + reference, never the raw exception. |
| Shared report / runtime at 0% / n = 0 while the authoring preview was populated | (a) the builder rewrote a saved analysis's dataset with the workspace selector on mount (twice under React strict mode); (b) planned analyses kept a stale environment (plan defaulted to LIVE); (c) `responses` was the base of whichever analysis came back first; (d) publish froze blank reports silently. | Values are compared, not "first run" flags; planned analyses are re-pointed at the dataset the run used (only if never edited); `responses` is the largest base; publish and export refuse a blank or partial snapshot unless forced (`checkSnapshot`); the viewer says "no respondents" instead of drawing zeros. |
| Columns showing only "has a base of 20…" and blank sections | One warning per column, zero bases rendered as 0.0%, runner exceptions surfaced raw. | Per-column base warnings collapse to one sentence, long lists fold behind the first three, zero bases render blank, weighted n follows the valid base, exceptions become a structured error with an actionable message. |
| Save / unsaved / stale confusion, double requests | Order-sensitive JSON comparison, concurrent saves, late responses overwriting newer state, stale errors never cleared. | Canonical (key-sorted) comparison, one save at a time, latest-run-wins, export / save-chart / add-to-report refuse stale results, a failed save aborts publish, results reload after save. |
| Irrelevant, duplicate or uncomputable analyses in the plan | Plan items were saved without review (variable not in the survey, mean of a text answer, a crosstab with an empty axis, a chi-square beside the crosstab that already carries it). | `planCheck`: `validateAnalysis`, `reviewPlanned`, `reviewAgainstSaved`, `analysisSignature`. "Create the planned analyses" reports what it blocked or skipped, with the reason; the rail separates generated analyses from the researcher's own. |
| Wrong charts for the question type | Chart choice looked at result shape only. | `questionChart`: multi-select → horizontal bars with denominator, Likert → diverging, numeric → histogram / box, no means for categoricals, no lines without ordered data, small-base notes; a saved choice the data can no longer draw falls back and says so. The person can still choose any valid chart, and it persists. |

Not proven (no database access from the audit environment): the exact producer of the undefined `analysisIds` in
the reporter's saved report, and which of (a)–(d) above produced their particular 0% share. All four mechanisms were
reproduced and fixed; to confirm on their data, compare `analytics_report_versions.snapshot` with
`analytics_analyses.definition->'dataset'` for the affected report in Supabase.

## 2. Delivered

- **Plan & analysis integrity** — `planCheck` (shared by the plan, the builder and Ask); duplicate detection by what an
  analysis computes, not its name; a significance test of a variable against itself is now an error.
- **Sharing / runtime / exports** — snapshots are validated at publish, share and export; the share page reads only
  the frozen snapshot (no authoring credentials, works after the author leaves); exports report gaps beside the
  download and never claim success for an empty file.
- **Report builder** (Reports → "Build with Rescript") — objective, key questions, audience, tone, scope; a review
  step (what was chosen and why, each chart's reason and denominator, what was left out and why, key questions
  nothing answers); nothing is saved until Create. Reports are drafted only from saved analyses and their computed
  results.
- **Animated story** — scene order objective → sample → findings → comparisons → differences → insights →
  implications (labelled "not a finding") → summary; preview, edit text, change chart (valid ones only), hide,
  reorder, regenerate a scene, export as one self-contained animated HTML file (inline SVG, keyboard controls,
  optional narration through the existing TTS provider and meter). Shared links play the story from the frozen
  snapshot in a sandboxed iframe. This story is HTML only. When this audit was done there was no video renderer; the
  separate "story report" pipeline (`packages/reportvideo`, Reports → Story reports) now produces editable PowerPoint
  and verified MP4, and the two coexist (see Limits). The HTML file plays in any browser and can be screen-recorded.
- **Intelligent Mode for analytics** (new **Ask** tab) — plain-language requests become a *proposal*: cross-tabs
  "X by Y and Z", significance tests, distributions, "remove redundant analyses", "choose the best chart for each
  question", a named chart for a question, a management summary / report / animated report. Every item shows why it
  was proposed, what it does, anything blocking it, and the status "Proposed — not applied" until applied. Applying
  re-validates each item on the server against the live survey, saved analyses and results; blocked items are shown
  with the reason and never run; one failure does not stop the rest. The last batch can be undone (a chart edited
  since is left alone). Charts can be swapped for another that suits the result. Reports are not created from Ask —
  they open in the report builder, pre-filled, for its review step. No operation carries a statistic; a model, when
  configured, is only asked about the parts the rules could not read, answers in the same closed vocabulary, and its
  operations go through the same validation.

## 3. Verification (actual results)

- `packages/analytics`: 332 tests pass (includes 19 reading-engine tests, the same-variable regression, builder /
  story / plan tests).
- `apps/studio` lib: 304 tests pass (includes 6 apply / undo tests that run the real statements against an
  in-memory database: duplicate-in-batch, soft delete + chart restore, report-used analysis, tenant scoping, chart
  change + undo, blocked chart).
- Studio typecheck clean; `scripts/auth-guard-audit.mjs`: 171 handlers, 0 problems; public docs check current.
- Browser suites (fake backend, **real** analytics engine, real UI): `analytics-audit-test` (16 checks),
  `report-builder-test` (22 checks, incl. Chromium playback of the exported story with no console errors or network,
  and the shared-link story), `analytics-ask-test` (17 checks).
- Mutation checks ("every fix gets a test, and the test gets mutation-checked"): phase 4 26/26 source + 8/8 UI;
  phase 5: every reading-engine, apply / undo and UI mutation is caught, after strengthening the tests that first
  let mutants survive; one check in the apply code that validation already made unreachable was removed (option-flag columns, ids from the browser, stale-proposal status, workspace refresh).

The brief's 12 scenarios: single + multi, rating / numeric / ranking, cross-tabs and segments, missing / filtered /
small bases, open text, generated + manual plan, saved-plan reload, authoring preview vs shared runtime, exports,
animated report, regeneration, multi-project no leakage — covered by the suites above at the engine / fake-backend
level. See "Limits" for what was not exercised against a live database.

## 4. Limits and remaining items

- **Live database and real route code were not exercised by the browser suites** (they use an in-process fake
  backend, with the real analytics engine and, for Ask, the real apply / undo code). The route shells, permissions
  and RLS are typechecked and covered by the auth-guard audit but need a smoke test in a deployed environment.
- **Two animated-report features now coexist.** The report builder's story (HTML, drawn from the same saved
  analyses and shared as a frozen snapshot) and the Mac-side story reports (storyboard → PowerPoint / MP4) were built
  in parallel and are not yet wired together. The natural follow-up is to feed the report builder's reviewed draft into
  the story-report pipeline for video, rather than maintain two renderers. Narration needs a TTS provider.
- **Ask history** is kept in the browser (per survey) plus the project audit log (each applied change records the
  request text). There is no server-side history view; the survey Intelligent Mode history is coupled to survey
  definitions and was deliberately not reused.
- The model fallback in Ask and the AI interpretation in the builder are only as good as the configured provider;
  with none configured, the deterministic features work unchanged and say so.
- Ask reads English requests; unrecognised parts are reported as "not understood", never guessed.
- Cross-tab proposals use one table per banner variable (a single wide table is hard to read); weighting is left to
  the workspace dataset settings.

## 5. Configuration / deployment

- No migration. No new environment variable is required for the deterministic features.
- Optional, for AI interpretation, Ask's model fallback and story narration: `AI_API_URL`, `AI_API_KEY`, and
  `AI_TTS_MODEL` for narration (names only; keys are read from the environment on the server and never reach a
  client or a shared page).
- Deploy order: build `packages/analytics` (`dist` is consumed by the studio), then deploy the studio.
- Post-deploy smoke test: build a report → publish → open the share link in a private window; export PPTX / XLSX;
  Ask → "Create cross-tabs of <question> by <question>" → Apply → Undo.

## 6. Merge note (rebased onto the Mac's 10-12 commits)

The four audit commits were rebased onto the Mac's five newer commits (analysis plan in Data Analytics, animated
reports → PowerPoint / MP4, two export-error fixes, report-video deploy split). Conflicts and how they were resolved:

- **Export route**: both sides had fixed the same crash. Kept the Mac's outer guard and its structured log, but the
  response is a sentence plus a reference (the raw cause goes to the log only); my `checkSnapshot` pre-check, file
  validation and `x-rescript-export-notes` are kept.
- **PPTX builder**: the Mac's per-block `drawBlock` isolation is kept; blocks read their analyses through
  `summaryAnalysisIds` so an insights / summary block without `analysisIds` cannot crash it.
- **Report snapshot**: a failed analysis becomes a structured error result (so `checkSnapshot` can see it) rather than
  a silently missing block.
- **Plan integration**: the Mac stamps planned analyses with `options.plannedHash`; that is now ignored by
  `analysisSignature`, otherwise a planned analysis would never match the same analysis built by hand (or by Ask).
- **Tabs / panels**: "Analysis plan" and "Ask" tabs coexist; the Reports tab shows the Mac's Story reports and
  "Build with Rescript" side by side.

Verified after the rebase: analytics 345 and studio lib 320 unit tests, typecheck, auth-guard audit (175 handlers,
0 problems), public docs current, and the browser suites `analytics-ask`, `report-builder`, `analytics-audit`,
`analytics-test`, plus the Mac's `analysis-plan` and `story-report`. Workspace packages (`storage`, `media`,
`reportvideo`, `engine`) must be rebuilt (`dist`) before the studio typechecks, and `pnpm install` picks up the new
`opentype.js` / `@resvg/resvg-js` / `ffmpeg-static` dependencies.
