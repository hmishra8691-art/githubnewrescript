# First real-model evaluation — 22 November 2026

The Phase 1 model baseline, run by the owner on their Mac with `pnpm eval:ai --record --max-cost 5`
(`AI_MODEL=claude-sonnet-4-6`, `AI_MODEL_SMALL=claude-haiku-4-5`), against `main` at patch 0273.

## Result

| | |
|---|---|
| Cases | 67 (all run; the $5 cap was not reached) |
| Passed | 43 (64.2%) |
| Cost | $2.99 |
| Latency | p50 11.4 s · p95 81.8 s |
| Repair rate | 14.7% · clarify rate 17.6% |

The report and the cassette are on the owner's Mac (`eval-reports/ai-eval-live-2026-11-22T18-16-51-481Z.*`,
`apps/studio/lib/eval/cassettes/claude-sonnet-4-6-2026-11-22T18-16-51-481Z.json`). The cassette is not committed:
it records the model's answers to the prompts before the fixes below, so replaying it would test the old prompts.

## What failed, and what was done (patch 0274)

| Cases | Cause | Change |
|---|---|---|
| 13 cases: 9 method cases (3 `method-fix-*`, 6 `method-repair-*`), `staged-item-guides`, `staged-guide-miss`, `repair-bad-reference`, `analysis-readiness-repair` | They test how the Studio handles a **deliberately wrong scripted reply** (a refused design corrected, a refusal repaired, a guide not sent). A real model answered correctly or asked for missing conjoint levels — which the product's own rule requires — so the mechanism was never reached. | Marked `scripted: true`: run with the fake provider only; a live run lists them as not run. |
| `method-conjoint`, `method-dual-response` | Every attribute and level was given and the model still asked "a few quick questions". | Methods guide: essentials given → build now; never ask first about sizes, placement or gating. |
| `staged-build` ($0.38, passed after a repair), and the real model's plans in `staged-item-guides` ($0.97) and `staged-guide-miss` ($0.42) | Early plan items tagged, routed and planned the analysis of questions LATER items create, under codes no item created; dozens refused, one large repair call. | Merged item actions apply creates first, references after (`buildOrder`); each item may name only questions that exist, were built earlier or are created by itself; the analysis plan is its own last item. |
| `advanced-omega` | "Check the reliability…" was routed to survey review by the word "check". | The review pattern excludes statistical checks; reliability / omega / latent class / bootstrap count as analysis requests. |
| `advanced-latent-class`, `advanced-mediation-bootstrap`, `advanced-lca-covariates-refused` | The model wrote `"type": "latent_class_analysis"`, `indicators`, `classes_min`, and measurement levels like `ordinal (1=never…)` and `continuous`. | The engine reads those names: method synonyms (only unambiguous ones; a mediation is a regression only when it names its mediator), snake_case option keys, a level's leading word and common synonyms. |
| `qual-ai-interviews` | The guide was created but `configure_ai_interviews` left out. | AI interview guide: configure in the same reply; only launching is the researcher's. |
| 3 injection cases | The model removed the injected line correctly but quoted it back. Survey text that addresses the AI did not get the untrusted-data rule at all. | The rule now covers survey text, is sent whenever any source is flagged, and says never to quote such text back. |
| `prod-9ef5958d`, `prod-b8fee20f` | A long brief now becomes a durable task / a plan, which has no single-turn context flags. | Long-brief production cases accept mode `task`; context flags are not checked on a task or plan answer. |
| `ux-popup-hindi` (first run) | Popup on "option 0" of an NPS; fixed in 0272 — passed on this run after one repair. | — |

## Not yet known

Whether these changes raise the pass rate is only known from another real run. The fake run passes 67/67 and
every unit suite passes; neither evaluates the model.
