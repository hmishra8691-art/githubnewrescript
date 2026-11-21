# Respondent Intelligence Engine — Phase 6 status, and where the whole build stands (20 November 2026)

Phase 6 is "engagement": achievements, notifications and reminders, messages, and an accessibility check. It
is the last of the six phases in `RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md`. The second half of this
document sums up all six.

## What was built in Phase 6

**Achievements and streaks** (`packages/engine/src/achievements.ts`). Nothing new is awarded. A survey's
points, level and badges are its existing gamification; the portal reads them back from the person's
completed interviews. The one thing worked out is a streak of on-time completions for an assessment taken
at intervals. The page says achievements are recognition, not money, and cannot be exchanged.

**Notifications** (`supabase/migrations/0106_portal_notifications_messages.sql`). A notice says that
something happened and names the assessment. It never carries an answer, a score or a message's text. Each
happens once. It appears in the portal and, when the person has an email address, as an email with the same
sentence and a link.

| Notice | When | Who sends it |
| --- | --- | --- |
| The next one is due | A repeated assessment has reached its due date | The hourly reminder job |
| Closing soon | An assessment the person has not done closes within two days | The hourly reminder job |
| Your request has been answered | An organiser answers a privacy request | The Studio, on answering |
| You have a new message | The team replies | The Studio, on replying |

Nobody is reminded about an assessment that is paused, closed, not yet open, or out of attempts.

**Messages.** Where the researcher allows it, a respondent writes to the organiser of one assessment, and
the team replies from the Studio. Limits: 20 messages a day per assessment, 4,000 characters. The page says
it is not for anything urgent and is not monitored for emergencies.

**Accessibility checks** (`scripts/respondent-portal-a11y.mjs`). Every portal page, in a real browser, at
1280 and 320 pixels. The checker is checked first: a page with one planted fault per rule must be reported
for all 13 before the portal is looked at.

| Area | What is checked |
| --- | --- |
| Page | Language, title, one main heading, a main landmark, headings that do not skip a level |
| Names | A label on every field; a name on every button, link and picture |
| Contrast | Text against its background, 4.5 to 1 (3 to 1 for large text), chart labels included |
| Keyboard | Tab reaches every control in order, and each shows where the focus is |
| Targets | Controls at least 24 by 24 pixels |
| Reflow | No sideways scrolling at 320 pixels |
| Tables | Header cells |

What the checks found, now fixed: pressing "Change" or "Put this in a paragraph" removed the button and
lost the keyboard focus; the "Change" buttons did not say which answer they change; the agreement checkbox
row was under 24 pixels tall; the focus ring was the browser's default.

**Studio.** Switches for achievements and messages in the portal settings; a Messages card to read and
reply.

## What was tested in Phase 6

| What | How | Result |
| --- | --- | --- |
| Streaks and achievements | 3 unit tests, engine (suite: 2,966); 1 service test | pass |
| Notifications and messages in the portal | 2 service tests (portal tests: 42; survey app suite: 177) | pass |
| Reminder planning, notice wording, replies | 5 unit tests (`portalNotifyCore.test.ts`; Studio suite: 1,319) | pass |
| Migration 0106 | `scripts/portal-notify-sql-test.sql` on a local PostgreSQL 16 built from every migration; run twice; migration applied twice | pass |
| Portal pages | `scripts/respondent-portal-test.mjs`: 15 checks, including notifications and a conversation | pass |
| Accessibility | `scripts/respondent-portal-a11y.mjs`: 8 pages, each at two widths, plus two open states | 0 problems |
| Guards, tenancy, row-level security, dependency boundaries | `pnpm audit:code` | 0 problems |

## What was NOT tested in Phase 6

- **The reminder job has never run.** Its planning is unit-tested; its reading of surveys, people and
  completions is type-checked only. It needs `CRON_SECRET`, the cron entry in `apps/studio/vercel.json`,
  and migration 0106.
- **No notice email was sent.**
- **The Studio Messages card was not opened in a browser**, and replying was not run against a database.
- **Accessibility was checked by a script, not by a person.** No screen reader was used. Only the portal
  was checked, not the Studio screens added in these phases.

