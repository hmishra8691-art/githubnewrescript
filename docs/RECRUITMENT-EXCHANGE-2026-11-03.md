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
| 3 — Trust infrastructure | RTID, `RTID_MATCH_KEY`, vendor participant mapping, participation ledger, atomic reservation, cross-vendor dedup with confidence states | 0083 | specified |
| 4 — Fraud intelligence | Admission gateway, access tokens, IP/device intelligence, the `admission` quality profile, risk scoring, quarantine and appeal | 0084 | specified |
| 5 — Advanced optimisation | Vendor quality engine, dynamic reallocation, fraud network graph, forecasting, model evaluation | 0085 | specified |
| 6 — Production integrations | Live vendor adapters, webhooks, settlement reconciliation, monitoring, load and security testing | 0086 | **blocked on vendor contracts** |

Phase 6 cannot start until Miures holds credentials. Phases 1–5 are independent of that and
deliver a working exchange over manually configured vendors, which is how a sample desk
operates today and is a genuine product on its own.

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

## 10. Decisions needed

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
