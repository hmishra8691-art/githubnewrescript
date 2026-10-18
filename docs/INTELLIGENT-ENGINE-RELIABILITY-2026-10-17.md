# Intelligent Mode reliability: the production failures, the classifier, staging and the failure taxonomy (2026-10-17)

Engineer A. Scope: the copilot route, the copilot's classification and plumbing, the engine's routing of unsupported requests, error mapping. The evidence comes from `intelligent_operations` (read-only queries on the production project), last 21 days.

## 1. The evidence: root cause, fix and test for each

### #1, 2026-10-16 12:49: a ~25k-character pasted brief got questions back instead of a plan
**What the log shows.** `mode generate`, `promptChars 43,698`, charge $0.155, status `clarify`. The model answered "I have a few questions… before generating 80–120 questions across 10+ blocks". The researcher got no plan and no survey. The log kept only the first 4,000 characters.

**Root cause (three defects):**
1. **The route cut the request to 8,000 characters without saying so** (`body.message.trim().slice(0, 8000)`). A 25k brief reached the model as roughly its first third. The hypotheses, questionnaire requirements, analysis plan, reporting section and "make assumptions, don't ask" instruction were all cut. The model asked for what it had not been sent.
2. **The plan stage carried every guide.** Keyword intents fired on a brief that mentions everything (analysis, quotas, translation, MaxDiff, findings, styling). The ~40k characters of action guides went with a call whose job is a list of items. That is where the 43,698 characters came from.
3. **The plan stage invited questions** (`"questions": [...]`, 3–15 items). A reply with questions and no items was not a plan, so the route fell through to the single-reply generation of the whole brief, which is the call most likely to be cut off.

**Fix:**
- The route reads up to `MAX_MESSAGE_CHARS` = 60,000 characters (`prompt.ts`) after `normalizeBrief`. Past that limit it answers 413 with an honest `too_long` card: nothing is sent and nothing is charged.
- `normalizeBrief` removes markdown noise and keeps the meaning. It strips bold and italic markers, heading hashes, horizontal rules, code fences, table alignment rows, link syntax, HTML comments and emoji. It keeps headings, numbered and bulleted lists, table rows and every word. It applies Unicode NFC and keeps the Devanagari joiners U+200C/U+200D.
- A pasted brief (`isLongBrief`: 1,500 characters or more, or structured with research words) is always planned first. The plan prompt now goes **without the action guides** (`copilotUserPrompt({ planOnly })`); the build items still carry them. The brief is labelled "A PASTED RESEARCH BRIEF… make the reasonable choice and list it under assumptions".
- `planStagePrompt({ longBrief })` requires assumptions, at most ONE question and up to 30 items. `coerceChangePlan(…, { maxQuestions: 1 })` enforces this. A reply that is not a plan is asked once more (`planRetryPrompt`, operation `copilot_plan_retry`). If there is still no plan, the researcher gets **one** focused question. A long brief never falls through to a single-reply generation.
- **Operation log.** `LIMITS.prompt` goes from 4,000 to 20,000 characters. A prompt over 4,000 characters also records `promptLength` and `promptSha256` in the intent; the SHA-256 is pure JS because the module ships to the browser. Migration `0063_intelligent_operations_prompt_20k.sql` relaxes the database check from 4,000 to 20,000. Until it is applied, `operationsStore.create` falls back to 4,000 when it gets the check violation, so no record is lost.

**Tests:**
- `engineReliability.test.ts`:
  - A ~24k fixture (`lib/copilot/fixtures/masterPromptBrief.mjs`, our own text). The old 8,000-character read loses the "Analysis Plan", "Reporting" and "Output Format" sections. The new read keeps all 18 sections and H1–H8.
  - Normalisation, including Devanagari.
  - The plan prompt carries no guides and is more than 30k characters lighter.
  - The plan keeps ≤ 1 question and up to 20 assumptions.
  - The production reply is not a plan.
  - The log keeps 20,000 characters plus length and a SHA-256 that matches `node:crypto`; an update does not clobber the intent.
- `operations.test.ts` updated.
- Browser: `intelligent-engine-test.mjs` [1].

