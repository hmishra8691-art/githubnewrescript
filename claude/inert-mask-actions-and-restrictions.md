# Inert mask actions, and four restrictions that refused working rules

A follow-on pass closing the "removable restrictions" list from
`claude/logic-compatibility-audit.md` — the items that audit judged arbitrary
rather than technically necessary. Claiming a restriction is removable and then
leaving it in place is worse than not having said so, which is why these came
next.

## Three mask actions that did nothing at all

`MaskAction` offers five values. `display` and `remove` worked.
`preselect`, `display_and_preselect` and `disable` were **storable, offered in
the picker, exported into the spec — and applied by no code anywhere.** The
switch in `applyMask` returned the list untouched with a comment claiming "the
runtime reads the set for ticking/disabling"; a repo-wide search found no such
reader. `listPunches` in `autoPunch.ts`, which computes disable/enable sets,
turned out to have **no callers either**.

This is the exact failure mode `claude/inert-and-security-close.md` exists
about, and it is worse than a missing feature: the programmer configured the
survey, saw the setting persist, saw it in the JSON, and had every reason to
believe it was live.

Both are now routed through mechanisms that already existed, rather than new
ones:

- **`disable`** sets `meta.disabled` on the options *outside* the set — the
  same flag an auto-punch `disable` rule sets a few hundred lines below in the
  same file, so the renderer needed no new concept and the two features cannot
  disagree about what "disabled" looks like.
- **`preselect` / `display_and_preselect`** tick the set at **prefill** time,
  beside auto punch, in a new `applyMaskPreselect`. It could not live in
  `applyMask`: that is a pure view function called on every render, and writing
  an answer from there would fight the respondent for the field. Two rules keep
  it safe — it only ever writes into an *unanswered* question (re-applying would
  make an unticked option impossible to remove), and it can only tick codes the
  question actually shows (the same rule the mask itself follows, where a set
  filters an existing list rather than inventing codes).

## Always-show, untangled from the empty-source fallback

Whether a protected "Other" / "None of the above" survived a mask was derived
from `onEmptySource` — a field describing an unrelated concern. Choosing
`show_none` because an unanswered source should show nothing *also*, silently,
let the mask delete "Prefer not to say". Two different decisions, one control.

`protectAlwaysShow` states it explicitly. Absent, protection is derived exactly
as before, so no stored mask changes behaviour — pinned by a test that a mask
with neither field set keeps its special code.

## Two operator tables that refused rules the evaluator handles

The linter raises a **blocking error** for a disallowed operator, so these were
not cosmetic — they refused rules at author time that would have evaluated
correctly at runtime:

- `choice` gained the numeric comparators. A `matrix_single` cell holds a scale
  point, and "this row was rated 4 or better" is the most ordinary question
  anyone asks of a grid.
- `ranking` gained `containsAny`/`containsAll`/`containsNone`. A ranking answer
  is an ordered array and `evaluate.ts` implements all three on arrays; "did
  they rank any of these three brands at all?" was implemented, offered nowhere,
  and rejected if written.

## Two more one-line reaches

The masking source picker filtered to questions with options or rows, although
`codesFrom` handles a scalar answer, an array and a per-row object uniformly —
so a hidden question populated programmatically (which the masking spec asks
for by name), an embedded-data field or a numeric answer were all engine-
supported and UI-blocked.

`SetExpr`'s `loopItem` leaf gained the `scope` field `ConditionSource` already
had, so an inner loop's mask can read the **outer** loop's item — "show the
products for the brand the outer loop is on" was inexpressible purely because
one field was not copied across.

## The loop simulator now says which questions run (§39)

It reported item count and references; the brief wants "see exactly which
questions would execute". Each simulated iteration now carries its question
list, resolved through `visibleQuestions` **in that iteration's own context** —
so an iteration where a follow-up is hidden by a rule reading `CURRENT_ITEM`
shows a shorter list, which is the whole reason to simulate rather than count.

Worth recording for next time: `loops.ts` cannot import `flow.ts`, because
`flow.ts` imports `loops.ts` and this package keeps that cycle open
deliberately (`loopModel.ts` exists for the same reason). The resolver is
**registered** by `flow.ts` instead — the identical pattern
`carryforward.ts` uses with `registerEffectiveRowsResolver`. Unregistered, the
simulator behaves exactly as it did.

## Tests

`packages/engine/src/maskActions.test.ts` (new, 12 cases). Engine suite
810 → 822. The load-bearing ones are the negatives: a preselect must not
overwrite an answer the respondent gave, must not tick an option the question
does not show, and a mask with neither always-show field set must behave
exactly as it always did.

Full monorepo typecheck/build/test clean across all nine suites;
`masking-test`, `loop-test` and `option-logic-test` pass unchanged; full
browser corpus **61 of 61**.

## Still open from the audit's list

`when` has no editor; ranking selection bounds are offered by one panel and
denied by another; column masking records no debug trace. And from the loop
spec: per-iteration declarative calculations and cross-iteration accumulators
(which need an idempotence ledger, since the flow recompiles constantly), and
an execution timeout.
