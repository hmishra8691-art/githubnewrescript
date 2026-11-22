# Level 5 roadmap, Phase 2 (Essentials) — progress (updated 25 November 2026)

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

### A3, A6, A8 — One plan format, with reasons and a clarification policy (25 November)

Every reader now produces the same thing, an agent plan:

| Part | Rule |
| --- | --- |
| Step | One call of one tool from the registry, with its input and why. A step with no reason is refused |
| Assumption | Something decided without asking, with its reason and how to overturn it |
| Question | Lists what its answer would change (audience, sample, quotas, method, questionnaire, length, fieldwork, budget, analysis, language) |

- A plan a model writes is read against the registry. An unknown tool, a missing reason or a bad dependency
  refuses the whole plan, with the nearest real tool names.
- Risk and approval are never taken from the plan. A plan that marks a deletion "safe" still needs explicit approval.
- Checking a plan runs every step on a copy of the survey and reports what each would do and destroy. Nothing is
  written. The Studio's tools endpoint does this for a posted plan.
- **Clarification policy:** a question is asked only if its answer changes the design and it has no defensible
  default. At most two are asked, the ones that move the design most. A question with a default becomes an
  assumption. A question that changes nothing is dropped. One that must be asked but is over the limit is held
  open and said, never silently assumed.

"Reasons on every choice" is met for plans: every step carries a reason and the engine's account of what it does.
It is **not** yet shown beside the diff in the screen, and it does not read the provenance graph.

### A4, A15 — The agent loop and model routing

The loop asks a planner for a plan, runs it on a copy, has the result verified, and hands the planner exactly
what was seen (the condition, the simulated respondents) for a repair. It stops when the result verifies, when two
repairs in a row do not improve it, or at a bound on attempts, steps or cost. It asks before it builds: an open
question that changes the design stops it with nothing built. It ends in a proposal and never saves.

Routing: classification, single edits and extraction go to the small model; planning, generation and review to
the large one; one escalation from small to large; no retry after the large one fails.

**The planner is injected, and so far it has only ever been a script.** No language model has run this loop. It is
not connected to the conversation yet: that has to go through the existing metered model route, after the model
baseline exists.

### Defects from the Phase 1 baseline

| Defect | State |
| --- | --- |
| "After S1 ask how many cars they own…" proposed as "move S1 after Q10" | Fixed. It goes to the model to draft. Wrong proposals in the benchmark: 1.7% to 0 |
| "Ask the open-end Q6 ahead of the attention check Q5" read as data cleaning | Fixed. Read as the move it is |
| One edit on the 501-question survey at about 440 ms | About 150 to 190 ms. Each edit no longer re-judges the survey it was given. **The 100 ms target is not met**; getting there needs incremental validation |
| How many of the 131 failing import scenarios are the scenario builder's fault | Not looked at |

## The scorecard after this

11 benchmarks, 9 measured. 20 of 35 metrics with a target meet it.

| Benchmark | Measured | Target |
| --- | --- | --- |
| Instructions in the product's phrasing, no model | 80% | 95% |
| The same in free phrasing, no model | 23.3% | 95% |
| Proposals that were not what was asked | 0% | 1% |
| Design questions answered with the right number (12 sentences) | 83.3% | 95% |
| Planted defects the verifier reports on the right question (7) | 100% | 99% |
| Agent loop scenarios with a scripted planner (12) | 100% | 100% |
| Loop runs that left the given survey unchanged | 100% | 100% |
| One edit on a 501-question survey | 185 ms | 100 ms |

The verifier and loop figures are on cases I wrote and graded. They show the mechanisms work on those cases.

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
| Guards, tenancy, dependency boundaries, unused exports | `pnpm audit:code` | 0 problems |
| Plan reading, plan check, clarification policy, routing, and the loop with scripted planners (verifies, repairs, stops on no progress, cost, refusals, unreadable plans, asks first) | `agentLoop.test.ts`, 10 tests | pass |
| The two misreadings, and that cleaning sentences and moves still read correctly | `designIntent.test.ts`, 1 new test | pass |
| Every suite after the edit speed-up: engine 3,000, analytics 894, Studio 1,331, templates 180, runtime 177, import 150, quality 119 | package tests | pass |
| All benchmarks against the previous baseline | `pnpm bench` | no regression; five improvements |

## What was NOT tested

- **Not in a browser.** The design answer and the "What was seen" section use the existing answer card in
  Intelligent Mode; I did not open either and look.
- **The tools endpoint's new branch was type-checked, not called over HTTP.**
- **No language model.** The loop has only run with a scripted planner, and it is not connected to the
  conversation. The plan-check endpoint was type-checked, not called over HTTP.
- **The interview-length rates are not validated against real timings.**
- **The verifier on scripts, quotas, loops and rare answer combinations.** None of the planted defects uses them.
  A defect that needs a rare combination can be missed at 60 respondents; the observation for a condition that was
  never true says so.
- **The server simulation route still returns the old verdict sentences.** Only the in-conversation simulation
  shows observations.
- **Quota cells are not yet written into the survey from a sentence.**
- **English only.**

## Phase 2 item by item

44 items: the 43 the roadmap puts in Phase 2 (some start in Phase 1), plus P1 from Phase 1, which is still open.
Done means built and tested as described above, not that its Level 5 threshold is met.

| Area | Done | Partly | Not started |
| --- | --- | --- | --- |
| AI design agents (8) | A3, A5, A6, A7, A15 | A2 (about 90 of 850 cases), A4 (loop built, no model), A8 (reasons in plans, not on screen) | |
| Programming (6) | | P1 (measured, edits faster, target not met) | P2, P3, P4, P5, P11 |
| Analytics (6) | | M1 (measured only) | M2, M3, M4, M5, M10 |
| Import (6) | | I1 (10 of 300 files), I2 (exists, 58.3%, not examined) | I3, I4, I5, I6 |
| Reporting (6) | | | R1 to R6 |
| Qualitative (6) | | | Q2 to Q7 |
| Fraud (6) | | | F2 to F6, F11 |

Some "not started" items have earlier work in the product that I have not assessed against the roadmap's
definition (libraries, dashboards, the quality review screen, the import review screen). I have not counted them.

**Next:** fraud items the red-team benchmark can score (machine-answer detection, duplicates, one trust score).
I am doing that one carefully: I wrote the simulated attacks, so tuning a detector to them would raise the number
without meaning anything. It needs attack variants held back from development.

**Cannot be done from here:** Q2 media server, F2 device and network signals (build or license), P4 80 languages
reviewed by people, P11 real devices, and anything needing the model, speech or vendor keys.

Still open from Phase 1: the model baseline (`pnpm eval:ai`) has not been run.

## Nothing to apply

No migration. No setting.
