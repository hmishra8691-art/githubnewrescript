# Smart Recruitment — researcher-first redesign

**2026-11-04.** Branch `feat/recruitment-abstraction`. Phase 1 of 7 built.

The recruitment exchange (Phases 1–6, `docs/RECRUITMENT-EXCHANGE-2026-11-03.md`) was built around
the vendor ecosystem: a marketplace, rate cards, a comparison table naming suppliers, an
optimiser whose output is a per-vendor allocation. That is the right internal model and the
wrong researcher-facing one. This workstream turns the experience around without discarding the
machinery underneath.

---

## 1. The audit, and two things it found

The brief required an audit before any change, and forbade replacing working functionality. Two
findings are worth stating before anything else, because both were load-bearing assumptions that
turned out to be false.

### 1.1 The role boundary did not exist

```ts
const MANAGING_ROLES = ["platform_admin", "programmer", "researcher"];
```

A researcher had **identical** access to vendor names, rate cards, per-vendor CPI and the
commercial terms behind them. Not "mostly hidden in the UI" — the same API, the same payload.
`vendorName` appeared in six places in `/api/surveys/[id]/recruitment`, the route a researcher
opens every day, plus the whole marketplace tab.

So the requirement that researchers never see the supply chain was not a matter of tightening
something. There was nothing to tighten.

### 1.2 Markup is not margin, and the difference is money

`markup_bps` has always been a **markup on cost**:

```ts
applyMarkup(cpi, bps) = cpi × (1 + bps / 10_000)
```

The brief asks for a **selling-price margin**, and its own worked example settles which:

| | cost | rate | price |
|---|---|---|---|
| Brief's intent | £7,000 | 30% margin | **£10,000** — `cost / (1 − 0.30)` |
| Current code | £7,000 | 3000 bps | **£9,100** — `cost × 1.30` |

£900 a project, in the wrong direction, silently. Anyone who typed `3000` meaning "30%" has been
under-charging by about 9% of the selling price. (The field is also easy to misread in the other
direction: a `1` entered during testing is 0.01%, not 1%.)

This is **not yet fixed** — see §4.

### 1.3 What already exists and must not be rebuilt

Much of what the brief asks for is built and working, and the brief explicitly forbids replacing
it. For the record:

| Brief asks for | State |
|---|---|
| §5 automated allocation across sources | Built — Lagrangian optimiser, per market (Phase 2) |
| §5.10 reallocate when a source underperforms | Built — deviation detection (Phase 5) |
| §5.5 historical data quality | Built — Wilson intervals on real outcomes (Phase 5) |
| §7 expected completion date, recruitment speed | Built — forecasting with honest insufficiency (Phase 5) |
| §8 quota cells | Schema exists (`AudienceQuotaCell`); no monitoring engine |
| §12 "never represent unverified capacity as confirmed" | Already the design — NULL availability, `verified_at`, pricing `source` |
| §12 vendor fallback | Partly — circuit breaker and retry policy (Phase 6) |

---

## 2. Phase 1 — the vendor abstraction layer

### 2.1 Two flags, not one renamed

`canSeeVendors` is new and sits **beside** `canManage` rather than replacing it. Platform
administrators only.

The two are separate because the work is separate: clearing a fraud case is research-operations
work that a researcher should be able to do, while the vendor directory is commercial
information about the organisation's own supply agreements. Collapsing them would have forced a
choice between locking researchers out of the review queue and leaking the supply chain.

The refusal message says what the caller **can** still do. A bare "you may not see vendors"
reads as a broken feature, when in fact every recruitment action remains available.

### 2.2 The payload is built, not filtered

`apps/studio/lib/recruitment/abstraction.ts` assembles the researcher's view from the fields a
researcher is entitled to. The per-vendor arrays are never spread into it.

This is the whole design decision. A filter can only remove what somebody remembered to list,
and `{ ...row }` written in a hurry is precisely how a vendor field comes back six months later.
Building the payload means a new internal field is absent by default rather than present by
default.

