---
summary: Repeat questions once per item — per brand selected, per child, per product — with the item piped in and answers stored per item
related: piping, carry-forward, lists, survey-flow
status: available
---
# Loops

A loop **repeats a set of questions once per item**: once for each brand the respondent owns, each child in the household, each product tried. The current item is piped into the text, and each answer is stored for its item.

## When to use it

- Evaluating each of several items with the same questions.
- The items come from an earlier answer (selected brands), a fixed list, a List Fill, or a number ("how many children?").

## Set it up in the builder

::: steps Loop Q2 over the brands selected at Q1
1. **Ask the source question first** — Q1, a multi-select of brands.
2. **Write the repeated question(s) with a pipe** — "How satisfied are you with {{loop.label}}?". Put them on their own page.
3. **Add the loop** — in **Programming → Survey Flow**, use **+ Add element** → **Loop**, and move the repeated page inside it (or ask Intelligent Mode: "create a loop around Q2 for each brand selected in Q1").
4. **Choose the source** — Q1's selected options.
5. **Limit or order the items (optional)** — a maximum number of iterations, random order, eligibility and skip / break conditions.
:::

::: example loops

## How it is stored

A `loop` node in the flow; its `source` names where the items come from and `loopVar` names the loop for nested piping:

```json
{ "type": "loop", "loopVar": "brand", "source": { "kind": "question", "questionId": "q_1", "filter": "selected" },
  "children": [ "page with Q2" ] }
```

Inside the loop: `{{loop.label}}`, `{{loop.code}}`, `{{loop.index}}`, `{{loop.count}}`; in logic `loop.code = 2`. Extra columns per item (`references`) are readable as `loop.<column>`, and `aggregates` publish values such as the average across items after the loop (`LOOP_<VAR>_<NAME>`).

## What the respondent sees and the data you get

Q2 once per selected brand, each time with the brand's name. Answers are stored per item and exported as `LSAT_1`, `LSAT_2`, … (by item code).

## Common mistakes

- **The source is asked after the loop** — the engine refuses it: the items must be known before the loop starts.
- **Long loops** — 10 items × 5 questions is 50 questions; limit the iterations (count max) or use a List Fill.

## Troubleshooting

- *The loop never runs* — nothing was selected at the source on this path.
- *Answers overwrite each other* — the question is outside the loop; move it inside.
