# Nested logic: audit and implementation pass (2026-10-01)

Follows `docs/NESTED-LOGIC-AUDIT-2026-09-28.md`. The acceptance criteria were that audit plus the
logic rows of the 29-09 and 30-09 review sheets.

## The model, as it now stands

- **One condition tree.** A `Condition` is either a rule or an AND / OR / NOT group, nested to
  any depth. A multi-child NOT means "none of".
- **One evaluator.** Every feature evaluates conditions with `evaluateCondition`.
- **One structural walker.** `conditionWalk.ts` is the only place that knows where conditions
  live:
  - `forEachConditionRoot` and `mapConditionRoots` find every condition field in a survey
    structurally.
  - `forEachRule` and `mapRules` walk into a COUNT's `where` as well.

  Renumbering, canonicalisation, named-expression usage and survey-level lint all use it. A
  new condition field is covered by all of them without being listed anywhere.
- **Empty groups.** `{and: []}` is the builder's starting state, and it is also what remains
  after the last condition is deleted. It is *vacuous*:
  - **As a gate** (show when, eligible when, display logic, page / branch / flow `visibleIf`,
    skip and display-rule `when`), it holds. "No constraint" is the behaviour it always had.
  - **As a trigger** (hide when, exclude when, move to top / bottom, a validation `check`,
    probe `stopWhen`, loop `skipIf` / `breakIf` / `invalidIf`, adaptive alternatives, quality
    custom rules), it does **not** fire. `conditionFires()` gives this, so an empty trigger now
    behaves the same as a missing one.
- **Constants.** `constantCondition(true | false)` is a real rule: `(1) = 1` and `(0) = 1`.
  Importers use it for "always" and "never". An empty group is not a constant.
- **Grid reads.**
  - A rule naming a whole row (`Q4.R1 > 23`), a column only, or a whole grid reads a *cell
    set*.
  - A positive operator holds if any cell matches. A negated operator holds if no cell does.
  - A fully addressed cell (`Q4.R1.c2`) is unchanged.
- **Depth limits.**
  - The evaluator stops at 200 levels and fails closed.
  - The parser stops at 64 bracket or NOT levels.
  - Lint gives a warning above 8 levels and an error above 200.

## Fixes: items from the 09-28 audit

