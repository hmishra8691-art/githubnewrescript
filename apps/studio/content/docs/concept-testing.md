---
summary: Product and concept testing — sequential monadic (every respondent rates every concept, in a balanced order), monadic cells and side-by-side preference
related: custom-experimental-designs, kano-model, question-randomization, study-methodologies
status: available
---
# Product and concept testing

ResLens.ai builds the three classic concept tests:

| Test | How it works | Sample |
|---|---|---|
| **Sequential monadic** | every respondent sees every concept, one at a time, in a Williams order | ≈ 150+ completes |
| **Monadic** | each respondent sees one concept (one cell per concept) | ≈ 150 per cell |
| **Comparative / preference** | the concepts side by side; which is preferred and why | 200+ |

## When and why to use it

- Choosing between ideas, designs, packaging, flavours or messages.
- **Sequential monadic** for a within-person comparison with a smaller sample; **monadic** for a clean read with no contrast effects.

## Configure the design

::: steps Add a sequential monadic test
1. **Study design** → **Sequential monadic concept test**, or "add a sequential monadic test of Fresh, Bold and Calm" (`add_method_template sequential_monadic`).
2. **The concepts** — 2–8 names (add the concept text or image to each block afterwards).
3. **The KPIs** — appeal and purchase intent (5-point) per concept, already added.
4. **The order** — a Williams randomizer over one block per concept; the order shown is recorded.
:::

::: example concept-testing

## The programmed block

A randomizer (order Williams) of one block per concept; each block shows the concept and asks `C<n>_APPEAL` and `C<n>_INTENT`. The order each respondent saw is stored in `ORDER_<randomizer>`, and the analysis plan gets a sequential monadic item.

## What the respondent does

Reads each concept on its own page and rates it, in their own balanced order.

## Output and analysis

Means and top-2 box per concept, paired comparisons within respondent (paired t or Friedman, with Holm correction), and the **order effect**: how ratings change when a concept is seen first — read from the recorded order.

## Common mistakes

- **More than about 5 concepts in sequence** — fatigue; split or use a monadic design.

## Troubleshooting

- *The concept text is missing* — the template adds a placeholder; put the real concept in each block's first item.
