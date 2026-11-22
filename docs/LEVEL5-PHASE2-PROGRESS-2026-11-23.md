# Level 5 roadmap, Phase 2 (Essentials) — progress (updated 24 November 2026)

Phase 2 is the essentials for all seven areas, about twelve weeks of work in the roadmap. This document is kept
as it goes: what is done, what was tested, what is next. AI design agents come first, as asked.

## Done so far

### A7 — Design calculators as tools

Six calculations a study design rests on. Each returns its number, the working, and every assumption it made
where nothing was given.

| Tool | What it answers |
| --- | --- |
| `design.sample_size_margin` | Completes needed for a margin of error (share, confidence, small population, design effect) |
| `design.sample_size_difference` | Completes needed to tell two shares or two means apart (significance, power, number of groups) |
| `design.precision` | What a sample gives: the margin of error, and the smallest difference between groups it can detect |
| `design.quota_cells` | Quota targets from shares, summing exactly to the completes, independent or crossed, small cells flagged |
| `design.interview_length` | Interview length from the questionnaire: typical respondent and longest path, by kind of question |
| `design.field_estimate` | Starts, invitations and cost from the incidence, rates and price given |

They are in the tool registry as a new kind of tool, a calculation: read-only, no approval, nothing written,
no model. The Studio's tools endpoint answers them directly.

Rules they follow:

- **No market figure is assumed.** With no incidence there are no starts; with no price there is no cost. The
  answer lists what could not be worked out.
- **Statistical defaults are stated.** 95% confidence, 50% share, 80% power, design effect 1 are used when not
  given, and each is listed as an assumption.
- **The interview length is a planning estimate.** It uses working rates (reading speed, seconds per answer by
  question type, 60% of conditional questions seen, loops run for 40% of their options). The answer says these are
  not timings measured on the survey. Every rate can be overridden.

### A7 — Intelligent Mode answers design questions from them

Before this, "How many completes do I need for a margin of error of 3%?" was answered "The plan needs about 30
completes": the sentence was read as a question about the analysis plan and the margin was ignored. That was a
wrong answer, found while building this.

Now these are read and worked out with no model:

| Sentence | Answer |
| --- | --- |
| How many completes do I need for a margin of error of 3%? | You need 1,068 completes for a margin of error of ±3 points |
| What sample size do I need to detect 40% vs 50%? | 388 in each group, 776 in all |
| What margin of error does 400 completes give? | ±4.9 points |
| How long is this survey? | Minutes for a typical respondent and the longest path, marked as an estimate |
| How many invitations for 1,000 completes at 25% incidence and 10% response? | 4,000 starts, 40,000 invitations; cost not worked out, no price given |

Each answer shows its working and assumptions. A calculation that cannot be done (a margin of 80%) is refused
with the reason. Edits, data questions, briefs and "how long will fieldwork take" are left to their own readers.

### A correction to Phase 1

The large-survey benchmark claimed display conditions it did not have (see the note in the Phase 1 status). Fixed,
re-measured, and a test now checks it.

### A5 — Verifier feedback as observations (24 November)

A verification used to end in sentences ("expectation broken: Q7 is shown, 3 of 40 respondents"). It now returns
observations: data an agent can act on and a person can read.

| Field | What it holds |
| --- | --- |
| Kind | A question nobody was shown, a broken expectation, a script error, an invalid answer accepted, nobody completing, an unbalanced rotation, a blocked validation, a critical review finding |
| Where | The questions and the page |
| Condition | The condition involved, in words, and the questions it reads |
| Respondents | Up to three simulated respondents it happened to, with only the answers that matter, where they ended and on which page |
| Seen | How often: n of N |
| Fix | The engine's own mechanical fix as actions, when it has one. Proposed, never applied |
| Look | One sentence on what to examine next |

It also finds the path that failed. Example, on a survey where Q6 shows only if Q2 is "Never" and Q2 "Never" is
also screened out:

