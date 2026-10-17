# Survey Flow — Embedded Data, Insert Piped Text, Add Element (document 15/10/2026)

Engineer: FLOW · 2026-10-17. Each item of the user's document: root cause, what changed, files, how it is verified, and what is not done (with the reason).

## A. Piping in a Fixed value did not resolve

**Root cause.** `applyEmbeddedField` (`packages/engine/src/embedded.ts`) took a `static` value as `raw = field.value` and only coerced it to the declared type. Nothing ever passed it through the piping resolver. So `ZIP_TEST = {{ed.ZIP_CODE}}` stored the literal text `{{ed.ZIP_CODE}}`, which is the screenshot's `stored as string: "{{ed.ZIP_CODE}}"`. Under Integer the same token failed with "is not a number". The release lint (`lintLogic`) reported that as an error, because it reads the value through `coerceEmbedded`.

**Fix.**
- New module `packages/engine/src/embeddedPiping.ts`. `applyEmbeddedFieldInFlow` resolves a Fixed value with the platform's own resolver (`resolvePipingText`, which is `resolvePiping` decoded to plain text, so `Ben & Jerry` is not stored as `Ben &amp; Jerry`). It then hands the resolved text to the unchanged `applyEmbeddedField`, which applies the source → default → declared type rules. No new syntax was added: `{{ed.X}}`, `{{embedded.X}}`, `{{Q1}}`, `{{calc.X}}`, `{{loop.*}}` and `{{expr: …}}` all work.
- `flow.ts` `moveForward` calls it at the point where the element runs. Live, test and the Studio preview all run the same Runner, so they all get it. Fields set earlier, including earlier in the same element, are already in state, so chained values work (`{{ed.FULL_NAME}}` built from `{{ed.FirstName}} {{ed.LastName}}`). The `embedded_data` runtime step now carries its `loop`, so `{{loop.label}}` resolves per iteration. The field's `when` still reads outside the loop, as it did before, so existing behaviour is unchanged.
- **Missing reference at runtime** reuses `calculationSettings.emptyEmbedded` (the setting every calculation already obeys):
  - **zero** (default): the missing part reads as empty text. A value that is a single numeric reference reads as `0`.
  - **error**: the field gets no value, and the reason is recorded in `state.calcErrors[name]`, which the test console shows.
  - **skip**: the field keeps its previous value.

  In all three cases, a value that resolves to nothing uses the field's Default value first. Its label now reads "(when the piped value is empty)".
- **Builder warning.** `lintEmbeddedPiping(def)` reports references to fields that do not exist (`Embedded Data field "FirstName" was not found.`) and references to fields that are only set later in the flow. The warnings appear inline under the field and in the Survey Flow issues box.
- `coerceEmbedded(<explicit type>, "{{…}}")` now returns no value and no error, because a template is not a value yet. As a result the release check no longer blocks `TOTAL_CALORIES = {{ed.LOWCAL_1}}` under Integer.
- Also fixed:
  - `{{ed.RESPONSE_ID}}` / `{{ed.SURVEY_CODE}}`: the redirect picker offered these as "System" values, but nothing ever set them, so links went out with them empty. They now resolve to the session id and the survey code. A field the survey captures under the same name still wins.
  - Quota-check "redirect when full" URLs went out with their tokens unresolved. They are now resolved like every other redirect.

**Files:** `packages/engine/src/{embeddedPiping.ts (new), embedded.ts, piping.ts, flow.ts, index.ts}`.

**Verified:** `flowEmbeddedPiping.test.ts`, A-tests:
- `TOTAL_CALORIES = {{ed.LOWCAL_1}}` stores 10
- `Customer: {{ed.CustomerName}}` stores "Customer: Rahul"
- First + Last combine
- the same, chained across elements
- zero, error and skip, plus the default value
- lint warnings (not found / set later)
- loop iteration
- `&` stays plain text
- RESPONSE_ID
- quota redirect

Browser: `flow-ed-test.mjs` RUNTIME block checks the stored values in the preview (`window.__rescriptState`).

## B. Compact value input

**Root cause.** The Fixed value was a full-width `<input>`, and the "stored as" chip printed the whole value. A ZIP list of hundreds of codes therefore produced a giant bubble.

