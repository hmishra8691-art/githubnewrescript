# Contains operator and default / piped values on open-ended fields (2026-10-24)

This covers client Excel 19/10/2026 items **A46 and A48** (the Contains operator) and **A63** (a piping box on every open-ended field). Engineer H4. There is no migration: every schema addition is an optional field.

## Where to find it

| Feature | Where |
|---|---|
| Operator menu (Contains, In list, Between) | Any condition builder: **Properties → Display logic**, skip logic, **Survey Flow → Branch**, quotas, validation conditions and the rest. Pick the source, then open the **Operator** dropdown. The operators each type offers are in the table below. |
| Range inputs | Choose **is between** / **is between (numbers)**. Two number boxes appear: *min* and *max*. Both ends are inclusive. |
| Value list | Choose **is in list** / **is not in list**. Type the values separated by commas. Each value shows as a chip with an × to remove it. |
| How a comma-separated answer is read | The grey hint under the rule, for between / in list on an open end. |
| Trying a condition | **Test condition** under the rule. It uses the same evaluator as preview and live. |
| Contains stored on a choice question | The rule shows a **needs update** chip and a **use “equals”** (or “has selected” / “is”) button. Clicking the button keeps the value. **Logic → Run quality check** lists it as a warning. |
| Question default | **Properties → State → Default / piped value**. It has a **Pipe** button (Insert piped text) and warns about a token that does not resolve. |
| Text / Numeric Matrix row default | Question editor → **Rows**: a *Default / piped value* box under each row. |
| Constant Sum row default | Question editor → **Options**: a *Default amount* box under each row. |
| Text / Numeric List field default | Question editor → **Fields**: a *default* box beside each field's placeholder. |
| Composite / custom-table defaults | Question editor → **Columns**: a box under each text or numeric column applies to every cell in that column. Under **Rows**, each row has one box per open column (*“<column> default”*), and a row's own cell default wins over the column's. |
| “Other — specify” box default | Under any option or row flagged *other_specify*: **Other box default**. |
| Unresolved default in preview / test | An orange *Test note* under the question names the field and the token. A live link never shows it. |
| Intelligent Mode | The `set_default_value` action takes an optional `"field"`: a row or field code, a constant-sum row, `"row/column"`, `"column:<id>"` or `"<code>.other"`. See the UX guide in `apps/studio/lib/copilot/prompt.ts` and the generated `actions-reference.md`. |
| Capability registry | `platform:open_end_operators`, `platform:open_end_defaults` (`/platform`, `capabilities.md`). |

**Environment variables:** none. Both features are pure engine and builder code and work with the fake AI provider.

## 1. The Contains operator (A46, A48)

### Which types offer which operators (as shown in the menu)

| Source | Operators offered | Contains? |
|---|---|---|
| Text entry (short, long, email, ZIP, …), interview transcript | equals, does not equal, **contains text**, does not contain text, starts with, ends with, **is in list**, **is not in list**, **is between (numbers)**, **is not between (numbers)**, matches pattern, is answered / unanswered | **Yes**: substring |
| Numeric (open, integer, decimal, currency, percentage, quantity) | = ≠ > ≥ < ≤, is between, is not between, **is in list**, **is not in list**, answered | No |
| Duration | = ≠ > ≥ < ≤, between, not between, answered | No |
| Text List field, Text Matrix row, text column | the text operators above, with a row / field selector | **Yes**: substring |
| Numeric List field, Numeric Matrix row, Constant Sum field, numeric column | the numeric operators, plus is in list / is not in list | No |
| Single select (radio, dropdown, buttons, cards, image …), label-only rating | equals, does not equal, is any of, is none of, option is (not) displayed, answered | **No** |
| Multi select | has selected, hasn't selected, has selected any / all / none of, has selected exactly, number selected …, displayed, answered | **No**. “Includes option” is **has selected**. |
| Single / multi grid | row selector, is / is not, any / none of, …, displayed, answered | **No** |
| Scored rating (NPS, stars, numeric codes) | numeric comparisons, is any / none of | No |
| Ranking | is ranked at / above / below position, first, last, in the top N, **is ranked** (`contains`), is not ranked | **Kept** as “is ranked”: the item appears in the ranked order |
| Embedded Data string | text operators and the list-item operators | Kept: substring |
| Embedded Data list | contains item, does not contain item, contains all of, is exactly, … contains text, equals (the whole list) | Kept: “contains text” beside “contains item” (unchanged from 17/10) |
| Date, time, file, boolean, count, MaxDiff | unchanged | No |

