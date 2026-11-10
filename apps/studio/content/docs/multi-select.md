---
summary: Several answers from one list, with minimum / maximum selections and exclusive options such as “None of these”
related: single-select, exclusive-options, none-of-the-above, question-validation
status: available
---
# Multi select

A multi-select question lets the respondent choose **any number of options** from a list — "select all that apply". Each option is either selected or not.

## When to use it

- Awareness, usage and ownership lists — "Which of these brands have you heard of?"
- Any list where several answers can be true at the same time.
- With a **minimum or maximum** — "Pick your top two" — use [validation](question-validation) on the selections.

## Set it up in the builder

::: steps Create a multi-select question
1. **Add the question** — **+ Add question** → family **Multi Select**; the default type is **Checkbox**.
2. **Add the options** — as for a single-select: one row per option with its code and label.
3. **Add an exclusive option** — For "None of these", open the option's **properties…** and tick **exclusive**; tick **anchor bottom** too so it stays last when the list is randomized.
4. **Add the instruction** — "Select all that apply." in the Instruction box helps respondents.
5. **Limit the selections (optional)** — In Properties → **Validation rules**, add *minimum selections* and/or *maximum selections*.
:::

::: example multi-select

## How it is stored

```json
{ "code": "Q1", "variableName": "STREAM", "type": "multi_select", "variant": "multi_select.checkbox",
  "options": [ { "code": 1, "label": "Netflix" }, { "code": 2, "label": "Prime Video" },
               { "code": 5, "label": "None of these", "flags": ["exclusive", "anchor_bottom"] } ] }
```

The answer is the list of selected codes, for example `[1, 3]`. In logic:

```logic
Q1.2                       -- Prime Video is selected
Q1 contains any [1, 2]     -- at least one of them
Q1 contains all [1, 2]     -- both
COUNT(Q1) >= 2             -- two or more selected
NOT Q1.5                   -- "None of these" was not chosen
```

## What the respondent sees and the data you get

Checkboxes (or buttons, cards, images — the variant decides). Selecting an **exclusive** option clears every other selection; selecting another option clears the exclusive one.

The export has one 0/1 column per option — `STREAM_1`, `STREAM_2`, … — and the list itself in `STREAM`. An other-specify text exports as `STREAM_other`.

## Common mistakes

- **Forgetting the exclusive flag on "None".** Without it a respondent can tick "None of these" *and* Netflix, which is contradictory data.
- **Setting a maximum lower than the minimum.** The engine refuses a contradictory pair when the rule is saved.
- **Required without "None".** If some respondents genuinely have no answer, give them one; otherwise they are forced to pick something.

## Troubleshooting

- *Ticking one option unticks another* — that option is marked exclusive.
- *"Please select at least 2" appears* — a minimum selections rule is set on the question (Properties → Validation rules).