**Fix.**
- New `CompactValueInput` (`FlowValueInput.tsx`): an auto-sizing textarea.
  - Its width is the longest line plus the caret, with a 14ch minimum. CSS caps it at `max-width: 100%`, and past that it wraps.
  - Its height follows the content up to 180px, then it scrolls. There is no manual width setting.
- New `StoredAsPreview`: shortens the preview to roughly 140 characters, cutting on a whole list item, and adds a "show all (N characters)" toggle. The chip wraps inside the card.
- The existing wording `stored as <type>: …` is kept, so `flow-dnd` and `oct06-review` still match.

**Files:** `apps/studio/components/studio/FlowValueInput.tsx` (new), `FlowNodeEditors.tsx`, `apps/studio/app/globals.css` (`.compact-value`, `.ed-value-row`, `.chip.ed-preview`), `apps/studio/lib/flow/flowEd.ts` (`compactWidthCh`, `previewText`).

**Verified:** `lib/flow/flowEd.test.ts`. Browser B block:
- a short value gets a field under 220px
- the field grows with its text
- the 400-code list stays inside the card, at 50–190px tall
- no horizontal page growth
- the preview is shortened, and "show all" reveals the rest

## C. Insert Piped Text

**Inventory before this change.** The resolver understood question tokens (label/value/count/labels/first/last/rank/other/matrix rows/geo parts), `calc.*`, `ed.*`, `loop.*` plus its aliases, and `expr:`. There were no date, random, device, survey/response metadata or quota sources.

**Added — cheap and safe, all resolvable at runtime.** The new `{{namespace.key}}` tokens are parsed in `pipingTokens.ts` and resolved in `systemPipes.ts`, which registers itself with `piping.ts` (the same pattern the other resolvers use, so no import cycle is created):
- `survey.id|code|name|version`
- `response.id|respondent_id|language|status`
- `date.today|now|time|start_date|start_time|start|day|month|month_name|year|weekday|timezone|unix|iso`, with `|fmt:<pattern>` (`YYYY MM DD dddd HH hh mm ss A [literal]`). In a Fixed value, the formatted text is what is stored.
- `device.type|os|browser|screen|viewport|language|user_agent`. These come from what the respondent's browser reports. The Runner records them in `state.meta` at start through `runtimePipeMeta`. Unknown parts are empty, never guessed.
- `distribution.channel` (live/test/preview) and `distribution.link_type` (the deployment access mode).
- `quota.<id|name>.count|limit|remaining|percent|status|name|id|cell`. These read the `quotaCounts` the runtime already has client-side, which are counts as of session start (0 in preview).
- `random.int(min,max)`, `random.decimal(min,max,places)`, `random.pick(a,b,c)`, `random.id(len)`, `random.bool`, `random.uuid`.
  - `|per:respondent` is the default (seeded by the respondent id if the link carries one, otherwise by the session seed, which a resume or reload keeps). The alternatives are `|per:session`, `|per:loop` and `|per:each`.
  - `|key:NAME` makes two otherwise identical tokens draw independently.
  - Values are derived, not stored, so nothing needs saving.

These names are recognised only as exact keys. A question coded `date` or `device` keeps meaning that question; the runtime and the lint both check for this.

**The menu.** `InsertPipedText.tsx` (new, shared) has exactly the agreed API, plus an optional additive `syntax: "piped" | "calc"`.
- Searchable, with categories → fields → a third level where one is needed (what to read from a question, a date format with a live example, the random settings form). It has a back arrow, arrow-key navigation and Escape.
- Its contents come from `pipeSourceCatalog` (engine, `pipeCatalog.ts`), which offers only sources the resolver supports.
- The type of value each category offers:
  - Survey Question, by question type: single-select text/code, multi-select labels/count/codes/first, numeric value, open end, matrix row answer/code, ranking, date/time.
  - Embedded Data, with its data type; fields set later in the flow are flagged.
  - Calculated Variable.
  - Quota, Survey Metadata, Device and Date/Time, as listed above.
  - Distribution.
  - Geolocation: precise location comes from a geo question.
  - Random.
- `accept: "number"` leaves only numeric sources.

