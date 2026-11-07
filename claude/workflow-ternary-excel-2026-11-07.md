# Workflow Builder, branch logic, piping, ternary logic, Excel list, Intelligent Mode (2026-11-07) — patch 0091

One engine for the Studio, the runtime, the preview and Intelligent Mode: `packages/engine/src/branchLogic.ts`,
`dynamicLogic.ts`, `flowLogicActions.ts` (+ `calc.ts` ternary, `piping.ts` grid cells, `validate.ts` content types).

## Checklist

| # | Requirement | Before | Now | How verified |
|---|---|---|---|---|
| 1 | Branch auto-name, visible at once, editable, unique | Missing (title optional, empty) | Fixed | `insertFlowNode` names every new branch "Branch N" (unique); the card's Name field shows it, can be renamed, re-fills when emptied; paths named from their condition while the label is still generated, a typed label kept; tests "branches: named at birth…" |
| 1 | Splitter / import names branches | Missing | Fixed | "Split by question…" on the branch card and `split_branch` (one path per option, "Q1 = A"); `ensureBranchNames` on import; tests "split by question…", "ensureBranchNames…" |
| 2 | Select existing blocks in a branch path | Missing (drag only) | Fixed | "+ Existing block" on every path and OTHERWISE: blocks selectable, questions listed under their block and never selectable, reasons for every refusal (already here / the branch reads its answers / contains the branch); the block is moved, never copied; test "existing blocks…" |
| 3 | Piping audit | Working | Tested and Verified + 2 fixes | `{{expr:…}}` pipes were not dependency edges (deleting Q1 did not warn; order checks missed them) — fixed; grid row × column piping added (item 4). Missing / empty / invalid values render "" (unchanged); preview and runtime share `resolvePiping` and `questionTextTemplate`. |
| 4.1 | Ternary question text | Missing | Fixed | `question.dynamicText.expression`; nested ternaries; `Q1 == "A"` by code or label; result may pipe; static text is the fallback; renderer, conversational runner and simulator all use `questionTextTemplate` |
| 4.2 | Ternary options | Missing | Fixed | `question.dynamicOptions.expression` (codes shown) and `option.labelExpression`; codes never change; hidden options are out of the effective list, so validation, data and exports keep one meaning; an empty / unknown set fails open |
| 4.3 | Editor UX | Missing | Fixed | Properties → "Dynamic text & options (ternary)": direct entry, "Build from answers…", live lint (syntax, unknown names, later questions, unknown codes), outcome table per answer; publish lint carries the same problems |
| E1 | Constant Sum "Other specify" | Missing | Fixed | flag offered on allocation options; box under the row once it holds an amount; text never in the total; `selectedOtherCodes` understands an allocation answer, so validation and clean-up work; all constant-sum renderers (central box for slider / chip allocation) |
| E2 | Matrix column logic (Numeric, Mixed, Text, Dropdown) | Partially (engine had column eligibility, no editor) | Fixed | ⑂ per column → Always show / Always hide / Show when / Hide when (the option logic editor); runtime and validation use the effective columns; lint covers column logic; test "Excel 2…" |
| E3 | Open-End family | Partially | Fixed | picker offers four types (Single-Line, Multiple-Line, Essay, Password — new, masked); other text variants stay registered for existing surveys and Intelligent Mode; Validation Rules → Add logic: Minimum length, Maximum length, Character range, Content type (Email, Phone, US state, Postal/ZIP, Date format, Number, Text only, URL), Custom (regex, expression, script, condition, with messages); "Treat the answer as" removed from the open-end main area; builder shows the response field as the type draws it, Pre-Text / Post-Text toggle (position + text), piped starting value with its pipe count; runtime draws the affix, masks a password; tests "Excel 3…" |
| E4 | Grid row + column piping | Partially (row only) | Fixed | `{{Q[r].row}}`, `{{Q[r].pair}}` ("Brand C – Somewhat Familiar"), `{{Q[r:c]}}`; picker: question → row → column; unanswered → ""; test "grid piping…" |
| E5 | Piping in the Calculation Builder | Partially (references typed by hand) | Fixed | "⤓ Piping" on every calculation: question answers and every stored value (option indicators, grid rows / cells, constant-sum amounts), embedded data, calculations, inserted at the cursor as calc references |
| 6 | Intelligent Mode | Missing | Fixed | `split_branch`, `rename_branch`, `add_block_to_branch`, `set_dynamic_text`, `set_dynamic_options` through the action gate on the same engine functions; `create_branch` names its branch; guide `flowLogicGuide.ts` sent for branch / dynamic-text requests (system prompt unchanged, under its cap); every guide example applied by the engine in a test |

## Verification
Typecheck (22 workspaces). Engine 2757, studio lib 1172, import 100, templates 125, quality 102, analytics 410,
runtime 112, schema 18 — 0 failing. `pnpm audit:code` clean. Studio and runtime `next build` clean.
