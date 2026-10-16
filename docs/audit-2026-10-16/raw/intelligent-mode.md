# AI (Phase 5: Intelligent Mode) — raw audit

Date: 2026-10-16. Area: AI copilot pipeline (brief → design → questionnaire → logic/quotas → analysis plan → analytics). Scratch scripts: `docs/audit-2026-10-16/repro/ai/` (`brand-tracker.mjs`, `validation-loss.mjs`, `misattributed.ts`, `plan-review.mjs`; outputs `run1.txt`, `run2.txt`). No source files modified. No dev server, no browser, no DB.

## 0. Test runs (executed)

| Suite | Command | Result |
|---|---|---|
| Studio copilot/architect/builder | `cd apps/studio && node --experimental-strip-types --no-warnings --test "lib/copilot/*.test.ts" "lib/architect/*.test.ts" "lib/builder/*.test.ts"` | **91 pass, 0 fail** (20.1 s) |
| Engine action layer | `cd packages/engine && node --test dist/surveyActions.test.js dist/actionValidation.test.js dist/quotaActions.test.js dist/optionActions.test.js dist/analysisFramework.test.js dist/coverage*.test.js` | 90 pass, 0 fail |
| Engine coverage / research blockers / analysis actions | `node --test dist/relevance.test.js dist/researchBlockers.test.js dist/analysisActions*.test.js` | 9 pass |
| Analytics plan bridge | `cd packages/analytics && node --test dist/planBridge.test.js dist/planCheck.test.js` | 17 pass |
| AI provider client | `cd packages/ai && node --test dist/retry.test.js dist/reply.test.js dist/jsonmode.test.js dist/provider.test.js dist/ceiling.test.js` | 42 pass |

`packages/engine/dist` was rebuilt 2026-10-16 (newer than `src`), so the repro scripts below exercise current code.

## 1. Pipeline trace — where context lives, what is structured

