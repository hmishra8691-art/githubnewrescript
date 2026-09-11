# Metered Usage, Project Wallets & Cost Allocation

*Commits `0465f5f` (the system) and the credit-transfer / cost-visibility update (see below). Package `@rescript/billing` (16 tests); `scripts/billing-test.mjs` (browser, end to end incl. transfers and visibility); `scripts/billing-sql-test.sql` (0023, incl. a 4-way race) and `scripts/billing-transfer-sql-test.sql` (0024); `scripts/auth-guard-audit.mjs` 124/124.*

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

## Credit transfers (update, change 1 — migration 0024)

Administrators move UNUSED credits between wallets: project → project, project → person, person → project, person → person. **Personal wallets**: `project_wallets.user_id` (unique) — a person's own pool, created on first use by `rescript_billing_user_wallet_for` / `store.walletForUser`; creditable (`POST /api/admin/billing/credit { userId }`), a source and a destination, and a project can be pointed at it via `shared_wallet_id`. `wallet_for` was redefined so the workspace wallet is the one with neither project nor person.

**Rules, enforced in SQL** (`rescript_billing_transfer(source, destination, amount, reason, note, by, reversal_of, threshold)`): both wallet rows locked `for update` in id order (no deadlock between crossing transfers); only `balance − reserved` may move — never reserved money, never overdraft room; `same_wallet`, `invalid_amount`, `unknown_wallet`, `already_reversed` refusals; one `credit_transfers` row (`code` TRX-10001…, source/destination kind + ref, amount, reason, note, transferred_by, status completed|reversed, reversal_of, reversed_by) + two `wallet_ledger` lines — `transfer_out` on the source, `transfer_in` on the destination — both with the same `transfer_id`; balances change by exactly the ledger amounts, in the same transaction. The destination's `total_added` grows; the source's history stands. A trigger forbids DELETE and every UPDATE except the reversal linkage. **Reversal** = a new transfer in the opposite direction with `reversal_of`, ledger kind `transfer_reversal` on both sides; the original becomes `reversed` → `reversed_by`; refused if the destination has since spent the credits (`insufficient_available`) or it was already reversed. `Meter.transfer` / `Meter.reverseTransfer` validate and word the refusals; `MemoryMeterStore` mirrors the SQL exactly.

**API** (platform admin): `POST /api/admin/billing/transfer { source: {type: user|project, id}, destination: {…}, amount, reason?, note? }` → `{ transfer, source, destination }` (402 `transfer_insufficient_available` with `available`; 400 same wallet; 404 unknown); `POST … { action: "reverse", transferId, note }` (402 / 409); `GET …/transfer?project=&user=&admin=&status=&from=&to=&min=&max=` → history with `sourceLabel`, `destinationLabel`, `adminLabel`; `GET /api/admin/billing/lookup` → users and projects with `{ walletId, balance, available }`. Audit events `billing.credits_transferred`, `billing.transfer_reversed`.

**UI** `/admin/billing` → **Transfer credits**: source type (User / Project) → source select showing available per entry → *Available balance* tile (balance, reserved) → amount (inline error over available; button disabled) → destination type → destination (a person who owns projects offers "land the credits in: their own wallet / Project …") → reason, notes → **Transfer credits** → confirmation *"You are about to transfer $25.00 from Project A (project) to Project B (project). This action will be recorded in the billing ledger."* → Confirm. **Credit transfer history** below: Date · Transfer ID · Source · Destination · Amount · Admin · Reason · Status, filters by project, user, admin, status, date range, min/max amount; **Reverse** on completed originals. Ledger words everywhere: *Credit Transfer Out / In / Reversal*.

## Cost visibility (update, change 2)

The backend still computes and stores every component per event (provider cost, infrastructure, payment fee, tax/reserve, customer charge, gross/net profit, margin). **Who sees what is decided server-side** in `apps/studio/lib/billingView.ts`: `projectMeterView(..., { audience: "user" | "admin" })`. The **user** view carries `summary` without `costs` (plus `usedPct`), categories/timeline/byEnvironment with `charge` only, rows from `publicEvent` (activity, quantity, environment, **charge**); the **admin** view adds `costs` and `adminEvent` rows (actualCost, providerCost, infraCost, paymentFee, taxReserve, grossProfit, netProfit, marginPct). `/api/surveys/[id]/billing` sends the admin view only to a platform administrator and passes the user payload through `stripInternalCosts` (a defensive tree-strip of `INTERNAL_COST_KEYS`) so no future field can leak; `/api/billing/me` is user-only and stripped; `/api/admin/billing/wallets?survey=` is admin. Screens: the researcher's Usage & Wallet tab shows Wallet remaining / Used / Usage % / Status and a usage table of Date · Activity · Quantity · Env · Charge; My usage adds a Project column and the personal wallet; the words "actual cost", "provider cost", "gross profit", "margin" do not appear on researcher screens (asserted by the suite). The administrator's tables (`showCost`) add Actual cost and Margin columns and the wallet cost breakdown.

