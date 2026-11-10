---
summary: Show, preselect, disable or remove options with a set expression — Q5.Selected, Q5.Unselected, unions and differences
related: carry-forward, lists, display-logic
status: available
---
# Masking

A mask decides **which options (or rows, or columns) of a question are shown**, using a *set expression* over earlier answers: show only the brands not chosen before, preselect what was picked, disable what is out of stock.

## When to use it

- "Of the brands you have **not** bought…" — `Q1.Unselected`.
- Combinations of earlier answers — `Q5 UNION Q6`, `Q5 MINUS [3]`.
- Preselecting or disabling options instead of hiding them.

## Set it up in the builder

::: steps Mask Q2 to the brands not chosen at Q1
1. **Make sure the lists match** — the masked question should have the same option codes as the source.
2. **Open Q2** and go to Properties → **Masking (dynamic option sets)** (rows and columns have their own masking sections on matrices).
3. **Write or build the set** — e.g. `Q1.Unselected`.
4. **Choose the action** — **display** (show only these), **preselect**, **display and preselect**, **disable** or **remove**.
5. **Decide what happens when the set is empty** — e.g. hide the question.
:::

::: example masking

## How it is stored

The mask is stored as a parsed set expression; the engine prints it back as text:

```json
"mask": { "expr": { "kind": "ref", "questionId": "q_1", "selection": "unselected" }, "action": "display", "keepAlwaysShow": true }
```

Set expressions you can write:

```logic
Q5                         -- the selected options (same as Q5.Selected)
Q5.Unselected
Q5.Displayed
[1, 2]
(Q5 UNION Q6) DIFFERENCE Q6.Unselected
Q5 MINUS [3]
LISTFILL(concepts)
```

`keepAlwaysShow` protects options marked always-show (such as anchored "None").

## What the respondent sees

Only the options in the set (or the set preselected / disabled, depending on the action).

## Common mistakes

- **Masking with different codes** — the set is codes; if Q2's codes differ from Q1's, the wrong options show.
- **No plan for an empty set** — a respondent who selected everything at Q1 has nothing left at Q2.

## Troubleshooting

- *An option is shown although it should be masked* — it is protected as always-show; or the expression names the wrong question. The **option preview** under the options explains each option.
