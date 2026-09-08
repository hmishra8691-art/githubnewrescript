# The Live View

A second view of the question the programmer already has open: the question
drawn exactly as a respondent will see it, with every element clickable, and
the configuration for whatever is selected in the property panel that was
already there.

It is **not a tab, a page or a workspace**. There is no "Live Canvas" item in
the left navigation. The Studio still has its 17 tabs in their original order,
and the Live View lives inside the Questions screen, in the editor of the
question that is open:

```
Questions  ▸  Q11  ▸  ( Standard | Live View )      ✓ saved
```

Nothing was taken away to make room for it. The Questions tab, its inline
editor, its Properties panel and every `data-testid` the corpus drives are
unchanged, and so is the survey engine: this adds a way in, not a second model.

---

## 1. Where it sits

The switch belongs to the question editor, not the application.

```
┌ Studio ────────────────────────────────────────────────────────────┐
│ left nav │ Questions                              │ property panel │
│ (17 tabs)│  ┌ Q11 ────────────────────────────┐   │                │
│          │  │ ( Standard | Live View )  ✓saved│   │  the question   │
│          │  │                                 │   │  — or, in Live  │
│          │  │  Standard: the existing editor  │   │  View, the      │
│          │  │  Live:     the rendered question│   │  selected       │
│          │  └─────────────────────────────────┘   │  element        │
└────────────────────────────────────────────────────────────────────┘
```

* Creating or selecting a question opens it in the Questions workspace, as
  before. Everything else on that screen — blocks, pages, the question list,
  add/duplicate/delete — is untouched.
* The mode is **per question**. Opening another question starts in Standard,
  which is where a programmer expects to land, and no one is ever forced into
  Live View.
* `QuestionsPanel.tsx` renders `<QuestionViewSwitch>` above the editor and then
  either the existing editor or `<LiveView>`. The existing editor is not
  wrapped, moved or rewritten — the Live View is an alternative branch beside
  it.

`apps/studio/components/canvas/CanvasContext.tsx` holds the mode, the selected
element and the pipeline annotations. It sits above `.ide-body` because the
centre column (the editor) and the right column (the property panel) are
siblings, so neither can own state the other needs. It holds no question data:
the question is the store's, and there is exactly one of it.

## 2. One renderer, two surfaces

The single most important thing about the Live View is what draws it.

```
                    Question definition
                            │
                   @rescript/renderer
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     Respondent runtime            Live View
```

The renderer is a workspace package, **`@rescript/renderer`**, that both apps
import:

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
programmer builds against and what the respondent answers cannot quietly
appear, because there is only one implementation to drift from.

## 3. Authoring anchors

The Live View has to answer one question about any node under the cursor: which
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

## 4. Selection

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

## 5. Authoring view vs respondent simulation

`apps/studio/components/canvas/authoringView.ts` is the difference between the
Live View's two toolbar modes.

**Author** hands the renderer a neutralised copy: `visibleIf`, option/row
logic, masking, list logic, list operations, punches and randomization all
switched off, so the whole structure reaches the DOM and every part of it is
clickable. The real pipeline is then run separately (`annotate`) and reported
as annotations — which is how an option can be visible to the programmer *and*
marked "Hidden by logic".

Two things are deliberately **not** neutralised:

* **Carry-forward.** It is not a way of hiding things, it is where the
  question's items come from. A carry-forward matrix has no rows of its own, so
  switching it off would empty the view of the very structure the programmer
  came to program. And when carry-forward legitimately produces nothing —
  normal while programming, because nothing upstream has been answered —
  `authoringQuestionView` (`@rescript/engine`) stands in the source
  question's resolved items, which carry the same codes, the same stable
  source identity, and will be the ones that arrive. It resolves the
  source's own carry-forward chain recursively, so a multi-hop chain
  (Q1 -> Q2 -> Q3) shows real items at every hop, not just the first.
* **Piping.** A token with a sample answer behind it is piped for real. A token
  with nothing behind it would resolve to empty and silently lose a word, so
  `markPiping` replaces it with a `.lc-pipe` chip carrying the token's name —
  visible, obviously a placeholder, impossible to mistake for respondent data.
  Content blocks pipe through `customHtml`, which is marked too.

**Simulate** hands the renderer the real question, the real `ResponseState`
built from the sample answers, and the real `validatePage` output. Nothing about
it is preview-only: the display logic, option filtering, masking, carry-forward,
piping, calculations, randomization seed and validation are the engine's, so an
answer given here does to the question exactly what it would do in a live
interview.

In Author the rendered controls are programming targets rather than inputs.
Interaction is suppressed at the capture phase with `preventDefault` alone —
never `stopPropagation`, which would cancel the selection too, since capture
runs before the target handler — and CSS gives the inputs `pointer-events:
none`. Switching to Simulate hands every control straight back.

## 6. The property panel — the existing one

The right-hand Properties panel is retained, not replaced. `PropertiesPanel.tsx`
asks the canvas context one question before it renders: is this question in
Live View with an element (not the question itself) selected? If so it renders
`ElementPanel` for that element; otherwise it renders exactly what it always
rendered.

The editors inside it are the ones the Studio already had —
`OptionLogicEditor` for option and row logic, `OptionalCondition` for
conditions — writing to the same fields, through the same store, saved by the
same autosave.