| Audit item | Fix |
|---|---|
| §3.1 Expression tab deleted COUNT `where`, positions and `$question` counts | The printer writes `COUNT(Q1, where (…))`, `Q2.$first`, `Q2.$3` and `COUNT(Q6)` on the right-hand side, and the parser reads all of them. `ExpressionEditor` commits only when the text was edited and the tree changed. |
| §3.2 Empty child group printed as `"Q2 = 1 AND "` | `formatCondition` prunes vacuous children (`stripVacuous`). |
| §3.3 Top-level NOT invisible | The root head has an ALL / ANY / NONE selector and a NOT chip (`lb-root-op`, `lb-root-not`). |
| §3.4 Ungroup on NOT dropped the negation | `ungroupAt` turns NOT[A, B] into NOT A, NOT B inside the parent AND. `canUngroup` disables the action where that is impossible. |
| §3.5 Simple-mode edit reset ELSE IF / recompute | `optionRule(s, id, base)` keeps the rule's chain mode, `recompute`, label and priority. `applyParsedPunch` does the same when the Expression box is edited. |
| §4 Parser | Accepts `&&`, `||`, `!`, `<>` and `A BUT NOT B`. Right-hand `Q6.R1` and `COUNT(Q6)` are resolved. Depth is limited. |
| §4 Grammar | "A unless B" becomes (A) AND NOT (B). Added neither / nor, either, both, but not and except. "Also show …" ORs with the existing logic; plain "show" replaces it and says so. |
| §4 Copilot | Any `when` / `expression` / `check` may be a structured tree. `set_validation` takes `when` and `kind: "condition"` with `check`, the condition a *valid* answer satisfies (stored negated). `create_branch` takes `arms[]` and `otherwise[]`. Behaviours take `when`. The prompt documents all of these. |
| §4 Punch text | THEN is found outside quotes and brackets. ELSE IF / ELSE parse and print. |
| §6 Deleting a question | COUNT `where` and right-hand `$question` references are pruned. A partial prune inside AND / OR / NOT is reported in the delete dialog. |
| §6 Renumbering | Every condition root is rewritten through `mapConditionRoots`. COUNT thresholds are not remapped. |
| §6 Dependencies | Follow named expressions and COUNT `where`, so same-page recompute and cycle detection see them. |
| §6 Copilot quota placement | `collectRefs` now uses `conditionRefs`. |
| §6 Response-filter SQL | No SQL clause is emitted for COUNT, rowCode, columnId or positions, so the evaluator decides those. Equality is type-exact. |
| §6 Diagnose | Agrees with the evaluator on empty groups. Finds contradictions through nested ANDs. |
| §6 Canonicalisation, lint, named-expression usage | All of them enter COUNT `where`. |
| §6 Survey-level lint | `lintSurveyLevelConditions` lints flow, branch, loop, quota, display-rule, calculation and named-expression conditions. |
| §6 Trace / summary | Vacuous children are hidden. The summary prints COUNT `where`, named-expression names, positions and "(any column)". |
| §7 Document import | OR binds looser than AND. Parentheses, NOT, "BUT NOT" and "CODE Q2.1 IN Q2" are read. |
| §7 Decipher | `count != N` becomes NOT(count = N). |
| §7 Word spec / datamap | The spec prints condition validation ("Invalid when …"), "only when" gates, and loop, randomizer, quota-check, redirect and embedded-field conditions. The variable dictionary has an "Asked when" column. |
| §1 Features without conditions | Added: UX behaviour `when`, randomizer `visibleIf` ("show N" draws only from eligible children), quota-check `when`, embedded-field `when`, custom-script `when`. |
| §2 Fields without editors | Editors added for validation `when`, list-rule `when`, carry-forward `where`, randomizer, quota check, embedded field, script and behaviour conditions. |

## Fixes: new findings in this pass

