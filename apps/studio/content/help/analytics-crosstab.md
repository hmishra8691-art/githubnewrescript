---
id: analytics-crosstab
title: Create a cross-tabulation
category: analytics
keywords: crosstab, cross tab, cross tabulation, banner, table, gender by brand, rows and columns, breakdown, compare groups, table by age
related: analytics-significance, analytics-overview, data-exports
---
## What it does
A crosstab shows one variable broken down by another — brand preference by gender, satisfaction by region — with percentages, bases and, optionally, significance letters between columns.

## How to set it up
1. Open **Data Analytics** (main navigation, or **Results** → **Data Analytics** from a project).
2. Choose the **Dataset** (**All complete responses**, or **Clean only (quality engine)**).
3. Click **Create crosstab** (or **New crosstab**).
4. Under **Variables (click to add)**, tick the row variable (brand preference) and the column variable (gender). Use **Ticked variables go to** to put them in **Rows** or the **Banner** (columns); **Nested rows** nests several row variables.
5. Set **Significance** to show which column percentages differ significantly, and **Measure & base** to choose percentages and bases.
6. Apply filters (for example only respondents aged 18–34), then run. **Excel** exports the table with significance in the cells; **Save chart** or **Add to report** keeps it.

## Interpreting it
Read down a banner column for its profile; read across a row to compare groups. A letter under a percentage means it is significantly higher than the column with that letter. Check the bases: small bases (under about 50) are unstable.

## Common mistakes
- Comparing percentages without looking at the base.
- Putting the outcome in the banner and the groups in the rows — groups usually go across.

## Ask in words
**Ask** (in Data Analytics) turns a sentence — “brand preference by gender, women 18–34 only” — into the table for you to review.
