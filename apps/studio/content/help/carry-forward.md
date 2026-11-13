---
id: carry-forward
title: Use earlier selections as a question's options (carry forward)
category: logic
keywords: carry forward, carry forward options, bring forward, show only brands selected, options from previous question, dynamic options, brands they selected, aware brands
related: masking, piping, loops
---
## What it does
Carry-forward builds a question's options (or a grid's rows) from another question for each respondent: what they selected, what they did not select, what was displayed to them, or every option. “Which of these brands have you used?” shows only the brands they said they were aware of.

## Why researchers use it
Brand funnels (aware → used → preferred), rating only the products someone owns, and asking about the items they did not choose — without programming a separate question per combination.

## How to set it up
1. Select the later question (Q2 “Which have you used?”).
2. Open **1 · Copy the list from another question (carry-forward)** in the properties panel and click **+ carry forward from another question**.
3. Choose the source question (Q1) and what to carry: **selected options**, **NOT selected options**, **displayed options** or **all options** (for a grid source: answered, unanswered, displayed or all rows).
4. Choose where the items go in this question (its options, or a grid's rows/columns), and whether to keep this question's own options as well (useful for “None of these”).
5. Test with **Test Survey** — select two brands at Q1 and check that Q2 shows exactly those.

## Example
Q1 (multi-select, aware of) → Q2 (multi-select, used): carry forward **selected options** from Q1 into Q2's options, keeping Q2's own “None of these”.

## Common mistakes
- Using it when only one option was selected and the question then has a single choice — add display logic so Q2 shows only when Q1 has at least two.
- Different codes in source and target: carried items keep the source's codes, which is what makes the data line up.

## Alternatives
- **2 · Keep, remove or reorder by an earlier answer (list logic)** keeps a question's own fixed list but includes or excludes options by what was selected earlier — choose it when the later question has its own options.
- **Row masking (dynamic row sets)** for grids: show only some rows of a fixed grid.
- **Piping** puts the answer into the question text instead of the options.
