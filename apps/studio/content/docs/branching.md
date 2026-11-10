---
summary: Send respondents down different paths of blocks with a Branch / condition element — one path per group, with an otherwise
related: skip-logic, display-logic, survey-flow, conditional-logic
status: available
---
# Branching

A branch **sends respondents down different paths** of the survey: customers get the Customers block, prospects get the Prospects block. Each path can hold any number of blocks.

## When to use it

- Different questionnaires for different groups (customers / prospects, users / non-users, by country).
- More than two paths: each path has its own condition; the first that holds runs, and **otherwise** catches everyone else.

## Set it up in the builder

::: steps Add a customer / prospect branch
1. **Create the blocks** — one block per path (Customers, Prospects), after the screener.
2. **Add the branch** — in **Programming → Survey Flow**, use **+ Add element** → **Branch / condition** after the screener.
3. **Set each path's condition** — Customers when `Q1 is Yes`.
4. **Drag the blocks into the paths** — Customers into the first path, Prospects into **otherwise**.
5. **Check the flow** — the Survey Flow shows each path with its condition as a sentence.
:::

::: example branching

## How it is stored

A `branch` node; each branch has a condition and its children, and `otherwise` runs when none holds:

```json
{ "type": "branch", "title": "Customer or prospect",
  "branches": [ { "when": { "type": "rule", "source": { "kind": "question", "ref": "q_2" }, "operator": "eq", "value": 1 },
                  "children": [ "block Customers" ] } ],
  "otherwise": [ "block Prospects" ] }
```

## What the respondent sees

Only the blocks on their path. The data has empty columns for the questions on paths they did not take.

## Common mistakes

- **Overlapping conditions** — only the first path that holds runs; order the paths from most to least specific.
- **No otherwise** — respondents who match no path continue after the branch, skipping all paths.

## Troubleshooting

- *A respondent sees neither block* — they matched no condition and there is no otherwise.
