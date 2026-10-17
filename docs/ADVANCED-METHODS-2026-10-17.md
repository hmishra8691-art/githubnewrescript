# Advanced methods — MaxDiff, Conjoint, LEAST / List Fill, Intelligent Mode (2026-10-17)

Summary of one audit-then-fix pass. Detail and evidence:

- MaxDiff: `docs/MAXDIFF-AUDIT-2026-10-17.md`
- Conjoint: `docs/CONJOINT-AUDIT-2026-10-17.md`, with measurement scripts in `docs/conjoint-audit-2026-10-17/`
- List Fill / LEAST and the advanced-customization inventory: `docs/LIST-FILL-LEAST-AUDIT-2026-10-17.md`
- Intelligent Mode: `docs/METHODS-INTELLIGENT-MODE-2026-10-17.md`

The architecture was kept as it was:

1. The configuration lives in the survey definition.
2. `@rescript/designs` generates a design once, from a seed, and pins it.
3. The renderer shows the design.
4. The engine and exporters flatten the answers.
5. Analytics estimates.

## 1. Current state before this pass (measured, not inspected)

| Method | Implemented | Incorrect or missing (evidence in the method docs) |
|---|---|---|
| MaxDiff | Exact item exposure in 4 of 5 configurations, reproducible seeds, no duplicates within a task, a real pooled best–worst logit | Pairs never shown together while the design was labelled "balanced" (8 items/4/6: 4 of 28 pairs); no prohibited pairs, best-only, practice task or labels; infeasible settings accepted (20 items × 3 tasks of 5 left 5 items unseen); XLSX export wrote every respondent as version 1 with an empty order; best = worst blocked silently |
| Conjoint | Prohibitions honoured in every run; aggregate MNL recovers planted values | Duplicate concepts in a task when the concept space is too small; attributes named `task`/`version` overwrote export columns; "balanced overlap" mislabelled; per-version D-efficiency down to 76.8 %; a preview reload switched version; stored choices not checked against the respondent's version; no stacked export; ACBC analysis silently analysed another question; menu analysis said "0 tasks"; phone layout scrolled sideways |
| LEAST / List Fill | Priority, quota-aware and target-balanced methods; atomic SQL claim | **No least-fill method.** "Least fill" ran as `balanced_random`, which without targets is plain random (allocation spread 233 over 1,000 respondents). Back plus a changed answer kept a stale claim. The SQL release-then-reclaim double-counted, and crossing preference orders deadlocked (126 in one 16-client run). Ranking and answer destinations kept removed items; zero-point constant-sum items counted as selected; unknown codes were allocated. No circular-dependency lint. Four panel controls did nothing |
| Intelligent Mode | — | MaxDiff and CBC could only be made as a question with no design, so the respondent saw nothing. There was no guide. Design settings were invisible to edits. "Add a None option" was refused by the grammar |

**What LEAST means here.** The word did not exist in the code. It is implemented as the market-research "least fill": each respondent gets the eligible item or items that the fewest respondents already have, counted on allocations or on completes. Ties are broken by a seeded random draw, by source order, or by priority then random. Caps and eligibility apply first. "Balanced" (furthest below target) remains a separate method, `balanced_random`.

## 2. What changed (in impact order)

**MaxDiff**

- A new `optimized` design is the default for new designs. Designs saved earlier regenerate byte-identically.
- Pair spread for 10 items, 4 per task, 10 tasks went from 0–3 to 1–2.
- For 8 items, 4 per task, 6 tasks, every pair now appears together. This needs some pair to appear 3 times, which a brute-force check confirms.
- Positions for 12 items, 4 per task, 9 tasks, 10 versions went from 2–14 to 7–8.
- The design's quality is measured, not assumed:
  - "Balanced" is said only when the item and pair spreads are as small as the counts allow; otherwise "near-balanced", with the numbers.
  - It is never called optimal.
- Prohibited pairs are added, enforced, and checked against the generated rows.
- Infeasible settings are refused with the numbers and the fix.
- New options: best-only, labels, instructions, and a practice task (exported, never analysed).
- best = worst now shows a message.
- Fixed: the XLSX seed bug, and an invented order written when a response has no seed.
- New long choice file: one row per respondent × task × item shown.
- The B−W counts are labelled descriptive; the logit is labelled as a pooled model. A recovery test passes: maximum error 0.026 at 1,500 respondents.

**Conjoint (CBC, menu, ACBC)**

- Feasibility checks always run; the generator refuses instead of producing duplicate concepts. Reserved and duplicate names are refused.
- New `efficient` method: D-efficiency 99.0 % per version (worst 98.4 %), level counts unchanged.
- New stacked export `format=cbc` (respondent × task × alternative × level, plus version, position and choice), and `_ORDER` columns in the wide export.
- Answers are recorded by design alternative, never by screen position. Screen labels A/B/C follow the shown order.
- Stored choices are validated against the respondent's own version. The preview keeps its seed across reloads.
- Phone layout: one card per alternative.
- Analysis:
  - Raw counts appear beside the model, which is labelled aggregate logit.
  - ACBC is refused in words, with no silent substitute.
  - Menu reports take-rate counts.
- ACBC combination prohibitions are fixed.

**List Fill**

- New `least_filled` method, with what is counted, how ties break, and per-List-Fill counting.
- New `selection.onChange` setting for Back plus a changed answer:
  - `keep_valid`, the default for sample-counted lists, releases items that no longer qualify and tops up.
  - `redecide` is the default for per-respondent lists.
  - `freeze` is the old allocate-once behaviour.
