# Respondent Intelligence Engine — Phase 4 status (20 November 2026)

Phase 4 is the templates: twenty kinds of portal as configuration over the one engine built in Phases 1 to 3.
The plan for all six phases is in `RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md`.

Phase 4 has **no database migration** and adds no new engine. A template is an entry in one list
(`packages/engine/src/portalTemplates.ts`).

## A note on the list

The original brief named twenty templates. That list was no longer available when this phase started, so
the twenty below were proposed and approved on 20 November 2026. If the brief's list differs, changing a
template is editing its entry; no other code depends on which twenty they are.

## What a template is

| Part | What it does |
| --- | --- |
| Words | What respondents read: the kind of thing ("check-in", "test", "wave"), who runs it ("your care team", "your teacher"), the heading over their results, the start and retake buttons |
| Note | The sentence under a person's results, saying what the scores are and are not |
| Colour | The accent of that assessment's pages |
| Starting settings | Identity, what respondents see, editing, attempts, the minimum group, the repeat interval. The researcher can change every one |
| Fixed rules | A few settings that kind of study must not loosen (below) |
| Usual scores | Names of the scores such a study normally defines. Names only: the researcher maps their own questions |

## The twenty

The six marked "first" are the industry portals offered at the top of the picker.

| Template | Sector | First | Fixed rules |
| --- | --- | --- | --- |
| Employee engagement | Work | yes | Group of at least 10 |
| Pulse check | Work | | Group of at least 10 |
| 360 feedback | Work | | No comparison with others |
| Compliance and safety test | Work | | No editing; no comparison |
| Skills assessment | Work | | None |
| Candidate assessment | Work | | No comparison; no editing; answers never shown back |
| Coaching progress | Work | | No comparison |
| Personality profile | Work | | No editing; group of at least 20 |
| Training and certification | Learning | yes | No editing |
| Student assessment | Learning | yes | No editing |
| Course feedback and learning progress | Learning | | Group of at least 10 |
| Patient-reported outcomes | Health | yes | Group of at least 20 |
| Wellbeing check-in | Health | | Group of at least 20 |
| Health and lifestyle appraisal | Health | | Group of at least 20 |
| Study diary | Research | | No comparison |
| Tracking panel | Research | yes | Group of at least 10 |
| Consumer panel member | Research | | Group of at least 10 |
| Customer satisfaction | Customer | yes | No comparison |
| Community and citizen survey | Public | | Group of at least 30 |
| Athlete and performance tracking | Sport | | None |

## Rules, as built

1. **Fixed rules are applied where the settings are read**, in one function (`portalSettings`). Every route,
   the scoring, the comparison and the edit check pass through it, so a later edit of the survey, or a
   screen that forgets, cannot loosen them. The saved settings are not rewritten.
2. **Health templates** carry a note that the scores are not a diagnosis or medical advice and to speak to a
   health professional; start with comparison off; and never compare in groups under 20.
3. **Nothing shown to a respondent labels them.** No template's words or note say "patient", "clinical" or
   "HIPAA" (a test checks this). "Patient-reported outcomes" is the researcher's name for the template.
4. **A survey with no template, or an unknown one, behaves exactly as before**: the same settings object is
   returned untouched.
5. **Applying a template keeps what was built**: the scores, the comparison groups, the series and the
   lists of locked questions. It sets the switches and limits.
6. Every accent colour meets the contrast standard for white text on it (4.5 to 1), checked by a test.

## What was built

**The catalogue** (`portalTemplates.ts`): the twenty entries, `applyPortalTemplate`, `enforcePortalTemplate`,
`portalPresentation`, `templateRules`.

**The portal** (`apps/runtime`). Each assessment presents by its template: its kind on the dashboard tile,
its buttons, the heading over the results, the note under them, its colour, and the same heading and note in
the PDF report. Sentences the engine produces ("locked by the organiser", "this assessment has ended") are
re-worded on their way out to the template's two names.

**The Studio** (Distribution, Respondent portal). A template picker showing the summary, what respondents
will see, the scores usually defined, and what the template always applies.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Catalogue: 20 unique templates, the six first, each parses as settings, defaults obey their own rules, contrast, health rules, no labelling words | 8 unit tests, engine (suite: 2,958) | pass |
| Enforcement where settings are read; no template means no change; applying keeps what was built | in the same 8 tests | pass |
| Portal: words, note and colour per assessment; a marked test; fixed rules reaching the respondent (candidate assessment, health minimum of 20); re-wording | 4 new service tests and 1 report test (portal tests: 37; survey app suite: 165) | pass |
| Portal pages with a template | `scripts/respondent-portal-test.mjs` in a real browser on the sandbox: 13 checks; one seeded assessment uses the employee-engagement template, the others none | pass |
| Guards, tenancy, row-level security, dependency boundaries | `pnpm audit:code` | 0 problems |

## What was NOT tested

- **The Studio template picker was not opened in a browser.** The functions it calls are unit-tested.
- **Only one template was seen in a browser** (employee engagement). The other nineteen are covered by the
  catalogue tests, which check their data, not their look on a page.
- **No template has been used on a real survey** on the hosted database.
- The wording of the twenty was written for this build and has not been reviewed by people in those
  fields. The health notes in particular should be read by someone qualified before real use.

## Known gaps in Phase 4

1. **Templates do not create questions.** A template names the scores a study usually defines; it does not
   add a questionnaire or map items to scores. The survey template library (`@rescript/templates`) is
   separate, and joining the two (a survey template that arrives with its portal template and scorecard) is
   not built.
2. **Words are English only.** The portal pages themselves are also English; translating the portal is not
   part of this phase.
3. **A researcher cannot edit a template's words** for one survey. They choose a template or the standard
   portal.
4. **The dashboard and account pages are shared across assessments**, so they stay in the standard words
   and colour. A person with a test and a check-in sees both on one neutral page.
5. **Re-wording covers two names** ("the organiser", "this assessment"). Other fixed sentences in the
   portal are the same for every template.
6. **Workspaces cannot add their own templates.** The list is in the code.

## To use it

In the Studio: Distribution, Respondent portal, Template. Choose one, read what it always applies, press
"Use this template", adjust the switches, define the scores, save and publish.

## Next

Phase 5 is AI and prediction: summaries and explanations on permitted data, change detection and forecasts
with stated uncertainty, and the consent and privacy-request screens. It depends on the AI budget decision
that is still open. It starts when asked.
