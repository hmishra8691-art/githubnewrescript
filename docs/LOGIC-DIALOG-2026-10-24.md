# Logic workspace — the centred logic dialog (24 Oct 2026)

Client review 23-10-2026, item 3: *"When we select a question and open the Properties section to apply logic, the logic configuration box appears in the right corner, making it difficult to manage complex logic and nested conditions. Display the logic configuration box in the centre of the frame as a pop-up or modal window with more space."* The sample was the Qualtrics "Display logic (…)" dialog: a centred box, a title naming the question, one explanatory line, the builder, and Close / Save at the bottom.

This work adds that dialog (the **logic workspace**) and wires it into every place in the Studio where a researcher builds conditions or rules. The engine, the evaluation and the stored data structures are unchanged. The workspace edits a draft copy and saves it through the same `onChange` / `patch` the inline editor already used.

## Where to find it

No environment variables are needed; it runs on the Studio sandbox as is.

| Feature | Screen → place → control |
|---|---|
| Display logic | Questions → select a question → Properties → **Display logic** → "⤢ in workspace" (no logic yet) or the ⤢ button in the builder's Visual/Expression bar (logic present) |
| Skip logic (whole list) | Properties → **Skip logic** → strip with the count and one line per rule → "⤢ Edit rules in workspace" |
| Validation rules (whole list) | Properties → **Validation rules** → strip → "⤢ Edit rules in workspace" |
| Auto punch (whole list) | Properties → **Auto punch** → strip → "⤢ Edit rules in workspace" |
| List logic (whole list) | Properties → **List logic** → strip → "⤢ Edit rules in workspace" |
| Masking / row masking / column masking | Properties → masking section → ⤢ on the Visual/Expression bar |
| Branch / condition (all paths) | Survey Flow → a Branch card → "⤢ Edit all paths in workspace" |
| Any other condition | the ⤢ button on that condition's Visual/Expression bar, or "⤢ in workspace" beside "+ add" |
| Compact panel = **the default** | The Properties panel (and the Architect inspector that hosts it) and the Survey Flow cards show each rule set as a read-only summary: the count ("3 conditions", "2 rules", "2 paths"), the plain-language sentence, the section's active dot, and **"Edit logic ⤢"** ("Add logic ⤢" when empty). Editing happens only in the centred dialog. |
| Opt-out (inline builders) | In any workspace footer, tick **"Also show the builders in the Properties panel"**. It is per browser (localStorage `rescript.logicSurface = "inline"`) and never written into the survey. Untick it to return to the default. |

## Behaviour (the shared component)

`apps/studio/components/studio/LogicDialog.tsx`:

- **Frame.** A centred dialog of width `min(1100px, 92vw)`, at most 85vh tall. Only the body scrolls, so the header and the Cancel/Save footer stay on screen. It has `role="dialog"`, `aria-modal`, `aria-labelledby` and `aria-describedby`. It is portalled to `<body>`, so it is centred on the window whichever panel opened it. Under 720px wide it becomes a full-screen sheet. Colours come from design tokens only.
- **Header.** The feature title plus the subject, e.g. "Display logic — A3: Age", and one explanatory line ("Display A3 only if the following condition is met:").
- **Draft.** The value is cloned on open, and every edit lands on the clone. **Save** commits it through the caller's own updater as one labelled undo step. **Cancel** discards it, and reopening shows what is saved.
  - Save is disabled while nothing has changed, or while the feature's `validate` objects; the button's tooltip says why. Examples: "Rule 2: pick where to go" (skip logic), "Rule 1: 'min value' needs a value" (validation), "A branch needs at least one path".
  - An "● unsaved changes" chip appears in the header while the draft differs from what is saved.
  - If the saved value changes underneath an open dialog (undo, a collaborator), a clean draft follows it; a dirty draft keeps the person's edits.
