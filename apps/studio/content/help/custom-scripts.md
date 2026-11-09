---
id: custom-scripts
title: Custom JavaScript (logic scripts)
category: advanced
keywords: javascript, jquery, custom script, custom code, js, script, on submit, on load, on change, logic script, script api
related: calculations, validation-rules, troubleshoot-script-not-running, script-status
---
## What it does
Logic scripts run your own JavaScript at chosen moments — when a page loads, when an answer changes, on validate, on submit, at completion — to read and set answers, calculations and embedded data, flag a respondent or add a validation error. They run in a sandbox with a fixed API, not on the respondent's page.

## How to set it up
1. Open **Research Tools** → **Scripts** and click **+ script**.
2. Name it, choose its scope (survey, page or question) and event (on_load, on_change, on_submit, on_validate, on_complete).
3. Write the code with the API: `get(ref)`, `set(ref, value)`, `getCalc`/`setCalc`, `getEmbedded`/`setEmbedded`, `expr("Q1+Q2")`, `pipe("{{Q1}}")`, `flag(name)`, `log(...)`, `error(message, ref)`.
4. Optionally limit when it runs with **Run only when**.
5. Click **Check scripts** to see whether it actually runs for simulated respondents, and add a test case that expects its result to have it validated.

## Example
```js
// on_submit on the page with Q4 and Q5
setCalc('TOTAL', (get('Q4') || 0) + (get('Q5') || 0));
```

## Common mistakes
- Using browser objects (`window`, `document`, network, storage) — they are not available; the code is refused before it is saved.
- Expecting a write to an on-screen question to override the respondent's answer — writes are checked like answers.

## Alternatives
Most needs are covered without code and are easier to maintain: calculations for derived values, validation rules for checks, display logic for showing and hiding. Styling and animation code belongs in **Styles, animations & scripts** on a question.

## Reference
The full API is on the reference page **Custom code**.
