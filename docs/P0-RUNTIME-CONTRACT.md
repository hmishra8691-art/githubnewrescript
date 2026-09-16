# The P0 runtime contract — embedded data, others specify, piping, logic

What was reported: Embedded Data variables left the survey runtime on a blank
loading screen; "Others Specify" text did not pipe; AND conditions sometimes
evaluated wrongly.

What was found, and fixed, is below. The short version: none of the three was
a bug in the thing it was reported against. The AND operator is correct, the
`{{Q1.other}}` token has always worked, and the engine starts every embedded
shape we could construct. In each case the defect was one layer down — **a
value that meant several things at once**, or **a name that only half the
product knew about**.

---

## 1. Embedded data

### `def.embeddedData` is a registry the Studio has never written to

Every embedded variable a programmer creates is a field on an **Embedded Data
node in the flow** (`def.flow[].fields[]`). The survey-level
`def.embeddedData` array exists in the schema and is written by nothing in the
Studio.

Five readers only ever consulted that empty registry:

| Where | What it did |
|---|---|
| `lintLogic.bareNameResolves` | reported the programmer's own variable as unknown |
| `lintLogic` piping check | "No embedded data field named …" on a token that resolves |
| `lintLogic` condition check | "References X, which does not exist in this survey" |
| `piping.lintPipingTokens` | the same, live, as the programmer typed |
| `variables.buildVariableDictionary` | **no column in the dictionary, the SPSS file or the analysis dataset** |
| `logicExpression` token list | the expression editor did not offer it |
| `responseImport` column mapping | an import could not map to it |

All now read `embeddedCatalog(def)` — the union of the registry and every
flow-declared field, which is what the piping picker already used. That is why
the linters, the runtime and the dictionary now agree.

The dictionary fix immediately exposed a real duplicate in the `brand_tracker`
starter: `WAVE` was declared twice, as a hidden question *and* as an embedded
field. The hidden question is gone; the embedded field reads `?WAVE=`.

### An unnamed row is not a variable

`FlowPanel` creates an Embedded Data node already holding
`{ name: "", source: "url" }` so there is something to type into, and the
schema accepts it (`z.string()`, deliberately — tightening it would make a
draft unsaveable mid-edit). But the runtime then wrote `state.embedded[""]`:
a nameless variable in the response, the export and every picker.

`embeddedFieldName()` is now the one rule — a field is a variable when its
name has non-whitespace in it, and the name is that text **trimmed**, so `"a "`
and `"a"` are one variable rather than two. `allEmbeddedFields`,
`embeddedCatalog` and `applyEmbeddedField` all use it. A row left unnamed at
release time is a lint **warning**, not an error: mid-edit it is normal, at
release it is a variable somebody meant to capture and did not.

### An expression that cannot be computed is a value, not an end

`applyEmbeddedField`'s expression branch had `flattenVariables(def, state)`
**outside** its try/catch. A survey it could not flatten threw out of
`compileFlow`, out of the Runner's init effect, and into nothing.

---

## 2. Runtime stability (§6 of the brief)

`apps/runtime` had **no error boundary of any kind**, and the Runner's init
effect — state creation, embedded data, on_load scripts, `start()`,
`compileFlow`, resume, language — was entirely unguarded. `stateRef.current` is
assigned part way through it, so any throw left it null and the render
short-circuited to

```tsx
if (booting || !state) return <h2>Loading survey…</h2>   // for ever
```

That is a masked exception dressed as a loading state. Four changes:

- **`RunnerBoundary`** wraps every mode (`/t`, `/preview`, and `RunnerLive`)
  because `Runner` is now a thin wrapper around `RunnerInner`. Render-phase
  throws become a real error card.
- **The init effect catches its own throws** — a React boundary cannot see an
  error inside an effect — and sets the same card.
- **`advance` and `goBack` are guarded.** `moveForward` throws
  "Flow did not terminate (guard exceeded)"; unhandled, that was a Next button
  that silently did nothing.
- **The session-start fetch has a 25-second watchdog.** A request that neither
  resolves nor rejects was the one failure `fetch` never reports.

The card has two audiences. **Test and preview** get the message, the stack and
a Copy button. **Live** gets one neutral sentence and a Reload; the diagnostic
still reaches `console.error`. `apps/runtime/app/error.tsx` catches what is left
— a server component throwing before the Runner mounts.

---

## 3. Others specify

### `{{Q1}}` piped the option label

This is the reported bug. `{{Q1.other}}` was always correct — but `{{Q1}}` is
the token the picker offers first and the one a researcher reaches for, and it
resolved a selected code to its option **label**, which for an other-specify
option is the invitation to type, never the thing typed. A respondent who chose
Other and wrote "Tesla Model Y" was asked about "Other, please specify".

A flagged option now resolves to the respondent's own words when there are any
(`label`, `labels`, `first`, `last`, `rank`). With an empty box it stays the
label — the option *is* selected, and piping nothing would lose that.
**`.code` and `.value` are untouched**: they are the stored code, which is how
a programmer tells the four things an option has apart — id, code, label,
other text — and a piped code that became free text would break every
cross-break.

### The box was missing on twenty-odd variants — a dead-end interview

`other_specify` is a flag on an *option*, so the Studio offers it wherever
there are options. Rendering it was each variant's own business: only
`SingleSelect`, `MultiSelect`, `Dropdown`, `ChoiceButtons` and `ChoiceCards`
ever drew one. `validate.ts` requires text for every selected flagged option on
**every** variant, because emptiness is a property of the answer and not of the
layout.

