# AI cost audit — JavaScript-related copilot calls (2026-10-17)

**Complaint.** "Each JavaScript-related AI call appears to deduct a fixed amount even when the work is small."

**Verdict.** There is no fixed fee. Every call is priced from the tokens the provider reported. But every call carries the same large fixed prompt (the system prompt and, for a behaviour request, the UX guide), sent at full input price with no provider prompt caching. Every call also asks for a whole new script. Together these put a floor of roughly $0.12–0.24 under even a one-line change. Caching of the stable prefix now fixes the first part. The second part, output, is now the larger share, and J's `edits` op is what addresses it.

Measured with `node --experimental-strip-types --no-warnings scripts/ai-cost-report.mjs [template]`. Tokens are estimated at 4 characters per token, which is the meter's own estimator. Prices use the default rate table and the default margin configuration.

## 1. Where AI work is charged

| Call (copilot route `apps/studio/app/api/copilot/turn/route.ts`) | When | Operation | Reserved output (budget.ts `expected`) |
|---|---|---|---|
| query embedding | research turns with embeddings | `copilot_query_embedding` | 1 |
| plan | a generation, plan-first | `copilot_plan` | 2,000 |
| item | each approved plan item | `copilot_<mode>_item` | 4,000 |
| turn | every other request (edit / ux / question / review) | `copilot_<mode>` | edit 2,500 · ux 3,500 · review 3,000 · generate 8,000 |
| repair | the Studio refused some actions and time remains | `copilot_<mode>_repair` | 2,500 |
| coverage | a generation whose research coverage has gaps | `copilot_<mode>_coverage` | 8,000 |

Other JavaScript-adjacent calls are `ai/logic` (`logic_intent`) and `import/custom-logic` (`import_custom_logic`). Each is one `meteredAi` call.

**The flow** (`apps/studio/lib/meterRun.ts` `meteredCore` → `packages/billing` `Meter`):

1. The project AI switch.
2. Whose AI is used.
3. `reserve`: the estimated input (characters/4 + 120) at the input rate, plus the expected output, held on the wallet.
4. The call runs inside `collectUsage`.
5. `settle`: ONE usage event priced from the reported tokens.
6. If the call throws, `release`.

A reservation can be settled exactly once. Memory store: `status !== "held"` throws. SQL `rescript_billing_settle` (0034): `if r.status <> 'held' then raise`. The reservation is the idempotency token of one logical call. `usage_events.idempotency_key` additionally de-duplicates replays where a caller supplies one.

**Retries, continuations, failures:**

- **Provider retries** (`packages/ai/src/provider.ts` `managedSend`): 429, 5xx and network errors, 3 retries by default.
  - Only a successful response reports usage, so retried attempts are never charged.
  - A fallback provider's usage is reported by whichever provider answered.
  - The compact retry after a context-too-long 400 (`fitting`) reports nothing for the refused attempt.
- **Continuations** (`completeJson`, `finish_reason: length`): up to `continuations` (8 in Intelligent mode). Also the one "that was not JSON" re-ask.
  - Each is a full request and reports its own usage.
  - Inside the one `collectUsage` they sum into ONE event (`metadata.requests` = number of requests). They are not charged separately.
- **A failed call is released, not charged.** `meteredCore` releases on throw, including after part of the call reported usage. Examples: a continuation timed out, or the reply was still `truncated` / `unparseable` after the provider was paid. The platform absorbs that cost; the customer does not pay for a failed call. This is a policy choice in the customer's favour, and the tests now pin it.
- **The route never charges a skipped call.**
  - A repair that is refused for policy reasons is not sent (`skipped: "policy"`).
  - A repair or coverage pass whose `meteredAi` is refused, or that throws, is not charged.
  - An answer served from the route's 15-minute `CACHE` makes no call and no charge.
  - A request that joins an identical in-flight call (`shared`, single-flight) reports no usage, so its own hold is released and it is not charged.
- **No duplicate charges found.** Each logical call produces one reservation, one settle and one event.

**Fixed and minimum charges:**