| Stage | Where the context lives | Structured vs free text | Loss risk |
|---|---|---|---|
| Research brief (researcher's words + uploaded docs) | Message: request body only (`turn/route.ts:124`), checkpointed in `localStorage` while in flight (`resume.ts:45`), recorded as `prompt` in the operations store (`operations.ts`, migration 0047). Documents: research store (migration 0045, memory fallback `durable.ts`). Structured brief: `def.research.brief` only after a `set_research` action is applied (`surveyActions.ts:814`). | Free text in; `brief` structured out (`coerceOne` set_research, `surveyActions.ts:306-308`). | The typed brief is persisted only as an operation prompt; the model's running `memory` is not persisted at all (**AI-05**). |
| Objectives / hypotheses / constructs / KPIs | `def.research` (`schema/src/survey.ts:165-207`): `hypotheses[]` by position, `hypothesisDetails[]` aligned by index, `constructs[].questionIds`, `kpis[]`. Outlined back to the model every turn (`outline.ts:68-77`). | Structured (`set_research`, `set_hypothesis`, `add/remove_hypothesis`). | Hypotheses are addressed by POSITION ("H1"). `remove_hypothesis` relabels dependants (`optionActions.ts:661-691`); `set_research` replacing the list does not (**AI-03**). |
| Research design → questionnaire | Plan stage (`changePlan.ts`, schema `CHANGE_PLAN_SCHEMA`) then one `completeJson` per item (`route.ts:304-337`); single-reply path when plan-first is off. | Structured: `COPILOT_REPLY_SCHEMA` (frame only) → `coerceCopilotReply` → `coerceSurveyActions`. | Single-reply generation that fails mid-way keeps only the prompt (**AI-07**). |
| Question types | `ACTION_TYPES` map → variant registry (`surveyActions.ts:129-154`); unknown type refused. | Structured. | Typed variants carry default validation (`questionCreate.ts:44`) that the action layer overwrites (**AI-01**). |
| Validation | `validations()` gate (`surveyActions.ts:186-201`), `shapeQuestion` (`:1127`), `validationFromSpecs` (`:1100`), `validateActionOutcome` (`actionValidation.ts`). | Structured; `check`/`when` conditions parsed strictly. | `message` dropped on create (**AI-02**); replace-not-merge semantics (**AI-01**). |
| Logic (display / skip / branch / loop / mask / punch) | `parseCondition` strict (`surveyActions.ts:1026-1036`), structured trees through `ConditionSchema` + `canonicalizeCondition` (`:1051-1064`), forward-reference and self-reference refused. | Structured (text expression or tree). | Verified: dangling refs refused with reasons (run1 §12). |
| Quotas / embedded | `quotaActions.ts` (cells on real codes, check placed after last read question), `create_embedded`/`update_embedded`. | Structured. | — |
| Runtime | Same `SurveyDefinition`; validated by `validateQuestion` (`validate.ts:379`). | n/a | Email/integer format not enforced when rule was dropped (run2). |
| Response schema / cleaning | Not AI-specific; same definition. | n/a | Not in scope (no AI-only fields; see §4). |
| Analysis plan | `def.research.analysisPlan` (`analysisPlan.ts`), `question.analysis` tags (`:41-59`), items carry `hypotheses[]`, `source: engine|copilot|researcher`. | Structured (`analysisActions.ts`, 12 ops). | Plan accepts a grid as a scalar test outcome without warning (**AI-09**, analytics area). |
| Analytics | `planBridge.ts` turns plan items into `AnalysisDefinition`s with `options.planned = <item id>` and `hypotheses` (`planBridge.ts:48,55`); findings turn reads the stored run (`route.ts:161-163`), never numbers the browser sends. | Structured. | — |

Classification of the chain as a whole: **IMPLEMENTED** (linked end-to-end: brief → `def.research` → `question.analysis`/constructs → `analysisPlan` → `planned` analyses → run verdicts by H-label), with the specific breaks listed in §6.

## 2. Structured generation — the action vocabulary

`coerceSurveyActions` (`surveyActions.ts:206-325`) accepts only ops in `SURVEY_ACTION_OPS` (70 ops + 8 UX aliases): 20 base (`create_block, rename_block, delete_block, create_question, update_question, delete_question, move_question, set_display_logic, add_skip, clear_skips, set_validation, page_break, create_embedded, create_calculation, create_randomizer, create_branch, create_loop, set_research, add_punch, remove_punches`), 11 UX (`create/update/remove_style|animation|behavior, set_theme, set_custom_html, set_default_value`), 12 analysis (`set_question_analysis, propose_analysis_plan, set_analysis_plan, add/remove_crosstab, add/remove_analysis_test, add/remove_derived_variable, update_crosstab, update_analysis_test, reorder_analysis_plan`), 8 localization, 6 quota, 13 option/misc (`update_option, reorder_options, set_option_randomization, set_mask, clear_mask, duplicate_question, set_survey_settings, update_embedded, remove_embedded, add/remove/set_hypothesis, set_custom_code`).

Per op: the coercion is hand-written (typed, trimmed, bounded) — not zod — but every result is applied on a clone and the whole definition is re-parsed with `SurveyDefinitionSchema` (`surveyActions.ts:434-438`); a batch that fails the schema returns the input unchanged (`valid:false`). Conditions given as trees are zod-validated (`ConditionSchema`, `:1052`). Ids come from a time-based minter (`questionOps.ts:32`) so output ids are not deterministic across runs; the client re-evaluates the proposal itself and applies its own result, so the server preview's `touched` ids are informational only (acknowledged in `client.ts:50-57`).

Free-form content the model may emit and where it is gated:

| Field | Gate | Verdict |
|---|---|---|
| `create_behavior.script`, `set_custom_code.js` | `validateUxScript` (`ux.ts:707-756`): lexer-based forbidden identifiers, `rs.*` API allow-list, targets resolved, compiled with `new Function` but never called; runs in the renderer sandbox (`uxSandbox.ts:342`) | IMPLEMENTED (run1 §11: `fetch(...)` refused) |
| `set_custom_html.html` | regex refuses script/iframe/style/handlers/javascript: (`uxActions.ts:330,340`) | IMPLEMENTED |
| `create_style.css` | `compileStyle` scoped to target, no html/body/:root/@import | IMPLEMENTED (prompt.ts:176) |
| `set_custom_code.css` | **none** — stored raw (`optionActions.ts:729`), injected raw (`QuestionRenderer.tsx:2814`) | **AI-06** |
| `set_translations` | placeholder/HTML/glossary checks (`localizationActions.ts`) | IMPLEMENTED (tests pass) |

`JSON.parse` / `eval` on model output: the only parses of model text are `completeJson.read` and `parseJsonReply` (`packages/ai/src/index.ts:1022-1038, 1343-1346`), both wrapped in try/catch and followed by the coercion gate; no `eval`/`new Function` runs model text outside the UX sandbox path above. `calc.ts` is an interpreter (no eval).

## 3. Error recovery (turn route + provider client)

Code read: `app/api/copilot/turn/route.ts`, `packages/ai/src/index.ts:1219-1398`, `packages/ai/src/provider.ts`, `lib/copilot/failure.ts`, `lib/copilot/resume.ts`, `components/intelligent/copilot/useCopilot.ts:474-740`.

| Event | Provider client | Route | Browser | Verdict |
|---|---|---|---|---|
| 401 / 403 / 404 | `classifyResponse` → `auth`/`forbidden`/`not_found`; not retryable (`provider.ts:76`); fallback provider tried once if configured (`index.ts:1295-1307`) | `failureOfError` → `failedTurn` HTTP 502 with `failure` card (`route.ts:249-259`); in a plan build: `halted`, built items returned (`:329-333`) | Card title/message/next/admin from `failure.ts:128-147`; "Resume" keeps the checkpoint | IMPLEMENTED |
| 429 / 5xx / network | Retries ≤3 with jittered backoff or `Retry-After`, never past the caller's deadline (`provider.ts:265,521-530`); shared lane cool-down; `exhausted` ProviderError | HTTP 503 + `Retry-After` header; plan build returns `stage:"progress"` with `waiting.retryAfterMs` | `exchange()` auto-retries ≤ `MAX_AUTO_RETRIES`=5 (`useCopilot.ts:539-545`), `MAX_STALLED_ROUNDS`=3; wait is researcher-interruptible | IMPLEMENTED (bounded) |
| Timeout | `AbortError` → `ProviderError{kind:"timeout"}` (`index.ts:1391-1393`); clamped to the route deadline `ROUTE_BUDGET_MS`=165 s (`route.ts:69`) | items built only while ≥ max(30 s, 1.5×slowest) remains (`:308`); rest returned as `pending` | checkpoint merged (`mergeBuilt`), card shows "n of m built" | IMPLEMENTED |
| Malformed / prose / truncated JSON | continuation on `finish_reason:"length"` up to 8× (`index.ts:1361-1367`); one re-ask for the object alone; then `AiReplyError{truncated|unparseable|empty}` | `failureFromReplyError` → card (`failure.ts:226-230`) | shown with "ask for less / use Plan first" | IMPLEMENTED |
| Context too long | `contextTooLong` → `fitting()` re-sends a compact prompt once (`route.ts:240-247`) | | | IMPLEMENTED |
| Partial actions (some refused by the engine) | | one repair call with the refusals (`route.ts:402-427`), kept only if more actions pass; `validation.results[]` per action with reason + `suggestion` | review lists refused actions; unticked actions excluded by flat index (`client.ts:70-103`) | IMPLEMENTED |
| Page reload mid-build | | | checkpoint in `localStorage` (TTL 24 h, `resume.ts:40-59`), restored as an "interrupted" card with Resume / Review what's ready (`useCopilot.ts:729-738`) | IMPLEMENTED |
| Wallet / internal mode / BYOK connection | | `refusalResponse` → `failureOf` maps to wallet/internal_mode/connection (`route.ts:118`) | | IMPLEMENTED |
| Route-level 400/401 (bad body, no session) | | plain `{error}` without `failure` (`route.ts:113,125,127`; `guard.ts:109`) | mapped to the generic "provider" card (`useCopilot.ts:594,606`) | **AI-04** |
| Unexpected client exception | | | `catch` sets `error: e.message` with no `failure` (`useCopilot.ts:660-663`): raw JS text under "COULD NOT ANSWER" | residual, see AI-04 |

Does a long generation that fails mid-way lose the work? **Plan-first (default on): no** — each item's reply is checkpointed server→browser→`localStorage`, never rebuilt, never charged twice (`route.ts:286-298`, `useCopilot.ts:559-573`). **Single-reply (plan-first off, or model returned no plan): yes** — only the prompt is kept (`resume.ts:21 kind:"turn"`), the card says "the partial answer was not applied" (**AI-07**, by design).

## 4. Cross-mode consistency

- Storage: an AI proposal is applied with `s.replace(state.after)` (`useCopilot.ts:969`), i.e. the same store path as any manual replace → `normaliseQuestionOrder` + `withOptionCodes` (`store.tsx:703-709`, `migrateLegacyCustomCode` + `canonicalizeSurveyConditions`) → the same debounced `/api/surveys/[id]/draft` save which re-parses with `SurveyDefinition.safeParse` and reports dropped fields (`draft/route.ts:53,77`). Readback goes through `migrateLegacyCustomCode(initial)` (`store.tsx:235`) and a one-time repair-on-load (`:834-843`). **IMPLEMENTED: same definition, same path.**
- AI-only fields: none on questions/flow. Provenance only: `analysisPlan.source: engine|copilot|researcher` (`analysisPlan.ts:131`), translation `origin: ai|manual|…` (`localization.ts:184-190`), `research.updatedAt`. `def.research` can be written by hand too (Research tab) — not AI-only.
- Regeneration vs manual edits: there is no "regenerate"; a new generate request is a proposal of actions against the current definition. Deletions/replacements are `destructive` and need confirmation (`surveyActions.ts:645,654,702`); `set_research` merges field by field and keeps the analysis plan (`:807-814`); a proposal whose base changed underneath is replayed (`rebaseProposal`) and must be re-approved (`useCopilot.ts:955-958`). **IMPLEMENTED.**
- Apply writes the whole `after` clone, so any manual edit made after the proposal's base is detected as `stale` (`useCopilot.ts:356`) rather than silently overwritten.

## 5. Generation quality — 29-action brand-tracker repro

`node docs/audit-2026-10-16/repro/ai/brand-tracker.mjs` (output in `docs/audit-2026-10-16/repro/ai/run1.txt`): set_research with brief/KPI/constructs, 4 blocks, 11 questions (numeric age with 3 rules + message, single, multi with exclusive, yes/no, long text, 4×5 matrix, single with Other, NPS, **email** with a max_length rule, dropdown), 2 skips to screen_out, 3 display-logic (one by label, one by `!= 99`, one unquoted label), a mask, a Gender×Age dimension quota (500), 4 `set_question_analysis` tags, `propose_analysis_plan`, `add_analysis_test`.

- Coercion: 29/29 accepted. Apply: 28/29 ok, `valid=true`, 0 warnings, 0 destructive. The one refusal is correct: `PREF = Brand A` (unquoted label with a space) → "does not parse … did you mean Brand A?" (the hint repeats the model's own text; it should say "quote it or use its code: PREF = 1" — P3, **AI-10**).
- Logic: label `AIDED = "Brand A"` canonicalised to code (`Q5.O1`), `AIDED != 99` → `notSelected 99`; skips placed; quota check placed after Screening; cells 84/84/83/83/83/83 = 500.
- Validation attached: AGE `[min_value 18, max_value 99, integer]` (**message "You must be 18 or over" lost**); runtime: 17 → "at least 18", 25.5 → "whole number", 130 → "at most 99". EMAIL: `[max_length 120]` only — **the variant's `{kind:"email"}` rule is gone; "not-an-email" is ACCEPTED at runtime.**
- Research context: brief, hypotheses (details `[{},{}]` — model gave no `set_hypothesis`), constructs linked to question ids, KPI; tags on 4 questions; plan 5 crosstabs + 5 tests with H-labels; `coverageReport.ok = true`.
- Review: quota uncovered combinations warning (legitimate), single-item constructs, required open end. Quality errors: 0.
- Partial/broken reply (§12 of the script): matrix without rows refused, display logic on the unmade question refused, skip to `NOT_THERE` refused, tag on missing question refused — each with its reason; the rest applied.

`node docs/audit-2026-10-16/repro/ai/validation-loss.mjs` (`run2.txt`): email+required → `[required]`, "nope" ACCEPTED; integer+min_value → `[min_value]`, 2.5 ACCEPTED; phone+max_length → `[max_length]`, "abc" ACCEPTED. Without any validation from the model the variant default is kept and enforced.

## 6. Findings

| ID | Sev | Class | Finding |
|---|---|---|---|
| AI-01 | **P1** | BROKEN (repro) | Typed-variant format rules (email / integer / phone / url / zip) are silently dropped whenever the model attaches any validation to `create_question`, and by any `set_validation`. Root cause: `shapeQuestion` assigns `q.validation = a.validation.map(…)` (`packages/engine/src/surveyActions.ts:1127`) over the variant default set by `createQuestionFromVariant` (`questionCreate.ts:44`, e.g. `text.email` → `[{kind:"email"}]`, `variants.ts:832-835`; `numeric.integer` → `[{kind:"integer"}]`, `:937-941`); `set_validation` likewise replaces (`:701`). Repro: `docs/audit-2026-10-16/repro/ai/validation-loss.mjs` — "not-an-email" accepted by `validateQuestion` on an AI-made email question with a `required` rule; 2.5 accepted on an integer question with `min_value`. Expected: a question of type email always validates email. Fix: in `shapeQuestion` and `set_validation`, merge — keep the variant's intrinsic kinds (`email`, `phone`, `url`, `zip`, `integer`) unless the action explicitly removes them; or have the prompt's type table say the rule is intrinsic and the engine re-add it. Add a test: `create_question type:"email" validation:[{kind:"required"}]` → kinds include `email`. |
| AI-02 | P2 | PARTIAL (repro) | Validation `message` is dropped on `create_question` unless the rule has `when`/`check`: `shapeQuestion` keeps only `kind`+`value` (`surveyActions.ts:1127`); the full builder `validationFromSpecs` (`:1100-1116`, keeps `message`) runs only in the `some(r => r.when || r.check)` branch (`:552-554`). Repro run1 §3: AGE `min_value 18` message "You must be 18 or over" absent. Fix: always build create_question rules through `validationFromSpecs` after the question exists. |
| AI-03 | P2 | BROKEN (repro) | `set_research` with a new `hypotheses` list re-numbers H-labels by position but does not relabel `question.analysis.hypotheses` or the plan items' `hypotheses` (`surveyActions.ts:793,809` only realigns `hypothesisDetails` by text). `remove_hypothesis` does relabel (`optionActions.ts:661-691`), so the two paths disagree. Repro run1 §9: after reordering, `AD_RECALL` still tagged `H1`, which now names the age hypothesis; the plan review only reports a side-effect ("H2 … is tagged on an item that does not read what it is about"). Fix: in `set_research`, map old→new index by text (as `hypothesisDetails` already does) and relabel tags on questions and plan items; drop labels that no longer match and warn. |
| AI-04 | P2 | BROKEN (repro) | Route refusals that carry no `failure` — 401 "Not signed in." (`lib/guard.ts:109`), 400 "send the survey as it is open in the editor (definition)" / "say what you want" (`turn/route.ts:125,127`) — are shown as **"THE AI SERVICE COULD NOT PROCESS THIS REQUEST … If it keeps happening, tell your administrator"** with the real text hidden in `detail` (`useCopilot.ts:594,606` → `describeFailure("provider", …)`, `failure.ts:119-123`). Repro `docs/audit-2026-10-16/repro/ai/misattributed.ts`. A session expiry is blamed on the AI provider. Also the catch-all at `useCopilot.ts:660-663` shows a raw JS exception under "COULD NOT ANSWER". Fix: route returns a `failure` for its own 4xx (a `session`/`request` code); client maps 401 → sign-in card and shows `d.error` for 400. |
| AI-05 | P2 | PARTIAL | Conversation memory is not persisted. Turns live in a module-level `Map` (`IntelligentView.tsx:118,144`) and `memoryFrom(copilotTurns)` (`useCopilot.ts:525`) is rebuilt from it; the operations store keeps `prompt`/`statusDetail` but not `reply.memory` (`lib/copilot/operations.ts`, no `memory` field). After a reload the next turn is sent `{history: []}`: objective/constraints agreed in chat but not yet applied via `set_research` are gone. Fix: persist `memory` (≤800 chars) on the operation record and seed `TurnMemory` from the latest records on load. |
| AI-06 | P2 | BROKEN (repro) | `set_custom_code.css` is applied without any gate and rendered unscoped: stored raw (`optionActions.ts:87,729`), injected via `<style dangerouslySetInnerHTML>` inside the question card (`packages/renderer/src/QuestionRenderer.tsx:2814`) — not through `sanitizeStylesheet`/`scopedHtml` (`engine/src/html.ts:109`, `scopedHtml.ts:83`) that `create_style` uses, and the prompt's "no html/body/:root" rule applies only to styles. Repro run1 §11: `& { color: red } body { display:none }` accepted ("custom CSS (38 characters)"). A model (or the manual Properties field — same path) can hide the page or the Next button for every respondent; a string containing `</style>` breaks out of the element. Fix: run `sanitizeStylesheet` + scope to `[data-qid="…"]` at apply (`editCss`) and at render; refuse `html|body|:root` selectors as `compileStyle` does. |
| AI-07 | P3 | PARTIAL (by design) | Single-reply generation (plan-first off, or no plan came back) that ends in `truncated`/`timeout` keeps only the prompt (`resume.ts` kind `"turn"`); all generated actions are lost and the card says so (`failure.ts:160`). Plan-first builds are checkpointed per item. Known limit; fix = default plan-first for `generate` (already default on) and keep the partial JSON for a "salvage" parse. |
| AI-08 | P3 | PARTIAL | The repair call omits `schema` (`turn/route.ts:410`) while plan/item/turn/coverage pass `COPILOT_REPLY_SCHEMA`; on a provider without json mode the repair reply is more likely prose and is then dropped silently (`repair.fixed=false`). One-line fix. |
| AI-09 | P3 | UNVERIFIED (analytics area) | `propose_analysis_plan` plans `t_test`/`chi_square`/`regression` with a 4-row `matrix_single` as the scalar outcome and `reviewAnalysisPlan` raises nothing (`docs/audit-2026-10-16/repro/ai/plan-review.mjs`; `measurementOf` treats `matrix_single` as ordinal, `analysisFramework.ts:71`). Whether the runner flattens rows or fails is for the analytics audit. |
| AI-10 | P3 | PARTIAL | Unquoted option label in a condition (`PREF = Brand A`) is refused with the hint "did you mean Brand A?" — the model's own text — so the repair pass must guess (one extra model call). Hint should say "quote the label or use the code (PREF = 1)". |

## 7. Classification summary

| Feature | Class | Evidence |
|---|---|---|
| Action gate (`coerceSurveyActions` → engine apply on a clone → schema re-parse) | IMPLEMENTED | §2, 90 engine tests, run1 |
| Condition parsing (strict, codes, forward/self reference refusal) | IMPLEMENTED | run1 §2/§12 |
| Validation attachment for AI-generated questions | **BROKEN** for typed variants + any rule | AI-01, AI-02 |
| Brief → research design → tags → plan → analytics link | IMPLEMENTED, with AI-03 reorder break | §1, §5, planBridge tests |
| Coverage gate + second pass | IMPLEMENTED | `route.ts:436-464`, relevance tests |
| Plan-first generation with checkpoint/resume | IMPLEMENTED | §3, resume/copilot tests |
| Provider retry/fallback/classification | IMPLEMENTED (bounded) | §3, 42 ai tests |
| Failure cards for provider failures | IMPLEMENTED | `failure.ts` |
| Failure cards for route 4xx / client exceptions | **BROKEN** (misattributed) | AI-04 |
| Conversation memory persistence | PARTIAL | AI-05 |
| Free-form JS gate | IMPLEMENTED | §2 |
| Free-form CSS gate (`set_custom_code.css`) | **BROKEN** | AI-06 |
| Same store/save/readback path as manual edits | IMPLEMENTED | §4 |
| Architect/builder libs (`lib/architect`, `lib/builder`) | IMPLEMENTED (UI structure helpers, not part of the model pipeline) | tests pass |

## 8. Known limits (code-verified, not defects)

- Per-process state: turn cache (`route.ts:56`, 15 min), provider lanes/cool-downs (`provider.ts:40-44`), memory stores when migrations 0045/0047 are missing (`durable.ts`) — several serverless instances do not share them.
- Route budget 165 s of `maxDuration` 180 (`route.ts:28,69`); an item slower than the remaining budget is handed back as pending, not lost.
- Test seams `fake`, `faults`, `budgetMs` are honoured only with `AI_PROVIDER=fake` (`route.ts:206,224,228`).
- BROWSER-REPRO NEEDED for AI-04 wording on the live card: open Intelligent mode, let the session expire (or send with an empty message via devtools), observe the "THE AI SERVICE COULD NOT PROCESS THIS REQUEST" card.
