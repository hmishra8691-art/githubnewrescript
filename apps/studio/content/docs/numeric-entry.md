---
summary: Numbers typed by the respondent — counts, ages, amounts, percentages — with ranges and whole-number checks
related: text-entry, question-validation, validation-rules, dont-know
status: available
---
# Numeric entry

A numeric question takes a **number** typed by the respondent — an age, a count, an amount of money, a percentage. The column it exports is numeric, so it can be averaged, banded and used in arithmetic and logic.

## When to use it

- Exact quantities: household size, age, money spent, hours per week.
- Anything you will compare (`Q1 >= 18`), compute with (`Q1 + Q2`) or band later.
- Subtypes: **Numeric Open End**, **Integer**, **Currency**, **Percentage**, **Quantity**, **Duration**, **Numeric Range**.

## Set it up in the builder

::: steps Create a numeric question with a range
1. **Add the question** — **+ Add question** → family **Numeric**, type **Numeric Open End** (or **Integer** for whole numbers only).
2. **Set the range** — Properties → **Validation rules** → add **min value** and **max value**. Write a message for the respondent if the default is not clear enough.
3. **Show a currency symbol (optional)** — the **Currency** subtype puts the symbol beside the box.
4. **Allow "I don't know" (optional)** — tick **Enable “I don't know” option**; the choice is stored beside the answer, never as a sentinel number like 999.
:::

::: example numeric-entry

## How it is stored

```json
{ "code": "Q1", "variableName": "HHSIZE", "type": "numeric", "variant": "numeric.integer",
  "validation": [ { "kind": "integer" }, { "kind": "min_value", "value": 1 },
                  { "kind": "max_value", "value": 20, "message": "Please enter a number from 1 to 20." } ] }
```

In logic and calculations the answer is a number:

```logic
Q1 >= 18
Q1 between 25 and 34
Q1 + Q2 > 100
```

## What the respondent sees and the data you get

A number box. When Next is pressed, a value that is not a number, or is outside the range, shows its message under the question. The export has one numeric column, `HHSIZE`.

## Common mistakes

- **Using 999 for "don't know".** It ends up in every mean. Turn on the **I don't know** option instead — it exports as its own `HHSIZE_DK` column.
- **No upper bound.** A typo of 2000 instead of 20 skews averages; set a plausible maximum.
- **Cross-question checks on one question** — "children cannot exceed household size" needs a [validation rule across questions](validation-rules).

## Troubleshooting

- *A decimal is refused* — the question is Integer (or has the `integer` rule).
- *The range message never appears* — the rule may be a **warning** (severity warning lets the respondent continue).
