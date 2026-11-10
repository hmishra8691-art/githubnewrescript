---
summary: Custom experimental designs — full and D-optimal fractional factorials, Latin squares, Williams designs and balanced incomplete blocks — and how to use them in a survey
related: question-randomization, concept-testing, design-generators
status: available
---
# Custom experimental designs

**What it is.** A general design generator for experiments that are not conjoint or MaxDiff:

| Design | What it plans | Use it for |
|---|---|---|
| **Full factorial** | every combination of factor levels | small factorial tests (2×2, 2×3) |
| **Fractional factorial (D-optimal)** | the most informative subset of combinations | many factors — main effects with fewer runs |
| **Latin square** | treatment orders where each treatment is in each position once | position effects |
| **Williams** | orders balanced for position **and** for which treatment follows which | sequential tests with carry-over |
| **BIBD** | balanced incomplete blocks: subsets of treatments, each pair together equally often | many treatments, only a few per respondent |

## When and why to use it

- Vignette and message tests with several factors.
- Showing several ads or concepts in sequence without order or carry-over bias.
- Many treatments where each respondent can see only a few.

## Configure the design

::: steps Generate a Williams design and use it
1. **Design Generators → Custom experimental design** — sample, Guided set-up or Describe it ("show 4 ads in sequence and balance order and carry-over effects"); or the `create_experiment` action in Intelligent Mode.
2. **Choose the design type** — factorial designs take factors and levels (and prohibitions); order and block designs take treatments.
3. **Generate** — the file and its figures (D-efficiency, largest correlation between factors, carry-over balance, pairs together).
4. **Use it in the survey** — for orders, a **Randomizer** with order **Williams** (or Latin square) over one block per treatment presents exactly these orders; the attached design documents the plan.
:::

::: example experimental-designs

## The generated design

Williams: one row per position — `version, position, treatment` — 6 sequences for 3 treatments, each treatment once in every position per half and following every other treatment exactly twice. Factorial designs have one row per run with a column per factor.

## What the respondent does

Sees the treatments in the order of their row; with a factorial design, sees the run (vignette) assigned to them.

## Output and analysis

The randomizer records each respondent's order (`ORDER_<RANDOMIZER>`), so the analysis can compare treatments within respondent and test for **order effects** (as in a [sequential monadic](concept-testing) test).

## Common mistakes

- **A fractional design with too few runs** — some effects become confounded; the generator recommends a run count and reports the largest correlation between factors.

## Troubleshooting

- *"Every combination is prohibited"* — loosen the prohibitions.
