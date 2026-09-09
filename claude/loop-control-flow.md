# Loop control flow — closing the gaps in the for-each engine

The 45-section For Loop spec arrived a second time. `claude/loops.md` records
that it was implemented on 2026-09-05 by growing the existing `loop` flow node
in place rather than adding a parallel repeating construct — so this pass was
an audit against that spec, not a build. A source sweep found most of the 45
sections already working, and thirteen genuine gaps. Nine are now closed.

**The thing worth saying first:** the audit's own summary was "do not rebuild
any of this". The pipeline (`source → filter → eligibleIf → order → count →
contexts`), loop-level reference columns, nested contexts with stacked answer
keys, `CURRENT_ITEM`/`LOOP_INDEX`/`LOOP_COUNT` across piping, conditions,
expressions, set expressions and scripts, six ordering modes, the inspector's
loop debug block, the simulator and the export dictionary were all already
there and correct. Everything below is an addition to that one pipeline.

## What was missing, and what it cost

**Control flow was the real hole.** `MAX ITERATIONS` existed; SKIP, BREAK,
WHILE and UNTIL did not. The audit's judgement was that break needed a new
mechanism, because `loopContexts` materialises every iteration before the body
runs and a break depends on answers produced *inside* iteration n.

That turned out to be wrong, in a way worth recording. `compileFlow` already
recompiles on every navigation, so the iteration list is re-derived after each
page submit. A `breakIf` evaluated per item, with that item's own context, is
therefore sufficient: iterations the respondent has not reached hold no
answers, so their condition is false and nothing truncates early; the moment
iteration 2's answers make it true, iterations 3+ leave the compiled flow. No
lazy expansion, no new execution model — nine lines in `resolveLoopItems`. It
also gets back-navigation right for free: editing an earlier answer so the rule
no longer holds brings the later iterations back, which is the same
re-evaluation rule display logic follows.

The break keeps the triggering iteration, because `RUN Block 7; IF score >= 5
BREAK` must have run the block that scored 5. `UNTIL cond` is this field;
`WHILE cond` is this field holding `NOT cond` — one truncation rule rather than
three spellings of it.

`skipIf` is the same filter stage as `eligibleIf` in the opposite polarity. It
runs before ordering and counting, so a skipped item never occupies a position
or consumes a `max` slot — which is what "skip" means, as distinct from an
iteration that runs and shows nothing.

**Aggregates (§11, §12, §37).** Already possible by hand: each iteration's
answer lands in a positional variable and the calc engine has `avg`/`countif`,
so `avg(Q7_1, Q7_2, Q7_3)` worked — but only when the definition fixes the
loop's size, and only if the programmer knew the positional spelling. A
declared `LoopAggregate` names the question and the operation instead, so it
works for a loop of any size. Unanswered iterations are skipped rather than
counted as zero: an average over three answers and two blanks is the average of
three answers.

**New sources.** Matrix rows and columns (§22-24) via a `dimension` field —
previously a programmer had to copy the row list into a static source, which
silently rots when a row is added. Columns consult `q.columns` then `q.options`,
because for `matrix_*` the column headers *are* the options; that is the
masking pipeline's existing convention, not a second idea of where a grid's
columns live. And a set expression (§20) as a source, reusing the masking
engine's evaluator so "the brands in both screeners" is one construct.

**Safety (§42).** A `count` source reads a numeric answer or an embedded-data
field, so it was only as sensible as what arrived — 1000000 allocated a million
contexts and hung the tab. There is now one ceiling every source shares
(`MAX_LOOP_ITERATIONS`), applied after the pipeline so it catches carried-forward
option lists too, and a nesting-depth lint error (five levels of a ten-item loop
is already 100 000 pages). Both truncate rather than erroring, so a mistyped
survey still fields; the lint is where the author finds out.

**Validation now names its iteration (§28).** A `ValidationError` carried no
loop information, so ten identical "Rating must be 1-5" errors were
distinguishable only by which page they appeared on — fine for the respondent
looking at that page, useless to a test-mode report or a data-quality review.
Taken from `ctx.loop` rather than from anything the rule declares, so every
rule kind got it without changing.

**Resolve-once mode (§32).** Behaviour was always re-evaluate, which is right
while the respondent is upstream of the loop and wrong once they are inside it:
adding a brand halfway through renumbers everything after it. `resolveSource:
"once"` snapshots the list the first time it resolves *to something non-empty* —
the emptiness guard matters, since a loop whose source is still unanswered
resolves to nothing on the compiles before the respondent reaches it, and
freezing that would give the loop zero iterations forever. The snapshot lives in
`state.calculated` under a reserved key rather than in a new `ResponseState`
field, so it persists, resumes and exports with everything else.

## Deliberately not built

- **A second repeating construct.** Every addition is a field on the existing
  loop node, and the first test asserts a loop written before any of this
  resolves to exactly what it always did.
- **Per-iteration declarative calculations**, and **accumulator variables that
  mutate across iterations** (`HIGH_SCORE_COUNT += 1`). Scripts can already do
  this — `setCalc` writes survey-level state and loop-body scripts get the
  iteration's context — but there is no idempotence: the flow recompiles on
  every navigation, so an accumulator over-counts on back/forward. Doing it
  properly needs a per-iteration "already ran" ledger, which is a real
  mechanism and not a field. The declared aggregates cover the cases the brief
  actually uses (§10-12, §37) without it, which is why they came first.
- **An execution timeout** (§42). Scripts are deliberately not time-boxed
  today; adding one is a script-host change with its own risks.
- **A structural expression mode for the loop config** (§41). The loop's
  *conditions* already have Visual⇄Expression parity through the shared
  `ConditionEditor`; a second textual grammar for the node's own shape would be
  a parser to keep in step with the editor forever.

## Demonstration

The brief's §44 example, walked by the real flow engine — five brands selected,
`skipIf` dropping the Other catch-all, `eligibleIf` dropping the two Value
brands by a loop-level reference column, selection ordering, piping of
`CURRENT_ITEM`, `CURRENT_ITEM.Category`, `CURRENT_ITEM.Product_ID`,
`LOOP_INDEX`/`LOOP_COUNT`, and a break on the second iteration:

```
ITERATION LIST  1→Apple   2→Google   3→Samsung
ITERATION 1/3  Apple
   Q23: How satisfied are you with Apple (Premium, PROD_001)? [1 of 3]
ITERATION 2/3  Google
   Q23: How satisfied are you with Google (Premium, PROD_003)? [2 of 3]
   → answered Q23 = 9
BREAK  Q23 >= 9 fired on Google — Samsung never ran
   LOOP_BRAND_AVG_SAT      7.5
   LOOP_BRAND_HIGH_COUNT   1
```

## Tests

`packages/engine/src/loopControlFlow.test.ts` (new, 19 cases). Engine suite
791 → 810. The cases that matter beyond the happy paths: a skipped item does
not consume a `max` slot; `breakIf` truncates nothing while the triggering
answers are absent; editing the answer away restores the later iterations;
matrix rows carry their real labels rather than bare codes; an average ignores
unanswered iterations; resolve-once does not freeze an empty list before the
loop is reached. Full monorepo typecheck/build/test clean across all nine
suites; `loop-test.mjs` (20 checks), `listfill-test`, `flow-export-test` and
`save-integrity-test` all pass unchanged, plus the full browser corpus.
