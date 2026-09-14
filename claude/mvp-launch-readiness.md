# Rescript Studio — MVP Launch Readiness Report

**Audited:** 14 September 2026, against `389396f` (container and `origin/main` in step)
**Method:** full read of `apps/studio`, `apps/runtime`, all 13 packages and 29 migrations;
live queries against Supabase `gouxrdjpiejuliucqwoy`; 1,542 package unit tests and the
`auth-guard-audit`, `p0-cookie` and `dashboard` suites executed.
**Not done:** a manual QA pass by a human researcher, and the ~30 Playwright suites that
need both servers running. Some findings below are marked *unverified by execution*.

---

## The one-paragraph version

The **engine is in much better shape than the product around it**. There is genuinely one
condition engine — display, skip, branch, count, mask, carry-forward, list fill, auto-punch,
quotas and quality rules all route through `evaluateCondition`, with no second evaluator in
either app, the renderer or analytics. Session handling, edit locks, autosave and route
authorisation are better than most shipped products. Against that, **13 launch blockers** sit
in the layers a customer actually touches: the export file, the variant renderers, structural
edits to a live survey, one unguarded page, and a commercial billing model that does not exist
yet. Two of the blockers are one-line fixes with very large blast radius.

The most important fact in this report is not a bug. It is this:

```
surveys 13 · users 9 · TEST responses 48 · LIVE responses 0 · LIVE completes 0
usage_events 56 · LIVE responses ever billed 0 · total ever charged $0.30
```

**Not one live interview has ever been collected on this platform, and not one has ever been
billed.** Every claim about the live collection and billing path is a claim about code that
has never met a real respondent. That governs the launch plan more than any individual defect.

---

## 1. RED — launch blockers

Ordered by expected damage. "One-line" means exactly that.

### R1 · Exports include responses the researcher deleted
`apps/studio/app/api/surveys/[id]/responses/route.ts:82-87` — no `deleted_at` filter, in any
of the CSV, JSON, XLSX or summary branches. Every other reader excludes them
(`responseData.ts:167`, `analytics.ts:51`).

Reproducible on live data now: survey `SURVEY_MTIPJMN7` has 12 test responses, 5 soft-deleted.
The Data tab shows 7. `?format=csv&include=test` returns **12**. A researcher who bins 40
fraudulent completes and then exports ships all 40 to their client.
**Fix: add `.is("deleted_at", null)` to both queries. One line.**

### R2 · Exports have no row limit and no pagination
Same query. One unbounded `select()` materialised in Node. Every other bulk reader in the
codebase chunks at 1,000 (`responseData.ts:187`, `analytics.ts:26`). The connecting role
carries `statement_timeout = 8s`, and if PostgREST's `db-max-rows` is set the file is
**truncated silently** — correct header, correct filename, missing rows, no error.
**Fix: chunked reads, as `analytics.ts` already does.**

### R3 · Any signed-in user can read any survey
`apps/studio/app/studio/[id]/page.tsx:23-42` is a server component that queries with the
**service-role client** and renders the complete definition — questions, logic, quotas,
scripts, the unsaved draft — with **no guard at all**. `middleware.ts` only checks that a
session cookie is *present*, and says itself that it is not a security boundary.

A user from another agency on the same installation, with no role on the project, opens
`/studio/<uuid>` and gets the questionnaire. This is precisely what `requireProject`'s
deliberate 404-not-403 design exists to prevent. `auth-guard-audit.mjs` passes 137/137 because
it only walks `app/api/**/route.ts`.
**Fix: `requireProject(…, "project.read")` before the first query; extend the audit to
`app/**/page.tsx`.**

### R4 · Option codes are re-sequenced on surveys that already have data
`store.tsx:435-440` probes `/api/surveys/{id}/responses?limit=1` and reads
`d.total ?? d.rows?.length ?? 0`. That endpoint returns `{live:{…}, test:{…}}` — there is no
`total` and no `rows`, so `n` is always 0 and **`hasResponses` has never once been true**.

