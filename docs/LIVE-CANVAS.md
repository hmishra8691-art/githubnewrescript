# The Live Question Canvas

A visual programming surface for one question: the question rendered exactly as
a respondent will see it, with every element clickable, and the configuration
for whatever is selected beside it.

It is a new tab — **Live Canvas**, next to Questions. Nothing was taken away to
make room for it. The Questions tab, its inline editor, its Properties panel
and every `data-testid` the test corpus drives are unchanged, and so is the
survey engine: this feature adds a way in, not a second model.

---

## 1. One renderer, two surfaces

The single most important thing about the canvas is what draws it.

```
                    Question definition
                            │
                   @rescript/renderer
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     Respondent runtime          Live Question Canvas
```

Before this change the renderer lived inside `apps/runtime` and the Studio had
no question rendering at all — previewing meant opening the runtime in another
tab. The renderer is now a workspace package, **`@rescript/renderer`**, that
both apps import:

| | |
|---|---|
| `packages/renderer/src/QuestionRenderer.tsx` | the base renderers (1 800 lines) |
| `packages/renderer/src/variants/*.tsx` | 23 variant families, 55 registered renderers |
| `packages/renderer/src/Media.tsx` | media embeds and safe images |
| `packages/renderer/src/authoring.ts` | the authoring anchors (below) |
| `packages/renderer/styles/questions.css` | rendered-question CSS, 405 lines + 23 variant sheets |

Both `apps/runtime/app/layout.tsx` and `apps/studio/app/layout.tsx` import
`@rescript/renderer/questions.css`, and both `next.config.mjs` files list the
package in `transpilePackages`.

The package has no dependency on either app. What was left behind in
`apps/runtime/app/globals.css` is exactly the app's own chrome: the page reset,
the preview banner, the testing toolbar, the inspector and the framed device
previews. `questions.css` declares only `:root` custom properties and
`box-sizing`, so importing it into the Studio changes nothing about the Studio.

There is deliberately **no editor renderer**. A discrepancy between what the
programmer builds against and what the respondent answers is not something that
can quietly appear, because there is only one implementation to drift from.

## 2. Authoring anchors

The canvas has to answer one question about any node under the cursor: which
piece of the definition drew this? The renderers answer it themselves, with two
inert data attributes (`packages/renderer/src/authoring.ts`):

```html
data-rs-el="question"  data-rs-id="q_devices"
data-rs-el="text"
data-rs-el="instruction"
data-rs-el="media"
data-rs-el="option"    data-rs-id="3"
data-rs-el="row"       data-rs-id="prod_a"
data-rs-el="column"    data-rs-id="col_2"
data-rs-el="cell"      data-rs-id="prod_a::col_2"
data-rs-el="scalepoint" data-rs-id="7"
```

They carry no behaviour, no styling and no bearing on the response model, and
the respondent runtime carries them too — which is the point: the markup is
identical in both surfaces, so the anchors are exercised by the whole runtime
test corpus rather than only by the editor.

The renderers that predate this convention already spoke local dialects
(`data-code`, `data-row`, `data-col`, `data-rowfor`…). Those are untouched —
tests and drag handlers read them — and the anchors sit alongside. A node
carrying both a row and a column coordinate is anchored as a **cell**.

## 3. Selection

`apps/studio/components/canvas/selection.ts` holds the model. One value says
what is being programmed:

```ts
{ type: "option", questionId: "q_devices", optionCode: "3" }
{ type: "row",    questionId: "q_freq",    rowCode: "prod_a" }
{ type: "column", questionId: "q_freq",    columnId: "col_2" }
{ type: "cell",   questionId: "q_freq",    rowCode: "prod_a", columnId: "col_2" }
```

Everything is addressed by identifiers the schema already uses, so a selection
survives a re-render, a device switch and a change of question type.

`resolveFromDom` walks **up** from the click target to the nearest anchored
ancestor, so the most specific thing under the cursor wins: clicking an
option's label selects the option, not the question; clicking a row label
selects the row; clicking a cell inside that same row selects the cell.
`selectionExists` drops a selection whose object has been deleted, so the panel
never edits nothing.

## 4. Authoring view vs respondent simulation

`apps/studio/components/canvas/authoringView.ts` is the difference between the
two modes.

**Authoring** hands the renderer a neutralised copy: `visibleIf`, option/row
logic, masking, list logic, list operations, punches and randomization all
switched off, so the whole structure reaches the DOM and every part of it is
clickable. The real pipeline is then run separately (`annotate`) and reported as
annotations — which is how an option can be visible to the programmer *and*
marked "Hidden by logic".

Two things are deliberately **not** neutralised:

* **Carry-forward.** It is not a way of hiding things, it is where the
  question's items come from. A carry-forward matrix has no rows of its own, so
  switching it off would empty the canvas of the very structure the programmer
  came to program. And when carry-forward legitimately produces nothing —
  normal while programming, because nothing upstream has been answered —
  `withCarriedFallback` stands in the source question's own items, which carry
  the same codes and will be the ones that arrive.
* **Piping.** A token with a sample answer behind it is piped for real. A token
  with nothing behind it would resolve to empty and silently lose a word, so
  `markPiping` replaces it with a `.lc-pipe` chip carrying the token's name —
  visible, obviously a placeholder, impossible to mistake for respondent data.
  Content blocks pipe through `customHtml`, which is marked too.

**Simulation** hands the renderer the real question, the real `ResponseState`
built from the sample answers, and the real `validatePage` output. Nothing about
it is preview-only: the display logic, option filtering, masking, carry-forward,
piping, calculations, randomization seed and validation are the engine's, so an
answer typed here does to the question exactly what it would do in a live
interview.

