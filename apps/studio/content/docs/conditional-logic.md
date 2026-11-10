---
summary: The condition language behind every rule — operators, AND / OR / NOT, counts, grids, named expressions, calculations and auto-punch
related: display-logic, skip-logic, branching, validation-rules
status: available
---
# Conditional logic

Every rule in ResLens.ai — display logic, skips, branches, validation, quotas, option logic, auto-punch — uses **one condition language**. Learn it once and it works everywhere, in the visual builder and as text.

## When to use it

- Combining answers: an age range **and** two or more sports.
- Counting: `COUNT(Q2) >= 2`.
- Reusing a condition under a name (named expressions), deriving values (calculations) and setting answers automatically (auto-punch).

## Set it up in the builder

::: steps Build a combined condition
1. **Open the logic** — e.g. Properties → **Display logic** → **Edit logic**.
2. **Add the first condition** — `Q1` *between* 18 and 44.
3. **Add a second one** — `COUNT(Q2)` *≥* 2, joined with **AND**.
4. **Group if needed** — brackets (groups) for mixes of AND and OR.
5. **Switch to the expression view** to read or paste the text form.
:::

::: example conditional-logic

## How it is stored

The text is compiled to a tree of rules and groups:

```logic
Q1 between 18 and 44 AND COUNT(Q2) >= 2
```

The language at a glance:

```logic
Q1 >= 18
Q3 = Female                 -- an option by its label (stored as its code)
Q5.3                        -- a multi-select option is selected
Q5 contains any [1, 3]
Q7 answered
Q12.r1 >= 4                 -- a grid row
Q5 > Q6                     -- compare two answers
(Q3 = 1 OR Q3 = 2) AND NOT Q5.3
calc.SCORE > 10 AND ed.PANEL = abc
quota.q_gender >= 200
loop.code = 2
```

Operators, functions and every spelling are in the [logic reference](logic-reference); the full guide is [Logic and expressions](logic).

**Auto-punch** sets answers from conditions, e.g. `IF COUNT(Q5) >= 2 THEN SET SEG = Heavy` (Properties → **Auto punch**). **Calculations** compute values (`sum(Q7_r1, Q7_r2) / 2`) usable as `calc.NAME` (Programming → **Calculations**).

## What the respondent sees

In the example, Q3 appears only when both parts hold.

## Common mistakes

- **Mixing AND and OR without brackets** — accepted with a warning; add brackets so it means what you intend (`NOT` binds tighter than `AND`, `AND` tighter than `OR`).
- **Comparing with an option that no longer exists** — the engine refuses the change and names the option.

## Troubleshooting

- *"reads a question asked later"* — conditions may only read earlier answers; move the logic or the question.
