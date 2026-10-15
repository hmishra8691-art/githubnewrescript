# BYOK 6 — Billing and usage

## Rules

| Source | Wallet | Recorded as | Customer charge |
|---|---|---|---|
| Platform AI | reserve → run → settle (unchanged) | `AI_REQUEST` (+ token rows) / translation / speech rows | priced from the rate registry |
| **Own provider** | **never touched**; no balance check, no read-only/suspended gate | `AI_REQUEST_BYOK` | **0** |
| Platform as the person's allowed last resort | a hold is reserved up front; unfunded → the backstop is not offered for that call | platform rows, `source: platform_fallback` | priced as platform |
| Platform fees (storage, responses, exports) | unchanged | unchanged | unchanged |

An empty wallet therefore stops platform AI and platform fees, and does **not** stop a person spending their own provider's money.

## What an own-provider row carries

User id, provider id (registry id, never a key), model, tokens in/out (chat), characters (translation), minutes (speech), whether a listed fallback served it, and the surface. Customer charge 0, platform cost 0. The primary and each fallback are separate rows under the provider that served them.

## The usage view

`GET /api/account/ai/usage` (Settings → Usage & cost) reads the usage events the metering door already writes — no second ledger. Two tables, never added together:

- **On my own provider · not billed here** — per feature/provider/model: calls, volume, calls via fallback. No money: the Studio does not charge for it and does not know the provider's price, and says so.
- **On the platform's AI · charged to my wallet** — per kind (AI model, translation, speech): calls and the customer charge, plus a total; the same amounts My usage shows. Provider cost, fees and margin are never read. Reversals and rows outside the window are excluded.

## Cost previews

Previews show 0 for own-provider calls ("your provider bills this directly").

## Operator notes

- Own-provider use never needs a rate row. DeepL/Microsoft rate rows exist but stay `active: false` for the platform's own use.
- Usage without migration 0023 (metering): the usage section says it is not enabled; the rest works.
- The cache identifies a translation by its provider id, so a platform Google result and a user's Google result are the same cache entry; DeepL, Azure, `llm`, `llm-own` are separate.
