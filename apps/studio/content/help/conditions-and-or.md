---
id: conditions-and-or
title: Combine conditions with AND / OR
category: logic
keywords: two conditions, multiple conditions, and or, combine conditions, both conditions, either condition, condition group, nested conditions, not
related: display-logic, skip-logic, branching
---
## What it does
Every condition in ResLens.ai — display logic, skip rules, branches, quota cells, masks, validation — is built with the same condition builder, so the same AND/OR grouping works everywhere.

## How to set it up
1. Open the condition (for example **Display logic** → **Add logic**).
2. Click **+ Add condition** for each rule.
3. Set **Match** for the group: **ALL of these (AND)**, **ANY of these (OR)** or **NONE of these (NOT)**.
4. To mix them, select conditions and use **Move to new group** — each group has its own match setting.
5. Switch between **Visual** and **Expression** to see the same condition as text.

## Example
Show Q8 to women aged 18–34: two conditions, Match **ALL of these (AND)**:

```
GENDER = 2 AND AGE >= 18 AND AGE <= 34
```
Show Q9 to users of Brand A or Brand B: **ANY of these (OR)**.

## Common mistakes
- Using AND where you meant OR (nobody can be both 18–24 and 25–34).
- Expecting “not selected” to include people who were never asked — an unanswered question is neither selected nor not selected; add a condition for that case if it matters.