### 2.3 Why there are no pseudonyms

"Source A" and "Source B" were considered and rejected. They still disclose the shape of the
supply chain: how many suppliers there are, how the sample was split between them, and which one
is behind. A researcher reading "Source B is underperforming" has learned the thing §5 says must
stay invisible.

The researcher sees **one plan**, broken down by market. Capacity is a word — `broad`,
`adequate`, `limited`, `unknown` — rather than a count, for the same reason: a number describes
the supply chain.

### 2.4 The guarantee is tested

```ts
findVendorIdentity(payload)   // forbidden keys, any depth, case-insensitive
findVendorNames(payload, names)  // this organisation's vendors as VALUES
```

The second one matters more than it looks. The likeliest leak is not a forgotten field — it is a
free-text note written for an operator ("Prolific could not express income targeting") passed
through to the researcher's plan. A key-name check cannot see it. A test pins that case.

### 2.5 A gap from 0082, found on the way

`sample_allocations.market` was added in 0082 and the store never selected it, so nothing
downstream could group an allocation by market. The per-market plan needs it; it is now
selected.

### 2.6 Verification

| Check | Result |
|---|---|
| `lib/recruitment/abstraction.test.ts` | 12 pass |
| `packages/recruitment` | 148 pass |
| `dependency-boundaries.mjs` | 2,227 files — 0 violations |
| `auth-guard-audit.mjs` | 273 handlers — 0 problems |
| `tsc --noEmit` studio / runtime | 0 / 0 |

`lib/storyEngine.test.ts` fails identically with and without these changes — pre-existing.

**Not verified:** no browser test of the gated tab, and no run against a real multi-vendor
project, because none exists yet (0 allocations in production).

---

## 3. What a researcher now receives

```
plan: {
  currency, requiredCompletes, price, pricePerComplete,
  markets: [{ market, required, planned, delivered, accepted, expectedDeliveryDays }],
  feasible, shortfall, expectedDeliveryDays,
  capacity: "broad" | "adequate" | "limited" | "unknown",
  quality: { score, confidence },
  notes: []
}
```

No vendor name, no integration id, no CPI, no acquisition cost, no per-source allocation. A
platform administrator additionally receives `comparison`, `allocations`, `orders` and
`capacity` with supplier identity attached.

---

## 4. The remaining six phases

| Phase | Scope | Why this order |
|---|---|---|
| **2 — Margin engine** | Selling-price margin, per market, per project, admin override; audit log of commercial calculations | The only part currently computing money **wrong**, and production data is still empty, so migrating costs nothing |
| 3 — Simplified setup | The six core fields; feasibility verdict before anything is saved | The visible half of the brief, and it needs the margin engine to quote a price |
| 4 — Advanced targeting | Collapsed by default; custom eligibility; regional quotas; nested AND/OR | Schema largely exists; this is UI plus validation |
| 5 — Quota monitoring | Continuous monitoring, fill under-represented cells, stop over-recruiting filled ones | Needs live traffic to be worth anything |
| 6 — Researcher dashboard | Progress, market-wise, quota-wise, speed, projected completion | Composes what Phases 2–5 produce |
| 7 — AI recommendations | Feasibility explained, actionable suggestions, accept/reject | Must rest on the real computed figures, never invented ones |

### 4.1 Decisions still open

1. **Existing `markup_bps` values.** Production holds one integration at `3` bps. Phase 2 should
   migrate the column to an explicit margin and decide whether existing values are read as
   markups (and converted) or discarded. With this little data, discarding is defensible and
   safer than a conversion nobody checks.
2. **Where margin is configured.** Per market and per project are both in the brief. Per
   integration is where the column lives today. These are three different tables.
3. **What a researcher sees when a plan is infeasible.** Currently `feasible: false` with a
   shortfall. The brief's §9 wants a recommendation instead — which needs Phase 7.
