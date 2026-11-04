# The respondent recruitment exchange — architecture and phased plan

*2026-11-03. Design for the Fieldwork module's transformation into a multi-vendor recruitment
exchange with cross-vendor deduplication, pre-entry fraud screening and sample allocation
optimisation. Written against the repository at `8f796595`, migrations through **0080**,
patches through **0057**.*

> **Status.** This document is the design and the Phase 1 build. Phases 2–6 are specified
> here but **not built**. Nothing in this document describes a vendor API that has been
> called: Miures holds no sample-provider credentials today, so Phase 1 ships the vendor
> registry, the adapter framework and **manual** feasibility, pricing and order entry.
> Every vendor in the marketplace reports its real integration state, and the only state
> any vendor can be in after Phase 1 is *manual* or *awaiting integration*.

---

## 1. What already exists

The brief's Phase 1 opens with "audit existing Fieldwork and survey runtime". That audit is the
single most load-bearing thing in this document, because roughly half of what the brief
describes as new is already in the repository — and the half that is missing is not the half
the brief emphasises.

### 1.1 The panel framework (migration 0072, 2026-10-22)

`definition.panels` already carries a versioned, cloneable `PanelConfig` per study, with presets
for **Prolific, Cint/Lucid, PureSpectrum, Dynata, Toluna, CloudResearch Connect, MTurk-style
codes and a custom panel**. Per panel it holds the id parameter (`PROLIFIC_PID`, `RID`, `psid`,
`gid`, `transaction_id`), further captured parameters, `requireId`, `dedupe`, redirect templates
and completion codes for each of the five outcomes (`complete`, `screenout`, `quota_full`,
`terminate`, `over_quota`), a full signing specification (HMAC-SHA256/SHA1 and the
append-the-secret digest schemes, with scope, encoding and case), the link kinds it applies to,
and `completesTarget`.

Behind it:

| Thing | Where |
|---|---|
| Pure entry/exit logic | `packages/engine/src/panels.ts` (420 lines) |
| Orchestration | `packages/analytics/src/panels/service.ts` |
| Runtime binding | `apps/runtime/lib/panels.ts`, `apps/runtime/app/api/panel/exit/route.ts` |
| Arrivals, atomic dedupe | `panel_entries` + `rescript_panel_enter(...)`, unique partial index on `(survey_id, panel_key, pid, is_test) where dedupe and pid <> ''` |
| Signing secrets | `panel_secrets`, sealed with `INTEGRATIONS_SECRET_KEY` through the BYOK envelope scheme; RLS on, **no policy**, no grant |

**This means the brief's §14 (atomic, idempotent participation reservation) already exists —
but only within one vendor.** `rescript_panel_enter` guarantees that the same `pid` from the
same panel cannot enter the same study twice, even from two tabs racing. It says nothing about
the same human arriving as `RID=abc` from Cint and `psid=xyz` from Dynata. That is the gap.

### 1.2 The quality engine (`packages/quality`, ~6,500 lines)

The brief's Part E reads as though fraud detection must be built from nothing. It must not.
The catalogue already carries **58 rules** across the categories the brief names:

- **Bots** — `bot.impossible_sequence`, `bot.machine_timing`, `bot.no_interaction`
- **Device** — `device.duplicate`, `device.webdriver` (automation detection), `device.locale_timezone`
- **Network** — `network.duplicate_ip`, `network.ip_density`, `network.risk_provider`
- **Coordinated fraud** — `cluster.burst`, `cluster.coordinated`, with a similarity/linkage
  implementation in `similarity.ts`
- **Duplicates** — `duplicate.answers`, `duplicate.multi_signal`, `matrix.signature_match`,
  `openend.duplicate`, `navigation.fingerprint_match`
- **History** — `history.poor_record`, `screener.repeat_attempts`
- plus 30-odd timing, matrix, pattern, attention, interaction and consistency rules

with weighted scoring (`score.ts`), configurable strictness profiles (`profiles.ts`), benchmarks,
and an arrival-order convention (`arrival.ts`) that already solves the problem the brief's §20
appeal mechanism gestures at: of a duplicate pair, exactly one is excluded, and the earlier one
is kept and marked informational rather than both being dropped.

The identity primitives exist too: `hashIdentifier(salt, value)`, `deviceHashFrom(salt, {...})`
and `clientIp(headers)` in `packages/quality/src/server.ts`, writing `responses.ip_hash` and
`responses.device_hash`, salted per survey by `QUALITY_HASH_SALT`.

**The gap is not the rules. It is when and over what they run.** Today the engine scores a
*finished response* against *peers in the same survey*. The brief needs a subset of those
signals evaluated **before entry**, **across projects**, and **across vendors** — which is a
different query, a different latency budget, and a different salt scope (a per-survey salt makes
cross-survey matching impossible by construction; that is a deliberate privacy property that
Part D must consciously and narrowly relax).

### 1.3 The admission seam

`apps/runtime/app/api/session/start/route.ts` is where a respondent becomes a row. Its order today:

```
survey status gate → password gate → resolve sample source → resume? → metering gate
  → panels.enter()  ← refused / duplicate / over_quota
  → createSession() ← ip_hash, device_hash, sample_source
  → panels.attach(entry, session)
```

The brief's Respondent Admission Gateway (Part F) is an **extension of the `panels.enter()`
step**, not a new front door. This matters: the route already enforces status, password,
metering and panel dedupe server-side, so the brief's §22 "a respondent must not be able to
bypass admission by opening the survey URL directly" is already half-true. What is missing is
the short-lived access token (§16.11, §23) — today the route mints the response row directly
rather than issuing a token that a second server-side call redeems.

### 1.4 Everything else worth naming

| Capability | Where | Relevance |
|---|---|---|
| Sample source attribution, first-wins | migration 0012, `packages/engine/src/sampleSource.ts` | Part I vendor-wise reporting already has its dimension |
| Fieldwork curve, pace, stall warning | `packages/analytics/src/fieldwork.ts`, `FieldworkPanel.tsx`, `FieldOverTime.tsx` | Part I §27 is an extension, not a new page |
| Quotas | `packages/engine/src/{quotas,quotaActions,quotaDashboard}.ts`, `quota_counts` | Part M §15 exists |
| Event outbox with idempotency, leases, retries, digests | `notify_events`, `notify_deliveries`, `rescript_notify_claim` | **Part K §32's event bus — reuse it, do not build a second one** |
| Envelope encryption, key rotation | `packages/ai/src/envelope.ts` | Part L §33's key management |
| Wallet, metering, usage limits | `packages/billing`, `lib/metering.ts` | Part J attaches to this, but see §6 below |
| Role model incl. a `vendor` role (`project.read` + `fieldwork.read` only) | `packages/access`, migration 0034 | Part L §33's RBAC, already with a vendor-shaped role |

### 1.5 What is genuinely new

1. **Any vendor API call whatsoever.** 0072 is redirect-only and says so: "No panel API is
   called (feasibility, quota sync with the panel's own system and payments stay in the panel's
   dashboard)." Feasibility, quotation, sample orders, capacity and reconciliation are all new.
2. **A vendor as an organisation-level entity.** Panels live on a *survey definition*. There is
   no `panel_vendors` table, no coverage, no CPI by market, no quality history, no commercial terms.
