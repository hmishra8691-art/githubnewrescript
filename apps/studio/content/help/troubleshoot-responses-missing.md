---
id: troubleshoot-responses-missing
title: Responses are not appearing in Data or Analytics
category: troubleshooting
keywords: responses not appearing, responses missing, no responses in analytics, data not showing, results empty, where are my responses, analytics empty
related: data-responses, billing-test-vs-live, data-quality
---
## Likely causes
- **Test vs live** — responses from the test link are TEST data; the live dataset does not show them (and the reverse).
- **Only completes are analysed** — Data Analytics works on complete responses; in-progress, screened and quota-full interviews are not in its tables.
- **The clean dataset** — responses removed or classified out by quality review are not in the clean dataset.
- **A filter** is applied in Data Analytics.
- **Responses removed** in Data → Manage (they can be restored).
- **A different version or link** — respondents used an older live link of another project.

## What to check
1. **Results** → **Data**: are the responses there, under test or live, and what is their status?
2. In **Data Analytics**, check the **Dataset** selector and the active filters.
3. In **Data** → **Quality**, check whether they were removed.

## How to fix
Switch the dataset or environment, clear filters, or restore removed responses. If responses are missing from Data itself while respondents report finishing, contact support with the survey code and approximate times — that needs an engineer to look at the server side.
