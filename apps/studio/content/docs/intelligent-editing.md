---
summary: Generating and modifying questions in words — adding options, changing scales and types, renaming, duplicating, moving and deleting
related: intelligent-mode-guide, intelligent-logic, intelligent-review
status: available
---
# Generating and modifying questions

In Intelligent Mode you change questions by describing the change. The engine reads edits to existing questions on its own; **new question wording** is written by the language model and then goes through the same checks.

## When to use it

- Quick structural edits: "add Don't know to Q1", "change Q2 to a 7 point scale", "rename Q3 to WHY_SAT", "duplicate Q3", "move Q4 after Q6", "delete Q2".
- New questions and whole questionnaires: "add a question about purchase intent", or paste a brief — the model drafts, the gate checks, you approve.

## What the engine reads by itself

| You say | What happens |
|---|---|
| add Don't know to Q1 | adds an exclusive "Don't know" kept at the bottom |
| change Q2 to a 7 point scale | replaces Q2's options with a 1–7 scale (the card says it replaces the old options) |
| rename Q3 to WHY_SAT | renames the variable; logic, calculations and piping that name it are rewritten |
| duplicate Q3 | a copy right after it, with its options and logic |
| change Q7 to a dropdown | the same question, presented as a dropdown |
| move Q4 after Q6 | moves it, refusing a move that would make logic read a later question |
| delete Q2 | deletes it, naming what depends on it first |

The full catalogue of sentences — checked against the engine on every build — is in [Intelligent mode (reference)](intelligent-mode).

## Set it up in the builder

::: steps Change a question in words
1. **Open Intelligent Mode** — **Mode → Intelligent**.
2. **Say the change, naming the question** — "change Q2 to a 7 point scale".
3. **Read what will change** — the card states it plainly, including what will be replaced.
4. **Apply** — or untick parts of a batch in Changes first.
5. **For new wording** — "add a 5-point satisfaction question about the battery" is drafted by the language model (shown with its cost before it is called), then applied the same way.
:::

::: example im-edit

## What the respondent sees

The edited questions, exactly as if you had made the changes in the builder.

## Common mistakes

- **Vague targets** — "change the scale" without a question; name it.
- **Renaming a variable after fieldwork** — the export column changes; the card warns you.

## Troubleshooting

- *"Q2 is already required — nothing to change"* — the survey already is as asked; nothing is proposed.
- *A new question was not created without a model* — creating wording needs the language model; with no model (or an internal-only project) the engine offers what it can instead.