- **Closing.** Escape, a click on the backdrop, the × and Cancel all close a clean dialog immediately. On a dirty draft they ask "Discard unsaved changes?" with **Keep editing** / **Discard**.
- **Focus.** Focus moves into the dialog on open and is trapped there (Tab and Shift+Tab wrap). On close it returns to the button that opened the dialog. A workspace opened from inside another (a count's "each counted item must meet") handles its own keys.
- **Props.** `title`, `subject`, `description`, `value`, `onSave`, `onClose`, and `children(draft, setDraft)` as a render-prop. Also `validate(draft) → reason | null`, `footer` (a node or a render-prop), `testId` and `saveLabel`. Helper components: `WorkspaceButton` (the ⤢ opener) and `WorkspaceSummary` (the inline strip with count, sentences and button).
- **Pure logic** lives in `apps/studio/lib/logicDialog/draft.ts` (open, edit, dirty, save-blocked reason, request close, keep editing, commit, reconcile). The panel-mode preference lives in `lib/logicDialog/surface.ts`.

**Where the compact layout applies.** `CompactLogicScope` wraps `PropertiesPanel` and `NodeEditor`, which covers the flow cards and the Architect workspace and inspector. Inside it, with the default preference, `useCompactLogic()` is true and every builder renders as summary + "Edit logic ⤢". The dialog body resets the scope, so the workspace always shows full builders. Wide main panes (Quotas, List Fill, Logic tab, Named expressions, Quality, Response Manager, localisation, AI conversation, and option popups in the question card) are outside the scope: they keep their builders and the ⤢ button. The branch card lists its paths; masking shows "Q8 shows only these options: …".

`ConditionEditor` gained two props, and its data and behaviour are unchanged:
- `layout="wide"` is CSS only: source, operator and value on one row; deeper indentation and a thicker bracket for nested groups; readable AND/OR connector hints.
- `workspace={{ title, subject, description }}`, or `false` to hide the button. **Every** `ConditionEditor` and `OptionalCondition` offers the workspace by default, so a call site added later gets it automatically. The AND/OR match selector, groups, ungroup/duplicate/delete, Test condition, "find operator…" and Visual ⇄ Expression all work inside the workspace exactly as inline.

## Audit: every rule builder in the Studio

**Modal?** — "Yes, whole list" means the workspace holds every rule of that kind with add / remove / reorder. "Yes" means the single condition opens in the workspace from its ⤢ button.

| Feature (file) | Where it lived | Modal? | Why |
|---|---|---|---|
| Display logic (PropertiesPanel) | 440px right panel | **Yes** | The client's example; nested AND/OR needs width. |
| Skip logic (PropertiesPanel) | right panel, one card per rule | **Yes, whole list** | Rules are ordered and each has a condition and a target. Save is blocked while a rule has no target or a bad URL. |
| Validation rules (PropertiesPanel) | right panel | **Yes, whole list** | Kind, value, severity, message, "check only when" and the condition kind together. Save is blocked while a value-kind has no value. |
| Auto punch: option rules and set rules (MaskingBuilder `PunchRules`, AutoPunchEditor) | right panel | **Yes, whole list** | IF / ELSE IF / ELSE chains read as one unit. In the draft a rule cannot be moved to another target question; the Logic tab does that. |
| List logic (PropertiesPanel) | right panel | **Yes, whole list** | Ordered include/exclude rules, each with an optional condition. |
| Masking, row masking, column masking (MaskingBuilder) | right panel | **Yes** (the whole mask: set expression, action, empty-source rule, "apply only when") | Set expressions with brackets need width. "Convert the old pipeline" stays inline because it also rewrites `optionPipeline`, which is outside the draft. |
| Carry-forward "only carry items where" (PropertiesPanel) | right panel | **Yes** | Per-item condition. Source, filter and destination are simple selects and stay inline (H3 owns them). |
| List operations: "keep options where", "only run this step when" | right panel | **Yes** (each condition) | The step kind, sources and ordering are simple selects and stay inline. |
| Conditional randomization rules | right panel | **Yes** (each condition) | Method and pick are simple and stay inline. |
| Follow-up probe "ask only when" / "stop once" | right panel | **Yes** | |
| Validation "check only when" / condition kind (inline cards) | right panel | **Yes** | Also inside the validation workspace. |
| Flow → Branch / condition (FlowNodeEditors) | flow card | **Yes, all paths** | Paths are ordered (first match wins) and reorderable in the workspace. Nested children stay in the flow. |
| Flow → page / block / section "show only when", randomizer "run only when", quota check "check only when", redirect "only when", embedded data "set only when" | flow card | **Yes** | |
| Flow → Loop: eligibility, invalid, skip (CONTINUE), stop (BREAK/UNTIL), aggregate "count an iteration when" (LoopEditor) | flow card | **Yes** | The loop scope (reference columns) is carried into the dialog. |
| Option logic: eligible / exclude / prioritize / deprioritize / randomize when, legacy show-when (OptionLogicEditor) | option popup in the question card | **Yes** | Per-option rules ("this option"). |
| Option groups "show the whole group when" | right panel | **Yes** | |
| Row "show when" (QuestionsPanel fields) | question card | **Yes** | |
| Canvas element panel: display logic, column "show when", row validation "check only when" (ElementPanel) | right panel (Live View) | **Yes** | |
| Quota cell conditions (QuotasPanel) | Quotas tab | **Yes** | |
| List Fill "run only when", per-item "eligible only when" (ListFillPanel) | List Fill tab table | **Yes** | |
| Named expressions (NamedExpressionsPanel) | Logic tab | **Yes** | |
| Logic tab: display rules, calculation "only compute when" (LogicPanel) | Logic tab | **Yes** | |
| Custom quality rules (QualitySettings) | Survey Settings | **Yes** | |
| Styles / scripts "only when" (UxItemsEditor) | right panel / flow | **Yes** | |
| Variant dynamic rules, localisation rules, AI conversation adaptive rules, Response Manager filter | wide main panes | **Button offered** (generic title) | Already in wide panes; the button is still there for nested logic. |
| Count "each counted item must meet" (CountEditor inside a rule) | inside a rule | **Yes** (nested workspace) | Opens over the workspace and saves into its draft. |
| Expression editor / Expr functions | inside ConditionEditor | n/a | Travels with the condition into the workspace. |

### Intentionally left inline

- **Simple properties**: carry-forward source, filter and destination (H3), randomization on/off, method and pick, list-operation kind and sources, quota-check quota list and on-full action, end-of-survey status and message, redirect URL, embedded-data name, type and value, loop source. These are one or two selects or inputs with no nesting.
- **State** (hidden, dictation, default/piped value; H2 and H4), Analysis, Notes, Custom CSS, Component code, geo, probe wording and limits. These are text fields and toggles.
- **Validation "Message position"**: one question setting, not a rule.
- **Wide main panes** keep their builders (see above). They are not the narrow sidebar the review is about, and each still offers ⤢.
- **Within the compact panel**, the simple controls next to a rule set stay inline: carry-forward source/filter/destination, randomization method, list-operation kinds, the condition's "clear" button, and the validation "Message position".

## Bug found and fixed on the way

The Properties panel's click-away listener (`Studio.tsx`, `RightPanel`) treated a click on the dialog's backdrop as "click outside the panel" and deselected the question. That unmounted the panel that owns the dialog, so the draft disappeared without the "Discard?" prompt. The backdrop (`.ld-back`) is now in the listener's ignore list.

## Files

- New: `apps/studio/components/studio/LogicDialog.tsx`, `apps/studio/components/studio/logicDialog.css`, `apps/studio/lib/logicDialog/draft.ts`, `apps/studio/lib/logicDialog/surface.ts`, `apps/studio/lib/logicDialog/draft.test.ts`, `scripts/logic-dialog-test.mjs`.
- Changed:
  - `ConditionBuilder.tsx`: `layout`, `workspace`, summary-only mode, "in workspace" on OptionalCondition.
  - `PropertiesPanel.tsx`: display-logic titles. Skip, validation and list-logic lists were extracted into `SkipRulesList` / `ValidationRulesList` / `ListLogicRules` with strips and workspaces, plus workspace titles on the other conditions.
  - `MaskingBuilder.tsx`: punch-rules workspace (`PunchRulesBody`) and mask workspace.
  - `AutoPunchEditor.tsx`: draft mode for `AutoPunchRows` / `AddRule`; locked target in the draft.
  - `FlowNodeEditors.tsx`: `BranchEditor` / `BranchPaths` and flow-condition titles.
  - `Studio.tsx`: the backdrop fix above.
  - Titles only: `LoopEditor.tsx`, `QuotasPanel.tsx`, `ListFillPanel.tsx`, `NamedExpressionsPanel.tsx`, `OptionLogicEditor.tsx`, `OptionGroupsEditor.tsx`, `QualitySettings.tsx`, `LogicPanel.tsx`, `QuestionsPanel.tsx`, `UxItemsEditor.tsx`, `canvas/ElementPanel.tsx`.

## Browser suites migrated to the workspace (24 Oct, default flipped)

A shared helper, `scripts/lib/logicWorkspace.mjs`, provides:
- `openSectionWorkspace(page, "display-logic" | "skip-logic" | "validation-rules" | "auto-punch" | "list-logic" | "masking" | …)` and `openWorkspace(page, scope)`.
- `saveWorkspace`, which saves; a clean dialog just closes; if the feature refuses Save it logs the reason and discards.
- `discardWorkspace`.
- `reopenLastWorkspace`, for "peek at the JSON, then keep editing".
- `useInlineLogic(page)`, the opt-out. No suite needed it.

In addition, `scripts/lib/nav.mjs` `openTab` / `openTabKey` / `switchMode` save an open workspace before navigating, as a person presses Save before moving on, so every `readDef()` sees what was built.

Migrated suites: logic-builder, smart-operators, matrix-condition, validation-condition, validation-message-editor, validation-kinds, nested-logic-audit, masking, masking-matrix, autopunch-header, autopunch-matrix, expression-editor, expression-copy, cond-rule-grid, option-popup, properties-accordion, named-expressions, schema-integrity, loop, blocks, save-integrity (plus a retry on a refused connection while the dev server restarts), qa-fixes (its narrow-layout check now runs on the workspace), codes-sync, and contains-operator (H4's; the one helper change only).

## Tests

- Unit: `cd apps/studio && node --experimental-strip-types --no-warnings --test lib/logicDialog/draft.test.ts`. 8 tests cover clone isolation, structural dirty check, save-blocked reasons, close/confirm/keep/discard, commit and reopen, reconcile with an external change, and the panel-mode preference. The full Studio unit run is 838/838.
- Browser: `flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/logic-dialog-test.mjs`. 20 checks:
  - Display logic: three conditions with a nested OR group, Save stores exactly `AND[OR[A1=yes, A1=no], A2=m]`, the inline summary updates.
  - Cancel / Keep editing / Discard, and reopening shows the saved state.
  - Escape and backdrop on clean and dirty drafts; a 60-Tab focus trap and focus return.
  - Skip, validation and auto-punch whole-list add / remove / reorder / blocked Save.
  - A flow branch with two paths.
  - 16 conditions: dialog height ≤ 85vh and the body scrolls.
  - A full-screen sheet at 680px.
  - The default compact panel (count + sentence + "Edit logic ⤢"; no builder in the panel or the branch card) and the inline opt-out.
