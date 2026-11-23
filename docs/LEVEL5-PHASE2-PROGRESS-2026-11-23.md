# Level 5 roadmap, Phase 2 (Essentials) — progress (updated 22 November 2026)

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

### Fraud — recorded automation, and what it showed (26 November)

The red-team corpus simulates attacks: it writes the telemetry I believed an attacker would leave. Building
detectors against my own simulation would prove little, so I recorded the real thing instead.

**What was recorded.** 30 sessions of a real Chromium completing the benchmark survey through the runtime's own
collector, driven seven ways (`scripts/redteam-record.mjs`, kept in `packages/quality/fixtures/recorded`):

| Style | What it is | Excluded |
| --- | --- | --- |
| Page script | Answers set from script, no real input events | 6 of 6 |
| Scripted browser, fast | Clicks and types as fast as it goes | 6 of 6 |
| Scripted browser, stealth | Automation flag hidden, short waits | 6 of 6 |
| Agent, typed | Pointer moved, a few seconds a page, text at 40 ms a key | 3 of 3 |
| Agent, pasted | The same, text pasted | 3 of 3 |
| Agent, slow and even | Reads at a person's pace, types at a fixed 180 ms a key | 3 of 3 |
| **Agent, patient** | **Reads at a person's pace, types at 140 to 340 ms a key with pauses** | **0 of 3** |

Each was scored as if it came from its own address and device, so only behaviour counts.

**What it showed.**

1. Before any change, the engine excluded every fast style, and all of them by speed alone. Speed is the easiest
   thing for an attacker to fix.
2. **A patient agent passes.** Its only flag was repeated text, and that is an artefact: my recordings use canned
   sentences, which a real model would not repeat. Counted properly, nothing catches it.
3. Two things the collector does not see, found by looking at real telemetry:
   - It counts clicks, not pointer movement. Moving the pointer to each target left exactly 31 pointer events,
     the same as not moving it. So a pointer path cannot be judged at all.
   - It keeps only the last 20 changes of a typed answer, so typing can be judged on 19 keystrokes, not 150.

**What was added.** Two rules that read how keys arrived, from the answer history (times and lengths; never the
text):

| Rule | Fires when | On the recordings |
| --- | --- | --- |
| Typed faster than a person can | 15 or more keys in a row above 16 characters a second | The fast scripted styles and the 40 ms agent |
| Typing too even to be a person | 15 or more keys in a row, gaps varying under 12%, nothing corrected | The slow, even agent — the one that speed does not catch |

The slow, even agent is excluded because of the second rule. Its only other flag is the repeated canned text,
the same as the patient agent, which is not excluded.

**What this does not establish.**

- **No person was recorded.** The rules' thresholds come from what is known about typing, not from data, and they
  have never met a recording of people. The synthetic genuine respondents have no keystroke history, so the rules
  cannot fire on them: the 0% false-positive figure says nothing about these two rules.
- I wrote the recordings and the rules in the same sitting. The patient style is my guess at an evasive agent,
  not a real one.
- Headless Chromium on one server. No real desktop, no phone, no language model.
- The simulated red-team numbers are unchanged (63.3% detected), as they should be: nothing was tuned to them.

**What it means for the roadmap.** The fraud items that matter most are now clearer, in this order: (1) F4, the
collector should keep typing statistics for the whole answer and a summary of the pointer path, because that is
where a patient agent could still differ from a person; (2) F2, device and network signals, which need a build or
license decision; (3) recordings of real people, without which no behavioural rule can be trusted to exclude.

### Fraud — the collector sees typing and the pointer path; a careful agent still passes (27 November)

**F4, built.** The runtime collector now keeps, per text answer, how it was typed (keys, mean and spread of the
gaps between them, pauses, corrections), and for the whole response how the mouse reached what it clicked (how
many clicks, how many jumped there, how many paths were ruler-straight in equal steps, mean straightness). No key,
character, text or coordinate is kept. The server's sanitiser keeps only those numbers, drops a summary that cannot
be true, and keeps nothing when the survey switches interaction telemetry off.

Two pointer rules read it: **mouse clicks without moving the pointer**, and **pointer paths drawn with a ruler**.
The typing rules now judge the whole answer when the summary exists.

**Re-recorded with the new collector**, 36 sessions, ten styles, each scored with its own address and device:

