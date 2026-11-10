---
summary: Composite grids where each column is its own field — numbers, text or dropdowns per row — and constant-sum grids
related: matrix-questions, numeric-entry, question-validation
status: available
---
# Grid questions

A grid (composite matrix) has **rows of items and columns that are fields of their own type** — an amount and a number of visits for each category, a dropdown and a comment per product. Where a [matrix](matrix-questions) asks one scale per row, a grid asks several different things per row.

## When to use it

- Several numeric facts per item: spend and frequency per category, hours per activity.
- Mixed inputs per row: a dropdown plus a text field.
- Allocations across rows and columns: **Constant-Sum Matrix** (each row or column adds to a total).

## Set it up in the builder

::: steps Create a numeric grid
1. **Add the question** — **+ Add question** → family **Grid / Matrix**, type **Numeric Matrix**, **Text Matrix**, **Dropdown Matrix**, **Mixed-Type Matrix (Composite)** or **Constant-Sum Matrix**.
2. **Add the rows** — the items (Groceries, Eating out, Transport).
3. **Add the columns** — each column has a label, a response type (numeric, text, dropdown…) and a variable stem used for its export columns.
4. **Add totals or checks (optional)** — row totals and column totals (`column_sum_equals`, `column_sum_max`, `column_sum_min`) are validation rules.
:::

::: example grid-questions

## How it is stored

`type: "composite"`; each column carries its own `responseType` and `variableStem`. The answer is a value per row and column:

```json
{ "code": "Q1", "variableName": "SPEND", "type": "composite", "variant": "matrix.numeric",
  "rows": [ { "code": "r1", "label": "Groceries" }, { "code": "r2", "label": "Eating out" } ],
  "columns": [ { "id": "c1", "label": "Amount ($)", "responseType": "numeric", "variableStem": "SPEND_AMT" },
               { "id": "c2", "label": "Visits", "responseType": "numeric", "variableStem": "SPEND_VISITS" } ] }
```

Answer: `{ "r1": { "c1": 120, "c2": 4 } }`. In logic a cell is `Q1.r1.c1`.

## What the respondent sees and the data you get

A table of input boxes. The export has one column per row and column: `SPEND_AMT_r1`, `SPEND_VISITS_r1`, …

## Common mistakes

- **Using a grid for a simple rating battery** — a single-select matrix is quicker to answer and analyse.
- **Unclear units** — put the unit in the column label ("Amount ($)").

## Troubleshooting

- *A total refuses the answer* — a row or column sum rule is set; the message names the total expected.