### #2, 2026-10-16 13:04: a 30–35-minute survey with loops failed with "the connection to the AI service was interrupted"
**What the log shows.** The `api_calls` entry has no `mode`, no `promptChars`, and charge 0. **No JSON from the route reached the page.** Every JSON answer of the route carries `context.mode` and `promptChars`. Until the AI-04 change that afternoon (`failure.ts` 16:31), a request that got no answer at all (HTTP status 0) was shown with the `network` card ("THE MODEL COULD NOT BE REACHED"). Today it is `unreachable`.

**Root cause, as far as the evidence goes.** The turn was a generation ("design a full survey, a new separate survey…") and went plan-first. A single request could stay open and silent for up to 165 s, the route's own clock: the plan call is non-streaming, uses the 32k output ceiling and allows up to 8 continuations, and the build kept starting items while time remained. The browser then auto-resent it (up to 5 times, each as long). A connection dropped by the client's network, a proxy or a sleeping phone produces exactly this record. The request was spoken (a voice transcript). The time budget, not the 180 s Vercel limit, is the binding constraint: a platform cut-off is a 504 page and would have read "timeout".

This **cannot be proven from the database**. The Vercel log line for that request would settle it.

**Fix:**
- **One stage per request.** `STAGE_SOFT_MS` = 90 s: no new plan item is started after 90 s of a request. What is built goes back as a checkpoint (`stage: "progress"`) and the browser asks for the next batch at once. Requests stay short; each stage's output is kept and shown (`cp-progress`). The existing plan → items mechanism is used with idempotent stage ids (`done[]`, `sanitizeDone`, now exported from `changePlan.ts`).
- The plan prompt is lighter (no guides), so it is faster.
- A **timeout** is auto-resent **once** (`autoRetriesFor`), not five times. The provider layer has already retried inside the request. After that the card offers Resume, which continues from the checkpoint.

**Tests:**
- `engineReliability.test.ts`: idempotent stage ids (first reply for an id wins; applied items are context only; a retried item lands once) and bounded resends.
- Browser [2]: four requests, one stage each, progress, applied once on a double click.
- Browser [3]: a timeout on stage 3 keeps 1–2 and retries 3; a provider that keeps timing out stops with the work kept, and Resume builds only the rest.

### #3, 2026-10-13 20:17: a Hindi brief failed with "THE PROVIDER REFUSED THE REQUEST" right after its plan
**What the log shows.** A plan at 20:13 (status `clarify`, kind `plan`, 7+ items). At 20:17 a `generate` record with no engine handoff (this is the `executePlan` path), charge 0, and no `promptChars`, so again no JSON reached the page.

**Root cause.** "THE PROVIDER REFUSED THE REQUEST" is the **pre-2026-10-14** title of the `provider` card. That code built every approved item in **one** request (7+ items × up to 300 s each). The platform cut the request off at 180 s with a non-JSON page, and the page turned "no JSON" into `describeFailure("provider")`. This is root cause #1 of `PROVIDER-RESILIENCE-2026-10-14.md`. It was fixed on 10-14: a checkpointed build, and `failureFromTransport` for non-JSON answers.

**It was not a refusal of the request.** The brief is a valid research request (the scope reads it as supported with hypotheses). Devanagari is not an issue: NFC, the JSON round trip and the prompt are all lossless. The prompt was 16,868 characters, so size was not the issue either. No title containing "REFUSED" remains for a non-JSON answer.

**Today's addition:** the 90 s stage cap described under #2.

**Tests:**
- `engineReliability.test.ts` "#3 a Devanagari brief survives the whole path".
- Browser [4]: the Hindi Mumbai brief is planned, not refused.
- Browser [2]/[3]: staged builds.

### #4, 2026-10-14 11:50: "So, question number two as a men's flip-flop mode." failed with "THE AI SERVICE COULD NOT PROCESS THIS REQUEST"
**What the log shows.** `promptChars 8,965` is present, so the route answered with its own failure JSON, code `provider`. That code is reached only by a `ProviderError` of kind `bad_request`, or by an exception whose words matched nothing.

**Root cause.** The sentence is ordinary: a speech transcript, scoped as supported, 8.9k characters. That morning the Studio had just been pointed at a fresh Anthropic key/workspace. Anthropic answers an empty balance with **HTTP 400** "credit balance is too low", which the classifier read as `bad_request` until the fix that same day (`PROVIDER-400-CREDIT-2026-10-14.md`). No model turn succeeded on any survey until 16:18 that day, 4.5 h later, which is consistent with an account problem and not this sentence.

