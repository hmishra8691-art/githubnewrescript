# Logic Builder UI rendering fix + Validation Rules on the Universal Logic Engine

Two screenshots showed the Logic Builder visibly broken — a COUNT condition
under Display Logic with an oversized quick-select box and an invisible
sliver where the operator/value controls should be, and Auto Punch's
Simple/Expression mode buttons overlapping their own text
("SimplExpression"). A 43-section brief followed, asking for a root-cause
fix to the shared condition-row renderer (not an isolated patch, so the same
bug can't reappear for the next function) plus upgrading Validation Rules
from flat required/min/max checks to the same Condition-tree engine that
already powers Display Logic, Skip Logic, and Auto Punch.

Both root causes were confirmed **live**, not guessed — a throwaway
Playwright repro against the running Studio dev server reproduced each
screenshot's exact defect and captured computed-style dumps that pinned down
the CSS mechanism, before any code was written. That same discipline
(documented for this codebase's prior masking, universal-logic-engine, and
universal-auto-punch briefs) held here too: most of the Logic Builder's
architecture — nested AND/OR/NOT groups, Visual⇄Expression mode switching,
the unified source picker, type-aware operators — was already correct and
untouched; the bugs were two narrow, well-understood layout defects. On the
Validation side, the load-bearing engine plumbing (a `when`-gated Condition
field, the calc engine, dependency tracking) already existed — the work was
a UI plus two small, additive schema/engine changes, not a rebuild.

## Part A — the two rendering bugs

**Bug 1 — `.cond-rule`'s CSS Grid swallowed COUNT/expr sub-editors.**
`.cond-rule` (`apps/studio/app/globals.css`) was an implicit 2-column CSS
Grid (`minmax(0,1fr) auto`) with no `grid-template-areas`. A
conditionally-rendered sub-editor — `CountEditor`'s `.count-editor` or
`ExprEditor`'s `.expr-editor`/read-only branch — sits between the main
row and the remove button in the JSX (`ConditionBuilder.tsx`'s
`RuleEditor`), and with no `grid-column` override it got auto-placed into
the column meant for the remove button. That column's track then sized to
the sub-editor's own content width (measured live at 327px), starving the
`1fr` column down to its explicit `0` floor — collapsing the source/
operator/value controls to an invisible sliver while the sub-editor ate the
row. Fixed with named `grid-template-areas` (`"main actions" "extra
extra"`) and a position-based selector — `.cond-rule > div:not(.cond-rule-
main):not(.cond-rule-actions)` — so any sub-editor, present or future,
always gets its own full-width row regardless of DOM order. No fixed
heights anywhere; both grid rows stay content-sized. Confirmed fixed via the
same computed-style/bounding-box technique that found the bug, for both
`.count-editor` and an `expr`-sourced rule's `.expr-editor`.

**Bug 2 — Auto Punch's rule header overlapped its own buttons.**
`AutoPunchEditor.tsx`'s per-rule header used the bare `.row` utility
(`display:flex`, no `flex-wrap`) to hold an unbounded-length mono
`ap-rule-text` span next to three `white-space:nowrap` buttons. Once the row
was narrower than its content, flex-shrink squeezed the buttons below their
own text's natural width, and the un-reflowable text overflowed into the
next button ("SimplExpression"). Fixed with a dedicated `.ap-rule-head`
(wraps) / `.ap-rule-actions` (a non-shrinking group that travels and wraps
together) pair, plus a `title` attribute so the full expression survives
even when the visible text is ellipsized.

Both fixes are in the one shared component tree Display Logic, Skip Logic,
and Auto Punch's "Only when" condition all render through — fixed once, not
patched per call site, per the brief's explicit instruction.

## Part B — Validation Rules on the Universal Logic Engine

**Schema** (`packages/schema/src/question.ts`): `ValidationRule` gained one
enum value, `"condition"`, and one new field, `check: Condition.optional()`
— kept separate from the existing `when` (which stays a pure enable/gate on
every kind) because a rule can legitimately want both: "only run this
cross-question check once Q3 is answered" (when) independently of "fail
when Q5 > Q6" (check). Condition **true** means the rule **fails**, matching
how a programmer reads "IF Q5 <= Q6 THEN invalid."

**Engine** (`packages/engine/src/validate.ts`): one new `case "condition"`
in `checkScalarRules`'s switch — `if (rule.check && evaluateCondition(rule.check,
ctx)) fail(...)`. Because `checkScalarRules` is already the one function
called for scalar answers, matrix/composite columns, and matrix/composite
rows alike, this single case makes `kind:"condition"` validation work
everywhere at once.

**UI** (`apps/studio/components/studio/PropertiesPanel.tsx`): picking
`"condition"` from a validation rule's kind select renders `<ConditionEditor>`
— the exact shared component Display/Skip Logic and Auto Punch already use,
not a fork — inside a card wrapper, matching how `SkipLogicEditor` wraps its
own rules. Its own internal Visual⇄Expression tab bar *is* the "mode"
toggle the brief asked for; "Simple mode" is just picking one of the
existing flat kinds instead. Also added: a `lintPipingTokens` warning on the
rule's message (the one real gap versus how question text is already
linted), and message piping resolution itself (`resolvePiping`, wired once
into `validateQuestion`'s single `push` closure so every rule kind's
message gets piped, not just `"condition"`'s).

**A real, load-bearing finding while building the cross-question test**: a
bare `ConditionRule.value` is a literal, never resolved as "the live answer
of another question" (`resolveComparisonValue` only special-cases `$option`
refs). So "Q5 > Q6" is **not** expressible by picking Q5, an operator, and
Q6 from the plain visual row — it's expressible by typing the comparison as
an **arithmetic run** in the same builder's Expression tab: `Q5 - Q6 > 0`,
which `logicExpression.ts` is deliberately built to parse (its own doc
comment: "so an expression like `Q5 + Q6 > 100` can…") into a rule whose
*source* is the arithmetic expression and whose *value* is the literal 0.
This is confirmed working end-to-end against the real runtime (Q5=10,
Q6=5 blocks; raising Q6 to 20 clears the block) — the initial plan's
description of cross-question validation as "just pick two questions and
compare them" was imprecise about the mechanism; the capability is real,
the authoring path is the Expression tab, not the Visual row's value field.

**Coverage confirmed with zero new Condition-source/operator work**: matrix
cell (`ConditionSource.rowCode`/`columnId`, already rendered by the shared
row/column pickers — proven against a real `matrix_numeric` question), COUNT
(the existing `∑ count` toggle, proven with `COUNT(Q7) < 3`), string/list/
loop conditions (all just Condition trees against operators that already
exist). VALID/INVALID/WARNING needed no new outcome model — the existing
`severity: "error"|"warning"` field already covers blocks-vs-warns.

**"Test Condition" and pre-save validation — both free.**
`LogicTracePanel.tsx`'s target registry gained one loop appending each
question's `kind:"condition"` rules; the existing trace UI (typed
hypothetical answers, the same `traceCondition` call every other target
uses) covers validation for free. `validateLogicTree`, already called
inside `VisualConditionEditor`, covers pre-save syntax/reference checking
the same way, with no new call site needed.

**`dependencies.ts`**: `conditionRefs(def, v.check, into)` added alongside
the existing `when` walk (question-level, and the row/column validation
arrays that have no editor UI yet but get the same treatment for free); a
new `exprStringRefs` helper (reusing `referencedNames`, the same scanner
`calcQuestionRefs` already uses for calc expressions — no second parser)
closes a real, separate gap where a `custom_expression` doing cross-question
validation could fail to re-fire live on the same page. `pipingRefs`, which
already existed for question text, is reused for validation messages too.

## Deliberately not built, and why

- **A second condition language for validation.** `check` reuses the exact
  `Condition` type and `ConditionEditor` component every other feature
  shares — no forked schema, no forked UI, satisfying the brief's explicit
  "do not duplicate slightly different implementations" instruction.
- **A new value-reference kind so the Visual row's value field can point at
  another question.** The arithmetic-run mechanism `logicExpression.ts`
  already has covers every cross-question numeric example in the brief;
  adding a second way to express the same comparison would be exactly the
  kind of parallel mechanism this codebase's history has repeatedly declined
  to build.
- **A third validation outcome beyond error/warning.** Already covered by
  the existing `severity` field.
- **A new debug UI for "Test Condition."** `LogicTracePanel` already existed
  and needed one registry entry, not a new panel.

## Tests

- `scripts/cond-rule-grid-test.mjs` (new, 8 checks): computed-width and
  bounding-box assertions proving `.cond-rule-main` and a COUNT sub-editor
  no longer collapse/overlap, the same for an `expr`-sourced rule, the
  remove button stays on the main row regardless of extra rows, and no
  horizontal overflow.
- `scripts/autopunch-header-test.mjs` (new, 6 checks): pairwise bounding-box
  checks across the chain-mode select, rule text, and all three buttons at
  both the default and a narrowed viewport, plus the `title` attribute
  carrying the untruncated expression.
- `scripts/validation-condition-test.mjs` (new, 12 checks): kind:"condition"
  renders `ConditionEditor`; a cross-question numeric check is built via
  the Expression tab and proven live against the real runtime (blocks, then
  clears when the comparison flips); COUNT and matrix-cell checks build
  correctly; Expression→Visual→Expression round-trips byte-for-byte; the
  Logic tab's trace lists the new target; message piping is lint-checked
  and a bad reference is flagged.
- Full existing suite re-run for regressions on the changed surfaces
  (`count-logic-test.mjs`, `autopunch-media-test.mjs`,
  `named-expressions-test.mjs`, `logic-builder-test.mjs`,
  `save-integrity-test.mjs`, `qa-fixes-test.mjs`, `option-logic-test.mjs`,
  `autopunch-matrix-test.mjs`, `properties-accordion-test.mjs`) — all green.
- Full monorepo bar: `pnpm -r typecheck && pnpm -r build && pnpm -r test` —
  clean across all 12 workspace projects.
- Full browser corpus (`node scripts/verify-browser.mjs`, all 61
  discoverable suites — 58 pre-existing plus the 3 new ones; 3 more skipped,
  as always, for needing Postgres): **61 of 61 passed**, 35.9 minutes.

### An environment trap worth recording

Mid-verification, running `pnpm -r build` (a production `next build`) while
the Studio and Runtime `next dev` servers were still running against the
same `.next` directories corrupted their dev-mode asset manifests — every
route kept returning HTML but every JS/CSS chunk 404'd, so nothing ever
hydrated and every browser suite failed identically regardless of what it
tested. The dev server processes also didn't show up under `ps aux` in this
sandbox (visible only via a raw `/proc` scan), so `pkill`-based cleanup
looked like it worked while a stale server silently kept holding the ports.
Fix: never run `next build` in a directory a `next dev` instance is using;
if dev servers must be restarted, delete `.next` first and confirm the port
is actually free via `/proc` (or a raw `http.createServer` bind test), not
just `ps aux`/`lsof`, before relaunching.
