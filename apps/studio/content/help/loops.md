---
id: loops
title: Repeat questions for each item (loops)
category: logic
keywords: loop, loop and merge, repeat questions for each, for each brand, for each child, iteration, roster
related: carry-forward, piping, survey-flow
---
## What it does
A loop repeats the questions inside it once per item — each brand selected, each child in the household, each product tried. Inside the loop the current item can be piped into the text, and every answer is stored per iteration.

## How to set it up
1. Open **Programming** → **Survey Flow**.
2. Click **+ Add element** and choose **Loop**.
3. Set its **Source**: an earlier question (for example the brands selected at Q2) or a fixed list of items. Optionally narrow the items with an eligibility rule, set **Order** and limit the **Iterations**.
4. Put the block with the repeated questions inside the loop.
5. In those questions, use **Insert piped text** → **Loop item** to show the current item (“How satisfied are you with {{loop item}}?”).
6. Test with **Test Survey** and check one pass per item.

## Common mistakes
- A loop source the respondent can leave empty — then the loop has no iterations; that is expected, but check the flow after it still makes sense.
- Piping a loop item in a question that is not inside the loop: it renders empty.

## Alternatives
For a short list of items rated the same way, a grid (one row per item, with row masking) is quicker for respondents than a loop.
