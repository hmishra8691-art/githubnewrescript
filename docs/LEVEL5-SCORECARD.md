# Level 5 scorecard

Run at 2026-11-22T14:08:32.167Z, commit 5179ec1f.

10 of 12 benchmarks measured. 22 of 43 metrics meet their Level 5 target.

## AI design agents

### ResBench instructions, answered without a model

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Instructions in the product's own phrasing, applied correctly first time | 80% | at least 95% | no |
| The same instructions in free phrasing, applied correctly first time | 23.3% | at least 95% | no |
| Proposals that were not what was asked | 0% | at most 1% | yes |
| Instructions the rules hand to the model (the model's share of the work) | 48.3% | none set | – |
| Out-of-scope or unanswerable requests that changed the survey | 0 | at most 0 | yes |
| Median time to a proposal | 16.1 ms | at most 2000 ms | yes |

68 cases, 29 not passing. First: add_text.plain (handed to the model: model); add_text.free (handed to the model: model); reword.free (handed to the model: model); type.free (handed to the model: model); add_option.free (handed to the model: model).

What this does not show: no language model was called. "Handed to the model" sentences are neither right nor wrong here; with a model they may well succeed. The survey is one 14-question fixture, in English. A wrong edit is still shown to the researcher as a proposal before it applies; this measures whether the proposal is what was asked.

### ResBench operations requests, read without a model

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Operations requests read correctly | 79.2% | at least 95% | no |
| Catalogue example sentences understood | 100% | at least 100% | yes |

24 cases, 5 not passing. First: upload_free (read as people); pause_free (read as not an operation); settings_free (read as not an operation); status_free (read as not an operation); guide_free (read as not an operation).

What this does not show: this checks that the sentence is read as the right operation with the right list and settings. Carrying it out (the people file, the accounts, the email) is tested in the browser suite, never against a hosted database.

### ResBench design questions, answered by the calculators

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Design questions answered with the right number and its working | 83.3% | at least 95% | no |
| Other sentences answered as design questions | 0 | at most 0 | yes |

16 cases, 2 not passing. First: difference_free (not read as a design question); length_free (not read as a design question).

What this does not show: sixteen sentences, no model. A design question in a phrasing the reader does not know goes to the model, which is not measured here.

### The verifier on surveys with a planted defect

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Planted defects reported on the right question | 100% | at least 99% | yes |
| Of those that should carry them: reported with the condition and the simulated respondents | 100% | at least 99% | yes |
| Problems reported on sound surveys | 0 | at most 0 | yes |
| One verification (60 simulated respondents, 14 questions) | 98 ms | at most 2000 ms | yes |

9 cases, 0 not passing.

What this does not show: seven planted defects on one 14-question survey, 60 simulated respondents each. A defect that needs a rare combination of answers, a quota, a script or a loop is not in this set.

### The agent loop, with a scripted planner and the real verifier

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Scenarios where the loop did what it should | 100% | at least 100% | yes |
| Runs that left the survey they were given unchanged | 100% | at least 100% | yes |

12 cases, 0 not passing.

What this does not show: the planner is a script. This shows the loop's control (hand back, stop, ask, approve, never write), not the quality of a model's plans, which needs a model key.

### ResBench with a language model, on two models

**Not measured.** no model key is configured. Set EVAL_AI_API_URL, EVAL_AI_API_KEY and EVAL_AI_MODEL and run `pnpm eval:ai`, once per model; the brief-to-survey, logic-path, injection and cost thresholds are scored there. Nothing about a model's quality is known until that has run.

## Programming

### A 500-question survey with 50 loops, in the engine

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Apply one edit | 157.2 ms | at most 100 ms | no |
| Read one instruction (rule path) | 158.5 ms | at most 2000 ms | yes |
| Parse and validate the whole definition | 86.9 ms | at most 1000 ms | yes |
| Review the whole survey for contradictions (the roadmap's 10 seconds is for publish) | 104.5 ms | at most 10000 ms | yes |
| Working out one page for one simulated respondent (about 308 pages each; the roadmap's 1 second is a page on a phone, which this is not) | 15.3 ms | at most 1000 ms | yes |
| One simulated respondent, start to end (at this rate 1,000 simulated respondents take over an hour) | 4699 ms | none set | – |

3 cases, 0 not passing.

What this does not show: this is the engine in Node, not the editor in a browser or a respondent's phone. The roadmap's 100 ms edit and 1 second page targets need a browser suite on a real device to confirm.

## Analytics and metrics

### Crosstabs on a large response set, in the engine

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Crosstab with a two-variable banner, 200,000 responses (400 ms here is the 2-second target scaled to a fifth of the rows) | 97.5 ms | at most 400 ms | yes |
| The same, scaled linearly to 1,000,000 (estimate) | 488 ms | at most 2000 ms | yes |
| Build the dataset from stored responses | 1507 ms | none set | – |

1 cases, 0 not passing.

What this does not show: measured at 200,000 responses by 4 variables, not the roadmap's 1,000,000 by 2,000: the present engine holds every response in memory as an object, which is what the columnar store (M1) replaces. The figure scaled to a million is an estimate, not a measurement.

## Import and migration

### Import fidelity on the corpus

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Items imported, a partial counting half | 94.4% | at least 98% | no |
| Weakest construct class (Survey options) | 31.1% | at least 95% | no |
| Behaviour scenarios identical to the source (419 built, 0 not run) | 58.3% | at least 99% | no |
| Files importing to a survey that passes the publish check | 90% | at least 100% | no |
| References the importer could not resolve | 4 | at most 0 | no |
| Import time per file | 180 ms | at most 120000 ms | yes |
| Files in the corpus | 10 | at least 300 | no |

26 cases, 16 not passing. First: decipher/decipher_1.xml (98.1% of 52 items; 32/61 behaviours); decipher/decipher_2.xml (100% of 32 items; 12/25 behaviours); decipher/decipher_3.xml (100% of 20 items; 9/19 behaviours); decipher/decipher_4.xml (97.6% of 82 items; 39/61 behaviours); decipher/decipher_5.xml (100% of 33 items; 23/47 behaviours).

What this does not show: fidelity is counted over what the importer detected, so a construct it never noticed is not in the denominator. The corpus is ten files (five Qualtrics, five Decipher), not the 300 the roadmap sets, and has no Word, PDF or Excel sources.

## Reporting and dashboards

No benchmark yet.

## Qualitative and video

### Speech-to-text word error rate and voice turn latency

**Not measured.** three things are missing: a speech-to-text and a text-to-speech provider (none is chosen, no key exists), a benchmark set of recorded speech with checked transcripts for each of the ten main languages, and a machine with a microphone path to time a voice turn. The word-error-rate and percentile arithmetic is written and tested; no provider has been heard.

## Fraud defence

### Red-team corpus through the quality engine

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Attacks detected (sent to review or excluded) | 63.3% | at least 95% | no |
| Attacks excluded outright (the roadmap's threshold is on detection; this is the stricter reading) | 29.3% | at least 95% | no |
| Language-model agents detected | 75% | at least 90% | no |
| Real people wrongly excluded | 0% | at most 1% | yes |
| Real people sent to review | 8.8% | at most 5% | no |
| Scoring time per response (after the fact; the roadmap's 150 ms is for the entry decision) | 19.2 ms | at most 150 ms | yes |

9 cases, 6 not passing. First: llm_agent_typed (Language-model agent, typing: 16 of 30 detected, 0 excluded); llm_agent_pasted (Language-model agent, pasting: 29 of 30 detected, 0 excluded); device_farm (Device farm: 3 of 30 detected, 0 excluded); click_farm_humans (Click-farm workers: 0 of 30 detected, 0 excluded); translated_paste (Copied open ends: 29 of 30 detected, 1 excluded).

What this does not show: the attacks are simulated from a description of how each behaves, not recorded from real attackers, and the people are synthetic. No device or network signal exists yet, so nothing here tests one.

### Recorded automated browsers through the quality engine

| Metric | Measured | Level 5 target | Meets it |
| --- | --- | --- | --- |
| Automated sessions excluded on behaviour alone (own address and device each) | 83.3% | at least 95% | no |
| Automated sessions with any evidence other than repeated (canned) text | 83.3% | at least 95% | no |
| The agent paced like a person: excluded | 0% | at least 90% | no |
| The agent paced like a person: any evidence other than repeated canned text | 0% | at least 90% | no |
| The careful agent (curved pointer, corrected typos): any evidence other than repeated canned text (written to evade the pointer and typing rules) | 0% | at least 90% | no |
| Agent-style sessions excluded on behaviour alone | 60% | at least 90% | no |
| Excluded as recorded (one address, one device) | 100% | at least 95% | yes |
| Synthetic genuine respondents excluded alongside them | 0% | at most 1% | yes |
| Recorded sessions | 36 | none set | – |

9 cases, 2 not passing. First: agent_patient (Agent told to pass for a person: reading pace, varied typing, pauses: 0 of 3 excluded, 0 with evidence other than repeated text (as recorded: 3 excluded). Fired: openend.duplicate 3); agent_careful (The patient agent, also curving its pointer and correcting typos: 0 of 3 excluded, 0 with evidence other than repeated text (as recorded: 3 excluded). Fired: openend.duplicate 3).

What this does not show: 36 sessions recorded on 2026-11-22 from headless Chromium on one server, scripted by the same author as the benchmark. No person was recorded, no real desktop or phone, and no language model: the agent styles reproduce how an agent drives a browser, with canned text. The typing and pointer rules were written by the same author as the recordings, from what is known about how people type and move a mouse; they have never been run on a recording of people.

