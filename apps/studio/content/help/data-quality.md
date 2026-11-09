---
id: data-quality
title: Data quality and cleaning (speeders, straightliners, bots, contradictions)
category: results
keywords: data quality, cleaning, clean data, speeders, straightliners, bots, fraud, duplicates, contradictions, inconsistent answers, attention checks, flagged responses, remove bad responses
related: quality-rules, data-responses
---
## What it does
The quality engine scores every response against rules — timing (speeding), grids (straightlining), patterns, attention checks, contradictions between answers (an exclusive “None” chosen with other answers, brands used but never heard of, more children than people in the household, more years than the respondent's age), open-end quality, devices, networks, bots, duplicates — and gives a verdict and the evidence. It never removes a response by itself: a person decides.

## How to set it up
1. Turn it on in **Programming** → **Survey Settings** → **Quality checks** and choose a strictness. Under **Rules**, open a category (for example **Consistency**) to see and adjust each check — including the contradiction checks this questionnaire supports.
2. Review in **Results** → **Data** → **Quality**: each flagged response with its signals and why.
3. Decide per response (keep, remove, review later), or in batches. Removed responses leave the clean dataset and can be restored.
4. In Intelligent Mode, ask for example “Flag speeders and people who use brands they've never heard of” — it proposes the batch for you to approve.

## Common mistakes
- Removing every flagged response automatically — read the evidence; informational flags describe, they don't condemn.
- Strict settings on a short survey (speed thresholds are relative to the survey's length).
