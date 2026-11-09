---
id: masking
title: Hide options, rows or columns based on earlier answers (masking)
category: logic
keywords: masking, mask options, choice masking, answer masking, row masking, column masking, hide options not selected, show only selected, question masking, exclude options
related: carry-forward, piping, display-logic
---
## What it does
Masking keeps a question's own list but shows each respondent only the items that pass a rule — options selected (or not selected) earlier, items in a List Fill result, a loop item, or a calculated set. Rows and columns of grids can be masked separately.

## How to set it up
For a question's options:
1. Select the question and open **List logic (from previous questions)**.
2. Click **Add logic**, then **+ list rule**, and say which options to keep: for example **KEEP OPTIONS WHERE** they were selected in Q1, or **NOT selected in** Q1.
3. Save, then test with **Test Survey**.

For a grid's rows or columns:
1. Select the grid question and open **Row masking (dynamic row sets)** or **Column masking (dynamic column sets)**.
2. Click **+ Add set** and choose the source (an earlier question's codes, a List Fill result, a loop item or a calculated value).
3. Under **What to do with the result**, choose for example **Show only these, and pre-select them**, and whether to **Always keep Other / None / Don't know**.
4. Decide what happens when the source is unanswered (**If the source is unanswered**).

## Example
A satisfaction grid lists ten brands; each respondent rates only the brands they use (Q3): row masking with a set from Q3's selected codes, “show only these”.

## Common mistakes
- Masking everything away: when the rule leaves no items, decide whether the question should be skipped (add display logic) or show the special items only.
- Masking and carry-forward on the same question for the same purpose — pick one.

## Alternatives
Carry-forward builds the list from the source question itself; masking filters a list the question already has.
