---
id: display-logic
title: Show a question only when a condition is met (display logic)
category: logic
keywords: display logic, show only if, show only when, conditional question, hide question, show question when, only ask if, conditional display
related: skip-logic, conditions-and-or, branching, troubleshoot-question-not-showing
---
## What it does
Display logic decides whether one question is shown. If its condition is false for a respondent, the question is hidden and they move on as if it were not there; with no condition, the question always shows when its page is reached.

## Why researchers use it
To ask a follow-up only of the people it applies to — “Why did you cancel?” only for those who cancelled — so nobody sees questions that make no sense for them.

## When to use it
For one question (or a few separate questions) that depends on earlier answers. To jump over a run of questions, skip logic is simpler; to send a whole group down a different path, use a branch in Survey Flow.

## How to set it up
1. In **Programming** → **Questions**, select the question to show conditionally (Q5).
2. In the properties panel, open **Display logic**.
3. Click **Add logic**. In the workspace, click **+ Add condition**, choose the earlier question (Q2), the operator and the value (Yes).
4. Click **Save**. The section now reads: IF Q2 = Yes THEN show Q5.
5. Check it with **Preview** or **Test Survey**: answer Yes, then No.

## Example
Show Q5 only when someone selects Yes in Q2: Display logic on Q5 → condition **Q2** “is” **Yes**. In text form the condition is:

```
Q2 = 1
```
(where 1 is the code of the Yes option).

## Common mistakes
- Putting the condition on the wrong question — display logic goes on the question that may be hidden (Q5), not on the one asked earlier (Q2).
- Q2 and Q5 on the same page: the condition is evaluated with the answers already given, so place Q5 on a later page than Q2, unless you want it to react on the same page.
- Comparing against the label instead of the option: pick the option from the list rather than typing text.

## Alternatives
- **Skip logic** on Q2 to jump past several questions at once.
- **Branch / condition** in Survey Flow when a whole block applies to a subgroup.
- With JavaScript: a survey script can hide content, but display logic is the reliable way — it is evaluated by the survey engine, checked by the logic checks, and reflected in tests and data.

## In Intelligent Mode
Say: “Show Q5 only to people who answered Yes at Q2.” The condition is proposed for you to review and apply.