Therefore `QuestionsPanel.tsx:668`'s `if (s.hasResponses) return;` never fires, and
`resequence()` runs after every option or row delete — on a live survey.
`renumber.ts:5-19` states in its own header that the caller must refuse this once responses
exist. The caller does not. Delete option 3 of 5 mid-field and every respondent who chose old
code 4 is now recorded as 3. The "Codes are frozen once responses exist" tooltip
(`ElementPanel.tsx:115`) has never been true either.
**Fix: parse the real shape (`live.total + test.total`), and disable the code inputs in
`QuestionsPanel.tsx:266` and `:555`.**

### R5 · "Other, specify" is an unanswerable dead end on 14 shipped variants
`validate.ts:365` blocks the page whenever a selected flagged option has no text, and
`otherSpecifyOptional` is off by default. But `OtherSpecifyBox` is rendered in only four
layouts. On the multi-select dropdown, searchable dropdown, image select, carousel, compare
images, icons, list rows, rich cards, multi-item carousel, statements, flip cards and
comparison carousel — **and on matrix columns** — the respondent is told to specify with no
field on screen. The survey cannot be completed.

23 variants declare the `other_specify` capability; 14 route to a renderer that draws no box.
No test sets a `variant` on an other-specify fixture, which is why the recent per-box fix
(`32bc051`) looked complete.
**Fix: the `OtherSpecifyBox` + `useChoice().vals` pattern already at `QuestionRenderer.tsx:1239`,
applied to each; plus a schema test asserting every declared capability is honoured by the
renderer it points at.**

### R6 · Version restore silently destroys unsaved work
`versions/[versionId]/route.ts:55` calls `rescript_finalize_version` with
`p_base_revision: -1`, which nulls `draft_definition`. Clearing the draft is *correct* —
otherwise restore does nothing visible. But the button is labelled "load / restore", there is
**no confirmation, no dirty-draft check and no draft history**. A programmer who has worked two
hours without cutting a version, and clicks it expecting to preview v1.3, loses the two hours
with no recovery path. No test covers restore.
**Fix: cut an automatic `auto-before-restore` version from the draft first.**

### R7 · Every export reads the current draft, not the version the response was collected under
`responses/route.ts:76-78` flattens **all** rows against `current_version_id`;
`qualityDef.ts:29` defaults to `"draft"`, so the Data tab, single-response view, import,
quality recompute, quota recount and analytics all interpret collected data through an
**unsaved draft** that may never have been fielded. Worse, `route.ts:104` stamps the *current*
version number onto every exported row, so a March export and a June re-export of the same
interviews differ while both claim the same version.

`responses.version_id` is `not null` with an FK and has been since migration 0001. **No read
path in the repository reads it.** The protection was paid for and is not collected.

### R8 · Re-coding, re-typing and renaming silently change the meaning of collected data
`flattenVariables` interprets stored answers using the *current* type, codes and variable
names. Concretely:
- delete a matrix row → its collected answers appear in **no export**, silently (R7 makes this
  unrecoverable rather than merely wrong);
- change option `3` to `03` → every stored `3` lands in a column that no longer exists;
- keep the code and change the label "Coke" → "Pepsi" → the export relabels history;
- `VariantPicker.tsx:306` gates the type-change warning on `changes.length === 0` rather than
  on `migration.safe`, so single ⇄ multi flips the response model **with no dialog**, and a
  stored `["1","3"]` exports as the literal string `1|3` in a column the codebook calls a
  single coded value.

### R9 · `renumber.ts` misses masks, punches, option groups and calculations
Its header claims "one atomic operation over the whole definition";
`grep -c "mask\|punch\|optionGroups\|attentionCheck" packages/engine/src/renumber.ts` returns
**0**. After a resequence, a mask reading `codes: [4,5]` shows two different options at
runtime. Deletion is handled properly by `references.ts` — re-coding is not.

### R10 · Nothing enforces the lint before a version is cut or deployed
`runQualityCheck` has exactly one call site in the whole app: `LogicPanel.tsx:94`. Neither
`versions/route.ts` POST nor `deploy/route.ts` POST consults it. A survey with dangling piping,
duplicate variable names and a mask that evaluates to the empty set (which renders **no
options**, `setExpression.ts:79`) deploys without a murmur. The lint is good; it is advisory.

