# Metered Usage, Project Wallets & Cost Allocation

*Commit `5e6f4da` (container) — apply on the Mac as `0002-billing.patch`. Package `@rescript/billing` (14 tests); `scripts/billing-test.mjs` (browser, end to end); `scripts/billing-sql-test.sql` (migration 0023, incl. a 4-way race); `scripts/auth-guard-audit.mjs` 121/121.*

**Simulation mode.** No money moves. An administrator assigns credits; every billable operation is metered against the project's wallet at a **customer charge derived from the actual cost by a configurable pricing model**. Real payments later write the same ledger line with a payment reference — the metering does not change.

## Architecture

```
Studio / Runtime feature ──► Metering service (apps/*/lib/metering.ts)
                                 │  estimate → check → RESERVE → run → record → SETTLE / release
                                 ▼
                        @rescript/billing  (pure: config · pricing · registry · wallet math · Meter)
                                 │
                 ┌───────────────┴────────────────┐
        SupabaseMeterStore                  MemoryMeterStore
        (migration 0023; balance            (sandbox /sandbox, tests,
         arithmetic atomic in SQL)           database-less installs)
```

`packages/billing/src`: `config.ts` (BillingConfig + `BILLING_CONFIG_FIELDS`), `pricing.ts` (`priceOperation`, `depositProjection`), `registry.ts` (events + rates, `findRate`, `providerCostFor`), `wallet.ts` (records, `summarizeWallet`, `usageByCategory`, `usageTimeline`, `forecastUsage`, `balanceLevel`, `READ_ONLY_MESSAGE`), `meter.ts` (`Meter`, `MeterStore`, `priceSpec`), `store-memory.ts`, `store-supabase.ts`.

## Pricing (never "deduct raw cost")

```
providerCost (+ API markup) + infraCost (+ infra markup) = base
target_margin:  charge = base / (1 − margin − feeRate − taxRate)      feeRate = processor% + fixedFee/assumedPayment
markup:         charge = base × (1 + margin) / (1 − feeRate − taxRate)
paymentFee = charge × feeRate · taxReserve = charge × taxRate
grossProfit = charge − actualCost · netProfit = grossProfit − paymentFee − taxReserve · marginPct = netProfit / charge
```
Defaults: margin 50 %, processor 6.5 % + $0.30/$100, reserve 0, min charge $0.001, low $20, critical $5, read-only $0, overdraft off, TEST free. Example: $10 cost → **$23.15** charge (not $15): $10 cost, $1.57 processor, $11.57 platform (50 %). A fixed `customerRate` on a registry row bypasses the model (e.g. `rescript.runtime.response` $0.02 per completed interview). Zero-cost work (cache hits, non-billable events) is recorded at $0 and never charged the minimum.

## Registry

**Events** (`DEFAULT_BILLABLE_EVENTS`, overridable in `billing_events`): AI_REQUEST (priced from AI_INPUT_TOKEN/AI_OUTPUT_TOKEN rows), TRANSLATION_CHARACTER, TRANSLATION_REQUEST (off), SURVEY_RESPONSE, SURVEY_RESPONSE_STARTED (off), SURVEY_SESSION/SURVEY_RENDER/API_REQUEST (off), STORAGE_GB, FILE_UPLOAD, BANDWIDTH_GB, DATABASE_STORAGE_GB (off), VOICE_MINUTE, TEXT_TO_SPEECH_CHARACTER, SPEECH_TO_TEXT_MINUTE, AUDIO/VIDEO_PROCESSING_MINUTE, GEOCODE_REQUEST, EMAIL_MESSAGE, REPORT_GENERATION (off), EXPORT_GENERATION (off), DATA_PROCESSING (off), CUSTOM_EVENT. Category → dashboard bucket (ai, translation, responses, storage, bandwidth, infrastructure, voice, export, processing, other); unit → how it is counted. `registerBillableEvent` for new features.

**Rates** (`DEFAULT_RATES`, stored in `billing_rates` once edited): `provider/service/model[/side]`, `providerCost` per `unitSize` (Google $20 / 1M chars; claude-sonnet-4-6 $3/$15 per 1M in/out; claude-haiku-4-5 $1/$5; gpt-4o-mini $0.15/$0.60; `*` fallback $3/$15 so an unknown model is never free; TTS $15/1M chars; STT $0.006/min; storage $0.021/GB-month; upload $0.00005/MB; egress $0.09/GB; geocode $0.005; email $0.0004), `markupPct`, `customerRate`, `effectiveFrom/Until`, `active`, `estimated`. Provider ids: `google`, `openai-compatible` (the endpoint kind; model = AI_MODEL), `deepl`/`microsoft` (inactive until adapters exist), `supabase`, `rescript`, `geocode`, `resend`, `browser` (free), `fake`.

