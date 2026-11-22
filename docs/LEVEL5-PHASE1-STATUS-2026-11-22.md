# Level 5 roadmap, Phase 1 (Measure) — status (22 November 2026)

Phase 1 of the roadmap builds no feature. Its job is to state each area's benchmark, run it, and record where the
product stands, so that every later claim of "Level 5" is a number and not an opinion.

## What exists now

One command runs every benchmark, compares the run with a committed baseline and prints a scorecard:

```
pnpm bench                     # run, compare, exit 1 on a regression or a benchmark that disappeared
pnpm bench --update-baseline   # keep this run as the baseline, rewrite docs/LEVEL5-SCORECARD.md
pnpm bench --only fraud        # one area
```

The rules it follows:

| Situation | What happens |
| --- | --- |
| A metric is worse than the baseline by more than its tolerance | Regression. The run fails |
| A metric is below its Level 5 target | A gap. Printed, not failing: the targets are where the roadmap is going |
| A timing is slower | A warning only. The CI machine is not the machine the baseline was made on |
| A benchmark cannot be measured (no model key, no audio) | "Not measured", with what it needs. Never scored, never counted as passing |
| A benchmark in the baseline did not run, or stopped reporting a metric | The run fails. A benchmark must not disappear quietly |
| A benchmark throws | The run fails |

It is a step in the CI workflow (`.github/workflows/verify.yml`). The whole run takes about three minutes.

## The baseline

`docs/LEVEL5-SCORECARD.md` has every number with its target. 8 benchmarks: 6 measured, 2 not measurable.
Of 27 metrics with a roadmap target, 12 meet it.

### AI design agents

Measured **without a language model**: the rule reader and the engine's gate only.

| Metric | Measured | Level 5 target |
| --- | --- | --- |
| 30 instructions in the product's own phrasing, applied correctly first time | 80% | 95% |
| The same 30 in free phrasing | 20% | 95% |
| Proposals that were not what was asked | 1.7% (1 of 60) | 1% |
| Instructions the rules hand to the model | 48.3% | none set |
| Out-of-scope or unanswerable requests that changed the survey (8 tried) | 0 | 0 |
| 24 operations requests read correctly | 79.2% | 95% |

What this says: without a model, the agent does what it is asked when the request is phrased the way the
product's examples phrase it, and hands nearly everything else to the model. The free-phrasing figure is the
size of the model's job, not a verdict on the agent with a model.

One wrong proposal was found: "After S1 ask how many cars they own, as a number between 0 and 10" is read as
"move S1" instead of "add a question". It would be shown as a proposal before applying, but it is the wrong
proposal. Not fixed in this phase; it is recorded in the baseline as a failing case.

One misreading that changed nothing: "Ask the open-end Q6 ahead of the attention check Q5" is read as a data
cleaning request because of the words "attention check".

**With a model: not measured.** No model key exists here. The Studio's harness is ready (`pnpm eval:ai` with
`EVAL_AI_API_URL`, `EVAL_AI_API_KEY`, `EVAL_AI_MODEL`); the roadmap asks for the baseline on two models.

### Programming

A survey of 501 questions over 100 pages with 50 loops and a display condition on two questions in five.

**Correction, 23 November 2026.** In the first baseline the display conditions were written in a field the survey
schema does not have, so the schema dropped them: the survey measured had 501 questions and 50 loops but **no**
display conditions. The fixture now writes them where the schema reads them (178 conditioned questions), a test
checks they survive, and the numbers below are from the first run. The corrected figures are in
`docs/LEVEL5-SCORECARD.md`: one edit about 394 ms, one simulated respondent about 4.3 s. The conclusions do not change.

| Metric | Measured | Level 5 target |
| --- | --- | --- |
| Apply one edit | 376 ms | 100 ms |
| Read one instruction (rules) | 355 ms | 2 s |
| Validate the whole definition | 98 ms | 1 s |
| Review the survey for contradictions | 130 ms | 10 s (publish) |
| Work out one page for a simulated respondent | 16.5 ms | 1 s |
| One simulated respondent, start to end (about 308 pages) | 5.1 s | none set |

The edit is nearly four times over its target at this size: every edit copies and re-checks the whole survey.
A simulated respondent takes five seconds, so a 1,000-respondent test run of a survey this size would take
over an hour.

### Analytics and metrics

| Metric | Measured | Level 5 target |
| --- | --- | --- |
| Crosstab with a two-variable banner on 200,000 responses | 125 ms | 400 ms (the 2-second target at a fifth of the rows) |
| The same scaled to 1,000,000 | 625 ms (an estimate) | 2 s |
| Build the dataset from stored responses, 200,000 | 1.6 s | none set |

### Import and migration

Ten files: five Qualtrics, five Decipher.

| Metric | Measured | Level 5 target |
| --- | --- | --- |
| Detected items imported, a partial counting half | 94.4% | 98% |
| Weakest construct class (survey options) | 31.1% | 95% |
| Behaviour scenarios identical to the source (419 built, 314 testable, 183 identical) | 58.3% | 99% |
| Files that import to a survey passing the publish check | 90% | 100% |
| References the importer could not resolve | 4 | 0 |
| Files in the corpus | 10 | 300 |