### R11 · Survey deletion orphans all localisation audio
Database deletion is genuinely complete — 37 of 38 foreign keys cascade, verified live, and
the one `SET NULL` is the billing ledger, which is correct. Storage is not.
`audio/route.ts:51-59` uploads to `rescript-audio` and returns a **five-year signed URL**
without ever inserting a `media_objects` row, so `purgeSurveyMedia` — which queries that table
— cannot see it. Live: `rescript-audio` holds **17 objects, 0 tracked**, all under live survey
ids. Delete those surveys and the recordings stay, reachable by URL, for five years.
**Fix: prefix-sweep `${surveyId}/` in the DELETE route — the key already carries the id.**
Related: single-response purge (`data/[responseId]/route.ts:179`) omits the
`purgeSessionMedia` call the bulk route has, so erasing one respondent leaves their audio
behind. That is the GDPR case the bulk route's own comment says must not happen.

### R12 · Studio metering bills test work as LIVE — and already has
`apps/studio/lib/metering.ts:67,73` default `environment` to `"LIVE"`, and **no Studio caller
anywhere passes the argument**. The Studio has no session row to read `is_test` from, so it
could not.

This is not theoretical. Live `usage_events` contains two `SPEECH_TO_TEXT_MINUTE` rows marked
LIVE, both with `session_id = null` — a researcher testing the recorder in the Studio, charged
as production. 21 LIVE `FILE_UPLOAD` rows include test takes. `respondents/send/route.ts`
parses the environment at `:57`, filters respondents by it at `:104`, and then discards it at
`:171`. `EXPORT_GENERATION` rows carry `metadata.include = "test"` beside `environment: LIVE`
in the same row.

The runtime side is correct everywhere — the completed response itself is safe. The fail-safe
direction is simply inverted: the default should be TEST, or the parameter required.
**This must be fixed before any invoice is generated.**

### R13 · The commercial model in the brief does not exist
What exists is a **prepaid USD wallet** with cost-plus-margin pricing, a strong immutable
ledger, atomic reservations, and an admin console. What the brief asks for is a **monthly
platform fee plus a per-completed-response price in rupees**. Specifically missing:

- no plans table, no per-plan config (`billing_config` is a single global row, `id = 1`)
- no recurring charge of any kind; nothing in the schema or code mentions a platform fee
- no billing period, no invoices, no payment status
- no payment integration at all — "Add funds" files a credit request an admin approves
- currency is one global string defaulting to `USD`; every rate is in dollars
- soft limits are **absolute currency thresholds** ($20 / $5), not the 80% / 100% warnings
  the brief requires
- `STORAGE_GB`, `AUDIO_PROCESSING_MINUTE`, `VIDEO_PROCESSING_MINUTE`,
  `SURVEY_RESPONSE_STARTED` and survey created/published are **registered but never emitted**
- `usage_events` has no respondent id (only an 8-character session prefix), no unit price
  column, and no billing period — three of the brief's §15 fields
- `rescript_billing_expire_reservations` exists with **no scheduler**, so abandoned holds pin
  balance indefinitely

---

## 2. YELLOW — functional, ships, fix soon

