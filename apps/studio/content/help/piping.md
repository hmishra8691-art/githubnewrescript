---
id: piping
title: Insert earlier answers into question text (piping)
category: logic
keywords: piping, pipe, piped text, insert answer, dynamic text, mention their answer, automatic piping, text piping, previous answer in question
related: carry-forward, masking, troubleshoot-piping-blank, calculations
---
## What it does
Piping inserts a value into a question's text, instruction or options when the respondent reaches it: an earlier answer, a calculated value, embedded data (such as a URL parameter), or the current loop item. “You said **Brand A** is your favourite — why?”

## How to set it up
1. Select the question and edit its text.
2. Click **Insert piped text**. Under **Insert from** choose **Previous question**, **Calculated value**, **Embedded data / URL parameter**, **Loop item** or **Expression (calc DSL)**.
3. Pick the question (and, for a grid, the row or column; for an “Other” box, which one) and click **Insert**. A token like `{{Q3}}` is placed in the text.
4. Test with **Test Survey** — the token shows the respondent's own answer.

## Example
Q3 asks for a favourite brand; Q4 reads: “Why is {{Q3}} your favourite?”

## Common mistakes
- Piping a question that comes later, or one the respondent skipped — the token renders empty. Pipe only answers that are always given before, or add display logic so the question shows only when the answer exists.
- Piping on the same page as the source question: the value is not known until the page is submitted.

## Alternatives
- To use earlier selections as **answer options**, use carry-forward; to hide options that were not chosen, use masking.
- **Dynamic text & options (ternary)** in the properties panel shows different wording depending on earlier answers.
