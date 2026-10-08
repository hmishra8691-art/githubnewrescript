# Research Engine — Phase 1: Reliability (08-10-2026)

**Source:** the Research Engine audit (`RESEARCH-ENGINE-AUDIT-2026-10-08.md`, section K, Phase 1). The outcome it set: *the model path either works or says exactly why; the research design is editable.* Every change below is at the cause the audit named, has a regression test, and the tests were mutation-checked. Nothing existing was removed or rewritten except the dead `significanceLetters` the audit listed.

## Checklist

| ID | Audit finding | Change | Status |
|---|---|---|---|
| R1 | `AI_*` variables undocumented | `.env.example` gains a LANGUAGE MODEL section; `/platform` reports presence (never a value) and warns on a bad configuration | ✅ Fixed |
| R2 | `finish_reason` never read — a cut-off answer was parsed as a whole one | `completeJson` reads it and continues the answer (up to `continuations`, default 2); still cut off → `truncated` | ✅ Fixed |
| R3 | A prose reply became `null` and fell to the grammar | one retry asking for the object alone; prose twice → `unparseable`; nothing → `empty` | ✅ Fixed |
| R4 | JSON-schema mode never used | `response_format: json_schema` first where the provider takes it; refusal remembered per base and `json_object` / plain used instead | ✅ Fixed |
| R5 | "NOT UNDERSTOOD" for every model-path failure | a `TurnFailure` (code, title, cause, next steps) on the route, the card and the history; the engine-only card names the missing model | ✅ Fixed |
| R6 | Derived variables existed only inside `runPlan` | `buildFor` adds the plan's variables and segments to every dataset; a second pass is idempotent; a variable that could not be computed leaves its note on the results that read it | ✅ Fixed |
| R7 | Milestone runs used the "all" dataset | the cron runs on `clean` | ✅ Fixed |
| R8 | Factor analysis promised scores it never output | a per-factor summary table and per-case scores on the chart data, in dataset order, null where an item is missing | ✅ Fixed |
| R9 | `significanceLetters` dead | removed (the crosstab's `columnLetter` is the live one, tested elsewhere) | ✅ Removed |
| R10 | No way to edit the research design by hand | `ResearchDesignEditor` in Survey Settings and the Analysis tab | ✅ Added |

## Causes and fixes

**R2 / R3 / R4 — the model path says exactly why (`packages/ai/src/index.ts`)**

- **Cause:** `completeJson` returned `null` for anything it could not parse, and read nothing but `content`. A long generation stopped at `max_tokens` was a half-object; a provider without JSON mode answered in prose now and then; both became `null`, and the route's `null` became the grammar's "I did not understand that".
- **Fix:** `completeJson` reads `finish_reason` on every call. On `length` it re-asks with the partial answer as the assistant's turn and *continue exactly from where it stopped*, up to `continuations` times (0–5, default 2; the copilot passes 2 for generation and 1 otherwise), metering every call. What still cannot be read is thrown as `AiReplyError` with a code — `truncated` (budget, continuations, tail sample), `unparseable` (after one retry for the object alone; head sample), `empty` — and `isAiReplyError` lets the route tell it apart from a provider exception.
- **Schema:** `CompleteJsonOptions.schema` is sent as `response_format: json_schema`. A 400 that names the response format marks the base in `NO_JSON_SCHEMA` and the call is resent as `json_object` (where `acceptsJsonMode`) or plain; any other 400 is the provider's answer and is not retried. Anthropic's OpenAI-compatible layer names `json_schema` as what it takes, so it gets the schema and still never `json_object`. The copilot's schema (`lib/copilot/replySchema.ts`) is deliberately loose — `kind`, `reply`, `actions[].op` — so the gate and the engine remain the validators.

**R5 — a precise cause instead of "NOT UNDERSTOOD"**

- **Cause:** every failure on the model path — 501 (no model), 402 (wallet), a provider 4xx/5xx, a timeout, a cut-off answer, prose, a valid object with nothing in it, every proposed action refused — reached the researcher through the same fall-through to the grammar, whose unknown-intent card said the Studio could not read English.
- **Fix:** `lib/copilot/failure.ts` defines `FailureCode` and `describeFailure(code, detail)`: a title for the kicker, a sentence naming the cause and the next steps, built in one place. The route includes a `failure` in its 501, its 402/423 refusal, its 502 (from `failureFromError`, which tells timeout, provider status and network apart; or `failureFromReplyError`) and its unusable-reply body. (A proposal whose every action the engine refused already had its own surface — the card lists each refusal and disables Apply — so no new code was added for it.) `useCopilot` stores the failure on the entry and marks the turn failed. One case still reaches the grammar: a well-formed answer with nothing in it (`unusable`), where a phrasing the engine's recognisers handed on but the grammar parses ("call Q2 PLATFORMS") is offered as before, replacing the failed turn; when the grammar cannot read it either, the failed turn — not a second "could not read this" — is the answer. The card renders the kicker, "What to do" and, under it, **what the engine read** before it handed the sentence on (request type, detected objects, the recogniser's reason). Once a 501 has been seen the Studio knows there is no model: the engine-only card's kicker is *NO LANGUAGE MODEL — THE ENGINE COULD NOT READ THIS* and its text names `AI_API_URL`, the sentences the engine does read, and what it read from this one. The grammar's own card for an unknown intent is now *COULD NOT READ THIS*; "NOT UNDERSTOOD" no longer appears anywhere.