| | Area | Issue |
|---|---|---|
| Y1 | CSV injection | `csv.ts:19-24` quotes `",\n\r` but does not prefix a leading `= + - @`. An open end typed `=cmd\|…` or a phone number `-447700900000` becomes a formula at the client. |
| Y2 | Missing export columns | No `END_TIME` in the CSV, so LOI cannot be computed from the delivered file; no `RESP_ID` in the XLSX, so it cannot be joined to the CSV or to a supplier's reconciliation file. |
| Y3 | Dictionary ≠ flatten | `image_select` is declared as one numeric scalar and flattened as an array plus per-option flags. Other/specify columns are emitted for grids, ranking and allocation by `flatten.ts` but **not declared** by `variables.ts`, so those verbatims are silently absent from both files. |
| Y4 | Column collisions | Duplicating a question twice mints two `Q5_COPY`s with no uniqueness check; the header dedups and one question's data overwrites the other's. `VAR_other` collides with an option literally coded `other`. `lintVariables` catches the first, nothing blocks on it. |
| Y5 | Two tabs, one session | Both tabs hold the lock (it is keyed on session). The second autosave 409s and `blocked.current = true` stops autosave **permanently**. No test. A `BroadcastChannel` guard removes the whole class. |
| Y6 | No durable client buffer | There is no localStorage/IndexedDB mirror of the draft anywhere in the Studio. On second-device login, lock loss or an unretried save failure, on-screen work exists only in React memory. A save that errors schedules **no** retry (`store.tsx:341`). |
| Y7 | Unload asymmetry | `useCollab.tsx:188` releases the lock with `keepalive: true`; `store.tsx` flushes the draft with a plain `fetch` the browser cancels. On tab close the platform reliably gives the lock away and unreliably saves the work. |
| Y8 | `_status` code frame wrong | `dataset.ts:126` declares `screened_out`; the database enum is `screened`. Every status banner shows a "Screened out" row at n = 0 beside an unlabelled row called `screened`. |
| Y9 | Bases ignore masking | `frequencies` divides by the whole answering base; there is no exposure counter outside MaxDiff. Every masked option is understated with no warning on the table. |
| Y10 | Dashboard mixes environments | `survey_dashboard_stats` and `rescript_my_projects` sum test into `response_count`/`complete_count`; the workspace "Completes" tile (`page.tsx:422`) counts test completes as real. |
| Y11 | Double-submit race | `Runner.tsx:845` awaits three round trips with no in-flight guard and no `disabled` on Next. Two concurrent finalises both pass the `status = in_progress` check, so one interview can increment a quota cell by 2 and bill two `SURVEY_RESPONSE` events. |
| Y12 | Reporting surfaces disagree with the engine | `logicSummary.ts:88` prints a multi-child NOT as NAND; the engine evaluates NOR. `logicTrace.ts:296` hand-rolls the punch chain over raw `q.punches`, skipping both sorts, so the trace can show a different winning branch than the engine applies. `autoPunch.ts:269` is a divergent copy with zero call sites. |
| Y13 | Four definitions of "selected" | `countCondition.ts:75`, `carryforward.ts:110`, `piping.ts:131` and `loops.ts:304` disagree on whether an allocation of `0` counts. Three answers for one question. Likewise three definitions of "empty". |
| Y14 | Invitations unproven | The code path is correct, but `project_invitations` has **0 rows** in production and `mail_deliveries` has 0 invitation sends. Password reset *has* delivered (1 real send, 2026-09-07) — the "SMTP not configured" note in `platform-status.md` is stale. |
| Y15 | Unbounded search | Text search streams the whole matching set through Node in 1,000-row chunks with no cap; `responseCounts` hard-caps at 200,000 and silently under-reports past it. Fine at MVP volume. |
| Y16 | `/t/` shows the draft, not the published version | Correct default for an author and clearly labelled, but a tester is not by default looking at what live respondents see. Needs saying in the launch docs. |

---

## 3. GREEN — launch ready

These were examined and found sound. They are the reason this is a five-week plan and not a
rewrite.

- **One condition engine, genuinely.** `evaluateCondition` / `evaluateRule` /
  `resolveSourceValue`, ~55 call sites across 21 modules. Display, skip, branch, nested
  AND/OR/NOT, numeric and text comparison, counts, variable/question/option references,
  selected/unselected, carry-forward, list operations, List Fill, auto-punch, auto-select,
  masking in all three dimensions, quotas and quality rules all route through it. **No second
  evaluator exists in either app, in the renderer or in analytics.** Count is modelled as a
  *source* rather than an operator, which is the cleanest design decision in the codebase.
- **Question types.** Single, multi, open-end, numeric, all four grid cell families, composite
  cells, required/optional, 22 validation kinds, randomisation with anchors and rotation,
  question and block randomisation, block management, page breaks, question moves with a
  forward-reference warning. ~190 variants, **zero stubs** — every declared renderer key
  resolves.
- **Deletion of a question, block or flow node.** `references.ts` is a whole-document walk
  keyed on field names, previewing the prune with the same code that performs it. Masks and
  punches clean up correctly because `SetExpr` spells its reference `questionId`. The strongest
  single piece of engineering in the repository.