3. **Cross-vendor and cross-project identity.** `respondents` is keyed per survey
   (`survey_id` FK), and the quality salt is per survey. There is no platform-level respondent.
4. **Pre-entry risk scoring.** The quality engine is post-hoc on the dataset.
5. **A survey access token** redeemed server-side.
6. **The orchestrator, the allocation optimiser and dynamic reallocation.**
7. **Vendor quality scored from verified outcomes**, with confidence intervals.
8. **A sample financial engine.** `packages/billing` meters *Rescript's own* usage against a
   wallet; vendor spend, CPI, margin, settlement and reconciliation are a different ledger.

---

## 2. The identity problem, stated honestly

The brief's §13 lists the deduplication signals as "Same email · Same verified phone · Same
authorized Trust ID · Same vendor participant ID". Three of those four are, for the vendors the
brief names, **not obtainable**.

Dynata, Cint/Lucid, Toluna and PureSpectrum do not transmit respondent email or telephone
numbers to a survey platform. Their integration is a redirect carrying an opaque participant
identifier — `psid`, `RID`, `gid`, `transaction_id` — and their contracts and privacy notices
specifically prohibit the buyer from attempting to re-identify the respondent. Asking for an
email address inside the survey in order to deduplicate is both a contract violation with most
panels and, under GDPR and the DPDP Act, processing without a lawful basis for that purpose.

So the design must be built on what is actually available, and must be explicit about the
confidence each path gives:

| Path | Available when | Confidence | Mechanism |
|---|---|---|---|
| **Vendor participant id** | always, per vendor | **deterministic, within one vendor** | already built (`rescript_panel_enter`) |
| **Device + network + behavioural cluster** | always | **probabilistic** | extend `packages/quality`'s device/network/cluster rules to a cross-project scope |
| **Platform-held identity** (email/phone) | own panel, invitation lists, client-supplied sample, direct recruitment | **deterministic, cross-vendor** | new: HMAC tokens, the RTID registry |
| **Vendor-shared cross-vendor token** | only where a vendor contractually offers one | deterministic | adapter capability flag; **no listed vendor offers this today** |

This produces the single most important architectural rule in this document, and it is the
brief's own §13 instruction taken seriously:

> **A Trust ID has a resolution state, and the system never represents a probabilistic match as
> a deterministic one.** `resolved_deterministic` · `resolved_probabilistic` ·
> `unresolved_vendor_scoped`. A duplicate decision made on a probabilistic match is reviewable,
> appealable and reported as such, and the researcher's final report states what fraction of the
> sample was deduplicated at each confidence level rather than claiming "zero duplicates".

The brief's acceptance criterion 10 — "Prevent duplicate participation across vendors" — is
therefore delivered as: deterministic prevention within each vendor and wherever platform-held
identity exists; probabilistic detection, scoring and quarantine across vendors otherwise; and
an honest number in the final report. Anything stronger would be a claim the integration cannot
support.

### 2.1 Salt scoping

`QUALITY_HASH_SALT` is applied **per survey** (`qualitySalt(surveyId)`), which makes a device
hash from survey A incomparable to one from survey B. That is a real privacy property and it
is why cross-project matching does not accidentally exist today.

RTID needs a second, narrower key — `RTID_MATCH_KEY` — under which a *separate* set of matching
tokens is derived, scoped to **one organisation** (never across customers) and retained under
its own policy. The per-survey hashes stay exactly as they are. The two never mix: a device
hash in `responses` is not a matching token, and a matching token is never written to
`responses`. This keeps the existing containment tests meaningful and means an organisation
that does not opt into cross-project deduplication has nothing derived at all.

---

## 3. Service boundaries

The brief asks for twelve services. In this repository that is the wrong unit: the platform is a
pnpm monorepo of three apps (`studio`, `runtime`, `interviews`) over seventeen packages, and the
convention that has held for 542 commits is **pure logic in a package, orchestration in a
service module, I/O in a route**. The recruitment exchange follows it rather than introducing
microservices.

| Brief's service | Lands as |
|---|---|
| Recruitment Orchestrator | `packages/recruitment/src/orchestrator.ts` (pure state machine) + `apps/studio/lib/recruitment/service.ts` |
| Vendor Integration Service | `packages/recruitment/src/adapters/*` behind one interface + `vendor_integrations` |
| Feasibility and Pricing Engine | `packages/recruitment/src/{feasibility,pricing}.ts` — pure |
| Sample Allocation Optimizer | `packages/recruitment/src/allocate.ts` — pure, deterministic |
| Respondent Trust ID | `packages/identity/src/rtid.ts` + `rtid_*` tables |
| Identity Resolution / Dedup | `packages/identity/src/resolve.ts` + `rescript_rtid_reserve(...)` |
| Fraud Intelligence | **extends `packages/quality`** — a new `admission` profile, not a new engine |
| Admission Gateway | `apps/runtime/app/api/admission/*` + the existing `session/start` seam |
| Vendor Quality Engine | `packages/recruitment/src/quality.ts` over `vendor_quality_metrics` |
| Recruitment Tracking | the existing event outbox (`notify_events`) with new event types |
| Billing and Reconciliation | `packages/recruitment/src/ledger.ts` + `vendor_settlements` — **separate from `packages/billing`** |
| Analytics and Reporting | extends `packages/analytics/src/fieldwork.ts` |

Two new packages, `recruitment` and `identity`. The dependency-boundaries check
(`scripts/dependency-boundaries.mjs`) must be extended so that `identity` may not import
`recruitment` — identity resolution must never be able to see commercial terms.

### 3.1 The latency split

The brief's §21 asks that slow analysis not delay legitimate respondents. Concretely:

- **Synchronous, < 150 ms**, in the admission path: signed token validation, vendor-scoped
  dedupe (one indexed lookup, already atomic), participation-ledger reservation, deterministic
  RTID lookup if the organisation has one, IP reputation from a cached list, and a rules-only
  risk score from signals present in the request.
- **Asynchronous**, after admission: graph clustering, cross-project probabilistic matching,
  behavioural scoring, vendor quality recomputation. These raise the risk score *during* the
  interview, and a respondent whose score crosses the critical threshold mid-survey is
  terminated at the next page boundary rather than being allowed to complete — which is
  exactly how `packages/quality`'s live assessment already behaves.

---

## 4. Data model

Twenty-three entities, in four groups. Foreign keys to the existing schema are marked →.

**Vendors (organisation-scoped, migration 0081)**

- `panel_vendors` — vendor identity, slug, legal name, logo, regions, status
- `vendor_integrations` — → `panel_vendors`, per organisation: mode (`api` / `manual` /
  `redirect_only` / `awaiting` / `inactive`), credentials **sealed** (envelope scheme, own key),
  health, last contact
- `vendor_capabilities` — what the adapter can actually do: `feasibility`, `quote`, `order`,
  `status`, `reconcile`, `cancel`, `identity_token`. **The marketplace renders from this**, so a
  vendor can never display a capability it has not got
- `vendor_pricing` — CPI grids by market × IR band × LOI band, with `source`
  (`live` / `vendor_reported` / `historical` / `administrator`) — the brief's §8 distinction, in
  a column, so a figure's provenance travels with it
- `vendor_quotations` — a quotation received, with its source and validity window

**Recruitment (0081)**

