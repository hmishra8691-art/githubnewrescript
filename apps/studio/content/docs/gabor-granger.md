---
summary: Gabor–Granger — an adaptive price ladder that finds the highest price each respondent would accept; demand and revenue curves
related: van-westendorp, menu-based-conjoint, study-methodologies
status: available
---
# Gabor–Granger price ladder

**What it is.** The respondent is asked whether they would buy at a price; a **yes** moves the next price up the ladder, a **no** moves it down, until the highest accepted price is found. Across respondents this gives a **demand curve** (share who would buy at each price) and a **revenue curve** (price × demand).

## When and why to use it

- Products with a known set of candidate prices.
- A quick read on price elasticity and the revenue-maximising price.

## Configure the design

::: steps Add a price ladder
1. **Study design** → **Gabor–Granger**, or "add a Gabor–Granger price ladder for the Plus plan at 5, 8, 12, 15 and 20 dollars" (`add_method_template price_ladder`).
2. **The ladder** — 3–20 positive prices.
3. **Where to start** — middle (default), lowest, highest or random.
4. **Wording** — the prompt and the yes / no labels.
:::

::: example gabor-granger

## The programmed block

One question, `PRICE_LADDER` (type Price Ladder), with the prices, the start and the labels. The answer is the highest price accepted (0 = none); the path of yes / no answers is kept as `GG_PRICE_LADDER_PATH`.

## What the respondent does

Answers "Would you buy the Plus plan at $12?" a few times as the price moves up or down.

## Output and analysis

The pricing analysis (Gabor–Granger) gives demand at each price, the revenue curve and the **revenue-maximising price** on the ladder.

## Common mistakes

- **Prices too close together** — differences disappear; space them meaningfully.

## Troubleshooting

- *Everyone accepts the top price* — extend the ladder upwards.
