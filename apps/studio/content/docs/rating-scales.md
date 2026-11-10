---
summary: Satisfaction, agreement and likelihood scales — labelled points, NPS 0–10, stars, sliders — and the codes they store
related: single-select, matrix-questions, display-logic
status: available
---
# Rating scales

A rating scale asks the respondent to place an answer **on a scale** — very dissatisfied to very satisfied, 0 to 10, one to five stars. In ResLens.ai a labelled scale is a single-select whose options are the scale points, so every scale stores a clean number.

## When to use it

- Satisfaction (CSAT), agreement (Likert), likelihood, importance, appeal.
- **NPS**: "How likely are you to recommend…" on 0–10 — use the NPS type, which fixes the 0–10 scale.
- Several statements on the same scale: use a [matrix](matrix-questions) instead of repeating the question.

## Set it up in the builder

::: steps Create a 5-point scale
1. **Add the question** — **+ Add question** → **Single Select** → **Radio Button**, and enter the scale points as options (1 Very dissatisfied … 5 Very satisfied). Intelligent Mode does the same from "add a 5-point satisfaction scale".
2. **Or choose a scale type** — **NPS (0–10)** and **Likelihood Scale** (family Single Select), **Star Rating**, **Emoji / Smiley Rating** and **Single Slider** (family Slider / Rating).
3. **Lay it out horizontally (optional)** — set the option **Layout** to several columns so the points sit in a row.
4. **Keep the direction consistent** — low to high (or high to low) across the whole survey.
:::

::: example rating-scales

## How it is stored

A labelled 5-point scale is a single-select with codes 1–5; NPS is its own type with the fixed 0–10 range:

```json
{ "code": "Q1", "variableName": "SAT", "type": "single_select",
  "options": [ { "code": 1, "label": "Very dissatisfied" }, { "code": 2, "label": "2" }, { "code": 3, "label": "3" },
               { "code": 4, "label": "4" }, { "code": 5, "label": "Very satisfied" } ] }
{ "code": "Q2", "variableName": "NPS", "type": "nps", "variant": "single_select.nps" }
```

In logic: `Q1 >= 4` (top-two box), `Q2 <= 6` (detractors).

## What the respondent sees and the data you get

A row or column of points (or stars, smileys, a slider). The export is one numeric column per question; top-box, mean and NPS analyses read it directly.

## Common mistakes

- **Mixing directions** — 1 = best on one question and 1 = worst on the next confuses respondents and analysts.
- **A "Don't know" coded inside the scale** — give it a code outside the range (98) so it never enters a mean.

## Troubleshooting

- *The NPS question will not take 11 points* — NPS is fixed at 0–10; use a single-select or slider for other ranges.
