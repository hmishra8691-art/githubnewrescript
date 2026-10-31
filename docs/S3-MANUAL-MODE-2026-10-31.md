# S3a — Manual Mode, part A: a real code editor (2026-10-31)

Branch `feat/persistent-execution-engine`, from `443831a`. Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` §7, rows MM-01 (code editor, Critical), MM-02, MM-10, MM-14; auditor notes S3 §3. S3b (enable/disable for behaviour scripts, duplicate, an all-scripts list, import/export, per-script history and diff, in-editor test run, snippets) is **not** started.

## Owner decision

New dependency approved for this step only: **CodeMirror 6**, in `apps/studio` only, exact versions pinned, lockfile updated with `pnpm install`. No Prettier, no Monaco, nothing else.

| package | version | why |
|---|---|---|
| `@codemirror/state` | 6.7.5 | editor state, compartments |
| `@codemirror/view` | 6.43.12 | the view, line numbers, keymaps, placeholder |
| `@codemirror/language` | 6.12.4 | `indentRange` (Format), bracket matching, folding, highlighting |
| `@codemirror/commands` | 6.11.1 | default keymap, history (the editor's own undo) |
| `@codemirror/search` | 6.7.2 | search & replace panel |
| `@codemirror/autocomplete` | 6.20.3 | completion UI, bracket closing |
| `@codemirror/lint` | 6.9.7 | diagnostics + gutter |
| `@codemirror/lang-javascript` | 6.2.5 | JS highlighting, `localCompletionSource` |
| `@codemirror/lang-css` | 6.3.1 | CSS |
| `@codemirror/lang-html` | 6.4.12 | HTML |

- The versions are the ones the lockfile already resolved for `apps/interviews`. So pnpm added only 4 new packages (`lang-css`, `lang-html`, `@lezer/css`, `@lezer/html`). Every version is more than two weeks old.
- `@codemirror/language` is not on the task's list. It is needed for `indentRange`, which the task names. It is already a dependency of every `lang-*` package.
- The `codemirror` meta-package is not used. The setup is assembled from the packages above.

## What changed

### 1. `CodeEditor` (`apps/studio/components/studio/code/CodeEditor.tsx` + `codeEditorSetup.ts`)

**A controlled field, like the textarea it replaces.**
- `value` comes in and `onChange` fires on every keystroke.
- `onCommit` fires when focus leaves the whole editor (toolbar included), or on **Ctrl/Cmd‑S**.
- The caller saves in `onCommit` through its own gate, exactly as before. Save semantics did not change anywhere.

**Editor features:**
- line numbers and active line
- bracket matching and auto-closing
- indentation on Enter and on typing a closing bracket
- code folding
- highlighting for JavaScript, CSS and HTML
- search & replace panel: Ctrl/Cmd‑F, Ctrl/Cmd‑H, F3 / Enter for the next match, replace and replace-all
- multi-cursor (CodeMirror default)
- read-only mode (still selectable, searchable and copyable)
- full-screen toggle, which acts as a dialog

**Undo.**
- Ctrl/Cmd‑Z, Ctrl/Cmd‑Shift‑Z and Ctrl/Cmd‑Y use the editor's own history.
- The Studio's ⌘Z handler (`store.tsx`) already ignores a focused `contentEditable`, so the two never fight.
- A commit is one ordinary, labelled Studio edit. The Studio's undo outside the editor undoes it. This is verified in the browser suite.

**Format (re-indent).**
- The button is labelled "Format (re-indent)". It uses `lib/code/format.ts`: `indentRange` from the syntax tree (Enter's own rule), then trims trailing spaces.
- **It is re-indentation, not a formatter.** It never moves code between lines, never adds or removes semicolons, quotes or braces, and never changes a string. A unit test checks that the non-space characters are identical.

**Accessibility.**
- The editable element is focusable and labelled (`aria-label` is the field's name).
- **Tab is not captured.** It moves focus, as it did for the textarea, so the editor is never a tab trap. This follows CodeMirror's tab-trap note.
- Indent with Ctrl/Cmd‑] and Ctrl/Cmd‑[, or let Enter do it.
- **Esc** works in this order:
  1. It closes the completion list or the search panel if one is open.
  2. In full screen, it leaves full screen. This also works from the toolbar.
  3. Otherwise it leaves the editor: focus moves to its "Full screen" button, and the next Tab moves on.

**Theme.**
- Colours come from the Studio's CSS tokens (`--panel`, `--text`, `--border`, `--accent`, `--mono`).
- If the Studio's background is dark, a dark syntax palette is used. It is derived from CodeMirror's default highlight style, with no theme package.
- The Studio has one (light) theme today, so the dark path is future-proofing. It is read once, when the editor mounts.

**Lazy loading.**
- `codeEditorSetup.ts` is loaded only through `import("./codeEditorSetup")`, so CodeMirror is its own chunk.
- Until it arrives, the field is a plain `<textarea>` with the same test id, value and save behaviour.
- If it never arrives (offline, a blocked chunk, `window.__rsBlockCodeEditor = true`), the textarea stays and says so (`code-editor-fallback`). The wrapper's `data-editor="loading|ready|fallback"` says which state it is in.

**Test compatibility.**
- The test id sits on the editable element.
- That element has a read-only `value` getter returning the document. Existing `$eval(e => e.value)` assertions keep working.
- Playwright's `fill` works on it, newlines included.

### 2. Completion from the platform (`apps/studio/lib/code/completions.ts`, pure)

**Where the names come from:**
- **`rs.*`:** every method in the capability registry's `SANDBOX_API`, with its signature and effect.
  - New: a `sig` per method in `packages/engine/src/capabilityRegistry.ts`. It is type-checked against `UX_SCRIPT_API`, and the test checks that it starts with `rs.<name>`.
  - Write methods say "(a write request)".
- **`rs.listen("…")`:** `SANDBOX_EVENTS`. The second argument offers `"self"` or a question code.
- **`rs.animate(t, "…")`:** `UX_PRESETS`.
- **Target-first methods** (`addClass`, `show`, `scrollTo` …): `"self"` or a question code.
- **Logic scripts:** the ctx helpers, from the new `LOGIC_HELPER_DOCS` in the registry. It is keyed by the code gate's `LOGIC_HELPERS`, so a helper added there and not documented is a type error.
  - `get("…")` offers question codes and calculations.
  - `getCalc` / `setCalc` offer calculations.
  - `getEmbedded` / `setEmbedded` offer embedded fields.
  - `map.get("…")` (a method of something else) offers nothing.
- **Components:** `el` and `api`, then `api.getValue / setValue / onChange / question`, from the new `COMPONENT_API`. It mirrors `legacyScripts.ts` `wrapComponentScript`.

**Page hooks in a selector string** (`querySelector("…")`, `closest`, `matches`):
- `UX_DOM_HOOKS`: Next, Back, a question card, the progress bar.
- `[data-rs-el="option"]`.
- Every question's `[data-qid="<id>"]`, with its code and text.
- Inside `[data-qid="` it offers the ids.

**Survey names** come from the current definition:
- A question reference inside `rs.getAnswer("…")` / `rs.setAnswer` / `rs.getQuestion` / `get("…")` offers the codes, with the question text as info.
- `rs.getAnswer("Q2") === "…"` and `get('Q2') == '…'` offer **Q2's option codes**, with their labels.

**Placement.** CSS and HTML fields keep their language's own completion. JS fields also get `localCompletionSource` (names the script declared).

### 3. Lint markers from the real gates (`apps/studio/lib/code/diagnostics.ts`, pure)

**The gate for each field:**

| field | gate (run debounced, 350 ms) | severity |
|---|---|---|
| behaviour script | the card's own `validateUxItem(def, "behavior", item)`: the save's gate, authoring problems as warnings | errors / warnings |
| logic script | `codeGate(code, "logic")` | error |
| component JS | `codeGate(code, "component")` | error |
| a style's scoped CSS | `compileStyle` (the save's gate) plus the stylesheet sanitiser | errors / warnings |
| Branding custom CSS, question custom CSS | `sanitizeStylesheet` diff, per line | warning (these fields have never refused a save) |
| Branding header/footer HTML, component HTML | `sanitizeHtml` diff, per line | warning |