- `audience_specifications` — the structured spec, versioned
- `recruitment_projects` — → `surveys`: required completes, budget, deadline, strategy, state
- `recruitment_orders` — → vendor: ordered completes, agreed CPI, status
- `sample_allocations` — the optimiser's output and its revisions
- `recruitment_events` — reuses the `notify_events` outbox shape

**Identity (Phase 3)**

- `respondent_trust_ids` — the pseudonymous platform identity, organisation-scoped
- `vendor_participant_mappings` — vendor × participant id → trust id
- `identity_match_tokens` — HMAC tokens under `RTID_MATCH_KEY`, with purpose and expiry
- `participation_ledger` — the authoritative per-project record, with the brief's ten states
- `identity_match_events` — every resolution, with confidence and evidence

**Fraud, admission and money (Phases 4–6)**

- `admission_decisions`, `survey_access_tokens`, `fraud_signals`, `fraud_cases`,
  `fraud_network_clusters`, `vendor_quality_metrics`, `vendor_settlements`,
  `billing_transactions`, `audit_events` (the last already exists in `packages/access`)

PII separation is enforced structurally: `identity_match_tokens` is the only table that can
hold a derivation of an email or phone, it holds no raw value, it has RLS on with **no member
policy** (the `panel_secrets` pattern), and `packages/identity` is the only package permitted
to import it.

---

## 5. Allocation — what the optimiser actually optimises

The brief's §25 contains the one sentence that makes the optimiser worth building:

> Optimize for cost per valid accepted complete, not merely cost per initial respondent or
> quoted CPI.

That is the objective function. For vendor *v* with quoted CPI *c*, expected incidence *ir*,
and — from `vendor_quality_metrics` — expected rejection rate *r* and expected duplicate rate
*d*, the cost per valid accepted complete is

```
cpvac(v) = c / ((1 − r) · (1 − d))
```

and the allocation is a bounded integer programme: minimise Σ cpvac(v)·n(v) subject to
Σ n(v) = N, n(v) ≤ capacity(v), Σ c(v)·n(v) ≤ budget, delivery(v) ≤ deadline, and
quality(v) ≥ threshold. With fewer than ~20 vendors this is small enough to solve exactly by
branch-and-bound rather than approximately; the solver is pure and deterministic so the same
inputs always produce the same allocation, which matters because a researcher authorises it.

