# P0-2 — Intelligent Mode × Style Animation Scripts, CSS/JS execution, and List Fill (2026-10-16)

Evidence first: every root cause below comes from the production operations log (`intelligent_operations`,
survey "CGP Protest & 2029 Elections") after the first P0 fix was deployed, reproduced in the live runtime,
and covered by a regression test.

## Root causes — Style Animation Scripts

| # | What happened (log) | Root cause | Fix |
|---|---|---|---|
| 1 | 21:25 — "popup on Q1 when it opens; on Q2 Yes, 'you are eligible to proceed'": the model wrote `create_behavior` with `on: "appear"` / `on: "select_option", options: ["1"]` **and** a `script`. All refused ("has both a script and effects"); a repair call refused the same way — **two paid calls, nothing applied**. | A behaviour was *either* effects-on-an-event *or* a script. The natural, unambiguous "run this script when option 1 is selected" had no representation. | `scriptOnEvent` (engine `uxActions.ts`): the event wraps the script deterministically — `rs.listen("select", "self", function (e) { if (["1"].indexOf(String(e.option)) < 0) return; … })`; `appear`/`page_enter` run it on page open. Stored as ordinary script (visible/editable), same sandbox and gate. No model call. |
| 2 | 21:23 — "javascript … popup when age is 18+": the model correctly proposed `set_validation` (min 18) + a script. The validation was **refused** ("look and behaviour only"), and the model's memory then said it had been set. | Look-only was *inferred* from the words ("javascript", "popup") and refused every structural action — including the validation the UX guide tells the model to use to stop a respondent. | `uxOnlyInferred`: when look-only is only inferred, `set_validation` is allowed (engine `applySurveyActions`, Studio route, and the browser's replay on Apply); an explicit "don't change the logic / only the UI" still refuses it. The turn's memory now appends what the Studio refused (`memoryWithRefusals`). |
| 3 | A script's popup in the Studio's card preview covered the **whole Studio** (blocked clicks; for ever if it never dismissed). | Survey scripts run in the Studio preview on the Studio page; `document.body` mapped to the Studio's body. | `DomBridge({ contain })` / `UxLayer contained`: in the Studio preview what a script adds to `body` goes into the survey shell, and the shell is the containing block for fixed elements. The respondent's survey is unchanged. |
| 4 | Every script that touched `document.body` logged "a script cannot create a `<script>` element". | The sandbox's own bootstrap `<script>` lives in its `<body>`; the mutation mirror serialised it as if the survey script had created it. | `uxSandbox.ts` skips the frame's own `<script>`. False diagnostics gone (asserted: no `[rescript:script]` lines). |
| 5 | Popups injected `<style>@keyframes…</style>` into `document.head` and animated with `animation:rsFadeIn` — silently nothing. | The sandbox drops `<style>`/`<link>` and `head`; nothing said so before it was applied. | Authoring checks refuse `<style>`/`<link>`/`<script>` creation, `document.head`, and inline animations naming keyframes that do not exist — with the fix (create_style / create_animation / rs.animate / transitions). |
| 6 | Scripts naming `[data-qid="Q3"]` (the code), option codes that do not exist. | The model had the hooks in general but not the question's own. | `questionHooks` in every UX turn's outline (card, answer box, options by code, rows, cells, page); authoring checks verify the ids and codes a selector names. A `when` on a script (ignored at runtime) is refused with the alternative. |

Cost safeguards: deterministic correction instead of a second call (1); no repair call when every refusal is a
policy one (said look-only, enforced research design); a repair returns **only** the corrections, merged once
with the accepted actions (no regenerating 60-line scripts that were fine); one repair at most, never a loop;
generated scripts are labelled "checked … not run yet — try it in Preview".

## List Fill

Root cause: Intelligent Mode had **no List Fill action**, so List Fill requests became masks with invented
expressions (2026-10-14: "brands rated familiar or better in Q37 → Q38, 4 at random when more than 5, Apple
always first" became `set_mask "Q37.Selected where (@option.rating >= 3) UNION {Apple}"`).

Full audit: `docs/LIST-FILL-AUDIT-2026-10-16.md`. Added `create_list_fill` / `update_list_fill` /
`remove_list_fill` (engine `listFillActions.ts`), the List Fill guide sent with List Fill requests
(`listFillGuide.ts`, English/Hinglish/Devanagari), and fixed: grid sources read the scale instead of the rows;
allocation went stale after Back (now re-decided when it differs); "more than 5 → 4" (`count.allUpTo`); export
dictionary width; the panel's "add every option" on a grid.

## Verification (real runtime, not code inspection)

- `scripts/style-script-p0-test.mjs` (12 checks): the model's real 21:23/21:25 answers through Intelligent
  Mode → applied → live runtime: CSS on Q2 only; Yes → one popup, No → none; pulse on select; Q1 popup once
  per visit (Next → Back → no accumulation); 17 stopped by validation, 25 → popup; survey completes; popups stay
  inside the Studio preview; `<style>`-in-head refused on the card; memory says NOT APPLIED; no false diagnostics.
- `scripts/listfill-intelligent-test.mjs` (9 checks): the field request → `create_list_fill` → runtime: 2 rated
  → both, Apple first; 7 → exactly 4, Apple on top, no duplicates; re-rated → follows; 5 → all 5; Apple
  unrated → not forced; none → Q38 skipped; rated again → back.
- Unit: engine 1,976 (scriptAuthoring +5, listFillActions +25, listFill +4), Studio lib 554, all packages
  green; typecheck clean; auth-guard and dependency audits clean; public docs current.
- Regression browser suites: listfill, age-script-p0, ux-script-dom, ux-copilot, copilot, copilot-errors,
  intelligent-mode, intelligent-runtime, matrix-a11y, validation-kinds, properties-accordion, canvas,
  codes-sync, master-demo, data-export, maxdiff-variants, p0-runtime-contract — all green.

## Remaining limits

- A sample-counted List Fill (per-item caps) keeps its first allocation when a respondent goes Back and changes
  the source — the database claim is idempotent; a per-list release needs a new SQL function (not written:
  no Postgres here to test it). Lists Intelligent Mode creates are not sample-counted unless caps are asked for.
- The database allocator (`rescript_allocate_listfill`) path was not exercised in this sandbox.
- A script can still be valid and wrong in its logic; the card says it has not run, and the preview inspector
  shows what the sandbox refused or could not find.