- **Survey deletion, database side.** A real `DELETE`, not an archive flag; 37 of 38 FKs
  cascade; cannot reappear in any listing; the confirm modal requires typing the code and only
  200/404 clears it.
- **Test/live separation, structurally.** `quota_counts`, `listfill_counts` and
  `response_counters` all carry `is_test` in the **primary key**; `respondents` has an
  environment-scoped unique index; per-environment SQL functions take `p_is_test` with no
  default; `usage_events.environment` has a check constraint; `responses.environment` is a
  generated column. `/api/session/save` re-reads `is_test` from the stored row and never trusts
  the client — the best pattern in the codebase.
- **Response collection.** 128-bit session ids minted server-side by the runner (not during
  SSR — the bug that produced 51 orphan rows is fixed); resume from both `localStorage` and
  `sessionStorage` with server re-validation; whole-state saves so a lost intermediate costs
  nothing; `persistFinal` retries 3× with backoff and the thank-you page only claims success
  after the server confirms; `respondent_code` assigned by trigger as `TEST_000001` /
  `RESP_000001`.
- **Auth and authorisation.** Opaque server-side sessions, Supabase tokens discarded, httpOnly
  cookie, 7 roles × 31 capabilities in one grant table with `can()` and never a role comparison,
  three separate gates, 404-for-outsiders, **137/137 API handlers guarded, guard-first,
  verified by a static audit**. No browser-side Supabase client exists; the service key never
  leaves `server-only` files. Zero tables in `public` without RLS.
- **Edit locks.** `survey_id` as primary key, atomic claim inside the row lock, liveness tied to
  a live session so a signed-out holder's lock is immediately takeable, force-release audited
  and notified. Two held locks in production, both healthy.
- **Saving and conflicts.** Revision-guarded conditional UPDATE; a stale write is refused with
  the server's state attached; the client distinguishes "someone else's work is newer" from a
  lock refusal; `droppedFieldPaths` reports what a newer client sent that the server did not
  keep; a lost race after a version snapshot deletes the orphan rather than leaving a phantom.
- **Response data management.** View, filter, edit (validated with the same `validateQuestion`
  the runtime uses, with optimistic concurrency and a `response_edits` trail), soft delete with
  a working hard purge gated to already-deleted rows, bulk operations with a `confirmCount`
  that must still match at execution.
- **Billing engine internals.** Reserve/settle/release under `select … for update`, wallet floor
  and project cap in one transaction, immutable `usage_events` and `wallet_ledger` with
  reversal-not-edit, no route knows a price, every threshold schema-driven rather than
  hard-coded. The *engine* is not the problem; the commercial model on top of it is missing.
- **Matrix and multi-select export layout**, RFC-4180 quoting, HTML stripped from labels, loop
  columns, crosstab column bases with explicit `Base (n)` rows and sub-30 warnings, filtering
  that reuses the shared evaluator, completion-rate and incidence SQL.

---

## 4. Metered billing status

**Engine: GREEN. Commercial model: RED.**

| Brief requirement | Status |
|---|---|
| Platform fee ₹2,999/month | **Missing** — nothing recurring exists |
| ₹1.50 per completed response | **Partial** — the event is right (completes only, screen-outs excluded); the price is `customerRate: 0.02` **USD** in `registry.ts:126` |
| Named config keys (`platform_monthly_fee`, `response_unit_price`, …) | **Missing** as named keys; two of seven exist as registry rows |
| Per-plan configuration | **Missing** — `billing_config` is one global row |
| Track surveys created / published | **Missing** — no event type, no call site |
| Track responses started | **Missing** — registered, never emitted |
| Track responses completed | **Exists** |
| Test vs live | **Partial** — correct in the runtime, **wrong in the Studio** (R12) |
| Audio / video minutes | **Missing** — duration is captured, never metered |
| AI transcription / analysis | **Exists** |
| Storage | **Missing** — billed once at upload, no recurring accrual |
| Exports | **Partial** — recorded but `billable: false` |
| Usage at project and account level | **Exists** |
| Dashboard: plan / estimated bill / invoices / payment status / overage | **Missing** |
| Dashboard: usage breakdown / limits | **Exists** |
| Soft + hard limits | **Partial** — hard limits are strong and transactional; "soft" is a currency threshold |
| 80% / 100% warnings | **Missing** — `usedPct` is computed and drives nothing |
| Nothing hard-coded | **Exists** |
| Billing separate from survey logic | **Exists** (strong) |
| Auditable event per action | **Partial** — no respondent id, no unit price, no billing period |
| Never recompute history | **Exists** — immutable triggers. Caveat: only `rateId` is stored and rate rows are editable in place |
| Payment integration | **None.** Ledger-only. |

