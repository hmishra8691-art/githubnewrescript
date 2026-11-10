---
summary: Free-text answers in the respondent's own words — essays, comments, reasons — with length checks and AI follow-up probes
related: text-entry, question-validation, piping
status: available
---
# Open-ended questions

An open-ended question collects a **free-text answer** in a multi-line box: an explanation, a suggestion, a story. It is how you hear what respondents think in their own words.

## When to use it

- "Why?" questions after a rating, suggestions for improvement, first impressions.
- Exploring before you know the answer list — the themes can become the options of a later closed question.
- Keep them few: open ends take effort, and a survey with many of them gets shorter answers.

## Set it up in the builder

::: steps Create an open-ended question
1. **Add the question** — **+ Add question** → family **Text / Open End**, type **Multi-Line Text** (or **Essay / Long Text** for a taller box).
2. **Ask for enough detail (optional)** — Properties → **Validation rules** → **min length** with a friendly message.
3. **Probe for more (optional)** — Properties → **Follow-up probe** asks a follow-up when an answer is short or vague.
4. **Let people speak (optional)** — speech input is available on text answers (the respondent can dictate instead of typing).
:::

::: example open-ended

## How it is stored

```json
{ "code": "Q1", "variableName": "IMPROVE", "type": "long_text", "variant": "text.multi_line",
  "validation": [ { "kind": "min_length", "value": 10, "message": "Please tell us a little more (10 characters or more)." } ] }
```

The answer is the text exactly as written. Logic can test whether it was answered and what it contains: `Q1 answered`, `CONTAINS(Q1, "price")`.

## What the respondent sees and the data you get

A multi-line box that grows with the text. The export has one text column (`IMPROVE`). In Data Analytics, text answers can be coded into themes and sentiment.

## Common mistakes

- **A minimum length on an optional question.** If the respondent may skip it, a min length still applies to anything they do type — keep it low.
- **Too many open ends in a row.** Answers get shorter and dropout rises; mix them with closed questions.

## Troubleshooting

- *The respondent cannot continue* — the minimum length (or a pattern rule) is not met; the message under the box says which.
