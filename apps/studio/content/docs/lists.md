---
summary: Option lists built from other answers — list logic (include, exclude, prioritise), list operations and List Fill
related: carry-forward, masking, loops
status: available
---
# Lists

ResLens.ai has three ways to build the list a question shows from what came before:

| Tool | What it does | Where |
|---|---|---|
| **List logic** | include, exclude, prioritise or deprioritise another question's selected / not selected / displayed options | Properties → **2 · Keep, remove or reorder by an earlier answer (list logic)** |
| **List operations** | union, intersection, difference, remaining, dedupe, filter, sort, randomize over one or more sources | Properties → **4 · Extra list steps (list operations)** |
| **List Fill** | decides, on the server, which items each respondent gets — e.g. the 3 least-filled concepts — with targets and priorities | **Programming → List Fill** |

In a question's properties these sit together under **Answer list rules**, numbered in the order they are applied: **1** copy the list from another question (carry-forward), **2** keep, remove or reorder by an earlier answer (list logic), **3** show a calculated set (masking), **4** extra list steps (list operations). The overview above them states, in plain words, what the question's list is doing right now, and flags rules that overlap or contradict each other — for example a "keep only" and a "remove" rule on the same answers, or a calculated set and a list step that both filter the list.

The quickest way in is to say what the list should show. On a question with no rules yet, **Answer list rules** opens on one line — **Show** *only the answers they chose at* *Q1* — with the nearest earlier multi-select already chosen. It says what it will do before you press **Apply**, and picks the right tool for you: list logic when this question already has the same answers as Q1, carry-forward when it has none of its own. The rule it adds is an ordinary rule of that tool, changed in its own section afterwards. Once a question has a rule, the same line is under **Add another rule**.

## When to use it

- **List logic** — "Which *other* supermarkets do you use?" without the main one.
- **List operations** — "brands aware of OR used, minus the one rejected".
- **List Fill** — balancing which items respondents evaluate across the whole sample (least fill, priority quotas).

## Set it up in the builder

::: steps Exclude the main supermarket from the follow-up
1. **Ask the source** — Q1, the main supermarket (single-select).
2. **Open the follow-up** (Q2, same list) → Properties → **2 · Keep, remove or reorder by an earlier answer (list logic)**.
3. **Add a rule** — source Q1, action **exclude**, which **selected**.
4. **Add a condition (optional)** — a rule can apply only when a condition holds.
:::

::: example lists

## How it is stored

```json
"listLogic": [ { "id": "ll_1", "sourceQuestionId": "q_1", "action": "exclude", "which": "selected" } ]
```

List operations are `optionPipeline[]` steps. The order everything runs in is fixed: source (static or carried) → always-hidden → eligibility (option logic, display rules) → list logic → list operations → prioritisation → sorting → randomization → piping.

List Fill publishes its allocation as variables (`LISTFILL_<NAME>_COUNT`, `LISTFILL_<NAME>_1`, … `_CODES`, `_LABELS`) usable in logic, piping and loops — see [Piping, lists and loops](piping-and-lists).

## What the respondent sees

Q2 lists every supermarket except the one chosen at Q1.

## Common mistakes

- **Two tools fighting** — a carry-forward and an exclude rule on the same question are applied in the order above; check the result with the option preview.
- **List Fill in a test** — test responses are counted apart from live ones.

## Troubleshooting

- *Why is an option hidden?* — press **option preview — why is an option shown or hidden?** under the options: it walks the pipeline for one option.
