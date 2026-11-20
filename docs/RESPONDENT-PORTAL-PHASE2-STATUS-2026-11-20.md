# Respondent Intelligence Engine — Phase 2 status (20 November 2026)

Phase 2 is "assessment intelligence": a respondent's own scores, what they mean, and how they compare with
other people. It builds on Phase 1 (`RESPONDENT-PORTAL-PHASE1-STATUS-2026-11-20.md`). The plan for all six
phases is in `RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md`.

## What was built

**The scorecard** (`packages/schema/src/portal.ts`, `packages/engine/src/scorecard.ts`). A survey names its
scores in `def.portal.scorecard`. A score does not mark anything a second time; it points at one of four
sources:

| Source | What it reads |
| --- | --- |
| Answers added up or averaged | Single-choice, rating and grid-row answers, with reverse-keyed items |
| A calculated variable | A value the survey already computes (the validated scales produce these) |
| The test's total marks | The knowledge-test marking engine |
| One topic of the test | The same engine, one topic |

Each score can have a lowest and highest possible value, a direction (higher or lower is better), named
ranges ("Low", "Moderate", "High") with a sentence each, and the survey can have one headline figure from 0
to 100. A score that cannot be worked out is shown as missing with the reason, never as zero.

**Comparisons** (`packages/analytics/src/benchmark.ts`). A respondent is compared with everyone who took the
survey, and with their own group in each grouping the researcher defines (by a question or a field of the
respondent list). They see a count, an average, and "higher than N% of the group".

**Storage** (`supabase/migrations/0104_portal_scorecards.sql`). `portal_scorecards` keeps one row of scores
per completed interview; `portal_benchmarks` keeps one comparison snapshot per survey. Scores are stored at
the final save and updated when a respondent changes an answer.

**The portal** (`apps/runtime`). "My results" on the assessment page: each score with its bar, range name and
comparisons; a print layout; and "Download PDF".

**The PDF** (`packages/exporters/src/pdf.ts`, `apps/runtime/lib/portal/report.ts`). A generated file with the
same content as the results page, made on request and never stored.

**The Studio** (Distribution tab, Respondent portal, "Scores and comparisons"). Define the scores and
groups, choose what respondents see, and "Score existing responses" for answers collected before the
scorecard existed or changed.

## Privacy rules, as built

1. Three separate switches, all off by default: respondents see their scores; the range name; a comparison.
2. No figure is shown for a group of fewer than 10 people who have that score. The researcher can raise
   the minimum, not lower it; the schema refuses a value under 10.
3. Complementary suppression. If the hidden people in a grouping total fewer than the minimum, the smallest
   shown group is hidden as well. Otherwise "everyone" minus "the shown groups" would describe the few.
   People who gave no group count as hidden. With two groups, one large and one small, neither is shown.
4. A respondent is compared with their own group only. No other group's figures are sent to their browser.
5. The snapshot holds no person: per group a count, mean, spread and 101 percentile cut points. The cut
   points stay on the server.
6. A person who took the survey twice counts once, with their latest completed attempt.
7. Scores made with a different scoring or grouping are never mixed into a comparison. They are left out
   until scored again.
8. A person's own scores are always recomputed from their answers. They never depend on a stored row.
9. For a survey that is not a knowledge test, the results carry the line "Scores describe the answers you
   gave. They are not a diagnosis or professional advice."

## What was tested

| What | How | Result |
| --- | --- | --- |
| Scorecard: sources, reverse items, ranges, missing scores, fingerprint, visibility, definition problems | 11 unit tests, engine (suite: 2,940) | pass |
| Benchmarks: floor of 10, complementary suppression, standing, own group only, one per person | 8 unit tests, analytics (suite: 893) | pass |
| Portal service: permissions, comparison, small groups, old scorings, failing store, edits, isolation | 6 new tests on the in-memory store (portal tests: 25; survey app suite: 153) | pass |
| Migration 0104 | `scripts/portal-scorecards-sql-test.sql` on a local PostgreSQL 16 built from every migration; run twice; migration applied twice | pass |
| PDF writer | 4 tests; files checked with `qpdf --check` and read back with `pdftotext` | pass |
| PDF report | 6 tests: content matches the page wording, absent parts are absent, multi-page, unsupported scripts | pass |
| Results page and download | `scripts/respondent-portal-test.mjs` in a real browser on the sandbox: 12 checks, including what the server sends, print layout, phone width, the download, and another person's report being "not found" | pass |
| Studio scoring logic | 5 unit tests (`portalScoresCore.test.ts`; Studio suite: 1,310) | pass |
| Guards, tenancy, row-level security, dependency boundaries | `pnpm audit:code` | 0 problems |

## What was NOT tested

- **Nothing ran against the hosted database.** Migrations 0103 and 0104 are not applied. The database
  queries in `supabaseStore.ts` (scores, snapshot), in the final save, and in `portalScores.ts` are
  type-checked only.
- **The Studio screen was not opened in a browser**, for the same reason as in Phase 1. The scorecard
  editor is type-checked; its logic helpers are unit-tested; the screen itself is not.
- **"Score existing responses" was not run against real data.** Its scoring step is unit-tested; the paging
  over the responses table is not.
- **The portal browser test used seeded data** (one person and 22 seeded colleagues), not scores produced by
  real interviews through the final save.
- No test with a large survey: the snapshot rebuild reads up to 50,000 stored scores on a page view.
- The PDF was not opened in Adobe Reader, Preview or a phone viewer; it was validated with `qpdf`, read
  back with `pdftotext`, and rendered once with `pdftoppm`.

## Known gaps in Phase 2

1. **The PDF file carries Western European text only** (English, French, German, Spanish, Portuguese,
   Italian, Dutch, Nordic). For Hindi, Arabic, Chinese, Greek, Cyrillic and other scripts the server
   refuses to make the file and the page points to Print, where the browser's "Save as PDF" handles every
   script. Supporting those scripts in the generated file needs embedded fonts and text shaping.
2. **Percentages are approximate by one or two points**, because they are read from 101 cut points rather
   than from every score.
3. **Comparison groups are fixed by the researcher.** A respondent cannot choose a filter (age band, period).
4. **Charts are bars.** No distribution curve, radar or trend chart yet; trends belong to Phase 3.
5. **Researchers have no screen of individual scores yet**, and scores are not in the data exports. The
   individual-results view, with its own permission, is Phase 3.
6. **A changed scorecard needs two steps**: publish, then "Score existing responses". Until the second step,
   earlier responses are left out of comparisons (their owners still see their own scores).
7. A comparison snapshot is kept for 15 minutes, so a new or erased response can take that long to be
   reflected in group figures.
8. Quota counts are still not re-counted on a respondent's edit (Phase 1 gap, unchanged).

## To switch it on

1. Apply migration 0103, then 0104.
2. In the Studio: Distribution, Respondent portal, turn the portal on, add scores, choose what respondents
   see, save and publish.
3. Press "Score existing responses" if the survey already has completed responses.
4. Walk one test survey end to end before real use: complete an interview, sign in to the portal, check the
   results, the comparison (it needs ten people) and the PDF.

## Next

Phase 3 is longitudinal: series of assessments, a person's history and change over time, year-on-year and
population trends, and the individual-results view for a named professional. It starts when asked.
