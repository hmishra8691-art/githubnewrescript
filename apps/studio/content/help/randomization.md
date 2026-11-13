---
id: randomization
title: Randomize the order of options, questions or blocks
category: logic
keywords: randomization, randomize, shuffle, rotate, order bias, random order, randomizer, show n of m, latin square
related: survey-flow, masking
---
## What it does
Randomization changes the order respondents see — options within a question, questions within a block, or blocks within the survey — to spread order bias evenly. ResLens.ai records the order each respondent saw.

## How to set it up
Options or rows of one question:
1. Select the question and open **Randomization**.
2. Choose **shuffle**, **rotate**, **reverse for half** or **keep order**, and anchor items that must stay put (such as “Other” or “None of these”).

Blocks or elements of the flow:
1. In **Programming** → **Survey Flow**, click **+ Add element** and choose **Randomizer**.
2. Put the blocks to randomize inside it. Choose how many to show (all, or N of M) and the balancing (**Exact balance**, **balanced positions — each part in each position equally (Latin square)**, or **balanced positions and sequence — also which part follows which (Williams)**).

## Common mistakes
- Randomizing an ordered scale (Strongly disagree → Strongly agree) — keep scales in order.
- Forgetting to anchor “None of these” at the bottom.

## Check it
Research Tools → Tests → simulated respondents report how often each item came first, so you can see the randomization is balanced.