### What each operator means now

- **Contains (text)**: any part of the text, ignoring case. It is unchanged.
- **Is in list**: the *whole* answer equals one of the configured values. With the list 1, 5, 10, 25, 50, 100, the answer 25 is TRUE and 26 is FALSE. A list typed as one comma-separated value is read as that list.
- **Is between**: the answer is a number from *min* to *max*, both ends included. The comparison is numeric, never a string comparison. Text that is not a number is never between anything.
- **The client's comma-separated answers.** On a source the respondent types into, `between`, `>`, `≥`, `<`, `≤` and `in` hold when **every** value satisfies them. `not between` and `not in` hold when **no** value is a match. Items are trimmed, and `,`, `;` and new lines all separate. Empty items such as `"25,,26,"` are ignored. Decimals and negatives read as numbers. A value that is not a number makes a numeric comparison FALSE.

The client's table, for Q1 → **is between (numbers)** 1 and 100:

| Respondent types | Result |
|---|---|
| 1, 5, 50, 99, 100 | TRUE |
| `25,26,27,45,39,50` | TRUE (every value is in range) |
| `99.100,101` | FALSE (101 is out of range) |
| 150 | FALSE |

**Decision:** the brief left “all or any” open. I chose **ALL** values in range for between and in list, which is what “Enter numbers between 1 and 100” asks of every number. `not between` / `not in` mean none of the values match.

### One evaluator

Display logic, skip logic, branch logic (Survey Flow), quotas, validation conditions and the Test condition panel all call `evaluateCondition`. The open-ended reading lives inside it (`applyOpenEnded` in `evaluate.ts`), so the results are identical. A unit test drives the same rule through display logic (`visibleQuestions`) and a flow branch for every row of the client's table, and the browser suite does the same in the runtime preview.

### Backward compatibility

- The 63,936-evaluation operator snapshot (`operatorCompat.test.ts`) and the template condition corpus (942 evaluations) are **unchanged**.
- Value-by-value reading applies only to question sources whose answer is typed. Embedded Data, choice, ranking, date and time sources evaluate exactly as before. On a typed source, an answer that matches as a whole still matches, so nothing a single value satisfied before has changed.
- A stored `contains` / `notContains` on a single select, multi select or categorical grid **keeps evaluating as it always did** (equals / has selected / is). The builder marks it **needs update** and offers the replacement with one click. The linter raises a **warning** (*“Operator “contains” on Q3 … needs updating: it is a text operator — use “equals” (eq) …”*). It is a warning, not an error, so it does not block deployment, because nothing is broken. `contains` on a numeric question was never valid and is still the blocking error it was.
- Validity table: `text` gained `between` / `notBetween`. Nothing that was valid became invalid.

## 2. Default / piped value on every open-ended field (A63)

**Storage** (all optional, so old definitions parse unchanged):

| Field | Where it is stored |
|---|---|
| Question | `settings.defaultValue` (existing) |
| Text / Numeric List field, Text / Numeric Matrix row | `rows[].defaultValue` |
| Constant Sum row | `options[].defaultValue` |
| Composite / custom-table cell | `rows[].cellDefaults[columnId]`, else `columns[].defaultValue` |
| “Other — specify” box | `options[].otherDefault` / `rows[].otherDefault` |

**Behaviour** (`packages/engine/src/defaultValue.ts`, run by the flow when a page is shown):

- The value is resolved with the piping engine to plain text, so the respondent never sees `{{…}}`. It is read as the field reads its value: a number for numeric fields, text otherwise.
- It is written **only into empty fields**, never over what the respondent typed or a punch or preselect, and **once per question per respondent**. A respondent who clears a field does not get the default back.
- A pipe that resolves to nothing writes nothing, so the field is empty on a live link. In preview and test mode the question shows a test note. In the builder the box warns as the token is typed (`lintPipingTokens`, the same rule question text uses). A default that could not resolve is tried again the next time the page is shown, so a page reached before Q1 was answered fills in once Q1 has an answer.
- Validation, numeric limits, constant-sum totals (the total counts pre-filled amounts) and storage are unchanged. An empty box changes nothing.
- An apply that changes only defaults counts as presentation (`structureUnchanged`), and the change summary lists it as “field defaults”.

