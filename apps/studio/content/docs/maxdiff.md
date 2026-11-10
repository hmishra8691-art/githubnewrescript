---
summary: MaxDiff (best–worst scaling) — rank 8–40 items by forcing trade-offs; the balanced design, the respondent's sets, scores and how to read them
related: design-generators, choice-based-conjoint, ranking, study-methodologies
status: available
---
# MaxDiff (best–worst scaling)

**What it is.** In each task the respondent sees a small set of items (typically 4 or 5) and picks the **most** and the **least** important. Across tasks every item is shown several times against different others, so every item gets a score on one common, ratio-like scale — without the "everything is important" problem of rating scales.

## When and why to use it

- Prioritising 8–40 features, benefits, claims or messages.
- Comparing importance across segments or markets on one scale.
- Not for trading features against price — that is [conjoint](choice-based-conjoint).

## Configure the design

::: steps Create a MaxDiff
1. **Research Tools → Design Generators → MaxDiff** — start from the sample, the Guided set-up or Describe it; or say "create a MaxDiff of these 10 features" in Intelligent Mode.
2. **List the items** — or take them from an earlier question's options.
3. **Items per task** — about a third of the list, 3–5 (ResLens.ai suggests 4 for 10 items).
4. **Tasks and versions** — enough tasks that each respondent sees each item about 3 times; several versions spread the combinations.
5. **Options** — best-only or best–worst, anchored MaxDiff, a practice task, pairs never shown together, express MaxDiff (a subset of items per version).
:::

## Design parameters

| Parameter | Meaning |
|---|---|
| items | what is scaled (2–200) |
| items per task | set size shown in each task |
| tasks | sets per respondent |
| versions | different sets of tasks, handed out across respondents |
| appearances per item | how often each item is shown per respondent |
| balance | `optimized` (item and pair balance) or `greedy` |

::: example maxdiff

## The generated design

The design file has one row per item shown: `version, task, position, item_index, item_label`. Its quality figures say how often each item appears (exact balance is the goal), how evenly pairs of items meet, and whether any pair never meets. In the example: 10 items, 4 per task, 8 tasks, 10 versions — every item is shown exactly 32 times across the versions (about 3 times per respondent), and every pair of items meets 10–12 times.

## What the respondent does

Each task is a short list with a **Most** and a **Least** column; one choice in each. Respondents get the tasks of their own version, in order.

## Output and analysis

Exported per task as `MD_T<n>_BEST` / `MD_T<n>_WORST` (with the version). The MaxDiff analysis gives counts (best, worst, best − worst) and aggregate utilities with a preference share per item; individual-level scores come from Hierarchical Bayes in Data Analytics. Read the **preference share**: the probability an item is chosen as best from the whole list — the shares add to 100%.

## Common mistakes

- **Too many items per task** — choices become hard and noisy; 4–5 is the norm.
- **Each item seen fewer than twice per respondent** — scores are unstable; add tasks or use express MaxDiff with care.

## Troubleshooting

- *"MaxDiff requires at least items per task + 1 items"* — add items or lower the set size.
