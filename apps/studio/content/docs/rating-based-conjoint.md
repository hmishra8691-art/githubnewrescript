---
summary: Rating-based conjoint (CVA) — rate full profiles 0–10 (or pairs); a D-optimal design and individual part-worths by regression, for small or specialist samples
related: choice-based-conjoint, adaptive-cbc, design-generators
status: available
---
# Rating-based conjoint (CVA)

**What it is.** Each respondent **rates** a set of full product profiles on a scale (0–10 likelihood to buy), or compares pairs. Because every respondent rates enough profiles, part-worths can be estimated **per respondent** by regression.

## When and why to use it

- Small or specialist samples (doctors, B2B buyers): about 60–100 completes.
- Few attributes (6 at most).
- Ratings are less realistic than choices — prefer [CBC](choice-based-conjoint) when the sample allows.

## Configure the design

::: steps Create a CVA
1. **Design Generators → Rating-based conjoint (CVA)**, or "create a rating-based conjoint" in Intelligent Mode.
2. **Attributes and levels**.
3. **Mode** — single profiles rated, or pairs compared.
4. **Profiles per version** — ResLens.ai suggests about 1.5 × the number of parameters (9 here, for 5 parameters).
5. **Versions, holdouts, scale labels, monotone attributes** (e.g. price decreasing).
:::

::: example rating-conjoint

## The generated design

One row per profile: `version, task, alt, <attributes>, is_holdout`. The generator uses a D-optimal exchange; the summary gives D-efficiency per version (0.97 on average here) and the degrees of freedom left for each respondent's regression.

## What the respondent does

Sees one profile (or a pair) at a time and rates it on the 0–10 scale.

## Output and analysis

Exported as one rating per profile. The conjoint analysis fits a regression **per respondent** (part-worths and importance), then summarises them; respondents who rate everything the same (flat raters) cannot be estimated and are reported.

## Common mistakes

- **Too many attributes for the profiles** — each respondent needs more profiles than parameters.

## Troubleshooting

- *"No respondent's ratings could be estimated"* — every respondent is a flat rater or rated too few profiles; check the data, or add profiles.
