# Logic and expressions

Everything conditional in a ReScript survey — display logic, skip logic, validation gates, branch conditions, option visibility, quota cells, list operations, punches — is a **condition**. Everything computed — calculated variables, inline piping, expression sources — is an **expression**. Both have a text form you write and a JSON form the definition stores; the engine compiles one to the other and refuses what it cannot read, with the object named.

## Conditions in text

A condition names a question by its code or variable name, an operator, and a value.

```
Q1 >= 18
AGE between 25 and 34
Q3 = Female                      -- an option by its label (stored as its code)
Q3 = 2                           -- or by its code
Q5.3                             -- a multi-select option is selected (bare reference)
Q5.3 IS SELECTED
Q5 contains any [1, 3]
Q5 contains all [1, 2]
Q7 answered                      -- "Q7" alone means the same
Q9 is empty
Q9 starts with "Dr"
Q11 ranked first A               -- the option ranked first (ranked last, ranked top N, not ranked)
Q12.r1 >= 4                      -- a grid row (R1, O1, A1 are sugar for "code 1, else the first")
Q13.r1.c2 = 3                    -- a composite cell: row, then column id or scale point
Q7 before 2024-01-01             -- dates are ISO literals
Q5 > Q6                          -- another question on the right-hand side
Q2.$first                        -- positions: $first, $last, $3
```

Connect conditions with `AND` (`&&`), `OR` (`||`), `NOT` (`!`), parentheses, `NOR` (= NOT (A OR B)) and `BUT NOT` (= AND NOT). `NOT` binds tighter than `AND`, `AND` tighter than `OR`; mixing `AND` and `OR` without brackets is accepted with a warning.

```
(Q3 = Male OR Q3 = 2) AND NOT Q5.3
Q1 < 18 OR Q1 > 65
IS_ADULT AND Q3 = "Female"       -- a named expression
calc.SCORE > 10 AND ed.PANEL = abc
quota.q_gender >= 200
loop.Category = "Smartphone"     -- inside a loop: the current item's reference column
@option.value > 3                -- per-option logic: the option under test
```

Every operator's spellings are in the [logic reference](logic-reference). Namespaces: `calc.X` (a calculation), `ed.X` / `embedded.X` (embedded data), `quota.X` (a quota's count), `loop.code | label | index | count | first | last | depth | <column>` and `<loopVar>.<column>` for an outer loop, `rule.NAME` / bare `NAME` for a named expression, `@option.code | label | value | index` in per-option logic.

**Counts.** `COUNT(Q5) >= 2` counts selections; `COUNT(Q12, matching, rows, answering [4, 5]) >= 1` counts the rows answered 4 or 5; the full form is `COUNT(Q, selected | notSelected | valid | invalid | eligible | visible | hidden | matching, options | rows | columns, only [codes], answering [codes], group G, where (@option.value > 3))`. On the right-hand side `COUNT(Q6)` is a value.

**Arithmetic in a condition.** `Q5 + Q6 > 100`, `SUM(Q1, SCORE) > 100`, `AGE(Q7) >= 18` — any calculation expression compiles to an expression source. `CONTAINS(Q9, "price")`, `STARTSWITH(…)` and `ENDSWITH(…)` are complete conditions on their own.

## Conditions in JSON

The stored form is a tree of rules and groups:

```json
{ "type": "group", "op": "and", "children": [
  { "type": "rule", "source": { "kind": "question", "ref": "q_age" }, "operator": "gte", "value": 18 },
  { "type": "group", "op": "not", "children": [
    { "type": "rule", "source": { "kind": "question", "ref": "q_brands" }, "operator": "selected", "value": "3" } ] } ] }
```

`source.kind` is `question` (the default; `ref` is the question **id**, with `rowCode`, `columnId`, `rowPosition`, `optionPosition` for parts), `variable`, `embedded`, `calculation`, `quota`, `loop`, `option` (per-option logic), `expr` (`ref` is a calculation expression) or `rule` (a named expression). `operator` is one of the 37 operators; `value` and `value2` carry the operands (a list for `in` / `containsAny`…, two values for `between`). A value can be dynamic: `{ "$option": "code" }` (the option under test) or `{ "$question": "q_other", "read": "answer" | "count" }`.

Where the definition takes a `Condition` (`displayLogic`, `skipLogic[].when`, `validation[].when`, `branches[].when`, `visibleIf`, `quotas[].cells[].when`…) it takes this JSON. Intelligent-mode actions and the editor take the text and compile it.

## Display logic, skip logic, validation

