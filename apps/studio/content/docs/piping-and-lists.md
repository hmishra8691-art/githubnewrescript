# Piping, lists and loops

## Piping

A `{{ … }}` token in a question text, instruction, option label, HTML block, end message, redirect URL or media URL is replaced with a value when the page renders.

```
{{Q4}}                      the answer's label(s)
{{Q4.value}}                the code(s)
{{Q3.labels|and}}           all selected labels as "A, B and C"
{{Q3.count}}                how many were selected
{{Q3.first}} {{Q3.last}}    the first / last selected
{{Q3.remaining}}            what was displayed and not selected
{{Q7[r2].label}}            a grid row's answer
{{Q3.other}}                the "other, specify" text
{{Q12.city}}                part of a location answer (lat, lng, address, city, region, country, radius)
{{calc.SCORE}}              a calculation
{{ed.PANEL_ID}}             embedded data
{{loop.label}} {{loop.index}} {{loop.count}} {{loop.<column>}}   the current loop item
{{brand.Category}}          an outer loop by its loopVar
{{expr: Q1 + Q2}}           an inline expression
{{Q3.labels|bullets}}       formats: comma (default), and, or, bullets, numbered, lines, upper, lower, title, image, join:<sep>
```

Properties and formats are listed in the [logic reference](logic-reference). A token for a question not yet answered renders empty; the review flags a token that names a question asked later.

## Carry-forward and option logic

A question's option list can be built from another question's answers — the brands chosen at Q3 become the options of Q4:

```json
"carryForward": { "sourceQuestionId": "q_brands", "filter": "selected", "into": "options", "keepOwn": false }
```

`filter` is `selected`, `not_selected`, `displayed`, `answered_rows` or `all`; `into` is `options`, `rows` or `columns`; `keepOwn` keeps the question's own options beside the carried ones; `where` filters further. Each option, row and column can also carry its own **logic** (`logic`): `visibility: always_show | always_hide | show_when | hide_when` with `when`, `eligibleWhen`, `excludeWhen`, `prioritizeWhen`, `deprioritizeWhen`, `randomizeWhen`, and `carryForward` / `carryBack` from a source question by code, value or label.

**List logic** (`listLogic[]`) includes or excludes another question's selections: `{ sourceQuestionId, action: include | exclude | prioritize | deprioritize, which: selected | not_selected | displayed, when? }`. **List operations** (`optionPipeline[]`) are the general form: `carry_forward, union, intersect, difference, exclude, remaining, prioritize, deprioritize, dedupe, filter, sort, randomize` over one or more sources.

The option pipeline runs in a fixed order: source (static or carried) → always-hidden → eligibility (option logic, `visibleIf`, display rules) → list logic → list operations → prioritisation → sorting → randomization → piping. Always-show options survive the middle stages unless `excludeWhen` removes them.

## Randomization

```json
"randomization": { "enabled": true, "scope": "options", "method": "shuffle", "groups": [[1, 2, 3], [4, 5]], "pick": 3,
  "rules": [{ "id": "r1", "when": { "type": "rule", "source": { "kind": "question", "ref": "q_segment" }, "operator": "eq", "value": 1 }, "method": "rotate" }] }
```

`scope` is `options`, `rows` or `columns` (or several in `scopes`); `method` is `shuffle`, `rotate`, `reverse_half` or `none`; `groups` randomizes within groups and keeps the groups in order; `pick` shows N of the list; `rules` choose a method by condition (first match wins). Options flagged `anchor_top` / `anchor_bottom` stay in place; option groups (`optionGroups`, `groupOrdering`) give structured lists their own ordering (`fixed, random, rotate, flip, alpha_asc, numeric_desc, priority, custom`…). Blocks are randomized with a `randomizer` flow node (`show: N` presents N of its children). In Intelligent mode: "randomize Q7 options keeping Other last", "show 3 random options of Q5", "randomize blocks Usage and Brands", "stop randomizing Q7".

## List Fill

A List Fill decides which items each respondent gets — which of twenty concepts to rate, which three brands to evaluate — from a source (`question`, `static`, `calculation`, `embedded`, another `listFill`, a `script`), a selection (`count` fixed, all, from a question, calculation or expression; `method` such as `priority_quota`, `balanced_random`, `weighted_random`, `selection_order`; what to do after an item's target or maximum is reached; a fallback), and tracking (sample-level counts, quota awareness, completes only). Each option has a `priority`, `target`, `maximum`, `weight` and `eligibleWhen`; destinations say which questions receive the items (`write: answer | piping_only`) and what to do with an unused destination (`hide, skip, disable, blank, do_not_instantiate, terminate_block`).

The allocation runs on the server and is recorded; it publishes `LISTFILL_<NAME>_COUNT`, `LISTFILL_<NAME>_<n>` (label), `_<n>_CODE`, `_<n>_POSITION`, `_CODES`, `_LABELS`, usable in logic, piping and loops (`LISTFILL(name)` in a set expression; `source.kind: "listFill"` on a loop).

## Loops

A loop node repeats its children once per item:

```json
{ "type": "loop", "id": "l_brands", "loopVar": "brand",
  "source": { "kind": "question", "questionId": "q_brands", "filter": "selected" },
  "count": { "mode": "max", "value": 3 }, "order": { "kind": "random" },
  "references": { "columns": [{ "name": "Category", "dataType": "text" }], "values": { "1": { "Category": "Smartphone" }, "2": { "Category": "Tablet" } } },
  "aggregates": [{ "name": "AVG_SAT", "questionRef": "q_sat", "op": "avg" }],
  "children": [{ "type": "page", "id": "p_loop", "questionIds": ["q_sat"] }] }
```

Sources: a question's selected / not selected / displayed / all options (or rows or columns), a static list, a design, a List Fill, a count, a variable with a separator, a set expression. `count` limits iterations (`all, exact, max, min`); `order` is `source, selection, listFill, priority, random, weightedRandom, custom`; `eligibleIf`, `skipIf` and `breakIf` gate iterations; `references` attach columns to items, readable as `loop.Category` (or `brand.Category` from an inner loop) in logic and piping; `aggregates` publish `LOOP_<VAR>_<NAME>` after the loop. Inside the loop a question's answer is stored per item (`SAT_1`, `SAT_2`…), and `CURRENT_ITEM`, `LOOP_INDEX`, `LOOP_COUNT`, `LOOP_FIRST`, `LOOP_LAST` are available. In Intelligent mode: "create a loop around Q8 to Q9 for each brand selected in Q5".
