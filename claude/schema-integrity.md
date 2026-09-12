# One schema, one order, and no references to things that are gone

*On top of `216be91`. Engine 955 tests (+29 new), templates 64, access 77, billing 31, quality 41, designs 43, exporters 58, analytics 53, mail 28; all 76 browser suites green; guard audit 129/129. New `scripts/schema-integrity-test.mjs`.*

Four bugs were reported as four bugs. They are one: **several places each decided, from a different field, what shape a question has and what order the survey asks them in.** A question's type was a label rather than a schema; a question's position existed in two arrays that nothing reconciled; a deleted question left its id behind in every rule that named it; and a logic builder showed the type a rule was written against rather than the type the question has now.

So the fix is not four fixes. It is one declaration of what a question shape owns, one function that moves a question between shapes, one question order, and one walk that finds every reference to a question.

## 1. A type change is a schema change

`packages/engine/src/questionShape.ts` holds **the table**: for each of the sixteen response models, which of `options` / `rows` / `columns` it reads and which settings it reads. Everything else on a question is not that shape's business.

`migrateQuestionType(q, to)` moves a question from one shape to another and returns the new question **plus the complete list of what changed**, in four kinds:

| | |
|---|---|
| preserved | the shape reads it; it stays |
| transformed | it becomes something the new shape *can* read |
| removed | the new shape cannot read it, so it goes |
| reset | it stays as a field, at its default for this type |

Transformation is deliberately small and honest. `options` and `rows` are the same kind of thing — a flat list of codes with labels — so one becomes the other: a single select converted to a text list keeps its five options as its five fields rather than asking a programmer to retype them. `columns` is not on that list, because a column carries its own response type, variable stem, option list and validation, none of which can be guessed from an option. The one exception is the genuine one: a matrix's shared scale **is** a single column, so matrix → composite turns the scale into one column holding the same points (when the matrix has no columns of its own), and a single column carrying a scale turns back into a scale.

Where a field is ambiguous the table **keeps** it. Removal has to be certain: a dropped option list cannot be reconstructed from a survey definition, and a programmer can always delete a setting that survived. That is why `derived` owns options (a hidden variable is the usual target of an auto punch, and a punch needs codes to write) and why the universal settings group is generous.

### The dialog

`switchTo` computes the migration first and shows it — kept, transformed, removed, reset, each item named — and applies it only on confirm. Cancel touches nothing; confirm is one undo step. A conversion that loses nothing (radio → dropdown) reaches no dialog at all, because there is nothing to put to anybody.

The old warning was a browser `confirm` saying "incompatible validation/settings will be reset". True, useless, and — since the rows and the scale and the mask all survived it — not even a description of what happened.

### Both paths, not one

`carousel.tsx` changed a question's type with a bare `patch({ type })`. It goes through the migration too. Its three base types share one response model so nothing is reported to anybody — but that is now the migration's judgement rather than that file's assumption, and a second way for a type to change is how the two drift.

## 2. There is one question order

Dragging a question rewrote `page.questionIds` and left `def.questions` exactly as it was. Both were "the question order". The Questions panel and the flow read the first; every logic picker, the variable dictionary, the JSON and the export read the second. They disagreed the moment anything moved, and nothing ever reconciled them.

The answer is not for each screen to sort for itself — that is the same mistake in more places, and a screen that forgets is a screen that is subtly wrong. **`def.questions` is kept in flow order**: `normaliseQuestionOrder(def)` runs at the single point every Studio edit passes through (`store.update`), on load and import (`store.replace`), and in the version route before the dictionary is built. The array *is* the order, and every consumer is right without asking.

Questions on no page keep existing and come last, in creation order; `placedCount(def)` says where that group begins.

## 3. Deleting a question is a change to the whole survey

`packages/engine/src/references.ts`. One walk of the definition finds every reference to a question — **by the field it sits in, not by a list of the places references are**, so a reference site added to the schema tomorrow is found without editing that file.

`referencesTo` runs the real pruning on a copy and reports; `pruneReferencesTo` runs it for real. They are the same function, because a preview computed by different code from the change it previews is a preview that is eventually wrong.

The rule that matters:

> **A rule that names the question is removed, not repaired.**

"Punch Heavy User when Q5 >= 5" with Q5 gone must not quietly become "punch Heavy User", which is what clearing the condition and keeping the rule would do. So losing a reference invalidates the thing that held it, and the invalidation cascades outward until it reaches something with an independent reason to exist — a question, a flow node, a page, an option, the survey. There the field is **cleared** instead, and the report says what the survey now does: *"Q7 — display logic removed, so it will always be shown"* is the sentence a programmer needs before pressing Delete.

Two judgement calls worth naming:

- **An option survives a rule that mentioned the question.** Its `visibleIf` goes; the option stays. An option carried *from* the deleted question does not — it was never its own option.
- **A flow branch does not survive.** Keeping it and clearing its condition sends every respondent down it, which is worse than removing it and letting them fall through to the path the flow already defines as the default.

