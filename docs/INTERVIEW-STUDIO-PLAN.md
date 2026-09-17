# Interview Studio — audit and plan

Five parallel read-only audits of `apps/interviews`, `packages/interviews` and
the survey platform beside it, then verification of every load-bearing claim
against the source. This is the answer to section 22 of the brief: what exists,
what is broken, what to reuse, and the order to build in.

## The finding that reorders the brief

**The candidate pipeline could not carry an interview.** Two independent
defects, both verified in the source and both now fixed:

1. No answer longer than about 59 seconds could ever be saved. The browser
   declared `expectedBytes(maxSeconds)` — the size of a *maximum-length*
   recording plus a 15% margin — and both ends treated that estimate as the
   number of parts owed. A recording cannot reach its own estimate, so every
   multipart answer was refused, and `/api/candidate/finish` requires every
   required response to be `stored`, so the interview could never be completed.
2. No candidate answer was ever transcribed. The audio companion recorder was
   started and never given an `ondataavailable` handler or an uploader, so
   nothing was ever labelled `answer_audio` — the only kind the completion
   route queues for transcription. No transcript meant no analysis either,
   because analysis is chained off the last transcript to finish.

So the AI layer the brief wants to extend has never run on a self-serve
interview. Everything in sections 5–9 sits on those two steps.

## What already exists and should be reused, not rebuilt

The standing rule on this project is not to duplicate existing systems, and the
survey platform beside this app already contains most of what sections 3, 11
and 12 ask for. `apps/interviews` currently depends on none of it.

| Brief asks for | Verdict | What exists |
|---|---|---|
| Display logic, skip logic, branching, AND/OR, nested conditions | **Adopt** | `packages/engine` — one condition language, 38 operators, arbitrary nesting, `evaluateCondition`, `visibleIf`, `SkipRule`, `branch` flow nodes, named expressions, an evaluation trace for auditing |
| Randomization: fixed / random / mixed groups, pick N of M | **Adapt** | Both sides already have it. Keep `drawSequence`/`explainDraw` in `packages/interviews` — recording the drawn sequence once is the audit property the brief wants and the engine does not have — but replace its private RNG with `engine/random.ts`. Two seeded RNGs in one repo is the real duplication |
| Text, long text, choice, multi-select, video, audio responses | **Adopt** | `packages/renderer` is a package with no app coupling, already consumed by two apps. 42 question types, including a `video_interview` type whose watch-gating (`foldWatchTick`) is exactly section 4's requirement |
| Code editor | **Build** | The only true greenfield item. No Monaco, CodeMirror, Prism, Shiki or Ace anywhere in the repo |
| Telemetry | **Adapt** | `packages/interviews/src/telemetry.ts` already has the richer *model* (38 kinds, neutral sentences, no score). Take the survey runtime's capture plumbing — focus/blur/paste listeners, device detection, reload counting — by promoting it out of `apps/runtime` into a package. Do not take its aggregation into risk scores |
| Media recording | **Adapt** | Four MediaRecorder implementations exist. Upload is already shared through `@rescript/storage`. A headless recorder hook in `packages/media` collapses them |
| PDF report | **Build (print path)** | Nothing in this repo generates a PDF. The established pattern is paginated HTML plus print CSS, which is how survey reports become PDFs today. Confirmed as the chosen route |
| Recruiter dashboard | **Build** | No reusable dashboard component. The pattern worth copying is `engine/quotaDashboard.ts`: pure config plus counts in, rows and summary out |

The highest-leverage single piece of work in the whole brief is one adapter,
`toSurveyDefinition(project, questions, pools)`, projecting the relational
`interview_*` tables into the `{ meta, questions, flow }` document the engine
already consumes. Logic, randomization, response types and the renderer all
unlock behind it. `SurveyDefinition`'s coupling to surveys is naming, not
structure — every field but three has a default, and `Question.type` is an open
string resolved against a registry, so `code_editor` is a legal type today.

## The scoring decision

`packages/interviews/src/evidence.ts` and `telemetry.ts` state, as enforced
design rules with reasons, that this product must never emit a number that
reads as a verdict on a person. Section 7 of the brief asks for exactly that.

**Settled: evidence-gated scoring.** A score may be composed only from
requirement verdicts that have passed quote-verification against the
transcript — never from video, telemetry, or model impression. Every number
expands to the quotes that produced it. `FORBIDDEN_INFERENCES` stays enforced
in the prompt, and the recommendation to advance or decline remains a human's,
not the model's. This satisfies the brief without reversing the safety
position, and `interview_requirements.weight` already exists unused for it.

