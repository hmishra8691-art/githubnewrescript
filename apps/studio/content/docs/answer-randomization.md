---
summary: Shuffle or rotate the options, rows or columns of a question, keep anchored answers in place, or show N at random
related: question-randomization, none-of-the-above, exclusive-options, single-select
status: available
---
# Answer randomization

Answer randomization changes **the order of a question's options** (or a matrix's rows or columns) per respondent, to remove the advantage of the top of the list.

## When to use it

- Brand lists, attribute lists, message lists — any unordered list where position could bias choice.
- Not for ordered lists: scales, age bands and frequency lists must keep their order.

## Set it up in the builder

::: steps Randomize the options
1. **Open the question** and go to Properties → **Randomization**.
2. **Turn it on and choose the method** — **shuffle** (random each time), **rotate** (each option in each position equally often) or **reverse half** (half the respondents see the list reversed).
3. **Choose the scope** — options, rows or columns (for matrices).
4. **Anchor what must stay put** — "Other", "None of these" and "Don't know" should be **anchored** (option properties… → anchor top / anchor bottom).
5. **Show only some (optional)** — **pick** shows N options of the list.
6. **Randomize within groups (optional)** — groups are shuffled inside, and the groups keep their order.
:::

::: example answer-randomization

## How it is stored

```json
"randomization": { "enabled": true, "scope": "options", "method": "shuffle" }
```

More: `groups` (randomize within groups), `pick` (show N), `rules` (choose a method by condition — first match wins). Options flagged `anchor_top` / `anchor_bottom` never move.

## What the respondent sees and the data you get

The options in a different order for each respondent. Codes do not change with position, so the data is identical whatever order was shown.

## Common mistakes

- **Randomizing a scale** — "Very satisfied" in the middle is confusing; never randomize ordered lists.
- **Forgetting to anchor "None of these" or "Other".**

## Troubleshooting

- *An option never moves* — it is anchored.
- *The order looks the same twice* — shuffling is random; with few options a repeat is likely. Use **rotate** for a guaranteed balance.
