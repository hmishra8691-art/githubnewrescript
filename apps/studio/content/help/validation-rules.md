---
id: validation-rules
title: Validate answers (required, ranges, formats, custom checks)
category: logic
keywords: validation, validation rules, required, must answer, range, min max, number between, format, error message, custom validation, sum must equal
related: question-types, custom-scripts, calculations
---
## What it does
Validation stops a respondent from moving on until an answer passes the question's rules — required, a number range, a minimum or maximum number of selections, a format (email, phone, postal code), a sum target, or your own condition — and shows your message when it fails.

## How to set it up
1. Select the question.
2. Tick **Required** if it must be answered; for multiple choice set **Min selections** / **Max selections**; for numbers set the allowed range in its settings.
3. For anything else, open **Validation rules**, add a rule, and describe when the answer is invalid (**The answer is INVALID when**) using the condition builder.
4. Edit the message under **Respondent sees** and choose **Message position**.
5. Test it with **Test Survey**: enter an invalid answer and check the message.

## Example
Age must be between 18 and 99: numeric question with minimum 18 and maximum 99, message “Please enter your age in years (18–99).”

## Common mistakes
- Hard-requiring sensitive questions — offer “Prefer not to say” instead.
- Validation that contradicts display logic (requiring a question that may be hidden): a hidden question is never validated, which is what you want.

## Check it
Simulated respondents (Research Tools → Tests) can try invalid answers automatically and report any the survey accepted.
