# Universal Auto Punch Engine + collapsible Properties panel

A 53-section brief asked for two things: turn Auto Punch into a
question-type-independent programming engine (any source, any target
including matrix/grid cells, priority-based conflict resolution, a debug
trace naming the winner) and redesign the right-side Properties panel into
independently collapsible sections. Both were checked against the shipped
code before anything was written — the same discipline this codebase's
history already documents for the masking and universal-logic-engine briefs
(`claude/masking-and-sets.md`, `claude/universal-logic-engine.md`): most of
the brief already existed. The real work was five concrete engine/schema
gaps, the UI to reach them without silently losing data, and the panel
redesign.

## What already existed (verified in source, not assumed)

Auto Punch already ran on the one universal Condition engine for its
trigger (`PunchRule.when`, the same tree/evaluator as display logic and
skip logic); already had synchronized Visual ⇄ Expression modes
(`AutoPunchEditor.tsx`'s `simpleView`/`parsePunchExpression`, and
`MaskingBuilder.tsx`'s `SetChainEditor`); already supported IF/ELSE-IF/ELSE
chains (`PunchRule.mode`, `walkPunchChain`); already reacted live on the
same page via a dependency graph (`questionDependencies`, `Runner.tsx`);
and already had a debug trace panel wired into the Studio Logic tab
(`LogicTracePanel.tsx` → `tracePunches()`). COUNT-based and calc/expr
conditions, loop-item conditions, and 8 of the ~12 listed action types were
all already there. See the plan file's "what already exists" table for the
full, source-verified list — it is not repeated here.

## The five gaps closed

**1. Matrix/grid cells as an addressable punch target — and a real bug
fixed.** `resolvePunches`'s source set already resolved against a target's
row/option codes, but `applyPunches` then did
`ctx.state.answers[key] = result.select[0]` unconditionally. A matrix or
composite answer is `Record<rowCode, value>`, not a scalar — so the moment
such a question carried a `select`-action punch rule, the entire per-row
answer object was silently replaced by one bare code. This was reachable
today (`MaskingBuilder.tsx`'s punch editor rendered for every question
type) with zero test coverage. Fixed by adding `targetRow?`/`targetColumn?`
to `PunchRule` (schema) and a genuine cell-write path in `resolvePunches` /
`applyPunches` (engine): a `PunchCellWrite` per addressed cell, applied
through a shallow-copied `base` object that reads/writes exactly one row or
row+column, leaving every sibling row and column untouched. The pre-existing
whole-answer path is completely unchanged when neither field is set — every
existing survey behaves exactly as before.

**2. Loop items and calculated values as the punch *payload*, not just the
trigger.** `SetExpr` (the "which codes get punched" vocabulary) gained two
leaf kinds: `loopItem` (`CURRENT_ITEM` / `CURRENT_ITEM_CODE` /
`CURRENT_ITEM.<ref>`, resolved via the same `findLoopScope`/`loopValue`
pair the condition side already used) and `expr` (`EXPR(<calc expression>)`,
parsed as an opaque token by an extended tokenizer and validated through
the existing calc engine at parse time — no new evaluator). `validateSetExpr`
gained matching checks: a loop-item reference outside any loop warns, and an
`expr` with a syntax error is rejected before save.

**3. Explicit priority + a trace that names the winner.** `PunchRule` gained
an optional `priority` (absent = 0, so every existing survey is
unaffected). Rules are now ordered by priority ascending before the
last-applied-wins chaining runs (`byApplicationOrder`, engine-local), so
"last wins" becomes "highest priority wins, ties keep original order" —
one new field instead of a 6-strategy conflict-resolution selector. Applied
narrowly: priority is a guaranteed winner for `set_value`, for cell-targeted
writes, and for same-code select/deselect conflicts — but **not** for two
independent rules proposing two *different* codes into one single-select
whole-answer slot, where the pre-existing (deliberate, documented)
array-order-wins behavior was left untouched rather than risk changing
already-working surveys. `tracePunches()` now returns `finalValue` (the
actual combined write, computed the same way `applyPunches` would) and
`conflicts: string[]` — human-readable lines naming every rule that
proposed a value for a target and which one the target actually ended up
with, whenever ≥2 independent applied rules disagree. This is now wired
into the Studio's Logic tab trace panel (`LogicTracePanel.tsx`): each
applied rule shows what it individually resolved to, and a "Conflicts
resolved by priority" card appears whenever there's something to explain.

**4. Same-page reactivity for calc-gated punches.** `conditionRefs`
(`dependencies.ts`), which builds the dependency edges the Runner uses to
decide what to live-recompute on an answer change, resolved `question` and
`variable` condition sources but not `calculation` sources — so
`IF CALC_SCORE >= 5` could fail to re-punch live when the *question* behind
`CALC_SCORE` changed on the same page (it worked fine on next-page arrival,
since calculations always run first there). Fixed with `calcQuestionRefs`,
which walks a calc's expression to the questions it transitively reads
(including calc→calc chains, cycle-guarded).

**5. Studio UI reach.** The option-to-option Auto Punch DSL
(`AutoPunchEditor.tsx`) has no syntax for `targetRow`/`targetColumn`/
`priority` — viewing or auto-applying such a rule through it would have
silently dropped those fields. A canonical `isOptionLevelPunch` guard
(engine, shared by `simpleView` and both Studio rendering filters) keeps
any cell- or priority-carrying rule out of that DSL entirely; it is only
ever edited through the "auto-select from a set" editor
(`MaskingBuilder.tsx`'s `PunchRules`), which gained: a Row picker (shown
whenever the target has rows) and a Column picker (shown once a row is
picked, when the target also has columns); a `priority` number input; an
adaptive mapping "to" control (the addressed cell's own options when it has
any, a free-text input otherwise); `set_value` and `clear` as first-class
actions; and an inline error when a stored row/column no longer resolves.
Auto Punch was also extracted out of being nested inside masking into its
own top-level Properties section, since it targets any question type
(numeric, hidden, matrix/composite cells), not just the choice-like types
masking applies to.

## Deliberately not built, and why

- **A generic, config-driven action engine** (new `increment`/`decrement`/
  `append`/`remove` primitives). `select` + mapping, `deselect`, and
  `set_value` with a calc-expression payload cover every example in the
  brief itself. This is the same restraint `claude/universal-logic-engine.md`
  already documented for a near-identical ask.
- **A 6-strategy conflict-resolution selector.** Priority + deterministic
  last-wins-by-order + a trace that names the winner gives full control and
  full visibility with one new field, not six new behaviors to build, test,
  and document.
- **A 7-option execution-timing dropdown.** Two real triggers exist (page
  arrival, same-page dependency-driven live recompute) and now cover every
  timing the brief lists — "on calculation update" was gap #4, fixed by
  extending the existing dependency graph rather than adding
  user-facing configuration for timings with no distinct engine behavior.

## Properties panel: independently collapsible sections (Part B)

New `CollapsibleSection` component
(`apps/studio/components/studio/CollapsibleSection.tsx`), modeled directly
on `QuestionsPanel.tsx`'s existing block-collapse pattern (same `▸`/`▾`
glyph, same "collapsed content is not rendered" behavior) rather than a new
visual language. Local `useState`, keyed by section id — **not** a global
store slice, and never written into `def`: expand/collapse is a UI
preference that must never alter survey logic, touch undo history, or reach
autosave, and a plain `useState` satisfies that by construction rather than
by convention. A section's `active` prop (whether it already carries
configuration) picks only its *initial* open state; once a programmer has
toggled it by hand, later renders never override that choice. The
"configured" indicator is a `●` glyph with `aria-label="configured"`, not
color alone.

