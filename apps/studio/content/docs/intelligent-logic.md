---
summary: Display logic, skips, terminates, validation, randomization, masks and piping set up by sentence — read by the engine into the same logic the builder writes
related: intelligent-mode-guide, display-logic, skip-logic, conditional-logic
status: available
---
# Logic and advanced programming in words

Most logic can be said in one sentence. The engine reads the condition with the same [condition language](conditional-logic) the builder uses, so what you get is ordinary display logic, skip logic, validation or randomization — editable in the builder afterwards.

## When to use it

- Show / hide: "show Q3 only if Q2 is 1 or 2".
- Routing: "skip to Q4 if Q2 = 5", "terminate if Q4 < 18".
- Checks: "Q4 must be between 18 and 99".
- Order: "randomize Q1 options keeping Other last".
- Masks and carry-forward: "at Q10, show only the options selected in Q5".

## Set it up in the builder

::: steps Add routing in words
1. **Open Intelligent Mode** and type the rule, naming questions by code.
2. **Check the condition on the card** — the engine rewrites it in its canonical form, e.g. "Q2 in [1, 2] (Very dissatisfied, 2)", so you can see which codes it means.
3. **Apply** — the logic appears in the question's Properties like any other.
4. **Test** — use **Preview** or **Test Survey** to walk both paths.
:::

::: example im-logic

## How it is stored

Exactly as builder logic — for example the skip above is

```json
{ "op": "add_skip", "from": "Q2", "when": "Q2 = 5", "to": "Q4" }
```

applied as `skipLogic` on Q2. See [Skip logic](skip-logic), [Display logic](display-logic), [Validation rules](validation-rules).

## Common mistakes

- **Conditions on later questions** — refused: logic can only read answers given before.
- **Labels that are not options** — "Q2 contains Apple" on a rating scale is not readable; the card lists the codes the question really has.

## Troubleshooting

- *Read as something else* — the card always says how a sentence was read ("Read … as …"). If it is wrong, do not apply; rephrase with codes.