**Shortest path**, in dependency order:

1. **Fix R12 first** — make `environment` a required parameter and let the compiler find the
   ten call sites. Half a day, and it blocks everything else, because every number computed
   before it is wrong.
2. Add the seven named unit-price keys to `BillingConfig`; have `priceSpec` prefer a
   configured unit price over the registry lookup, so the brief's flat model and the existing
   cost-plus model coexist rather than compete. Switch `currency` to INR and reprice.
3. Add `plans` + `customers.plan_id`; merge plan config over the global row. This is the
   largest structural change and the platform fee, limits and "current plan" all depend on it.
4. Add `billing_periods` and stamp `usage_events.billing_period_id` at insert; build
   `invoices` by aggregating **once, at period close**, never recomputed — the immutability
   triggers already guarantee the inputs cannot move. Pair with the missing cron for
   `rescript_billing_expire_reservations`.
5. Close the metering gaps: emit started, audio/video minutes from `duration_seconds`, a
   nightly storage accrual, survey created/published. Add `respondent_id` and `response_id`
   columns and stop truncating the session id.
6. Percentage warnings (branch on the `usedPct` that already exists), the dashboard sections,
   then Razorpay: a `payment` ledger kind plus a webhook calling `rescript_billing_credit`.
   Nothing else changes.

---

## 5. Security risks

| | Risk | Severity |
|---|---|---|
| S1 | `/studio/[id]` renders any survey to any cookie holder (R3) | **High** — confidentiality of the core asset |
| S2 | `/api/session/start` takes `mode` from an unauthenticated request body; nothing ties `responses.is_test` to `deployments.mode` | Medium — a script could file interviews as TEST to dodge metering |
| S3 | Leaked-password protection still off in Supabase Auth | Low, one toggle |
| S4 | Signup keeps the address-matching invitation claim path beside the token path, and signup does not verify addresses | Low, documented, acceptable for MVP |
| S5 | Write policies granted to `public` rather than `authenticated` | Inert today (`auth.uid()` is null for anon); defence in depth |
| S6 | CSV formula injection (Y1) | Medium — it is the *client* who opens the file |

Genuinely clean: no unauthenticated mutating route; no route derives the acting identity from
anything but the cookie; the service key never reaches the browser; migration 0026 closed what
had been a complete authentication bypass; zero tables without RLS.

---

## 6. Data integrity risks

Ranked, all covered above: R4 (re-sequencing live surveys) → R7 (reading collected data
through the wrong definition) → R8 (re-coding and type changes) → R1 (deleted rows exported) →
R9 (renumber blind spots) → R10 (no gate before publish) → R6 (restore destroys the draft) →
R11 (media orphaned) → Y11 (double-submit double-counts) → Y6/Y7 (no durable client buffer).

The pattern is consistent and worth naming: **deletion is protected by a genuinely good
reference engine; everything else that changes an identifier is not.** Option codes, row codes,
question types and variable names can all be changed freely, with no rewrite, no lint gate and
no version isolation — and the single guard that was meant to stop the worst of it has never
been `true`.

---

## 7. Recommended launch plan

The determining fact is that zero live interviews have ever been collected. Nothing in the
live path is proven by usage, so the plan buys that proof rather than assuming it.