A second, latent path to the same card was found: **an exception inside the Studio** (a TypeError, an unset scope) was also shown as "the AI service could not process this… try rephrasing".

**Fix:**
- Since 10-14, the credit 400 maps to `quota`.
- Today, a non-`ProviderError` exception maps to `unexpected` ("something went wrong in the Studio"), not `provider` (`failureFromError(…, { studio: true })`). Its words stay in the log only.

**Tests:** `engineReliability.test.ts` "#4": every `ProviderError` kind maps to a card with no status code, key, provider words or stack. A Studio exception maps to `unexpected`. An old-style "(401)" message still maps to `auth`. The logged detail is redacted at the source.

## 2. The classifier: one, extended, before generation
- `packages/engine/src/requestScope.ts` (re-exported through `nlIntent.ts`) provides `requestScope(text)`:
  - **supported**, with the categories touched: research planning, hypotheses, qualitative, quantitative, mixed methods, survey (creation/modification/programming), advanced methods, analysis, data quality, reporting, translation, scripting.
  - **mixed**: names the outside clauses.
  - **unsupported**.
  - **ambiguous**: a greeting or a bare "help".
- **Conservative by construction.** A request is unsupported only if it matches an explicit off-topic shape (a poem or joke, booking a flight or hotel, the weather, a recipe, scores, prices, alarms, music, images, homework, cover letters, building an unrelated app; Hindi and Hinglish forms included) **and** has no research or survey cue in English, Hinglish or Devanagari. Text over 1,500 characters is never unsupported. Follow-ups ("yes, go ahead", "build it", "undo that") have no off-topic shape, so they stay supported.
- **The engine** (`interpretRequest`, first step):
  - unsupported → `refused`, category `unsupported` (new; 24 categories), with the exact sentence. **No model call and no charge**; the browser answers locally.
  - ambiguous → one `clarify` with choices.
  - mixed → `model`, with the outside parts in `detected`.
  - A long brief is no longer captured by the MaxDiff-design shortcut.
  - "Add a hypothesis ABOUT X" is handed to the model to write the statement. It used to record "About price sensitivity" verbatim.
- **The route** reads the same scope for any caller:
  - unsupported → the sentence, `usage.charge 0`, `context.modelCalled false`, before metering.
  - mixed → the prompt says what is outside and not to mention it, and the Studio appends `outsideNote(...)` to the reply.
  - Theme assistant and plan-execution requests are not re-read.
- **Localized edits are not generations** (`classifyRequest`). On a survey with ≥ 3 questions, a short request that starts with an edit verb and does not name the whole survey is an edit. Before this, "Add a hypothesis about price sensitivity" and "Include them in the analysis plan with the hypothesis" went to plan-first generation because any "hypothesis" did.
- **Section 15 context:**
  - `memoryFrom` and `memoryFromOps` now end each copilot line with what it proposed, by name: `[proposed 3 actions: PRICE_1, PRICE_2, PRICE_3]`, `hypothesis “…”`, `display logic on PRICE_2 (PRICE_1 = 1)`. These are the referents of the next "it" or "them".
  - Recent turns go to the prompt at 500 characters, as the route keeps them (was 400).
  - The working definition (proposal applied) remains the outline.
- **Tests:**
  - Engine `requestScope.test.ts`: about 40 real phrasings never unsupported (English, Hinglish, Devanagari, the four evidence prompts, a structured brief); 16 off-topic requests unsupported with the exact sentence; mixed; ambiguous; long brief; hypothesis topic; MaxDiff in a brief.
  - Studio: the six-turn chain with the stand-in model checks that turn N's prompt contains what turn N-1 created and that no turn is `generate`.
  - Browser [4]/[5]/[6].

## 3. Staging, retries and honesty
- **Stages** use the existing plan → items mechanism:
  - The plan is one call, with retry once for a brief.
  - Items are built one call each. A request stops starting items after 90 s or when its clock is short, and returns a checkpoint. The browser drives the next request.
  - `done[]` ids are never built again; `applied` items are context only. Finalize turns what exists into a proposal.
  - A failed item is pending or failed and is retried by Resume. Partial results are kept (browser checkpoint plus localStorage).
- **Retries, by layer:**
  - Provider layer (`packages/ai` `managedSend`): up to 3 retries with equal-jitter back-off inside the request's deadline, and a shared cool-down per lane. Unchanged; verified.
  - Page: resends a temporary failure up to 5 times, except a **timeout, which is resent once**.
  - Stalled builds stop after 3 rounds with no progress.
  - Billing settles only returned calls; built items are never re-asked (`providerBilling.test.ts`, unchanged).
