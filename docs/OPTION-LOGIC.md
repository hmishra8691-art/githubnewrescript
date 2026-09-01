# Option logic, list processing and piping

This is the reference for everything that decides **which answer options a
respondent sees, in what order, and what dynamic text surrounds them**.

Three primitives do all the work, and they are deliberately generic — there is
no per-question special-casing anywhere in the platform:

| Primitive | Lives in | What it expresses |
| --- | --- | --- |
| `Condition` | `packages/schema/src/conditions.ts` | any AND/OR/NOT tree over any source and operator |
| `OptionLogic` | `packages/schema/src/optionLogic.ts` | what one option does |
| `ListOperation` | `packages/schema/src/optionLogic.ts` | set algebra over other questions' answers |

Everything below is **optional**. A survey saved before this feature existed
carries none of these fields, and the pipeline reduces to exactly what it did
before: static options → `visibleIf` → list logic → sort → randomize → piping.

---

## 1. The pipeline

`effectiveQuestion()` (in `packages/engine/src/carryforward.ts`) is the single
implementation. The editor, the runtime, validation, exports and the debugger
all call it, so what a programmer configures is what ships.

```
  1  source            static options, or question-level carry-forward
  2  always hidden     options flagged "Always Hide" leave the list
  3  eligibility       per-option logic + legacy visibleIf
  4  previous answers  listLogic include / exclude / prioritize / deprioritize
  5  list operations   optionPipeline: intersect, union, difference, exclude,
                       remaining, dedupe, filter, sort, randomize
  6  prioritization    per-option prioritize / deprioritize conditions
  7  sorting           presentation sort (never mutates programmed order)
  8  randomization     conditional sets, N-of-M, anchors, groups, pinning
  9  piping            tokens resolved inside the surviving labels
```

The order is fixed and deterministic. Two rules matter:

* **"Always Show" is protected.** Stages 3–5 cannot remove it, and stage 8's
  "show only N" can never drop it (it is still shuffled, just never dropped).
  The single escape hatch is an explicit `excludeWhen` on that same option —
  the programmer deliberately overriding their own pin.
* **Randomization is seeded.** The same respondent seed always produces the
  same order, so a session can be replayed and debugged.

Matrix **rows** run stages 1–3, 6 and 8 (the list operations are option-only).
Composite **columns** run stages 1 and 3.

---

## 2. Option-level logic

```jsonc
{
  "code": "other",
  "label": "Other",
  "logic": {
    "visibility": "always_show",       // default | always_show | always_hide
                                       // | show_when | hide_when
    "when":            { /* Condition — used by show_when / hide_when */ },
    "eligibleWhen":    { /* extra gate */ },
    "excludeWhen":     { /* hard removal, beats always_show */ },
    "prioritizeWhen":  { /* move to top */ },
    "deprioritizeWhen":{ /* move to bottom */ },
    "randomizeWhen":   { /* false ⇒ pinned to its programmed slot */ },
    "carryForward": { "sourceQuestionId": "q1", "which": "selected", "match": "code" },
    "carryBack":    { "direction": "back", "sourceQuestionId": "q9", "which": "selected" }
  }
}
```

**Carry back** points at a question asked *later*. While that question is
unanswered the rule is skipped rather than failing closed, so an option is
never hidden by a question the respondent has not reached yet. Studio warns
when the direction and the flow order disagree.

### Option-to-option matching

The value side of any rule may be `{ "$option": "code" | "label" | "value" | "index" }`,
which resolves to the option currently being evaluated. That is how **one**
rule covers an entire option list:

```jsonc
{ "type": "rule",
  "source":   { "kind": "question", "ref": "q_used" },
  "operator": "selected",
  "value":    { "$option": "code" } }
```

> *Show this option when its own code was selected in Q_USED.*

`index` is the option's **programmed** position — it does not shift when an
option above it is filtered out, so the same rule means the same thing at
every stage of the pipeline.

A rule can also **read** the option under test with
`source: { kind: "option", ref: "label" }` — used by `filter` operations such as
"keep options whose label starts with A".

---

## 3. List operations

```jsonc
"optionPipeline": [
  { "id": "op1", "kind": "intersect",
    "sources": [ { "questionId": "q1", "which": "selected" },
                 { "questionId": "q3", "which": "selected" } ] },
  { "id": "op2", "kind": "exclude",
    "sources": [ { "questionId": "q2", "which": "selected" } ] }
]
```

| kind | effect on the working list |
| --- | --- |
| `carry_forward` | replace the list with options drawn from the sources |
| `union` | append options from the sources that are not already present |
| `intersect` | keep options whose code appears in **every** source list |
| `difference` | keep options in `sources[0]` that are in none of `sources[1..]` |
| `exclude` | remove options appearing in **any** source list |
| `remaining` | keep options appearing in **no** source list ("not yet seen") |
| `prioritize` / `deprioritize` | move matching options to the top / bottom |
| `dedupe` | drop repeated codes, keeping the first |
| `filter` | keep options where `where` holds (`$option` available) |
| `sort` | order the list — presentation only |
| `randomize` | shuffle / rotate / pick N, honouring anchors and pins |