**Shown disabled, with the reason (not done, by design):**
- **Loop & Merge outside a loop**: "Unavailable here — this field is not inside a loop." Inside a loop the category lists index, count, label, code and the loop's reference columns.
- **Distribution contact fields**: there is no contact model. On anonymous links the reason is "no contact record". On invitation links the reason explains that the list's columns arrive as Embedded Data and should be declared as an Embedded Data field.
- **Approximate geolocation (IP)**: the platform does no IP lookup, so there is nothing to pipe.
- **Precise geolocation with no geo question**: it is only collected with permission, by a geo question.
- **Every non-DSL source in calculation syntax**: the Calc DSL cannot read them. The reason given is to store the value in an Embedded Data field first.

**Files:** `packages/engine/src/{pipingTokens.ts, piping.ts, systemPipes.ts (new), pipeCatalog.ts (new)}`, `apps/studio/components/studio/InsertPipedText.tsx` (new), `apps/runtime/components/Runner.tsx` (records `state.meta` before `start`), `scripts/lib/publicDocs.mjs` (adds a "System sources" section to the logic reference).

**Verified:** engine C-tests:
- formats
- random persistence: respondent, session, respondent id, loop, each, key, ranges and shapes
- metadata, device, distribution, quota
- a question coded like a namespace keeps meaning that question
- the token grammar round-trips
- catalog: disabled reasons, numeric filter, calc syntax, search

Browser C block: inserts at the cursor an ED field, a question (mid-text), a date with a format and a random integer; back, search, Escape; Loop is disabled.

## D. Insert Piped Text in other Survey Flow fields

The button was added only where the field is evaluated through the piping resolver:
- **Embedded Data** Fixed value.
- **Embedded Data Calculation**, as "Insert variable": `syntax="calc"`, numeric only, written as `ed.NAME` / a variable name / `loop.index`.
- **Quota check** "redirect when full" URL. This now resolves its tokens; see A.
- **Block title.** The runtime pipes the page heading.
- **Group title.** The runtime pipes the block-name line.
- **End of survey** message and redirect URL.

**Branch conditions:** LOGIC imports `InsertPipedText` into the condition builder's value field. `ConditionBuilder.tsx` was not touched.

**Not given the button, with reasons:**
- **Loop & Merge item / reference values.** These are data the loop reads before any iteration exists, and loop filters, conditions and exports use them verbatim. Piping them would make one value differ between text and logic.
- **Randomizer and Branch names.** Respondents never see them, and nothing resolves them.
- **The Redirect element.** It keeps its existing "+ variable" picker, which existing suites rely on.

## E. Test Value

The **Test value** button opens a panel labelled "sample test data". It explains that the values are test data only: nothing is saved and no respondent data is used.
- It has one input per Embedded Data field, question or calculation the value reads. A field with a plain fixed value is pre-suggested.
- It shows the **Expression**, the **Resolved** text and **Stored as** `<type>: <value>`.
- It warns for invalid references, e.g. `Embedded Data field "FirstName" was not found.`
- System sources (date, random…) are filled in by the platform at test time and listed as such.
- It works for Calculation fields too.
- It runs the real `applyEmbeddedFieldInFlow` on a throwaway state (`testEmbeddedValue`), so the test cannot disagree with the runtime.

**Files:** `embeddedPiping.ts` (`testReferences`, `testEmbeddedValue`), `FlowValueInput.tsx` (`TestValuePanel`).

**Verified:** engine E-test; browser E block.

## F. Add Element grid

`AddElementMenu` (`FlowPanel.tsx`) is now a grid of labelled buttons with icons, built from the same `INSERTABLE` list. All 9 elements are kept: Embedded data, Branch / condition, Randomizer, Loop, Quota check, Redirect, End of survey, Block, Group.
- **Layout:** 3 per row, or 2 under 520px. All buttons are the same size and have a hover state.
- **Tooltips:** the existing one-line descriptions, as `title` and in a live hint line under the grid.
- **Keyboard:** arrows, Home/End and Enter; Escape closes and returns focus.
- **Click:** inserts at that position and closes.
- **Search box removed.** With every element visible there is nothing to search for, and the document asks for direct selection.
- **Icons:** `shuffle`, `repeat`, `redirect` and `flag` were added to `components/ui/Icon.tsx`.
- **Test ids:** `flow-insert`, `flow-insert-menu` and `insert-<type>` are unchanged, so `flow-dnd`, `logic-builder` and `expression-editor` still work.

**Files:** `FlowPanel.tsx`, `Icon.tsx`, `globals.css` (`.add-el-*`), `lib/flow/flowEd.ts` (`gridMove`).