The dialog lists everything, confirming prunes it all in **one** undo step, and blocks and flow elements deleted with questions inside them go the same way — listing what referred to them from *outside*, since their own internal wiring is going with them anyway.

## 4. A logic builder shows the current schema

- **The operator list** follows `sourceKindForQuestion`, which now reads `effectiveResponseModel` instead of a hand-written list of base types. The old list called `image_select` multi-valued — true of one of its two variants, false of the other — and had no entry for anything added since, so every newer type fell through to "any" and was offered the union of every operator family: "ranked first" on an upload, "contains" on a location.
- **A saved operator the source can no longer take** stays selectable but is labelled *"not available for this question"*, with one click that repairs it. Dropping it from the list would show the first valid operator while the stored rule still held the invalid one — the same lie the other way round.
- **A comparison against another question** stores that question's **id**, not its code. Renaming Q5 to Q5b used to break every rule comparing against it, silently, because an unresolvable reference is simply false. The evaluator has always accepted an id, a code or a variable name, so existing rules keep working.
- **A multi-select in the visual builder** is a list of positions, so it is cleared exactly when positions move — a structural change to the tree — and left alone when only an operator or a value changes.

## 5. The shape is asked, never counted

Three places decided a question's shape from an array length, so a question carrying a previous type's data was treated as still being that type:

| where | was | is |
|---|---|---|
| `gridAxes` | any question with `rows.length > 0` is a grid | the shape owns rows |
| `PropertiesPanel` | Row/Column masking offered on `rows.length` / `columns.length` | the shape owns that axis |
| `validate.ts` | `required` suppressed when a question "ran out of items" | only lists the shape reads can make it unanswerable — a mandatory open end carrying stale options could be left blank |

## 6. What older surveys are still carrying

Every survey written before this pass carries what its questions had before they were retyped. `staleFields(q)` asks the migration what a question holds that its *current* type cannot read; the logic lint reports each one, and the properties panel shows them with a button that says exactly what it will drop before it drops it.

They are reported rather than removed on sight. Deleting a programmer's list because a lint pass thought it obsolete is exactly the silent behaviour this work is undoing.

## What turning the lint on found

The stale-field lint was pointed at the Master Demo, which is the survey most likely to exercise every corner of the schema. It reported four questions. **Three of them were the table's fault, and fixing them is the point of having built it:**

| | |
|---|---|
| a numeric matrix carrying one column | `gridScaleOptions` genuinely resolves a per-row scale from `columns[0].options` as well as from `q.options`, so `per_row` owns `columns`. A shape must own every spelling the runtime honours, or the migration removes working configuration. (The scale → column transform now fires only when the question has no columns of its own.) |
| a constant-sum grid carrying `sumTarget` | `rowSum` is the switch and `sumTarget` is the total each row is measured against, so `cells` owns the `sum` group |
| a swipe question carrying `swipeDirections` | the swipe variants are `per_row`, and the renderer reads `settings.swipeDirections`, so `per_row` owns `swipe` |

The fourth was real. `SURVEY_STARS` was built as a `single_select` carrying five options, with the `single_select.stars` variant — whose base type is `numeric` and whose renderer draws its stars from `minValue` / `maxValue` and never looks at an option list. The type said the answer is a code, the variant said it is a number, and the five options were configuration nothing read. It is now a `numeric` question with bounds 1–5: the same five stars on screen, one source of truth underneath.

That is the shape of the whole pass in miniature — a disagreement between two fields that nothing rendered, so nobody could see it.

## Tests

| where | what |
|---|---|
| `packages/engine/src/questionShape.test.ts` | the table and the migration field by field: a matrix → open end taking nothing with it and reporting all six losses; options becoming fields with codes intact; a mask following its list; randomization and carry-forward retargeted; a matrix scale becoming one column and back; a variant withholding a capability; a safe change reporting nothing; the input never mutated |
| `packages/engine/src/references.test.ts` | a survey where Q1 is wired into everything, deleted: the preview and the pruning proved identical; a punch *conditioned* on Q1 removed along with one *sourced* from it; a condition keeping the rules that still resolve; an option surviving a rule that named Q1 while a carried option does not; a flow branch going; one quota losing a cell and its neighbour untouched |
| `packages/engine/src/dependenciesCalcPunch.test.ts` | the array put in flow order, the no-op detected, unplaced questions last |
| `packages/engine/src/gridAxes.test.ts` | a question that used to be a matrix is not one because its rows survived; a text list still is, because its shape owns rows |
| `scripts/schema-integrity-test.mjs` | all of it in a browser: the dialog naming every loss, cancel changing nothing, confirm applying exactly what was listed; options becoming fields; the Questions panel and the variable dictionary reading in flow order; a stale operator labelled and repaired; delete listing what it breaks, cancelling, then pruning everything in one undo step with no dead id left in the JSON; leftover configuration reported and cleared; and the runtime agreeing with the schema it was given |