`PropertiesPanel.tsx` wraps every section — Display logic, Skip logic,
Carry-forward, Option groups, Randomization (+ its conditional-randomization
sub-block), Masking, List logic, List operations, Row masking, Column
masking, Auto punch, Validation rules, State, Custom code — in
`<CollapsibleSection>`, each with a cheap, already-computable `active` read
(`!!q.mask`, `(q.punches?.length ?? 0) > 0`, `!!q.displayLogic`, etc.) and no
change to what's inside each body — every existing `data-testid` a browser
test clicks into is exactly where it was. A `Search Properties…` input
filters the section list by title substring, purely client-side, touching
nothing about the underlying survey. The panel's outer scroll container
(`.rightpanel`, `overflow-y: auto`) already scrolled independently of the
canvas; no layout change was needed to satisfy "the canvas stays stable."

## Tests

- `packages/engine/src/autoPunchMatrixCell.test.ts` (12, new): the bug-fix
  regression (a per-row object survives, not replaced by a scalar), plain
  matrix row punch, missing-row unmatched reporting, composite cell punch
  with siblings untouched, composite select-column option validation,
  priority via `set_value`, priority-absent order preservation, `loopItem`
  in/out of a loop, `expr` via the calc engine, parse/format round-trip for
  `CURRENT_ITEM`/`EXPR`, a `validateSetExpr` loop-outside warning, and
  `tracePunches` naming a conflict's winner.
