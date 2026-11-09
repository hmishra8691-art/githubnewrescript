---
id: conjoint
title: Conjoint studies (CBC, ACBC, menu-based, rating-based)
category: designs
keywords: conjoint, cbc, choice based conjoint, acbc, adaptive conjoint, menu based conjoint, rating based conjoint, cva, attributes, levels, trade off, willingness to pay, design file, prohibitions
related: maxdiff, choose-a-method, methodologies, data-exports
---
## What it is
Conjoint shows respondents product profiles built from attributes (brand, price, features) and levels (the values each can take), and infers how much each level matters from the choices they make.

- **CBC (choice-based)** — choose the best of several profiles per task; the standard for pricing and feature trade-offs.
- **ACBC (adaptive)** — builds each respondent's tasks around what they said matters; for many attributes, smaller samples, complex products.
- **Menu-based** — build-your-own bundles and add-ons.
- **Rating-based (CVA)** — rate profiles rather than choose; for small samples or simple designs.

## When to use it
When you need to know how people trade features and price against each other, simulate market shares, or estimate willingness to pay. For ranking a list of items by importance, MaxDiff is simpler.

## How to set it up
1. Not sure which design fits? **Research Tools** → **Study design** → **Recommend a methodology** recommends one from your objective, with the sample and length it needs.
2. Open **Research Tools** → **Design Generators** (**Research Design Generators**).
3. Choose the conjoint type, then add attributes with **+ attribute** and their levels with **+ level**. Add **+ prohibition** for combinations that cannot exist.
4. Set the experimental settings — tasks per respondent, alternatives per task, versions, a None option — and click **Generate Design File**. Review its balance and efficiency.
5. The design appears under **Attached design files**; add the conjoint tasks to the survey where they should run.
6. Test with **Test Survey**, then simulate respondents to check every version is shown.

## Sample design
As a rule of thumb (Orme): completes ≥ 500 × the largest number of levels ÷ (tasks × alternatives), and at least 300 for robust results; more if you will compare subgroups.

## Interpreting the data
Data Analytics estimates part-worth utilities (hierarchical Bayes or multinomial logit), attribute importances, willingness to pay (with a price attribute) and share-of-preference simulations. Exports include a long-format choice file (one row per respondent × task × alternative).

## Common mistakes
- Too many levels on one attribute (it looks more important than it is).
- Unrealistic combinations — add prohibitions instead of dropping levels.
- Too few tasks for the number of parameters.
