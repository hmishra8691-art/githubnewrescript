---
summary: Brand research — the brand funnel (unaided and aided awareness, consideration, purchase, preference) and the related brand equity, tracking and lift studies
related: study-methodologies, carry-forward, concept-testing
status: available
---
# Brand research

ResLens.ai's brand methodologies build on the **brand funnel**: unaided awareness (open, coded by AI classification), aided awareness, consideration, purchase and preference — each stage carried forward from the one before. **Brand equity**, **brand tracking** (waves) and **brand lift** (exposed vs control) add to it; all are in the [catalogue](study-methodologies).

## When and why to use it

- Where a brand loses people: awareness, consideration or conversion.
- Comparing brands on the same funnel, wave on wave.

## Configure the design

::: steps Add a brand funnel
1. **Study design** → **Brand funnel**, or "add a brand funnel for coffee with Alpha, Beta, Gamma and Delta" (`add_method_template brand_funnel`).
2. **The category and brands** — 2–15 brands.
3. **Tracking or lift (optional)** — the tracking methodology adds a WAVE field from the link; lift adds an EXPOSED field and recall questions.
:::

::: example brand-research

## The programmed block

`UNAIDED` (open) with `UNAIDED_CODED` (an AI classification over the brand list, resolved at runtime), `AWARE` (multi), then `CONSIDER`, `PURCHASED` and `PREFER`, each carrying forward the brands from the stage before. The analysis plan gets a brand funnel item and the frequencies of the coded first mention.

## What the respondent does

Names a brand unprompted, then ticks known brands; later stages offer only the brands from the stage before.

## Output and analysis

The brand analysis shows the funnel per brand — awareness → consideration → purchase → preference — and the conversion between stages; tracking adds wave-on-wave significance.

## Common mistakes

- **Showing the brand list before the unaided question** — it primes the answer; keep unaided first.

## Troubleshooting

- *UNAIDED_CODED is empty in testing* — the coding needs the AI service at runtime.