**R6 / R7 / R8 — analytics**

- `withPlannedVariables` is now called by `buildFor`, so the plan's derived variables and segments are columns of every dataset the Studio builds, not only inside `runPlan`. A derived column already present from an earlier pass is skipped without the "already has a variable" warning (the second pass is idempotent). A variable that could not be computed leaves its note in `Dataset.warnings`, and `runAnalysis` appends the notes that mention one of the analysis's variables to that result — only to results that read it.
- The milestone cron runs the plan on the `clean` dataset (`dataset: "clean"`), and `StoredRun` now carries the dataset spec it ran on, so the report says which.
- `factor()` outputs a `scores` table (per factor: n, mean, SD, min, max) and `chart.scores` (`factors`, one row per case in dataset order). `factorAnalysis` now returns `cases`, the input index of each scored row, because it scores complete cases only — without it the scores were in a different order from the dataset. A case missing an item has `null` scores and is not counted.

**R10 — the research design editor (`components/studio/ResearchDesignEditor.tsx`)**

- Objective, target population, methodology, planned completes; hypotheses with a coverage chip (testable / unplanned / unmeasured / unlinked, from `hypothesisCoverage`); constructs with role, definition and the questions that measure them; assumptions. Edits go through the store, labelled for undo.
- Removing a hypothesis goes through the engine's `remove_hypothesis`, which renumbers the later H-labels on every question and plan item that cites them — the one edit where a form writing the array would leave tags pointing at the wrong hypothesis.
- Mounted in Survey Settings (after Quality) and, compact, under the Analysis tab's hypotheses, which used to say "write them in the Research design" when there was none.

**R1 — configuration**

- `.env.example` documents `AI_API_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_WORKSPACE_ID`, `AI_API_HEADERS`, `AI_VISION_MODEL`, `AI_EMBEDDINGS_MODEL`, `AI_STT_*`, `AI_TTS_MODEL`, with what each does and what Intelligent Mode loses without one.
- `lib/aiConfig.ts` (pure, testable) reports presence only — `ai`, `aiFake`, `aiModel` — and `aiConfigWarning` says when none is configured, when the fake provider is in production, or when `AI_MODEL` is unset for a real endpoint. `platform.ts` includes both; no key value is read anywhere.

## Tests

| Suite | What it checks | Result |
|---|---|---|
| `packages/ai/src/reply.test.ts` | continuation reads one object and meters both calls; truncated after the continuations, with the budget and count; `continuations: 0`; prose retried once then `unparseable`; empty; schema → json_object → plain fallbacks; an unrelated 400 is not retried; Anthropic gets the schema and never json_object | 4 tests, ai 31 pass |
| `apps/studio/lib/copilot/failure.test.ts` | every code has a title, cause and next step; timeouts, provider status and network errors told apart; the reply error's budget and sample; not_configured names the variables | 4 pass |
| `apps/studio/lib/platformAi.test.ts` | presence flags, blank values, the three warnings | 3 pass |
| `packages/analytics/src/phase1.test.ts` | derived variables on a built dataset run a saved analysis; the second pass adds and warns nothing; the dataset note is inherited only by results that read the variable; factor scores table and per-case scores, null for a case missing an item | 3 tests, analytics 133 pass |
| `scripts/phase1-reliability-test.mjs` (browser) | the fake provider's unusable reply shows the cause, the next step and what the engine read; a 502 truncated, a 402 wallet and a 501 not-configured each show their own card; after the 501 the engine-only card names `AI_API_URL`, the examples and what it read, kicker *NO LANGUAGE MODEL — …*, badge *engine only*, no "not understood" anywhere; Survey Settings → Research design stores every field, a construct linked to Q4 and an assumption; removing H1 renumbers H2→H1 on the questions' tags; the Analysis tab's coverage follows a hypothesis added through its editor; `/api/platform` reports `ai`, `aiFake`, `aiModel` | 9 checks pass |

Mutation checks: ai 12/12 caught (two tests strengthened), analytics 9/9 (one test strengthened, which exposed the score-order defect fixed above), failure + aiConfig 12/12 (one test strengthened), Studio surfaces (route, client, view, card, editor) 10/10 through the browser suite (two checks strengthened).

Regression: `intelligent-mode-test.mjs` and `copilot-test.mjs` expected the fake model's empty answer to fall to the grammar's "not understood" card; they now expect the failed turn with its cause (and the grammar's reading where it has one). Both pass, with engine-first, findings-copilot, analysis-framework, history, oct06/oct07/october-review, the unit suites (`pnpm -r test`: 17 packages, 0 failures), both typechecks and the auth-guard audit.
