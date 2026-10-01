# Where nested logic cannot be applied (audit, 2026-09-28)

> **Status (2026-10-01):** most items are fixed. See `NESTED-LOGIC-IMPLEMENTATION-2026-10-01.md`
> for what changed and what remains.

Scope: `packages/schema`, `packages/engine`, `packages/renderer`, `packages/import`,
`packages/exporters`, `apps/studio`, `apps/runtime`, `apps/interviews`, at `main` 7caaf68.

**Baseline.** The logic type `Condition` (a rule, or an AND/OR/NOT group of any depth) is
evaluated correctly at any depth by `evaluateCondition` (`engine/evaluate.ts:766`).
- A multi-child NOT means "none of these".
- Empty groups are ignored.

The shared Studio builder `ConditionEditor` (`studio/components/studio/ConditionBuilder.tsx:793`)
nests to any depth in both its Visual and Expression tabs, and 38 of the 43 authorable
`Condition` fields use it. The gaps are listed below. Items marked **(verified)** were reproduced
by running the built engine.

## 1. Features with no Condition at all (nothing can be combined)

| Feature | Where | What it has instead |
|---|---|---|
| UX behaviours | `schema/ux.ts:114`, `engine/ux.ts:930` | One `on` event plus an option list (OR'd). No `when`, no other question, no AND/NOT. Only a sandboxed script escapes this. |
| UX style rules | `schema/ux.ts:62` | One `state` + one `media` + one `whenClass`, implicitly AND'd. No NOT, no OR. |
| UX animations | `schema/ux.ts:84` | One `trigger` enum. |
| Custom scripts | `schema/survey.ts:151` | `scope` + `event` only. No `when`, although the `conditions.ts` header claims script guards. |
| Randomizer node | `schema/flow.ts:278` | `show: N` only. No `visibleIf`, no per-child rule. Must be wrapped in a block or branch. |
| `quota_check` node | `schema/flow.ts:390` | `quotaIds` + `onFull`. No `when`. |
| Quota as a whole | `schema/survey.ts:60` | Cells take a Condition, but `mode`/`onFull` are per quota, there are no quota groups, and the `quota` source only reads the total. |
| End / terminate node | `schema/flow.ts:406` | Conditional only by where it sits. |
| Embedded-data fields | `schema/flow.ts:373` | No per-field `when`. Conditions go through the calc language (see §4). |
| Attention check | `question.ts:1120` | `expectedCodes` (OR). Terminating goes through a skip rule. |
| Quality built-in rules | `schema/quality.ts:57` | Numeric params. Only `customRules[].when` is a tree. |
| Carry-forward / list source selection | `optionLogic.ts:42`, `question.ts:492` | Enums, one source. |
| Conjoint prohibitions | `designs/conjoint.ts:34` | Level pairs only. |
| Test-case expectations | `templates/testCases.ts:71` | Flat AND of lists and exact values. |
| Distribution / invitations / reminders | `studio/app/api/surveys/[id]/respondents/route.ts` | Status/list filters. No condition on respondent or embedded data. |

## 2. Condition fields with no editor (JSON or copilot only)

| Field | Where | What the UI does |
|---|---|---|
| `ValidationRule.when` (incl. row validation) | `question.ts:342` | Not shown. Kept on edit. |
| `Option.visibleIf` (legacy) | `question.ts:231` → `OptionLogicEditor.tsx:138` | A "legacy" warning chip with "remove it". The condition itself is not shown. |
| Grid `QuestionRow.visibleIf` | `question.ts:562` | Same legacy chip. Form-style rows do have the full editor (`QuestionsPanel.tsx:896`). |
| `ListLogicRule.when` | `question.ts:498` → `PropertiesPanel.tsx:1237` | Not shown. |
| `CarryForward.where` | `question.ts:514` → `PropertiesPanel.tsx:1067` | Not shown. |
| `ListFillOption.eligibleWhen` | `listFill.ts:175` → `ListFillPanel.tsx:245` | Only a boolean checkbox. |
| `CountSpec.where` (the condition inside a COUNT rule) | `conditions.ts:247` | No editor, no text syntax. See §3. |

## 3. Faults in the shared editor

1. **Data loss (verified):** the Expression tab commits on blur whenever the text parses
   (`ExpressionEditor.tsx:224`). The printer cannot write `count.where`, which prints as
   `COUNT(Q1, ) >= 2`. Clicking into the Expression box and out again deletes the
   COUNT's `where`. Row/option positions and `$question` `read:"count"` are also not printed.
2. **An empty child group prints broken text (verified):** `AND[Q2=1, AND[]]` → `"Q2 = 1 AND "`,
   `NOT[AND[]]` → `"NOT "`. This affects every caller of `formatCondition`: punch text, loop
   descriptions, diagnose text and the logic diff.
3. **A top-level NOT is invisible in the Visual tab.** `NOT Q1.A` looks like `Q1.A`, and you
   can't remove the NOT there (`setGroupConnector` refuses NOT groups, `logicTree.ts:220`).
   "+ Add condition" puts the new condition inside the NOT.
4. **"Ungroup" on a NOT group drops the negation** (`logicTree.ts:326`): `NOT[A]` → `A`.
5. **Auto-punch Simple mode** (`AutoPunchEditor.tsx:84`) is single-rule by design.
   - It is correctly disabled for nested logic.
   - But editing an ELSE IF rule in Simple mode turns it back into IF and resets `recompute` and `ignoreUnmatched` (a separate bug).

## 4. Text languages and AI

- **Expression parser** (`logicExpression.ts`):
  - Precedence is NOT > AND > OR. Parentheses nest to any depth.
  - `&&`, `||`, `!` and `<>` are not accepted.
  - There is no syntax for COUNT `where` or for row/option positions.
- **Calc language** (`calc.ts`; calculations, `custom_expression`, `{{expr:}}` piping, embedded expressions):
  - Supports `and/or/not/if()` to 64 levels.
  - Cannot use named expressions, COUNT specs or option-level references.
  - `countif` takes one criterion.
- **Embedded `IF…THEN…ELSE`** (`embedded.ts:183`) nests only in the ELSE tail. An IF inside THEN is likely mangled.
- **Intelligent-mode grammar** (`studio/lib/intelligent/grammar.ts`, `proposal.ts`):
  - Nesting only comes from an explicit AND/OR/NOT or brackets.
  - "A unless B" after a `when` fails.
  - There are no rewrites for either/or, neither/nor, "but not", "except".
  - A new display rule replaces the existing one instead of combining with it.
  - There are no intents for quota, branch, randomizer, punch, calculation or conditional validation.
- **Copilot actions** (`surveyActions.ts`):
  - Conditions are expression text only; a structured tree from the model is refused.
  - `set_validation` has no `when` and no condition kind.
  - `create_branch` makes one arm with no otherwise.
  - Randomizer, loop, embedded and calculation actions take no condition.
- **Punch expression** (`autoPunch.ts:169`): a condition containing the word "then" breaks the IF…THEN split. ELSE only exists as a mode.

## 5. Editors that cap nesting

| Editor | Where | Cap |
|---|---|---|
| Analytics filter builder | `studio/components/analytics/FilterBuilder.tsx:96` | 3 levels. Question variables only, no COUNT. Saved filters combine by flat AND; reports apply one at a time. |
| Interview builder | `apps/interviews/components/builder/LogicEditor.tsx:182` | One level of grouping, no NOT in the UI. An existing NOT is shown as "all of these". |
| Response Manager | `ResponseManager.tsx:240` | The condition is a full tree, but status/source/environment/search are ANDed around it and can't be OR'd. |

## 6. Engine functions that mishandle nested logic

**Wrong results at runtime:**
- **Deleting a question** (`references.ts:204`, verified):
  - A COUNT whose `where` names the deleted question loses its whole `count` and becomes a plain comparison.
  - Removing one child of AND/OR/NOT silently broadens the logic, and the delete dialog doesn't report it.
  - Right-hand `$question` references are never pruned.
- **Renumbering option codes** (`renumber.ts`, verified): these are never rewritten, so they point at whatever option now holds the old code:
  - punch `when` (only `source` is rewritten, `:333`)
  - mask/rowMask/columnMask `when`
  - validation `check`
  - flow-node `visibleIf` (`rewriteFlow` handles only `when`/`branches`)
  - loop `eligibleIf`/`skipIf`/`breakIf`/`invalidIf`
  - named expressions, list fills, option groups

  A COUNT rule's threshold is also remapped as if it were a code.
- **Dependencies** (`dependencies.ts:151`): named-expression sources are ignored. As a result:
  - The runtime does not recompute a same-page punch gated on a named expression (`Runner.tsx:1591`).
  - Cycle detection and block dependencies inherit the gap.
- **Copilot quota placement** (`surveyActions.ts:819` `collectRefs`): only question sources are collected (not `$question`, `expr`, `count.where` or named expressions). `create_quota` can therefore place the quota check before a question its cells read.
- **Response filter SQL** (`responseFilter.ts:86`): drops the COUNT spec and marks the result exact, so the Studio's response filter returns wrong rows for COUNT rules.

**Wrong in authoring:**
- **Diagnose** (`diagnose.ts:188/200`): disagrees with the evaluator on empty groups ("can never be shown" for always-shown questions).
- **COUNT `where` is never entered** by:
  - option-code canonicalisation (`optionCodes.ts:113`)
  - lint (`lintLogic.ts:223`)
  - named-expression usage and cycles (`namedExpressions.ts:79`)
- **`lintSurveyLogic` lints only question-level conditions.** It never lints flow `visibleIf`, branches, loops, quotas, display rules, calculations or named expressions.

**Cosmetic:**
- `logicTrace.ts:80`: empty children are shown as ✓.
- `EvalTrace` (`evaluate.ts:668`) is a flat list with no group structure.
- `conditionSummary` omits COUNT `where` and prints named-expression ids.

## 7. Import and export

- **Word/PDF/Excel/text import** (`import/adapters/document.ts:348`):
  - It splits on the first AND/OR, so `A AND B OR C` becomes `A AND (B OR C)`.
  - Parentheses are not supported.
  - NOT only works in "not selected X".
- **Qualtrics QSF:** skips are a single comparison, non-simple quotas become one cell, and quota groups are dropped.
- **Decipher:**
  - Named `<condition>` references are not expanded, so the condition is dropped.
  - `count != N` is mapped to "at most N" (likely bug).
- **Mapper** (`import/map.ts`):
  - Any unresolved leaf drops the whole condition.
  - Quota-sourced conditions are dropped.
  - Counts become calc text instead of a structured COUNT.
- **Word spec export** (`exporters/docx.ts`):
  - Nested display logic prints correctly.
  - Condition-kind validation prints just "condition", and validation `when` gates are omitted.
  - Loop conditions are not printed.
- **SPSS/SAS/Stata/CSV/datamap:** no logic is exported (no FILTER/DO IF, no "asked when" column).

## Suggested order to fix

1. **Data loss and wrong runtime results:** the Expression-tab `count.where` loss, renumber coverage, delete-question pruning, named-expression dependencies, response-filter COUNT, copilot quota placement.
2. **Editors for the seven editor-less fields and COUNT `where`** (text syntax + builder), plus the visible top-level NOT and a correct ungroup of NOT.
3. **Conditions where none exist:** a `when` on UX behaviours, randomizer, `quota_check`, embedded fields and custom scripts, reusing `Condition`.
4. **AI and grammar:** structured conditions in copilot actions, conditional validation, branch with otherwise, grammar combining rather than replacing.
5. **Import precedence and parentheses; logic in the Word spec, SPSS FILTER syntax and an "asked when" column.**
