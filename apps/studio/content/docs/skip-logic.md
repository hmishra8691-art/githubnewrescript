---
summary: Jump ahead when a page is submitted — to a later question, block, the end, a terminate or a URL
related: display-logic, branching, survey-termination, redirects
status: available
---
# Skip logic

Skip logic **jumps the respondent forward** when they press Next: past questions that do not apply, to a later block, to the end, or out of the survey.

## When to use it

- Skipping a section that does not apply ("No" → skip the app questions).
- Screening out ([Survey termination](survey-termination)) or sending to a URL.
- When several questions in a row depend on one answer — one skip is simpler than display logic on each.

## Set it up in the builder

::: steps Skip to Q3 when the answer is No
1. **Open the question the skip starts from** (Q1) and go to Properties → **Skip logic**.
2. **Add a rule** — the condition (`Q1 is No`) and the destination (Q3).
3. **Add more rules if needed** — they are evaluated in order; the first one that holds is used.
4. **Pick the right destination** — a later question, page or block, the end of the survey, a terminate with its status (screened, quota full, terminated) or a URL.
:::

::: example skip-logic

## How it is stored

`skipLogic[]` on the question, evaluated when its page is submitted:

```json
"skipLogic": [ { "when": { "type": "rule", "source": { "kind": "question", "ref": "q_1" }, "operator": "eq", "value": 2 },
                 "target": { "kind": "question", "ref": "q_3" } } ]
```

`target.kind` is `question`, `page`, `block`, `section`, `end`, `terminate` (with `status`) or `url`.

## What the respondent sees

Nothing special — after Next they simply arrive at Q3. Back returns them along their own path.

## Common mistakes

- **Skipping backwards** — refused: a skip can only jump forward.
- **Skip vs display logic** — a skip fires on Next; to show or hide something on the same page, use display logic.
- **Skipping over a question other logic needs** — later pipes and conditions see it as unanswered.

## Troubleshooting

- *The skip does not fire* — skips run when the page with the question is submitted; check the rule's condition and order.
