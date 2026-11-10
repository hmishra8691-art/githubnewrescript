---
summary: Choice-based conjoint (CBC) — trade-offs between product profiles, with prices; efficient designs, the None option, labelled designs, partial profile, utilities, importance and the market simulator
related: adaptive-cbc, menu-based-conjoint, rating-based-conjoint, maxdiff
status: available
---
# Choice-based conjoint (CBC)

**What it is.** The respondent repeatedly chooses between a few **product profiles** — combinations of attribute levels (brand, screen, battery, price) — and, optionally, "None". From the choices the analysis estimates how much each level is worth (**utilities**), how much each attribute matters (**importance**), and simulates **market shares** for any products you define.

## When and why to use it

- Product and pricing decisions: which features to build, what to charge, how a competitor's launch changes share.
- Up to about 6–7 attributes in full profile; more with **partial profile** (below) or [ACBC](adaptive-cbc).

## Configure the design

::: steps Create a CBC
1. **Design Generators → Choice-based conjoint (CBC)** — sample, Guided set-up or Describe it; or "create a conjoint with brand, screen, battery and price" in Intelligent Mode.
2. **Attributes and levels** — 2–6 levels each; keep level counts similar.
3. **Alternatives per task** — usually 3; add a **None** option (or **dual-response None**) for realistic choices.
4. **Tasks and versions** — about 8–15 tasks; ResLens.ai suggests enough to estimate every level (12 here) and 10 versions.
5. **Prohibitions** — combinations that may never appear (e.g. a premium brand at the lowest price).
6. **Options** — efficient or balanced design, holdout tasks, labelled / brand-specific designs, **attributes shown per task** (partial profile).
:::

## Design parameters

| Parameter | Meaning |
|---|---|
| attributes, levels | what varies between profiles |
| alternatives per task | profiles per screen (plus None) |
| tasks, versions | screens per respondent; distinct task sets |
| design | `efficient` (D-efficiency) or `balanced` |
| prohibitions | level pairs or combinations never shown |
| attributes per task | partial profile: only this many attributes in each task |

::: example cbc

## Partial-profile CBC

With many attributes, showing all of them in every task overloads respondents. **Partial profile** shows only some attributes per task — balanced so each attribute is shown equally often — and leaves the others out of that task. Set **attributes shown per task** in the generator, or say "a partial profile conjoint showing 4 attributes per task".

::: example cbc-partial

## The generated design

One row per alternative: `version, task, alt, <attribute columns>, none_option, is_holdout`. Quality figures: level frequencies (balance), D-efficiency per version and pooled, and for partial profile how often each attribute is shown.

## What the respondent does

Each task shows the alternatives side by side as cards; the respondent picks one (or None). Attributes left out of a partial-profile task are not shown in it.

## Output and analysis

Exported as `CBC_T<n>` (the design alternative chosen, not its screen position) with `_VERSION` and `_T<n>_ORDER`. The conjoint analysis estimates aggregate logit utilities per level and attribute **importance** (each attribute's share of the total utility range), with a **market simulator** (share of preference, first choice, randomized first choice) for scenarios you save; individual utilities come from Hierarchical Bayes in Data Analytics. Read importance as "how much this attribute can change a choice over the levels tested" — it depends on the levels you chose.

## Common mistakes

- **Unrealistic combinations** — prohibit them, or the simulator learns from impossible products.
- **Price levels too far apart** — importance of price then reflects your range, not the market.

## Troubleshooting

- *Low D-efficiency* — too many prohibitions or too few tasks; relax or add tasks.
