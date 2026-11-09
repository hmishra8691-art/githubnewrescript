---
id: branching
title: Send respondents down different paths (branching in Survey Flow)
category: logic
keywords: branch, branching logic, different path, route respondents, conditional block, survey flow condition, split by question
related: skip-logic, display-logic, survey-flow, termination
---
## What it does
A branch in Survey Flow sends respondents who meet a condition through the elements inside it — blocks, loops, randomizers, endings — and everyone else past it. It works on whole blocks rather than single questions.

## How to set it up
1. Open **Programming** → **Survey Flow**.
2. At the point where the path should split, click **+ Add element** and choose **Branch / condition**.
3. Set the condition (for example, Q3 is “Owner”). Use **+ add path** for more paths, or **Split by question…** for one path per answer option, named after it.
4. Move the blocks for that group inside the branch (drag them, or **Move into…** from a card's **More actions**).
5. Test each path with **Test Survey**.

## Example
Owners answer the satisfaction block, non-owners the consideration block: a branch on Q3 with two paths, each containing its block.

## Common mistakes
- Leaving a block both inside and after the branch — respondents then see it twice; each block should appear once.
- Conditions on questions that come after the branch: the answer does not exist yet.

## Alternatives
Skip logic for a simple jump; display logic for single questions.
