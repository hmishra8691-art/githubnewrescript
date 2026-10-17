# Smart operators and list items (documents 15/10 and 16/10)

Status date: 2026-10-17. Owner: LOGIC. Nothing was committed; the files are listed below.

## Item 1: Contains on comma-separated Embedded Data (15/10, two items)

### Reproduction in the real evaluation path

`smartOperators.test.ts` builds a flow (`embedded_data` with a fixed value → `branch` → two pages) and runs it through `start()`, the same walker the runtime uses. Results before the fix, with `ZIP_Code_DMA = "10001, 10002, …"`:

| Field type | Condition | Routed | Correct? |
|---|---|---|---|
| none / String | `contains "10005"` | hit | yes, but only by substring |
| none / String | `contains "1000"` | hit | **no**: a partial item matches |
| none / String | list `"110001, 20002"` `contains "10001"` | hit | **no**: 10001 matches 110001 |
| none / String | `contains "10001, 10003"` | miss | **no**: a list needle is one piece of text |
| none / String | `contains "10001,10003"` (spacing differs from the stored text) | miss | **no** |
| Integer | anything | miss | **no**: the list coerces to `null` ("is not a number") |

### Root causes

1. **`contains` on text is a substring test.** It works only when the needle appears exactly as written in the stored text. That is why the user saw it "only work when the whole list is entered": a contiguous run of the stored text matches, and a list of items, a different spacing or a different order does not. It also gives false positives (`1000`, `110001`).
2. **Integer typing nulls a list.** `coerceEmbedded("integer", "10001, 10002")` stores `null`, so every condition on the field is false. That code is FLOW's (`embedded.ts`). It now offers the right types, `list` and `auto`, and its type preview reports the problem. I did not change it.
3. **The builder had no notion of a list.** An Embedded Data source got the full ~38-operator list (no type detection), so there was no way to ask for item matching.

I could not reproduce "`contains 10005` fails on a String field" in the engine. That exact case evaluates TRUE through `start()`. The reproducible failures are the ones in the table above.

### What was done

- New operators, added to the schema without changing existing ones (`conditions.ts`): `containsItem`, `notContainsItem`, `containsAllItems` and `containsExactly`. They compare whole items: trimmed, case-insensitive, leading zeros kept, and a list needle matches when ANY item matches. They are implemented in `evaluate.ts` (`itemsOf` splits text lists and arrays).
- **The legacy `contains` is unchanged** on untyped and `string` fields, which covers every stored survey. It switches to whole-item matching only for a field whose effective type is **list**: a declared `list`, or `auto` holding a list. Both are FLOW's new types, so no stored condition changes meaning.
- The comparison value can come from another question's answer (`{ $question }`, which already existed) or from **piped text**. Piped text is a new additive `{ $pipe: "{{Q1.ZIP}}" }` reference, resolved by `resolvePipingText` at evaluation time. A literal value containing braces keeps its literal meaning. In expressions it prints and parses as `PIPED("{{…}}")`, and unresolvable tokens produce a lint warning.
- Builder: a list source starts on **Contains item**. A note under the rule spells out the difference: "Contains item: whole items … 10001 never matches 110001" versus "Contains text: any part of the text". FLOW's `InsertPipedText` is wired into the value field. `accept` is `number` for numeric operands and `text` otherwise, and the token is stored as `{ $pipe }`.
- Expressions: `contains item`, `not contains item`, `contains all items` and `contains exactly`. Plain-words phrases are also understood: "contains the item 10005" and "doesn't include item 10003".

## Item 2: Smart logic operators by question type (16/10)

### Design

`packages/engine/src/smartOperators.ts` is the one operator engine, used by every condition builder in the Studio:

- `operandTypeOf` works out the source type. For questions it uses the response model, variant and type (rating is split into scored and label-only by option codes). For Embedded Data it uses the declared type, or the authored value for `auto` and for list text.
- `operatorMenu` returns grouped entries (Operators · List items · Count · Shown to the respondent · Response status), a default entry, a value kind per entry (`option`, `options`, `cell`, `number`, `numberRange`, `text`, `textList`, `items`, `date`, `dateRange`, `time`, `timeRange`, `rank`, `none`), and a row selector (`row`, `field`, `task`).
- Every entry is filtered by **the linter's own validity** (`operatorsForQuestion` plus the grid-cell vocabulary). A rule built from the menu can never be a lint error, and a test proves this for every entry of every type.
- `entryForRule`, `applyOperatorEntry`, `operatorStatus` (`ok` / `other` / `needsUpdate`), `ruleSentence` / `conditionSentence`, and `conditionTestInputs` / `evaluateWithTestInputs` (which use the real evaluator) complete the module.

The entries map onto existing operators wherever possible. New operators were added only for whole-item list matching and "has selected exactly". `eq` on two arrays was order-sensitive, so it could not express "exactly".

