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
- **Not in this step (S3b):** enable/disable for behaviour scripts, duplicate, an all-scripts list, import/export, per-script history and diff, an in-editor test run with logs, and snippets.
