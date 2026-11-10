---
summary: Limit how many respondents of each kind complete — cells, limits, hard and soft quotas, where they are checked and what happens when full
related: survey-termination, embedded-variables, conditional-logic
status: available
---
# Quotas

A quota **caps how many respondents of a kind can complete**: 200 women and 200 men, 100 per region. When a cell is full, the next respondent in it is stopped (or flagged) where the quota is checked.

## When to use it

- Matching a sample to a population (gender, age, region).
- Capping expensive or over-represented groups.
- **Hard** quotas stop respondents; **soft** quotas only flag them.

## Set it up in the builder

::: steps Create a gender quota
1. **Open Programming → Quotas** and add a quota named Gender.
2. **Add the cells** — Women when `Q1 = 1`, limit 200; Men when `Q1 = 2`, limit 200. A limit can also be a percent of a total target.
3. **Choose hard or soft**, and what happens when full — terminate (quota full), redirect, flag or warn.
4. **Place the quota check** — a **Quota check** element in the Survey Flow right after the question it reads (Intelligent Mode: "check the gender quota after Q1").
5. **Watch the fills** — the Quotas tab shows fills against limits and their history.
:::

::: example quotas

## How it is stored

```json
"quotas": [ { "name": "Gender", "mode": "hard",
  "cells": [ { "label": "Women", "when": { "…": "Q1 = 1" }, "limit": 200 }, { "label": "Men", "when": { "…": "Q1 = 2" }, "limit": 200 } ],
  "countStatus": ["complete"] } ]
```

A `quota_check` flow node applies it: `{ "type": "quota_check", "quotaIds": ["…"], "onFull": { "kind": "terminate" } }`. In any condition `quota.<id>` is the current count.

## What the respondent sees

Nothing while their cell is open. When it is full, they reach the quota-full end screen (or the redirect) at the quota check.

## Common mistakes

- **No quota check in the flow** — a quota with no check never stops anyone.
- **Checking too late** — put the check right after the screener, so full-cell respondents are not asked the whole survey first.
- **Counting in-progress responses** — by default only completes count; in-progress counting reserves places for people who may drop out.

## Troubleshooting

- *Test responses fill the quota* — they don't: test responses are counted apart from live ones.