> Q6 was shown to none of 60 simulated respondents: 54 reached its page and its display logic hid it. 6 answered
> so that it should show, and never reached it: 6 ended screened after page p2.
> SIM-…-0011 (simulated, ended screened on p2): Q2 = "never"
> Look: The answers that should show Q6 also end the interview or skip past it. Find the skip, screen-out or quota
> on Q2 that fires first.

Intelligent Mode's simulation answer ("simulate 40 respondents") now shows these under "What was seen" instead of
the old problem sentences. Every respondent is labelled simulated. Advice from the review (wording, possible
duplicates) is deliberately not reported as a failed check.

## The scorecard after this

10 benchmarks, 8 measured. 17 of 33 metrics with a target meet it.

| Benchmark | Measured | Target |
| --- | --- | --- |
| Design questions answered with the right number and its working (12 sentences) | 83.3% | 95% |
| Other sentences wrongly taken as design questions (4 sentences) | 0 | 0 |
| Planted defects the verifier reports on the right question (7 defects) | 100% | 99% |
| Of those, reported with the condition and the simulated respondents (5 that should) | 100% | 99% |
| Problems reported on sound surveys (2 surveys) | 0 | 0 |

The verifier figure is on seven defects that I planted and I graded, on one 14-question survey. It shows the
mechanism works on those; it is not evidence about defects in real surveys.

The two design questions not answered are free phrasings: "We expect awareness to go from 40% to 50%. How many
people per wave to see that?" and "Roughly how many minutes will people spend on this?" They go to the model.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Formulas against textbook values (385, 1,068, 2,401, 664, 323; 388 per group; 64 and 394 per group; ±3.1) | `designCalc.test.ts`, 8 tests | pass |
| Quota rounding sums exactly; small cells flagged; shares scaled when they do not add to 100 | same | pass |
| Interview length against a hand calculation, with a loop and a conditional question | same | pass |
| Field estimate assumes no rate it was not given | same | pass |
| The engine's formulas agree with the analytics package's across 180 margin cases and 16 difference cases | `sampleSize.test.ts`, 1 new test | pass |
| Design questions read in several phrasings; 14 sentences that must be left alone | `designIntent.test.ts`, 5 tests | pass |
| Observations on surveys with planted defects: impossible condition, screened before the question, everyone screened, broken expectation, critical review finding; a sound survey reports nothing | `observations.test.ts`, 6 tests (templates suite: 180) | pass |
| The simulation answer in Intelligent Mode carries the observation, its respondents and what to look at | `simulationRequest.test.ts`, extended (Studio suite: 1,331) | pass |
| The whole engine suite | 2,989 tests | pass |
| Guards, tenancy, dependency boundaries, unused exports | `pnpm audit:code` | 0 problems |
| All benchmarks against the previous baseline | `pnpm bench` | no regression |

## What was NOT tested

- **Not in a browser.** The design answer and the "What was seen" section use the existing answer card in
  Intelligent Mode; I did not open either and look.
- **The tools endpoint's new branch was type-checked, not called over HTTP.**
- **No language model.** The agent does not yet call the calculators or read the observations on its own; that is
  the agent loop (A4). Today they are reached by sentences and by the tools endpoint.
- **The interview-length rates are not validated against real timings.**
- **The verifier on scripts, quotas, loops and rare answer combinations.** None of the planted defects uses them.
  A defect that needs a rare combination can be missed at 60 respondents; the observation for a condition that was
  never true says so.
- **The server simulation route still returns the old verdict sentences.** Only the in-conversation simulation
  shows observations.
- **Quota cells are not yet written into the survey from a sentence.**
- **English only.**

## Next in Phase 2 (AI design agents first)

| Item | State |
| --- | --- |
| A3 Unified plan format over the tool registry | Next |
| A6 Clarification policy, A8 reasons on every choice | After A3 |
| A4 Agent loop, A15 model routing | Needs the model baseline run |
| Defects from the Phase 1 baseline (wrong "move S1" proposal, the "attention check" misreading, 394 ms edits) | Open |
| The other six areas' Phase 2 essentials | Not started |

Still open from Phase 1: the model baseline on the two models (`pnpm eval:ai`) has not been run. I have no key
here, so it has to be run where the key is.

## Nothing to apply

No migration. No setting.
