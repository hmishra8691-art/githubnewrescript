---
id: quotas
title: Set up quotas
category: logic
keywords: quota, quotas, quota cell, target, completes per group, quota full, nested quota, interlocking quota, quota check, soft quota, hard quota
related: termination, troubleshoot-quota-not-filling, fieldwork, recruitment
---
## What it does
A quota counts respondents in cells (for example women 18–34) against a target and decides what happens when a cell is full: end the interview as quota full, redirect, flag and continue, or only warn. Counts come from completes (optionally including those still in progress), separately for test and live.

## How to set it up
1. Open **Programming** → **Quotas** (the **Quota Dashboard**).
2. Click **+ Create Quota**, name it, and set its type and **Target total**.
3. Open the **Logic Builder** to add cells: each cell has a condition (for example GENDER = 2 AND AGE between 18 and 34), a target and, optionally, a maximum.
4. Decide what happens when a cell is full: **hard** (stop the respondent), **soft**, or **warn**, and the action (**terminate**, **redirect** or **flag**).
5. Make sure the survey checks the quota where it should: add a **Quota check** element in **Survey Flow** after the questions the cells read (right after the screener, usually).
6. From a quota sheet in Excel or CSV, Intelligent Mode can propose all quotas at once (attach the sheet).

## Example
Gender × age, six cells, 100 each: one quota, six cells with conditions on GENDER and AGE, hard, terminate as quota full, checked by a Quota check after the screener.

## Common mistakes
- A quota no element checks — it counts but never stops anyone. The dashboard says so on the quota.
- Checking the quota before the questions its cells read have been asked.
- Expecting test responses to fill live quotas — they are counted separately.

## Related
Monitor progress on the Quota Dashboard (current count, remaining, near full) and in **Results** → **Fieldwork**.