## Database (migration 0023)

`billing_config` (id=1, jsonb) · `billing_rates` · `billing_events` · `project_wallets` (customer_id, survey_id unique / null = workspace wallet, `shared_wallet_id` for the explicit shared-wallet feature, balance, reserved, total_added, total_used, state active|read_only|suspended, per-wallet overdraft override) · `usage_reservations` (held|settled|released|expired, TTL) · **`usage_events`** and **`wallet_ledger`** — immutable (trigger raises on UPDATE/DELETE; a correction is a reversal row `adjusts_event_id` + a `reversal` ledger line) · `credit_requests`.

Functions (security definer, revoked from anon/authenticated; thresholds passed in from the config): `rescript_billing_wallet_for(customer, survey, create, seed)`, `_reserve(wallet, …, amount, floor, ttl)` — `select … for update`, refuses when `balance − reserved − amount < floor`; `_settle(reservation, event jsonb, read_only_threshold)` — debits the ACTUAL charge, releases the hold, writes usage + ledger, recomputes state; `_release`, `_record` (no hold), `_credit(wallet, amount, kind, reason, note, by, expires, reference, usage_event, threshold)`, `_expire_reservations`. RLS: tenant read via `current_customer_id()`; writes through the service role behind the apps' guards.

## Metering service

**Studio** `lib/metering.ts`: `getMeter()` (database) / `getSandboxMeter()` (memory, seeded `BILLING_SANDBOX_CREDITS`, default 100); `billingProjectFor(user, body.surveyId, capability)` — the body names the project, the caller must hold `survey.edit` on it (sandbox id accepted without a session); `meteredAi(meter, ctx, "AI_REQUEST", { estimateText, maxTokens, operation }, fn)` — reserve from prompt tokens + max_tokens, settle with the provider's reported usage (collected through `@rescript/ai`'s `collectUsage` AsyncLocalStorage — no signature changed; `complete()` reads `usage.prompt_tokens/completion_tokens`, estimates when absent); `meteredTranslation(...)` — reserve from characters × 1.25, settle with the characters Google actually billed (protected text, wrappers included) or the LLM's tokens; `refusalResponse` → **402** insufficient / **423** read-only or suspended; `assertNotReadOnly(kind)`; `recordUsage`; `projectContext(gate)`. Metered: `/api/ai/rephrase`, `/api/ai/translate` (cache hits free), `/api/ai/tts`; recorded: responses export (EXPORT_GENERATION), analytics export (REPORT_GENERATION), audio upload (FILE_UPLOAD), invitation emails (EMAIL_MESSAGE); read-only respected by exports (unless `allowExportsWhenReadOnly`) and sends. `BILLING_SIMULATE_FAKE_COSTS=1` prices the fake providers as the real ones (development only).

**Runtime** `lib/metering.ts`: `definitionForProviderCall` now returns `billing: { customerId, surveyId, environment: TEST|LIVE, sessionId }` (null for a preview); `meteredSessionAi` around `classify`/`sentiment` (session/ai) and `writeProbe` (probe) — a refusal leaves the value unset and the interview continues; geocode → GEOCODE_REQUEST; upload → FILE_UPLOAD; save at `status = complete` → **SURVEY_RESPONSE** (screen-outs are not completes); `recordSessionUsage` writes an **unbilled** $0 row (`metadata.unbilled`, `wouldHaveCharged`) when the wallet cannot cover a completed interview — data is never lost to the meter; `sessionAllowed` refuses a new LIVE interview on a read-only project with 423 when `lockRespondentsWhenReadOnly` (default on; TEST-free sessions always allowed; resumes untouched).

## Statuses & thresholds

`balanceLevel`: normal → low (≤ lowBalanceThreshold) → critical (≤ criticalBalanceThreshold) → locked (≤ readOnlyThreshold). `walletStateFor`: read_only at/below the read-only threshold, active above, suspended manual. Message: *"Your project has reached its usage limit. Please request additional credits from your administrator."* Available = balance − reserved + overdraft room − minimumRemainingBalance; two concurrent reservations cannot both take the last dollar.

