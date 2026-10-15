# P0 — Excel audit, matrix-condition and expression-copy fixes

Workbook: `12-10-2026.xlsx` (six items) plus the two release-blocking logic bugs from the brief.
Status date: 2026-10-15. Nothing is pushed; the work is committed locally and delivered as a patch.

Every row below says what was wrong, the root cause, where the fix lives, and the test that proves it.
"Verified" means a test fails without the fix and passes with it, and — for anything a respondent or a
programmer sees — that it was exercised in a real browser against the real Studio and runtime.

## Issue → fix checklist

| # | Issue | Root cause | Fix | Proof |
|---|---|---|---|---|
| **M1** | Matrix condition asks for both an answer **Column** and a **Value** for the same categorical answer | A single-/multi-select matrix cell *is* its scale point, but the schema gave it two homes (`source.columnId` and `value`); the builder offered both, the evaluator read one and ignored the other, so the box nobody looked at decided | One canonical form: `{rowCode, columnId, operator: selected \| notSelected}` with **no value**; ordinal comparisons use a value and no column. `gridCell.ts` (`normalizeGridRule`, `gridCellOperators`, `withGridOperator`), evaluator, parser/printer, lint, summary, builder UI, load/edit-time migration (`canonicalizeCondition`) | `gridCondition.test.ts` (23), `scripts/matrix-condition-test.mjs` (10, builder + runtime) |
| **C1** | Copying an expression changes it | The text round trip was lossy: zero-padded codes lost their zeros, quoted text could not be read back, `"4"` became `4`, a column-only reference could not be written, `@option.code` printed `[object Object]`; and question duplication silently re-pointed nothing | Round-trip identity in `logicExpression.ts` / `optionCodes.ts`; **exact** copy (`copyCondition`) separated from an explicit, previewed, confirmed **Remap references** (`remapConditionReferences`, UI in the Expression editor); duplication re-points only the copy's own references (`pointCopyAtItself`) | `gridCondition.test.ts`, `scripts/expression-copy-test.mjs` (5) |
| **X1** | Dropdown Matrix `multi_dropdown` was a `<select multiple>` list box | Cell renderer used the native control | `CellMultiDropdown`: checkbox popover that stays open, labels or "N Options Selected", column min/max selections (max enforced in the list, min by validation on Next), exclusive options, per-row state, same stored value, Escape/outside click, phone width. Used by Dropdown Matrix and the Editable Table | `scripts/dropdown-matrix-multi-test.mjs` (7) |
| **X2** | `{{ed.Field}}` in Calculations / Embedded Data calculation / Calc DSL → "Unexpected character '{'" | The calc tokenizer did not know piping syntax; embedded-data calculations used a private resolver that could not see embedded data; `+` concatenated numeric strings; the piping regex ended `{{expr: …}}` at the first `}}`, leaving fragments in preview text | Tokenizer accepts `{{ref}}`; one resolver (`calcOptionsFor`) for all three sections incl. `ed.`/`embedded.`; numeric-string coercion in numeric context only (IDs like `007` stay text); `EmbeddedDataError` names the field (empty / non-numeric); survey setting **Empty Embedded Data Handling** (Treat Empty as 0 / Show Calculation Error / Skip Empty Values); values read live each evaluation; reasons recorded in `state.calcErrors` and shown in the inspector; pipe regex allows one nesting level; lint names undeclared / non-numeric embedded fields | `calcEmbedded.test.ts` (14), `scripts/calc-embedded-test.mjs` (6) |
| **X3** | Per-option "Show Popup Message When Selected" | Did not exist | `OptionLogic.popup` (message, title, Information/Warning/Confirmation, Immediately/On Next, button text, Every selection/Only once); Advanced Rules editor (fields only when enabled); one hook in `QuestionRenderer` (works for every choice renderer, fires only for *added* options, never deselects); on-Next gate in the Runner before List Fill (Cancel on a confirmation keeps the respondent on the page, "once" is not consumed by a cancel); accessible dialog, queued, fixed-position so it fits phone widths | `optionPopups.test.ts` (13), `scripts/option-popup-test.mjs` (11) |
| **X4** | "Show when…" / "Hide when…" duplicate Eligible / Exclude; Advanced Rules hidden | Two spellings of one rule | Pills removed; saved options are migrated to the equivalent Eligible-when / Exclude-when (engine/schema/store/editor, idempotent, behaviour-preserving); legacy "visible if" converts to Eligible; Logic panel opens with Advanced Rules expanded | `optionPopups.test.ts` (migration), `scripts/option-popup-test.mjs`, `option-logic-test`, `count-logic-test`, `remaining-items-test` updated |
| **X5** | Auto Punch: Simple mode and the multi-select list box | Three editors over one rule | Simple mode removed (Builder is the default; Expression kept as the text view); target options are a single-choice dropdown (select on a one-answer question) or a checkbox dropdown (everything else); existing rules unchanged | `autopunch-media`, `autopunch-header`, `nested-logic-audit` suites updated and passing |
| **X6** | "Display" operator in Advanced Rule conditions | Did not exist | `displayed` / `notDisplayed` operators (question or option/row shown after display & exclusion logic, selected or not); evaluator via a registry module with no runtime imports (an import cycle otherwise leaves it uninitialised); builder: Source Question + Source Option, no row/column/value boxes; expression language; grids use rows | `optionPopups.test.ts` (4), `scripts/option-popup-test.mjs` |
| **L1** | Logic audit across question types | — | `logicAudit.test.ts` (12) pins single/multi/count/numeric boundary/text/ranking/nesting/stale refs/upstream change/calculated vars/label & order independence/copy; matrix scenarios in `gridCondition.test.ts` | engine suite 1850/1850 |