- **AI_REQUEST has no fixed rate.** Its event rate is `null`. Production rows show `fixedRate: false`, `estimated: false`. The charge is `(providerCost + infra) / (1 − 0.50 − 0.068)` = provider cost × 2.315 (+ infra).
- **The infrastructure estimate is the one fixed component.** `estimatedInfrastructureCostPerAiRequest` is $0.0002 per call, which becomes a $0.00046 customer charge per call.
- **Minimum floor.** `minimumChargePerOperation` is $0.001 by default (an admin setting; 0 disables it). It lifts only a charge below $0.001.
  - Example: a runtime classification on gpt-4o-mini, 300 in / 10 out, is modelled at $0.00058 and lifted by $0.00042 to $0.001.
  - It never touches a copilot call, the smallest of which is about $0.09.
  - It was already visible as `metadata.minimumApplied`. The event now also records `metadata.minimumLift`, the amount added. The floor is kept, since it is a configured policy.

**Script execution is never metered.**

- Behaviours, styles and animations run in the respondent's browser.
- The runtime meters only:
  - completed responses (`SURVEY_RESPONSE`, $0.02 customer rate)
  - classify / sentiment / probe (`meteredSessionAi`)
  - speech
  - geocoding
- The Studio's validation of a script (`applySurveyActions`, the script lint) is deterministic engine code, not a model call.

## 2. Token composition of a typical JavaScript request

Request: "On Q, add JavaScript: when the typed age is 18 or more show 'Yes, you are an eligible voter', keep Next disabled until then". It runs as a UX turn with memory and two recent turns.

| Piece | chars | ≈ tokens |
|---|---|---|
| `COPILOT_SYSTEM_PROMPT` | 14,793 | 3,699 |
| `COPILOT_UX_GUIDE` (every behaviour request) | 13,850 | 3,463 |
| outline: screener template (7 questions) | 2,466 | 617 |
| outline: master demo (160 questions) | 19,422 | 4,856 |
| memory + recent turns | 146 | 37 |
| **total input, master demo** | 48,535 | **12,134** (production copilot_ux: 12,362) |
| other guides when sent: analysis / translation / quota / list fill / findings | | 1,235 / 925 / 732 / 844 / 396 |

Before this change, the guides came after the outline in the user message. The only text identical between two calls was therefore the system prompt, and nothing was cached: the copilot used Anthropic's OpenAI-compatible endpoint, which does not apply prompt caching.

As now sent, the system blocks are [system prompt, guides]: 28,645 characters, about 7,162 tokens, and the same bytes on every behaviour request. That is the **cacheable share**: 59% of the master-demo request and 91% of the screener request.

**Output is the other half of the cost.** Production behaviour calls return 2,000–2,300 output tokens (whole scripts) and questions up to 4,800. At $15 per million against $3 per million for input, 2,215 output tokens cost as much as 11,000 input tokens.

## 3. Cost before / after (claude-sonnet-4-6; Anthropic cache read = 10 %, 5-minute write = 125 % of input)

| Call (production sizes) | in / out | before | after, cache warm | after, first call (write) |
|---|---|---|---|---|
| copilot_ux | 12,362 / 2,215 | $0.1632 | **$0.1185 (−27 %)** | $0.1757 (+8 %) |
| copilot_ux_repair | 14,640 / 2,102 | $0.1751 | **$0.1304 (−26 %)** | $0.1876 (+7 %) |
| copilot_question (system prompt only cacheable) | 9,770 / 4,822 | $0.2357 | $0.2126 (−10 %) | $0.2422 (+3 %) |

- The "before" charges reproduce the production records exactly.
- For a turn followed by its repair, which reads what the turn wrote: $0.3383 → $0.3061 (−10 %).
- If the cache is already warm from an earlier request within 5 minutes: $0.2489 (−26 %).
- The cache lives on the provider for 5 minutes and is refreshed on every hit, so a researcher iterating on behaviour pays the write once per session.
- After caching, output is about 65 % of a copilot_ux charge.

## 4. What changed

**`packages/ai`:**
- `completeJson(system: string | string[], …)`. Blocks are the stable prefix.
  - **Anthropic** (base on `anthropic.com`): called natively at `POST /v1/messages`, with `x-api-key`, `anthropic-version` and the workspace header, and `cache_control: ephemeral` on each system block (up to 4).
  - The reply, `stop_reason: max_tokens` → `length`, and the usage are read back into the same shape as before.
  - If the native API refuses the request's shape (400 that is not quota or context, or 404), the request is sent once more through the OpenAI-compatible endpoint, and that base is remembered (`native_refused` log).
  - **OpenAI-style**: the blocks are joined into one leading system message, so automatic prefix caching hits.