Other weak classes: quota conditions 66.7%, custom JavaScript 75.6%, piped text 81.3%, randomizers 83.3%.

Of the 131 failing behaviour scenarios, most are "the question was not shown" and 47 are "the respondent was
screened out before reaching the rule". It has not been established how many are wrong imports and how many are
the scenario builder failing to answer earlier screeners correctly. That has to be separated before the 58.3% is
read as import quality.

The product allows 8 seconds per file for these scenarios and reports the rest as "not run". On the build
machine that left 81 to 92 of the 419 not run, a different number each time. The benchmark runs all of them.

### Fraud defence

510 responses: 240 synthetic genuine people and nine simulated attacks of 30 each.

| Metric | Measured | Level 5 target |
| --- | --- | --- |
| Attacks detected (sent to review or excluded) | 63.3% | 95% |
| Attacks excluded outright | 29.3% | 95% |
| Language-model agents detected | 75% | 90% |
| Real people wrongly excluded | 0% | 1% |
| Real people sent to review | 8.8% | 5% |

| Attack | Detected of 30 | Excluded |
| --- | --- | --- |
| Language-model agent, pasting | 29 | 0 |
| Copied open ends | 29 | 1 |
| Stealth script | 30 | 18 |
| Answer-sharing ring | 30 | 30 |
| Classic bot | 30 | 30 |
| Language-model agent, typing | 16 | 0 |
| Location spoof only | 4 | 0 |
| Device farm | 3 | 0 |
| Click-farm workers | 0 | 0 |

The three the product barely sees are the three that need a device or network signal, which the product does
not have. A language-model agent is noticed but never excluded.

### Not measurable today

| Benchmark | What it needs |
| --- | --- |
| ResBench with a model, on two models | A model key and a budget |
| Speech-to-text word error rate, voice turn latency | Providers chosen and keyed; recorded speech with checked transcripts in ten languages. The word-error-rate arithmetic is written and tested |
| Reporting and dashboards | No benchmark written. Its Level 5 tests are about people reading a report |

## Phase 1 exit criteria

| Criterion | State |
| --- | --- |
| AI baseline recorded on two models | **Not met.** Rule-path baseline only. Blocked on a model key |
| ResBench in CI | Part. The instruction and operations corpora run in CI. The brief corpus with a model does not |
| Fidelity corpus in CI | Met for the 10 files there are. The corpus is 10, not 300, and has no file with its expected behaviour written by a person |
| Red-team corpus in CI | Met, with simulated attacks |
| Speech providers chosen and measured | **Not met.** Blocked on providers and audio |
| Large-survey and large-data timings known | Met in the engine. Not in a browser, not on a phone, not at 1,000,000 by 2,000 |

Phase 1 is not complete. The two unmet criteria need decisions and keys, not code.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Compare logic: regression, gap, timing warning, missing benchmark, blocked, informational metric | `core.test.ts`, 5 tests | pass |
| Word error rate (English, Hindi, Chinese), set rate, percentiles | `speech.test.ts`, 3 tests | pass |
| Corpora well formed; the grader tells a right edit from a wrong one; blocked suites score nothing; fixture sizes | `suites.test.ts`, 6 tests | pass |
| Red-team corpus: deterministic, right sizes, attackers do not copy genuine answers | `redTeam.test.ts`, 2 tests (quality suite: 119) | pass |
| The whole benchmark, twice, compared with its own baseline | `pnpm bench` | no regression on the second run |
| Guards, tenancy, dependency boundaries, unused exports | `pnpm audit:code` | 0 problems |

## What was NOT tested

- **No language model**, anywhere in this phase.
- **No real attacker data and no real respondents.** The fraud numbers are about simulated behaviour.
- **No browser and no device.** Edit and page timings are the engine in one Node process.
- **The CI step has not run on GitHub.** It was run locally with the same command.
- **The whole repository's test suite (`pnpm -r test`) was not re-run** after these changes. The quality and bench
  packages' tests, the type check of both, and the code audits were.
- **The agent corpus is small**: 30 instructions on one 14-question English survey, written by the same author as
  the benchmark. Two graders were wrong on the first run (they did not look inside blocks) and were corrected;
  one task ("make Q6 optional") was already true of the survey and was replaced.
- **The timing baseline is from a small cloud build machine.** Absolute times will differ elsewhere.

## Decisions needed to finish Phase 1

1. A model key and a spending limit, and which two models to baseline.
2. Speech-to-text and text-to-speech providers to compare, and where the recorded speech comes from.
3. Where the import corpus grows from: 290 more files, with consent to keep them in the repository, and at
   least some with the expected behaviour written down by a person.
4. Whether real, labelled fraud data can be obtained from a sample partner.

## Nothing to apply

No migration. No setting. `pnpm install` picks up the new `@rescript/bench` package.
