---
summary: The survey flow — blocks, pages, groups, branches, randomizers, loops, embedded data, quota checks, redirects and ends
related: branching, question-randomization, loops, survey-termination
status: available
---
# Advanced survey flow

The **survey flow** is the order of everything a respondent goes through. Questions live on pages, pages in blocks, and the flow arranges blocks with branches, randomizers, loops, quota checks, embedded data, redirects and ends.

## The flow elements

| Element (+ Add element) | What it does |
|---|---|
| **Block** | a named group of pages — what the Questions view shows as a block |
| **Group** | a grouping of elements with no title screen of its own |
| **Branch / condition** | the first path whose condition holds runs; otherwise the fallback — see [Branching](branching) |
| **Randomizer** | its children in random (or rotated / Latin square / Williams) order; show N of them — see [Question randomization](question-randomization) |
| **Loop** | its children once per item — see [Loops](loops) |
| **Embedded data** | captures values from the URL, a panel or an expression at that point — see [Embedded variables](embedded-variables) |
| **Quota check** | checks quotas here — see [Quotas](quotas) |
| **Redirect** | sends the respondent to a URL — see [Redirects](redirects) |
| **End of survey** | an end with its status: complete, screened, quota full, terminated — see [Survey termination](survey-termination) |

## Set it up in the builder

::: steps Randomize two sections after an intro
1. **Create the blocks** — Intro, Food, Drinks (Programming → Questions → **+ Add block**).
2. **Open Programming → Survey Flow** — the flow reads top to bottom from START to END.
3. **Add a Randomizer** — **+ Add element** → **Randomizer** after the Intro block.
4. **Drag Food and Drinks into it** — grab a card by its ⠿ handle and drop it on the randomizer.
5. **Check the end** — every survey has at least one **End of survey** with status complete.
:::

::: example survey-flow

## How it is stored

`flow[]` in the survey definition is a tree of nodes. Only a `page` asks questions; everything else arranges pages:

```json
"flow": [
  { "type": "block", "title": "Intro", "children": [ { "type": "page", "questionIds": ["…"] } ] },
  { "type": "randomizer", "title": "Section order", "children": [ "block Food", "block Drinks" ] },
  { "type": "end", "status": "complete" }
]
```

Every node type and field is listed in [The survey definition](survey-definition).

## What the respondent sees

The intro, then the two sections in random order, then the end screen.

## Common mistakes

- **A question on no page** — it is never asked. Hidden and calculated questions should sit on a page too, so they are evaluated in order.
- **Moving a block above the question it depends on** — logic and pipes that read a later question are refused.

## Troubleshooting

- *Undo a move* — **Undo** in Survey Flow (or ⌘Z / Ctrl+Z); **Esc** cancels a drag.
