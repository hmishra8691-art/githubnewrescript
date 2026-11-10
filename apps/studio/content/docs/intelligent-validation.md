---
summary: How Intelligent Mode checks every change — refusals with reasons and fixes, forward-reference checks, no-op detection and the action gate
related: intelligent-review, intelligent-troubleshooting, actions
status: available
---
# Validation and error correction

Every proposal is **applied to a copy and checked** before you see it. A change that would break the survey is refused with the reason and, where one is obvious, the fix — so a wrong sentence never becomes a broken survey.

## What is checked

- References: the questions, options and blocks named must exist (with a "did you mean" for near misses).
- Order: logic may only read answers given earlier; skips only move forward.
- Fit: an operator the question cannot answer (`contains` on a number), a validation rule the type does not support, contradictory rules.
- No-ops: asking for what is already true ("Q4 is already optional").
- What a batch breaks elsewhere: logic that reads a removed option, a planned analysis on a deleted question.

## Set it up in the builder

::: steps Read a refusal and fix it
1. **Read the reason** on the card — it names the object and the problem.
2. **Follow the suggestion** — "move Q4 before Q1, or put the condition on Q4 instead".
3. **Rephrase and send again** — or make the change in the builder.
:::

::: example im-validation

## What the respondent sees

Nothing changes — refused proposals are never applied. The live survey in the example is the starting survey.

## Common mistakes

- **Fighting the order rule** — if a condition needs a later answer, move the question, or use a skip from the later question.

## Troubleshooting

- *"Skips only move forward"* — to ask an earlier question again, use a [loop](loops); to route around it, skip forward.