## Not built in Phase 6

| Item from the plan | Status | Why |
| --- | --- | --- |
| Community (forums, shared spaces) | Not built | It needs moderation, reporting and a policy before it is safe to switch on. It is a product decision, not a coding gap |
| Rewards with value (vouchers, payments) | Not built | Achievements are recognition only. Paying respondents is a separate, regulated matter |
| A diary calendar | Not built | A diary is an assessment repeated daily; the history, streak and reminders cover it. There is no calendar view |
| Uploading media outside a survey | Not built | Media is collected by survey questions, as before |
| Push or SMS notifications | Not built | Portal and email only |
| Notification preferences | Not built | A person cannot yet switch reminder emails off for themselves |

The last item matters before real use: reminder emails currently have no unsubscribe choice in the portal.

---

# Where the whole build stands

## The six phases

| Phase | What it gave | Patches | Migrations |
| --- | --- | --- | --- |
| 1. Core | Accounts, sign-in, the portal, answer viewing and editing with history, researcher controls | 0206–0209 | 0103 (applied) |
| 2. Scores | Scorecard, personal results, comparisons with a minimum group of 10, PDF report | 0210–0215 | 0104 (applied) |
| 3. Over time | Series, like-for-like change, My progress, individual results for a named professional | 0216–0219 | none |
| 4. Templates | 20 portal templates as configuration, with fixed rules per kind of study | 0220–0222 | none |
| 5. Insight and privacy | Rule-written sentences, projection, optional AI paragraph; consent, privacy requests | 0223–0226 | 0105 (not applied) |
| 6. Engagement | Achievements, notifications and reminders, messages, accessibility checks | 0227–0230 | 0106 (not applied) |

## What holds across all of it

1. **One engine.** One portal, one scorecard, one comparison, one history. Templates are data.
2. **Careful defaults.** Every visibility switch is off until the researcher turns it on.
3. **Groups, never people.** A comparison needs at least 10 people, more for some templates, and hidden
   small groups cannot be worked out by subtraction.
4. **A person's own figures come from their own answers**, recomputed, never from a stored copy.
5. **Like for like.** A change over time is only ever between results scored the same way.
6. **Nothing existing changed meaning.** A survey with no `portal` block behaves exactly as before; every
   suite that existed before these phases still passes.
7. **Before a migration is applied, the feature it serves is simply absent.** Nothing breaks.

## What has never been tested, across all six phases

This is the honest centre of the status. Everything below is type-checked and unit-tested, and none of it
has been exercised for real:

1. **The hosted database, end to end.** Migrations 0103 and 0104 are applied and verified in place, but no
   portal request has run against them. 0105 and 0106 are not applied.
2. **Every Studio screen added in these phases**: the portal settings, scorecard editor, template picker,
   individual results, privacy requests, messages. None was opened in a browser, because the Studio does
   not stay up in the build environment.
3. **Real email**: invitations, password reset, notices.
4. **A real AI provider** for the optional paragraph.
5. **The scheduled reminder job.**
6. **Real respondents' data**: scores produced by actual interviews through the final save, a real series
   across two published surveys, real group sizes.
7. **Volume.** No load test.
8. **Security review by a person.** The guards are audited by script; nobody has attacked it.
9. **Accessibility by a person**, and any language other than English.

## Before real respondents use it

In order:

1. Push the code and deploy it. Apply 0105 and 0106.
2. Walk one test survey through everything with two or three colleagues as respondents: create accounts,
   accept the invitation, take the survey, see results and the PDF, change an answer, retake it, see
   progress, file a privacy request and answer it, send a message and reply. Then with 10 people, check a
   comparison appears.
3. Have the consent notice and the health-template wording reviewed by someone qualified.
4. Decide about reminder emails: add a way for a person to switch them off before sending any.
5. For health use: the hosting and email agreements, a risk analysis and legal review are still required.
   The software has the technical safeguards; it is not by itself compliant with HIPAA or similar.
6. Decide the open questions: named-respondents-only access for a clinician, an assistant, community,
   rewards with value.