- Caching is **opt-in per call**: on with blocks or `promptCache: true`. A plain-string system prompt is sent exactly as before. `AI_PROMPT_CACHE=off` disables it everywhere.
- `chatUsageFrom` reads `cache_read_input_tokens` / `cache_creation_input_tokens` (Anthropic) and `prompt_tokens_details.cached_tokens` / `cache_write_tokens` / `prompt_cache_hit_tokens` (OpenAI-style, DeepSeek, gateways).
- `AiUsage.cachedInputTokens` and `cacheWriteTokens` are subsets of `inputTokens`, summed by `sumUsage`.

**`packages/billing`:**
- Rate sides `cache_read` and `cache_write`.
- Default rows for every listed chat model:
  - Anthropic: read 10 %, write 125 %.
  - gpt-4o-mini: read 50 %, no write row.
  - `*`: read 0.30, write 3.75.
- `cacheRateFor` takes the cache row of the **same model as the input row**, never another model's. When there is none, cached tokens are priced at the input rate, as before.
- `UsageSpec.cacheReadUnits` and `cacheWriteUnits`. `priceSpec` prices uncached input, cache read, cache write and output separately. The margin model is unchanged.
- The event metadata gains:
  - `tokens {input, cachedInput, cacheWrite, uncachedInput, output}`
  - `rateCacheReadId` / `rateCacheWriteId`
  - `minimumLift`
- `ChargeBreakdown.minimumLift`.

**Studio:**
- `meterRun.usageToSpec` carries the cache units.
- `lib/aiPromptCache.ts` (`copilotCall`, `splitStable`) lifts the guides out of the user text, verbatim, into the second system block.
- The copilot route's 5 model calls (plan, item, turn, repair, coverage) pass `...copilotCall(text)`.
- The admin rate editor offers the two new sides; previously, saving a cache row would have made it single-sided.

**Migration `0060_ai_prompt_cache_rates.sql`** (re-runnable, verified on Postgres 16):
- Widens the `side` check.
- Inserts the cache rows only when the table is already materialised. An empty table means "use the code's defaults", which already include the cache rows. Inserting into an empty table would have made those 13 rows the whole rate table.

## 5. Not changed (reported)

- **Usage UI.** `components/billing/shared.tsx` `describeQuantity` shows "N tokens", which is input plus output.
  - Showing "x cached" needs `billingView.publicEvent` to forward `metadata.tokens` and `describeQuantity` to print it. That is three lines in two files outside this change.
  - The data is on every new AI event.
- **Output budget** (`lib/copilot/budget.ts`):
  - Every kind asks for the 32,000-token ceiling, with 8 continuations. This does not affect what is charged (billing is on actual output) or the reservation (which uses the expected size, ux 3,500).
  - The bound on a runaway UX call is 9 × 32,000 output tokens, about $4.3 provider cost or $10 charged, and the settle debits beyond the hold.
  - Recommendation: 2 continuations for edit, ux and repair.
  - This was left alone because "Intelligent mode does not ration the answer" (Phase 7) is a documented product decision.
- **Route `CACHE`.**
  - It keys on survey, user, connection, the system prompt, the whole user prompt (mode, memory, guides and look-only flags are all in it) and `maxTokens`. That is correct.
  - It covers the single turn only, not plan or item, and it is per process, so hit rates on serverless are low.
  - The theme-image URL is applied after the cache, so it does not need to be in the key.
- **The repair re-sends the previous answer** (up to 14,000 characters) and the whole user prompt. Its system blocks are now read from the cache. Sending only the refused actions would cut its variable part, but that is `repairPrompt`, which is J's.
- **Runtime and interviews metering** (`apps/runtime/lib/metering.ts`, `apps/interviews/lib/metering.ts`) do not forward cache units. Their calls do not opt in to caching, so they are priced as before.

## 6. Configuration and rollout

- No new variable is needed: caching is on for the copilot.
  - `AI_PROMPT_CACHE=off` returns the copilot to the OpenAI-compatible endpoint.
  - `AI_ANTHROPIC_VERSION` is optional (default `2023-06-01`).
- Deploy the code, then apply migration 0060. Code that predates the change cannot parse a `cache_read` row.
- **Live check:**
  1. Make two behaviour requests within 5 minutes.
  2. The second event's `metadata.tokens.cachedInput` should be about 7,000 or more, and `providerCost` should be lower.
  3. There should be no `native_refused` lines in the log.
- Anthropic caches a prefix only above a model-specific minimum: 1,024 tokens on Sonnet, more on some models. The 3,700-token system prompt alone may fall below the minimum on such models; with the UX guide (about 7,200 tokens) it does not.
