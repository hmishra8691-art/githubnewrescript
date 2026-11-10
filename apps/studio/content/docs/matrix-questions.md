---
summary: Several statements rated on the same scale — single- and multi-select matrices, Likert, semantic differential
related: grid-questions, rating-scales, question-validation, masking
status: available
---
# Matrix questions

A matrix asks **several statements (rows) on the same answer scale (columns)** in one compact table — agreement with five statements, satisfaction with four aspects of a service.

## When to use it

- A battery of attitude or satisfaction items that share one scale.
- **Single-Select Matrix** — one answer per row (Likert). **Multi-Select Matrix** — several answers per row ("which of these describe each brand?").
- Keep it short — about 8 rows at most per screen. On phones, the matrix is shown row by row.

## Set it up in the builder

::: steps Create a single-select matrix
1. **Add the question** — **+ Add question** → family **Grid / Matrix**, type **Single-Select Matrix** (or **Likert Matrix**, **Semantic Differential**, **Multi-Select Matrix**).
2. **Add the rows** — the statements, each with a row code (r1, r2…).
3. **Add the scale** — the columns are the answer options with their codes (1 Strongly disagree … 5 Strongly agree).
4. **Randomize the rows (optional)** — Properties → **Randomization**, scope rows.
5. **Require every row** — Required on the question means every visible row must be answered.
:::

::: example matrix-questions

## How it is stored

`type: "matrix_single"`; the rows are `rows[]`, the scale is `options[]`. The answer is one code per row:

```json
{ "code": "Q1", "variableName": "ATT", "type": "matrix_single", "variant": "matrix.single",
  "rows": [ { "code": "r1", "label": "The app is easy to use" }, { "code": "r2", "label": "The app is good value" } ],
  "options": [ { "code": 1, "label": "Strongly disagree" }, { "code": 5, "label": "Strongly agree" } ] }
```

Answer: `{ "r1": 4, "r2": 2 }`. In logic a row is `Q1.r1`:

```logic
Q1.r1 >= 4
COUNT(Q1, matching, rows, answering [4, 5]) >= 2     -- two or more rows in the top-two box
```

## What the respondent sees and the data you get

A table with a radio button per cell (or cards row by row on a small screen). Missing rows are named when Next is pressed. The export has one column per row: `ATT_r1`, `ATT_r2`, … (a multi-select matrix adds `ATT_r1_<code>` per option).

## Common mistakes

- **Long matrices** cause straight-lining (the same column for every row); split them or randomize the rows.
- **Mixed scales in one matrix** — if rows need different answers, use a [grid](grid-questions) with typed columns.

## Troubleshooting

- *Only some rows are shown* — row masking or row logic is on (Properties → **Row masking**).
