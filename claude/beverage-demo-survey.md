# Beverage Habits 2026 — a demo survey for Rescript Studio

`BEVERAGE_MASKING_DEMO_v1.json` — 45 questions, 18 masks, 6 punch rules, 16
validation rules, 6 custom scripts, 10 calculations, one List Fill, three
quotas, 12 flow nodes. No conjoint, no MaxDiff.

Import it as a survey definition, or hand it to the runtime preview
(`postMessage({type:"rescript:preview", definition})`).

## Every masking scenario the set engine supports

| # | Question | Set expression | Action |
|---|---|---|---|
| 1 | Q2 Usage | `Q1.Selected` | display (+ `keepAlwaysShow`) |
| 2 | Q3 Consideration | `Q1.Selected DIFFERENCE Q2.Selected` | display |
| 3 | Q4 Repertoire | `(Q2.Selected UNION Q3.Selected) INTERSECTION Q1.Selected` | display |
| 4 | Q5 Rejected | `Q2.Unselected` | display |
| 5 | Q6 Unaware | `NOT (Q1.Selected)` | display |
| 6 | Q7 Premium | `[1,5,8,10] INTERSECTION Q2.Selected` | display, `onEmptySource: show_all` |
| 7 | Q8 Favourite | `Q2.Selected` | display — **not** preselect, see below |
| 8 | Q9 Buy again | `Q2.Selected` | **disable** (greys out, does not hide) |
| 9 | Q10 New to you | `Q2.Selected` | **remove** |
| 10 | Q11 Heavy only | `Q2.Selected`, gated by `when` | display, conditional |
| 11 | Q12 Segment | calculated `expr` | **display_and_preselect** |
| 12 | Q13 Allocated | `listFill: lf_brand_eval` | display |
| 13 | Q14 Grid | `Q2.Selected` | **rowMask** |
| 14/15 | Q15 Composite | rows from `Q2.Selected`, columns from a code list | **rowMask + columnMask** |
| 16 | Q16 Allocation | `Q2.Selected` | display |
| 17 | Q17 Ranking | `Q2.Selected` | display |
| 18 | L3 Attributes | `loopItem: WrongFormat` | **remove**, loop-scoped |

Top-N is not a mask kind — Q18 does it with an `optionPipeline` filter over
the ranking; Q19 uses `randomize` with `pick: 5`; Q20 uses carry-forward.

## Three things the survey demonstrates by NOT doing them

**A reference column is one scalar, so a comma-separated one fed to a mask is
one code that matches nothing.** L3 narrows twice: the MASK reads
`WrongFormat` (a single code) and removes it; the FILTER reads `Attributes`
(comma-separated) per option with `contains` + `{$option: "code"}`. The
"None of these" option carries `logic.visibility: "always_show"` so the
filter cannot take it.

**`display_and_preselect` pre-ticks the FIRST code the set produced.** On Q8
that would have answered "which is your favourite" for the respondent. It is
used only on Q12, where the set is one code by construction. The engine now
warns when this is put on a single-answer question with a plural set.

**A validation floor above the screener traps the people it is meant to screen
out.** Q_AGE accepts 13+; the 18+ rule is a branch. With `min_value: 18` the
under-18 branch can never fire — a 15-year-old sits on the page forever.

## Flow and redirects

```
embedded data → Consent block → consent gate → About-you block
  → eligibility gate → quota check → brand funnel (9 pages)
  → list fill → LOOP (1 block, 2 pages, 5 questions, per brand)
  → randomizer (3 closing blocks) → derived/punched → complete
```

Each gate sits immediately after the page that decides it, so a screened-out
respondent never sees the next question.

- **Screen out** → `https://www.google.com/?rs=<reason>&pid={{ed.PANEL_ID}}&wave={{ed.WAVE}}`
  (three reasons: `no_consent`, `under_18`, `non_category`; a fourth,
  `quota_full`, on the quota node)
- **Complete** → `https://miures.com/?rs=complete&pid={{ed.PANEL_ID}}&wave={{ed.WAVE}}&seg={{calc.TECH_SEGMENT}}`

## List fill

`lf_brand_eval` allocates 1–3 brands with `priority_quota`, respecting both
hard quotas, with per-option targets and maxima, one option gated by age, and
`fillToCount`. Its source is a hidden question written by a custom script
(the punch), ordered by the respondent's own ranking. It drives three
destination questions, the Q13 mask, and the loop.

Its variables pipe as **bare** tokens — `{{LISTFILL_BRAND_EVAL_LABELS}}`, not
`{{calc....}}`: List Fill writes into `state.calculated` without being a
`calculations` entry.

## The loop

One block, two pages, five questions, once per allocated brand. Piping:
`{{loop.label}}`, `{{loop.Category}}`, `{{LOOP_INDEX}}`, `{{LOOP_COUNT}}`,
`{{CURRENT_ITEM_CODE}}`. Reference columns `Category`, `Attributes`,
`WrongFormat`, `Premium`. Aggregates `AVG_RATING` and `N_RATED`.

## Custom code

Six scripts: `on_load` (stamp the build, normalise the sample source),
`on_change` on Q_FREQUENCY and on the loop's rating, `on_submit` on
`p_brand_depth` (**the punch** — computes the list-fill source set and writes
it onto a hidden question), `on_validate` on `p_spend` (two cross-question
checks), `on_complete` (mean NPS across iterations).

Six declarative punch rules: an if / else-if / else chain, a mapped punch
(brand → owner group), a `set_value` from a calculated expression, and a
`targetRow` punch into one grid cell.

## Custom CSS

`branding.customCss` plus per-question `customCss` on Q2 and L1. Every
selector was taken from the runtime's markup — `.rs-card[data-qid]`,
`.rs-qtext`, `.rs-qinstruction`, `.rs-option` + `.selected` / `.disabled`,
`.rs-matrix`, `.rs-alloc-total` + `.ok` / `.bad`, `.rs-error-msg`,
`.rs-progress-fill` — and verified against computed styles in a browser.

Per-question `customCss` is injected **raw and unscoped**, so both blocks
scope themselves with `[data-qid="..."]`.

`branding.customJs` runs **once per session at load, with no arguments**,
before the first page exists — so it installs a MutationObserver that
publishes the on-screen question count as `data-bev-questions` on the shell.

## Verified

Harnesses are in the same folder.

- `validate.mjs` — parses against the real `SurveyDefinition` zod schema, and
  proves no key was silently stripped
- `lint.mjs` — 16 lint passes, all clean
- `walk.mjs` — 4 headless runs: every mask asserted against expected codes,
  the list fill, the loop, both redirects, `onEmptySource` fallbacks
- `validation.mjs` — 22 validation cases plus the script-level checks
- `render-demo.mjs` / `render-screenout.mjs` — real browser, real runtime:
  computed styles, greyed options, masked grid rows, the allocation total
  turning red then green, three loop passes, and all four redirect paths
