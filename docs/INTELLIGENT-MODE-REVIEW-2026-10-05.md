# Intelligent Mode, Phase 4 — the review, what can be done to what is selected, and what it is wired to

*Intelligent Mode upgrade, Phase 4. Built 2026-10-05 on Phases 2–3. It fixes the audit's R13 (a flat, all-or-nothing review), R14 (sideways scrolling) and R15 (no option-level selection, no context actions, the dependency view hidden), and the brief's §2, §3, §6, §7, §11 and §21.*

## The review

The Changes panel renders the engine's change tree (`changeItems`, Phase 2) instead of a three-column table:

- **Impact first.** "Impact: N dependent objects", with severity chips (breaks / changes / to review) and the list behind it, each item navigating to the object.
- **Survey, then blocks, then one card per question.** The card's header is one line — "Q7 · Single choice · Do you own a car?" — with the number of its changes; cards start collapsed when more than four questions change.
- **One row per change.** The category (Wording, Option label, Display logic, Masking, …), "Option 4 — United States" for an option, the field, the old value struck through and the new one below it (wrapping, clamped to three lines with "more"), "Affected: N" with the dependents, the destructive note, and the status: Proposed, Excluded, Partly excluded, or Refused with the engine's reason. The technical fragments are a collapsed section that wraps.
- **Selective apply.** Every card and row has a tick. An action is what the engine can leave out, so unticking a row excludes the actions behind it and says beforehand what else they made ("Unticking also excludes …"). Rows the engine could not attribute to an action (Q12's display logic pruned because Q11 is deleted) follow their cause: untick the deletion and that row reads Excluded. The engine credits every action that touched a question to all of that question's rows; the review narrows each row to the actions that can make that kind of change, so unticking Q7's skip does not untick Q7's relabelled option. Apply reads "Apply 7 of 9 changes", applies the included actions only — evaluated afresh, so an included action that needed an excluded one is shown refused — and the History entry and the audit record list what was left out.
- **Option preview.** Hovering or focusing an option row (or an option chip in the Inspector) shows its code, export value, flags (exclusive, other-specify, anchored), its own display condition, the question's randomization and mask, and what reads that option — the engine's impact of removing it.
- **No sideways scrolling.** The tab strip wraps onto two lines; every value, table and code block in the panel wraps. The browser suite checks `scrollWidth ≤ clientWidth` for the panel and everything in it at 260, 360 and 520 px, with a URL-length option label and a long condition in the proposal.

## What can be done to what is selected

`contextActions(def, target)` (engine) lists the operations valid for a question, one of its options, or a block, grouped (Logic, Options, Validation, Data, Structure, Inspect, Research). Validity is the engine's: the Options group only for a question with options; selection counts only for a multi-select; a range and "whole numbers" only for a number; an email check only for an open text; "make required" only when it is not; "add Other" only when there is none; "make None exclusive" only when it is not; a mask only from an earlier multi-select offering the same choices; AND / OR / remove only when the question has display logic; skip and page break only when questions follow. Each operation is a sentence for the engine's interpreter: a complete one is offered only after the interpreter has read it to actions or an answer (an operation it would refuse is never shown), and a click sends it through the same path as typing; a template ("Show Q7 only if …") fills the input box. The Inspector computes the list after the selection paints (about half a second on a 60-question survey), so selecting is immediate.

## What it is wired to

`dependencyReport(def, key)` (engine, extracted from the interpreter so the sentence "what depends on Q7?" and the view say the same) gives what reads an object, grouped — display logic, skips, validation, masking and carry-forward, piping, calculations, quotas, randomization and list logic, flow, the analysis plan, constructs, translations — then what is reached only through those, and what the object reads, grouped the same way. The Inspector draws it as a flow under the object ("Q7 ↓ Display logic: Q8, Q9 ↓ Skip logic … ↓ Analysis plan … ↓ Indirectly affected …"), every chip navigating. Selecting a question while no proposal is open turns the panel to the Inspector; with a proposal open the panel stays on Changes.

## Conditions the engine cannot read

A condition the engine cannot parse is not refused any more unless the failure is a near-miss name ("Q33" for Q3 — refused with the corrected sentence as the fix) or a code-shaped name that is not there. Otherwise ("show Q7 when Q3 is Yes or Maybe and Other is not chosen" — an option named without its question) the sentence goes to the model with what the engine detected, as an unrecognised sentence would; with no model, the grammar says what it could not read. "Q3 is Yes or Maybe" is now one question with two answers (`Q3 in [Yes, Maybe]`) when the plain reading fails and the right side names no question. Found by `codes-sync-test`, which had not been run after Phase 3.

## Where

| File | What |
|---|---|
| `packages/engine/src/contextActions.ts` (+ test) | `contextActions`, `ContextAction`, `ContextGroup` |
| `packages/engine/src/nlIntent.ts` | `dependencyReport`; conditions it cannot read go to the model; a missing code is refused with its nearest |
| `packages/engine/src/naturalCondition.ts` | "X is A or B" → `X in [A, B]` |
| `apps/studio/lib/copilot/review.ts` (+ test) | the review's pure part: `reviewTree`, `actionCategories`, `itemStatus`, `toggleItems`, `siblings`, `applyCount`, `presentIds`, `excludedLabels`, `optionFacts`, `typeName`, `questionHeader`, `groupContextActions` |
| `apps/studio/lib/copilot/client.ts` | `evaluateProposal(p, { excluded })` with results re-indexed to flat action indexes; `actionMap` |
| `apps/studio/components/intelligent/copilot/ChangeReview.tsx` | the review |
| `apps/studio/components/intelligent/copilot/ContextPanel.tsx` | actions for the selection, its options, the dependency map |
| `apps/studio/components/intelligent/copilot/{CopilotPanel,useCopilot,CopilotCard}.tsx`, `IntelligentView.tsx` | exclusions in the session, "Apply N of M", the panel turning to the Inspector on selection, ask / template wiring |
| `apps/studio/app/api/copilot/record/route.ts` | the audit record carries what was excluded |
| `apps/studio/app/design-system.css` | the review, the preview, the map; the wrapping tab strip |

## Tests

- Engine: 1613 (`contextActions.test.ts` 5, the interpreter's condition hand-off and "A or B" values, `dependencyReport` through the interpreter's existing answers).
- Studio unit: 234 (`lib/copilot/review.test.ts` 11: flat indexes and exclusions through `evaluateProposal`, a refusal caused by an excluded dependency, cascade rows following their cause, siblings, statuses, toggling, the Apply count, the history's "excluded", attribution narrowing, type words, option facts, context-action groups, and the edges mutation found).
- Mutation-checked: 37 mutations over `contextActions`, the condition hand-off, "A or B", and the review's pure part. All are caught, except six documented as equivalent:
  - three because the interpreter's own check already filters what the guard filters (a page break after the last question; a mask from a later question; a question joined as a value);
  - one because the list is already empty;
  - one because one attribution can only narrow to itself or nothing;
  - one because option-scope impact has no indirect items.
- Browser: `scripts/change-review-test.mjs` (11): the cards and rows, selective apply end to end (the excluded removal is not written; History says so), the option preview, no sideways overflow at 260 / 360 / 520 px in both tabs, the context actions (only valid groups; a ready action becomes an engine proposal; a template fills the input), the dependency map's navigation. All fifteen Intelligent-mode suites pass, including the five not run after Phase 3 (`codes-sync`, `default-value`, `mode-sync`, `multimodal-foundation`, `product-surface`); `mode-sync` now applies its display-logic change from the engine's card; `copilot-test` and `intelligent-mode-test` read the new review rows.

## Not done here

- Grid rows and columns have no hover preview yet.
- An option selected in the panel is the panel's own selection; the Studio-wide selection is still the question.
