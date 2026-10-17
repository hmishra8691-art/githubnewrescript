# List Fill — LEAST fill audit (2026-10-17)

Engineer L. Scope: the meaning of "LEAST" List Fill, the allocator end to end (engine → runtime route → SQL),
Back/change consistency, the panel's controls, circular dependencies, and an inventory of the other advanced
customisation features. Prior reading: `docs/LIST-FILL.md`, `docs/LIST-FILL-AUDIT-2026-10-16.md`,
`docs/P0-2-INTELLIGENT-MODE-SCRIPTS-AND-LIST-FILL-2026-10-16.md`.

## 1. What "LEAST" means here, and why

The word LEAST appeared nowhere in the code. The candidates were:

| Reading | Exists? | Evidence |
|---|---|---|
| a minimum-selection strategy ("at least N") | yes, but as COUNT, not a method: `count.fixed.n`, `allUpTo`, per-item `minimum` (urgency for `balanced` rules) | `schema/src/listFill.ts` `ListFillCount`, engine `urgency()` (`listFill.ts:162`) |
| **least-filled allocation** (Decipher/Forsta "least fill": the eligible item with the fewest respondents so far, ties random) | **no** | no method ordered by the raw count |
| `balanced_random` | a different thing: ranks by `(target − count) / target`, i.e. distance from a TARGET. With no target every item scores 0.5 and the order is the seeded shuffle — **exactly `random`** (1,000-respondent simulation below: identical counts, draw for draw) | `listFill.ts` `urgency()`; `listFillLeast.test.ts` "balanced_random with no target = random" |
| `quota_aware_random` | "most remaining capacity" — weighted by room under a maximum; uncapped items are all "infinite" → random | `orderCandidates` `capacityOrder` |

**Decision.** In this platform "LEAST" is the market-research least fill, and it was missing. Intelligent Mode
mapped `least_fill` / `least_filled` → `balanced_random` (`listFillActions.ts`, old line 95) — so every
"least fill" a researcher asked for in words ran as plain random unless they also set equal targets. The two are
not interchangeable: least fill needs no target and balances the raw count; balanced-to-target balances shares of
targets (with equal targets the two coincide — S2 below).

Implemented `method: "least_filled"` (additive enum) with `selection.leastFilled`:

