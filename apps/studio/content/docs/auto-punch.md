---
summary: Auto-punch — IF a condition holds THEN select, deselect, set or clear an answer automatically, with ELSE branches, priorities and recompute rules
related: conditional-logic, behaviours, embedded-variables, actions
status: available
---
# Auto-punch actions

Auto-punch **sets answers automatically from conditions**: "IF age < 35 THEN code SEG = 1 ELSE 2", "IF Q5.1 is selected THEN select Q6.1". It is how you derive segments, flags and coded variables while the survey runs, without asking the respondent.

## Action types

| Verb | What it does |
|---|---|
| `SELECT` / `PUNCH` | selects option codes on the target |
| `DESELECT` / `UNPUNCH` | removes them |
| `SET … = …` | sets a value (or an expression) |
| `CLEAR` | empties the answer |
| `SHOW` / `HIDE` / `ENABLE` / `DISABLE` | options or questions, by condition |

Rules are **IF / ELSE IF / ELSE** chains on the target question; they run by priority, then order. `recompute` is `once` (the first time the condition holds) or `always`.

## When to use it

- Segments and groups computed from answers (age bands, heavy / light users).
- Back-coding: "if they chose brand 1 at Q5, mark it at Q6 too".
- Flags for quotas, routing and reporting.

## Set it up in the builder

::: steps Code an age segment
1. **Add the target** — a **hidden** question SEG with the options Under 35 (1) and 35 and over (2).
2. **Open SEG** → Properties → **Auto punch**.
3. **Add the IF rule** — condition `Q1 < 35`, action **select** 1.
4. **Add the ELSE rule** — action **select** 2.
5. **Place SEG after Q1** — on a later page, so the age exists when the rule runs. Intelligent Mode: "if Q1 < 35 then code SEG as 1".
:::

::: example auto-punch

## How it is stored

```logic
IF Q1 < 35 THEN SELECT SEG.1
ELSE SELECT SEG.2
```

stored as `punches[]` on SEG. In preview and test, a hidden question is shown (purple) with its auto-punch result; on the live link it is hidden.

## What the respondent sees and the data you get

Nothing — the respondent is not asked. The data has `SEG = 1` or `2`, usable in logic, quotas and crosstabs.

## Common mistakes

- **Punching from a later question** — the rule must read answers that exist when it runs.
- **Overlapping IF rules** — use ELSE IF so exactly one applies.

## Troubleshooting

- *SEG stays empty* — the page with SEG was not reached, or no rule's condition held and there is no ELSE.
- *SEG already has a value before Q1 is answered* — an ELSE rule holds whenever no IF holds, including while Q1 is still empty; in the live example SEG shows 2 at the start and changes to 1 once an age under 35 is entered.