| Style | Excluded | What caught it, besides timing |
| --- | --- | --- |
| Page script | 6 of 6 | No interaction, automation flag |
| Scripted browser, fast | 6 of 6 | Superhuman typing, **pointer jumps** |
| Scripted browser, stealth (flag hidden) | 6 of 6 | Superhuman typing, **pointer jumps** |
| Mouse moved in 25 equal steps, then pressed | 3 of 3 | Superhuman typing, **ruler-straight pointer paths** |
| Agent, typed at 40 ms a key | 3 of 3 | Superhuman typing |
| Agent, pasted | 3 of 3 | Pasted answers |
| Agent, reading pace, fixed 180 ms a key | 3 of 3 | Even typing |
| Agent paced like a person | **0 of 3** | Nothing |
| **Careful agent**: paced like a person, curved pointer, typos corrected | **0 of 3** | Nothing |

Both pointer rules fire on real recordings of the patterns they describe. Neither fires on the agents that move
the pointer with any irregularity.

**What this shows.** Behavioural rules raise the cost of an attack: an automated browser left to its defaults is
caught on several independent counts. But an agent written to look like a person, as the careful one was in an
afternoon, passes every behavioural check here. I do not expect more behavioural rules to change that; each one
tells the attacker what to vary next. The defences that do not depend on how the browser is driven are:

1. **F2, device and network reputation**: data-centre and proxy addresses, emulators, device farms. Needs the build
   or license decision.
2. **F3, the same person across surveys and vendors**: hashed identifiers, so one agent cannot complete a hundred
   times.
3. **F5, machine-written open ends**: judged by a model on content, and validated against real answers.
4. **Recordings of real people**, without which none of the behavioural thresholds can be trusted to exclude, and
   without which "the careful agent passes" cannot be turned into "the careful agent differs from people in X".

One observation to test once human recordings exist: the patient agent typed 140 characters with no correction
three times out of three. People rarely do. That is a candidate signal, not a rule, because I have no data on how
often people do.

**Benchmark change.** The recorded set grew from 30 to 36 sessions and gained the careful agent and the scripted
mouse. The overall exclusion rate fell from 90% to 83.3% because the set got harder; every style excluded before is
still excluded at the same count. The baseline was re-kept on purpose and the commit says so.

### Programming batch: path coverage, source format, libraries (28 November)

**P2, path coverage.** A survey becomes a list of goals: every page reached, both sides of every conditional
question, every branch path, skip, ending and quota cell. Simulated respondents are run, later rounds aimed at
what is still missing, and the fewest of them that meet every met goal are picked as a test script a person can
walk by hand. An unmet goal says why, including where the respondents who would have met it went instead. Quota
feasibility: cells no complete entered, a target above its maximum, targets that do not add up, hard maximums that
cannot fill. Intelligent Mode answers "test every path" with it.

On four shipped surveys, 94.9% of goals were met by scripts of 17 respondents in all. The unmet goals are real
findings or generator limits, and the tool does not tell which: for example, the brand funnel template's "shown if
aided awareness is answered" can never hide anything because that question is required.

**P3, survey source format.** A survey written as text: questions with options, logic and skips; the flow as an
indented outline; quotas. A condition is written as the expression the logic editor shows only if reading that text
back gives exactly the same condition; otherwise as JSON. Everything else goes on an `extra` line. All 39 fixtures
(every template, the 501-question survey, the ten imported corpus surveys) come back identical. 92.7% of conditions
are written as readable expressions. A line diff of two versions is what a review reads. The Studio serves the draft
as source and reads an edited source back as a diff, without writing.

**P5, reusable libraries.** A library is another survey of the workspace; its blocks, questions and option lists
are the items, reused from its latest saved version. Inserting copies the item and records a link with a fingerprint
of the whole item and of each question. The link later tells "up to date", "update available", "changed here" and
"both" apart; for an update it lists what is added, removed and changed, the logic and quota cells elsewhere that
would lose a question or option they read, and the local edits it would overwrite. The Studio route previews an
insert or update as a source diff and saves it only with apply, under the edit lock and revision guard.

What is not done: no screen to browse a library or see link status (route only); the routes were type-checked and
audited, not called over HTTP; no database was used.

### Analytics batch: assumption checks, "why this number", tab plans, simulators, published limits (29 November)