| Setting | Values | Testable meaning |
|---|---|---|
| `basis` | `auto` (the cap's counter) · `allocated` (claimed, incl. in progress) · `completed` | which counter is ranked (`listFillBalanceBasis`; the route passes `balanceCounts`) |
| `tieBreak` | `random` (seeded per respondent) · `sequential` (source order) · `priority` (lower number, then random) | order among equal counts; a priority never beats a lower count |
| count / N / allUpTo / min / max / eligibility | unchanged | caps still cap, eligibility applies first |
| scope | per List Fill, per respondent (session) | counters are keyed by list id; one allocation per session per list |

"Started" is not a separate counter: `allocated` is "reached the allocation point", the closest the counters hold.

## 2. Current state — audit table (before the fixes)

| Area | Status | Evidence |
|---|---|---|
| Engine decision: candidates → eligibility → caps → quotas → priority → method → trace | implemented | `decideListFill` |
| Least fill | **missing** | §1; IM alias pointed at `balanced_random` |
| Sample-counted list + Back + changed source | **incorrect** | `listFillIsStale` returned false for `needsAllocation` (old `listFill.ts:1036`); SQL had only release-ALL (`0007:238`). A respondent who de-selected the allocated brand kept being asked about it and kept its slot |
| SQL: release then re-claim the same session | **incorrect** | unique index `(session, list, slot)` included released rows (`0007:72`) → `on conflict do nothing` dropped the row but the counter had moved: repro on PG16 — counter B=2 after two calls, no allocation row |
| SQL: concurrent claims in different preference orders | **incorrect (deadlock)** | claims lock counter rows in PREFERENCE order (`0007:104`, a refused `on conflict … where` still locks). pgbench, 16 clients, [A,B]/[B,A], 2 items: **126 deadlocks, run never finished** (each = a 503 to a respondent) |
| SQL: restore after delete | latent | trigger un-released every released claim (`0007:313`) — would resurrect replaced claims once per-list release exists |
| Runtime route idempotency per page submit | implemented | allocate is idempotent; advisory lock per session+list |
| Answer destination after a shorter re-decision (U8) | **incorrect** | old code left the destination holding the dropped code; export showed it |
| Ranking of the list's items after Back + change (U9) | **incorrect** | `pruneHiddenSelections` skipped `rank_order`; probe: ranking `["B","A"]` kept after the mask changed to C,D |
| `runWhen` false → destinations not hidden (U7) | **incorrect** | list never ran, `whenUnused` never applied |
| Allocation (constant-sum) question as source | **incorrect** | `{A:0,B:60}` → A was "selected" (`Object.keys`) |
| Invalid / stale source codes | **incorrect** | a code not on the source question became an unconfigured, uncapped item in counters and export |
| Circular dependency (list whose source depends on its own output) | **missing** | `detectLogicCycles` is question-only; a destination = source, or `LISTFILL(self)` mask on the source, was not flagged (a self mask is removed by `questionDependencies` `into.delete(q.id)`) |
| Dangling source / destination; same answer written by two lists; duplicate names | **missing** | Quality-check area "List Fill" promised it; nothing emitted (U11) |
| Panel: `fallback` "when nothing is left" | **does (almost) nothing** | the main pass already tries every eligible item with room; fallback pool is empty unless a quota blocked an item at one POSITION; never substitutes. `listFillLeast.test` "fallback never substitutes" (5 rules × 1,000 respondents, identical) |
| Panel: "store the decision trace on each response" | **does nothing** | `storeTrace` read by nothing |
| Panel: equal-priority rule for non-priority methods | **does nothing** | `withinBand` only runs inside `byPriorityBands` |
| Panel: whenUnused "show it disabled" | **does nothing** | no renderer reads `disable` (only the inspector) |
| Panel simulator for a completes-capped list | **incorrect** | simulated against allocated counts, not completed |
| Panel: `allUpTo` | missing | U12 |
| Loops over a List Fill | implemented (respondent scope) | `listFillLoopItems`; flat export positional from loop variables (dropped iterations not exported) |
| Quotas (`respectQuotas`) | implemented for every method incl. least fill | provisional variables + `matchingCells` |
| Intelligent-Mode-created lists | **incorrect for least fill** | alias above |

## 3. Fixes (in impact order)

1. **Least fill** — `least_filled` (schema enum + `LeastFilledSettings`), engine ordering (`listFill.ts:740`),
   `balanceCounts`, panel (method, basis, tie-break, warning without sample counting), IM alias
   `least_fill → least_filled` (a priority becomes `tieBreak: priority`; `always` refused with the reason),
   `balanced` still → `balanced_random` ("furthest below target").
2. **Back + change for sample-counted lists** — `selection.onChange` (`keep_valid` | `redecide` | `freeze`,
   additive), `reconcileListFill` / `listFillRetained` / `countsWithout` (engine), `decideListFill({ retain })`
   (held items first, no capacity re-check — they hold their own slot), route logic moved to
   `apps/runtime/lib/listFillAllocate.ts` (testable with a fake store), new SQL
   `rescript_reallocate_listfill`. A plain Back/Next is never a change (no churn when counters move).
3. **Migration `0061_list_fill_reallocate.sql`** (re-runnable; applied twice on PG16): `release_reason`
   column; unique slot index over ACTIVE claims only; `rescript_allocate_listfill` conflict target fixed and
   leak-proof; `rescript_reallocate_listfill`; `rescript_lock_listfill_rows` — every counter-touching function
   (allocate, reallocate, release, complete) locks its rows in CODE order first → no deadlock; release marks
   `released`; the restore trigger never resurrects a `changed` claim; least-privilege revokes.
4. **Circular / dangling / duplicate lint** — `packages/engine/src/listFillLint.ts`, wired into
   `lintSurveyLogic` (Quality check → List Fill) and shown on the panel. Cycles through answer destinations,
   `LISTFILL()` masks, own variables in `eligibleWhen`/`runWhen`/count, `listFill` sources, calculations and
   the question dependency graph; the message names every hop.
5. **U8** answer destination cleared when it holds the code the previous list had at that position (a
   respondent's own answer is untouched). **U9** ranking pruned of authored codes the mask took away.
   **U7** a `runWhen`-false list runs to nothing once its source is settled (destinations' `whenUnused` applies;
   it re-decides when the gate opens). Allocation source ignores 0/blank. Unknown source codes ignored.
6. **Panel** — hidden: fallback, storeTrace, equal-priority (unless a priority method), "show it disabled"
   (only shown if already set, labelled unsupported). Added: least-fill settings, "on a changed answer",
   "all of them when at most N qualify", lint chips; simulator uses the cap's counter (completes-only fixed).
   IM actions store `disable`/`terminate_block` as `hide` with a warning.
7. **Preview counters** — `rescript:preview` may carry `listFillCounts` (Runner prop, preview only), so a
   preview and the browser suite can decide against counters.

## 4. Allocation spread — 1,000 respondents (engine + in-memory claim mimicking the SQL)

Sources: each respondent selects brand A with p=.8, B .6, C .5, D .4, E .3, F .2 (exposure A 817 … F 213).
`scratchpad sim.mjs`; the same scenario is asserted in `listFillLeast.test.ts`.

| Scenario | random | balanced_random | quota_aware_random | highest_priority (no priorities) | **least_filled** |
|---|---|---|---|---|---|
| S1 N=1, no targets | 304/215/188/125/83/71 — spread **233** | identical — **233** | 276 | 233 | 165/166/164/164/164/163 — **3** |
| S2 N=1, equal target 170 | 233 | **3** | 276 | 233 | **3** |
| S3 N=2, no targets | 431 | 431 | 474 | 431 | 352/350/350/344/262/213 — 139, every item within 10 of the top or at its exposure (E 262/264, F 213/213) |
| S4 N=1, bursts of 25 deciding on one snapshot | 233 | 233 | 276 | 233 | **17** (herding is bounded by the burst) |

Before the fix "least fill" (via IM) produced the `balanced_random` column; after, the `least_filled` column.

## 5. SQL on real Postgres 16

A scratch cluster with a Supabase shim (roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`,
`storage`) — all 61 migrations apply cleanly; 0061 applied twice.

- `scripts/listfill-reallocate-sql-test.sql` — **19/19**: first claim + reuse; Back + change keeps B, releases A,
  claims C, counters = allocations; unchanged = no write; a released capped slot is claimable by the next
  respondent; a kept code not held is not granted; count shrink; the 0007 leak; delete → restore does not
  resurrect a replaced claim; recount agrees.
- `scripts/listfill-reallocate-concurrency.sh` (pgbench) — 32 clients × 250 mixed re-allocations over 400
  sessions, caps 40/40: 8,000/8,000, caps hold exactly, every counter = its active allocations, no session holds
  two claims, 0 deadlocks; 16 clients × 50 first allocations in crossing orders: **800/800, A=300 B=300, 0
  deadlocks** (before: 126 deadlocks, never finished).
- `scripts/listfill-allocation-test.mjs` (yesterday's) still needs the `pg` npm module, which is not installed
  here (no new dependencies); its scenarios are covered by the two scripts above.

## 6. Tests

- Engine `listFillLeast.test.ts` (20): ordering, ties (random seeded / sequential / priority), eligibility +
  exclusions + caps, basis, no sample counting, 1,000-respondent spread (N=1, N=2, bursts, caps), fallback
  never substitutes, N/all/allUpTo/empty/invalid/duplicates, destination mapping + U8, Back/change reconcile
  (keep/drop/top-up, no churn, held item over its cap), count shrink / runWhen / short with and without room /
  freeze / redecide, per-respondent rule unchanged, circular lint (self destination, self mask, own variable,
  three-list chain vs cycle, normal setup clean), dangling/duplicate lint, IM action, allocation source, U7, U9,
  export after Back/change. `listFillActions.test.ts`: two tests updated to the new contract.
- Runtime `lib/listFillAllocate.test.ts` (5): least fill across respondents through the server path with caps,
  Back + change releases and re-claims (and a plain revisit makes no DB call), kept item not re-claimed, store
  without 0061 keeps the old items, a failed claim is never replaced by the optimistic decision, completes basis.
- Browser `scripts/listfill-least-test.mjs` (to be run by the orchestrator).

## 7. Advanced customisation inventory (Priority 4)

Unit = engine test files (top-level `test(` count); browser = Playwright suites in `scripts/`.

| Feature | Where | Unit | Browser | Defects found |
|---|---|---|---|---|
| Randomized blocks (flow randomizer, `show N`, `evenPresentation`) | `engine/flow.ts:140-200`, schema `flow.ts:286` | flowTree 35, g1–g6 | flow-mode, blocks, flow-dnd | **D1** |
| Question / option / row randomization, anchors | `carryforward.ts` (`effectiveQuestion`), `optionGroups.ts` | rowRandomization 4, optionGroups 37 | masking, option-groups | — |
| Ranking (click/drag/top-N/buckets/tournament) | renderer `QuestionRenderer.tsx:1394`, `bucketRules.ts`, `tournament.ts` | bucketRules 6, pairwiseSet 5 | variants-g*, maxdiff-variants | **D2** (fixed) |
| Allocation / constant sum | renderer `Allocation` (:1457), validate sum | otherAndUnits, octoberValidation | validation-kinds | **D3** (fixed) |
| Quotas & assignment | `quotas.ts`, `quotaActions.ts`, `quotaDashboard.ts`, SQL 0057 | quotaActions 5, quotaDashboard 7 | quota-dashboard, quota-copilot | — |
| List Fill | this document | listFill 47, listFillActions 21, listFillLeast 20 | listfill, listfill-least, listfill-intelligent | fixed above |
| Loops | `loops.ts`, `loopModel.ts`, `flatten.ts:478` | loops 29, loopIntegration 13, loopControlFlow 19 | loop | D7 |
| Piping | `piping.ts`, `pipingTokens.ts` | pipingLint 9, engine 24 | wave*, master-demo | — |
| Embedded data | `embedded.ts` | calcEmbedded 14, embeddedUrl 6 | calc-embedded | — |
| Masking / carry-forward | `setExpression.ts`, `carryforward.ts` | setExpression 54, maskActions 12, carryforward 6 | masking, masking-matrix | D2 |
| Display / skip / branch | `visibility.ts`, `displayRules.ts`, `flow.ts` | displayRules 27, nestedLogicAudit 32, logicTree 34 | logic-builder, nested-logic-audit, logic-fixes, logic-targets | — |
| Matrix conditions | `gridCell.ts`, `gridAxes.ts` | gridCondition 23, gridAxes 9 | matrix-condition, cond-rule-grid | — |
| Auto-select / option rules | `autoPunch.ts`, `optionActions.ts`, `punchChain.ts` | autoPunch 20+12+18, optionLogic 28, punchChain 17 | autopunch-*, option-logic | — |
| Dynamic lists / derived values | `calc.ts`, `aiFunctions.ts`, `derivedNames.ts` | logicFunctions 21, calcCodes 5 | count-logic, ai-variables | — |
| Custom validation | `validate.ts`, `serverValidation.ts`, `semanticValidation.ts` | serverValidation 7, validationMessage 11 | validation-kinds, validation-condition | — |
| Scripting / events | `scripts.ts`, `ux.ts`, `uxScriptGuard.ts` | scriptAuthoring 10, legacyScripts 5, ux 8 | ux-script-dom, style-script-p0, age-script-p0 | — |

Ranked defects (reproduced; not fixed unless marked):

| # | Impact | Defect | Repro | One-line fix plan |
|---|---|---|---|---|
| D1 | High (monadic concept tests) | Randomizer `evenPresentation` is no more even than a shuffle: the offset comes from the respondent's RANDOM seed, so each child is shown with probability N/M independently — 1,000 respondents, show 1 of 4: spreads 14 / 62 / 26 (even) vs 41 / 22 / 35 (plain) | `scratchpad probe-even.mjs` | back the randomizer with a least-filled claim: a hidden List Fill keyed `randomizer:<id>` over the child ids, decided by the server route like any sample-counted list |
| D2 | High — **fixed** | Ranking of a masked/List-Filled list kept items the mask took away (U9) | `listFillLeast.test` U9 | `visibility.ts:266` prunes authored ranked codes no longer offered |
| D3 | Medium — **fixed** | Allocation source: 0 points = "selected" | `listFillLeast.test` | `listFill.ts:213` |
| D4 | Medium | `whenUnused: "disable"` is read by no renderer (destination shown as normal) | `grep` — only `inspector.ts` | render disabled destinations read-only in `QuestionRenderer` (shared with M/C — not touched); until then IM stores `hide` and the panel hides the option |
| D5 | Medium | `priority_random`, `priority_quota`, `highest_priority` are one code path; only `equalPriority` differs (and quota checks apply to every method) | `orderCandidates` `case "priority_random": case "priority_quota": default` | make `priority_random` force random within a band; document `priority_quota` = `highest_priority` + `respectQuotas` |
| D6 | Low | `afterMaximum`, `allowDuplicates`, `fillToCount`, `weighted`, `repeatBlockId`, `custom`, `script` source, `expression` count are schema-only (U2–U4) | 2026-10-16 audit | implement or drop from the schema docs; panel never offers them |
| D7 | Low | A List Fill decides once per respondent: no per-loop-iteration (task/page) allocation scope; raw answers keep a dropped iteration's answers (the flat export does not) | `lintLogic.ts:1679` warns | a loop-scoped List Fill (`scope: "iteration"`) keyed by iteration in `listfill_allocations.slot` |

## 8. Limitations

- Browser suites were written, not run (no dev servers here): `scripts/listfill-least-test.mjs`.
- Least fill herds under bursts (25 respondents on one snapshot → spread 17): the SQL claim enforces caps, not
  balance. A balance-exact variant would re-rank inside the claim (decision in SQL), which this design avoids.
- `keep_valid` keeps a held item even if a hard quota closed since (it holds its slot); use `redecide` if a
  changed answer must re-check quotas.
- A per-respondent list without counts in the Runner treats "short with room unknown" as stale; the server,
  with counts, may decline (no DB call). Without migration 0061 a changed sample-counted list keeps its items
  (logged) and the client asks again on each submit.
- `0061` must be applied after 0007 (re-running 0007 alone would restore the full unique index and old functions).