**Verified:** `flowEd.test.ts`; browser F block (3-per-row geometry, same size, icon, label and tooltip, keyboard, each of the 9 types inserted between `ed1` and the block, the grid closes).

## G. Automatic data type

**Root cause.** The only types were explicit ones. The ZIP list under Integer was read with `Number("2000, 2001, …")`, which gives "is not a number".

**Fix.**
- `EmbeddedDataType` gains `"auto"` and `"list"`. This is additive: existing fields keep their stored type, or none, and behave exactly as before.
- **New fields default to Auto**, both from "+ add field" and in a new element (`blockModel.newFlowNode`).
- `coerceEmbedded("auto")` uses `detectValueType`:
  - a plain integer or decimal becomes a number, and `true`/`false` become booleans;
  - a list, a date, a URL and free text stay **exactly** as typed;
  - `02108` stays `"02108"`.
- `"list"` keeps the text.
- An explicit single-value type given a list now says: `"2000, 2001, 2002" is a list of 3 items, not a single number — choose the Auto or List type to keep it`.
- **The type control** reads `Auto (detected: List of 4 items)` (or `Text — leading zero kept`, `Whole number`, …), and every explicit type is still available as an override.
- **Helper for consumers:** `effectiveEmbeddedType(def, name, value?, state?)`:
  - an explicit type is returned as is;
  - Auto returns the type detected from the value (`integer|decimal|boolean|date|datetime|url|list|string`);
  - an untyped field returns `string`.

  `describeDetectedType(raw)` gives the words.
- **Exports:** the variable dictionary keeps Auto and List columns as **text**, deliberately. One column can hold 25 for one respondent and `02108` for the next, and only text keeps both. The dictionary note says so. Other entries are unchanged.
- **Piping:** reads the stored value, so Auto 10 pipes as "10".

**Files:** `packages/schema/src/flow.ts`; `embedded.ts` (`EMBEDDED_TYPES`, `coerceEmbedded`, `effectiveEmbeddedType`, `describeDetectedType`); `variables.ts` (notes); `FlowNodeEditors.tsx`; `blockModel.ts`.

**Verified:** engine G-tests (detection, the list-under-Integer message, unchanged legacy types, `effectiveEmbeddedType`, dictionary, a ZIP list end to end); browser G block.

**Not done:** the AI action vocabulary (`optionActions.ts`, which is not FLOW's) still accepts only the original seven types for AI-created fields. Those fields keep working; they simply cannot request Auto or List yet.

## For LOGIC
- **Conditions:** read Embedded Data with `effectiveEmbeddedType(def, name, value)`, not the raw `dataType`, because `embeddedTypeOf` now returns `"auto"` for new fields. Auto values that are numbers are already stored as JS numbers.
- **Release check:** consider adding `lintEmbeddedPiping(def)` (warnings) to `lintSurveyLogic`. Today it is shown in Survey Flow only.
- **`InsertPipedText`:** import from `apps/studio/components/studio/InsertPipedText.tsx`. Props: `def`, `onInsert`, `accept`, `context`, `label`, `testId`, plus the optional `syntax`. `onInsert` receives a `{{…}}` token. Insert it at your cursor (`insertAt` in `lib/flow/flowEd.ts`).

## Verification run
- `packages/schema` build ✓
- `packages/engine` build ✓; `node --test dist/*.test.js` → 2091/2091 ✓ (including 22 new)
- `packages/renderer` `tsc --noEmit` ✓
- `apps/studio` `tsc --noEmit` ✓; lib tests → 600/600 ✓ (5 new)
- `apps/runtime` `tsc --noEmit` ✓; lib tests → 20/20 ✓
- `gen-public-docs --check` ✓
- `dependency-boundaries` → 0 violations ✓
- Browser (orchestrator to run, needs Studio :3000 and runtime :3001): `node scripts/flow-ed-test.mjs` (new), plus the existing `flow-dnd-test.mjs`, `flow-mode-test.mjs`, `flow-export-test.mjs`, `settings-flow-width-test.mjs`, `calc-embedded-test.mjs`, `oct06-review-test.mjs` (Embedded Data URL type and the preview wording), `logic-builder-test.mjs` and `expression-editor-test.mjs` (both use the Add Element menu). For piping, also run `p0-runtime-contract-test.mjs`, `e2e-smoke.mjs`, `master-demo-test.mjs` and `geo-test.mjs`.