In authoring mode the rendered controls are programming targets rather than
inputs. Interaction is suppressed at the capture phase with `preventDefault`
alone — never `stopPropagation`, which would cancel the selection too, since
capture runs before the target handler — and CSS gives the inputs
`pointer-events: none`. Switching to Simulate hands every control straight back.

## 5. The contextual panel

`ElementPanel.tsx` shows the configuration for the selected element and only
that. The editors are the ones the Studio already had — `OptionLogicEditor` for
option and row logic, `OptionalCondition` for conditions — writing to the same
fields, through the same store, saved by the same autosave.

| Selected | Offered |
|---|---|
| Question | code, variable, text, required, display logic, randomization, and a link to the full Properties panel on the Questions tab |
| Question text / instruction | the text itself, with a note about HTML and piping |
| Media | the media URL |
| Option | label, code, image, the seven behaviour flags, full option logic |
| Row | label, code, required, row logic, row validation rules |
| Column | label, variable stem, data type, min/max, read-only, display condition |
| Cell | a cross-reference — the engine programs the row and the column, not the intersection, so a cell reports its variable and hands off to whichever side the programmer meant |
| Scale point | the value and the bounds that generate it |

A matrix's columns *are* its answer scale on `matrix_single`/`matrix_multi`, so
selecting such a header edits that option and the panel says so, rather than
pretending a column object exists.

## 6. Structure, indicators, simulation

Below the render, in programmed order: the options and rows with drag handles,
inline label editing, duplicate, delete, and Add. Every one is an ordinary store
mutation, so undo (⌘Z) and autosave behave as they do everywhere else.

`⚙` marks elements carrying programming; a hatched veil and a "Hidden by logic"
tag mark elements today's logic would hide. Both are overlays measured from the
DOM, never injected into the rendered markup, and both can be switched off.

The **Sample answers** panel appears when the question depends on other
questions or sits inside a loop. It offers the questions this one actually reads
(derived by scanning display logic, option and row logic, carry-forward, mask,
list logic, punches, pipeline, validation and piping tokens) and, for a looped
question, the iteration to preview. Sample values never reach a respondent or
the data; they only build the `ResponseState` the preview evaluates against.

Desktop / tablet / mobile change the frame width and stay fully programmable.
The existing testing toolbar in the runtime — Desktop / Tablet / Mobile /
Debug, with its sticky behaviour — is untouched and still the place to run a
whole survey.

## 7. One definition

```
                Question definition (the survey JSON)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     Contextual panel              Live Canvas
              └─────────────┬─────────────┘
                            ▼
                    store.update(fn)
                            │
                  undo · autosave · draft
                            │
                      versioning
```

Every canvas edit is a `store.update()` mutation of the one
`SurveyDefinition`, so it appears in the JSON tab, in the Excel exports, in the
version snapshots and in the draft autosave, with no new persistence path and
no separate versioning. The canvas test asserts this directly: it renames an
option on the canvas, then reads the JSON tab and finds the new label there.

## 8. Verification

`node scripts/canvas-test.mjs` — 36 checks against the sandbox Studio with the
Master Demo loaded (160 questions, **35 question types**, every matrix family,
ranking, allocation, hotspot, upload, annotation, conjoint and MaxDiff):

* every one of the 35 types renders and exposes its question anchor
* clicking text / option / row label / column header / cell selects the right
  thing and switches the panel
* editing a label in the panel redraws the canvas immediately, and the edit is
  in the survey JSON
* a matrix exposes its rows, columns and all 48 intersections
* carry-forward rows appear and are selectable while authoring
* Add option puts a real option into the render; drag reorders definition and
  render together; delete removes the right one
* applying "always hide" marks the element and keeps it inspectable, and
  Simulation removes it
* programming indicators appear and can be turned off
* piping is chipped while authoring, in question text and in content blocks
* simulation runs the real validator
* all three widths render and stay selectable
* undo reverts a canvas edit, and the save state is reported
* the Questions tab and its Properties panel are unchanged

The whole existing corpus passes unchanged: studio, blocks, flow-dnd,
flow-export, logic-builder, expression-editor, masking, option-logic, pagebreak,
listfill, loop, quality, autopunch-media, variants g1–g6 and choice,
persistence, save-integrity, tester-fixes, qa-fixes, response-data,
test-survey-sync, p0-session (41), collaboration (57), dashboard,
quota-dashboard, master-demo, analytics (38), browser-test — plus the engine
(451), analytics (35) and quality (36) unit tests, and clean `tsc` and
`next build` for both apps and the package.

`scripts/analytics-test.mjs` §10 was updated: it asserts the 17 original tabs
are unchanged in order, that Data Analytics follows Data, and that Live Canvas
follows Questions — both additions, neither displacing anything.

## 9. Notes for whoever extends this

* **New renderers should stamp anchors.** `anchor("option", o.code)` on the
  element that draws an option, `anchor("row", …)`, `anchor("column", …)`,
  `cellAnchor(row, col)`. Without them an element is not selectable; with them
  it needs no canvas-side code at all.
* **The canvas never mutates the definition to render it.** `neutralised`,
  `withCarriedFallback` and `withMarkedPiping` all return copies that live for
  one render. What is saved is always what was programmed.
* **The overlays live inside the scrolling stage** and add back `scrollLeft` /
  `scrollTop`, so a wide matrix scrolls sideways with its outlines attached.
* **The measurement effect has no dependency list on purpose** — no dependency
  can express "the DOM moved" — so it writes state only when a box actually
  changed. Without that guard each measurement schedules the next one, which is
  a render loop; it happened once during development.