## Mandatory regression scenarios (brief §7)

1. Matrix display logic without a redundant Value — `gridCondition.test.ts`, `matrix-condition-test.mjs`
2. Row + column skip logic — `gridCondition.test.ts` (skip routes on cell, not on another row)
3. Multi-select selected / not selected — `logicAudit.test.ts`, `gridCondition.test.ts` (matrix_multi)
4. Numeric thresholds — `logicAudit.test.ts` (boundaries, between inclusive, unanswered)
5. Text entry — `logicAudit.test.ts`
6. Copy / compare structure — `expression-copy-test.mjs`, `logicAudit.test.ts`
7. Multi-reference expressions — `gridCondition.test.ts`, `expression-copy-test.mjs`
8. Matrix row / column / answer-code refs — `gridCondition.test.ts`
9. Nested AND / OR / NOT — `logicAudit.test.ts`
10. Same expression into several questions — `logicAudit.test.ts`, `expression-copy-test.mjs`
11. Save / reload / export-import / project duplication — `gridCondition.test.ts` (round trip, structural clone)
12. Label change keeps refs — `logicAudit.test.ts`
13. Rename / reorder rows or columns keeps refs — `logicAudit.test.ts` (conditions reference stable codes)
14. Upstream answer change re-evaluates — `logicAudit.test.ts`, `gridCondition.test.ts`
15. True / false / unanswered / null / invalid / boundary — `logicAudit.test.ts`
16. Respondent-facing test runtime — `matrix-condition-test.mjs`, `option-popup-test.mjs`, `calc-embedded-test.mjs`, `dropdown-matrix-multi-test.mjs`
17. Unrelated questions unchanged — `gridCondition.test.ts` (repair leaves other rules alone), `logicAudit.test.ts`

## Decisions worth knowing about

* **Auto Punch "Builder only"**: Simple is gone and Builder is the default. The Expression view is kept as a
  secondary text view (it is how a rule with several targets is added, and the text round trip is now exact).
  If "Builder only" meant removing Expression too, that is a one-line change; it was not done because it
  removes a capability the brief did not ask to remove.
* **Single vs checkbox dropdown for punch targets** follows the *target* question: a one-answer question punched
  with "select" gets a single-choice dropdown (it can hold only one option); every other combination
  (multi-select targets, deselect/show/hide/enable/disable) gets the checkbox dropdown.
* **Dropdown Matrix min/max** reuse the column's existing `min_selections` / `max_selections` rules (already
  authorable and already validated) rather than adding a second pair of fields.
* **Empty Embedded Data Handling** is one survey-wide setting, so the three calculation surfaces cannot disagree.
  Default is "Treat Empty as 0" — the previous behaviour — so no existing survey changes.
  *Skip Empty Values* applies to aggregate functions (sum, avg, count, min, max); in plain arithmetic there is
  nothing to leave out, so it counts as 0 there ("where supported" in the brief).
* **Non-numeric embedded values in arithmetic are now an error that names the field** (previously silently 0).
  A calculation that hits one yields no value and records the reason; this is the behaviour the brief asked for
  but it is a change for any survey that relied on text being read as 0.
* Popup "only once" is remembered in memory per respondent session: a respondent who reloads the page sees it
  once more (the safe direction for a message somebody wanted shown).

## Blockers / not done

* None of the eight items is blocked. Items not exercised: real physical devices (phone/tablet verified at
  360 px viewport width in the browser only), and the four Postgres-dependent suites the corpus runner excludes
  by design.
* The expression editor's "Remap references…" lists question-level maps only; column-level maps
  (`ReferenceMap.columns`) are used by duplication and are available in the engine but have no picker yet.

## Verification run

* Engine unit suite: 1850 / 1850. All package unit suites pass (studio 517); typecheck clean; auth-guard audit: 0 problems.
* Browser corpus (147 suites, run serially against the real Studio and runtime): **141 pass** after reruns,
  **2 were updated for the intended new behaviour** and now pass:
  `expression-editor-test` (a matrix cell is `columnId`, no separate value — M1) and `codes-sync-test`
  (the toast now reads "Logic tidied — …" because the same repair also migrates matrix conditions).
* **6 suites fail identically with and without this change** (checked by stashing the work, rebuilding and
  running them on the previous commit): `analysis-framework-test` (first planned crosstab), `billing-test`
  (402 on insufficient balance with the fake provider), `dashboard-outage-test` (one-off 502 recovery),
  `picker-taxonomy-test` (Percentage Slider in Numeric), `qa-fixes-test` (emoji default scale),
  `quality-test` (help-text overlap). They are unrelated to logic, matrix, calculations or popups and were
  left alone.
* A first pass reported ~25 more failures; those were server restarts / a concurrent runtime / a 400 s cap and
  all passed when rerun alone. `fonts.googleapis.com` is unreachable from the sandbox (harmless for tests).
* Four Postgres-dependent suites are excluded by the runner by design.
