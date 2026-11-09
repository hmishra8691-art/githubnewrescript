---
id: list-fill
title: List Fill — allocate concepts or items to respondents
category: advanced
keywords: list fill, allocate, allocation, least fill, assign concepts, concept allocation, balanced allocation, monadic allocation
related: quotas, loops, randomization
---
## What it does
**List Fill** chooses items for each respondent from a source list — concepts, products, ads — by rules: only eligible items, the least-filled first, a maximum per respondent — so items reach their targets evenly. The result can drive loops, masks and piping.

## How to set it up
1. Open **Programming** → **List Fill** and click **+ List Fill**.
2. Choose the source and add items (**+ add every option from the source**).
3. Set eligibility (**Eligible for allocation** or **Eligible only when a condition holds**) and how many to take.
4. Use the result (a LISTFILL variable) in a loop source, a mask, or piping.
5. **Simulate one respondent** to check the allocation.

## Common mistakes
Allocating before the questions that decide eligibility are answered.
