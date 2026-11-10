---
summary: Show questions, pages or blocks in random order with a Randomizer — balanced orders, show N of M, and the recorded order
related: answer-randomization, survey-flow, branching
status: available
---
# Question randomization

Question randomization changes **the order in which questions (or whole pages and blocks) are shown** from one respondent to the next, so no question always benefits — or suffers — from coming first.

## When to use it

- Concept tests and sequential monadic designs — every concept seen first by some respondents.
- A set of independent evaluation questions where order could bias answers.
- **Show N of M** — give each respondent a random 3 of 10 concepts.

## Set it up in the builder

ResLens.ai randomizes order with a **Randomizer** in the survey flow. Put each question (or group of questions) in its own block and place the blocks inside the Randomizer.

::: steps Randomize the order of three questions
1. **Give each question its own block** — in **Programming → Questions**, **+ Add block** for each concept and add its question(s).
2. **Add a Randomizer** — in **Programming → Survey Flow**, use **+ Add element** → **Randomizer** where the questions should appear (or ask Intelligent Mode: "randomize blocks Concept A, Concept B and Concept C").
3. **Move the blocks inside it** — drag them by their ⠿ handle onto the Randomizer.
4. **Choose how it orders them** — random, rotation, Latin square or Williams (balanced for position and for which item follows which). Set **show** to present only N of them.
5. **Balance exactly (optional)** — exact balance hands out orders by least-filled, so each order is used equally.
:::

::: example question-randomization

## How it is stored

A `randomizer` flow node holds the blocks:

```json
{ "type": "randomizer", "title": "Concept order", "children": [ "block “Concept A”", "block “Concept B”", "block “Concept C”" ] }
```

Options: `show` (N of the children), `order` (`random`, `rotation`, `latin_square`, `williams`), exact balance and weights. The order each respondent saw is recorded in `ORDER_<RANDOMIZER ID>`, so you can test for order effects.

## What the respondent sees and the data you get

The same questions, in a different order for each respondent. The data columns are the same whatever the order; `ORDER_…` tells you which order was used.

## Common mistakes

- **Putting questions that depend on each other in one randomizer** — a question that pipes or branches on another must come after it; keep them outside.
- **Several questions on one page** — the randomizer orders its children (blocks), not the questions inside one page; give each question its own block.

## Troubleshooting

- *Everyone gets the same order in testing* — each new respondent gets a new order; in the live example press Restart.