The five strategies are weight vectors over (cost, quality, speed), not different algorithms.
A vendor with insufficient history gets a wide confidence interval and the optimiser uses the
**pessimistic bound** — so a new vendor is not penalised in its score (the brief's §24) but is
also not awarded 40% of a project on one lucky week.

---

## 6. Two things the brief asks for that should be built differently

**Billing.** The brief's §30 lists vendor commissions, taxes, currency conversion, margin and
settlement. `packages/billing` is a wallet metering *Rescript's own* usage and must not become a
vendor ledger — they have different invariants (a wallet may be read-only; a vendor settlement
may not simply fail), different audiences and different audit requirements. `vendor_settlements`
and `billing_transactions` are a separate double-entry ledger with idempotency keys, reconciled
against vendor statements, exposed in the same UI. Phase 6.

**"Qualtrics Panels" in the marketplace.** The brief's §5 lists Qualtrics as a provider. Qualtrics
is a direct competitor whose own audit (`claude/competitive-audit-2026-11-01.md`) is in this
project; its panel arm sells through Qualtrics contracts. It belongs in the directory as a
vendor an organisation may configure manually, not as a planned API integration. Likewise
"Lucid" and "Cint" are now one company and must be one vendor with two integration modes, not
two rows — 0072 already treats them as one preset.

---

## 7. Phases

| Phase | Scope | Migration | State |
|---|---|---|---|
| **1 — Foundation** | Vendor registry, adapter framework + capability registry, manual pricing/feasibility/quotation/order, recruitment dashboard | **0081** | **built, see §8** |
| **2 — Recruitment intelligence** | Audience builder (structured + NL), per-market targets, vendor capacity, allocation optimiser, budget controls | **0082** | **built, see §9** |
| **3 — Trust infrastructure** | RTID, `RTID_MATCH_KEY`, vendor participant mapping, participation ledger, atomic reservation, cross-vendor dedup in shadow mode | **0083** | **built, see §10** |
| **4 — Fraud intelligence** | Admission gateway, access tokens, IP/device intelligence, admission scoring in the shared catalogue, quarantine and appeal | **0084** | **built, see §11** |
| 5 — Advanced optimisation | Vendor quality engine, dynamic reallocation, fraud network graph, forecasting, model evaluation | 0085 | specified |
| **6 — Production integrations** | Transport (retry, backoff, circuit breaker), the Prolific adapter, webhook receipt and verification, settlement reconciliation | **0086** | **built, see §13.** Cint and load/security testing remain |

Phase 6 was planned as blocked on vendor contracts. Most of it turned out not to be: the
transport, the webhook door, settlement reconciliation and one real adapter are all buildable
against published documentation, and only *verification against a live account* needs the
contract. What remains genuinely blocked is narrower than the original plan assumed — see §13.9.

---

## 8. Phase 1 — what was built

Migration **0081**, one new package, two routes, one Studio tab. No vendor was contacted, because there is
nothing to contact with: every integration is `manual`, `redirect_only` or `awaiting`, and the API mode is
refused by the route with the reason.

### 8.1 Migration 0081

Ten tables — `panel_vendors`, `vendor_integrations`, `vendor_capabilities`, `vendor_pricing`,
`vendor_quotations`, `audience_specifications`, `recruitment_projects`, `sample_allocations`,
`recruitment_orders`, `recruitment_events` — plus two security-definer ownership helpers and two atomic
functions. RLS on all ten, SELECT-only policies, service-role writes, and `credentials_sealed` removed from
the column grant rather than from the table, so a member reading an integration gets its mode, health and
masked hint and never the sealed blob.

Three constraints are worth naming because they encode decisions rather than types:

- **`vendor_integrations_api_needs_credentials`** — an `api` integration with no credentials cannot exist. The
  marketplace renders from this table, so the lie the brief forbids is refused by the database.
- **`rescript_recruitment_allocate`** enforces the approved budget and the required completes as *ceilings*,
  raising rather than clamping. §30's "never exceed an approved budget without authorization" is a check
  constraint in a function, not a warning a screen prints.
- **`rescript_recruitment_order_apply`** inserts the idempotency key into `recruitment_events` first and
  returns `applied = false` if it was already there. Counts are **absolute, not deltas**, so an out-of-order
  vendor callback cannot double-count money.

The platform catalogue — Dynata, Cint (Lucid), Toluna, PureSpectrum, Prodege, Prolific, YouGov, Bilendi,
CloudResearch, Qualtrics Panels — is seeded as **directory entries only**, each pointing at the 0072 panel
preset that already knows its redirect contract where one exists. A catalogue row grants no capability.

### 8.2 `packages/recruitment`

- **`capabilities.ts`** — the capability registry. A capability has three states (`unsupported` / `declared` /
  `verified`), `MODE_CEILING` caps what a mode can ever support regardless of what an adapter claims, and
  `requireCapability` throws rather than returning a boolean a caller can forget to check.
- **`adapter.ts`** — the vendor adapter interface: authenticate, feasibility, quote, createOrder, orderStatus,
  cancelOrder, reconcile. Every figure carries a `source`; a vendor-side "no" is a result, not an exception.
- **`adapters/manual.ts`** — the only adapter that works today, with its I/O injected so it stays pure. Its
  `maxSource` is `vendor_reported`, so **it cannot produce a `live` figure by construction**.
- **`adapters/registry.ts`** — dispatch, with the capability checked before the call.
- **`pricing.ts`** — half-open rate-card bands, markup, and the objective function
  `costPerValidComplete = cpi / ((1−r)(1−d))`.
- **`feasibility.ts`** — assembles an estimate per vendor and ranks the comparison on cost per valid accepted
  complete. Missing figures are `null`, never 0; unrankable vendors stay in the table with their reason.

### 8.3 Studio

- `GET/POST/DELETE /api/recruitment/vendors` — the directory, integrations, capabilities and rate cards.
  Refuses `mode: "api"` (no adapter) and `source: "live"` (a person typing is not a quotation), both with the
  reason rather than silently.
- `GET/POST /api/surveys/[id]/recruitment` — the project, comparison, allocation, authorisation, orders and
  progress. Reading needs `fieldwork.read`; allocating, authorising, ordering and recording spend need
  `deploy.manage` — deliberately narrower than reading, because those four commit money.
- **Fieldwork → Recruitment**, beside Fieldwork in Results. Capabilities render as words, not ticks; the
  comparison shows the quoted CPI beside the cost per valid complete so the winning row can be seen not to be
  the cheapest; API mode appears disabled with its reason rather than hidden.
- Six audit events added to the closed vocabulary in `packages/access/src/audit.ts`, with their sentences.

### 8.4 Verification

| Check | Result |
|---|---|
| 0001–0081 applied in order to a scratch Postgres 16 | all 81 applied |
| 0081 applied three times (re-runnability) | clean; the catalogue stays at 10 rows, not 30 |
| `scripts/recruitment-sql-test.sql` | 6 groups PASS — structure, shapes, allocation ceilings, idempotent progress, the RLS backstop, cascade |
| `packages/recruitment` unit tests | 29 pass |
| `packages/access` (audit vocabulary) | 123 pass |
| `packages/schema`, `packages/engine` (panels, sampleSource) | 18 + 21 pass |
| `tsc --noEmit -p apps/studio` / `-p apps/runtime` | 0 / 0 |
| `scripts/dependency-boundaries.mjs` | 2,186 files, 11,039 imports, 21 workspaces — 0 violations |
| `scripts/auth-guard-audit.mjs` | 271 handlers — 0 problems |
| `scripts/analytics-test.mjs` nav assertion | updated for the new tab (not run: needs a dev server) |

**Not verified here.** No browser suite was run — the container has no dev server and the device VM has no
pnpm — so the Studio tab has been typechecked and reasoned about but not clicked. No Supabase project was
touched: everything above is a scratch Postgres. And no vendor API exists to test against, which is the
honest state of Phase 1 rather than a gap in its testing.

---

## 9. Phase 2 — what was built

Migration **0082**, the optimiser, budget control, and the audience as a first-class part of the study.
Still no vendor is contacted.

### 9.1 Markets (0082)

Phase 1 priced a project against the first country in its audience. For "US, UK and Germany" that is wrong in
the expensive direction. A project now carries a completes target **per market** (`recruitment_markets`), and
`rescript_recruitment_allocate` was replaced with a market-aware version holding two ceilings: the approved
budget across the whole project, and the required completes *per market* — over-delivering Germany does not
excuse under-delivering the US. A market the project never declared is refused outright rather than invented.
A project with no declared markets keeps Phase 1's single-pool behaviour exactly, and the Phase 1 SQL test
still passes against the replacement.

`vendor_capacity` records what a vendor says it can supply in a market, with provenance and a recorded date.
A NULL `available_sample` means **they did not say** — not zero, not unlimited — and the optimiser treats it
as unknown. Capacity expires, and an expired row is not served at all rather than served with a flag.

### 9.2 The optimiser

`packages/recruitment/src/allocate.ts`. Per market the problem is a transportation problem with box
constraints, so a greedy fill in ascending score order is *exactly* optimal — no search needed. What makes it
interesting is the budget, which couples the markets; that is handled with a Lagrangian, bisected for the
smallest cost pressure whose plan fits, and the pressure is reported as `costPressure` so the plan can say out
loud that it gave you cheaper vendors than your strategy asked for.

Three properties were prioritised over squeezing the last percent, because a human authorises the output and
then spends tens of thousands on it: **deterministic** (ties break on integration id, never on input order or
map iteration), **explainable** (every row carries its arithmetic; every excluded vendor carries its reason),
and **honest** about thin data. A vendor with no history is scored on a prior rather than on its own thin
numbers — assuming zero rejection would make an unknown vendor look flawless and win every comparison — and
its share of a market is capped. Those caps relax, with a note, when they would otherwise make a new
organisation's first project unbuyable.

### 9.3 Budget control

`packages/recruitment/src/budget.ts`. One distinction governs it: **spent** is what delivered completes have
cost; **committed** is what placed orders will cost. Headroom is budget minus committed, never minus spent — a
dashboard built on the second number tells a researcher they have £28,000 left on the morning they have
already promised £26,000 of it. `rescript_recruitment_recommit` recomputes committed spend in the database and
reports a threshold **crossing** rather than a state, so `BudgetThresholdReached` fires once rather than on
every order afterwards. The projection extrapolates from the rate the project is *actually* paying per
accepted complete, but only once there are at least 100 of them — fifty completes is an anecdote, and
extrapolating from one would cry wolf on every study's first hour.

### 9.4 The audience

`definition.audience` holds the working specification, like `definition.panels`: versioned with the study,
cloned with it, undone with it. A recruitment project **snapshots** it into `audience_specifications` when it
is created, so editing the draft afterwards cannot silently change what was ordered against.

`define_audience` and `clear_audience` are new ops in `packages/engine/src/recruitmentActions.ts`, wired into
the existing gate, preview diff and change list. Two decisions there are worth recording:

- **An unrecognised country is refused, not guessed.** `countryCode` consults its word table *before* the
  two-letter shape, because "uk" is both — and the ISO alpha-2 for the United Kingdom is GB. A rate card keyed
  on "UK" matches nothing, prices nothing, and looks like a vendor problem.
- **Refining merges.** `AudienceSpecification` gives every list a default of `[]`, so after parsing, "the
  researcher did not mention income" and "the researcher wants no income filter" are the same empty array. A
  plain spread would silently remove a filter they are still paying for, so `mergeSection` lets an empty list
  never overwrite a populated one. Removing a filter is what `replace` is for, and it is asked for explicitly.

### 9.5 A Phase 1 bug the Phase 2 tests caught

`asFraction` in `pricing.ts` guessed whether a rate was a percentage or a fraction with `rate > 1 ? rate / 100
: rate`. That guess is wrong at exactly one value, and that value is common: a duplicate rate of `1` means one
percent and was read as 100%. **Any vendor with a 1% duplicate rate was scored as yielding nothing and
silently dropped from every allocation.** There is no heuristic that can tell 1% from 100%, so there is no
heuristic now: the unit is fixed at percent, documented, and clamped. A regression test pins it.

### 9.6 Verification

| Check | Result |
|---|---|
| 0082 applied twice over the full chain on scratch Postgres 16 | clean |
| `scripts/recruitment-markets-sql-test.sql` | 6 groups PASS |
| `scripts/recruitment-sql-test.sql` (Phase 1) re-run against the replaced allocator | 6 groups PASS — no regression |
| `packages/recruitment` | 56 pass (29 → 56) |
| `packages/engine` | 2,668 pass, including the new `recruitmentActions` suite |
| `packages/schema`, `access`, `quality` | 18 / 123 / 67 pass |
| Studio copilot + prompt-cache suites | 437 pass |
| `tsc --noEmit` studio / runtime | 0 / 0 |
| `dependency-boundaries.mjs` | 2,193 files, 11,062 imports — 0 violations |
| `auth-guard-audit.mjs` | 271 handlers — 0 problems |
| `gen-public-docs.mjs --check` | current (the new ops regenerate into the actions reference) |

**Not verified here**, as in Phase 1: no browser suite ran, and no Supabase project was touched.

---

## 10. Phase 3 — what was built

Migration **0083**, a new `packages/identity`, and the admission path extended — **in shadow mode, refusing
nobody**. §2 of this document is the specification this phase implements, and nothing in it was softened.

### 10.1 The graded answer

The schema is built around three resolutions rather than a yes/no, because three of the brief's four
deduplication signals are not obtainable from the vendors it names:

| Resolution | When | Confidence |
|---|---|---|
| `deterministic` | the same vendor's participant id, or an identity this platform holds | 100 |
| `probabilistic` | different ids, but device/network/behaviour agree | 55 / 75 / 88 by signals agreeing |
| `vendor_scoped` | nothing links this arrival outside the vendor that sent it | 0 |

**Probabilistic never reaches 100, at any number of agreeing signals.** A household behind one router sharing
one tablet produces three agreeing signals and is two people; no quantity of circumstantial evidence becomes
proof, and a system that rounded 88 up to "certain" would be refusing someone a day's paid work on a guess.

`rescript_rtid_resolve` returns **two** answers that are constantly confused and must not be: how *this
arrival* was matched, and how well the *identity* is known overall. A person known deterministically from Cint,
arriving from Dynata linked only by a shared device, is a probabilistic match to a deterministic identity.
Reporting the identity's standing as the match's would turn circumstantial evidence into proof at exactly the
moment it matters. The test suite caught me conflating them.

### 10.2 Keys

`RTID_MATCH_KEY` is a different key from `QUALITY_HASH_SALT`, and the reasoning is in `.env.example` beside it.
The quality salt is per *survey*, which makes a device hash in one study incomparable with one in another — a
real privacy property that exists on purpose. Cross-project matching relaxes it, so it is relaxed narrowly: its
own key, its own table, its own retention, organisation-scoped so a trust id never spans customers. The
per-survey hashes in `responses` are untouched; a match token is never written there and a `responses` hash is
never usable as a match token.

**Unset, the whole subsystem is off.** `keyRing()` throws rather than defaulting, and the runtime catches that
and admits everyone. A system that silently derived matchable tokens under a guessable key would be worse than
one that refused to run, because nobody would find out until the tokens were written.

`identity_match_tokens` holds HMACs and has **no column a raw identifier could go in** — the schema makes the
mistake impossible rather than forbidding it in a comment. RLS on, no policy, no grant: the `panel_secrets`
pattern.

### 10.3 Normalisation, and why it does less than you'd expect

E-mail normalisation trims and lower-cases and **nothing else**. It is tempting to strip dots and `+tags`
because Gmail treats them as equivalent, but plenty of providers deliver `a.b@` and `ab@` to different people
and `+` is a legal, meaningful character. The asymmetry decides it: over-normalising **merges two people**,
which here means refusing one of them entry and their earnings; under-normalising merely fails to match, which
is recoverable. Phone numbers are normalised to digits with the prefix given and **no country is ever
inferred** — guessing a country code and matching on the guess merges strangers.

### 10.4 Atomic reservation

`participation_ledger_live_uniq`, a partial unique index over `(survey_id, trust_id)` where the state is live
and the row is not a shadow observation. Concurrent arrivals contend on it in the database, which is the only
place the race can actually be won.

`scripts/rtid-concurrency.sh` fires N genuinely parallel sessions at one person in one project, because a
single-transaction SQL test cannot make a claim about concurrency — the transaction never races itself. At 24
and at 16 arrivals: **exactly one admitted, the rest refused, zero errors, one live ledger row.**

Reservations expire and `rescript_rtid_sweep` returns them. Without it, a respondent whose browser died on the
consent page holds their own place forever and is refused as a duplicate of themselves — the most infuriating
possible failure, and invisible unless somebody is looking for it.

Several trust ids answering one deterministic token are recorded as a **merge candidate**, never merged.
Merging rewrites participation history, and doing it inside an admission call that must answer in milliseconds
is how a race corrupts a ledger.

### 10.5 Shadow mode

Every project starts at `dedupe_mode = 'shadow'`: identities resolve, the ledger is written, duplicates are
recorded with `would_block`, and **nobody is refused**. Counting those events *is* the false-positive exposure,
measurable on real traffic before anyone loses a paid piece of work. A deduplication system that starts by
turning away real respondents with no measured baseline is one that gets switched off in week two.

The runtime path fails open on every error — missing key, unmigrated schema, unreachable table all admit the
respondent and log once. And even under enforcement, a probabilistic match below 85% never refuses anybody.

`deduplicationStatement()` writes the honest headline for a final report: deterministic prevention where
identity was available, circumstantial detection elsewhere, and the count of arrivals nothing could be said
about at all. It cannot produce the words "zero duplicates", because that claim cannot be supported.

### 10.6 Verification

| Check | Result |
|---|---|
| 0083 applied twice over the full chain | clean |
| `scripts/rtid-sql-test.sql` | 7 groups PASS |
| `scripts/rtid-concurrency.sh` at 24 and 16 arrivals | PASS — exactly one admitted each time |
| `packages/identity` | 20 pass |
| `packages/recruitment` / `engine` / `schema` / `access` / `quality` | 56 / 2,668 / 18 / 123 / 67 |
| `tsc --noEmit` studio / runtime | 0 / 0 |
| `dependency-boundaries.mjs` | 2,199 files, 22 workspaces — 0 violations, and R3 now forbids `identity → recruitment` (verified by a deliberate violation) |
| `auth-guard-audit.mjs` | 271 handlers — 0 problems |

**Not verified:** no browser suite, no Supabase project, and — importantly — **no real traffic has been through
shadow mode yet**, so the false-positive rate this phase exists to measure is still unmeasured. That is the
gate on Phase 4 turning enforcement on.

---

## 11. Phase 4 — what was built

Migration **0084**, the gateway endpoint, and admission scoring inside `packages/quality` rather than beside it.
Nothing here refuses anybody on a risk score.

### 11.1 The gateway

`/r/<client>/<study>` — deliberately shaped like the survey link it redirects to, so a vendor swapping one for
the other changes a single character and keeps every parameter it already appends. It resolves identity (0083),
scores risk, records the decision, issues an access token and redirects to `/s/…?at=…`.

Nothing is rendered. An admitted respondent should see the survey, not an interstitial telling them they were
checked; a refused one goes to their vendor's own end link with the outcome that vendor's reconciliation
expects, without being shown a message about fraud. It fails **open** at every step: unmigrated database,
missing key, unreachable table all send the respondent through exactly as the plain link would. A gateway that
can take a study offline is worse than no gateway.

### 11.2 Access tokens

`survey_access_tokens` stores the **SHA-256 of the token, never the token** — treated exactly as a password
would be. Single use is a conditional update (`where redeemed_at is null`), so simultaneous redemptions contend
in the database. `scripts/admission-concurrency.sh` fires N parallel redemptions of one token: at 20 and 12,
**exactly one succeeded, the rest were told `already_used`, zero errors.**

Failure says *why* — `already_used`, `expired`, `unknown` — because those lead a respondent to different next
steps. A token for another survey answers `unknown` rather than admitting the row exists.

**The honest limit of this phase: the token is recorded, not required.** Nothing yet refuses an arrival that
skipped the gateway and went straight to the survey link — which is every arrival today, since no vendor has a
`/r/` link. Requiring it is a one-line change in `session/start` and belongs in Phase 6, once gateway links are
actually in use. Redemption also cannot refuse, because the runner re-posts on resume, by which time the token
is legitimately spent; refusing would turn every tab refresh into a lockout.

### 11.3 Scoring inside the existing engine

`packages/quality` already had 58 rules and a worked-out combination of evidence. Admission adds **four rules to
the same catalogue** — `network.datacenter`, `network.identity_density`, `device.identity_density`,
`history.refused_elsewhere` — and runs them through the same `finalizeFlags` and `riskScore`, which already
folds network and device into one fact because the same machine on the same connection is one piece of evidence,
not two. One vocabulary, one set of weights, one dashboard; a reviewer does not learn a second system.

Every rule states what it **saw**, never a verdict: "eleven identities from this network" is a fact,
"suspicious" is not, and a test asserts no explanation contains the word.

**The ceiling.** Every admission rule firing at once, at maximum intensity, reaches **74** — one below the
brief's `critical` band. That band is not reachable before entry, and that is the point: it is reserved for
evidence this layer does not have, namely the respondent's actual answers, timings and peers. Circumstantial
evidence about a network and a device, however much of it there is, is not certainty about a person. The test
pins the ceiling so a future weight change that pushed it past 75 fails loudly.

### 11.4 Review, not refusal

A high band opens a `fraud_case`, holds the complete from billing, and admits the respondent. Clearing a case
releases the payment **and lowers the identity's standing risk** — without that, one false positive would follow
a respondent for ever, opening a fresh case on every later arrival. Upholding quarantines the identity. An
appeal is recorded and answerable, because an upheld case with no appeal is an accusation a person cannot
answer, from a system whose false-positive rate nobody has measured.

### 11.5 A Phase 3 bug this phase found

`identity_match_tokens` had a unique index on `(customer_id, kind, token)`. For a deterministic token that is
right. For a **probabilistic** one it was wrong in the direction that harms people: a network token belongs to a
router, and a router has a household behind it. Under that index the second person to arrive from an address
could not get their own row, so `rescript_rtid_resolve` found the **first** person's identity and silently
returned it. **Two people sharing a home connection became one person**, and the second was then liable to be
refused as a duplicate of a stranger. The Phase 4 test caught it.

Two changes, both in 0084:

- uniqueness scoped to what it is true of — deterministic unique per token, probabilistic unique per
  *(token, identity)*, so many identities may legitimately share a network or device;
- **circumstantial evidence no longer merges people.** A probabilistic match is adopted only at or above 85 —
  the same threshold `decideAdmission` requires before it will act on a match. Below it, a new identity is
  minted and the resemblance is recorded as a `merge_candidate` with its confidence. Evidence that cannot
  license a refusal cannot license an identity either.

The weaker links are not thrown away: the shared tokens are exactly what the density rules count, so a click
farm running forty identities through one device still lights up — as a scored, reviewable fraud signal rather
than a silent identity merge nobody can see. Phase 3's SQL test was rewritten around the corrected rule.

### 11.6 Verification

| Check | Result |
|---|---|
| 0084 applied twice over the full chain | clean |
| `scripts/admission-sql-test.sql` | 6 groups PASS |
| `scripts/admission-concurrency.sh` at 20 and 12 replays | PASS — exactly one redemption each time |
| `scripts/rtid-sql-test.sql` (rewritten for the corrected resolver) | 7 groups PASS |
| `packages/quality` | 83 pass (67 → 83) |
| `identity` / `recruitment` / `engine` / `schema` / `access` | 20 / 56 / 2,668 / 18 / 123 |
| `tsc --noEmit` studio / runtime | 0 / 0 |
| `dependency-boundaries.mjs` | 2,203 files, 22 workspaces — 0 violations |
| `auth-guard-audit.mjs` | 271 handlers — 0 problems |

**Not verified:** no browser suite; no Supabase project; no traffic through the gateway, so the false-positive
rate remains unmeasured. There was also no Fraud Intelligence Center UI at this point (the brief's §29) — the
data was all there and queryable, but a reviewer had no screen to work the queue from. That, the click-farm
graph (§19) and vendor quality scoring are §12 below.

---

## 12. Phase 5 — what was built

Phases 3 and 4 look at one arrival at a time. Phase 5 asks the three questions that only exist across many
arrivals: *is this a ring rather than a person*, *is this vendor actually any good*, and *is this project going
to finish*. It also builds the screen the previous two phases were missing, and — the part that matters most —
the measurement that says whether any of it works.

Migration **`0085_fraud_graph_and_quality.sql`** adds `fraud_network_clusters`, `vendor_quality_metrics`,
`recruitment_forecasts` and `model_evaluations`, plus `fraud_cases.cluster_id`.

### 12.1 The ring is the unit

`packages/quality/src/cluster.ts` builds a graph over the probabilistic signals identities share — device,
network, behaviour — and reports connected components as candidate rings.

The hard problem is **carrier NAT**. Four hundred unrelated people behind one mobile operator's address share a
network token, and a naive component walk reports them as the largest fraud ring ever detected. Two rules stop
that:

```ts
export function signalWeight(kind: SignalKind, sharedBy: number, config: ClusterConfig): number {
  if (sharedBy < 2) return 0;
  if (sharedBy > config.maxIdentitiesPerSignal) return 0;   // infrastructure: no information about who is behind it
  return KIND_WEIGHT[kind] / Math.log2(sharedBy);            // a link shared by many proves little
}
```

A signal held by more than 50 identities is dropped entirely rather than down-weighted, because the
down-weighted version still links them all into one component. The surviving edges are weighted by how *rare*
the link is.

The score is then deliberately a function of **both** size and ratio, never either alone:

```
score = 100 × (0.55·ratio + 0.20·size + 0.15·cohesion + 0.10·burst)
```

Six identities on one device scores 42 against a threshold of 45 and is **not** reported. Twelve on two devices
— the same ratio, twice the evidence — scores 52 and is. Twelve across four devices is ratio 3.0 and is not
reported at any size, because that is a household. A test pins all five of those cases, because the first
version of that test asserted the wrong one and the code was right.

A detected ring opens **one** case naming its members, with the arithmetic attached. Re-running the hourly pass
updates that case rather than opening another, and a ring a human has already judged keeps its verdict —
otherwise a reviewer clears the same network every hour forever.

### 12.2 Vendor quality, with the uncertainty attached

`packages/recruitment/src/quality.ts` and the SQL function `rescript_vendor_quality_recompute` compute each
vendor's rates from **real order outcomes**, with a **Wilson score interval** beside every one.

The motivating failure is simple: a 20% rejection rate over five completes and over five thousand are different
claims, and a column holding only the point estimate cannot tell them apart. The optimiser (Phase 2) already
ranks on the pessimistic bound — this is what finally gives it a bound to rank on.

Wilson rather than the normal approximation because the normal interval for 0 successes in 5 trials is exactly
`[0, 0]`: a brand-new vendor would look flawless on its first week. Wilson gives `[0%, 43%]`, which is the
truth. Verified in SQL: the same 9.09% rejection rate is 10.9 points wide over 110 completes and 3.4 points over
1,100.

Two refusals are built in and tested:

- **No score below 50 accepted completes.** Not a low score — `NULL`. Rendering "unknown" as zero buries every
  new vendor relationship on its first day.
- **A vendor with no history ranks LAST, not first.** The bug this guards against is reading a null rejection
  rate as 0 and handing a brand-new supplier the whole project.

### 12.3 Reallocation proposes; it does not act

`reallocate.ts` detects two kinds of deviation and computes a costed replacement plan — and then stops.

Applying it cancels part of one supplier's order and places it with another. That is a commercial act with a
counterparty and a contract behind it, and a researcher who comes back from lunch to find the platform has
unilaterally cancelled half of a vendor's order has lost more than the hour the automation saved. So the type
itself carries `requiresApproval: true` and the notes end with *"Nothing has been ordered."*

Three judgements worth stating:

- **The shortfall is the projected gap, not today's.** A vendor at 300 of 1,000 with 80% of the field gone is on
  track for 375, so 625 needs re-sourcing — not the 500 it is behind pro-rata right now.
- **Pace alone is the wrong test near a deadline.** 60% of pro-rata with half the period left is a *watch*; the
  same 60% with a fifth left is an *act*, because recovering would take four times their own observed rate.
- **Quality is judged on the OPTIMISTIC bound.** The pessimistic bound is right for *choosing* vendors; the
  optimistic one is right for *accusing* them. Six rejections in 40 screened is 15% against 8% assumed and is
  not actioned; the same rate over 2,000 screened is.

### 12.4 Forecasting has two outcomes, not three

`forecast.ts` returns a forecast or an `insufficient` with the reason. There is deliberately no "low confidence
estimate", because in practice that is read as an estimate.

Two independent gates, both of which must clear: **30 accepted completes** and **6 hours of field**. A project
running at 400/hour clears the sample gate in minutes and still waits out the clock, because response rates
follow the local clock and the first two hours of a launch are the rate of the launch, not of the project.

An `insufficient` result carries no date and no rate — nothing a reader could multiply out themselves.

### 12.5 The detector grades itself, and currently scores nothing

`rescript_model_evaluate` measures precision and the false-positive rate over **resolved** cases only. An upheld
case is a true positive, a cleared one a false positive; a suspicion is neither.

Below 30 resolved cases it reports `insufficient` and publishes no numbers. Today that is the honest state: no
traffic has been through shadow mode, so nothing has been resolved. The SQL test pins the two properties that
matter — 29 resolutions is still insufficient, and **a hundred open cases move precision not at all**. Counting
suspicions as confirmations is how every fraud system reports 99% accuracy right up until somebody checks.

### 12.6 The Fraud Intelligence Centre

`apps/studio/app/fraud/page.tsx`, with `/api/fraud` behind it — the screen §29 asks for and the previous two
phases did not have.

- Networks are shown as networks, with one decision for the whole ring.
- Every case shows the reasons and the evidence that produced its score. A reviewer being asked to withhold a
  supplier's payment should not have to take a number on trust.
- **Upholding requires a typed reason.** §20 gives the respondent an appeal, which is worth nothing without a
  stated reason to appeal against.
- A banner at the top says the scores have not been validated, and the evaluation panel says so in numbers —
  and keeps saying so until reviewers have worked the queue.

There is no bulk "uphold everything open" and no filter that resolves a selection. An unmeasured false-positive
rate is not a thing to automate against.

`/api/cron/fraud-intelligence` runs the graph, the quality recompute, the forecasts and the evaluation hourly
(`vercel.json`, minute 29). It opens cases. It refuses nobody, voids nothing, and marks no identity — the Phase 4
rule, unchanged.

### 12.7 A bug in 0085 the SQL test caught

`rescript_cluster_upsert` returns `(cluster_id, case_id, created)` and queries `fraud_cases`, which has its own
`cluster_id` column:

```sql
select id into v_case from public.fraud_cases
  where cluster_id = v_cluster and ...;     -- ambiguous: OUT parameter or column?
```

PostgreSQL refuses the whole call. The function would have detected a ring, begun opening its case, and then
errored — every time, silently, from a background job nobody watches. Fixed by aliasing the table.

### 12.8 Verification

| Check | Result |
|---|---|
| 85-migration chain applied to a clean database | clean |
| 0081–0085 each applied twice | clean |
| `scripts/fraud-graph-sql-test.sql` | 11 assertions PASS |
| `packages/quality` | 96 pass (83 → 96) |
| `packages/recruitment` | 89 pass (56 → 89) |
| `identity` / `engine` / `schema` / `access` | 20 / 2,668 / 18 / 123 — all pass |
| `tsc --noEmit` studio | 0 errors |
| `dependency-boundaries.mjs` | 2,214 files, 11,134 imports, 22 workspaces — 0 violations |
| `auth-guard-audit.mjs` | 273 handlers — 0 problems |
| `gen-public-docs.mjs --check` | current |

**Not verified at the time:** no browser suite, no Supabase project, and — the one that matters — still no traffic. Every
threshold on this page (45 for a cluster, 50 accepted completes for a score, 30 resolved cases for precision,
5 points for a quality deviation) is a considered guess. The machinery to measure them now exists; the
measurement does not.

---

## 13. Phase 6 — what was built

The plan called this phase blocked on vendor contracts. Most of it was not. A vendor's API
documentation is public; what a contract buys is the right to *call* it. So the transport, the
webhook door, settlement reconciliation and one complete adapter were all built against
published documentation, and what remains blocked is only verification against a live account.

Migration **`0086_live_integrations.sql`** adds `vendor_api_calls`, `vendor_circuit_state`,
`vendor_webhook_receipts`, `settlement_reconciliations` and `settlement_differences`.

### 13.1 Retry is a question about safety, not about failure

`packages/recruitment/src/http.ts`. The useful question is never "did it fail" — it is "is
trying again safe". A feasibility lookup may be retried freely. An order placement may not,
unless the vendor de-duplicates on a key:

```ts
export function mayRetry(policy: RetryPolicy, status: number | null, method: string): boolean {
  if (policy === "never") return false;
  if (policy === "safe" && method !== "GET" && method !== "HEAD") return false;  // the caller is mistaken
  if (status === null) return true;
  return RETRYABLE_STATUS.has(status);
}
```

A caller that marks a write as `safe` is refused rather than obeyed, because the cost of
honouring that mistake is buying the same sample twice. And when a non-retryable write times
out, the error says the order's state is **unknown** rather than that it failed — an operator
told "failed" re-orders.

Backoff is full jitter rather than a fixed ladder: equal backoff puts every client back on a
recovering API at the same instant, which is how an outage is extended by the retries that
followed it.

### 13.2 A circuit breaker that admits what it cannot do

A 400 does not trip the breaker. Our own malformed request must not take a working vendor
offline for every project that includes it; only transport failures, 5xx and 429 count.

More importantly, the in-process breaker is documented as a **fast path, not the truth**. On
serverless hosting each invocation may be a cold process, so in-memory state is frequently
empty and the breaker then behaves as if closed. A breaker that silently does nothing in
production while passing its tests is worse than no breaker, so it takes an optional durable
state store and `vendor_circuit_state` exists for one to be built on. Without it, it degrades
to per-process — honest, and weak, and said so in the file.

### 13.3 The Prolific adapter, and four things Prolific is not

Written against `docs.prolific.com`: base `https://api.prolific.com/api/v1`,
`Authorization: Token <token>`, `POST /eligibility-count/`, `POST /studies/` then
`POST /studies/{id}/transition/`.

Four constraints fall out of what Prolific actually is, rather than what the adapter interface
would like it to be:

- **It does not quote a CPI.** It pays a participant a reward and charges a fee. So `quote` is
  not declared as a capability, and `maxSource` is `vendor_reported` — never `live`.
- **Its eligibility count returns 0 to mean "fewer than five".** A privacy floor, not a
  measurement. Writing that 0 into `available` would let the optimiser read "we may not tell
  you" as "there is nobody" and silently drop a vendor with sample. It becomes `null` with the
  reason attached.
- **A match count is not a forecast of completes.** How many people fit the filters and how
  many will take the study are different numbers, and the gap between them is the whole
  recruitment problem. The estimate says which one it is.
- **Only age is mapped to a real filter.** Prolific's other filter ids are account- and
  locale-specific, discovered at runtime. A wrong `selected_values` is *accepted* by the API
  and quietly recruits the wrong population — discovered weeks later, in the data. Every other
  criterion is named in `unmapped` instead, and repeated on the order acknowledgement so the
  operator learns it twice.

Screeners are deliberately *not* listed as unmapped: they are asked inside the survey, so
calling them dropped would be false.

### 13.4 Why ordering is two calls

A draft commits nothing; publishing spends money. Creating the draft first means an ambiguous
timeout leaves an orphaned unpublished study — free, and deletable. A single combined call that
timed out would leave a study that may or may not be live and may or may not be paying people.

A publish failure therefore returns the draft id and says *nothing has been recruited and
nothing has been spent*, with instructions to publish or delete it. `OrderRequest` gained an
optional `audience`; ordering without one is refused outright, because on Prolific that
recruits the general population and bills for it.

### 13.5 The webhook door

`webhook.ts` and `apps/studio/app/api/webhooks/vendors/[vendor]/route.ts`. This is the one
endpoint a stranger is invited to call, and what arrives decides whether a supplier is paid.
Three things must hold, each failing closed: **authentic** (constant-time HMAC over the exact
bytes), **fresh** (a signed timestamp inside five minutes, in *both* directions — a future
timestamp is how a replay is given a long life), and **new** (an event id not seen before).

Verification runs over the **raw body**. Prolific's own example re-serialises a parsed body
with `json.dumps`, which works only while both sides serialise identically; one difference in
key order and a genuine event is rejected as a forgery. A test pins exactly that.

**Nothing is dropped.** A forged, stale or unsigned delivery is stored with its verdict and
quarantined. An endpoint that silently discards what it cannot verify is indistinguishable from
a broken one, and it hides both an attacker probing it and an integration nobody finished
configuring. A rising count of `bad_signature` and a rising count of `no_secret` are different
problems, and both are invisible if unverifiable deliveries are thrown away.

De-duplication is a unique index in the database, not a check in the handler. A select-then-insert
loses the race between two simultaneous retries, and losing it means paying for one complete
twice. `scripts/webhook-concurrency.sh` fires 24 simultaneous deliveries of one event id;
exactly one is new.

### 13.6 Three accounts of one order

`settlement.ts`. At the end of a project there are three records of the same work — what the
vendor claims, what the platform accepted, and what is payable once fraud holds are applied —
and they are never quite the same.

The temptation is to produce one number. That number is always wrong for somebody and, worse,
hides *why*: a vendor shown "we owe you £4,120" cannot tell a quality rejection from a clerical
mismatch. So there is a line per disagreement, each with its cause, and the total is reported
three times.

It reports **both directions**, including completes the platform accepted that the vendor has
not billed for — the half a one-sided reconciliation misses entirely, and usually a sign the
vendor's own records are incomplete. A price disagreement settles the participation at the
agreed rate and reports the difference, rather than withholding the whole payment over a
rounding dispute. Nothing here resolves anything: `settled_at` is set only by a human.

### 13.7 Health that is observed rather than declared

`rescript_vendor_health_recompute` computes `vendor_integrations.health` from the call log, so
it stops being an operator's opinion. A vendor nobody has called is `unknown` — not healthy,
not failing. The same refusal §12.2 makes about vendor quality.

`vendor_api_calls` stores the **path only**. A query string on a recruitment API routinely
carries a participant identifier, and this table is kept long enough for health trends — long
enough that storing one would be a quiet re-identification surface sitting beside the registry
§10 went to such lengths to keep hashed. A test asserts no stored path contains `?`.

### 13.8 Verification

| Check | Result |
|---|---|
| 0086 applied twice over the full chain | clean |
| `scripts/live-integrations-sql-test.sql` | 8 assertions PASS |
| `scripts/webhook-concurrency.sh` at 24 deliveries | PASS — exactly one new |
| `packages/recruitment` | 146 pass (89 → 146) |
| `quality` / `identity` / `access` / `schema` | 96 / 20 / 123 / 18 — all pass |
| `tsc --noEmit` studio / runtime | 0 / 0 |
| `dependency-boundaries.mjs` | 2,223 files, 11,166 imports — 0 violations |
| `auth-guard-audit.mjs` | 273 handlers — 0 problems |

### 13.9 What is still not built, and why

**There is no Cint adapter.** `WebSearch` is disabled in the environment this was built in, and
Cint's API documentation could not be read. Writing an adapter from memory would be precisely
the misrepresentation the capability registry exists to prevent — a vendor appearing integrated
when nothing has been checked. The Prolific adapter is the template; Cint needs its documentation
and perhaps two hours.

**Nothing has been run against a live account.** The adapter is written against published
documentation and tested against scripted responses. Until a real call succeeds, every
integration stays `verified_at = null`, and §8's rule holds: declared is not verified, and every
surface shows the difference.

**No load or security testing.** The original Phase 6 scope included both. Neither was done.

---

## 14. Decisions needed

1. **Vendor contracts.** Nothing in Phase 6 can proceed without at least one sample-provider
   agreement. Cint's marketplace API and Prolific's API are the two with the lowest barrier.
2. **`RTID_MATCH_KEY` and the cross-project opt-in.** Deduplicating across projects means
   deriving matching tokens an organisation does not derive today. This needs a DPIA entry and
   a per-organisation setting that is **off** by default.
3. **Whether Rescript holds respondent identity at all.** Everything deterministic in Part D
   depends on it. If the answer is "only for client-supplied sample and our own panel", the
   design above is complete; if Miures intends to operate its own panel, that is a product in
   its own right with consent, incentive and payout obligations not covered here.
4. **Appeal SLA.** §20 requires a false-positive review mechanism. A blocked respondent is
   someone's earnings; an appeal queue with no owner and no turnaround is worse than no appeal.
