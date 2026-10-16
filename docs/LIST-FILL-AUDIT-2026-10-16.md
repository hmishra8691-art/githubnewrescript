# List Fill — end-to-end audit (P0, 2026-10-16)

Trigger: production log 2026-10-14 (Hindi, translated). "Q37 grid: 10 brands × familiarity 1–5. Brands rated 3–5 go to Q38 (ranking). More than 5 qualify → randomly assign 4. Apple always on top: in the four when it qualifies, otherwise priority to Apple." Intelligent Mode had no List Fill action, so the model wrote `set_mask` with an invented expression (`Q37.Selected where (@option.rating >= 3) UNION {Apple}`), and the user corrected it twice.

Prior notes read: `docs/audit-2026-10-16/raw/methodologies.md` (METHOD-09…12), `05-methodology-matrix.md`.

## 1. How it works (what was verified)

| Stage | Where | Status |
|---|---|---|
| Schema: `def.listFills[]`, source / selection / tracking / options / destinations / runWhen | `packages/schema/src/listFill.ts` | OK |
| Decision: candidates → eligibility (`eligible`, per-option `eligibleWhen`) → capacity → quota → priority bands → method → fallback; deterministic per respondent seed | `packages/engine/src/listFill.ts` `decideListFill` (:375) | OK — no duplicates (dedup of the pool + `already_selected`), labels from the source |
| Variables `LISTFILL_<NAME>_COUNT/_n/_n_CODE/_n_POSITION/_CODES/_LABELS` in `state.calculated` | `listFillVariables` (:829) | OK; exported via `flatten.ts:160` |
| How a destination SHOWS the items | three mechanisms: (a) a question's **mask** `LISTFILL(<name>)` (`setExpression.ts:113`, read-only via `listFillLoopItems`) filters its options/rows in the question's own order; (b) `destinations[].write:"answer"` writes position n's code as that question's answer (`applyListFillDestinations` :912); (c) piping `{{LISTFILL_<NAME>_n}}` | OK. (a) is the only way to "show N brands in a ranking"; the native `destinations` are one item per question |
| Empty list → `whenUnused` | `pendingListFills` (:997) + `listFillSourceSettled`; `listFillHiddenDestinations` (:977) used by `flow.ts` | OK since METHOD-09 fix; still open when `runWhen` is false (list never runs → destination not hidden) |
| Runtime: preview | `apps/runtime/components/Runner.tsx:307` — same pure engine in the browser, no counters | OK |
| Runtime: test / live | `apps/runtime/app/api/session/listfill/route.ts` — server decides with the pinned definition; `rescript_allocate_listfill` claims atomically only when `tracking.sampleLevel` | OK (DB claim not exercised here: `scripts/listfill-allocation-test.mjs` needs Postgres) |
| Templates simulator | `packages/templates/src/simulate.ts:253` — same `pendingListFills → decide → variables → destinations` sequence | OK, 109/109 |
| Studio panel | `apps/studio/components/studio/ListFillPanel.tsx` | configure / simulate / dashboard OK; see §3 |
| Loops over a List Fill | `loops.ts` `listFill` source → `listFillLoopItems` | OK (code read) |

Source kinds × question types as a source (engine, after the fixes below):

| Source | Works | Notes |
|---|---|---|
| single select | yes | one candidate |
| multi select / multi dropdown | yes | `selected` keeps the respondent's order |
| ranking | yes | candidates in rank order; `selection_order` = top N by rank |
| grid (matrix single) with a value rule | **yes (fixed)** | items are the ROWS; rule = per-row `eligibleWhen` `{source:{ref:grid,rowCode}, gte/lte/between/in}` |
| grid (matrix multi) | yes with `answers` (`containsAny`) | no single value for ≥ |
| carry-forward question | yes | labels now borrowed from the carried list |
| static / embedded / calculation / another List Fill | yes | calc/embedded: codes only, labels = codes |
| script | **no** | reads `state.calculated[scriptId]`; nothing runs the script (METHOD-12) |