- **Never "success" when nothing happened:**
  - `honestReply`: if every proposed action was refused, the reply starts "Nothing was changed: none of the N proposed changes could be applied (…)". A reply that claims a change with no actions gets "(Nothing has been changed yet…)".
  - A build whose items came back empty says "Nothing was built…", and the card no longer shows "ready for review" (`useCopilot`: `doneBuilding` requires actions).
  - Apply is still idempotent (the proposal is cleared, and the operation-record transitions refuse a second number).

## 4. Failure taxonomy (what the researcher sees)
| Cause | Card (code) | Retried |
|---|---|---|
| 429 / 529 / 5xx / busy lane | capacity: "busy, your work is saved", countdown | provider ×3 in-request, page ×5 |
| Dropped connection to the provider | network | same |
| Provider timeout | timeout | provider in-request; page **once**, then Resume |
| Page got no JSON (status 0) | unreachable | page ×5 |
| Platform 504 page | timeout | page |
| 401 / key refused | auth (own provider: "your key") | never |
| 403 permission / disabled organisation | forbidden | never |
| Spent credit (402, 429-quota, 400 "credit balance") | quota | never; remembered 30 s |
| Unknown model | not_found | never |
| Context too long | too_long (after one compact retry) | — |
| Request over 60,000 characters | too_long, 413, nothing sent or charged | — |
| A genuinely malformed request (400) | provider, with an admin pointer | never |
| An exception in the Studio | unexpected (was: provider) | Resume |
| Cut off / prose / empty / nothing usable | truncated / unparseable / empty / unusable | — |

No card shows a status code, a key, provider words or a stack trace. The provider's words are redacted at the source (`redact`) and appear only in the server log (`said`).

## 5. Not done, and why
- **Streaming or keep-alive bytes from the route.** This would keep idle connections alive during a long model call; it is the definitive answer to #2-type drops. It changes the route/page protocol (NDJSON) across both sides, and all browser suites depend on the JSON shape. The 90 s stage cap gets most of the benefit with no protocol change. This is the recommended next step.
- **Migration 0063 is written, not applied to production.** Production DDL is the operator's step. The Studio is backward compatible meanwhile (it falls back to 4,000 characters).
- **#2, #3 and #4 are inferred from the operation log.** The log carries no server-side detail. The `[rescript:copilot] … failed` and `[rescript:ai] refused … said` lines in the Vercel log for those timestamps would confirm them.
- **The brief is resent with every item call** (it is the variable part of the prompt, so it is not cached). Summarising it into a structured intermediate once (objectives, constraints, sections) would cut item cost. The plan already carries the structure and an item prompt names its section, so this was left as a cost optimisation, not a reliability fix.
- `docs/` reference pages and `markdown.test.ts`/`publicDocs.test.ts` drift came from concurrent work and was green at the final run.

## 6. Files
- **Engine:** `src/requestScope.ts` (new), `src/requestScope.test.ts` (new), `src/nlIntent.ts` (scope first, `unsupported` category, hypothesis-topic hand-off, brief before the MaxDiff shortcut), `src/nlIntent.test.ts`.
- **Studio:**
  - `app/api/copilot/turn/route.ts`
  - `lib/copilot/prompt.ts`: `normalizeBrief`, `MAX_MESSAGE_CHARS`, `honestReply`, localized-edit rule, `planOnly` / `longBrief` / `scopeNote`, 500-character turns
  - `lib/copilot/changePlan.ts`: long-brief plan, `planRetryPrompt`, `maxQuestions`, `sanitizeDone`
  - `lib/copilot/client.ts`: `actionGist`
  - `lib/copilot/history.ts`, `lib/copilot/operations.ts`, `lib/copilot/operationsStore.ts`, `lib/copilot/failure.ts`
  - `lib/copilot/resume.ts`: `autoRetriesFor`
  - `components/intelligent/copilot/useCopilot.ts`
  - Tests: `lib/copilot/engineReliability.test.ts`, the fixture, `memory/copilot/operations` test updates
- **Database:** `supabase/migrations/0063_intelligent_operations_prompt_20k.sql`.
- **Browser:** `scripts/intelligent-engine-test.mjs`.
