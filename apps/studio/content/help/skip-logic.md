---
id: skip-logic
title: Skip questions based on an answer (skip logic)
category: logic
keywords: skip logic, skip questions, skip the next questions, jump to, go to question, go to end, bypass, if no skip
related: display-logic, branching, termination, conditions-and-or
---
## What it does
Skip logic is attached to a question and runs after it is answered: the first rule whose condition is met sends the respondent to another question, a page, or an ending. Rules are checked top to bottom.

## Why researchers use it
To jump over a run of questions that do not apply — “No, I haven't bought in the last six months” skips the five purchase questions.

## When to use it
When one answer should move the respondent forward past several questions. For a single question that may or may not show, use display logic.

## How to set it up
1. In **Programming** → **Questions**, select the question whose answer decides the jump (Q1: “Have you purchased in the last six months?”).
2. In the properties panel, open **Skip logic** and click **Add logic**.
3. Click **+ skip rule**. Set the condition (Q1 is No) and, under **THEN GO TO**, choose where to go — the first question after the purchase block (Q7).
4. Click **Save**. The rule reads: IF Q1 = No → go to Q7.
5. Test both answers with **Test Survey**.

## Example
Purchased in the last six months? If **No**, skip Q2–Q6 and continue at Q7: one skip rule on Q1, condition Q1 = No, THEN GO TO Q7.

## Common mistakes
- Jumping backwards — skip forward only; a loop is the tool for repetition.
- Several rules in the wrong order: the first one that matches wins, so put the most specific first.
- Skipping to a question that is later moved: check the target after reordering.

## Alternatives
- Display logic on each of Q2–Q6 (more work, same result).
- A **Branch / condition** in **Survey Flow** around the purchase block — clearer when the block is long.
- An **End of survey** target ends the interview (screen-out) instead of skipping ahead.

## In Intelligent Mode
“If Q1 is No, skip to Q7” — proposed, reviewed, applied.
