# One wallet per person, and what each project may spend from it

*Migration 0025 on top of `b727524`. Billing 31 tests (+6 rewritten), access 77, engine 924; new `scripts/billing-central-wallet-sql-test.sql`; guard audit 129/129.*

The wallet model is inverted. A wallet used to belong to a project, so money had to be moved into a study before it could run and a researcher with five studies kept five balances topped up by hand. Now a **person** has one wallet, every project they own draws on it, and what a project may take is a **policy on the project** rather than a pot of money inside it.

## The one line that explains the whole thing

> **A budget is permission against a wallet, not money in a project.**

Setting a project's limit to $1 takes nothing from anywhere. Raising it to $100 transfers nothing either. The balance is identical before and after — the limit only decides how much of the wallet that project is allowed to consume. Every screen that mentions a limit says this, because it is the one genuinely surprising thing about the model.

## Where the wallet is decided: in SQL

`rescript_billing_wallet_for` now resolves a project to its **owner's** wallet, and it does it in the database rather than in the application. Everything that asks "which wallet does this project spend from" has to get the same answer — the Studio charging an AI call, the respondent runtime which has no signed-in user at all, the dashboard, Billing Administration, the transfer screen. The previous shared-wallet feature (`shared_wallet_id`) was followed by exactly one code path and ignored by every other, so two screens could show two different balances for one project. An explicit `shared_wallet_id` still wins where an administrator has set one; nothing needs to set it now.

A project with **no owner** keeps exactly what it had. Ownership only became a column in 0008, and sending those projects to the workspace wallet would silently pool several studies' money the first time the function ran, so they go on funding themselves from their own wallet.

## Where the cap is enforced: in the one gate every charge passes

`rescript_billing_reserve` checks two things under the same row locks, in the same transaction: the wallet's floor, and the project's headroom. A cap enforced anywhere else is a cap two concurrent charges walk straight past. The refusal says **which** test failed — `project_limit` or `insufficient_balance` — because "this study has reached its limit" and "your wallet is empty" ask a person to do completely different things, and being told the wrong one sends them to top up a wallet holding $499.

Settle and record then move the project's own meter: the hold comes off, the spend goes on, and the project freezes itself the moment `spent + reserved ≥ limit`. Raising the limit above what has been spent releases it in the same statement — nobody goes looking for a second switch.

One more correction fell out of the model: `wallet_ledger.survey_id` was taken from the *wallet* row. A central wallet has no project, so every debit would have been attributed to nothing and per-project history would have emptied itself. It now comes from the usage event, which is the project that actually spent.

## The three modes

| mode | means |
|---|---|
| `shared` (default) | spends freely from the owner's wallet; stops only when the wallet does |
| `budget` | may consume at most `budget_limit` from that wallet, ever; at the limit the PROJECT freezes and the rest of the wallet carries on |
| `priority` | shared, and marked as the study the wallet is mainly for |

`priority` grants no privilege of its own, deliberately. With the other projects capped it already has whatever they cannot take; a second mechanism — a reservation only it could spend — would be two ways to express one intention, and they would disagree the first time somebody edited a budget. (This is the brief's §5/§6 arrangement: one priority study, the rest capped at a dollar.)

## What happened to the money already in project wallets

It moved to the owners, once, through the existing `rescript_billing_transfer` — so both wallets have matching ledger lines under one transfer id, the ledger explains where every cent went, and the installation's total is identical before and after. The emptied project wallet is marked `retired_at`: kept, because immutable `wallet_ledger` rows point at it, but never resolved as a funding wallet again. A project's `spent` is seeded from what its old wallet had used, so its history follows it. The sweep is idempotent.

## Transfers

Person to person, by User ID, and that is now the only transfer there is: a project holds no money, so there is nothing inside one to move. A request naming a project is answered with what to do instead — set its limit — rather than with a generic refusal, because the change is recent and the instinct is reasonable.

## Add funds

The platform is in simulation mode, so the honest version of "add funds" is a **request**: a person names an amount, an administrator approves it, and the credits land through the same audited path as every other credit. It is deliberately the shape a payment provider drops into later — the person chooses an amount and something else decides whether the money arrives. Connecting Stripe or Razorpay replaces that step and changes nothing about the wallet, the ledger, or the projects spending from it.

## The screens

- **Projects dashboard** — one wallet strip above the list (balance, used of added, held, Add funds), because there is one of it; repeating a balance on every card is what suggested each project had its own. Each card shows what THAT study has spent, its limit or "no limit", what it may still spend, and a meter. The label says which figure is binding: "Left of it" for a budgeted project, "Wallet left" for a shared one. Filters gained *at its limit*; sorts read "least left to spend".
- **My usage → My wallet** — the person's whole position: available balance, total deposited, total used, transferred out, received, reserved, available to spend; then the projects spending it, with each one's spend, limit, usage and state.
- **A project's Usage & Wallet tab** — the wallet it draws on (retitled: "Project wallet" on a balance five studies share would be the old model's words on the new model's number), and beside it *This project*: what it has spent, its limit, what is left of it, and the owner's control to change it.
- **Billing Administration** — a *Project spending* table answering what each study is costing and what it is allowed to cost, with a limit an administrator can set, clear or make priority. Wallets remain the money view.

New capability **`billing.set_budget`** (owner only, plus platform admins), and a new audit event `billing.project_budget_changed` recording mode, limit, spend and resulting state.

## Two states, not one

A project can stop for two reasons and they never share a word:

```
Limit reached   — this project's own rule; the wallet still has money for others
Wallet empty    — nothing can run; adding funds starts everything again
```

## Tests

| where | what |
|---|---|
| `scripts/billing-central-wallet-sql-test.sql` | the model in the database where it is enforced: two projects resolving to one owner wallet; a $1 project frozen while $499 remains for the others; the priority project spending on; a frozen project refused a cent however full the wallet; raising a limit moving nothing and unfreezing; a hold counting against the cap and returned on release; exhaustion stopping everything and a deposit reactivating; ledger lines still attributed per project; and the sweep — balance moved, wallet retired, totals unchanged, spend history carried, idempotent |
| `packages/billing/src/billing.test.ts` | the same rules through the engine and the arithmetic: three projects on one balance; the brief's priority-plus-$1-caps arrangement with the refusal naming the project; a budgeted project judged on what it may still spend rather than on the wallet; `check()` telling a frozen project from an empty wallet; the wallet overview from the ledger; and no cost field anywhere on a researcher's meter |
| `scripts/project-meter-test.mjs` | the dashboard: one wallet above the list, per-card spend and binding limit, "Limit reached" vs "Wallet empty", the filters, setting and raising a limit with the balance unchanged, Add funds as a request, and a 390px pass |
| `scripts/billing-test.mjs` | Billing Administration's project-spending table, a limit set and cleared, and the wallet page's six figures |

Verified against a real PostgreSQL 16: all 25 migrations replayed from empty, then the three SQL suites (0023, 0024 and this one) run against the result.

## Still to do

**Migration 0025 has not been applied to Supabase.** It is verified locally but it moves money — the sweep empties every project wallet into its owner's — so it should be applied deliberately: Supabase dashboard → SQL editor → paste `supabase/migrations/0025_central_wallet.sql` → Run. It is idempotent and safe to re-run.
