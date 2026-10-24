# Review documents 19/10/2026 and 23/10/2026 — implementation report (2026-10-24)

Sources: `19_10_26.xlsx` (hidden questions, Add Element, block preview, Contains, piping on open ends, stale preview) and `23-10-2026.xlsx` (variable-name case, carry-forward, centred logic popup — sample: the Qualtrics "Display logic (…)" modal).

Detail docs:

- `LOGIC-DIALOG-2026-10-24.md`
- `HIDDEN-AUTOPUNCH-2026-10-24.md`
- `FLOW-PREVIEW-NAMING-CARRY-2026-10-24.md`
- `CONTAINS-AND-OPEN-END-DEFAULTS-2026-10-24.md`

## 1. Centred logic popup (23/10 item 3, and the brief)

One shared component, `LogicDialog`.

**The dialog**

- **Size and position:** centred, about min(1100px, 92vw) wide, at most 85vh tall, with internal scrolling. It becomes full screen under 720px.
- **Header:** the feature title, the question, and a one-line explanation.
- **Editing:** changes are made on a draft. **Save** commits through the existing update path, so the data, the engine and runtime behaviour are unchanged. **Cancel**, **Esc**, the backdrop and **×** ask before discarding unsaved edits.
- **Accessibility:** focus is trapped in the dialog and returns to the button that opened it.

**What the Properties panel and flow cards show (the default):** each rule set appears as a compact summary — the count, a plain-language sentence and the active dot — with **"Edit logic ⤢"** ("Add logic ⤢" when empty).

**In the popup:**

| Feature | What the popup holds |
|---|---|
| Display logic | the condition |
| Skip logic | the whole list |
| Validation rules | the whole list |
| Auto-punch: option rules and set rules | the whole list |
| List logic | the whole list |
| Row, column and option masking | the mask |
| Carry-forward "only carry items where" | the condition |
| List-operation filters | the condition |
| Conditional randomization | the condition |
| Follow-up probe ask / stop | the condition |
| Survey Flow → Branch / condition | all paths |
| Survey Flow → page / block / section, randomizer, quota check, redirect and embedded-data conditions | the condition |
| Survey Flow → loop rules | the rules |
| Option logic, option groups, row "show when" | the condition |
| Canvas element panel | the condition |

**Same ⤢ button, also in the wide panes:** quota cells, List Fill, named expressions, Logic tab rules, quality rules, and script "only when".

**Left inline on purpose** (simple selects, toggles and fields):

- carry-forward source, filter and destination;
- randomization method and pick;
- list-operation kind;
- quota and end-of-survey settings;
- State, Notes, CSS, and validation "Message position".

**Opt-out:** a per-browser checkbox in the dialog footer shows the builders inline again. It is never saved into the survey.

## 2. The 19/10 items

| Item | What was done |
|---|---|
| **Read Only removed** | Properties → State shows only Hidden. Old surveys keep `readOnly` working; State offers "legacy read-only · clear". Intelligent Mode no longer sets it. |
| **Hidden = invisible to respondents only** | Shown in Preview, test mode and test links with the purple theme: `#F3EEFF` background, `#9B7BEA` dashed border, eye-slash icon, "HIDDEN QUESTION" badge, info banner, "Q6 — 🔒 HIDDEN". This works on every question type. Live links draw nothing and leave no empty page. Logic, auto-punch, piping and calculations still run, and a required hidden question never blocks Next. The mode is decided by the route that served the page, never by a URL parameter. |
| **Auto-punch visualisation** | Green option, light-green background and "AUTO-PUNCHED" badge. A status line: Applied, Waiting for Condition, Failed or No Matching Condition. A "Selected Answer" line and expandable details showing source, condition, target, option, TRUE/FALSE and status. It updates live. Stored data is unchanged. Preview and test only. |
| **Stale preview** | Saved preview answers carry a fingerprint of each question's configuration (options, Hidden, punch rules, logic). A changed question has its answer, and any punch that depends on it, recalculated. Unrelated answers and plain navigation are kept. |
| **Add Element** | One long horizontal row of the nine elements, opening below the "+ Add element" that was clicked. Each button has an icon over its label and a tooltip. Hover is light blue. The row scrolls sideways on narrow screens and animates open and closed. Keyboard: ←/→, Home/End, Enter and Esc. It applies to every "+ Add element". |
| **Block preview** | Only the chosen block is shown, with the embedded data before it. Back and Next never leave the block. The end screen says "Thank you for completing this block." with **↻ Restart Block**, which restarts that block only. The full preview keeps "Restart test session". |
| **Contains operator** | Offered only on text inputs; choice, grid and numeric questions no longer offer it. New operators: **is in list** and **is between (numbers)**, inclusive and value-by-value for comma-separated answers. The client's table gives the expected results. Display, branch, skip and quota logic share one evaluator. Old saved conditions evaluate as before and show "needs update" with a one-click fix. |
| **Piping box on every open field** | A default/piped value box on text and numeric list fields, matrix text and numeric rows, constant-sum rows, composite and custom-table columns and cells, and "Other — specify" boxes. It pre-fills only an empty field, once. Respondents never see `{{…}}`. An empty box changes nothing. |

