# Intelligent Mode, Phase 5 — every operation recorded, and nothing called done that is not

*Intelligent Mode upgrade, Phase 5. Built 2026-10-05 on Phases 2–4. It fixes the audit's R11 (false success), R12 (history kept only in the page), R20 (a failed grammar proposal consumed an undo step) and R21 (the store's undo invisible to the history), and the brief's §4 and §23.*

## The record

Every Intelligent Mode operation is a row of `intelligent_operations` (migration 0047, applied): the prompt; the source (engine, model, grammar, fix, import, context); the interpreted intent; what was detected and targeted; what was proposed (each action with its description, kept so it can be re-proposed), applied, excluded and refused (with the reasons); the warnings; the engine operations performed; the model calls made (route, mode, charge, whether cached, prompt size); the survey before and after (for applied changes only, ≤ 2 MB each); the status and its detail; the saved revision. An applied operation carries the survey's AI change number, assigned by the server on the first arrival at `applied` (the highest + 1, guarded by a unique index on (survey, number) and retried once on a clash), so numbers continue across sessions and two researchers never get the same one. A redo keeps its number.

Statuses and their transitions are a closed list: proposed → applied / cancelled / failed; applied → saved / not saved / reverted; not saved → saved / reverted; saved → reverted; reverted → applied (a redo). Answered, refused, clarification and failed are final. A refused transition is a 409 the page says on the entry.

`/api/copilot/operations` — GET the list (newest first, without the surveys), GET one with them, POST a new record, PATCH an update. Reads need project access, writes the edit right and the edit lock. Without the table (an installation that has not applied 0047) the same store runs in server memory, and the History tab says the history is kept on this server only. The sandbox is always in memory, keyed by the browser tab, so it survives a reload of the tab. The audit log keeps its `survey.ai_changed` row per applied change, now with the server's number; a failed audit write is said on the entry, no longer swallowed.

## Nothing called done that is not

Apply puts the change into the store, records it as applied (the survey as the store holds it afterwards — the store normalises option codes, so the proposal's own end state would have made a later revert think the survey had changed), then waits for the draft to save:

- `APPLIED · SAVING…` while the save is on its way;
- `APPLIED · SAVED` only when the save returned true;
- `APPLIED · NOT SAVED — CONFLICT` (or lock lost, signed out, the error's own message) with **Try saving again**; the record says not saved, with why;
- `APPLIED · SANDBOX (NOT SAVED)` in the sandbox, which stores nothing.

The grammar's proposals are applied to a copy first and written to the store only when the copy has no errors, so a failed one no longer takes an undo step or marks the survey as edited; they are recorded and numbered like the copilot's. ⌘Z that takes the survey back before the latest AI change marks it reverted ("undone with ⌘Z"); ⌘⇧Z marks it applied again. A change still standing after the survey's current state stops the search: ⌘Z took a later edit, not an earlier AI change.

## The History tab

Newest first, each entry with its AI change number, a status chip, the source, the time and the prompt; **Details** shows the intent, what was detected, the targets (each selects its object), the proposed / applied / left-out / refused lists, the warnings, the engine operations, the model calls with their cost and the status detail. **Compare** shows what the change did (the before and after read back from the record, as the read-only review). **Restore** reverts where it is safe — at once for the latest standing change; with the warning that later edits go too otherwise; it works for changes from an earlier session. **Reapply** puts the entry's actions back into the Changes panel as a new proposal against the survey as it is now, reviewed again.

## Also fixed

The auth-guard audit had three failures, none from this phase's files. Two were in the analysis-runs cron route from the research-intelligence Phase 5: the bearer-token check was not the handler's first statement and the route was not registered as a scheduler route. It now checks in each handler's first statement, and the route is registered with its reason, like the other two jobs. The third was the brand-scrape route, which reads a public page and returns colours and writes nothing; it is now registered as needing no edit lock, with that reason. The audit reports 0 problems.

## Tests

- Studio unit: 252 (`lib/copilot/operations.test.ts` 18: coercion and bounds, transitions allowed and refused, the change number under gaps and concurrency, the memory store, the recorder, the save words, the kicker, ⌘Z observed, Restore and Reapply rules).
- Mutation-checked: 22 mutations over the transitions, coercion, numbering, retry, save words, kicker, ⌘Z observation, comparison, Reapply and Restore — 17 caught at first, the 5 survivors closed with one test.
- The table checked in a transaction that rolls back: a duplicate change number and an unknown status are refused; the list's `before->>meta` flag reads.
- Browser `scripts/history-test.mjs` (8): an engine change applied and recorded with its prompt, source, targets, applied list and engine operations; a simulated conflict shows Not saved with the reason and a retry; a model turn records its call; refused and answered turns are recorded; after a reload the history is still there and numbering continues (#002 after #001); Compare, Reapply and Restore; ⌘Z and ⌘⇧Z; a failed grammar proposal leaves no undo step. The other Intelligent-mode suites pass, two reading the honest kicker (`APPLIED · SANDBOX (NOT SAVED) · AI CHANGE #001`).

## Not done here

- The database half of the store has run against the table's constraints but not through PostgREST in this environment (the service key is never handled here); the memory half is what the suites exercise.
- After a reload, an entry lists what was applied, not the Created / Modified / Removed lines (they are not stored).
- ⌘Z is observed while Intelligent mode is open; it catches up on return.