| Window | Work |
|---|---|
| **15 – 26 Sep** | R1, R2, R3, R4, R11, R12, Y1, Y8 — the small-fix wave. Most are one-liners; each needs a regression test, because every one of them passed review by looking correct. |
| **29 Sep – 10 Oct** | R5 (other-specify renderers + a capability-honoured test), R6, R7 (version-scoped reads), R8, R9, R10 (gate the lint at version-cut and deploy). The structural data-integrity block. |
| **13 – 24 Oct** | Billing steps 1–4: environment, named keys, INR, plans, periods, invoices. Razorpay behind a flag. |
| **20 Oct** | **Paid pilot** — 2 or 3 design partners, real fieldwork, **manual invoicing**, metering running in shadow and reconciled by hand against what you would have charged. |
| **27 Oct – 7 Nov** | The brief's §20 regression suite as an automated run; Y-list fixes; fix whatever the pilot finds. |
| **17 Nov 2026** | **Commercial launch.** |

**Recommended launch date: Monday 17 November 2026**, with a paid pilot from **20 October**.

The four weeks between pilot and launch exist for one reason: the first invoice a customer
receives must not be the first invoice the code has ever produced. Reconcile a month of real
metering by hand before anyone's card is charged.

Hold the date if any of these are still open on 10 November: R1, R3, R4, R7, R12, or a
pilot partner reporting a wrong number in a delivered file.

---

## 8. Recommended first commercial pricing

The brief's shape is right. Two adjustments, one of which matters commercially.

**Rescript Professional — ₹2,999 / month**, including **500 completed live responses**,
then **₹1.50 per completed live response**.

Test responses free. Screen-outs, quota-fulls and partials free — the code already meters only
completes, which is the correct and customer-friendly choice and worth saying in the pricing
page.

**The adjustment that matters: ₹1.50 cannot cover a qualitative interview.** Speech-to-text
alone costs about $0.006/minute at provider price. A five-minute recorded interview is roughly
₹2.60 in transcription before storage, delivery or any AI analysis — it loses money at ₹1.50
per response, and loses more the better the product gets. Price media responses separately:

| Unit | Price | Note |
|---|---|---|
| Completed response (text/standard) | ₹1.50 | after the included 500 |
| Completed response with audio or video | ₹12 | covers transcription, storage and the 48-hour delivery |
| AI open-end analysis | ₹0.50 / response | when the P1 coding feature ships |
| Additional storage beyond 5 GB | ₹8 / GB / month | once the accrual job exists |

Set a **floor rule in config**: no response bills below its own provider cost. The margin model
in `pricing.ts` already computes this; it simply is not applied to the fixed response rate.

Pin the USD→INR rate in `billing_config` and review it quarterly rather than leaving rates in
dollars and converting at display time — an invoice must not move because the rupee did.

Keep Basic / Professional / Advanced / Enterprise as **empty rows in the `plans` table** from
day one. Adding a plan later should be an INSERT, not a migration.

---

## 9. P1 — after launch, in the order real usage will demand it

1. AI open-end coding — the highest-value differentiator for an agency, and the metering for
   it already exists
2. Sentiment analysis
3. Advanced analytics and dashboards
4. PowerPoint reporting — agencies deliver in PowerPoint, and this is closer than it looks
   (`packages/analytics/src/export` already writes tables with bases and significance letters)
5. Audio and video surveys as a *sold* capability — the pipeline and 48-hour delivery are
   built; what is missing is the pricing above and a per-plan switch
6. Real-time transcription
7. AI follow-up questions; conversational surveys
8. Advanced conjoint; MaxDiff improvements
9. Predictive modelling
10. Advanced quality detection; respondent profiling

P2 (SSO, SCIM, webhooks, white-labelling, data residency, SLA) stays untouched until a
customer asks in a contract.

---

## 10. Regression suite the brief asks for (§20)

None of this exists as one run today. `pnpm verify` covers typecheck, 1,542 unit tests and the
guard audit; the browser suites are a separate, partly manual `verify:browser`. Build the
brief's 20 steps as a single scripted journey — create, 20+ questions, complex logic, save,
reload, edit, publish, collect, submit, verify in the database, export, edit a response, delete
a response, delete the survey permanently, re-login, verify state, verify usage, **verify test
responses are not billed, verify live responses are billed, verify three other-specify fields
stay independent**.

The last three are the ones that would have caught R12 and R5. Nothing currently asserts any
of them end to end.