## 2. Broken → fixed (with tests)

| # | Defect | Evidence (before) | Fix |
|---|---|---|---|
| F1 | **Intelligent Mode could not create a List Fill** → requests became invented masks | no op in `SURVEY_ACTION_OPS` | new `packages/engine/src/listFillActions.ts` (`create_list_fill`, `update_list_fill`, `remove_list_fill`), wired in `surveyActions.ts`; guide + intent in `apps/studio/lib/copilot/listFillGuide.ts` |
| F2 | **Grid source read the scale, not the rows**: `take:"all"`/`"displayed"` returned scale points; a selected row was labelled from `q.options` (row "1" → "Never heard of"); unanswered (null) rows counted as selected; order = answer-object key order | `listFill.ts` question case (old :207-217) | rows via `carrySourceRows` / `effectiveQuestion().rows`, answered rows only, in row order; `listFillItemsAreRows` exported (`listFill.ts:14, 193`) |
| F3 | **Stale allocation after Back**: "allocated once" (count var present → never re-run). Re-rating Q37 left Q38 showing the old brands | `pendingListFills` old :931 | `listFillIsStale` (:1035): a list that does NOT claim sample capacity is re-decided when a fresh decision differs from the stored `_CODES` (same seed → an unchanged source reproduces it, so no churn). Sample-level lists keep allocate-once (DB claim is idempotent) |
| F4 | Re-decided shorter list left `LISTFILL_X_3/_4…` behind (stale piping) | — | `applyListFillDestinations` clears positions beyond the new count (all three callers run it after assigning variables) |
| F5 | "More than 5 → 4" not expressible (count was a fixed n) | schema | additive `count.allUpTo` (`schema/listFill.ts`): ≤ allUpTo eligible → all of them, else n (`decideListFill`) |
| F6 | Dictionary declared ONE column for an unconfigured `count:"all"` list; dictionary labels for a grid source came from the scale | `maxItems` / `variables.ts:858` | `maxItems(lf, def)` / `listFillVariableNames(lf, def)` bound by the source size; callers in `variables.ts`, `loops.ts`, `lintLogic.ts` pass `def`; labels from rows |
| F7 | Panel "add every option from the source" added the scale points of a grid | `ListFillPanel.tsx:105` | uses rows for a grid |
| F8 | Public actions reference lacked the ops | `publicDocs.test` | `scripts/lib/publicDocs.mjs` "List Fill" group; regenerated |

## 3. Still broken / unsupported (not fixed here)

| # | Item | Status / why not now |
|---|---|---|
| U1 | METHOD-10 — no reconcile of claims held by abandoned sessions | unchanged (needs a cron + SQL) |
| U2 | METHOD-11 — `afterMaximum`, `fallback`, `fillToCount`, `allowDuplicates`, `weighted` stored but inert; Panel still exposes `fallback` | unchanged; the **actions refuse** them with the reason |
| U3 | METHOD-12 — `count.kind:"expression"`, `source.kind:"script"`, `method:"custom"` schema-only | unchanged; actions refuse |
| U4 | `repeatBlockId` is read by nothing but the dependency index — no block repeats | actions refuse; use a loop over `LISTFILL(<name>)` |
| U5 | Sample-level list + respondent changes the source after the claim → keeps the old items | by design of the idempotent claim; a proper fix needs a per-list release (`rescript_release_listfill` releases ALL lists of a session) and a re-claim |
| U6 | Per-respondent list that respects hard quotas (`respectQuotas` + a hard quota in scope) keeps allocate-once (its result depends on counters the client cannot see). Actions set `respectQuotas:false` for per-respondent lists | documented |
| U7 | A list whose `runWhen` is false never runs → its destinations are not hidden (METHOD-09 remainder) | unchanged |
| U8 | `write:"answer"` destination left holding an old code when a re-decided list is shorter (only `whenUnused:"blank"` clears) | unchanged |
| U9 | A respondent who already RANKED Q38 and then changes Q37: whether the runtime prunes ranked codes no longer displayed was not verified | unverified |
| U10 | A 503 from the allocator → list not run → the destination is visible with an empty mask (`always_show_only`) until the next submit retries | unchanged (Runner.tsx:338) |
| U11 | Quality-check area "List Fill" promises "every List Fill has a source and somewhere to put what it allocates" — no check emits into it (a deleted source question is not flagged) | unchanged; the actions validate at write time |
| U12 | Panel simulator builds a grid answer as an array of row codes, so per-row value rules cannot be exercised there; panel has no field for `allUpTo` | unchanged |
| U13 | The mask shows the items in the DESTINATION's order. "Apple on top" holds when Apple is first in Q38 or via the move-to-top rule the action adds; a destination that randomizes its options shuffles it (action warns) | by design |
| U14 | DB allocator (`0007_list_fill.sql`) not exercised (Postgres) | `scripts/listfill-allocation-test.mjs` |

