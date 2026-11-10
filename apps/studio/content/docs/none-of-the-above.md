---
summary: A “None of the above” answer — exclusive, anchored last, and safe with randomization
related: exclusive-options, multi-select, answer-randomization, dont-know
status: available
---
# None of the above

"None of the above" lets a respondent say that **no option applies** — so a required multi-select never forces a false answer.

## When to use it

- Any required multi-select where "none" is a real answer — features used, brands bought, problems experienced.
- Pair it with randomization: the substantive options are shuffled, "None of the above" stays last.

## Set it up in the builder

::: steps Add "None of the above"
1. **Add the option** — "None of the above" (or "None of these") as the last option.
2. **Make it exclusive and anchored** — in its **properties…** tick **exclusive** and **anchor bottom**. ResLens.ai recognises these labels and sets both flags when the option is created; check them in properties.
3. **Randomize the rest (optional)** — Properties → **Randomization**; the anchored option keeps its place.
:::

::: example none-of-the-above

## How it is stored

It is an ordinary option with the exclusive and anchor flags — there is no separate "none of the above" flag:

```json
{ "code": 99, "label": "None of the above", "flags": ["exclusive", "anchor_bottom"] }
```

Logic can route people who chose it: `Q1.99` (or `Q1 = "None of the above"`).

## What the respondent sees and the data you get

The option sits last, however the others are ordered, and selecting it clears the others. Export: `FEAT_99` = 1 for respondents who chose it.

## Common mistakes

- **Not anchoring it on a randomized list.**
- **Showing a follow-up about "the features you used" to people who chose None** — add display logic `NOT Q1.99` to the follow-up (see [Display logic](display-logic)).

## Troubleshooting

- *It moves when the list is shuffled* — **anchor bottom** is not set.
