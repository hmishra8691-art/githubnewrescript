# Intelligent Mode — final end-to-end audit

*Intelligent Mode upgrade, Phase 7. 2026-10-06. It closes the brief "Intelligent Mode Complete Audit, Engine Integration & Intelligent Research Suite Upgrade". It audits the result against the Phase 1 audit (INTELLIGENT-MODE-AUDIT-2026-10-05.md), gives the brief's §27 test matrix, and verifies that what Intelligent mode applies reaches the runtime.*

## The pipeline, as it now runs

```
sentence ─▶ engine: interpretRequest (nlIntent, nlTargets, naturalCondition)
              ├─ actions ─▶ applySurveyActions on a clone
              │               validateActionOutcome · impactOf · plan review · translation pruning/moves
              │               ─▶ changeItems tree ─▶ Changes review (select / exclude, hover, dependents)
              │               ─▶ Apply ─▶ store ─▶ draft save ─▶ "APPLIED · SAVED" only when the save returned
              │                                   └▶ preview window (250 ms push) · Test Survey (flush → version → deploy)
              ├─ answer  (dependencies, impact, "why this analysis", sample size) — no model call
              ├─ clarify (two candidates fit) · refused (did-you-mean + a checked fix)
              ├─ defer:grammar ─▶ grammar proposal applied to a copy first
              └─ model (rewording, translation, open requests) ─▶ the same closed vocabulary, the same review
every turn ─▶ intelligent_operations (0047): intent, targets, proposed/applied/excluded/refused, warnings,
              engine ops, model calls, before/after, status ─▶ History: view · compare · restore · reapply
```

## The root causes, one by one

| | Root cause (Phase 1) | Now | Where |
|---|---|---|---|
| R1 | Two unconnected action vocabularies | The engine's interpreter emits the copilot's `SurveyAction` vocabulary. The grammar runs only on `defer:grammar`, and its proposals are reviewed, recorded and numbered the same way. | Phase 3, 5 |
| R2 | The cloud goes first | The engine reads every sentence first. The model is asked only when the engine hands over. | Phase 3 |
| R3 | One sentence charged twice | An unusable copilot reply falls through to the grammar, not to a second model. `/api/ai/logic` is asked only when there is no copilot: one sentence, one model call at most. | Phase 3 |
| R4 | The deterministic planner lives in the app | Interpretation is in `@rescript/engine`. `proposal.ts` delegates normalisation to it. | Phase 3 |
| R5 | Validation post-hoc and demoted | `validateActionOutcome` blocks forward references, type/operator mismatches, stale codes and cycles before a batch is accepted. | Phase 2 |
| R6 | The parser accepts silent nonsense | Unresolvable words are refused. "over/under/older than" are comparators. Strings against numeric sources are refused. | Phase 2–3 |
| R7 | Code-referenced conditions skip canonicalisation | `ref` by code or id is canonicalised the same way. | Phase 2 |
| R8 | Renames and removals do not propagate | Renames go through `applyRename`. Option removals and recodes rewrite or warn on every comparison. Moves are diffed (LCS). | Phase 2 |
| R9 | Impact computed and thrown away | `impactOf` / `impactOfAction` go to the review and to "what will break if…". | Phase 2, 4 |
| R10 | The index knows no analysis or translation | Analysis, construct and translation edges in `dependencyIndex`. | Phase 2 |
| R11 | False success | Apply records "applied", then waits for the save: *saved*, *not saved — reason* (with retry), or *sandbox*. Verified again here against a delayed server. | Phase 5, 7 |
| R12 | History page-lifetime only | `intelligent_operations` (applied, RLS), numbered by the server across sessions. View, compare, restore and reapply. | Phase 5 |
| R13 | Flat, all-or-nothing review | A survey → block → question → option tree, per-change selection, partial apply, refusals caused by an exclusion, statuses. | Phase 4 |
| R14 | Horizontal scrolling | The tab strip wraps, and tables are fixed-layout with wrapping. Asserted in the browser suites. | Phase 4 |
| R15 | No option-level selection or context | The option panel with hover previews, context actions per selected object, and a signalled dependency view. | Phase 4 |
| R16 | No suggested fixes | Did-you-mean with a checked, previewable fix. Ambiguity becomes a choice. | Phase 2–4 |
| R17 | No sample size or explanation in analysis | `explainPlanItem`, required bases, expected sample, the sample-size review. Derived variables and segments are computed. | Phase 6 |
| R18 | Verdicts ignore direction | Direction-aware verdicts, with opposite-direction results reported. | Phase 6 |
| R19 | Three placeholder regexes, orphans, no wrong-language check | One grammar (`placeholders.ts`), orphans pruned or moved, wrong-script detection, per-language impact. | Phase 6 |
| R20 | A failed grammar proposal consumes an undo step | Applied to a copy first, written only when clean. A half-applied batch cannot be committed. | Phase 5 |
| R21 | Store undo invisible to history | ⌘Z / ⌘⇧Z mark entries reverted / applied. Comparison is canonical. | Phase 5 |

## Runtime verification

`scripts/intelligent-runtime-test.mjs` (new, 9 checks) drives the real Studio and the real runtime:

- **The Studio's Preview window** is opened once with the Preview button and never re-opened. It follows each engine change within the push: a question's text; an option relabelled, recoded (the window draws the new code) and added; a question deleted, then restored from History; display logic across pages, answered in the window (No goes past the hidden question). None of these called a model route.
- **Translation through a change:** German is added through the model (fake provider), then the engine recodes an option. The runtime at `?lang=de` shows the German label on the new code, and the old key is gone.
- **Saved surveys:** against a server that takes 400 ms to save, the card reads `APPLIED · SAVED` only after the draft with the change was received. Test Survey cuts and deploys a version carrying the change, and that version, run in the runtime, enforces it (a required question keeps the respondent on the page).

