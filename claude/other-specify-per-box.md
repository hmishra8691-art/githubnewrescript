# "Other, specify": one identity per box

## The bug

A multi-select with three "Other, specify" options showed three boxes and
stored **one** string. Typing `Apple` into the first put `Apple` into the
other two — on screen, as the respondent typed, and in the data.

It was not a rendering bug. Every layer assumed a question could have only one
Other box:

| Layer | The assumption |
|---|---|
| `otherSpecify.ts` | `otherKey(questionId, loop)` → `q1__other`. No option dimension. The file said so on purpose. |
| `QuestionRenderer` | `otherValue?: string`, `onOtherChange(text)`. No signature could say *which* box. |
| `OtherSpecifyBox` | `.find(...)` — the button/card/tile layouts rendered a box for the **first** selected flagged option only. |
| `validate.ts` | `chosen.some(...)` — one filled box satisfied the requirement for all three. |
| `flatten.ts` / `variables.ts` | `.some(...)` → one `VAR_other` column however many boxes. |
| piping | no token at all; the accidental `{{VAR_other}}` flat-map fallback reached the one shared column. |

And the test suite could not have caught it: **every fixture had exactly one
flagged option per question** — the one shape where a shared key and a correct
one are indistinguishable.

## The fix

The key grew the dimension it was missing:

```
q1__other__97   q1@apple__other__99
```

The code, not the position — reordering options in the Studio must not move a
respondent's text from one box to another, and a code is the one thing about
an option that is promised to be stable.

Everything above it now carries the code: `otherValues: Record<code, string>`
and `onOtherChange(text, code)` in the renderer, `setOtherTextFor` /
`otherTextFor` / `otherTextsOf` in the engine, one input element per flagged
option with its own `id`, `name` and `data-other-code`.

## Old responses still read

A response collected before this has `q1__other` and no per-option key.
`otherTextFor` falls back to it **for the first flagged option only** — the
only box it could have belonged to. Nothing rewrites stored data; the fallback
is read-only and permanent.

`VAR_other` also stays the column name of that first option, so an export
opened next to last month's still lines up. Additional boxes are new, so they
get new names: `VAR_other_98`, `VAR_other_99`.

Clearing a box also drops the legacy key, or the fallback would put the old
text straight back the moment the respondent emptied it.

## Piping

```
{{Q1.other}}        the first "Other" box
{{Q1[98].other}}    option 98's box, specifically
```

The option code goes in the `[...]` slot the grammar already had for a matrix
row — the same idea ("which part of this answer"), so the parser needed no new
syntax. Offered in the Studio's piping picker, with a "Which Other box"
selector when a question has more than one; and both linters know it, so
`{{Q1[55].other}}` is reported with the codes that do exist.

Plain open ends already piped correctly (`{{Q5}}` on an open text, long text,
numeric, or `{{Q5[r1]}}` on a grid cell); that is now pinned by tests rather
than assumed.

## Logic

Each box is its own flat variable, so a condition can name exactly one:

```
BRAND_other      == "Apple"
BRAND_other_98   == "Samsung"
```

via an expression source. Tested, including that `BRAND_other_98 == "Apple"`
is **false** — the property the bug destroyed.

## Verified

- `packages/engine/otherSpecify.test.ts` — 31 tests, fixture is one question
  with **three** boxes: independence, editing, clearing, unticking one,
  loops, legacy read-back, export columns, the dictionary, piping each box,
  escaping, per-box validation, conditions
- `packages/engine/pipingLint.test.ts` — 9, including the new token
- `scripts/other-specify-test.mjs` — 18 checks in a real browser: three inputs
  with three ids, typing in one leaving the others, editing, clearing,
  piping all three into one sentence, Next/Back, unticking one
- 1,495 package tests; both apps typecheck; the logic, masking, loop, list
  fill, master demo, QA and tester browser suites pass

## Still true, and worth knowing

- **Matrix rows and columns cannot carry an Other box.** The schema allows the
  flag there; no renderer reads it. Unchanged by this work.
- **Quality's open-end checks do not read Other text** (`rules/openEnd.ts`
  looks only at the answer and probes). Gibberish and duplicate detection
  therefore ignore it. Unchanged, and a reasonable next step.
- **`/api/session/save` does not validate answer keys.** A crafted POST can
  write any key, including any `__other__*`. Pre-existing, noted in the media
  audit too.