## Statuses & thresholds

`balanceLevel`: normal → low (≤ lowBalanceThreshold) → critical (≤ criticalBalanceThreshold) → locked (≤ readOnlyThreshold). `walletStateFor`: read_only at/below the read-only threshold, active above, suspended manual. Message: *"Your project has reached its usage limit. Please request additional credits from your administrator."* Available = balance − reserved + overdraft room − minimumRemainingBalance; two concurrent reservations cannot both take the last dollar.

## API

Project: `GET /api/surveys/[id]/billing` (`billing.read`; `sandbox` id → memory) → wallet, summary (initial/added/used/remaining/reserved/available, cost split, today/week/month), level + message, thresholds, policy, categories, byEnvironment, 30-day timeline, recent (50), forecast (avg daily over `forecastWindowDays`, days remaining, trend %), ledger, requests; `POST { action: "request_credits", amount, reason, message }` (`billing.request_credits`: owner/editor). User: `GET /api/billing/me` (projects from `rescript_my_projects`). Admin (`requireBillingAdmin` = platform admin; database-less install → memory meter without a session): `GET/PUT /api/admin/billing/config`, `GET/PUT/DELETE …/rates`, `GET/PUT …/events`, `GET …/wallets[?survey=]`, `POST …/wallets {action:"ensure"}`, `PATCH …/wallets` (state, overdraft, shared wallet), `POST …/credit { walletId|surveyId, amount ±, reason, note, expiresAt }`, `GET/POST …/requests` (approve with custom amount / reject, note), `POST …/reverse { eventId, note }`. Audit events `billing.*`.

## UI

Studio: **Usage & Wallet** tab (Management, not in EDITING_TABS): banner by level, wallet card (remaining, progress used/total, initial/added/used/remaining, "where the usage went" split), Usage tiles (today/week/month/projected remaining + trend, LIVE/TEST chips, thresholds line), usage by category, 30-day bars, Credits card (Request additional credits: $10/$50/$100/$500/$1,000 presets or custom, reason, message; request list; wallet history), recent usage table (what · quantity · env · actual cost · charge). Header **wallet badge** (`bl-wallet-badge`, coloured by level, opens the tab) and a **read-only bar** across the Studio at the limit; the three share one cached fetch. `/billing` My usage (totals, by project, by category, recent, requests; header links "My usage"). `/admin/billing` Billing Administration: Wallets & credits (table with balance/added/used/month/margin/level; Credits… panel with presets, reason, note, expiry, Add/Remove, suspend/reactivate, per-wallet overdraft, cost split, ledger, project usage with **Reverse**; "Create wallet" by project id), Credit requests (pending/all, approve custom amount + note, reject), Configuration (every field grouped with help + a worked $100 / $10 example), Cost registry (edit/new/remove rates), Billable events (billable, unit, category, active). Test ids: `wallet-badge`, `wallet-readonly-bar`, `usage-panel[data-state]`, `wallet-banner[data-level]`, `wallet-remaining`, `usage-progress`, `usage-chart`, `usage-forecast`, `usage-categories`, `usage-row`, `request-*`, `admin-*`, `cfg-*`, `rate-*`, `event-*`.

## Access

Capabilities `billing.read` (every role that can open a project) and `billing.request_credits` (owner, editor). Audio (`/audio`) and glossary (`/glossary`) writes now require the edit lock (`requireEditRight`). The guard audit knows the shared gates `requireAiCaller`, `requireTranslationCaller`, `requireBillingAdmin` (honoured only while their own source calls a real guard) and accepts their `if (!gate.ok) return gate.response` shape.

## Deployment

Apply `supabase/migrations/0023_billing.sql` (after 0022) and `0024_credit_transfers.sql`. Nothing else: the Studio's `/admin/billing` → Configuration seeds defaults on first save; rates seed themselves from `DEFAULT_RATES` on first edit. Assign a project's first credits from Wallets & credits ("Create wallet" with the project id, then Add). Development: `BILLING_SIMULATE_FAKE_COSTS=1` with the fake providers.

## Open

- Infrastructure is estimated per event (`estimatedInfrastructureCostPer*`); actual database / storage / bandwidth / compute metering from provider usage data is a store job that writes STORAGE_GB / BANDWIDTH_GB / DATABASE_STORAGE_GB rows.
- Voice minutes (VOICE_MINUTE, SPEECH_TO_TEXT_MINUTE) are registered but the browser Web Speech path is free; a cloud voice adapter would report `seconds`.
- Reservation expiry (`rescript_billing_expire_reservations`) has no scheduler; run it from a cron or on the admin wallets read when one exists.
- Credits `expiresAt` is recorded on the ledger but not yet enforced.
- Real payments: a `payment` ledger kind + a webhook writing `rescript_billing_credit` is the whole integration.
