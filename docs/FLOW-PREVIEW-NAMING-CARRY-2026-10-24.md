# Flow, block preview, variable naming and carry-forward — 2026-10-24 (group 3 / H3)

Client Excel reviews of 19/10 and 23/10/2026: items **A32** (Add Element row), **A44** (block preview isolation + Restart Block), **B20** (variable-name case) and **B47–B55** (carry-forward destinations by question type). No migration, no new dependency, no new environment variable.

## Where to find it

| Feature | Where |
|---|---|
| Add Element row (A32) | Studio → open a survey → **Survey Flow** → any **+ Add element** (between cards, at the end, inside a group / randomizer / loop / branch path) |
| Block preview isolation (A44) | Studio → **Questions** → a block's header → **▶ Preview block** (opens the runtime `/preview` tab, bar says "Preview block · <title>") |
| Restart Block (A44) | the block preview's completion card → **↻ Restart Block** |
| Variable-name case (B20) | Studio → **Questions** → open a question → **Variable name** field (also the Variables tab's rename, which uses the same rename check) |
| Carry-forward destinations (B47–B55) | Studio → select a question → Properties → **Carry-forward (dynamic options)** → "+ carry forward from another question" |

Environment: none beyond the usual `NEXT_PUBLIC_RUNTIME_URL` (the Studio's link to the runtime, default `http://localhost:3001`).

## A32 — Add Element as one long row

The compact 3 × 3 popup (`.add-el-grid`, 15/10) is replaced by a long rectangular container that expands **directly below** the "+ Add element" position, spanning the width of the flow row (or of the container the position is in):

- all nine elements in **one row** — Embedded data, Branch / condition, Randomizer, Loop, Quota check, Redirect, End of survey, Block, Group — icon on top, label below, equal widths (`flex: 1 1 0`) and heights, the existing icons;
- clean panel background, 12 px rounded corners, 1 px border, soft shadow; hover / keyboard focus = light blue background (`--tint`) + blue border (`--accent`);
- a tooltip (`title`) with each element's short description, repeated in the line under the row for the hovered / focused element;
- narrow widths: the row **scrolls horizontally** (buttons keep a 104 px minimum), never wraps or cuts a button off;
- subtle expand / collapse animation (160 / 140 ms; reduced to nothing under `prefers-reduced-motion`);
- choosing an element inserts it at that position and closes the row; the same button reopens it; Escape or a click outside closes; ← → move, Home / End jump, Enter adds.

Every "+ Add element" in Survey Flow is the one `AddElementMenu` component, so the change applies everywhere. Implementation: `apps/studio/components/studio/FlowPanel.tsx` (`AddElementMenu`), CSS `.add-el-anchor / .add-el-panel / .add-el-row / .add-el-btn` in `apps/studio/app/globals.css` (the wrapper is `display: contents`, so the panel is a full-width flex child of `.flow-insert`, which now wraps).

## A44 — "Preview block" shows only that block

**Root cause.** Preview block sent the whole definition plus `startAt`; the engine compiled the WHOLE flow and only moved the entry point, so Next walked into the next block, Back (compiled-order fallback) walked into the previous one, and the completion card was the survey's.

**Fix.** The Runner now runs a definition scoped to the chosen node — engine `scopeDefinitionToNode(def, startAt)` (`packages/engine/src/blockPreview.ts`):

- the flow becomes: the Embedded Data elements on the way to the block (root level and inside enclosing containers, before its position) → the block itself (all its pages, page breaks, display / skip logic, piping, auto-punch, loops inside it) → one `end` (complete);
- an enclosing **loop** is kept, pruned to the path, so a looped block previews per iteration with its loop variables; enclosing branches / randomizers / groups are flattened (the programmer asked to see this block);
- the block's own `visibleIf` is lifted off the copy and evaluated against the test values: when it would hide the block, the block is still shown with a note ("…this block's display logic would hide it in the real survey. It is shown here anyway…"). A survey-level display rule that hides it ends the run with an explicit note instead;
- questions, calculations, quotas, etc. are shared by reference; **the saved definition is never modified**.

Because the scoped flow contains nothing else, Back on the block's first page has nowhere to go: the Back button is now drawn only when a previous page exists (`hasPreviousPage`, engine `flow.ts`). Also fixed on the way: `goBack` with nothing behind it used to jump to step 0, a dead end ("There is no page to show") on any flow that opens with an Embedded Data element; it now stays on the current page.

Completion: a block preview's card reads **"Thank you for completing this block."** with **"↻ Restart Block"** (`data-preview-scope="block"`). Restart Block re-runs the scoped flow — the block from its first question, fresh test answers and auto-punch, a fresh preview position (the preview resume key already includes the block id). The full preview and test sessions keep "Thank you for completing this survey" / "↻ Restart test session" and their behaviour.

Files: `packages/engine/src/blockPreview.ts` (+ test), `packages/engine/src/flow.ts` (`goBack` fallback, `hasPreviousPage`), `apps/runtime/components/Runner.tsx` (scoping, start, note, completion text, Restart Block, Back visibility), `apps/studio/components/studio/PreviewBlock.tsx` (comment only — it already sent `startAt`).

## B20 — the variable name keeps its case

**Decision: allowed (it was not a deliberate constraint).** The upper-casing lived only in the Studio field (`VariableNameInput`: `toUpperCase()` on every keystroke) and in the default for a newly created question (`questionTypes.ts`). Nothing downstream needs upper case:

- **Resolution** — `getQuestionByCodeOrVar`, piping (`{{Q6a}}`), conditions, calculations and the rename rewriter all match the **stored** spelling exactly; embedded fields already resolve case-insensitively.
- **Exports** — CSV / JSON / Excel write the stored name; **Stata** keeps case and de-duplicates case-insensitively; **SPSS** and **SAS** upper-case their own names (`spssName`, `sasName`) and de-duplicate afterwards. So `Q6a` exports as `Q6a` in CSV and `Q6A` in .sav / .xpt — as it would have from SPSS itself.
- **Derived names** (`rowColumn`, option / row / cell suffixes, naming templates) are built from the stored base, so `Q6a_1`, `Q6a_r1` etc.

What changed:

- the field now only replaces characters a name cannot hold (`normalizeVariableNameInput`: anything outside `[A-Za-z0-9_]` → `_`); case is kept; a new question's variable name defaults to its code **as typed**;
- **uniqueness is case-insensitive** (`renameImpact`, `renameQuestionCode`'s ownership map): `Q6A` is refused while `Q6a` exists, as a variable, a code or an embedded field ("…already a variable in this survey (variable names are matched regardless of case)"); a case-only rename of the same variable is allowed. `nextQuestionNaming` was already case-insensitive;
- **Escape now cancels** an edit in the field — previously the blur that Escape triggered committed the typed name (found by the new suite);
- existing surveys are untouched: stored names are never rewritten.

## B47–B55 — carry-forward destinations by question type

`packages/engine/src/carryForwardInto.ts` decides from the target question's **shape** (`shapeOf`, not from how many rows it holds right now):

| Target | Destinations shown | Stored `into` |
|---|---|---|
| single / multi select, dropdown, image select, ranking … | one, shown as a chip (no dropdown): **→ into the answer list (rows)** | `options` |
| per-row grid / matrix (`matrix_*`) | dropdown: **→ into rows**, **→ into columns** | `rows` / `options` |
| column table (composite, custom table) | one chip: **→ into rows** (its columns carry per column) | `rows` |
| list of fields (text list, numeric list) | one chip: **→ into the fields (rows)** | `rows` |
| open end, number, … | "→ nowhere to carry into" (+ a lint warning) | unchanged |

**Why a grid's "columns" stores `options`.** The engine applies a question-level carry-forward to exactly two lists, `options` and `rows` (`carrySourceOptions` / `carrySourceRows`). On a per-row grid the columns the respondent sees *are* the scale, which is the `options` list. That is how the brand-tracker template's "which brands describe each attribute" grid (Q5, `matrix_multi`, `into: "options"`) works, and it is read as "→ into columns", unchanged. A stored question-level `into: "columns"` has never been applied by the engine (column tables carry per column via `columns[].carryForward`), so it is not offered; a survey that saved it gets a warning ("never applied at question level — the carried items currently land nowhere") and a one-click fix.

"Options" is no longer a visible choice anywhere. **Backward compatible:** the data model is still `"options" | "rows" | "columns"`; the engine's resolution is unchanged; a value the type takes is kept as is (every template and existing survey reads exactly as before). `normalizeCarryForwardInto` maps an old or careless value to a valid one: a single-select's `rows` becomes its answer list, a grid's `columns` becomes its column choices, and a table's or fields question's `options` becomes its rows. A saved value the type does not offer is **shown, never silently rewritten**: a warning chip with a one-click **use …** button, and the linter (`lintLogic`, path `carryForward.into`) says the same. New carry-forwards start with the type's first destination (rows on a grid).

All shipped templates (nps_relationship, csat_support, screener_quota, brand_tracker, employee_engagement, master demo) lint with **0** carry-forward issues; templates package tests 110 / 110.

Source side: the source dropdown lists only questions that have something to carry (an option list, rows, or a list built at runtime); the stored source is always listed. The source filter choices were already type-aware (grid source → row choices, choice source → option choices; nested-logic-audit suite).

There is no copilot `set_carry_forward` action today (carry-forward is written through the Properties panel, JSON and imports); anything that writes the old values keeps working through the normaliser. The guide `apps/studio/content/docs/piping-and-lists.md` says how destinations follow the type.

## Tests

Unit (engine, `node --test dist/*.test.js`): **2330 / 2330 pass**; templates package **110 / 110**, including the new
- `blockPreview.test.ts` — scoped flow content, Next/Back never leave the block, page break and display logic inside it, gate lifted and reported, block in a loop, a group, unknown id;
- `variableCase.test.ts` — normaliser keeps case, mixed-case rename + piping + lookup, case-insensitive uniqueness (variable and code), a new question's name = code as typed, flattener column names;
- `carryForwardInto.test.ts` — destinations per type, normalisation of stored values.

Studio lib tests: 838 / 838. Typecheck: runtime and studio clean. Auth-guard audit: 0 problems.

Browser — new `scripts/flow-preview-naming-test.mjs` (10 checks): Add Element row (one row, equal sizes, order, icon above label, spans the row, below the button, border + radius, hover colours, purpose line, insert + close, reopen, keyboard, every insert position incl. empty containers, narrow viewport scrolls with all nine reachable); block preview isolation (3 blocks, preview block two: no block one / three, no Back on its first page, embedded data set, piping, Back within the block, completion text, Restart Block clears and restarts block two; block three alone; full preview unchanged); variable case (Q6a kept, invalid characters replaced, Escape cancels, `q6A` refused, `{{Q6a}}` resolves); carry-forward (choice → fixed answer-list chip stored as `options`, sources with a list only; grid → rows / columns, columns stored as `options`; the inert `columns` on a grid and `rows` on a single-select flagged and fixed in one click).

Existing suites re-run and passing: `flow-ed-test` (updated: the grid expectations became one-row expectations), `flow-dnd-test`, `autopunch-media-test` (updated: a gated block is now shown with a note instead of falling back to page 1 — the A44 rule), `nested-logic-audit-test`, `master-demo-test` (block previews of a loop, conjoint, MaxDiff, calculations sections), `variable-management-test`, `naming-templates-test`, `logic-builder-test`, `blocks-test`.

## Not done / notes

- `codes-sync-test` fails at "the hidden Q6 is never shown" in a FULL preview (no block scoping involved). This comes from the concurrent work on revealing hidden questions in preview / test (H2); it is not caused by these changes.
- The block preview's completion wording is fixed English (it is a programmer-facing test screen, like "Restart test session"); the survey's own translated thank-you is still used for full runs.
