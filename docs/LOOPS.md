# Loops — for-each / repeating blocks with loop-level references

```
FOR EACH qualifying item
    RUN Block X
END LOOP
```

A **loop** is a flow element. It iterates whatever is inside it once per item,
and every question inside runs with a *current item* it can pipe, test, compute
with and script against. The construct existed before this work (iterating a
block over selected options, a static list or a List Fill result); this document
describes what it does now. Nothing that worked before changed meaning.

---

## The one rule that shapes everything: references are loop-level

A loop can carry a table of programmer-defined columns for its items —
`Brand_Nickname`, `Product_ID`, `Client_Code`, `Category`, anything. That table
lives **on the loop node and nowhere else.**

- It is not a property of the source question. Creating a loop over Q2 leaves
  Q2 byte-for-byte unchanged (§40). The JSON of Q2 contains no reference values.
- It is not a property of Q2's options. `Apple` is still `{ code: 1, label:
  "Apple" }` and nothing more.
- It is not survey-wide. Two loops over Q2 can carry entirely different columns;
  LOOP_001's `Category` and LOOP_002's `Region` never meet, cannot collide, and
  are not visible to each other (§6, §41).
- Every reader — piping, conditions, calculations, scripts, the inspector, the
  export — reaches a reference **only through the iteration's context**. There
  is no function anywhere that answers "what is Apple's Product_ID" without
  first asking "in which loop".

```
Survey
 ├── Q1
 ├── Q2                      ← unchanged
 ├── Q3
 └── LOOP_001                ← the table lives here
       ├── source = Q2 (selected)
       ├── target = Block 2
       └── references
             ├── Brand_Nickname
             ├── Product_ID
             ├── Client_Code
             └── Category