## 3. The 23/10 items

| Item | What was done |
|---|---|
| **1. Variable name forced to uppercase** | It was a Studio input habit, not a constraint. Names now keep the typed case and default to the code. Duplicate checks ignore case, so Q6a and Q6A cannot coexist. SPSS and SAS exports upper-case names themselves; CSV and Stata keep the case. Existing surveys are not rewritten. |
| **2. Carry-forward destinations** | Single and multi select carry into the answer list automatically, with no dropdown. Grids offer rows and columns only. "Options" no longer appears. Stored values and older surveys keep working. A destination that a question type can never use gets a warning with a one-click fix. |
| **3. Logic popup** | See §1. |

## 4. Also fixed on the way

- Clicking the backdrop of a dialog with unsaved edits deselected the question and dropped the draft.
- Escape in the variable-name field saved instead of cancelling.
- Back at the start of a survey that begins with embedded data showed a blank page.
- An emoji, star or heart slider without explicit bounds drew 10 faces instead of the variant's 5.
- A linter rule wrongly flagged brand_tracker's grid carry-forward.

## 5. Verification

**Unit tests**, all passing:

| Package | Tests |
|---|---|
| engine | 2,330 |
| analytics | 749 |
| designs | 114 |
| ai | 150 |
| exporters | 138 |
| templates | 110 |
| access | 123 |
| quality | 61 |
| billing | 57 |
| media | 174 |
| interviews | 178 |
| import | 51 |
| schema | 11 |
| Studio lib | 838 |
| runtime lib | 55 |

**Checks:** typechecks clean; public docs current; dependency boundaries 0 violations; auth-guard 249 handlers, 0 problems; fake AI evaluation 67/67.

**Browser suites, run on 2026-10-24.** 44 of 49 passed in one run; two more passed on rerun:

- **New suites:** `logic-dialog` (20), `hidden-autopunch` (9), `flow-preview-naming` (10), `contains-operator` (7), `open-end-default` (9).
- **24 suites migrated to the popup:** they pass, including logic-builder, smart-operators, matrix-condition, validation (condition, kinds, message editor), nested-logic-audit, masking, masking-matrix, the auto-punch suites, expression-editor, cond-rule-grid, option-popup, properties-accordion, named-expressions, schema-integrity, loop, blocks, qa-fixes, codes-sync, save-integrity and listfill.
- **Other regressions:** flow-ed, flow-dnd, default-value, master-demo, intelligent-engine, copilot, popup-p3, layout-centering, qual-research, analysis-plan, conjoint-suite, methods-intelligent, engine-15-19, engine-11-14, speech-input, menubar and canvas pass.

**Environment note.** The sandbox Studio dev server is repeatedly killed for lack of memory (`dmesg`: cgroup OOM). Three suites could not finish here because of it, at steps that touch nothing in this change:

| Suite | Where it died |
|---|---|
| `live-session` | Browser tab crashed at step 4 |
| `analytics` | The server died while compiling `/share/[token]`; no analytics or share file changed |
| `ux-copilot` | Every step passed; the final page-error check saw the dev server's HMR socket refused during a restart |

## 6. Needs your decision

- **The opt-out checkbox:** inline logic editing stays available per browser. Remove it if you want the popup to be the only way.
- **Hidden-question test note:** "Thank you for completing this block." and the hidden-question test notes are English only. They are programmer-facing.
- **Live links in the browser:** published and test links themselves were not driven in a browser, because they need the database. Live hiding is covered by unit tests and by Preview's "as a respondent" view.