| # | Bug | Root cause | Files |
|---|---|---|---|
| N1 | A numeric grid row with "any column" (`Q4.R1 > 23`) never held (Oweas #7). | A row read returned the row object, and `{…} > 23` is false. | `evaluate.ts`, `gridAxes.ts`, `lintLogic.ts` |
| N2 | Constant sum `Q5.1 < 6 OR Q5.2 > 6` compared the whole map (Prince 44). | The parser read `Q5.1` as "option 1 selected" and then dropped the option. | `logicExpression.ts` (parse and print `Q5.O1`) |
| N3 | Punching through a hidden question on the same page did nothing (Prince 66). | The page handler only recomputed page questions that read the answer directly. | `flow.ts` `recomputePunchesAfterChange`, runtime `Runner.tsx` |
| N4 | A derived (hidden) question kept a stale punch after its source changed. | Recompute "always" only added codes and never took them back. | `setExpression.ts` `withdrawStalePunches` |
| N5 | An empty trigger fired for every respondent: an unfinished "Hide when" removed the option for everyone, an empty validation check blocked everyone, an empty loop `skipIf` emptied the loop, and an empty quality rule flagged everyone. | A vacuous group evaluates true. A missing field and an empty field behaved oppositely. | `evaluate.ts` `conditionFires`, `carryforward.ts`, `validate.ts`, `probe.ts`, `loops.ts`, `adaptive.ts`, `quality/engine.ts` |
| N6 | A Qualtrics block that is not in the Survey Flow was shown to everyone. | The importer wrote FALSE as NOT(empty), which is vacuous, so it read as TRUE. | `import/map.ts`, `conditionWalk.ts` `constantCondition` |
| N7 | COUNT `where` was ignored except on `matching`. The new parser turned "selected" into "matching", which counts unselected options. | `where` was only read by one branch. | `countCondition.ts`, `logicExpression.ts` |
| N8 | A grid carry-forward's "displayed", "all" and "NOT selected" produced the grid's scale points, not its rows. A carried row took the scale point's label when the codes collided. | `codesFrom` and `optionFromSource` always read options first. | `carryforward.ts` |
| N9 | `create_question` dropped a validation rule's `when` and `check`. | `shapeQuestion` copied only kind and value. | `surveyActions.ts` |
| N10 | An ELSE IF punch printed as IF (Oweas #5). | The printer had no ELSE IF. | `autoPunch.ts` |
| N11 | The "logic" markers showed on questions and options with no working logic (Oweas #4). | They tested whether the field was truthy, and `{and: []}` is truthy. | `optionLogic.ts` `optionLogicHasEffect`, `conditions.ts` `isEmptyConditionTree`; Properties, outline chips, Copilot structure pane, Architect map, Grid |
| N12 | A numeric open end could not be the source of an auto punch, and value ranges could not be set (Prince 66). | The editor listed only choice questions. | `AutoPunchEditor.tsx` (numeric / text sources, = ≠ > ≥ < ≤ between) |
| N13 | Nested AND / OR on one multi-select could not be built in the punch editor (29-09 #3). | The builder was collapsed under the Expression box, and absent for rules with no condition. | `AutoPunchEditor.tsx` (Builder tab, "+ add condition") |
| N14 | Carry-forward offered five near-duplicate choices whatever the source was (Oweas 1–3, 6). There were no grid "displayed rows" (29-09 #5) and no "rows where column X was chosen" (29-09 #6). | One fixed enum list. | `PropertiesPanel.tsx` `CarryForwardEditor`; schema `CarryForward.columns` |

The behaviour of unconditional rules is **kept, and now flagged**. A skip rule or a HIDE
display rule with an empty condition still applies to everyone, as before. Existing surveys may
rely on that. Now:

- lint reports it;
- the Logic panel lists it under "check these rules";
- an unfinished skip rule shows "No condition yet — this rule skips every respondent".

## Behaviour changes to note before fielding

- **Whole-row, whole-column and whole-grid comparisons** now mean "any cell". Before, they never
  matched.
- **Randomizer "show N of M"** draws only from children the respondent is eligible for.
- **Hidden questions with "always" punches** give up codes whose rule no longer holds.
- **Grid carry-forward "displayed" / "all" / "NOT selected"** carry rows, not scale points.
- **COUNT `where`** narrows any COUNT, not only `matching`.

## Tests

- `packages/engine/src/nestedLogicAudit.test.ts`: 32 tests covering the brief's S1–S20 and each
  spreadsheet row.
- Also added:
  - import: the unused-block constant;
  - quality: an empty custom rule;
  - exporters: the spec's "Invalid when" / "only when" lines and the dictionary's "Asked when"
    column;
  - studio: `lib/intelligent/nestedGrammar.test.ts`.
- Browser: `scripts/nested-logic-audit-test.mjs`, 17 checks across Studio and runtime.
- Each fix was mutation-checked: the code was reverted and the tests confirmed to fail.

## Remaining

- **Spreadsheet items that are not logic:**
  - randomise rows and columns together (29-09 #1);
  - the "Options" logic button in grid column config (#2);
  - the quota target-total box width (#4, Prince 52);
  - the piping dialog fields (#7);
  - multiple images / media layout (Prince 11, 14, 16);
  - a URL-parameter image URL (Prince 36).
- **From the 09-28 audit:**
  - the analytics filter (3 levels), the interview builder (1 level) and the Response
    Manager's AND-only frame;
  - calc-language limits and nested IF…THEN in embedded expressions;
  - QSF single-comparison skips and quota groups;
  - Decipher named `<condition>`s;
  - the mapper dropping a whole condition for one unreadable leaf;
  - SPSS FILTER / DO IF syntax (the datamap has "Asked when");
  - editors for `ListFillOption.eligibleWhen` and for legacy `Option.visibleIf` / grid row
    `visibleIf`;
  - UX styles and animations, conjoint prohibitions and distribution filters still take no
    condition.