| Selected | Offered |
|---|---|
| Question | code, variable, text, required, display logic, randomization, and a way back to the full question properties |
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

Nothing is invented for a question type that does not support it: the panel
offers what that type's schema actually has.

## 7. Structure, indicators, simulation

Below the render, in programmed order: the options and rows with drag handles,
inline label editing, duplicate, delete, and Add. Every one is an ordinary
store mutation, so undo (⌘Z) and autosave behave as they do everywhere else,
and the render redraws from the same definition immediately.

The reorder drag carries its origin in `dataTransfer`
(`application/x-rescript-struct`, `"<kind>:<index>"`) as well as in component
state, so a re-render between grab and drop cannot lose it.

`⚙` marks elements carrying programming; a hatched veil and a "Hidden by logic"
tag mark elements today's logic would hide. Both are overlays measured from the
DOM, never injected into the rendered markup, and both can be switched off.

The **Sample answers** panel appears when the question depends on other
questions or sits inside a loop. It offers the questions this one actually
reads (derived by scanning display logic, option and row logic, carry-forward,
mask, list logic, punches, pipeline, validation and piping tokens) and, for a
looped question, the iteration to preview and its reference columns
(`components/canvas/loopPreview.ts` walks the flow tree for the loops that
contain the question, whether their source is a static list, a question, a
List Fill or a count). Sample values never reach a respondent or the data; they
only build the `ResponseState` the preview evaluates against.

Desktop / tablet / mobile change the frame width and stay fully programmable.
Debug shows the option pipeline stage by stage — the existing `OptionPreview`
debugger, not a second one. The runtime's own testing toolbar is untouched and
still the place to run a whole survey.

## 8. One definition

```
                Question definition (the survey JSON)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      Standard editor              Live View
              └─────────────┬─────────────┘
                            ▼
                    store.update(fn)
                            │
                  undo · autosave · draft
                            │
                      versioning
```

There is one canonical question definition and no second state model. Every
Live View edit is a `store.update()` mutation of the one `SurveyDefinition`, so
it appears in the Standard editor, in the JSON tab, in the Excel exports, in the
version snapshots and in the draft autosave, with no new persistence path and
no separate versioning. Switching modes is a view change, never a conversion.
The save state is reported next to the switch, from the existing `saveState` —
not a save button of its own.

## 9. Verification

`node scripts/canvas-test.mjs` — 38 checks against the sandbox Studio with the
Master Demo loaded (160 questions, **35 question types**, every matrix family,
ranking, allocation, hotspot, upload, annotation, conjoint and MaxDiff):

* there is no Live Canvas tab, page or navigation item, and the 17 tabs are
  unchanged in their original order
* opening a question offers Standard / Live View inside its own editor
* the existing right-hand property panel is retained, not replaced
* every one of the 35 types renders and exposes its question anchor
* an edit made in one mode is present in the other, and in the survey JSON
* clicking text / option / row label / column header / cell selects the right
  thing and switches the panel
* a matrix exposes its rows, columns and all 48 intersections
* carry-forward rows appear and are selectable while authoring
* Add option puts a real option into the render; drag reorders definition and
  render together; delete removes the right one
* applying "always hide" marks the element and keeps it inspectable, and
  Simulate removes it
* piping is chipped while authoring, in question text and in content blocks
* a looped question previews per iteration and its reference columns simulate
* Simulate runs the real validator
* all three widths render and stay programmable; Debug still explains the list
* undo reverts a Live View edit through the existing history, and the save
  state is reported where the editing happens
* the mode belongs to the question — each question opens in Standard
* switching back restores the Standard editor exactly as it was, and blocks,
  pages and question creation are unchanged

The whole existing corpus passes unchanged: studio, blocks, flow-dnd,
flow-export, logic-builder, expression-editor, masking, option-logic, pagebreak,
listfill, loop, quality, autopunch-media, variants g1–g6 and choice,
persistence, save-integrity, tester-fixes, qa-fixes, response-data,
test-survey-sync, p0-session, collaboration, dashboard, quota-dashboard,
master-demo, analytics, browser-test and e2e-smoke — plus clean `tsc` for all
11 workspace projects and clean `next build` for both apps.

`scripts/analytics-test.mjs` §10 is back to its original assertion: the 17 tabs
unchanged in order, with Data Analytics the only addition, following Data.

## 10. Notes for whoever extends this

* **New renderers should stamp anchors.** `anchor("option", o.code)` on the
  element that draws an option, `anchor("row", …)`, `anchor("column", …)`,
  `cellAnchor(row, col)`. Without them an element is not selectable; with them
  it needs no editor-side code at all. A renderer that returns early (the `html`
  type does) still needs its own question anchor.
* **The Live View never mutates the definition to render it.** `neutralised`,
  `authoringQuestionView` and `withMarkedPiping` all return copies that live
  for one render. What is saved is always what was programmed.
* **The overlays live inside the scrolling stage** and add back `scrollLeft` /
  `scrollTop`, so a wide matrix scrolls sideways with its outlines attached.
* **The measurement effect has no dependency list on purpose** — no dependency
  can express "the DOM moved" — so it writes state only when a box actually
  changed. Without that guard each measurement schedules the next one, which is
  a render loop; it happened once during development.
* **Test ids in the Live View are prefixed `live-`.** The Standard editor
  already owns `add-option` and `del-option`; the two must not collide.