| Type | Shown (label → operator) | Default |
|---|---|---|
| Single select (radio, dropdown, buttons, cards, image, icon, list, tile…), Rating with text labels | equals `eq`, does not equal `ne`, is any of `in`, is none of `notIn` · option is (not) displayed · is (un)answered | Equals |
| Multi select | has selected `selected`, hasn't selected, has selected any/all/none of `containsAny/All/None`, has selected exactly `containsExactly` · number selected =, >, ≥, <, ≤ (COUNT source) · displayed · answered | Has selected |
| Numeric, Duration | = ≠ > ≥ < ≤, between / not between (two number inputs) · answered | Equals |
| Rating, scored (NPS, stars, likelihood, numeric codes) | = ≠ > ≥ < ≤ between not between, is any / none of · answered | Equals |
| Text | equals, does not equal, contains text, does not contain text, starts with, ends with, is one of `in` (exact list membership), is not one of, matches pattern · answered | Equals |
| Single grid (incl. image categorisation / buckets, pairwise set) | row selector ("any row" = any row equals) · is `selected` + answer column, is not, is any / none of `in`/`notIn`, ≥ ≤ > < between (numeric scales only) · row is (not) displayed · answered | Row is |
| Multi grid | row selector · has selected, hasn't selected, any / all / none of · row displayed · answered | Row has selected |
| Numeric grid / Text grid | row selector · numeric / text operators | Equals |
| Constant sum | field selector · Field = ≠ > ≥ < ≤ between not between · answered | Field equals |
| Ranking | is ranked at position `rankEquals`, above / below position `rankLessThan`/`rankGreaterThan`, ranked first / last, in the top N, is ranked `contains`, is not ranked · displayed · answered | Ranked at position (position dropdown) |
| MaxDiff | task selector (empty = any task) · chosen / not chosen as most preferred (`eq`/`ne` on column `best`), as least preferred (`worst`) · answered | Most preferred |
| Date | is on `dateEquals`, is not on `ne`, before / after, on or before `lte`, on or after `gte`, between `dateBetween`, not between `notBetween` (date inputs) · answered | Is on |
| Time | is at `eq`, is not at, before `lt`, after `gt`, between, not between (time inputs) · answered | Is at |
| File upload | has uploaded a file `answered`, has not `unanswered` | Has uploaded |
| ED boolean | is true / is false (`eq` with a preset value), is set / is not set | Is true |
| ED integer / decimal | numeric operators | Equals |
| ED string | text operators (+ list-item operators) | Equals |
| ED list (declared `list`, `auto` list, or list text) | contains item, does not contain item, contains all of, is exactly · is (not) empty · contains text / equals (the whole list), offered only where `contains` is still text | Contains item |
| COUNT source | = ≠ > ≥ < ≤ between | ≥ |

The validity table (`OPERATORS_BY_KIND`) gained entries only. Text gained `in` and `notIn`. Date and time gained `gt`, `gte`, `lt`, `lte`, `between` and `notBetween`, which the evaluator already ordered correctly. List gained the new item operators. No operator that was valid became invalid.

### Builder behaviour (`ConditionBuilder.tsx`, the one RuleEditor every surface renders)

