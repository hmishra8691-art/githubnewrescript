---
id: maxdiff
title: MaxDiff (best–worst scaling)
category: designs
keywords: maxdiff, max diff, best worst, best-worst scaling, maximum difference, rank items, importance of items, prioritise features, claims test
related: conjoint, choose-a-method, methodologies
---
## What it is
MaxDiff shows a few items at a time and asks which is most and least important (or appealing). From many such choices it produces a ratio-scaled score for every item — far more discriminating than rating scales.

## When to use it
To prioritise a list: features, claims, messages, benefits, pain points (typically 10–30 items). For trade-offs between attributes and price, use conjoint.

## How to set it up
1. Open **Research Tools** → **Design Generators**.
2. Choose MaxDiff, enter the items, and set items per task (usually 4–5) and tasks per respondent (so each item is seen about three times). Add a **+ prohibited pair** for items that must not appear together.
3. Click **Generate Design File** and review its balance.
4. Add the MaxDiff tasks to the survey; test with **Test Survey**.

## Interpreting the data
Data Analytics estimates scores per respondent (hierarchical Bayes) or for the sample, with best–worst counts as a check; the long export has one row per respondent × task × item shown.

## Common mistakes
- Items of very different kinds in one list (features mixed with prices).
- Too few tasks: each item should appear at least three times per respondent.
