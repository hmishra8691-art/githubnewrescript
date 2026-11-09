---
id: troubleshoot-quota-not-filling
title: A quota is not filling (or over-filling)
category: troubleshooting
keywords: quota not filling, quota not counting, quota overfilling, quota full too early, quota wrong count, quota not stopping respondents
related: quotas, fieldwork
---
## Likely causes
- **No element checks it** — the quota counts but never stops anyone (the Quota Dashboard says so on the quota).
- **The cell conditions do not match the answers** — wrong codes, AND/OR mistakes, a variable that is never set.
- **Checked too early** — the quota check runs before the questions its cells read.
- **Counting rules** — completes only vs completes plus in progress; test and live are counted separately.
- **Soft or warn** instead of hard — respondents are flagged, not stopped.

## What to check
1. **Programming** → **Quotas**: open the quota's **Details** and **Edit Logic**; read each cell's condition and the **Used by** line.
2. In **Survey Flow**, find the **Quota check** and make sure it comes after the screener questions.
3. Compare the counts with **Results** → **Fieldwork**.

## How to fix
Correct the conditions, add or move the quota check, choose hard where respondents must be stopped. **Recount from data** rebuilds the counts from stored responses after a fix.