## What the builder cannot do today

Worth stating plainly, because it explains why the AI layer has no input: the
interviewer-facing product is one text box. Project creation sends a single
`name` field. There is **no project edit route at all**, so instructions,
consent text, status, retention and every cost cap are unreachable after
creation. There is **no route to create a requirement**, so the analysis has
nothing to analyse against — `requirements.edit` is declared and checked by
nothing. Pools have no UI, so the randomization engine that exists is never
reached. Questions can be added but not edited, reordered or deleted, and the
add form hardcodes `maxSeconds: 180` and `maxRetries: 0` while the API accepts
guidance, min/max seconds, retries, think time and kind.

Several capabilities are fully built and simply unreachable: the draw engine,
per-question settings, question kinds, invite options. That is the cheapest
work in the brief and it is what makes everything else demonstrable.

## Order of work

**Phase 1a — the pipeline. Done.** Both P0s, plus three ways a respondent could
be stranded: a white page on an empty question sequence, an unbounded boot
fetch, and a Finish button that never appeared when the last question was
optional and skipped. Added the app's first error boundary.

**Phase 1b — the builder. Done.** Requirements authoring, project settings,
per-question settings and kinds, question edit/reorder/archive.

**Phase 2 — the engine adapter. Done.** `toSurveyDefinition` projects the
interview rows into the engine's document — one page per question, in the
drawn order — and `toResponseState` feeds answers back. The browser walks the
flow with `@rescript/engine` to know what to show next; `finish` walks it again
server-side and is the only authority on what was owed. Display logic, skip
rules, AND/OR groups: the engine's own `Condition` and `SkipRule`, stored
verbatim in `visible_if` and `skip_logic` (migration 0035), validated by the
schema's zod types at save time. Three new kinds — `long_text`, `single_choice`,
`multi_choice` — with options and a choice answer the condition language can
compare. Pools and the draw configuration are reachable: `selection.ts` now runs
on the engine's generator, `interview_projects.selection` is read for the first
time, and the Order tab creates pools, sets pick-N and shuffles.

**Phase 3 — video-first flow. Done.** An interviewer records or uploads a clip
against a question (`question_prompt`, `prompt_media_id` — both existed with
no code). The candidate's screen autoplays it, refuses forward seeking,
disables every answer control until `ended`, and reports the watch to the
server; `answer` and `finish` both refuse an unwatched required question, so
the gate is a rule, not a button. The clip is transcribed like an answer and
shown beside it on the review page. A live transcript preview appears while
speaking where the browser has a recogniser, labelled as a preview and never
stored. Every telemetry event carries `response_id` and `question_id`;
`question_shown`, `answer_started` and `prompt_playback_*` are new, so time
per question is a subtraction a reviewer can see. The self-view is
re-attached on the question screen (it used to record into a black box), the
camera is asked for only when a question needs one, and retake and skip are
server-side facts rather than local state.

**Phase 4 — evaluation and reporting.** Next. Evidence-gated scoring, the recruiter
dashboard, the paginated printable report.

**Phase 5 — mock interviews and retention.** The mock concept does not exist in
the schema at all, and the brief's 24-hour rule is currently unrepresentable:
`retention_days` is an integer with a floor of 1 and the sweep's arithmetic is
in whole days. Both need schema work. Retention also does not currently touch
respondent PII, telemetry or responses — only media — and the sweep has a
truncation bug that orphans objects past the first hundred.

**Phase 6 — code responses.** The editor dependency and question type.

## Carried findings not yet fixed

Recorded here so they are not lost between phases.

- The retention sweep deletes at most 100 objects but marks every row deleted,
  leaving objects that no row can name and that the orphan sweep classifies as
  claimed. The orphan sweep itself has no caller.
- `sessions/upload/begin` enforces no byte ceiling at all, and `SessionRecorder`
  sets no bitrate against a 25 MB transcription cap, so moderated recordings
  become untranscribable within a minute or two.
- A retake mints a new client token and leaves the superseded take `stored`,
  billed and listed with no current-take marker.
- Session transcripts never reach the analysis: sources are built from
  `interview_responses` and session media has `response_id: null`.
- A 402 wallet refusal is classified permanent and never retried, contradicting
  its own comment.
- The analysis chat timeout is 8 seconds against a 24k-token prompt.
- `viewer` can read participant emails through the participants route and the
  interview page, which is the role designed not to see respondents.
- Nothing ever writes a `failed` transcript status, so a failed transcription
  blocks analysis for that interview for ever and renders "Transcribing…"
  permanently.