The suite was mutation-checked against the product: the live push removed, Restore not reverting, and "saved" claimed before the save returned are each caught. A recode that does not move its translations is **not** caught by this suite, by design. The batch's orphan pruning re-homes a translation whose source text matches exactly one new element, so the two mechanisms back each other up in the common case. The explicit move matters when the label is ambiguous or outdated, and there the engine's unit tests catch the mutation.

Already in place and re-run: `codes-sync-test` (Intelligent-mode logic, code and theme, then the runtime), `test-survey-sync-test` (save → version → deploy → test link), `packages/engine/src/testBuild.test.ts` (a test link resolves to the latest saved draft and never falls back).

## The §27 test matrix

Unit counts are test blocks. Browser counts are checks. "Mutation" names where each area was mutation-checked; each phase doc gives the tallies.

| Area | Unit | Browser | Mutation |
|---|---|---|---|
| Question operations | `surveyActions` 22, `actionValidation` 28, `nlIntent` 49 | `engine-first` 9, `intelligent-mode` 55, `copilot` 11, `intelligent-runtime` 9 | Phase 2 (196 mutations, survivors closed or documented), Phase 3 (99) |
| Option operations | `optionActions` 20, `optionCodes` 11, `changeItems` 26 | `change-review` 11 (option tree, hover), `intelligent-runtime` (relabel, recode, add) | Phase 2, Phase 4 (37), Phase 7 |
| Logic | `logicExpression` 35, `naturalCondition` 7, `nlTargets` 8 | `engine-first` (skip, AND, mask, anchored randomisation), `codes-sync` 12, `intelligent-runtime` (display logic answered) | Phase 2–4 |
| Dependencies and impact | `dependencyIndex` 18, `impact` 21, `contextActions` 5 | `engine-first` ("what will break"), `change-review` (dependency view, context actions) | Phase 2, 4, 6 |
| Translation | `placeholders` 13, `localization` 11, `localizationActions` 5, ai `translation` 7 | `translation-copilot` 11, `intelligent-runtime` (recode keeps German) | Phase 6, Phase 7 |
| Analysis and findings | `analysisExplain` 22, `analysisFramework` 9, analytics `findings` 9, `planBridge` 6 | `analysis-framework` 9, `findings-copilot` 7 | Phase 6 |
| History and state | Studio `operations` 18, `review` 11, `copilot` 19 | `history` 8, `mode-sync` 13 | Phase 5 (22) |
| Runtime | `testBuild` 12 | `intelligent-runtime` 9, `codes-sync` 12, `test-survey-sync` 9 | Phase 7 (3/4 caught; 1 covered by unit, reason above) |

Totals at the end of the brief: engine 1649, analytics 130, ai 27, Studio unit 253, Studio typecheck clean, auth-guard audit 0 problems (164 handlers).

## The whole browser corpus

All 125 browser suites were run against the sandbox (studio with the fake provider, runtime), restarting the servers every four suites: **113 pass, 12 fail**. None of the 12 is caused by this brief:

- **7 failed identically in the last full run before the brief (2026-10-04)**, with the same first assertion: billing, dashboard-outage, p0-runtime-contract, picker-taxonomy, qa-fixes, quality and tester-fixes. These are expectations that predate the brief.
- **4 need a local Postgres driver and database** this sandbox does not have (`pg`): auth-collaboration and version-scoped-export (failing the same way on 2026-10-04), plus listfill-allocation and lock-concurrency (not in that run).
- **ai-conversation is intermittent:** in standalone runs it passed 1 of 3 at HEAD. With the engine, schema and ai packages rolled back to before the brief (7072a96) it passed 0 of 3, so the brief did not cause it. It times out waiting for the second voice "next" to raise the adaptive follow-up. The runtime and renderer were not changed by the brief.

Two suites that failed on 2026-10-04 pass now: distribution-test, and the auth-guard audit (fixed in Phase 5).

## Architecture rules, checked

- `@rescript/engine` imports only `@rescript/schema`: no `fetch`, `process.env` or `node:`, and no analytics/ai import (re-checked: 239 imports, all `@rescript/schema`).
- Every Studio handler starts with its guard. The audit reports 0 problems.
- No key is read or handled outside the environment. The service role is never used from this workspace.
- Migration 0047 is applied and recorded. It is the only schema change of the brief.

## What remains

- Grid rows and columns have no hover preview. An option selected in the panel is the panel's selection, not the Studio-wide one (Phase 4).
- The database half of the operations store has been verified against the table's constraints, not through PostgREST here. After a reload, an entry lists what was applied, without Created / Modified / Removed. ⌘Z is observed while Intelligent mode is open (Phase 5).
- The contradiction check can warn falsely on reads covering several cells, and does not examine text, dates or multi-selects (Phase 2).
- Required bases are rules of thumb with sources, not power calculations. A result with no readable direction counts towards support and says so. Script detection covers the major scripts (Phase 6).
- The engine does not reword or translate. Those remain the model's work, under the same review and checks.

## Before deploying

- `git push` the phase commits (aea15c7 … this one).
- Set `CRON_SECRET` for the analysis-runs scheduler route (Phase 5 moved its check into each handler).
