# Level 5 roadmap, Phase 2 (Essentials) — progress (23 November 2026)

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

## The scorecard after this

9 benchmarks, 7 measured. 13 of 29 metrics with a target meet it.

| Benchmark | Measured | Target |
| --- | --- | --- |
| Design questions answered with the right number and its working (12 sentences) | 83.3% | 95% |
| Other sentences wrongly taken as design questions (4 sentences) | 0 | 0 |

The two not answered are free phrasings: "We expect awareness to go from 40% to 50%. How many people per wave to
see that?" and "Roughly how many minutes will people spend on this?" They go to the model. They are recorded as
failing cases, not tuned away.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Formulas against textbook values (385, 1,068, 2,401, 664, 323; 388 per group; 64 and 394 per group; ±3.1) | `designCalc.test.ts`, 8 tests | pass |
| Quota rounding sums exactly; small cells flagged; shares scaled when they do not add to 100 | same | pass |
| Interview length against a hand calculation, with a loop and a conditional question | same | pass |
| Field estimate assumes no rate it was not given | same | pass |
| The engine's formulas agree with the analytics package's across 180 margin cases and 16 difference cases | `sampleSize.test.ts`, 1 new test | pass |
| Design questions read in several phrasings; 14 sentences that must be left alone | `designIntent.test.ts`, 5 tests | pass |
| The whole engine suite | 2,989 tests | pass |
| The Studio suite | 1,331 tests | pass |
| Guards, tenancy, dependency boundaries, unused exports | `pnpm audit:code` | 0 problems |
| All benchmarks against the previous baseline | `pnpm bench` | no regression |

## What was NOT tested

- **Not in a browser.** The answer uses the existing answer card in Intelligent Mode; I did not open it and look.
- **The tools endpoint's new branch was type-checked, not called over HTTP.**
- **No language model.** The agent does not yet call these tools on its own; that is the agent loop (A4). Today
  they are reached by the sentences above and by the tools endpoint.
- **The interview-length rates are not validated against real timings.** No fieldwork timing data was used.
- **Quota cells are not yet written into the survey from a sentence.** The calculation exists; "set quotas of
  49/51 by gender on 1,000 completes" still goes through the existing quota action.
- **English only.**

## Next in Phase 2 (AI design agents first)

| Item | State |
| --- | --- |
| A5 Verifier feedback as structured observations | Next |
| A3 Unified plan format over the tool registry | After A5 |
| A6 Clarification policy, A8 reasons on every choice | After A3 |
| A4 Agent loop, A15 model routing | Needs the model baseline run |
| Defects from the Phase 1 baseline (wrong "move S1" proposal, the "attention check" misreading, 394 ms edits) | Open |
| The other six areas' Phase 2 essentials | Not started |

Still open from Phase 1: the model baseline on the two models (`pnpm eval:ai`) has not been run. I have no key
here, so it has to be run where the key is.

## Nothing to apply

No migration. No setting.