So on a searchable dropdown, an adaptive question, a carousel or an image grid,
a respondent who selected Other was shown "Please specify", given nowhere to
specify it, and **could not go forward**. `QuestionRenderer` now renders one
centrally for every variant that does not draw its own
(`rendersOwnOtherBox` + `OtherSpecifyFallback`), driven by the engine's own
`selectedOtherCodes` so a scalar, an array and a grid object behave identically.

### The Studio simulator could not demonstrate any of it

The Live View simulator let a programmer choose which option a previous
question selected and nothing else — so `{{Q1.other}}` always rendered as an
unresolved chip. That is almost certainly why the bug was reported. It now
offers the text box, stored under the engine's own per-box key.

### Two reads that were wrong

- `otherTextFor` treated a stored `""` as "no answer" and fell through to the
  legacy `__other` key, **resurrecting text from an older response**. Presence
  decides now: if the key exists, its value is the answer, `""` included.
- It built one exact key while `lookupAnswer` walks outward, so from inside a
  loop the Other text of a question answered outside it was invisible. It now
  uses `answerLookupKeys`.

---

## 4. The value contract (§3)

`undefined`, `null`, `""`, whitespace, `0`, `false` and real text are seven
things. Three conversions were found and removed:

- the legacy-key resurrection above;
- `{{Q.count}}` sat below the null guard and above `codes = [value]`, so it
  was wrong in both directions at once — unanswered piped `""` (not a number),
  and an empty string piped `"1"` (a selection nobody made). It is now
  computed before the guard: nothing is `0`, a scalar is `1`, an array is its
  length;
- **three definitions of "not answered"** (`evaluate`, `countCondition`,
  `validate`) that disagreed on `"   "` and on `{ r1: null }` — both reachable
  inside one AND, so a grid with no cell filled was simultaneously answered and
  not answered. `isEmptyAnswer` in `answers.ts` is now the only one. `0` and
  `false` remain answers.

---

## 5. The AND conditions

The operator is sound. Four things underneath it were not.

**An empty group took its truth value from its operator.** `[].every()` is
true and `[].some()` is false, so:

```
A AND B AND or([])   →  A ∧ B ∧ false  →  always false
A OR  B OR  and([])  →  A ∨ B ∨ true   →  always true
```

One click on "+ Group" in the analytics filter builder, before a rule was
added to it, silently inverted a whole tree — and the printed summary omitted
the empty group, so the screen said the opposite of what ran. An empty group is
now **skipped**, which is the contract an absent condition already had; a group
whose children are all empty is empty in turn, so nesting cannot smuggle it
back (`isVacuousCondition`).

**A count rule read a different answer from an ordinary rule.**
`evaluateCount` used `answerKey` (one exact key) while `evaluate` uses
`lookupAnswer` (walks outward). Inside a loop, an AND containing one of each was
being told two different things about the same question.

**`contains` had two case policies**, chosen by the answer's runtime shape:
array members matched case-sensitively, strings case-insensitively. The same
rule changed meaning when a respondent selected one option instead of two.
Case-insensitive throughout now; *what* is matched still depends on the shape,
because membership and substring are genuinely different questions.

**A known, deliberate divergence, now documented in the code:** inside an
`expr` source an unanswered numeric reads as `0` (a calculation has to total
what is there), while an ordinary rule is fail-closed. Write
`Q5 isNotEmpty AND Q5 < 10` when it matters. Unifying them would move every
live quota built on `toNum`.

---

## 6. One engine, one answer

Everything above is in `@rescript/engine`. Builder, Test, Preview and Live all
evaluate through `evaluateCondition` / `resolvePiping` / `otherTextFor`, and
the analytics filters go through `matchesResponseCondition` → the same
`evaluateCondition`. There are no per-surface copies to keep in step.

| Fact | Its single owner |
|---|---|
| is this embedded field a variable, and what is it called | `embeddedFieldName` / `embeddedCatalog` |
| the value of an embedded field | `applyEmbeddedField` |
| the text in one Other box | `otherKeyFor` / `otherTextFor` |
| which flagged options an answer selects | `selectedOtherCodes` |
| is this answered | `isEmptyAnswer` |
| does this condition hold | `evaluateCondition` |
| what does this token resolve to | `resolvePipeToken` |
| does this group say anything | `isVacuousCondition` |

---

## Tests

- `packages/engine/src/p0RuntimeContract.test.ts` — 22 cases, the brief's
  regression matrix. Every one was checked to **fail against the previous
  code**: `{{Q1}}` gave `"Other, please specify"`, `{{Q1.count}}` gave `""`,
  `A AND B AND or([])` gave `false`, the loop count gave `false`,
  `contains "blue"` on `["Blue"]` gave `false`, the linter reported the
  embedded field as missing, the dictionary had no column for it, and an
  unnamed row produced `embedded: { "": null }`.
- `scripts/p0-runtime-contract-test.mjs` — 8 checks in a real browser: the
  embedded page renders and pipes; a broken expression does not stop the
  interview; five malformed definitions, none stuck on the boot card; a throw
  produces the error card with its diagnostic; the Other box renders on
  `searchable_single`; and `{{Q1}}` pipes the respondent's own words.
- Full workspace: 1554 unit tests green.
