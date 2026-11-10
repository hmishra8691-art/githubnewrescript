---
summary: Checks on a single answer — length, range, formats, number of selections, totals — and how their messages appear
related: validation-rules, mandatory-optional, numeric-entry, text-entry
status: available
---
# Question validation

Validation rules check an answer **before the respondent can move on**: a number in range, an email that looks like an email, exactly two options picked, a total of 100.

## When to use it

- Ranges on numbers (`min value`, `max value`, `integer`).
- Formats on text (`email`, `phone`, `zip`, `url`, `us_state`, `date_format`, `number_only`, `text_only`, `pattern`).
- Lengths (`min length`, `max length`, `length range`).
- Selections (`min selections`, `max selections`) and totals (`sum equals / max / min`, column totals on grids).
- For checks **across questions** (children ≤ household size), see [Validation rules](validation-rules).

## Set it up in the builder

::: steps Add a validation rule
1. **Open the question** and go to Properties → **Validation rules**.
2. **Add a rule** — choose the kind; only the kinds that make sense for the question type are offered.
3. **Enter the value** — e.g. 2 for minimum selections.
4. **Write the message (optional)** — what the respondent reads when the rule fails. Without one a clear default is shown.
5. **Choose blocking or warning** — a **warning** shows the message but lets the respondent continue.
:::

::: example question-validation

## How it is stored

`validation[]` on the question; each rule has a `kind`, a `value`, an optional `message` and an optional `severity`:

```json
"validation": [
  { "kind": "min_selections", "value": 2 },
  { "kind": "max_selections", "value": 2, "message": "Please pick exactly two." }
]
```

A rule can apply only in some cases with `when` — e.g. a minimum of 2 selections only when `Q4 = 1`.

## What the respondent sees

The message appears under the question when Next is pressed, and the respondent stays on the page until the answer passes (unless the rule is a warning).

## Common mistakes

- **Contradictory rules** (a minimum above the maximum) — the engine refuses them when they are saved.
- **Validation on an optional question** — rules still apply to what is typed; an empty optional answer passes.

## Troubleshooting

- *The message does not appear* — the rule has a `when` condition that does not hold for this respondent; check it in Validation rules.
