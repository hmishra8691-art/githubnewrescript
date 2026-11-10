---
summary: Show a question, page, block or option only when a condition holds — instantly on the same page
related: skip-logic, branching, conditional-logic, masking
status: available
---
# Display logic

Display logic shows a question **only while a condition holds**. If the condition is false the question is not shown, not asked and not required.

## When to use it

- Follow-ups that apply to some respondents: car owners get the fuel question.
- On the **same page**: the follow-up appears the moment the triggering answer is given.
- On pages, blocks and even single options, rows and columns (option logic, display rules).

## Set it up in the builder

::: steps Show Q2 only to car owners
1. **Open Q2** and go to Properties → **Display logic**.
2. **Build the condition** — choose the question (Q1), the operator (*is*) and the value (*Yes*). **Edit logic** opens the full builder with AND / OR groups and an expression view.
3. **Read the sentence under it** — "Display Q2 if the respondent selects Yes at Q1" — to check it says what you mean.
4. **Test it** — with **Preview** or the live example below.
:::

::: example display-logic

## How it is stored

You write the condition as text (or build it visually); the engine compiles it to the stored JSON and prints it back:

```logic
Q1 = 1
```

```json
"displayLogic": { "type": "rule", "source": { "kind": "question", "ref": "q_1" }, "operator": "eq", "value": 1 }
```

The same condition language is used everywhere — see [Conditional logic](conditional-logic) for AND / OR, counts and more.

## What the respondent sees

Answering Yes makes Q2 appear on the same page; changing to No removes it again. If every question on a page is hidden, the page is skipped.

## Common mistakes

- **Logic that reads a later question** — refused by the engine: the condition must only read answers given earlier (or on the same page).
- **Hiding a question that other logic depends on** — its answer is empty for those respondents; check downstream pipes and conditions.

## Troubleshooting

- *The question never shows* — test the condition with the answers you gave; a typo in a value (`"yes"` vs `1`) is the usual cause. The builder shows the condition as a sentence.
