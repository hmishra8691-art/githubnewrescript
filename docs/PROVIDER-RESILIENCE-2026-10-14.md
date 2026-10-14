# AI provider errors in Intelligent Mode — audit, root cause, fix (2026-10-14)

**Symptom.** A researcher submits a natural-language prompt ("create a survey…") and gets *THE PROVIDER REFUSED THE REQUEST — The provider refused the request.* (401/403/429), with no detail and the work gone.

## Root causes (from the code, and reproduced in the browser suite)

| # | Cause | Where |
|---|---|---|
| 1 | The execute stage built **every plan item in one HTTP request** (route `maxDuration` 180 s, per-item provider timeouts 180–300 s). A long build was cut off by the platform, which answers with a **non-JSON** page → the client built `describeFailure("provider", undefined)` = the detail-less card. Every item already built was lost. | `app/api/copilot/turn/route.ts`, `useCopilot.run` |
| 2 | One retry, pause ≤ 5 s, no jitter, `Retry-After` only as seconds, **no memory between requests** (each researcher hammered a provider that had just said "slow down"), no concurrency limit. | `packages/ai` `postChat` |
| 3 | 401, 403, 404, 429 and 5xx all reached the card as the same sentence; a spent quota looked like a rate limit; a 403 that was a rate limit looked like a permission. | `failure.ts` |
| 4 | No checkpoint: prompt and built items lived in React state only; a reload or a failure lost them; no resume. | `useCopilot` |
| 5 | No fallback provider; no health view; no structured log. | — |

## What changed

**`packages/ai/src/provider.ts` (new) — the AI request manager**, used by `completeJson` and the embeddings/OCR calls.
- `ProviderError` with a `kind` (rate_limited, quota_exhausted, overloaded, server, network, timeout, auth, forbidden, not_found, bad_request, busy), `retryable`, `retryAfterMs`, `contextTooLong`. `classifyResponse` reads status + body + headers (a 429 about credit ≠ a rate limit; a 403 about a rate limit ≠ a permission).
- `Retry-After` in seconds / HTTP date / `retry-after-ms` / `anthropic-ratelimit-*-reset` / `x-ratelimit-reset-*`.
- Bounded exponential **equal-jitter** back-off (default 3 retries, ≤ 30 s a wait) **inside the caller's deadline**: a wait that does not fit ends the call with `retryAfterMs` so the caller saves its work and returns later.
- Per-provider **lane**: shared cool-down after a 429, concurrency limit (`AI_MAX_CONCURRENCY`, default 6) halved by a 429 and widened by successes; a refused key or spent quota is remembered 30 s (no pointless re-asking).
- **Fallback provider** only when configured (`AI_FALLBACK_API_URL/KEY/MODEL`, https, all three required) and only for failures a second provider can cure; never for a malformed request.
- Structured log lines (`retry`, `recovered`, `gave_up`, `refused`, `fallback`) with no key and no prompt; `providerHealth()`; `GET /api/ai/health`; `onEvent` callback.
- `capacityNotice()` — a heads-up only when the provider's rate-limit headers say < 5 % of the allowance is left.
- `completeJson` gained `deadline`, `onEvent`, `operation`; timeouts are `ProviderError` kind `timeout`.

**Copilot route.** Own clock (`ROUTE_BUDGET_MS` 165 s): provider calls get a deadline; items are built only while there is time for another; the rest is returned as **pending** with the built replies (`stage: "progress"`) — a checkpoint, never a timeout. `done[]` from the browser means a built item is never asked again (no duplicates, no double billing); `applied` marks items already in the open proposal (context only); `finalize` turns what exists into a proposal (partial: coverage pass skipped). Failures are always JSON, HTTP 503 + `Retry-After` when temporary. A prompt the provider says is too long is retried once in compact form. Identical in-flight calls share one provider call (`singleFlight`). Fake-provider-only test seams: `faults`, `budgetMs`.

**Browser.** `lib/copilot/resume.ts` (checkpoint in memory + `localStorage`, merge, backoff, statuses). `run()` auto-retries temporary failures (including a platform 504 page or a dropped connection), continues progress rounds, stops after bounded stalled rounds. Card: *"Temporarily waiting for AI capacity. Your work has been saved."* + countdown + **Resume now**; *"Resuming survey generation…"*; *"Your survey draft is ready for review."*; paused/failed cards with **Resume / Review what's ready / Build the remaining N / Discard**; a reload restores the card as *"Your generation was interrupted"*. New failure codes: capacity, auth, forbidden, quota, not_found, interrupted — **no status code or provider text** on a card; an administrator note names what to check.

**Billing.** Unchanged contract, now pinned by `providerBilling.test.ts`: `meteredAi` releases the hold on any throw and settles only a returned call; retries happen inside the call (one settle); built items are not re-asked.

## Tests
- `packages/ai`: 63 pass (new `provider.test.ts`: Retry-After forms, classification, backoff, success / 429 recovery / consecutive 429s / timeout / 500–503 / 401 (and not re-asked) / 403 / quota / deadline / concurrency / lane health / fallback configured, unconfigured, half-configured, failing / network / log has no secrets / `onEvent` / context-too-long / capacity notice).
- `apps/studio`: 383 pass (new `resume.test.ts`, `providerBilling.test.ts`, extended `failure.test.ts`).
- Browser `scripts/provider-resilience-test.mjs`: 16 scenarios (429 recovery, consecutive 429s, Retry-After countdown, timeout, 503, platform 504 page, dropped connection, 401, 403, failure after N items → resume with no duplicates, route time-budget checkpointing, reload mid-generation, quota spent mid-build → Review what's ready → Build the rest, Discard, a provider that stays busy, single-reply path). Existing copilot suites re-run green.

## Limits stated honestly
- Provider limits cannot be removed; the Studio paces itself, waits, resumes and keeps the work. Nothing errors unless the provider's allowance or the wallet is actually exhausted — and then the work is kept.
- Lane state is per server instance (serverless runs several); the checkpoint design does not depend on it.
- The checkpoint is in the researcher's browser (not cross-device).
