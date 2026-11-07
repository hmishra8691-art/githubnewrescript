# Survey programming audit (2026-11-07) — patch 0092

Full report: the Claude Doc "Survey Programming Audit — 2026-11-07". Executed, not inferred:

- `scripts/programming-audit.mjs` — 57 engine checks: whole surveys built as a programmer / Intelligent Mode builds
  them, walked by simulated respondents through the runtime functions, replayed by the server's `checkSubmission`.
- `scripts/programming-audit-browser.mjs` — 17 checks in the built runtime (`RUNTIME_URL`, default :3001): every
  variant rendered at 1280 / 390 px, a multi-block survey clicked through and compared with the engine page for page,
  numbering / lettering / auto-advance.

## Defects found and fixed
1. Ternary `Q2 == "Apple"` never matched a carried-forward Q2 (labels now follow the carry-forward chain).
2. The simulated respondent (production-like test, IM simulation) ignored validation rules and field types — correct
   surveys were reported blocked (essay min length, min_value, date-time, weekday calendar, date range, forms).
3. The simulator did not record display orders (ORDER_…) as the Runner and server replay do.
4. New choice questions from the picker had no options (`withStarterOptions`).
5. A preset sample referenced a question "Q1".
6. Single / Multi / Dropdown matrices arrived with no scale; lint did not catch it (scale seeded, lint error added).
7. Mixed matrix arrived with no rows or columns; lint did not catch it.
8. Image choices were not operable by keyboard / screen reader (role, aria-checked, focus, Enter / Space).
9. Click-to-rank pool items were not keyboard operable.
10. A reload restarted a timed page's clock (arrival kept in `TIMER_<PAGE>_ARRIVED`; a reload / resume continues).

## Added
Question numbers (code / sequence), option lettering, auto-advance on single-choice pages —
`branding.layout.questionNumbers | optionNumbering | autoAdvance`; Branding panel; Intelligent Mode via set_theme.

## Open
The option export value field (schema) is not editable and not used by exports (Low).

## Verification
Typecheck clean; engine 2757, studio 1172, runtime 113, templates 125, import 100, quality 102, analytics 410,
renderer 12, schema 18 — 0 failing; audit:code clean; studio and runtime builds clean; both harnesses green.

## Follow-up phases (patches 0093–0094)
- **0093 — auto-next + answer × option grid.** `autoNextKind/autoNextReady` (engine): single-answer questions advance
  on click; multi-selects, open answers, sliders, rankings wait; grids wait for every row; a page of several singles
  advances after the last; other-specify waits. Survey default (`branding.layout.autoAdvance`) + per-question
  `settings.autoNext`; Studio controls; IM via update_question / set_theme. Ternary option text fixed (compares by
  code) and the **option-text-by-answer grid** (`dynamicGrid`, `compileDynamicGrid`, Studio grid editor, IM
  `set_dynamic_options … grid`).
- **0094 — paths, library, export values, CI.**
  - Respondent-path explorer (`explorePaths` / `summarizePaths`, templates): reach per flow element and branch path,
    endings, top routes, never-reached, validation blocks. `comparePaths`: where two answer sets part, pages only one
    sees, piped text / options that differ. Studio Flow › **Paths**; IM "who goes where?" / "show me the paths"
    → production-like test card with routes and never-reached.
  - Library insert (`importQuestions`, engine): copy pages / questions from any project as a new block — fresh ids,
    colliding codes renamed, rules between copies follow, piping follows, rules naming uncopied questions removed and
    listed. Studio Questions › "From another survey".
  - Option export value: editable in the option list ("Export values" toggle); `VariableDef.exportValues`; new export
    mode "Export values" (CSV / Excel / JSON). Closes the audit's open Low item.
  - Hotspot click question operable by keyboard (arrow-key marker, Enter places, Backspace removes) — found by the
    browser harness once image types got sample content.
  - CI: `.github/workflows/programming-audit.yml` runs both harnesses on every push.
  - Guide: `docs/JQUERY-AND-CUSTOM-JS-MIGRATION-2026-11-07.md`.
- Verification (0094): engine 2765, studio 1172, runtime 113, templates 127, exporters 149, analytics 410, import 100,
  quality 102, renderer 12, schema 18 — 0 failing; audit:code clean; studio + runtime builds clean; engine harness
  59/59; browser harness 23/23 (hotspot / annotation now checked with a sample image).