## 4. The Intelligent Mode actions

```json
{"op":"create_list_fill","name":"BRANDS","source":"Q37","eligible":{"minValue":3},"count":4,"allIfAtMost":5,
 "method":"priority_random","priority":{"Apple":1},"destinations":["Q38"],"whenUnused":"hide"}
```
→ "List Fill BRANDS: from Q37 rows rated 3–5 (Somewhat familiar … Very familiar), 4 items (all of them when 5 or fewer qualify), Apple first when eligible, random among the rest, into Q38 (shown as its options; hidden when nothing qualifies)".

- `source`: code/variable/label of a question · `{question,take}` · `{items:[…]}` · `{listFill}` · `{calculation}` · `{embedded}`.
- `eligible` (grid only): `{minValue}` / `{maxValue}` / `{answers:[codes or labels]}` → one `eligibleWhen` per row. `eligibleWhen:{item: condition}` per item. `eligible.when` is refused (a condition cannot say "this row").
- `count` n | "all" | `{question}`; `allIfAtMost`; `method` (aliases incl. least_fill → balanced_random); `priority` by label or code; `always:[item]` = no eligibility condition + top priority (refused for a multi-select's `selected` list, where an unselected item is not a candidate); `maximum`/`target`/`weight` (caps switch `trackSample` on); `runWhen`.
- `destinations`: a question with options/rows → **show** (mask `LISTFILL(id)` + a `piping_only` position-1 destination carrying `whenUnused`, default hide; codes aligned BY LABEL to the source's codes — e.g. Q38 1…10 → r1…r10 — only when nothing else reads the destination, reported as destructive); otherwise **piping** (position n); `as:"answer"` writes the code.
- Refused with the reason: unknown question/item/scale point; destination before the source or on the same page; a destination lacking an item; `method` that ignores a given priority; allowDuplicates, fillToCount:false, afterMaximum/fallback, custom/script, expression count, repeatBlock, caps with `trackSample:false`, `allIfAtMost` < count.
- `update_list_fill` (partial; `newName` rewrites every `LISTFILL_<OLD>_` reference), `remove_list_fill` (removes the mask/move-to-top it set up; refused while piping, logic or a loop still reads it).
- Every result passes `ListFill.parse`, `validateActionOutcome` (generic action gate) and `lintLoops` (new List-Fill loop findings: errors refuse, warnings travel).

## 5. Tests

- `packages/engine/src/listFillActions.test.ts` (20): the real case end to end (2 / 7 / exactly 5 / Apple not rated / none / Back + re-rate), `always`, multi-select, single-select piping, static, every refusal, update, rename, remove.
- `packages/engine/src/listFill.test.ts` (+4): grid candidates, `allUpTo`, dictionary width, re-decide on change only.
- `apps/studio/lib/copilot/copilot.test.ts` (+2): intent in English/Hinglish/Devanagari; the guide's example applies as written; the op-coverage test now includes the guide.
- Browser: `scripts/listfill-intelligent-test.mjs` (Studio fake provider → apply → runtime preview: rate, Next, Back, re-rate, empty) — **to be run by the orchestrator** (dev servers :3000 / :3001).
