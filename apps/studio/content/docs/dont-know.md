---
summary: Two ways to offer “Don't know” — an exclusive answer code on choice questions, and a stored-beside choice on text and numeric questions
related: exclusive-options, none-of-the-above, numeric-entry, text-entry
status: available
---
# Don't know options

Respondents should not have to guess. ResLens.ai offers "Don't know" in two ways, depending on the question type.

## When to use it

- **On a choice question** — add "Don't know" as an option with a code outside the scale (98 is common).
- **On a numeric or text question** — turn on **Enable “I don't know” option**: a checkbox beside the box that is stored *beside* the answer, so the numeric column never contains a fake value.

## Set it up in the builder

::: steps Offer "Don't know"
1. **On a single- or multi-select** — add the option "Don't know" with code 98. On a multi-select make it **exclusive** and **anchor bottom** (ResLens.ai sets both when the option is created with that label).
2. **On a numeric or text question** — open the question and tick **Enable “I don't know” option** under the response field. Change its wording with the label setting if you need to.
3. **Keep it out of means** — on a rating scale, code "Don't know" outside the scale range (98), never as a scale point.
:::

::: example dont-know

## How it is stored

On Q1, "Don't know" is the option code 98. On Q2 the setting is `settings.dontKnow: true`:

```json
{ "code": "Q2", "variableName": "PAID", "type": "numeric", "settings": { "dontKnow": true } }
```

When the respondent ticks it, the answer stays empty and the choice is stored beside it (`<question id>__dk`). Typing a number clears the choice; ticking the choice clears the number.

## What the respondent sees and the data you get

Q1 shows "Don't know" as one more answer. Q2 shows an **I don't know** checkbox under the number box.

Export: `AWARE = 98` for Q1. For Q2, `PAID` stays purely numeric and a separate column `PAID_DK` holds 1 (don't know), 0 (answered) or blank (not asked or unanswered) — with value labels in SPSS, Stata and SAS. "Required" is satisfied by either a number or the choice.

## Common mistakes

- **Typing 999 or "DK" as an answer** — it pollutes the data. Use the setting.
- **A "Don't know" scale point in the middle of a scale** — it becomes a fake midpoint in the mean.

## Troubleshooting

- *A minimum value message appears although "I don't know" is ticked* — minimum, maximum and integer rules apply to a typed number only; make sure the box is empty.
