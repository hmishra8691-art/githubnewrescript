---
summary: Adaptive CBC — build-your-own, screening with must-haves and unacceptables, and a choice tournament built around each respondent
related: choice-based-conjoint, menu-based-conjoint, design-generators
status: available
---
# Adaptive choice-based conjoint (ACBC)

**What it is.** ACBC adapts the conjoint to each respondent in three stages: **build your own** (the respondent configures their ideal product), **screening** (near alternatives are accepted or rejected, with must-have and unacceptable checks), and a **choice tournament** among the accepted concepts. Concepts are generated at interview time around each respondent's own answers.

## When and why to use it

- Complex products with many attributes (7+), configurators, B2B purchases.
- Smaller samples (about 150–300) still give usable individual-level results.
- It is the longest conjoint interview (about 10–15 minutes).

## Configure the design

::: steps Create an ACBC
1. **Design Generators → Adaptive CBC (ACBC)**, or "create an adaptive conjoint for laptops" in Intelligent Mode.
2. **Attributes and levels** — as for CBC; an optional **summed price** (a base price plus increments per level, varied ± a percentage).
3. **Screening** — the number of screening screens and concepts per screen, how many attributes vary from the respondent's own build.
4. **Thresholds** — when a level becomes "unacceptable" or "must-have".
5. **Tournament** — alternatives per tournament task, the minimum number of concepts.
:::

::: example acbc

## The generated design

ACBC's file is the **plan of the stages**, not a fixed task list: `stage, step, items, note`. The summary gives the concept space (81 possible concepts here), the screening tasks and concepts per screen. The actual concepts are drawn per respondent from their build and their seed.

## What the respondent does

Builds an ideal product, then marks screened concepts as "a possibility" or "won't work for me", confirms must-haves and unacceptables, and finally picks winners until one concept remains.

## Output and analysis

Exported as the ACBC set — the build (`_BYO_*`), the winner (`_WINNER_*`), unacceptable and must-have levels. The conjoint analysis estimates aggregate utilities from the screening and tournament choices; individual-level utilities via Hierarchical Bayes.

## Common mistakes

- **Using ACBC for 3–4 attributes** — a plain CBC is shorter and enough.

## Troubleshooting

- *Unacceptable checks confuse respondents* — raise the threshold so a level is asked about only after it was rejected several times.