## API

Project: `GET /api/surveys/[id]/billing` (`billing.read`; `sandbox` id → memory) → wallet, summary (initial/added/used/remaining/reserved/available, cost split, today/week/month), level + message, thresholds, policy, categories, byEnvironment, 30-day timeline, recent (50), forecast (avg daily over `forecastWindowDays`, days remaining, trend %), ledger, requests; `POST { action: "request_credits", amount, reason, message }` (`billing.request_credits`: owner/editor). User: `GET /api/billing/me` (projects from `rescript_my_projects`). Admin (`requireBillingAdmin` = platform admin; database-less install → memory meter without a session): `GET/PUT /api/admin/billing/config`, `GET/PUT/DELETE …/rates`, `GET/PUT …/events`, `GET …/wallets[?survey=]`, `POST …/wallets {action:"ensure"}`, `PATCH …/wallets` (state, overdraft, shared wallet), `POST …/credit { walletId|surveyId, amount ±, reason, note, expiresAt }`, `GET/POST …/requests` (approve with custom amount / reject, note), `POST …/reverse { eventId, note }`. Audit events `billing.*`.

## UI

Studio: **Usage & Wallet** tab (Management, not in EDITING_TABS): banner by level, wallet card (remaining, progress used/total, initial/added/used/remaining, "where the usage went" split), Usage tiles (today/week/month/projected remaining + trend, LIVE/TEST chips, thresholds line), usage by category, 30-day bars, Credits card (Request additional credits: $10/$50/$100/$500/$1,000 presets or custom, reason, message; request list; wallet history), recent usage table (what · quantity · env · actual cost · charge). Header **wallet badge** (`bl-wallet-badge`, coloured by level, opens the tab) and a **read-only bar** across the Studio at the limit; the three share one cached fetch. `/billing` My usage (totals, by project, by category, recent, requests; header links "My usage"). `/admin/billing` Billing Administration: Wallets & credits (table with balance/added/used/month/margin/level; Credits… panel with presets, reason, note, expiry, Add/Remove, suspend/reactivate, per-wallet overdraft, cost split, ledger, project usage with **Reverse**; "Create wallet" by project id), Credit requests (pending/all, approve custom amount + note, reject), Configuration (every field grouped with help + a worked $100 / $10 example), Cost registry (edit/new/remove rates), Billable events (billable, unit, category, active). Test ids: `wallet-badge`, `wallet-readonly-bar`, `usage-panel[data-state]`, `wallet-banner[data-level]`, `wallet-remaining`, `usage-progress`, `usage-chart`, `usage-forecast`, `usage-categories`, `usage-row`, `request-*`, `admin-*`, `cfg-*`, `rate-*`, `event-*`.

## Access

Capabilities `billing.read` (every role that can open a project) and `billing.request_credits` (owner, editor). Audio (`/audio`) and glossary (`/glossary`) writes now require the edit lock (`requireEditRight`). The guard audit knows the shared gates `requireAiCaller`, `requireTranslationCaller`, `requireBillingAdmin` (honoured only while their own source calls a real guard) and accepts their `if (!gate.ok) return gate.response` shape.

## Deployment

Apply `supabase/migrations/0023_billing.sql` (after 0022). Nothing else: the Studio's `/admin/billing` → Configuration seeds defaults on first save; rates seed themselves from `DEFAULT_RATES` on first edit. Assign a project's first credits from Wallets & credits ("Create wallet" with the project id, then Add). Development: `BILLING_SIMULATE_FAKE_COSTS=1` with the fake providers.

## Open

- Infrastructure is estimated per event (`estimatedInfrastructureCostPer*`); actual database / storage / bandwidth / compute metering from provider usage data is a store job that writes STORAGE_GB / BANDWIDTH_GB / DATABASE_STORAGE_GB rows.
- Voice minutes (VOICE_MINUTE, SPEECH_TO_TEXT_MINUTE) are registered but the browser Web Speech path is free; a cloud voice adapter would report `seconds`.
- Reservation expiry (`rescript_billing_expire_reservations`) has no scheduler; run it from a cron or on the admin wallets read when one exists.
- Credits `expiresAt` is recorded on the ledger but not yet enforced.
- Real payments: a `payment` ledger kind + a webhook writing `rescript_billing_credit` is the whole integration.
