---
summary: The Kano model — functional and dysfunctional questions per feature, classified into must-be, one-dimensional, attractive and indifferent, with Better / Worse coefficients
related: concept-testing, maxdiff, matrix-questions, study-methodologies
status: available
---
# Kano model

**What it is.** For each feature the respondent answers two questions — how they would feel if the product **had** it (functional) and if it did **not** (dysfunctional) — on five standard answers (I like it · I expect it · I am neutral · I can live with it · I dislike it). The pair classifies the feature for that respondent: **must-be** (expected), **one-dimensional** (more is better), **attractive** (a delighter), **indifferent**, reverse or questionable.

## When and why to use it

- Prioritising a roadmap: what must be there, what pays back in proportion, what delights.
- It classifies; it does not trade features against price (pair it with [conjoint](choice-based-conjoint)).

## Configure the design

::: steps Add a Kano block
1. **Study design** → **Kano model (feature classification)**, or "add a Kano study of offline mode, dark theme and live chat" (`add_method_template kano`).
2. **The features** — 2–20.
3. **Importance (optional)** — a third grid asks how important each feature is.
:::

::: example kano-model

## The programmed block

`KANO_FUNC` and `KANO_DYSF` — two grids with the same feature rows (f1…fn) and the five answers — and optionally `KANO_IMP`. The analysis plan gets a Kano item.

## What the respondent does

Answers the "if it had" grid, then the "if it did not have" grid.

## Output and analysis

Per feature: the share in each category, the category (the most frequent; ties broken must-be > one-dimensional > attractive > indifferent), the **category strength** (the gap to the next category), and Timko's **Better** = (A + O) / (A + O + M + I) and **Worse** = −(O + M) / (A + O + M + I). Read Better as the satisfaction gained by having the feature and Worse as the dissatisfaction caused by its absence.

## Common mistakes

- **Editing one grid's rows and not the other's** — the analysis pairs them by row code.

## Troubleshooting

- *Many "questionable" answers* — the wording of the two questions is confusing respondents.
