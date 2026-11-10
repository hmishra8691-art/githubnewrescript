---
summary: Reviewing and approving what Intelligent Mode proposes — the card, Changes, destructive confirmations, History, undo and restore
related: intelligent-mode-guide, intelligent-validation, actions
status: available
---
# Reviewing and approving changes

Intelligent Mode never edits the survey on its own. Every request produces a **proposal**: a card that says how it was read, and a diff in **Changes** you approve, trim or discard.

## When to use it

- Always — every change goes through this review.
- Destructive changes (deleting, replacing options) need an explicit confirmation.
- Proposals with code (scripts, components) are run in a **test session** first; Apply waits until they pass.

## The review in four places

::: flow Where a proposal is reviewed
1. **The card** — how the sentence was read, and the impact ("nothing else depends on it")
2. **Changes** — the diff, change by change; untick what you do not want
3. **Apply** — one undoable step; destructive parts confirmed first
4. **History** — the prompt, the reading, the actions, the cost; restore or compare
:::

## Set it up in the builder

::: steps Review and approve a proposal
1. **Read the card** — check the reading ("Read … as …") and the impact line.
2. **Open Changes** — tick or untick each change of the batch.
3. **Confirm destructive changes** — deleting or replacing asks for a confirmation tick.
4. **Apply** — or discard the proposal; nothing was written yet.
5. **Undo or restore** — **⌘Z / Ctrl+Z** undoes the last apply; **History** restores any earlier state.
:::

::: example im-review

## What the respondent sees

Only applied changes reach the survey. In the example both proposals were approved.

## Common mistakes

- **Applying a batch without opening Changes** — for multi-part requests, untick what you did not mean.
- **Undo after many edits** — use History to restore a specific point instead.

## Troubleshooting

- *Apply is disabled* — a proposal with code is still running in its test session, or a destructive change is not confirmed.