## Files

- **Schema:** `packages/schema/src/conditions.ts` (`OPEN_ENDED_MULTI_VALUE_OPERATORS`; text gained between / notBetween) and `packages/schema/src/question.ts` (`Option.defaultValue/otherDefault`, `QuestionRow.defaultValue/cellDefaults/otherDefault`, documentation on `QuestionColumn.defaultValue`).
- **Engine:**
  - New: `containsOperator.ts`, `containsOperator.test.ts`, `openEndDefaults.test.ts`.
  - Changed: `evaluate.ts` (`applyOpenEnded`, `isOpenEndedQuestionSource`), `smartOperators.ts` (In list / Between entries, `numberList` value kind, `operatorStatus().replacement`, `applyContainsReplacement`), `lintLogic.ts` (contains-on-choice warning), `defaultValue.ts` (`fieldDefaultsFor`, `questionHasDefaults`, `unresolvedDefaultsFor`, per-field `applyDefaultValues`), `uxActions.ts` (`set_default_value { field }`), `surveyActions.ts` (description and diff of field defaults), `theme.ts` (field defaults count as presentation), `capabilities.ts` (two entries), `index.ts`, and `p2Fixes.test.ts` (column list bound).
- **Renderer:** new `defaultsNote.tsx`; one anchored line in `QuestionRenderer.tsx`.
- **Studio:** new `components/studio/DefaultValueBox.tsx`. Changed: `ConditionBuilder.tsx` (range min/max placeholders, value chips, replacement button, open-end hints), `QuestionsPanel.tsx` (boxes under rows, options, fields and columns), `PropertiesPanel.tsx` (the State box is now `DefaultValueBox`), and `lib/copilot/prompt.ts` (UX guide line).
- **Generated:** `apps/studio/content/docs/{actions-reference,capabilities,logic-reference}.md`.
- **Browser suites:** new `scripts/contains-operator-test.mjs` and `scripts/open-end-default-test.mjs`. The `matrix-condition-test.mjs` operator-count bound was updated.

## Tests

- Engine: 2,328/2,328 pass, including `containsOperator.test.ts` (11), `openEndDefaults.test.ts` (8), the operator compat snapshot and `smartOperators.test.ts`.
- Studio lib: 838/838 pass, including the operator-menu guard `smartOperatorsWiring.test.ts`. Exporters: 138/138.
- Templates: 109/110. The template condition snapshot passes. The one failure is `brand_tracker`'s carry-forward warning (“into options” on a matrix_multi), from the concurrent carry-forward-by-type work (H3), not from this change.
- Typecheck: renderer, runtime and Studio are clean. `gen-public-docs --check`: current. Auth-guard audit: 0 problems.
- Browser:
  - `contains-operator-test`: 7/7.
  - `open-end-default-test`: 9/9.
  - Regression suites `smart-operators-test` (11), `default-value-test`, `logic-builder-test`, `matrix-condition-test` (16), `schema-integrity-test`, `validation-condition-test` (12) and `data-export-test` all pass.

## Not done

- **Live-link check in a browser.** No browser suite drives a published live link; only the preview was driven. Live safety rests on two things. The engine never stores `{{…}}`, which unit tests prove. The preview note renders only when the Runner passes `programmerView`, which it does only for preview and test (H2's route-based gate).
- **Other-box and composite-cell defaults in a browser.** These have engine unit tests and builder controls, but no browser suite covers them. The browser suite covers the grid text cell and the constant-sum row the brief named.
- **`update_question` action.** It was not extended; `set_default_value { field }` carries per-field defaults instead. `update_question` is being changed concurrently (H2), and one action per setting keeps it simple.
- **Value-by-value reading on Embedded Data.** A list typed into an Embedded Data *string* is not read value by value; its list-item operators do that job.
