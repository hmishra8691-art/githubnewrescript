---
summary: Custom validation with conditions across questions — compare answers, enforce totals, block or warn — plus script checks
related: question-validation, conditional-logic, numeric-entry
status: available
---
# Validation rules

Beyond the built-in checks of a single answer ([Question validation](question-validation)), a **condition rule** can test *anything the condition language can express* — compare two answers, check a count, combine several questions — and block or warn with your own message.

## When to use it

- Consistency: children ≤ household size, years at employer ≤ age − 14.
- Combined checks: "if you own a car, the fuel question cannot be 'No car'".
- Soft checks (**warning**): unusual but possible answers, such as more than 20 hours of TV a day.

## Set it up in the builder

::: steps Check that children do not exceed household size
1. **Open the second question** (Q2) → Properties → **Validation rules**.
2. **Add a Condition rule** — write what a **valid** answer must satisfy: `Q2 <= Q1`.
3. **Write the message** — pipes work: "That is more people than live in your household ({{Q1}})."
4. **Block or warn** — leave it blocking, or choose **warning** to let the respondent continue.
5. **Gate it (optional)** — a rule can apply only `when` another condition holds.
:::

::: example validation-rules

## How it is stored

You write the valid case; the engine stores the **invalid** case as `check`, and prints it back:

```json
{ "kind": "condition", "check": { "type": "group", "op": "not", "children": [ { "…": "Q2 <= Q1" } ] },
  "message": "That is more people than live in your household ({{Q1}})." }
```

Other advanced kinds: `custom_expression` (a calculation that must be true, e.g. `Q1 + Q2 + Q3 = 100`) and `custom_script` (a Scripts-panel script that calls `error(message)`), plus `date_min` / `date_max` and grid column totals.

## What the respondent sees

The message under the question when Next is pressed, with the piped value. A warning shows the message but lets the respondent continue.

## Common mistakes

- **Writing the invalid case** — write what a correct answer looks like (`Q2 <= Q1`), not the error case.
- **Putting the rule on the first question** — a rule that reads Q2 belongs on Q2 (or later), when both answers exist.

## Troubleshooting

- *The rule always fails* — check the comparison direction, and that both questions are numeric.