- The operator `<select>` has `<optgroup>`s per group, uses the type's words, and carries `data-operand-type`. A search box ("find operator…") filters the compatible operators.
- When the source changes, the operator becomes that source's default. Choosing a different operator keeps the value only if the new operator takes the same kind of value.
- The value control follows the operator: an option dropdown; option checkboxes plus the typed list for many options; two `number`, `date` or `time` inputs for a range; a rank position dropdown; nothing for answered, "is true" or grid cells; a MaxDiff task input; and "Insert piped text" for typed values.
- **Needs update:** if a stored operator no longer fits its source (for example, the source was retyped), it stays selected and is labelled "— not available for this question (needs update)". A `needs update` chip appears, the source's own operators are offered, and a "fix" button applies the default only when clicked. The linter raises an **error**: "… this condition needs updating …". That error blocks `runQualityCheck`, `publishGate` and live deploy. An Embedded Data field with a ranking or display operator is treated the same way. An operator that is still valid but no longer offered (`Q1 > 2` on a single select) is shown as "other — still valid" and evaluates exactly as before.
- A sentence appears under every rule ("the respondent selects “Tea” or “Coffee” at Q1"). Display logic also reads as a whole: "Display Q4 if the respondent selects “Tea” or “Coffee” at Q1."
- **Test condition:** one input per source the condition reads (with option codes offered). The panel shows TRUE or FALSE from `evaluateCondition`.
- **One engine everywhere:** display, skip, branch, Survey Flow nodes (FLOW's files render `ConditionEditor` / `OptionalCondition`, and I changed only the component), quotas, validation `when` / `check`, auto-punch, masking `when`, option / row / column logic, carry-forward `where`, loops, list fills, named expressions, randomizer conditions, UX behaviours, localisation rules, AI-conversation rules and the response filter. `operatorMenu(def, source, { exclude })` lets a feature narrow the menu further. `apps/studio/lib/smartOperatorsWiring.test.ts` fails if any component builds its own comparison-operator dropdown.

## Backward compatibility (proven before / after)

- `packages/engine/src/operatorCompat.test.ts` runs every pre-existing operator against a matrix of 24 left values × 18 right values × 4 second values (text, list text, arrays, numbers, booleans, dates, clock times, grid maps, empty). That is 63,936 evaluations (37 operators) through `evaluateCondition`, compared with a snapshot **taken before the change**. They are identical.
- `packages/templates/src/conditionCorpus.test.ts` evaluates every condition in every template (NPS, CSAT, screener, brand tracker, employee, the 120-question master demo, and the 60-question scale survey) against six deterministic respondents. That is 942 evaluations, compared with a snapshot taken before the change. They are identical.
- One existing assertion was updated: `changeItems.test.ts`. A quota reading `in` on a question retyped to text is now judged "changes" rather than "breaks", because `in` on text (exact membership) is now valid.

## Files

- Schema (additive only): `packages/schema/src/conditions.ts` adds the four operators, `LIST_ITEM_OPERATORS`, the `OPERATORS_BY_KIND` additions and `PipedValueRef` / `isPipedValueRef`.
- Engine:
  - New: `smartOperators.ts` and its test, `operatorCompat.test.ts` and its snapshot.
  - Changed: `evaluate.ts` (new operators, list-typed `contains`, `$pipe`), `lintLogic.ts` (needs-update errors, ED ranking/display, piped tokens, MaxDiff `best`/`worst` and task rows), `logicExpression.ts` (spellings, `PIPED()`), `naturalCondition.ts`, `logicSummary.ts`, `optionCodes.ts`, `actionValidation.ts`, `diagnose.ts`, `index.ts`, and `changeItems.test.ts` (one expectation).
- Templates: `conditionCorpus.test.ts` and its snapshot.
- Studio: `components/studio/ConditionBuilder.tsx`, `PropertiesPanel.tsx` and `components/canvas/ElementPanel.tsx` (the display-logic purpose sentence only), `lib/smartOperatorsWiring.test.ts`.
- Browser suite: `scripts/smart-operators-test.mjs`.
- Regenerated: `apps/studio/content/docs/logic-reference.md`.

## Verification

- Schema build: clean.
- Engine: build clean; **2,092/2,092** tests pass (14 new in `smartOperators.test.ts`).
- Templates: **110/110**.
- Typecheck is clean for the renderer, Studio, runtime and every other package.
- Studio lib: **600/600**.
- `gen-public-docs --check`: current.

The orchestrator should run (studio :3000, runtime :3001):

- New: `scripts/smart-operators-test.mjs`.
- Existing suites that drive the builder: `logic-builder-test`, `matrix-condition-test`, `count-logic-test`, `codes-sync-test`, `schema-integrity-test` (retype → stale operator / fix), `option-logic-test`, `option-popup-test`, `validation-condition-test`, `nested-logic-audit-test`, `named-expressions-test`, `response-data-test`, `expression-editor-test`, `logic-fixes-test`, `logic-targets-test`.

## Not done, and why

- **"All rows equal"** on a grid is not offered as one click. It needs a COUNT whose `where` holds the chosen answer, and a one-click entry would have to rewrite that `where` whenever the value changes. It is still expressible: "count of rows answering X = number of rows" with the ∑ count toggle. "Any row equals" is offered, as row "any row".
- **Constant sum "Total"** is not offered. The calc engine reads an allocation answer as 0 in `SUM(Q8)`, so there is nothing faithful to map it onto. That needs a calc change (`calc.ts`, not mine).
- **File count / type / size** are not offered. The upload answer does store `{ url, name, size, type }`, but no condition source or operator reads that metadata. Adding them needs a new source kind or operators and evaluator paths, which is out of scope here. Only "has / has not uploaded" is offered.
- **Grid "row count"** for multi grids is not a menu group. The existing ∑ count toggle (scopes rows and columns) covers it.
- **Auto-punch / masking source–target compatibility:** the existing checks (codes exist, mapping, preselect on a single select) and the needs-update lint on their `when` conditions apply. No new type-compatibility check was added.
- **Integer-typed list:** the coercion is FLOW's. The answer is the `list` / `auto` type, not a looser integer.
- SPSS base syntax (`exporters/spssBases.ts`) has no translation for the four new operators. A base using them falls back to whatever that exporter does for an operator it cannot express.
