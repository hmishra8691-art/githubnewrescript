---
id: troubleshoot-question-not-showing
title: A question is not showing / skip logic is not working
category: troubleshooting
keywords: question not showing, question not displaying, skip logic not working, display logic not working, question hidden, never shown, logic broken, respondents skip question, why isn't this question displaying
related: display-logic, skip-logic, conditions-and-or
---
## Likely causes
- **Its display logic is false** for the answers given — often a code mismatch (the condition compares against option 2 but Yes is code 1) or AND where OR was meant.
- **A skip rule earlier jumps past it** — a rule on an earlier question sends respondents beyond it.
- **It is inside a branch** in Survey Flow whose condition is false, or in a block that is not in the flow at all.
- **The condition reads a question on the same page** — the answer is not known until that page is submitted.
- **Testing an old version** — the test or live link runs a deployed version, not your latest edits.

## What to check
1. Select the question and read **Display logic**: does the condition say what you mean, with the right option codes?
2. Open **Programming** → **Logic** → **Logic trace** (or **Logic check**) to see what can reach the question and what hides it; **NOTHING REACHES THESE** lists questions no path reaches.
3. In **Programming** → **Survey Flow**, check the question's block is in the flow, and whether it is inside a branch.
4. Look for skip rules on earlier questions (**Skip logic** on each).
5. Click **Test Survey** (it saves and deploys your latest version) and take the path again.

## How to fix
Correct the condition or the target of the skip rule; move the question to a later page than the one it depends on; take the block out of the branch if everyone should see it.

## Prove it is fixed
Research Tools → Tests → simulated respondents report questions that are never reached; add a test case for the path that must show it.
