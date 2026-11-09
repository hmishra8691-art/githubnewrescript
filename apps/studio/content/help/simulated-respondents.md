---
id: simulated-respondents
title: Simulated respondents and test cases
category: studio
keywords: simulate, simulated respondents, dummy data, synthetic responses, test every path, generate test responses, test cases, regression tests, qa, coverage
related: test-and-preview, script-status, billing-test-vs-live
---
## What it does
Simulated respondents walk the real survey — logic, quotas, scripts, randomization — and report what happened: endings, questions never reached, conditions that never fired, validation that accepted invalid answers, and randomization balance. Test cases record a respondent's answers and what must happen, and keep checking it after every change.

## How to set it up
1. Open **Research Tools** → **Tests**.
2. Under **Simulated respondents**, say what to simulate (Intelligent) or set **Respondents**, profiles, distributions and expectations (Manual), then run.
3. Read **Endings**, **Coverage**, **Validation probes** and **Expected vs actual**; open any respondent's journey.
4. **Download Excel** / **Download CSV**, or **Save as test data** to analyse them as test responses. **Clear** removes them.
5. Under **Test cases**, add **+ test case**: answers, and what must happen (end status, questions asked or skipped, variable values).

## In Intelligent Mode
“Generate 100 test responses and test every path.”
