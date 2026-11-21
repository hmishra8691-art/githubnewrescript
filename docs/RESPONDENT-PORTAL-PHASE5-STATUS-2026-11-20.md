# Respondent Intelligence Engine — Phase 5 status (20 November 2026)

Phase 5 is "AI and prediction", plus the consent and privacy screens that earlier phases deferred. The plan
for all six phases is in `RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md`.

## Two decisions taken without asking

The plan said this phase depended on an AI budget decision that was still open. To keep building, two
choices were made. Both are easy to reverse.

| Question | What was built | To change it |
| --- | --- | --- |
| Do respondents' insights need the AI provider? | No. Insights, change detection and projection are fixed rules and arithmetic. They cost nothing and send nothing anywhere. | — |
| Who pays when a respondent asks for the AI paragraph? | The project's existing AI budget, through the same meter as every other AI call a respondent causes. It is off by default and made only when the person presses the button. When the budget refuses, the person sees the rule-written sentences. | Leave the switch off, or change the meter call in `apps/runtime/lib/portal/http.ts`. |

## What was built

**Insights** (`packages/engine/src/insights.ts`). A few sentences about a person's results, each traceable
to its figures: a pattern in the changes, the latest change, the strongest score, the one with most room,
and standing in the group. They state facts only. A test checks that no sentence gives a cause or advice.

**Change detection.** A pattern is reported only with evidence: three like-for-like changes running the
same way, or a latest change at least twice the person's usual one over four or more results.

**Projection.** A straight line through at least four like results, with an 80% range around its next
point, kept inside the score's possible range. When that range would cover more than half the scale, the
page says the results vary too much to project. The page says it is arithmetic, not a prediction.

**The AI paragraph** (`packages/ai/src/index.ts`, `writeResultSummary`). Opt-in. What is sent to the
provider is the rule-written sentences and the word for the assessment ("survey", "test"). No name, no id,
no answer, no question, no group name. The reply is checked before anyone sees it, and discarded if it
contains any of the following.

| Check | Why |
| --- | --- |
| A number that is not in the sentences | The model must not invent a figure |
| Advice ("you should", "try to", "we recommend") | The portal does not advise |
| A cause ("because", "due to") | Nothing here knows why a score changed |
| A health word (diagnosis, treatment, symptom, therapy) | Not a diagnosis |
| A question, a link or an address | Not a conversation, and nowhere to send people |
| Text that reads like instructions to the AI | Prompt-injection guard already used elsewhere |

When the reply is discarded, the provider is down, or the budget refuses, the person sees the rule-written
sentences and is told which they are reading.

**Consent** (`supabase/migrations/0105_portal_consent_requests.sql`, `PORTAL_CONSENT` in
`packages/access/src/respondent.ts`). A versioned notice. It is read and agreed to before an invitation is
accepted, and recorded with its version. An account that has not agreed still works (profile, password,
sign-out) but its assessments are hidden everywhere until it agrees. The agreement can be withdrawn.

**Privacy requests.** A respondent asks the organiser of one assessment for a copy of their data, a
correction or deletion, from Profile and security. The organiser answers in the Studio (Distribution,
Respondent portal, Privacy requests): done, or declined with a reason. The respondent sees the answer.

**Who opened my results.** The account page lists the times an organiser's staff opened the person's
individual results (recorded since Phase 3).

**Studio.** Three switches under Scores and comparisons (sentences, projection, AI paragraph) with what is
sent and who pays; the Privacy requests card.

## Rules, as built

1. Sentences, projection and the AI paragraph are three separate switches, all off by default.
2. Health templates and the candidate assessment never show a projection and never send anything to the AI
   provider, whatever is switched on. This is enforced where settings are read, like the other template rules.
3. The AI paragraph is made only when the person asks, is labelled as written by an AI system, and says
   what was sent.
4. The AI action is rate-limited like a sign-in attempt (20 a minute for one address), not like a page view.
5. A privacy request goes to one assessment's organiser. One open request of each kind per assessment; ten
   open requests per person.
6. Answering a request records the outcome. It does not copy, change or delete data. The organiser does
   that first with the project's own tools.
7. Listing requests needs the permission to see contact details; answering needs the permission to manage
   responses. Each answer is in the audit log (the kind and the outcome, not the text).
8. Before migration 0105 is applied, nothing changes: the portal cannot tell whether a person has agreed,
   so it behaves as it did before consent existed.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Insights, patterns, projection; wording has no cause or advice | 5 unit tests, engine (suite: 2,963) | pass |
| Template rules for projection and AI | template tests, updated | pass |
| The AI reply guard, and the stand-in provider | 2 tests, AI package (suite: 155) | pass |
| Portal: sentences, the AI paragraph and what is sent, health template, projection | 4 service tests | pass |
| Portal: notice at invitation, hidden assessments, withdraw, requests, staff views, store that cannot tell | 5 service tests (survey app suite: 174) | pass |
| Migration 0105 | `scripts/portal-privacy-sql-test.sql` on a local PostgreSQL 16 built from every migration; run twice; migration applied twice | pass |
| Request rules | access suite (137); `portalRequestsCore.test.ts` (Studio suite: 1,314) | pass |
| Portal pages | `scripts/respondent-portal-test.mjs` in a real browser on the sandbox: 14 checks, including the sentences, the paragraph on request, the projection, the notice at invitation, withdrawing and agreeing again, and a request | pass |
| Guards, tenancy, row-level security, dependency boundaries | `pnpm audit:code` | 0 problems |

## What was NOT tested

- **No real AI provider was called.** The browser and unit tests use the stand-in provider, which joins the
  sentences. How a real model words the paragraph, and how often the guard discards it, is unknown.
- **The meter was not exercised against the hosted database.** The sandbox runs unmetered.
- **Migration 0105 is not applied.** The consent and request queries are type-checked only.
- **The Studio screens were not opened in a browser**: the three switches and the Privacy requests card.
- **No request was walked end to end** from a respondent to a researcher's answer and back on a real database.
- The projection was tested for arithmetic and limits, not against real score histories.

## Known gaps in Phase 5

1. **There is no assistant.** The plan listed a conversational assistant. It was not built: a respondent
   cannot ask questions about their results. Only the one-paragraph re-wording exists.
2. **The AI paragraph is not cached.** Each press is a new call and a new charge, within the rate limit.
3. **The notice is words about what the software does, not legal text.** It needs review for each market
   before real use. Changing it means changing its version, which asks everyone to agree again.
4. **A request is answered, not carried out, by the software.** There is no one-click "send this person
   their data"; the organiser exports, corrects or erases with the existing tools.
5. **No deletion of the portal account itself.** A person asks each organiser to delete their data; closing
   the shared account is not offered.
6. **No notification** when a request is filed or answered. The researcher sees it in the Studio; the
   respondent sees the answer on their account page. Notifications are Phase 6.
7. **Projection is a straight line.** No seasonality, no model of the scale's reliability. That is why it
   needs four results, shows a range, and refuses when the range is wide.
8. **After 0105 is applied, people who already have an account are asked to agree** the next time they open
   the portal. That is intended, but they should be told to expect it.

## To switch it on

1. Apply migration 0105.
2. Insights: Studio, Distribution, Respondent portal, Scores and comparisons. Tick the sentences, and if
   wanted the projection and the AI paragraph. Save and publish.
3. Have the notice reviewed before inviting real respondents.

## Next

Phase 6 is engagement: notifications and reminders (including the next-due date and request answers),
rewards, diary and media entries, messaging, and an accessibility review. It starts when asked.
