# Respondent Intelligence Engine — Phase 3 status (20 November 2026)

Phase 3 is "longitudinal": a person's results over time, and a way for a named professional to follow one
person. It builds on Phases 1 and 2 (`RESPONDENT-PORTAL-PHASE1-STATUS-2026-11-20.md`,
`RESPONDENT-PORTAL-PHASE2-STATUS-2026-11-20.md`). The plan for all six phases is in
`RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md`.

Phase 3 has **no database migration**. It reads what Phases 1 and 2 store.

## What was built

**Series** (`packages/schema/src/portal.ts`). A survey can say it belongs to a series: a key, a name, what
this survey is called in the series ("2026", "Spring term"), and an optional repeat interval in days.
Surveys of one workspace that carry the same series key form one history. A survey that is simply taken
again needs no series: its own attempts are its history.

**The comparability rule** (`packages/engine/src/scorecard.ts`, `history.ts`). Every score carries a
signature of how it was made: its questions by code, their scale ends, reverse-keying, range and direction
(or the test's answer key). Two results are compared only when the signatures are equal.

| Situation | Outcome |
| --- | --- |
| The same scale programmed again in next year's survey | Comparable (codes and scale decide, not internal ids) |
| An item added, removed or reversed; a scale lengthened; another range or direction | Not comparable |
| The score renamed, re-described, or given new range names | Still comparable |

A result that is not comparable is still listed, drawn apart and labelled "scored differently". It is never
used in a change figure.

**Change** (`history.ts`). For each score: the change against the previous like result, since the first like
result, and against the like result closest to twelve months earlier (within 45 days). A change is worded
"Up 2 (from 7 to 9)" and coloured by the score's direction, so "down" is good news for a score where lower
is better. A change below the score's own threshold is "about the same".

**My progress** (`apps/runtime`, `/portal/progress`). One track per series and one per assessment that is in
no series. Each score has a line chart and a table that says the same in words. The average of everyone
appears beside the latest result of an assessment only. A repeated assessment shows when the next one is
due, on the dashboard and on the progress page.

**Individual results for a named professional** (`apps/studio`). A new permission,
`responses.read_individual`, lets a member open one respondent's latest scores and their history in that
survey, from Distribution, Respondent portal.

**Studio settings.** A "changed over time" switch, the series fields, and the per-score "about the same"
threshold, in Scores and comparisons.

## Rules, as built

1. Progress needs two permissions from the researcher: scores, and their history. Either alone shows
   nothing. Both are off by default.
2. A series never crosses workspaces. The same series key in another workspace is a separate track.
3. A person sees only their own results. Every score is worked out again from their own answers.
4. A change figure is always between two like-for-like numbers. Where there is no such pair, there is no
   figure.
5. The average of everyone is shown only where the comparison is permitted and a group of ten exists
   (the Phase 2 rules). It is attached to the latest result of an assessment, not to earlier ones, because
   the stored average is today's.
6. The progress page says that a change describes the person's own answers at two points in time and says
   nothing about the cause, and that scores are not a diagnosis.
7. The individual-results permission is not part of reading response data. The owner and the project admin
   hold it; anyone else needs it ticked. The view shows scores only: no answers, and the name and email
   only for a member who may see contact details.
8. Each opening of a person's results is written to the audit log (who opened whom, not the results), and
   noted in that person's portal access log.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Signatures, comparability, change, year on year, headline, next due | 10 unit tests, engine (suite: 2,950) | pass |
| Progress: permissions, retakes, series, another workspace, scored differently, group average, next due, isolation, long histories | 7 new tests on the in-memory store (portal tests: 32; survey app suite: 160) | pass |
| My progress page | `scripts/respondent-portal-test.mjs` in a real browser on the sandbox: 13 checks, including the chart, the table, the change wording and colour, what the server sends, and phone width | pass |
| The new permission | access suite (136); the pinned role sets were updated on purpose and a test added | pass |
| Individual results logic | 3 unit tests (`portalPersonCore.test.ts`; Studio suite: 1,313) | pass |
| Guards, tenancy, row-level security, dependency boundaries | `pnpm audit:code` | 0 problems |

## What was NOT tested

- **Nothing ran against the hosted database.** Migrations 0103 and 0104 are still not applied. The Studio
  route for individual results is type-checked only.
- **The Studio screens were not opened in a browser**: the "Open this person's results" card and the series
  settings. Their logic is unit-tested.
- **A real series was not walked end to end**: two published surveys with the same series key, one person
  completing both, then the progress page. The browser test used one seeded assessment with three seeded
  attempts; series across surveys is covered by the service tests only.
- No test with long histories on a real database: a progress view reads up to 24 attempts for each of the
  person's assessments.

## Known gaps in Phase 3

1. **Named respondents only is not built.** A member with the individual-results permission can open any
   respondent of that survey, and the platform's rule for extra permissions means they also hold "view" on
   the survey's response data. Restricting a clinician to a list of their own people needs a new kind of
   membership.
2. **The professional's view covers one survey.** It does not follow the person into other surveys of the
   series, because the member's permission is for that project. The respondent's own page does.
3. **No population trend across waves for the researcher.** The respondent sees the group average beside
   their latest result; a researcher's chart of the group over the surveys of a series is not built.
4. **"About the same" is a threshold the researcher types**, not a statistical test. No reliable-change
   index or significance is computed.
5. **The next due date is shown, not sent.** Reminders and notifications are Phase 6.
6. **The PDF report does not include the history.** It covers the latest results (Phase 2). The progress
   page prints.
7. **Whether respondents can see who opened their results** is recorded but not yet shown to them; the
   privacy screens are Phase 5.
8. A series is matched by a key the researcher types into each survey. A mistyped key makes a separate
   track; there is no picker of existing series yet.

## To switch it on

1. Apply migrations 0103 and 0104 (Phase 3 adds none).
2. In the Studio: Distribution, Respondent portal, Scores and comparisons. Turn on "how they have changed
   over time". For a series, tick the series box and use the same key in every survey of it. For a
   repeated survey, set the interval and allow retakes.
3. Save and publish.
4. To let a colleague follow individuals, give them the "Open one respondent's portal results and history"
   permission in the project's access settings.

## Next

Phase 4 is the templates: the 20 portal presets as configuration over this one engine, six industry portals
first. It starts when asked.
