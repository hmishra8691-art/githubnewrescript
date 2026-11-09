---
id: wallet
title: How the usage wallet works
category: billing
keywords: wallet, credits, usage, billing, charges, deduct, balance, add funds, spending limit, low balance, read only, ai charges, translation charges, response charges, usage history, transfer credits
related: billing-test-vs-live, troubleshoot-unexpected-charges
---
## What it does
ResLens.ai charges for what is used, from a wallet: AI requests, translation, responses, storage, exports, voice and similar activity. Each project spends from its wallet; every charge is recorded with the operation, the amount and the balance after. The exact rules on your installation — what is billable, how test usage is treated, the balance thresholds — are listed in the live billing facts Help shows with billing answers. Help never quotes prices: the actual charge for each operation is shown on Usage & Wallet when it happens.

## How to set it up
In a project:
1. Open **Management** → **Usage & Wallet**.
2. **Wallet** shows the balance, **Usage by category** and **Usage over time** show where it went, and **Recent usage** lists each charge with the **Balance after**.
3. Set a **Spending limit** to cap what the project may spend.
4. Running low? **Request additional credits** sends a request to your administrator.

For your account:
1. Open the account menu → **My usage**.
2. **My wallet** shows what you have, **Projects spending it** what each project spent, and **Add funds** tops up. **Transfer credits** sends credits to another user by their User ID.

## How charges happen
Before a metered operation runs (an AI request, a translation), its likely cost is reserved; when it finishes, the actual amount is charged and the rest released. If the wallet cannot cover it, the operation is refused rather than run (unless your installation allows an overdraft). At the read-only threshold a project stops spending and, depending on configuration, stops taking new live interviews.

## Common mistakes
- Expecting test responses to cost the same as live ones — see “Test vs live responses and billing”.
- Using your own AI provider and expecting AI charges: work on your own connected provider is recorded, not charged by the platform.