- `packages/engine/src/dependenciesCalcPunch.test.ts` (3, new): direct
  calc-gating, a transitive calc→calc chain, and a self-referential cycle
  that does not hang.
- Full pre-existing engine suite (756 tests) — zero regressions.
- `scripts/autopunch-matrix-test.mjs` (new): builds a composite cell punch
  rule through the actual Row/Column pickers and mapping control in Studio;
  confirms the Logic tab's trace names the resolved cell; then, in the real
  runtime, hand-answers two sibling cells before the trigger fires, fires it
  live (same-page, not just page-arrival), and asserts only the addressed
  cell changed.
- `scripts/properties-accordion-test.mjs` (new): a section with existing
  configuration opens by default, every other section starts collapsed,
  toggling one section never affects another, collapsing/reopening a
  section changes nothing about the survey definition (byte-for-byte),
  a typed value survives a collapse/reopen round trip, the configured `●`
  indicator appears even while collapsed, the search box narrows the
  section list without touching content, and opening every section doesn't
  resize or reflow the canvas.
- Existing suites updated for the accordion (sections now default
  collapsed, so a test that used to find an element immediately now expands
  its section first): `masking-test.mjs`, `option-groups-test.mjs`,
  `option-logic-test.mjs`, `blocks-test.mjs`, `expression-editor-test.mjs`,
  `logic-builder-test.mjs`, `qa-fixes-test.mjs`, `save-integrity-test.mjs`.
  No test's actual assertions changed — only the setup needed to reach a
  now-collapsed section.
- Full browser corpus (`node scripts/verify-browser.mjs`, all 58
  discoverable suites — 3 more skipped, as always, for needing Postgres):
  **58 of 58 passed**, ~35 minutes.
- Full monorepo bar: `pnpm -r typecheck && pnpm -r build && pnpm -r test` —
  all clean across all 13 workspace projects.

## Acceptance criteria → where proven

| criterion | proof |
|---|---|
| `Q20[Apple] = "Very Satisfied"` cell targeting | `autoPunchMatrixCell.test.ts`, `autopunch-matrix-test.mjs` |
| The whole-answer scalar-overwrite bug is fixed | `autoPunchMatrixCell.test.ts` "plain matrix row punch" / "composite cell punch" |
| Loop item / calculated value as punch payload | `autoPunchMatrixCell.test.ts` loopItem/expr cases |
| Explicit priority + trace names the winner | `autoPunchMatrixCell.test.ts` priority + trace tests; `autopunch-matrix-test.mjs`'s trace assertions |
| Calc-gated punch re-fires live on the same page | `dependenciesCalcPunch.test.ts` |
| No second/generic action engine | `autoPunch.ts`/`setExpression.ts` reuse the existing evaluator and `PunchAction` enum; nothing new added |
| Properties panel: independently collapsible, non-color-only indicator | `properties-accordion-test.mjs` |
| Collapse/expand is UI-only, never alters survey logic | `properties-accordion-test.mjs` "§45" checks |
| Existing functionality not broken | full engine suite (756) + full browser corpus (58/58) both green |
