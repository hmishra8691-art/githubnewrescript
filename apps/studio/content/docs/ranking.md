---
summary: Put a list in order — drag and drop, click to rank, top-N, buckets or a tournament — stored as a rank per item
related: multi-select, answer-randomization, question-validation
status: available
---
# Ranking

A ranking question asks the respondent to **put items in order of preference or importance**. Each item gets a rank: 1 for the first, 2 for the next, and so on.

## When to use it

- A short list (about 4–8 items) where the order matters — features, messages, priorities.
- For longer lists, or when you need ratio-scaled importance, a MaxDiff design discriminates better (see [Research design generators](research-engine)).

## Set it up in the builder

::: steps Create a ranking question
1. **Add the question** — **+ Add question** → family **Ranking**. **Drag-and-Drop Ranking** is the common choice; **Click-to-Rank**, **Bucket Ranking**, **Pairwise / Tournament Ranking** and **Image Ranking** are alternatives.
2. **Add the items** — they are the options, each with a code.
3. **Rank only the top N (optional)** — with Click-to-Rank, set a maximum number of selections in Validation rules so respondents rank only their top three, for example.
4. **Randomize the starting order** — Properties → **Randomization**, so the first item is not favoured by position.
:::

::: example ranking

## How it is stored

`type: "ranking"`; the answer is the list of codes **in rank order** — `[3, 1, 5, 2, 4]` means Price first, Battery life second…

```json
{ "code": "Q1", "variableName": "RANKF", "type": "ranking", "variant": "ranking.drag",
  "options": [ { "code": 1, "label": "Battery life" }, { "code": 2, "label": "Camera" }, { "code": 3, "label": "Price" } ] }
```

In logic: `Q1 ranked first 3` (Price was ranked first), `ranked top 2`, `not ranked`.

## What the respondent sees and the data you get

Cards that can be dragged (or clicked, or moved with the keyboard) into order. The export has one column per item holding its rank — `RANKF_1 = 2` means Battery life was ranked second.

## Common mistakes

- **Long lists.** Ranking 15 items is hard and the middle ranks are noise; use MaxDiff or rank only the top few.
- **Reading ranks as distances.** Rank 1 vs 2 is not the same gap as 4 vs 5; analyse ranks as ordinal data.

## Troubleshooting

- *The question cannot be submitted* — a minimum number of ranked items is set and not met.