An operation whose sources have all been deleted — or `difference` with fewer
than two lists — is skipped rather than evaluated against the empty set, so a
broken reference can never silently wipe a question's options at runtime.
Options imported by `union` / `carry_forward` are put through the eligibility
stage as they arrive, so an option the source marked **Always Hide** stays
hidden wherever it travels.

`which` selects the slice of the source answer:
`selected`, `not_selected`, `displayed`, `answered_rows`, `all`.
`displayed` runs the source question's own pipeline, so
`exclude + displayed` is "everything they have not been shown yet".

---

## 4. Operators

Only operators that make sense for the source question are offered in the
editor, and the linter rejects the rest (`operatorsForQuestion`).

| family | operators |
| --- | --- |
| any | `answered` `unanswered` `isEmpty` `isNotEmpty` `eq` `ne` |
| choice | `selected` `notSelected` `in` `notIn` `contains` `notContains` |
| list | + `containsAny` `containsAll` `containsNone` |
| text | `startsWith` `endsWith` `matches` |
| numeric | `gt` `gte` `lt` `lte` `between` `notBetween` |
| ranking | `rankedFirst` `rankedLast` `rankedTopN` `rankEquals` `rankGreaterThan` `rankLessThan` `notRanked` |
| date | `dateBefore` `dateAfter` `dateEquals` `dateBetween` |

Rank operators take the code in `value` and the rank number in `value2`.

---

## 5. Piping

Stored as text — `{{Q1.labels|and}}` — which is what the engine, the exporters
and every existing survey already use. `packages/engine/src/pipingTokens.ts`
is the structured view: `parsePipeBody` → descriptor → `serializePipeToken`.
The Studio's picker composes descriptors, and the rich-text editor renders
tokens as non-editable chips so a pipe cannot be half-deleted into broken
syntax. Chips are converted back to tokens on every commit; the HTML tab
always shows the real stored source.

**Properties** — `label` `value` `count` `first` `last` `rank` `displayed`
`remaining`, plus `{{Q1[row].label}}` for matrices.

**Formats** — `comma` (default) `and` `or` `bullets` `numbered` `lines`
`upper` `lower` `title`, plus `|join:/` for a custom separator.

Token whitespace has always been trimmed, so `|join:, ` means `","`, not
`", "` — use `|and`, `|or`, `|lines` or `|bullets` for spaced, readable lists.
Case formats skip tags and HTML entities, so `|upper` on `Ben &amp; Jerry`
gives `BEN &amp; JERRY`, never `BEN &AMP; JERRY`.

```
{{Q1.labels|and}}        → Apple, Orange and Banana
{{Q1.count}}             → 3
{{Q1.remaining}}         → options shown but not selected
{{calc.SCORE}} {{ed.PANEL_ID}} {{loop.label}} {{expr: Q1 + Q2}}
```

Respondent-derived values are HTML-escaped on the way out; programmer-authored
labels keep their formatting. That boundary is enforced in `html.ts`.

---

## 6. Dependencies, cycles and performance

`packages/engine/src/dependencies.ts` builds one graph from **every** source of
coupling — display logic, option logic, list logic, list operations,
carry-forward, conditional randomization, validation guards and piping tokens.

```ts
dependencyGraph(def)          // question → what it reads
dependentsGraph(def)          // question → who reads it
dependentsOf(def, "q1")       // everything downstream, transitively
detectLogicCycles(def)        // [["q4","q5"], …]
questionOrder(def)            // flow order, for forward-reference checks
```

`dependentsOf` is the recalculation set: when one answer changes, only those
questions need re-evaluating. `detectLogicCycles` blocks
"Q4 depends on Q5 depends on Q4" in the editor, and the pipeline additionally
carries a runtime re-entrancy guard so a bad definition can never hang a
respondent.

## 7. Validation

`lintSurveyLogic(def)` / `lintQuestionLogic(def, q)` return typed issues for:

* references to questions, rows, columns or calculations that do not exist
* option codes that were renamed or deleted
* operators incompatible with the source question
* empty condition groups and unset comparison values
* forward references (reading a question asked later)
* carry forward / carry back pointing the wrong way
* list operations with no source, or `difference` with fewer than two lists
* piping from a question that is unavailable at that point
* circular dependencies

Errors surface on the question in the Properties panel, in the option
debugger, and survey-wide under **Logic → Logic check**.

## 8. Debugging

`explainOptions(q, ctx)` re-runs the pipeline and keeps the reasoning:
every stage's before/after, what it removed and why, and a per-option status
(`visible` / `hidden`, the deciding stage and rule, `alwaysShow`, `pinned`,
`moved`, final position).

* **Studio** — *Option preview* under the options editor: set the answers this
  question depends on and watch the pipeline run.
* **Runtime** — the test-mode inspector shows the same trace for every dynamic
  question on the current page.
