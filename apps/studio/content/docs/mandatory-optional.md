---
summary: Required versus optional questions — what Required checks for each type, and when to leave a question optional
related: question-validation, dont-know, validation-rules
status: available
---
# Mandatory and optional questions

A **required** question must be answered before the respondent can move to the next page; an **optional** one can be left blank.

## When to use it

- **Required** for anything your analysis, quotas or logic depend on — screeners, key measures, questions that later questions pipe or branch from.
- **Optional** for sensitive questions, final comments, and anything a respondent may genuinely not be able to answer (or offer a [Don't know](dont-know) instead).

## Set it up in the builder

::: steps Make a question required
1. **Open the question** — click its card in **Programming → Questions**.
2. **Use the REQUIRED drop-down** — choose **required** or **optional**.
3. **Check what "answered" means for the type** — for a matrix, every visible row; for a multi-select, at least one option (or set a minimum in Validation rules); for an Other option, its text too when **Require the “Other” text** is on.
:::

::: example mandatory-optional

## How it is stored

`"required": true` (or false) on the question. A required question that is hidden by [display logic](display-logic) is not asked, so it never blocks the respondent.

## What the respondent sees and the data you get

Pressing Next with a required question empty keeps the respondent on the page and shows a message under that question. An optional question left blank is exported as an empty cell (not as zero).

## Common mistakes

- **Everything required** — respondents forced to answer what they cannot will guess or drop out. Offer a Don't know or leave the question optional.
- **A required question that logic hides for everyone** — it can look "required" in the builder but is never asked; Review flags unreachable questions.

## Troubleshooting

- *The respondent is stuck on a page* — one of the required questions (or a matrix row) is still empty; the message is shown under it.
