---
summary: Build a question's options from another question's answers — selected, not selected, displayed or all
related: masking, lists, loops, piping
status: available
---
# Carry forward

Carry-forward builds a question's **answer list from another question's answers**: the brands selected at Q1 become the options of Q2. Only what the respondent chose (or did not choose) is shown.

## When to use it

- Awareness → consideration → usage → preference funnels.
- "Of those, which…" follow-ups — favourites, most-used, would recommend.
- For finer control over which options show (union, difference, conditions), see [Masking](masking) and [Lists](lists).

## Set it up in the builder

::: steps Carry the selected brands forward
1. **Ask the source question first** — a multi-select with the full list (Q1).
2. **Open the target question** (Q2) and go to Properties → **Carry-forward (dynamic options)**.
3. **Choose the source question and the filter** — *selected* (the usual), *not selected*, *displayed*, *answered rows* or *all*.
4. **Choose the destination** — for a single- or multi-select it is the answer list; for a matrix it can be rows or columns.
5. **Keep the target's own options (optional)** — e.g. keep its "None of these" beside the carried ones.
:::

::: example carry-forward

## How it is stored

```json
"carryForward": { "sourceQuestionId": "q_1", "filter": "selected", "into": "options" }
```

`filter` is `selected`, `not_selected`, `displayed`, `answered_rows` or `all`; `into` is `options`, `rows` or `columns`; `keepOwn` keeps the target's own options; `where` filters further.

## What the respondent sees and the data you get

Q2 lists only the brands picked at Q1, with the same codes — so `FAV = 3` means Google in both questions, and the export lines up.

## Common mistakes

- **Carrying from a question that may have one answer only** — the follow-up has a single option. Add display logic (`COUNT(Q1) >= 2`) or a skip.
- **Different codes in source and target** — carry-forward keeps the source's codes; do not renumber one of them.

## Troubleshooting

- *Q2 is empty* — nothing was selected at Q1 on this path; decide what should happen (hide Q2 with display logic, or keep its own options).
- *The destination you want is not offered* — destinations follow the target question's type.
