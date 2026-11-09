---
id: billing-test-vs-live
title: Test vs live responses — and what each costs
category: billing
keywords: test responses, live responses, do test responses cost, do test responses consume credits, are test responses charged, test usage free, billable response, test link, live link, environment, test data, charged for testing
related: wallet, test-and-preview, deploy-versions
---
## What it does
Every response belongs to an environment: **TEST** (the test link, **Test Survey**, simulated respondents saved as test data) or **LIVE** (the live link). Test responses are kept separately: they never count toward live quotas, never appear in analysis of live data unless you include them, and never reach a client export of live data.

## Billing
Whether test usage is charged is a setting of your installation — free, discounted, or metered like live — and Help states the current rule from the live configuration. A live response is charged when it is recorded on the live link, as configured; each charge appears in **Usage & Wallet** → **Recent usage**.

## How to check
1. **Data** (top bar) shows test and live responses separately.
2. **Management** → **Usage & Wallet** → **Recent usage** lists each charge with its operation.

## Common mistakes
- Sharing the test link with real respondents — their answers are stored as test data.
- Leaving simulated test respondents in place when you want a clean test dataset — clear them in Research Tools → Tests.
