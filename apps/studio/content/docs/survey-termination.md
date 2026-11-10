---
summary: End the survey early — screen-outs, quota-full and terminated statuses, end messages and where to send people
related: skip-logic, quotas, redirects, survey-flow
status: available
---
# Survey termination

A survey ends at an **End of survey** element with a **status**: *complete*, *screened*, *quota full* or *terminated*. Screeners end early by skipping to a terminate.

## When to use it

- **Screened** — the respondent does not qualify (age, category usage, country).
- **Quota full** — their group is already full (usually set by a quota check, see [Quotas](quotas)).
- **Terminated** — any other early end (failed attention check, explicit refusal).
- Each status can show its own message or send the respondent to a panel URL.

## Set it up in the builder

::: steps Screen out under-18s
1. **Open the screener question** (Q1, age) → Properties → **Skip logic**.
2. **Add a rule** — `Q1 < 18`, destination **terminate** with status **screened**.
3. **Write the message (optional)** — in **Programming → Survey Flow**, open the matching **End of survey** element and set its message, or a redirect URL for panel respondents.
4. **Test both paths** — under and over 18.
:::

::: example survey-termination

## How it is stored

```json
"skipLogic": [ { "when": { "type": "rule", "source": { "kind": "question", "ref": "q_1" }, "operator": "lt", "value": 18 },
                 "target": { "kind": "terminate", "status": "screened" } } ]
```

An end node can carry its own message and redirect: `{ "type": "end", "status": "screened", "message": "…", "redirectUrl": "…" }`.

## What the respondent sees and the data you get

The end screen for that status. The response is saved with its status, so screen-outs are counted apart from completes (and quotas count completes by default).

## Common mistakes

- **Terminating with status complete** — screen-outs then count as completes in reports and quotas.
- **Screening on an optional question** — a blank answer slips through; make screeners required.

## Troubleshooting

- *Everyone is screened out* — check the operator and value (`<` vs `>`), and that the question is numeric.
