---
id: analytics-significance
title: Significance testing and statistical tests
category: analytics
keywords: significance, significant difference, statistical test, p value, chi square, t test, compare groups, confidence interval, sig test, letters
related: analytics-crosstab, wave-tracker
---
## What it does
Data Analytics marks differences that are unlikely to be chance: column-proportion and mean tests in crosstabs (letters), and the appropriate test for each analysis type — chi-square for tables, t-tests and ANOVA for means, trend tests across waves — computed from the data, never estimated by a model.

## How to set it up
1. In a crosstab or analysis, open **Significance** and choose the test letters and the level.
2. Run the analysis; the result explains which differences are significant.
3. For waves of a tracker, use **Results** → **Wave tracker**, which tests wave on wave, against the baseline and for trend.

## Interpreting it
Significant means unlikely to be sampling noise at the chosen level — not necessarily large or important. Look at the size of the difference and the bases. Many simultaneous tests produce some false positives.