```

In the JSON (§38):

```json
{
  "type": "loop", "id": "LOOP_001", "loopVar": "brand",
  "source": { "kind": "question", "questionId": "q2", "filter": "selected" },
  "references": {
    "columns": [
      { "name": "Brand_Nickname" }, { "name": "Product_ID" },
      { "name": "Client_Code" }, { "name": "Category" },
      { "name": "Priority", "dataType": "number" }
    ],
    "values": {
      "1": { "Brand_Nickname": "APPLE",  "Product_ID": "PROD_001", "Client_Code": "C001", "Category": "Smartphone", "Priority": 2 },
      "3": { "Brand_Nickname": "GOOGLE", "Product_ID": "PROD_003", "Client_Code": "C003", "Category": "Smartphone", "Priority": 1 }
    }
  },
  "children": [ … Block 2 … ]
}
```

Values are keyed by **item code** (so one table serves every order the loop can
run in) and by **column name** (so the JSON is self-describing; renaming a column
rewrites its key, which the editor does in one place). Because the table is part
of the definition, it versions with the survey (§39): version 1.0 with two
columns and version 1.1 with four are two different definitions, and a deployed
version runs with exactly its own.

---

## The pipeline

```
source → filter → eligibility → order → count → contexts
```

Implemented once, in `packages/engine/src/loops.ts` (`resolveLoopItems`). The
flow compiler, the Studio simulator and the runtime inspector all call it. A
preview and a live respondent can only disagree if the data they are given
disagrees.

### Source (§8)

| `source.kind` | items |
|---|---|
| `question` | a question's options, narrowed by `filter` |
| `listFill` | the items a List Fill allocated to this respondent, in allocation order |
| `static` | a list written into the loop |
| `count` | 1…N — a plain numeric iteration; N literal or from a question / calculation / embedded field / variable |
| `variable` | a list held in a calculated variable, embedded field or answer — a JSON array (`["a","b"]` or `[{"code":"a","label":"Apple"}]`) or a delimited string. How a script, a calculation or an API result (via embedded data) feeds a loop |
| `design` | a design file's tasks |

### Filter (question source only) — §9–§12

| `filter` | items |
|---|---|
| `selected` | the options the respondent chose (a single-select yields one) |
| `notSelected` | the options *shown* and not chosen — 3 of 5 selected leaves 2 |
| `displayed` | every option the display pipeline actually showed (masking, carry-forward, randomised subsets) |
| `all` | every option |
| `eligible` | every option that passes `eligibleIf` |
| `invalid` | codes in the answer that match no option, plus every option for which `invalidIf` holds |

"Selected / not selected / displayed" reuse `codesFrom`, the same single
definition the carry-forward and set-operation engines use, so "displayed" means
the same thing everywhere.

### Eligibility (§12)

`eligibleIf` is a per-loop condition evaluated **once per candidate item, with
that item as the loop context**. That is what lets it read the item's own
references:

```
loop.Category = "Smartphone"
```

It narrows the items whatever the filter is. It belongs to the loop, not to the
source question — two loops over Q2 can disagree about who is eligible.

### Order (§14)

| `order.kind` | |
|---|---|
| `source` | option / static order (default) |
| `selection` | the order the respondent chose them |
| `listFill` | allocation order (default for a List Fill source) |
| `priority` | by a reference column — `column`, `direction` |
| `random` | seeded — the same respondent always gets the same order |
| `weightedRandom` | seeded draw weighted by a reference column |
| `custom` | an explicit list of codes; anything unlisted follows in source order |

A random order uses the seed key the loop always used, so a respondent who was
mid-survey when this shipped keeps the order they started with.

### Count (§13)

| `count.mode` | |
|---|---|
| `all` | every qualifying item (default) |
| `exact` | exactly N — fewer qualifying items means fewer iterations; the loop never invents items |
| `max` | at most N |
| `min` | a **gate**: run only when at least N qualify, otherwise zero iterations |

`count.value` is a literal or `{ kind: "question" | "calculation" | "embedded" |
"variable", ref }` — `Loop Count = Q2_SELECTED_COUNT` is `{ kind: "question",
ref: "Q2" }` (a multi-select's count is how many were chosen).

The legacy fields `randomizeIterations` and `maxIterations` are still honoured
when `order` / `count` are absent.

---

## The current item (§19–§22)

Inside the loop, every question runs with a context:

| token | value |
|---|---|
| `{{loop.label}}` or `{{CURRENT_ITEM}}` | the item's label |
| `{{loop.code}}` or `{{CURRENT_ITEM_CODE}}` | its code |
| `{{loop.index}}` or `{{LOOP_INDEX}}` | 1-based position in this run |
| `{{loop.count}}` or `{{LOOP_COUNT}}` | how many iterations this run has |
| `{{loop.first}}` or `{{LOOP_FIRST}}` | `true` on the opening iteration |
| `{{loop.last}}` or `{{LOOP_LAST}}` | `true` on the closing iteration (empty when the count is unknown) |
| `{{loop.item}}` | the label again, under the brief's name |
| `{{loop.depth}}` or `{{LOOP_DEPTH}}` | how many loops enclose this iteration, counting itself |
| `{{loop.Product_ID}}` or `{{CURRENT_ITEM.Product_ID}}` | **any reference column, by name** |

`first` / `last` are the two questions every loop body eventually asks — a
different intro on the first pass, a summary or a different button on the
last — and until now had to be spelled `LOOP_INDEX = 1`, and could not be
spelled at all for the last (a rule compares a source to a literal, not to
another source). As conditions: `loop.first = true`, `loop.last = true`. The
condition builder and the piping picker list them; scripts see them on
`getCurrentLoopItem().first / .last / .item / .depth`.

Several in one question is ordinary text:

```
Evaluate {{loop.Brand_Nickname}} for product {{loop.Product_ID}} in category {{loop.Category}}.
→ Evaluate APPLE for product PROD_001 in category Smartphone.
```

A reference the loop does not declare renders **empty** — never the label. (It
used to render the label, which put the brand name into a sentence that asked
for a category, silently. The lint now names the unknown column instead.)
Reference values are HTML-escaped like every other pipe.

**Conditions** (display logic, skip logic, eligibility, anything that takes a
condition) read the same context:

```
loop.Category = "Smartphone"        CURRENT_ITEM.Category = "Smartphone"
LOOP_INDEX > 1                      loop.Priority >= 4      (numeric columns compare numerically)
```

As a structured rule: `{ source: { kind: "loop", ref: "Category" }, operator:
"eq", value: "Smartphone" }`. The condition builder offers the loop's columns by
name — and only for a question that is actually inside that loop, because
anywhere else the value would always be empty.

**Display logic, skip logic and validation are evaluated separately for every
iteration** (§27–§29): Q8 can be shown for Apple and hidden for Xiaomi in the
same run; Q7 in iteration 2 is validated against iteration 2's answer.

---

## The calc language inside an iteration

An expression evaluated from inside an iteration — an `expr` condition, a
set-expression `expr` payload, a **calculated question in the loop body**, a
script's `expr(...)` — resolves the body's questions as THAT iteration
answered them, under their plain codes: `Q7 * 2 + loop.index`, not `Q7_3`.
The loop's own properties are in scope as `loop.index`, `loop.count`,
`loop.first`, `loop.last`, `loop.code`, `loop.label`, `loop.<Column>`, the
`LOOP_INDEX` / `CURRENT_ITEM` aliases and `<outerLoopVar>.<prop>`. One
resolver, `calcOptionsFor(def, state, loop)` in `calcContext.ts`, for all of
them. A calculated question inside a loop is written per iteration
(`qc@apple`, `qc@google`) — before this it was evaluated once against the bare
keys and written once, the last iteration's value under a key no iteration
read.

Masked questions inside a loop report per iteration too: `MASK_Q7_2_COUNT`,
`MASK_Q7_2_LIST`, `MASK_Q7_2_ITEM_1` for iteration 2 (nested `MASK_Q9_2_1_…`),
positional like the answer columns `Q7_2`.

---

## Nested loops (§32)

Contexts form a stack, innermost first. `{{loop.x}}` is the innermost;
**an outer loop is addressed by its `loopVar`**:

```
{{brand.label}} {{loop.label}} — region {{brand.Region}}, sku {{loop.Sku}}
→ Apple Watch — region US, sku SKU-Y
```

and in conditions `brand.Region = "EU"` (structured: `{ kind: "loop", ref:
"Region", scope: "brand" }`). A loop's name is only read as a loop when no
question has that code.

Answer keys carry the **whole path**: a question inside the inner loop is stored
as `q@<outerCode>@<innerCode>`. A single loop still stores `q@<code>` exactly as
before, so nothing already saved moved. (Before this, an inner loop's context
replaced the outer one: every outer iteration wrote the inner loop's answers to
the same `q@<innerCode>` key and the last one won. That was a data-loss bug and
is gone.)

The inner loop's source (say, "which products of *this* brand") is read through
the outer context, so Apple's inner loop runs over Apple's products and
Google's over Google's. Lint refuses two nested loops with the same `loopVar`.

---

## Variables and export (§24, §29, §36, §37)

Every loop writes, on every recompute, into the calculated variables:

```
LOOP_BRAND_COUNT
LOOP_BRAND_ITEM_1              the label of whatever ran first
LOOP_BRAND_ITEM_1_CODE         its code — the join key back to the source
LOOP_BRAND_ITEM_1_PRODUCT_ID   one per reference column
LOOP_BRAND_ITEM_2 …
```

(`LOOP_` + the loopVar upper-cased; a nested loop is prefixed with the outer
item: `LOOP_BRAND_A_LOOP_PRODUCT_COUNT`.) They are readable in calculations,
conditions, piping and scripts the moment the source is answered.

**Questions inside a loop export as positional columns** — `Q7_1 … Q7_N`, N
being the most iterations the definition allows — declared in the dictionary up
front, following the List Fill precedent, so a dataset has the same columns
before the first respondent and after the last. Position n's item is whatever
`LOOP_BRAND_ITEM_n_CODE` says ran n-th, which is how a randomised loop still
exports cleanly. Nested: `Q9_2_1` is the first inner iteration of the second
outer one.

This fixes a pre-existing gap: loop answers **never reached CSV or XLSX at all**
(the dictionary had no rows for them), and the old `Q7_<code>` naming collided
with a multi-select's own `Q7_<optionCode>` flag columns. A response stored
before the loop variables existed still flattens to the old spelling, so nothing
already exported changes.

The XLSX variable dictionary gains a **Loops** sheet — Loop ID, Loop, Source,
Iteration, Item, Item Code, Reference Column, Reference Value, Reference Type,
Question Variable, Data Type, Loop Variable — making Loop → Item → Reference →
Question explicit. The Variables sheet carries Loop / Iteration / Reference
columns. A survey with no loop exports exactly the three sheets it always did.

A loop whose size the definition cannot know (a count from a variable, a list
from a variable) declares its `_COUNT` only; its answers are still stored per
iteration and reachable by code, and the lint says why there are no positional
columns.

---

## Scripts (§31)

```js
getCurrentLoopItem()                 // { code, label, item, index, count, first, last, depth, references }
getCurrentLoopIndex()                // 1-based; 0 outside a loop
getLoopCount()
getCurrentLoopReference("Product_ID")   // any column name — nothing is hardcoded
getLoopItems()                       // every iteration of the current loop, in order
getLoopAnswer("Q7", "3")             // another iteration's answer
```

Each takes an optional trailing `scope` — a loopVar — to address an outer loop:
`getCurrentLoopReference("Region", "brand")`. `get`/`set` stay loop-scoped, and
`getLoopAnswer` is the one sanctioned way to cross iterations, so the `@`
convention stays an engine detail. `loop` (the raw context) is still available.
`expr("Q7 + 1")` inside an iteration reads that iteration (see *The calc
language inside an iteration*).

**A page's `on_load` runs when the page is shown** — for a loop body, once per
iteration (`p6@apple`, `p6@google`), with that iteration as `loop`, so
`get`/`set` land on the iteration's keys. Survey-wide `on_load` still runs
once when the session opens. Before this a page-scoped `on_load` never ran at
all: the session-open call passed no page, so no page script ever matched.

---

## Studio

The loop card in **Survey Flow** opens into the loop editor:

- **Source** now offers *a set expression* — "the brands in both screeners" —
  with the same visual chain / text editors masks use (`SetExprField`,
  exported from `MaskingBuilder`). The schema and engine had the source; the
  editor could not produce it and destroyed one on any kind switch.
- **Custom order** can be typed for an unbounded source too (the engine
  honoured it; the editor hid the field).
- **This loop as a statement** — the configuration read back as
  `FOR EACH brand IN Q2.selected / WHERE … / ORDER BY … / AT MOST … / BREAK
  WHEN … / RESOLVE ONCE / LOOP_BRAND_AVG = avg(Q7)` (`describeLoop`), in the
  grammar the condition and mask expression tabs use. One-way on purpose: the
  conditions round-trip in their own editors, and a parser for the loop's own
  shape would be a second grammar to keep in step with the editor for ever.
- The mask builder's **Loop Item** payload takes a `scope` (an enclosing
  loop's name) as well as a reference column, so a mask inside a nested loop
  can punch the OUTER item.

- **Source / filter / name** — every source kind, including List Fill (the
  previous editor could not produce one and destroyed it on a kind switch).
- **Eligibility rule**, and **what makes an item invalid** for the `invalid`
  filter — ordinary condition builders whose source list offers this loop's
  columns.
- **Iterations** (all / exactly / at most / only if at least) and **Order**.
- **Loop references** — one row per item the source can produce; **+ Add
  Reference Column** (name, type, required); rename by editing the header;
  reorder with ‹ ›; remove; type each cell. Required cells with no value are
  outlined and the lint reports them.
- **Import…** — paste CSV/TSV with a header row (first column or one named
  `code` is the item code; every other header becomes a column, created if
  missing) or a JSON object keyed by code. Rows for codes the source cannot
  produce are kept and reported. Save an Excel sheet as CSV first.
- **Loop simulator** (§34) — tick the source answers and read the iterations
  the runtime would run, with every reference value. It calls
  `simulateLoop`, which is `resolveLoopItems` — it cannot disagree with the
  runtime.

A question inside a loop shows an **in loop "brand"** chip in its properties,
naming the references it can use; its condition builder and piping picker offer
them (and an outer loop's, when nested).

## Runtime

In test/preview mode the inspector shows a **Loop debug** block (§35): loop id,
iteration n / N, current item, code, and every reference value — the exact
context the block is running with — and an outer block beneath it when nested.

"Other, specify" text is now per iteration. It was shared across iterations
while validation read the scoped key, so Apple's text reappeared under Google.

**Randomization is per iteration and stable per respondent.** Option, row and
column shuffles always were (`rand:<q>@<code>`); now a **randomizer node
inside a loop body** draws afresh for each iteration (`flow:<id>@<code>`), and
a **nested loop's random / weighted order** is drawn per outer iteration
(`loop:<id>@<outer>`) — Apple's products in one order, Google's in another. A
top-level loop's seed key is unchanged, so a respondent mid-survey keeps their
order. Design-based tasks (conjoint, MaxDiff) inside a loop still draw one
version per respondent; the lint says so.

**Safeguards.** `MAX_LOOP_ITERATIONS = 200` per loop, `MAX_LOOP_DEPTH = 5`
(now enforced at runtime too — a sixth level resolves to nothing), and
`MAX_LOOP_PRODUCT = 2000` for the nest as a whole: outer × inner × … is
trimmed at the innermost loop, so five nested loops of 200 cannot compile
3.2 × 10¹¹ pages. All three truncate rather than error; the lint is where the
author finds out.

**`resolveSource: "once"` snapshots are stamped** with a fingerprint of the
loop's definition (source, rules, count, order). A session resumed after the
programmer changed what the loop iterates over retakes the snapshot instead
of keeping the old list for ever; a snapshot from before the stamp existed is
still honoured.

## Lint

From the definition alone (`lintLoops`, part of `lintSurveyLogic`):

- a token or rule naming a reference column the loop does not declare — the
  silent-empty case this lint exists for — **error**
- duplicate / non-identifier / built-in-shadowing column names — error
- a required column with a hole — warning, naming the items
- a source question asked after the loop — error
- nested loops with the same name — error
- exact/min count larger than the source can supply — warning
- ordering by a column the loop lacks — error
- a loop token outside every loop — warning
- an unbounded source (no positional export columns possible) — warning
- a bounded nest whose outer × inner product exceeds `MAX_LOOP_PRODUCT` — warning
- aggregate names: non-identifier or duplicate — error; over a question outside the loop — warning
- a List Fill whose source / count question, or a destination, sits inside a
  loop body — warning: a List Fill runs once per respondent on the plain
  keys, so it cannot see or feed per-iteration answers (loop over the List
  Fill instead)
- an AI follow-up (probe), an AI-derived variable, or a design-based task
  inside a loop — warning: these are per respondent, not per iteration

## Where things are

| `calcContext.ts` | `calcOptionsFor(def, state, loop)` — the one resolver, loop-aware |
| `loopDescribe.ts` | `describeLoop` — the loop as one statement |
| | |
|---|---|
| schema | `packages/schema/src/flow.ts` — `LoopSource`, `LoopReferences`, `LoopOrder`, `LoopCount`; `conditions.ts` — `scope` on a loop source |
| engine | `packages/engine/src/loops.ts` (pipeline, variables, simulator), `loopModel.ts` (structure, no evaluation), `state.ts` (`LoopContext`, `loopKeySuffix`, `answerLookupKeys`, `lookupAnswer`, `loopValue`, `findLoopScope`) |
| tests | `packages/engine/src/loops.test.ts` (29), `loopControlFlow.test.ts` (19), `loopIntegration.test.ts` (13 — first/last, the calc language and scripts inside an iteration, per-iteration randomization, the nest cap, snapshot stamping, per-iteration masks, dependency edges, the lints, the statement), `packages/exporters/src/exporters.test.ts` (3 loop tests), `scripts/loop-test.mjs` (25, Studio → runtime) |
| studio | `components/studio/LoopEditor.tsx`, `loopScope.tsx`; `ConditionBuilder`, `PipingPicker`, `PropertiesPanel` |
| runtime | `Runner.tsx` (full-path keys, per-iteration other-text), `Inspector.tsx` (Loop debug) |
| export | `packages/exporters/src/variableDictionary.ts` (Loops sheet), `exportConfig.ts` |
