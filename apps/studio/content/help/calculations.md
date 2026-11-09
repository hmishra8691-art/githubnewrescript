---
id: calculations
title: Calculated variables and expressions
category: advanced
keywords: calculation, calculated variable, compute, score, sum, index, derived variable, expression, formula, recode, average
related: embedded-data, piping, custom-scripts, conditions-and-or
---
## What it does
A calculation computes a value from answers, embedded data and other calculations — a score, a total, a segment, a recode — and stores it as a variable you can pipe, use in conditions and quotas, and find in exports and analysis.

## How to set it up
1. Open **Programming** → **Calculations** (also listed under **Logic** → **Calculations**).
2. Click **+ calculation**, name the target variable, and write the expression, for example `Q1 + Q2 + ed.Embedded_Data_1`.
3. Optionally limit it with **Only compute when** (a condition) and choose when it is computed.
4. Choose how empty values are treated: **Treat Empty as 0**, **Show Calculation Error**, or **Skip Empty Values (sum, avg, count, min, max)**.
5. Use it: pipe it into text (**Insert piped text** → **Calculated value**), compare against it in a condition, or check it in **Data**.

## Example
A satisfaction index: `(Q10 + Q11 + Q12) / 3`, computed when the respondent leaves the page with Q12.

## Common mistakes
- Referring to questions that may be unanswered — choose the empty-value handling deliberately.
- Calculating on a page before the inputs are answered.

## Reference
Every operator and function is on the reference page **Logic reference**.
