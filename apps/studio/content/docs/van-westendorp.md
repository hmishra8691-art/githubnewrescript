---
summary: Van Westendorp price sensitivity meter, with the Newton–Miller–Smith extension — four price questions, the acceptable price range, the optimal price and trial / revenue optima
related: gabor-granger, study-methodologies, choice-based-conjoint
status: available
---
# Price sensitivity (Van Westendorp)

**What it is.** Four open price questions — at what price is the product *too cheap* (doubt the quality), *a bargain*, *getting expensive*, *too expensive* — answered by each respondent. Cumulating the answers gives four curves whose crossings define the **acceptable price range** and an **optimal price point**. The **Newton–Miller–Smith (NMS)** extension adds purchase likelihood at the respondent's own "bargain" and "expensive" prices, giving trial and revenue optima.

## When and why to use it

- New products without an established market price.
- Early pricing: the range respondents find credible.
- It does not tell you about competitors or features — use [conjoint](choice-based-conjoint) for that.

## Configure the design

::: steps Add a Van Westendorp block
1. **Research Tools → Study design**, objective "how much would customers pay for …" → **Van Westendorp Price Sensitivity Meter**; or say "add a Van Westendorp price block for the Aurora kettle" in Intelligent Mode (`add_method_template pricing_psm`).
2. **Product and currency** — used in the question texts.
3. **NMS on or off** — on adds the two likelihood questions that pipe the respondent's own prices.
4. **Curve definition** — proxy (default) or textbook end points.
:::

::: example van-westendorp

## The programmed block

`PSM_TOO_CHEAP`, `PSM_CHEAP`, `PSM_EXPENSIVE`, `PSM_TOO_EXPENSIVE` (numeric, with the currency) and, with NMS, `NMS_CHEAP` / `NMS_EXPENSIVE` — "At $`{{PSM_CHEAP}}`, how likely would you be to buy…" on a 5-point likelihood scale. The analysis plan gets a pricing item that reads all six.

## What the respondent does

Types four prices, then (NMS) says how likely they are to buy at two of their own prices.

## Output and analysis

The pricing analysis reports the point of marginal cheapness (PMC), the point of marginal expensiveness (PME) — the acceptable range between them — the optimal price point (OPP), the indifference price point, the curves, and with NMS the trial and revenue curves (likelihood calibrated 0.7 / 0.5 / 0.3 / 0.1 / 0 from the top box down).

## Common mistakes

- **Illogical answers** — "too cheap" above "too expensive"; check and clean them before reading the curves.
- **Reading the range as demand** — it is perception, not purchase.

## Troubleshooting

- *Very wide ranges* — the product description was unclear; describe it before the price questions.
