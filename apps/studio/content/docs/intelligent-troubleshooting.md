---
summary: When Intelligent Mode asks back, hands a request to the language model, declines it, or the AI service is busy — and what to do
related: intelligent-mode-guide, intelligent-validation, intelligent-mode
status: available
---
# Troubleshooting Intelligent Mode

Every turn ends one of five ways: **proposed** (actions to approve), **refused** (with the reason), **asked back** (a choice), **answered** (a question about the survey), or **handed to the language model** (something to write). The card always says which.

## When something does not go as expected

| What you see | Why | What to do |
|---|---|---|
| Asked back with choices | the request named nothing to act on | pick a choice, or say more |
| Handed to the language model | wording to write, or a phrasing the engine does not read | let the model draft (cost shown first), or rephrase with codes |
| Refused, with a reason | a missing object, a forward reference, a no-op | follow the fix on the card |
| Declined as outside Intelligent Mode | not a research or survey task | Intelligent Mode is for planning, programming, analysis, quality, translation and reporting |
| "Temporarily waiting for AI capacity" | the AI service is busy | it resumes by itself; your work is saved |
| Refused in internal mode | the project sends nothing to a model | switch the project to cloud in the Workflow tab, or let one request through |

## Set it up in the builder

::: steps Recover from a stuck turn
1. **Read the card's last line** — it names the cause.
2. **Rephrase with codes** — "show Q3 only if Q2 = 1" reads where "show the why question for unhappy people" may not.
3. **Check the model settings** — no model configured, or an empty wallet, refuses model turns with that reason.
4. **Resume** — interrupted generations offer **Resume**, **Review what's ready** and **Discard**.
:::

::: example im-troubleshooting

## Common mistakes

- **Long multi-part sentences** — split them, or use **Plan first** so each item is built and approved separately.

## Troubleshooting

- *Nothing happens after Enter* — the box needs a sentence of a few words; a bare "help" is answered with a question.
- *A charge for a failed call* — failed and paused calls are released, not charged.