**Display logic** (`question.displayLogic`, `page.visibleIf`, `block.visibleIf`, `option.visibleIf`) shows the object only while the condition holds. The engine refuses logic that reads a question asked later than the object it controls.

**Skip logic** (`question.skipLogic[]`) is a list of `{ when, target }` evaluated when the question's page is submitted: `target.kind` is `question`, `page`, `block`, `section` (with `ref`), `end`, `terminate` (with `status: screened | quota_full | terminated | complete`) or `url`. A screener is a skip to `terminate` with `status: "screened"`.

**Validation** rules are listed on the question. A rule's `when` gates it (`min_selections: 2` only when `Q4 = 1`); `kind: "condition"` with `check` turns any condition into a rule — `check` is the condition a *valid* answer must satisfy as the editor writes it (the engine stores the invalid case). `severity: "warning"` lets the respondent continue.

**Display rules** (`displayRules[]`) are the same as display logic but named, targetable at any object including options, rows and columns, with `action: show | hide`. HIDE beats SHOW; among SHOW rules the last wins.

## Calculations

A calculation is an expression over the answers, evaluated at a trigger:

```
sum(Q7_r1, Q7_r2, Q7_r3) / 3
if(Q1 >= 65, "senior", if(Q1 >= 35, "mid", "young"))
round(pct(ALLOC_1, ALLOC_total), 1)
age(DOB)
concat(upper(Q2), " ", Q3)
avg(ALLOC_*)                    -- a wildcard over variable names
coalesce(Q9, 0)
countif(Q7_r1, Q7_r2, Q7_r3, ">=", 4)
```

Operators are `+ - * / %`, comparisons, `and` / `or` / `not`; strings are quoted; `+` concatenates when either side is a string; division by zero is null. Names resolve in order through the loop scope, the flat variables (`VAR`, `VAR_<code>`, `VAR_<row>`, `<stem>_<row>`), earlier calculations, embedded data and named expressions (1 or 0). The function list — aggregates, arithmetic, logic, strings, dates, geo and the two server-resolved AI functions — is on the [logic reference](logic-reference).

Inline, in any text: `{{expr: Q1 + Q2}}`. A `calculated` question is a calculation with a place in the flow and `settings.expression`.

## Set expressions and masks

A set expression names a set of option codes: `Q5` or `Q5.Selected`, `Q5.Unselected`, `Q5.Options` / `All`, `Q5.Displayed`; `[1, 2]`; `LISTFILL(name)`; `EXPR(<calc>)`; `CURRENT_ITEM`. Combine with `UNION` / `OR`, `INTERSECTION` / `AND`, `DIFFERENCE` / `MINUS` / `EXCEPT`, `NOT` / `COMPLEMENT`.

```
(Q5 UNION Q6) DIFFERENCE Q6.Unselected
Q5 MINUS [3]
[1, 2] UNION Q6.Displayed
```

A **mask** on a question (`mask`, `rowMask`, `columnMask`) is a set expression with an action: `display` (show only these), `preselect`, `display_and_preselect`, `disable`, `remove`; `keepAlwaysShow` protects anchored options; `onEmptySource` says what to do when the set is empty. In Intelligent mode: "mask the brands selected in Q5 from Q10", "at Q10 show only the brands not selected in Q5".

## Auto-punch

A punch sets answers from criteria, stored on the target question (`punches[]`):

```
IF Q5.1 IS SELECTED THEN SELECT Q6.1
IF COUNT(Q5) >= 2 THEN SET SEG = Heavy
ELSE IF Q1 < 18 THEN SET SEG = Light
ELSE SET SEG = Light
IF Q3 = 2 THEN HIDE Q6.3 AND DESELECT Q5.3
IF Q1 > 60 THEN CLEAR Q6
```

Verbs: `SELECT` / `PUNCH`, `DESELECT` / `UNSELECT` / `UNPUNCH`, `CLEAR`, `SET … = …`, `SHOW`, `HIDE`, `ENABLE`, `DISABLE`. A rule's `recompute` is `once` (the first time its condition holds) or `always`; rules run by `priority` then order. In Intelligent mode: "if Q3 = 2 then code SEGMENT as 2", "when Q5.1 is selected, select Q6.1".

## What the engine checks at the change

Every edit — from the editor, from a sentence or from a model — is applied to a copy and validated before it is shown: a condition that reads a question asked later, an operator the source cannot answer (`contains` on a number), a comparison with an option that no longer exists, a cycle, a validation kind the type does not support, a skip to a question before its source. Each is refused with the object named and, where one is obvious, the corrected action offered. What a batch newly breaks elsewhere (a planned test now reading an open text, a translation whose source changed) is reported with it.
