---
id: test-and-preview
title: Preview and test your survey
category: studio
keywords: preview, test link, test survey, try the survey, test responses, dry run, check routing, QA
related: deploy-versions, simulated-respondents, billing-test-vs-live
---
## What it does
**Preview** shows the survey you are editing right now, page by page. **Test Survey** saves your latest changes as a new version, deploys it to the test link and opens exactly that version — with real routing, quotas and scripts — so what you test is what you would publish. Test runs are stored as TEST responses, separate from live data.

## Why researchers use it
To check wording, layout, logic and validation before respondents see anything, and to produce test data for checking exports and analysis.

## How to set it up
1. Click **Preview** in the top bar for a quick look at the current draft.
2. Click **Test Survey** to save a test build and open it. Answer as a respondent would, taking each path you need to check.
3. Open **Data** (top bar) to see your test responses row by row.
4. For many paths at once, use **Research Tools** → **Tests**: simulate hundreds of respondents through the real logic, and keep recorded test cases that must keep passing.

## Example
Your screener ends the survey for people under 18. Click **Test Survey**, answer 17, and confirm you reach the screened-out ending; then answer 30 and confirm you continue.

## Common mistakes
- Testing in **Preview** and assuming quotas or scripts behaved as live — use **Test Survey** for the real behaviour.
- Mixing test and live data: test responses are kept separately and never count toward live quotas, analysis of live data or client exports.

## Alternatives
Simulated respondents (Research Tools → Tests) cover every path automatically and report questions that are never reached.