- Migration **0061** adds a re-allocation function and a release reason, makes slot uniqueness count only active claims, and locks rows in a fixed order so allocations cannot deadlock. Tested on Postgres 16:
  - SQL tests: 19 of 19 pass.
  - 8,000 of 8,000 mixed re-allocations keep caps, with counters matching allocations.
  - 800 crossing-order allocations produce 0 deadlocks.
- New lint for circular lists, missing sources or destinations, double writes and duplicate names.
- Data fixes: stale destination codes and ranking items, zero-point constant-sum items, unknown codes, and `runWhen` lists never hiding their destinations.
- Dead panel controls are removed; the simulator uses the right counter.
- Allocation spread over 1,000 simulated respondents with uneven sources, one item, no targets: random 233, least fill 3.

**Intelligent Mode**

- New actions: `create_maxdiff`, `update_maxdiff`, `create_conjoint`, `update_conjoint`. Each:
  - checks feasibility with the generator, using the panel's words;
  - generates the design once, from a seed derived from the configuration, so Apply reproduces exactly what the proposal showed;
  - creates the question;
  - describes the measured diagnostics.
- Updates change only the named fields, and regenerate the design only when the tasks would change.
- Unsupported variants are refused with the reason, never substituted: rating- or ranking-based conjoint, HB, labelled designs, dual-response None, worst-only, and MaxDiff or conjoint made as a plain question.
- A methods guide (4,380 characters, sent only when a method is named, in English, Hinglish or Devanagari) says what to ask and what to infer, and when to reply with a clarifying question. Example: a conjoint request without attributes.
- The List Fill guide covers least fill and `onChange`.
- The outline lists each design's settings, and the proposal shows a "Research design — measured" block.

## 3. Tested example configurations (real generators, Intelligent Mode actions)

| Request | Result |
|---|---|
| MaxDiff, 12 items, sizes not given | Inferred 4 per task, 9 tasks, 10 versions; each item shown 3 times per respondent; pairs 0–1 per version, 7–9 across versions (near-balanced) |
| "Make it 5 items per task" | Only that setting changes; items now shown 3–4 times |
| Prohibit a pair | 0 violations, measured on the rows |
| CBC, 4 attributes × 3 levels | 3 alternatives, 12 tasks, 10 versions, efficient; D-efficiency 99 % per version, 99.9 % pooled; 0 duplicate concepts |
| "Add a None option" | None on every task, nothing else changed |
| MaxDiff, 20 items, 3 tasks × 5 | Refused: "Use at least 4 tasks per version" |
| CBC, 2 × 2 levels, 5 alternatives | Refused: only 4 distinct concepts exist |
| "Use least fill counted on completes" | `least_filled`, basis completed; items, caps and destination untouched |

## 4. Advanced customization inventory — top open defects (ranked)

1. **Randomizer "even presentation" is no more even than a shuffle** (reproduced: 1,000 respondents, show 1 of 4, spread 62 with it on, 22–41 off). Fix plan: back it with a least-fill claim, as List Fill now does.
2. **Unused destinations set to "disable" are not handled by any renderer.** Intelligent Mode now stores "hide" and warns.
3. **`priority_random`, `priority_quota` and `highest_priority` share one code path.**
4. **Some List Fill settings exist only in the schema:** `afterMaximum`, `allowDuplicates`, `fillToCount`, `weighted`, `repeatBlockId`, custom script, expression count.
5. **No per-loop-iteration List Fill.**
6. **Design version assignment is a hash of the respondent seed.** It is stable across Back and resume, but balanced only on average; balancing it needs the same server-side claim.

## 5. Limitations (still open)

- **Estimation:**
  - No HB or individual-level utilities. Both MaxDiff and CBC are pooled models; the long and stacked files are the hand-off to HB tools.
  - ACBC has no estimator. Menu-based analysis is counts only.
  - Rating- or ranking-based conjoint is not implemented.
- **Design quality and generation:**
  - MaxDiff reports frequency balance, with no D-error figure.
  - Above about 40 versions the efficient CBC method stops at its work budget: 96.3 % per version at 300 versions.
  - Large designs generate in seconds in the browser while a proposal is open.
- **Least fill** balances on the counts at decision time. Simultaneous respondents can pick the same item (a spread of 17 in bursts of 25); the SQL claim enforces caps, not balance.
- **`keep_valid`** keeps an item even if a hard quota closed since; use `redecide` when quotas must be re-checked.
- **Stacked export** skips CBC questions inside loops. The long MaxDiff file uses the current definition for every response.
- **Not exercised in this sandbox:** `scripts/listfill-allocation-test.mjs` (needs the `pg` module); live resume. Reload was tested through the preview's session storage.

## 6. Deploy

1. Deploy the code.
2. Apply `supabase/migrations/0061_list_fill_reallocate.sql`. It is re-runnable. Without it, the runtime keeps stored items on a changed answer and logs that it did.
3. If not done yet, also apply 0060 from the previous change.

Existing surveys load unchanged:

- Designs saved without the new options regenerate identically.
- New designs default to `optimized` (MaxDiff) and `efficient` (CBC).
- Visible changes: the extra `_ORDER` columns in the CBC wide export, the A/B/C labels, and the best = worst message.