**M5, assumption checks.** Linear regression reports cases per predictor, collinearity (VIF), normality of residuals
(Jarque–Bera), constant variance (Breusch–Pagan) and influence (Cook's distance); logistic regression reports events
per predictor, convergence, separation and collinearity; crosstabs, tests and correlations carry the existing data
advice (expected counts, small bases) in the same form. Each check gives the observed value, the threshold, holds /
caution / fails, and what to do. Failed checks also appear in the result's warnings.

**M4, "why this number".** Any cell of a table, explained from the result and its provenance record without
recomputing: the kind of figure, the count over the column base ("8 of the 32 respondents in North chose 2 —
25.0%"), base, filter and scope, the test, level and Holm correction, the columns it is significantly higher than,
whether a small column was left untested, small-base cautions, and the engine version, data version, input hash and
time. Function only; no screen shows it yet.

**M2, tab plan engine.** One banner, a list of stubs, run-wide filter, weighting, significance level, decimals and
minimum base. Each table stub is the existing crosstab (nets, boxes, means, NPS, sorting), so a tab book figure is
the figure on screen; summary stubs put one statistic of many questions side by side, optionally ranked. A draft
plan is made from the data. The run lists every stub it could not make. The tab book is an Excel workbook with a
linked contents sheet and one formatted sheet per table. On the 360-respondent synthetic corpus the draft plan made
24 tables with no problems. No screen or route yet.

**M3, simulators.** The conjoint simulator already existed (shares, revenue, willingness to pay, demand,
sensitivity, optimisation, segments). Added: MaxDiff share of preference within any subset of items (by default the
rule of the result's own share column, so all items reproduce it; or the logit rule); a TURF line-up simulator
(reach, frequency, each item's unique reach, gain from each candidate, best single swap); a price what-if (would-buy
share and revenue index from Gabor–Granger or NMS, interpolated between tested prices and refused outside them, and
the price's place on the Van Westendorp curves). Functions only; no screen yet.

**M10, published limits.** [ANALYTICS-LIMITS.md](ANALYTICS-LIMITS.md) lists 13 enforced limits, each the engine's own
constant, with what happens when it is exceeded, and 9 checks against outside references with the tolerance each
test uses, plus what has no outside reference. A test fails if the page and the code disagree.

### Fraud batch: cross-survey duplicates, trust score, review console (29 November)

**F3, cross-survey duplicates.** Identity resolution already merges the same e-mail, phone or panel ID, and the
fraud graph finds rings sharing devices and networks. Added, for one organisation at a time: the same open-ended
answer (identical, or 85% character-shingle overlap, the in-survey rule's standard setting) from different
respondents in different surveys; one person reusing their own paragraph (informational only); and one identity
behind several participant IDs of one vendor. Short and generic answers are never evidence; a text shared by more
than 50 sessions across five or more surveys is treated as boilerplate and noted. The hourly fraud job runs it over
the organisation's last 30 days of real completes (at most 4,000) and opens one "duplicate" case per new finding,
without holding payment.

**F6, trust score with actions.** A second number beside the identity's standing risk: a Beta-style average with a
prior worth ten observations at 70, clean completes and cleared cases for, rejections, duplicates, upheld cases,
suspicious completes and open strong cross-survey findings against, capped by the standing risk. Confidence is kept
apart so a newcomer is not read as bad. It recommends allow, watch, verify, review before payment or quarantine,
each with its reason; quarantine needs enough evidence. A route reads it for one respondent and can open a manual
case with a typed reason; nothing quarantines or blocks directly.

**F11, review console.** The per-survey quality panel already recorded decisions with reasons, in bulk, with a
history, and the fraud centre already handled cases and rings. Added: a review queue (flagged first, riskier first,
one response per cluster ahead of its siblings), per-rule verdicts (how often reviewers removed what a rule flagged,
with a Wilson interval), and Cohen's κ between two reviewers. A "Review console" card in Data → Quality shows them.

### Import batch: five more formats, legacy data, side-by-side review (22 November)

**I3, more source formats.** Readers for Triple-S (XML), SPSS syntax (.sps: variable and value labels, missing values,
multiple-response sets), SurveyMonkey and Alchemer survey JSON, and Forsta Plus project XML. Each is detected by
content, not by the file extension, and feeds the same mapping, validation and report as the existing readers.

**I4, legacy data migration.** A legacy data table (from an SPSS file, a CSV or a workbook) is mapped onto the imported
survey: variable to question by name and label, codes to options, the weight to an embedded field, with a
reconciliation of what was carried over, recoded or dropped. A preview route shows the plan and the reconciliation.
**It writes nothing.** Storing migrated responses waits on your decision about whether they count as completes for
billing.

**I6, side-by-side review.** Each imported question is compared with the source part by part (type, text, options,
rows, logic), and each part is marked same, converted, check or lost. "Accept all at or above" a confidence accepts in
bulk. This is a "Side by side" tab on the import review screen. Acceptance is saved with the import since 0290 (see
below). The tab's badges first
used fixed colours and failed the theme test; 0279 fixed this.

### Qualitative batch: highlight reel as video, interview booking (22 November)

**Q4, one video of a highlight reel.** A reel is planned before anything is cut. A quote is shown as footage only if
three things hold: its session records consent to recording, there is a recording, and the quote has a time range.
Otherwise the quote is shown as a text card. Speakers appear as "Participant N" unless names are asked for. The
render is 1280×720 at 30 fps with AAC audio, with a title card, burnt-in captions and cards drawn with the report
fonts. A render allows up to 20 clips and 180 seconds.

**Q6, interview booking.** Booking works like this:

- The researcher adds bookable times from availability windows (length, buffer, capacity, moderator).
- The researcher invites people from the survey's list or by typed addresses. Each person gets a personal link by
  email; only its hash is stored.
- On a public page, the invitee picks, moves or cancels a time in their own time zone.
- An hourly job sends reminders 24 hours and 1 hour before each session.
- After a session, the researcher marks attended or no-show. The incentive owed under the study's policy is recorded:
  a late cancellation inside 24 hours earns a share or nothing.
- The Studio says how many more people to invite to reach a target, using the study's own rates once it has enough.

Not covered:

- Panel members from the sample exchange are reached through their vendor, so they are not invited by email here.
- The incentive is recorded, not paid.
- The Studio screen came later (0287, see below).

### Reporting batch: one model, shared dashboards, viewer rules, client masters, schedules (22 November)

**R1, one report model.** A report or a dashboard now goes through one renderer to PowerPoint, PDF, Word, Excel or
CSV. Before building, it states how each block will come out in that format (as itself, expanded, as its data table,
or left out) and which blocks have no data. Word is new: every block type is rendered, and a chart appears as its
data table. Two things were fixed along the way:

- PDF and CSV both left panel grids out without saying so; they now include them.
- The export history table accepted only PowerPoint and Excel, so every PDF and CSV export's history row has been
  refused. I checked this on the live database. Migration 0108 fixes it.

**R2, shared dashboards.** A shared report was already a frozen version with pre-computed viewer filters. Added:

- **Drill-down:** one variable a viewer may open by value, at most 12 values, each computed when the report is
  published.
- **Minimum base:** no figure from fewer than the minimum number of people leaves the server. A whole result is
  withheld, a column is blanked in both the table and the chart, and a small segment is removed; each says so. This
  applies to filters and drill values at 30 by default, and to the main results when the report sets a minimum. The
  share route applies it again when a share is opened or downloaded, so versions published earlier are covered on
  their next view.

**R3, who sees what.** A share link can carry viewer rules. Each signed-in viewer, matched by email or by domain, sees
everything, one filter, or one drill value. The server sends only that part; the other segments' numbers never reach
the browser. People no rule names see nothing. A restricted viewer is not told the whole sample size.

**R4, client PowerPoint masters.** A client's .pptx or .potx is read on our server. The deck theme takes from it:

- the slide size;
- the theme colours, fonts and theme part;
- the master's background and pictures, with their positions;
- where the title sits (taken from a layout when the master itself has none).

Decks exported with that theme are built on a master rebuilt from the file:

- their theme part;
- titles in their heading font, where their title placeholder is;
- text that reads on their background;
- native, editable charts in their accent colours.

Not carried over: drawn shapes on the master and layouts other than the master. The import lists both.

**R5 and R6, refresh, schedules and alerts.** A schedule re-computes a report daily, weekly or monthly, or on demand.
Each run:

- renders the report through the one renderer and stores it;
- records what changed since the last run: figures that moved by 3 points or more, KPIs, bases, and analyses added or
  gone. Moves on fewer than 30 people are not called findings;
- emails the recipients the change summary with a sign-in link to the file, plus the share link when one is named. No
  file is attached.

An alert watches one figure. It emails once when the figure crosses its threshold, not again while it stays over, and
never on a small base. The hourly job claims each due schedule before running it, so overlapping runs never run one
schedule twice.

### Screens and finishing touches (22 November, 0287 to 0291)

Things that worked only through the API now have screens, and two gaps left above are closed.

**Booking tab (Q6), 0287.** Research Tools → Qualitative → Booking:

- **Times:** add bookable times from a window (day, hours, length, gap, places, moderator) in the researcher's own
  time zone; withdraw a time, and the people who held it are listed to contact.
- **Invite:** typed addresses and/or respondents from the survey. Addresses skipped or not sent are listed with the
  reason. The button is disabled, with the reason shown, when email is not configured.
- **Bookings:** status, time, reminders sent and incentive per person; mark attended or no-show; cancel for someone.
- **Target:** how many more to invite to reach a number of sessions.

0289 tests the invitee's public page in a browser and removes a duplicated note on it.

**Analytics screens (M2, M3, M4), 0288.**

- **"Why this number":** choose a number cell in the Tables view or a result's Tables tab, and the explanation opens
  under the table: the count over the base, the significance letters in words with the test and correction, small-base
  cautions, and what computed it.
- **Tab book:** Explore → Tab book. Pick up to 8 banner columns; the Studio drafts a table per question, runs it and
  offers the workbook download (needs report downloads; audited as an export). The draft no longer adds a table per
  option of a multi-select.
- **Simulators:** Explore → Simulators. MaxDiff preference shares for a chosen set of items; TURF reach and frequency
  as items are toggled, with the best addition and swap (computed on the server, no respondent rows returned); price
  demand and revenue index, or the Van Westendorp reading, with the range respondents named shown.

The assumption checks (M5) appear in result warnings as before; there is no separate screen for them.

**Import review acceptance saved (I6), 0290.** Questions accepted in the side-by-side review are kept with the import
(who, when, at what level) and come back when the import is reopened. A question that changed since it was accepted
is dropped from the acceptance, and the screen says so. Needs migration 0113; without it, saving answers with a
message naming the migration.

**Republish on refresh (R5), 0291.** A report schedule can republish: each run, scheduled or "Run now", publishes the
fresh results as the report's next version, so share links that follow the latest version show the new numbers.
Links pinned to a version do not change. The rules:

- The Studio's Publish button and schedules use the same publish code, so viewer filters, drill values and the
  minimum base apply in both.
- A schedule never forces a publish. A run that comes back partial keeps the last published version, and the run's
  summary says why; a run that cannot render its file publishes nothing.
- A scheduled publish is audited like a manual one, marked as from the schedule.
- Needs migration 0114. Without it, schedules still save and run; only the republish option is unavailable.

### Quotas and translations, video answers, moderator v2, observer room (22 November, 0293 to 0296)

**I5, quotas and translations brought across and checked (0293).** A survey moved from another platform mid-fieldwork
brings the quota counts it reached there, and each language version is checked after the import.

- **Carried-over counts:** each quota cell can hold completes carried over from earlier fieldwork, with where they
  came from. They come from a Qualtrics export's count (read only beside its target, so an old export's count-as-target
  is never taken for completes) or from a quota report's Achieved / Current / Completes-so-far column. A report for a
  quota already in the survey sets the counts on its cells by label and reports a different target rather than
  applying it.
- **Where they count:** they are added to the LIVE counters wherever fullness is decided (the runtime, List Fill,
  conditions that read a quota, the dashboard, the copilot's quota tab), never to the test counters. They live on the
  definition, so a recount from responses never wipes them. The dashboard shows them apart ("Carried over N") and
  lets the researcher change or clear them.
- **Language versions:** the import report runs each imported language through the translation tasks' own final
  check: strings present, missing (by label), broken (a piping token, placeholder or HTML that does not match the
  source) or still in the source language. The import card has a "Quotas and languages" section. Survey-level and
  interface strings are not part of an imported translation, and the report says so.
- Fixed on the way: a long quota sheet with a Target and an Achieved column was read as a cross-tab.

**Q7, video answers transcribed, coded and usable in tables (0294).**

- **Transcription:** while the camera records, the recorder also records the audio track alone; after the video is
  stored, that track goes through the voice answers' transcription pipeline. An uploaded video file is transcribed
  from the file itself when it is 25 MB or less. The transcript rides on the video file's answer, written by the
  server when the job ends and by the recorder when it sees it. The audio track is deleted once the words are kept.
  Variables `<VAR>_TRANSCRIPT` and `<VAR>_TRANSCRIPT_SOURCE` are in the dictionary and the data.
- **Coding into variables:** open-ended answers added to the qualitative workspace now include what a video answer
  said. Codes on those answers become 0/1 columns (`<VAR>_CODED`, `<VAR>_<CODE>`) in the Studio's dataset and
  variable list, over the answers that were coded. An answer that was not coded is missing, never 0. Rejected codes
  are left out; AI-suggested ones count, and each column says how many a person reviewed. This is part of M9 (Phase 3)
  for any coded open end, not only video.

**Q3, moderator engine v2 (0295).**

- **Laddering:** a question can ladder (1 to 5 rungs): after the first answer the moderator asks why it matters,
  rung by rung, and stops early once the participant names a personal value.
- **Topic exhaustion:** once a follow-up's answer has little new in it, probing stops for that question.
- **Section timing:** each section has minutes (the guide's, else its share by steps). A section near them gets at
  most one follow-up, over them none, and at 1.5 times them the rest of it is skipped.
- **Stimuli:** a concept board (title, text, optional picture) and a screen-share task. The participant page shows the
  concept as a card and offers "Share your screen"; with recording consent the screen is recorded with that answer.
- **Guide adherence:** per interview, steps asked (60%) and objectives covered (40%), with missed steps and why,
  ladders, exhausted topics and sections over time. Shown in the Studio's interview table and the simulator.

**Q5, observer room for AI interviews (0296).** Beside the live transcript of a running AI interview: a private chat
for the team, markers on moments, and questions for the moderator. A question is asked after the participant's next
answer, as the moderator's own follow-up, once; a question asking for contact details, a link or several things is
refused when sent, and one still queued when the interview ends is recorded as not asked. The participant never sees
any of it. Live groups (many participants and observers on video) still wait on the media server (Q2). Needs
migration 0115.

## The scorecard after this

14 benchmarks, 12 measured. 24 of 47 metrics with a target meet it.

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
| Path coverage goals met on four shipped surveys | 94.9% | 100% of reachable |
| Fixtures identical after a source round trip (39) | 100% | 100% |
| Recorded automated sessions excluded on behaviour alone (36) | 83.3% | 95% |
| The agent paced like a person, and the careful agent: excluded (3 each) | 0% | 90% |

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
| The two typing rules: fixed-delay typing, a person's uneven typing, a correction in the window, a fast typist, too few keys, a paste, no history | `typing.test.ts`, 3 tests (quality suite: 122) | pass |
| 36 real automated sessions recorded through the runtime's collector, ten styles, all completed | `scripts/redteam-record.mjs` | 36 of 36 |
| The typing and pointer summaries: kept as numbers only, implausible ones dropped, off with interaction telemetry | `telemetrySanitize.test.ts`, 1 new test (runtime suite: 178) | pass |
| Whole-answer typing and the two pointer rules on hand-written summaries: fixed delay, fast, a person, corrected, jumps, ruler, a hand, a straight flick, few clicks, none | `typing.test.ts`, 2 new tests (quality suite: 124) | pass |
| Path coverage: goals, a sound survey fully covered by a small script, an unused condition found, quota feasibility | `coverage.test.ts`, 4 tests (templates suite) | pass |
| Source format: lossless round trip, readable lines, diff, edits read back, errors by line, JSON fallback | `surveySource.test.ts`, 4 tests | pass |
| Libraries: items, insert with renumbering and logic, update with impact, local edits, lists, missing items | `library.test.ts`, 5 tests (engine suite: 3,009) | pass |
| Assumption checks: a clean fit holds, collinear, heteroscedastic and influential data fail, logistic separation | `modelChecks.test.ts`, 5 tests | pass |
| "Why this number": count over base, letters mapped to columns, totals, base rows, untested small columns, bad references | `whyNumber.test.ts`, 4 tests | pass |
| Tab plan: cells identical to a direct crosstab, summary rows equal each question's own, ranking, refusals reported, draft plan, workbook sheets, links and formats | `tabPlan.test.ts`, 5 tests | pass |
| Simulators: MaxDiff shares reproduce the engine's within 0.1 point, logit formula, TURF reach equals TURF's own, price interpolation and refusal, Van Westendorp range | `simulators.test.ts`, 4 tests | pass |
| Published limits: sources and reference tests exist, the page matches the generator, a truncated dataset warns | `limits.test.ts`, 4 tests (analytics suite: 916) | pass |
| Cross-survey duplicates: reuse across surveys found, own answers and same-survey repeats not, near-duplicates, boilerplate, vendor ID switching, two organisations refused, text read from answers | `crossSurvey.test.ts`, 7 tests | pass |
| Trust score: stranger at 70, clean history, newcomer verified not quarantined, quarantine with evidence, risk cap, open case, cleared case | `trustScore.test.ts`, 6 tests | pass |
| Review console: queue order, rule verdicts with interval, κ on a hand-worked case | `reviewConsole.test.ts`, 3 tests (quality suite: 140) | pass |
| All benchmarks against the previous baseline | `pnpm bench` | no regression |
| Import adapters: Triple-S, SPSS syntax, SurveyMonkey, Alchemer, Forsta Plus, detection by content | `i3Adapters.test.ts` (import suite: 164) | pass |
| Legacy data: plan, migration keyed by question id, weight, reconciliation | `dataMigration.test.ts` | pass |
| Side by side: part levels, bulk accept by confidence and by ids | `sideBySide.test.ts` | pass |
| Highlight reel: plan by consent, media and timing; anonymised speakers; budget; a real render from a generated recording (3 segments, 1280×720, AAC, length within 0.35 s); frames checked by eye | `reel.test.ts` (reportvideo suite: 9) | pass |
| Interview booking: slots, booking refusals, late cancel, reminders once, settlement, invites needed; token shape and hash, row mapping, a booking's whole life, mail text | `scheduling.test.ts` 6 (interviews suite: 184), `qualScheduling.test.ts` 4 | pass |
| One report in all five formats; Word contains every block and passes its check; panel grids in PDF and CSV; a dashboard; an empty one refused | `render.test.ts`, 7 tests | pass |
| Minimum base: column blanked in table and chart, whole result withheld, small segment removed, idempotent; drill plan; the drill filter really filters (North n = 144 of 400) | `dashboardData.test.ts`, 5 tests | pass |
| Viewer rules: every refusal, email over domain, longest domain, no suffix match, no rule, signed out; a restricted payload holds nothing of another segment | `viewerAccess.test.ts`, 3 tests | pass |
| Client master: everything read from a template saved the PowerPoint way; the deck carries the client's theme part, background, logo, a native chart in their accent, titles in their font; rendered through LibreOffice and checked by eye | `clientTemplate.test.ts`, 3 tests | pass |
| Digests, change summary, next run times, alerts that fire once | `reportSchedule.test.ts`, 4 tests (analytics suite: 941) | pass |
| One schedule run end to end against an in-memory database: Word rendered, stored, a sign-in link mailed and no file, the second run reports an 8-point move, an alert fires once, a deleted report, a failed computation | `reportSchedulesCore.test.ts`, 3 tests (Studio suite: 1,343) | pass |
| The fake-provider AI eval after all of the above | `pnpm eval:ai` | 67 of 67 |
| Booking page in a browser: open times in the invitee's zone with a taken time not offered, book, cancel and the time offered again, a time taken a moment earlier refused, an unknown link, no page errors | `scripts/booking-page-browser.mjs` (mocked API) | 6 of 6 |
| Analytics screens in a browser: the explanation's sentence and base, 11 tables listed and one opened, the workbook downloads, MaxDiff shares sum to 100%, TURF reach, a price inside the range | `scripts/reporting-screens-browser.mjs` (fake backend computed by the real engine, 400 synthetic respondents) | 8 of 8 |
| Review acceptance: who and when, held by the bulk rule, dropped when the question changes | `sessions.test.ts`, 1 new test | pass |
| Publish: a partial report refused unless forced, numbering, the report pointed at the new version, another project's or a deleted report unknown | `reportPublishCore.test.ts`, 2 tests | pass |
| Republish: a new version on each run that unpinned links follow, a partial run not published, a failed render publishing nothing, no publish without the setting or on an alert | `reportSchedulesCore.test.ts`, 2 new tests (Studio suite: 1,363) | pass |
| Carried-over quota counts: from a Qualtrics export (live only, full when reached), none said with what to send, an old export's count read as the target, a report onto existing quotas, a new quota with counts, a non-whole count reported | `i5FieldState.test.ts` 5, `quotaCarried.test.ts` 3 | pass |
| Language versions checked after an import: a broken piping token and a missing option named | `i5FieldState.test.ts` | pass |
| Video answers: the transcript on the answer, the dictionary and the data in step | `q7VideoTranscript.test.ts`, 2 tests | pass |
| Coded answers as variables: rejected codes left out, an uncoded answer missing, a crosstab whose base is the coded answers | `codedVariables.test.ts`, 3 tests (analytics suite: 944) | pass |
| The recorder makes a second, audio-only recorder that hands over data when the take stops; none when transcription is off | `scripts/q7-video-transcript-browser.mjs` (Chromium's fake camera, test link) | 3 of 3 |
| Moderator v2: the plan's ladders and section minutes, laddering by rules and model, exhaustion on and off, a section over its minutes moving on, guide adherence | `aiModeratorV2.test.ts` 6, two new eval cases (fake-provider moderator eval passes; engine suite: 3,030) | pass |
| On the participant page: the ladder asks why, a value moves on and the concept card shows, a screen share starts and stops | `scripts/q3-moderator-v2-browser.mjs` (runtime sandbox, fake screen) | 4 of 4 |
| Observer room: notes checked, a question asked once after the next answer, not after injected text or on the closing question; queued → asked, withdrawn never asked, a late question refused | `aiInterviewObserver.test.ts` 3, runtime `service.test.ts` 1 (runtime suite: 179) | pass |
| Observer room end to end: the moderator asks the observer's question on the participant's page, the room shows it asked, the participant never sees the room | `scripts/q5-observer-room-browser.mjs` (runtime sandbox) | 5 of 5 |

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
- **The analytics screens were tested in a browser against a fake backend, not a real database.** The new
  analytics-tools route was type-checked and audited, not called on real data.
- **The fraud batch was not run against a database.** The hourly cross-survey pass, the trust route and the console
  route were type-checked and audited (Studio suite 1,332 passes), not called; the review console card was not opened in a browser. No
  reviewer has made decisions, so the rule verdicts and κ have no real figures yet.
- **Nothing in the import, qualitative and reporting batches ran against a database.** Migrations 0107 to 0110,
  0113 and 0114 are not applied. The routes were type-checked and audited, not called over HTTP. No email was sent.
- **Not opened in a browser:** the Booking tab (project pages need sign-in), the side-by-side tab with saving (the
  script `scripts/import-side-review-browser.mjs` is written, but the dev server ran out of memory compiling the
  import route here), the drill selector, the viewer-rules editor, the master import button, and the schedules card
  with its republish option.
- **R4 was tested on a template I built, not on a real client's template.**
- **The 0293 to 0296 batch ran against no database.** Migration 0115 is not applied. The upload of a video's audio
  track, a real transcript (no speech-to-text provider here), a real screen recording upload, the moderator v2 with a
  real model, and the Studio's observer-room panel and quota "Carried over" field in a browser were not exercised;
  the routes and panels were type-checked and audited. Coded columns are in the Studio's tables, not yet in the
  exported data files.
- **English only.**

## Phase 2 item by item

44 items: the 43 the roadmap puts in Phase 2 (some start in Phase 1), plus P1 from Phase 1, which is still open.
Done means built and tested as described above, not that its Level 5 threshold is met.

| Area | Done | Partly | Not started |
| --- | --- | --- | --- |
| AI design agents (8) | A3, A5, A6, A7, A15 | A2 (about 90 of 850 cases), A4 (loop built, no model), A8 (reasons in plans, not on screen) | |
| Programming (6) | P2, P3 | P1 (edits faster, target not met), P5 (engine and route; no screen) | P4, P11 |
| Analytics (6) | M2, M3, M4 (screens tested against a fake backend), M5, M10 | M1 (measured only) | |
| Import (6) | I3, I5, I6 | I1 (10 of 300 files), I2 (exists, 58.3%, not examined), I4 (preview only; storing waits on the billing decision) | |
| Reporting (6) | R1, R2, R3, R4, R5 (with republish), R6 (not run against a database) | | |
| Qualitative (6) | Q3 (no real model or speech run), Q4, Q6, Q7 | Q5 (AI interviews; live groups wait on Q2) | Q2 |
| Fraud (6) | F3, F4 (typing and pointer summaries collected, sanitised and read by four rules), F6, F11 | F5 (typing rules only; open-end content not judged) | F2 |

Some "not started" items have earlier work in the product that I have not assessed against the roadmap's
definition (libraries, dashboards, the quality review screen, the import review screen). I have not counted them.

**Next:** the 11 items asked for are built (I3, I4, I6, Q4, Q6, R1 to R6), and their screens and the two follow-ups
(review acceptance, republish) are in 0287 to 0291. F2 still waits on the build-or-license decision; I4's storage
waits on the billing decision for migrated completes. Then I5, Q3, Q5 and Q7 were built (0293 to 0296).
Open in the table: P1, P4, P5's screen, P11, M1, I1, I2, Q2, Q5 for live groups, F2, F5, and the model-dependent parts
of A2, A4 and A8.

**Cannot be done from here:** Q2 media server, F2 device and network signals (build or license), P4 80 languages
reviewed by people, P11 real devices, and anything needing the model, speech or vendor keys.

The model baseline was run on 0273 (43 of 67, $2.99) and again after the 0274 fixes (44 of 54, $1.23, Claude Haiku 4.5;
[AI-EVAL-BASELINE-2026-11-22.md](AI-EVAL-BASELINE-2026-11-22.md)). 0286 fixed what that run showed; re-scoring the
recorded answers offline gives 50 of 54. Three of the remaining four need a new live run to check (the conjoint
re-ask, the multi-turn Italian case, the dual-response second turn); the fourth (latent classes with covariates,
refused) waits on your decision.

## To apply

0105 and 0106 are applied on the live database. Written and not applied, in order:

| Migration | What |
| --- | --- |
| 0107 | interview slots and bookings; mail kinds for invitations and reminders |
| 0108 | export history accepts PDF, CSV and Word (PDF and CSV rows are being refused today) |
| 0109 | viewer rules on share links |
| 0110 | report schedules and runs; mail kinds for deliveries and alerts |
| 0111, 0112 | from the scale work, not this roadmap: responses partitioned by month, and survey versions copied to object storage (see [SCALE-READINESS-2026-11-22.md](SCALE-READINESS-2026-11-22.md)) |
| 0113 | import sessions keep the side-by-side review's acceptance |
| 0114 | report schedules can republish (needs 0110) |
| 0115 | the observer room of an AI interview (needs 0069) |

Two new hourly jobs are in `apps/studio/vercel.json` (interview reminders, report schedules); they need `CRON_SECRET`,
like the others. Links in emails use `STUDIO_PUBLIC_URL` when it is set.