**Positions.** The gates return sentences, not positions. `locateMessage` maps them, ignoring the `“label”:` prefix:
- the `rs.method("arg")` the sentence quotes, marked at the argument
- `rs.method is not part …`, marked at the call
- `name is not available`, marked at the name in code (comments and strings are blanked with the engine's own `lexJs`)
- `"x" is not available, not even as a string`, marked at the string
- `computed access on x[…]`, and a computed name built from strings
- loops without braces (the loop keyword), `.click()`, `preventDefault`, `document.head` / `createElement`, `rs.popup`, a self-calling timer, an answer fill
- otherwise the first quoted name or selector in the sentence that occurs in the code

**Fallbacks:**
- A **parse error** ("does not parse: …") goes on the line where CodeMirror's parser first produced an error node.
- A sentence that names nothing findable is **attached to line 1** and says "(the check gives no position — shown on line 1)" (`located: false`). An example is "longer than 20,000 characters".
- For the sanitisers, the diff is per line. When the change spans lines (a `<script>…</script>` block), it is marked at the first character that differs.

**Unchanged.**
- **Save still refuses on errors exactly as before.** The editor only shows the findings. The refusal lists (`ux-item-errors`, `script-refused`, `component-js-refused`) and their wording are untouched.

**Header.**
- **Reads / writes:** `scriptLiteralRefs` (S2b), for behaviour and logic scripts. For example: "reads AGE · writes TOTAL", or "reads nothing named · writes nothing".
- **Script-health chip** (S1c): moved into the editor header for behaviour scripts, Scripts-panel scripts and component JS. It keeps the same test id and `data-script`.

### 4. Where it is now — every screen

| screen | field | test id | gate on save (unchanged) |
|---|---|---|---|
| Question → Properties → Styles, animations & scripts → a script | behaviour script | `ux-script` | `validateUxItem` on leaving / Mod‑S |
| Live View → option → Properties → Styles… | behaviour script | `ux-script` | same |
| Flow → page / block editor → Styles… | behaviour script | `ux-script` | same |
| Research tools → Branding → Styles, animations & scripts (survey-wide) | behaviour script | `ux-script` | same |
| any of the above → a style → Scoped CSS | scoped CSS | `ux-style-css` | `validateUxItem` / `compileStyle` |
| Research tools → Scripts → a script | logic script | `script-code` | `codeGate(…, "logic")` on leaving / Mod‑S / "Save code" |
| Question (Custom component) → Properties → Component code | Component HTML | `component-html` | none (saved as typed) |
| same | Component JavaScript | `component-js` | `codeGate(…, "component")` on leaving / Mod‑S / "Save code" |
| Question → Properties → Styles… → Custom CSS | question CSS | `custom-css` | none (saved as typed) |
| Research tools → Branding → Header / footer / custom CSS | header HTML, footer HTML, survey CSS | `branding-header-html`, `branding-footer-html`, `branding-custom-css` (new — they had none) | none (saved as typed) |

These stay textareas, and that is a deliberate scope choice:
- a style rule's declaration list (`ux-rule-decls`): it is a `property: value` list with its own parser, not a stylesheet
- a behaviour's effects JSON (`ux-beh-effects`)
- the JSON tab
- the expression input (`expr-input`)
- rich text

### Keyboard shortcuts (in any code field)

| keys | does |
|---|---|
| Ctrl/Cmd‑S | save the field now (same gate as leaving it) |
| Ctrl/Cmd‑F | find (panel at the top) |
| Ctrl/Cmd‑H | find & replace (opens the same panel, which has the replace field) |
| F3 / Shift‑F3, Enter in the panel | next / previous match |
| Ctrl/Cmd‑Z, Ctrl/Cmd‑Shift‑Z, Ctrl/Cmd‑Y | the editor's undo / redo (the Studio's undo is outside the editor) |
| Ctrl‑Space | open completion |
| Enter (in the list) | accept a completion; Esc closes the list |
| Ctrl/Cmd‑] / Ctrl/Cmd‑[ | indent / outdent the line |
| Ctrl/Cmd‑/ | toggle comment |
| Esc | close the list / panel → leave full screen → leave the editor |
| Tab / Shift‑Tab | move focus (never captured) |

### Chunk size

- **Dev chunk** (`_app-pages-browser_components_studio_code_codeEditorSetup_ts.js`, measured by `code-editor-test`): **3,686 KiB**. This is unminified and includes Next dev's eval-source-maps.
- **Production** (`next build` into a separate dist dir, `NEXT_DIST_DIR=.next-s3a`, then deleted): the dynamic import loads three chunks, and none of them is in any page's initial chunk list (`app-build-manifest.json`):

  | chunk | raw | gzip |
  |---|---|---|
  | `1af7ea47.….js` (id 6890: state / view core) | 192,037 B | 60,615 B |
  | `1612.….js` (languages, lezer parsers, search / lint / autocomplete) | 375,711 B | 130,889 B |
  | `8387.….js` (`codeEditorSetup` + `format.ts`) | 4,657 B | 2,303 B |
  | **total** | **572,405 B (559 KiB)** | **193,807 B (189 KiB)** |

  Most of the weight is `lang-html`, which carries the CSS and JavaScript parsers too.
- **Lazy loading verified:** the JSON tab does not request the chunk. It is requested once, when the first code field appears.

## Verification

| check | result |
|---|---|
| studio lib units `node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | **1114 / 1114**. New tests: `format.test` 5, `completions.test` 8, `diagnostics.test` 12 (was 1089) |
| engine `pnpm -s build && node --test dist/*.test.js` | **2523 / 2523** (+1: registry signatures / helper docs / component api) |
| runtime lib | **57 / 57** |
| tsc studio / runtime / renderer | **0 / 0 / 0** |
| Studio production build (`next build`, heap 4,600 MB, servers stopped) | **succeeded**, ~3 min; editor chunk sizes above |
| `node scripts/gen-public-docs.mjs --check` | current (no public docs changed) |
| `node scripts/dependency-boundaries.mjs` | 0 violations (2034 files) |
| `node scripts/auth-guard-audit.mjs` | 0 problems (259 handlers) |
| **new** `scripts/code-editor-test.mjs` | **OK**: 11 checks, A–F, 45 s |
| `properties-accordion-test.mjs` | ok (reads `.value` now instead of `inputValue`) |
| `script-audit-test.mjs` | ok (types into `script-code` with `fill`, unchanged) |
| `ux-script-dom-test.mjs` | ok |
| `logic-scripts-sandbox-test.mjs` | ok |
| `style-script-p0-test.mjs` | ok |
| `oct06-review-test.mjs` | ok |
| `script-health-test.mjs` | FAIL in the batch run: a Studio `next-server` was OOM-killed at uptime 16992 s and the summary never loaded. Rerun alone: **6 / 6** (the chip in the editor header) |
| `codes-sync-test.mjs` | **FAIL twice, both OOM deaths.** Run 1: "Target crashed" after 11 ok (next-server and headless_shell OOM-killed at 17323 s). Run 2: `.menubar` timeout at line 394 after 11 ok (next-server OOM-killed at 19379 / 19465 s). In both runs its editor steps passed: 10–13 (Properties shows and edits AI-made CSS/HTML/script, read via `.value`) and 16–20 (Branding). |

- The Studio dev server ran with a 4,600 MB heap (a private copy of `studio-sup.sh`) and the runtime with 1,800 MB, on a 7.8 GB machine.
- The OOM kills are the same memory pressure recorded in S2c.

## Honest limits

- **Format is re-indentation**, not a formatter: no line breaking, no quote or semicolon style, no blank-line policy.
- **Positions are mapped from the gates' sentences**, because the gates give none. A sentence that names nothing findable is shown on line 1 and says so. A forbidden name that appears twice is marked at its first occurrence in code.
- **Completion reads literal context** on the current text before the cursor:
  - A name built at run time is not completed.
  - Selector completion works for literal `querySelector / closest / matches` strings.
- **Lint and completion run on the client only.** The server and the runtime re-check exactly as before. Nothing about what is saved or run changed.
- **Dark mode is read once** from the Studio's background when the editor mounts. The Studio has no dark theme today.
- **Read-only state is now passed** to the Branding and question CSS/HTML editors (`s.readOnly`). Before, these textareas had no read-only state, so a viewer could type into them.
- **Leaving a field** by clicking another question card commits first, as the textarea did. On a busy re-render, that click can be lost. This is the same as before, and the suite clicks again. Not changed.
- **Not in this step (S3b):** enable/disable for behaviour scripts, duplicate, an all-scripts list, import/export, per-script history and diff, an in-editor test run with logs, and snippets — all done in part B below.


---

# S3b — Manual Mode, part B: managing scripts (2026-10-31)

Branch `feat/persistent-execution-engine`, from `c050d9e` (8 commits `84f4205` … this one). Audit rows MM-06 (duplicate), MM-07 (enable/disable), MM-08 (import/export), MM-09 (overview, per-script history), MM-11 (logs beside the editor), MM-12 (snippets), MM-15 (test run in the editor). No new npm dependency. The one schema change is additive.

## What changed

### 1. Switch a behaviour on / off (MM-07)

- **Schema** (`packages/schema/src/ux.ts`): `UxBehavior.enabled?: boolean` (absent = on; every stored survey parses unchanged) and `UxBehavior.notes?: string` (≤ 600; the import's review note; never shown to respondents).
- **Runtime:** `UxLayer` filters `enabled === false` out before anything starts: no sandbox frame, no click / hover handlers, no events. The engine's `evaluateUxTriggers` skips it too.
- **Gate:**
  - switching **off** is always allowed in the editor, even for code the check refuses (a refused import can be parked);
  - switching **on**, or any other edit, passes `validateUxItem` as before;
  - in Intelligent mode, a switched-off behaviour is nobody's duplicate (`refuseDuplicate`); switching on a copy while its twin runs is refused, with the usual "update … instead";
  - `reviewUx` reports a switched-off item's errors as warnings ("switched off — it cannot be switched on until this is fixed");
  - the S2c test session (`proposalCodeItems`) skips a switched-off script.
- **Audit log:** `scriptItems` now carries a UX script's `enabled`, so `diffScriptItems` writes `script.disabled` / `script.enabled` for behaviour scripts (S1c already had the actions for logic scripts).
- **Intelligent mode:** `update_behavior {"id", "enabled": false|true}` (also `"disabled": true`). The description says "switched off (it stays here, and does not run)" or "switched on". The outline and `uxBehaviorWords` mark the item `DISABLED`. One line in the UX guide; the system prompt is untouched.
- **UI:** an **on** box (`ux-item-enabled`) in the header of every Styles-animations-&-scripts card that is a behaviour (script or effects). A dashed card and a note (`ux-item-off-note`) when off. A Scripts-panel logic script keeps its existing **enabled** box (with the S0b gate on switching on).

### 2. Duplicate (MM-06)

`apps/studio/lib/scripts/manage.ts`:
- `duplicateUxItem` and `duplicateLogicScript` give a new id and a "(copy)" name. A copy of a copy is "(copy 2)", "(copy 3)", within the name limit.
- **Behaviours and logic scripts start switched off**, so the two never both run.
- A copied behaviour drops its `source` (it is no longer the moved Custom code field).
- Styles and animations have no switch; their copy applies at once.

**Duplicate** buttons:
- `ux-item-duplicate` in every card header, inserted right after the original;
- `script-duplicate` on each Scripts-panel script.

The note "The copy is switched off, so the two never both run — edit it, then switch it on." is in the button's title and the toast.

### 3. Research tools → All code (MM-09 overview, MM-11 logs)

`lib/scripts/inventory.ts` (pure) builds one row per item of the script audit log (`scriptItems`), so the list, the log and History use the same ids. The kinds:
- behaviour script
- logic script
- component JS and component HTML
- question CSS
- header HTML, footer HTML and survey CSS
- the old Custom code fields

Each row has:
- where it runs (`describeUxTarget`, or the scope with the question code)
- its events (`rs.listen` events and targets, DOM listeners, the logic event, a component's render / answer change)
- on / off (or "—")
- the check's verdict (`scriptVerdict`)
- reads / writes (`scriptLiteralRefs`)
- the id its health is reported under

**`AllCodePanel`** (new tab key `allcode`, label **All code**):
- It sits in **Research tools, right after Scripts**. Research tools is where the Studio's survey-code screens already are (Branding, Translation, Scripts).
- It is in `EDITING_TABS`, so its controls are inert in read-only mode. Viewers still see the list and read-only editors.
- Each row shows the S1c health chip (`/api/surveys/[id]/script-health`) and the last error (the top message).
- Filters:
  - kind (`allcode-kind`)
  - text over names, questions, refs and the code itself (`allcode-search`)
  - problems: refused, sanitised or legacy, or failing live (`allcode-problems`)
  - switched off only (`allcode-off`)
- Clicking a row opens that item's own editor in place (`allcode-editor`):
  - `UxItemEditorById` (the same `UxItemCard`, with save, remove and duplicate through the shared `useUxItemActions`);
  - `LogicScriptCard` (taken out of `ScriptsPanel` unchanged);
  - `ComponentJsField` (exported from PropertiesPanel, with the same gate);
  - a CSS / HTML field saved when left, as on its home screen.

### 4. Import / export (MM-08)

`lib/scripts/bundle.ts` uses the format `{ "format": "rescript-scripts", "version": 1, "source": { survey, title, exportedAt }, "items": [ … ] }`.

**An item** is a behaviour (a script or effects) or a logic script. It holds:
- name, code, events (`on`, `options`; `event`, `scope`), `once`
- **where it runs by question code**: an option by its code, a block by its title, a page by its 1-based number, an effect's own target the same way
- question ids that appear inside the code, carried as id → code

**Import** (`importScripts`):
- It resolves codes to the new survey's ids and rewrites ids inside the code.
- Each item goes through its gate: `validateUxItem` for a behaviour, `codeGate(…, "logic")` for a logic script.
- What is imported arrives **switched off** with `notes` "Imported from SRC on 2026-10-31 — switched off: review it, then switch it on."
- Items that could not be mapped (a question, option, block or page the survey does not have) are listed with the reason and **not imported**.
- Items the gate refuses are listed with the reasons and **not imported**.
- An "only when" condition is not carried (it names questions by id inside an expression tree). The note says so.

**UI** (All code → **Export / import scripts**, `ScriptBundleTools`):
- export the selected rows (`bundle-export-selected`) or every script (`bundle-export-all`);
- the JSON is shown, with a **Download .json** link;
- import from a file or a paste, then **Check** (a preview of what is added, unmapped and refused), then **Import (switched off)**: one labelled, undoable edit.

### 5. Per-script History and a readable diff (MM-09)

`lib/scripts/history.ts` (pure):
- `itemCode`: one item's code in any definition, by the audit key;
- `lineDiff`: LCS on lines after a common head and tail, with line numbers on both sides; a removal comes before an addition, so a replacement reads "− old / + new"; above 1,500 lines the middle is compared as one block;
- `diffText`;
- `itemAuditEntries`.

**History** (`code-history-toggle`) is in the header of:
- every behaviour-script editor
- every Scripts-panel logic-script editor
- every component-JavaScript editor (Properties and All code)

**The panel** (`ScriptHistory.tsx`):
- that item's S1c audit entries;
- a code diff (`code-history-diff`, `+n −m`) between any two of:
  - the survey's saved versions (`/api/surveys/[id]/versions[/vid]`)
  - this session's edits: the Studio's undo stack, now exposed as `store.editHistory`; consecutive identical codes collapse
  - "now (stored)"
  - "now (this editor, not saved)"
- by default, the last different version against now.

### 6. Run in a test session from the editor (MM-15)

`lib/scripts/testRun.ts` (pure):
- `editorRunInput` puts the editor's **unsaved** text into a clone of the survey and builds the S2c harness item from it. A switched-off behaviour is switched on in the clone.
- `runEditorTest` takes the runner as an argument; the browser passes `runVerification`.
- `runLog` flattens the record into lines: `rs.log` / `log`, errors with their line, effects, writes, what Next did, notes.
- `runMarkers` turns an error that names a line into an error marker on that line, once per line.

**The button and its panel:**
- **Run in a test session** (`code-run`) is in the header of behaviour, logic and component editors (`components/studio/code/ScriptTools.tsx`).
- The panel under the editor (`code-run-panel`, with `data-verdict`) shows the verdict in words, the summary, the scenario count, the time, "not saved", and the run log (`code-run-log`).

**Markers in `CodeEditor`:**
- `extraDiagnostics` adds the run's markers while the text is still the text that ran. The next edit's lint drops them.
- `EditorHandle.relint()` dispatches `setDiagnostics` directly. CodeMirror's `forceLinting` only runs a lint that is already pending, so it did nothing on an unchanged text. The browser suite found this.

Nothing is saved, and the draft is never touched. The S2c limits apply (5 s per item).

### 7. Snippets (MM-12)

`lib/code/snippets.ts` has eight built-in snippets:

| snippet | kind |
|---|---|
| highlight on select | behaviour script |
| live total with warning | behaviour script |
| countdown display (each second scheduled once, so there is no self-calling timer) | behaviour script |
| show message after answer | behaviour script |
| section jump button (`rs.goToSection`) | behaviour script |
| logic-script calculation | logic script |
| logic-script validation (`error(msg, ref)`) | logic script |
| component skeleton (`el` / `api`) | component |

Each passes its own gate as written, and the tests check that.

They are offered in two ways:
- as **completion entries of type `snippet`** ("snippet highlight on select"…) at a bare name, for the field's kind. They are never offered inside a string or after `rs.`;
- from an **Insert snippet…** menu (`code-snippet-menu`) in the editor toolbar, which inserts at the cursor on its own line with the line's indentation (`EditorHandle.insert`).

Snippets are plain text with placeholder codes (Q1, Q2, TOTAL…). They have no tab-stops, because a snippet's tab-stops would capture Tab, and the editor keeps Tab for focus.

**Not built:** an organisation-wide shared snippet library. It needs a backend (storage, permissions, versioning) and is out of scope.

## Where to find it

| what | where | test ids |
|---|---|---|
| on / off | Question → Properties → Styles, animations & scripts → a behaviour card's header (also Live View option, Flow page / block, Branding survey-wide, All code) | `ux-item-enabled`, `ux-item-off-note` |
| duplicate | the same card headers; Research tools → Scripts → a script's row | `ux-item-duplicate`, `script-duplicate` |
| all code | **Research tools → All code** (`?tab=allcode`) | `allcode-panel`, `allcode-row[data-key]`, `allcode-open`, `allcode-editor` |
| import / export | All code → **Export / import scripts** | `bundle-toggle`, `bundle-export-all`, `bundle-json`, `bundle-import-text`, `bundle-import-check`, `bundle-import-apply` |
| history | **History** in the header of a behaviour script, logic script or component JavaScript editor | `code-history-toggle`, `code-history-diff` |
| test run | **Run in a test session** in the same headers | `code-run`, `code-run-panel`, `code-run-log` |
| snippets | **Insert snippet…** in the editor toolbar; completion "snippet …" | `code-snippet-menu` |

Public doc: `apps/studio/content/docs/custom-code.md` has a new section, "Managing scripts — on/off, duplicate, all code, import / export, history, test run, snippets". `gen-public-docs --check` is current. `actions-reference.md` is generated and did not change, because `BehFields` is not expanded there; `enabled` is in the UX guide.

## Verification

| check | result |
|---|---|
| studio lib units `node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | **1132 / 1132** (was 1114). New: `scripts/manage.test` 4, `scripts/inventory.test` 2, `scripts/bundle.test` 3 (a round trip between two surveys with different ids), `scripts/history.test` 3, `scripts/testRun.test` 3 (the harness gets the unsaved text), `code/snippets.test` 3 (every snippet passes its gate). `completions.test`'s exact-list helper now ignores snippet entries |
| engine `pnpm -s build && node --test dist/*.test.js` | **2529 / 2529** (was 2523; new `uxEnabled.test` 6) |
| runtime lib | **57 / 57** |
| tsc studio / runtime / renderer | **0 / 0 / 0** |
| `node scripts/gen-public-docs.mjs --check` | current |
| `node scripts/dependency-boundaries.mjs` | 0 violations (2051 files) |
| `node scripts/auth-guard-audit.mjs` | 0 problems (259 handlers) |
| **new** `scripts/script-manage-test.mjs` (items 1–7) | **13 passed**, 23 s. The first run failed at the test-run marker, which is how the `forceLinting` bug was found and fixed |
| `code-editor-test.mjs` | ok (42 s) |
| `script-audit-test.mjs` | ok (24 s) |
| `im-verify-test.mjs` | ok (54 s) |
| `ux-script-dom-test.mjs` | ok (78 s) |
| `logic-scripts-sandbox-test.mjs` | ok (34 s) |
| `script-health-test.mjs` | **not passed: 4 attempts, each with an OOM kill during the run** (dmesg, uptime s): batch run, runtime next-server 4499 killed at 22622 (failed in A after session 1); alone, Studio 5234 at 22995 and Studio 5607 at 23609 (both failed in B waiting for `script-health-totals`); direct on warmed servers, runtime 5642 at 23866 (failed at the start). In S3a it passed 6 / 6 alone. Its Scripts-panel parts (chips in the header) are also exercised by `code-editor-test` and `script-audit-test`, which passed |

The Studio ran with `studio-sup-4600.sh` (heap 4,600 MB). The runtime ran from `fresh.sh` (1,800 MB). The machine has 7.8 GB.

## Honest limits

- **The runtime's skipping of a switched-off script is unit-tested** (`evaluateUxTriggers`, `UxLayer`'s filter is one line). No browser suite checks a disabled script in the respondent runtime. `ux-script-dom-test` (enabled scripts) passed.
- **Custom Component code and Branding / question CSS / HTML have no on/off switch.** There is no field for it, and a component's script *is* the question.
- **Duplicate** is not offered for Custom Components (a copy would be a second question) or Branding.
- **A bundle carries behaviours and logic scripts only.** It does not carry components, Branding, question CSS, styles or animations, and not "only when" conditions. A refused or unmappable item is listed and not imported; it is never imported as disabled code.
- **Import matches by question code.** A survey whose codes differ needs the codes renamed first. Ids inside code are rewritten only for questions (not for blocks or pages).
- **History's saved versions need the database.** The sandbox has none, so there it compares this session's edits and the editor. The undo stack is capped (`UNDO_LIMIT`) and is lost on reload.
- **The test run is the S2c harness.** It has the same scenarios and limits (5 s per item), runs only on pages the survey shows, and a logic script whose event the scenarios cannot reach is "not run".
  - The browser suite covers a behaviour script. The logic and component paths are unit-tested (`editorRunInput`) and use the same harness `im-verify-test` exercises.
  - Line numbers come from the sandbox's stack (`new Function` offset). An error with no line is in the log, not marked.
- **The All code list is read from the draft.** Live health needs the response-reading right, as in S1c. In the sandbox it shows "not available here" unless a health token is in the URL.
- **There is no browser test of the read-only All code list.** It relies on `EDITING_TABS` and `s.readOnly`, which every editor in it honours.

---

# S3 complete — Manual Mode (parts A and B)

| audit row | status after S3 |
|---|---|
| MM-01 code editor (Critical) | **Done (A)**: CodeMirror 6 everywhere code is typed |
| MM-02 / MM-14 completion and in-editor reference | **Done (A)**: from the capability registry and the survey |
| MM-10 dependencies | **Done (A + S2b)**: a reads / writes header on every script |
| MM-06 duplicate | **Done (B)** |
| MM-07 enable / disable | **Done (B)**: behaviour scripts now too (logic scripts had it) |
| MM-08 import / export | **Done (B)**: a bundle by question code, gated, imported switched off |
| MM-09 per-script history / overview | **Done (B)**: All code, History with a code diff |
| MM-11 logs beside the editor | **Done (B)**: the test-run log, plus health and last error per row in All code |
| MM-12 snippets | **Done (B)**: built in. **Org-wide sharing is not built** (needs a backend) |
| MM-13 sharing scripts across surveys | **Partly (B)**: by bundle file. There is no shared library |
| MM-15 test run in the editor | **Done (B)**: the S2c harness on the unsaved text, errors as markers. There is no step debugger or breakpoints |

**Open for a later step:**
- a shared snippet / script library
- a step debugger
- on/off for components
- a browser check of a disabled script in the respondent runtime
- a passing `script-health-test` run on a machine with more memory
