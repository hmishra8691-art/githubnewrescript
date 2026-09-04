# Advanced List Fill & Allocation Engine

List Fill takes a list — usually the options a respondent selected — and
allocates one or more items to that respondent according to priority, targets,
capacity and quotas, then makes the result available everywhere as ordinary
answers and variables.

It is deliberately **not** a "carry forward the selected answers" feature.
Carry-forward moves a list from one question to another; List Fill *decides*
which member of a list this particular respondent gets, subject to how the
whole sample has been allocated so far. That decision is the product.

The same machinery is built to serve quota allocation, experimental
assignment, conjoint and MaxDiff task allocation and randomised treatment
assignment: nothing in it knows the word "brand". A List Fill is a source, a
set of options with limits, a strategy, and somewhere to put the answer.

---

## Where the parts live

| Concern | File |
| --- | --- |
| Configuration model (versioned with the survey) | `packages/schema/src/listFill.ts` |
| The decision engine — pure, deterministic, explainable | `packages/engine/src/listFill.ts` |
| Atomic allocation, counters, audit | `supabase/migrations/0007_list_fill.sql` |
| Server-side allocation for a session | `apps/runtime/app/api/session/listfill/route.ts` |
| Runtime integration (runs on page submit) | `apps/runtime/components/Runner.tsx` |
| Programming panel, dashboard, simulator | `apps/studio/components/studio/ListFillPanel.tsx` |
| Counts + recount API | `apps/studio/app/api/surveys/[id]/listfill/route.ts` |
| Unit tests (38) | `packages/engine/src/listFill.test.ts` |
| Concurrency proof (45 checks, real parallel transactions) | `scripts/listfill-allocation-test.mjs` |
| Browser suite (22 checks) | `scripts/listfill-test.mjs` |

`def.listFills` is an array inside the survey definition, so a List Fill
versions, autosaves, exports, diffs and rolls back exactly like a question or
a quota. A deployed link allocates with the configuration its **pinned
version** carries, whatever the builder has changed since.

---

## The split that makes it safe

The single most important design decision:

```
  ENGINE (pure)                        DATABASE (atomic)
  ────────────────────────             ─────────────────────────
  decides an ORDERED PREFERENCE        claims ONE slot, once
  and a full decision trace            and says what was won
```

The engine never writes anything and never asks anything. It takes the
definition, the respondent's state, the current counters and a seed, and
returns "try A, then B, then C, and here is why" plus a trace of every
option's fate.

The database then claims a slot in that order, in a single statement:

```sql
insert into listfill_counts (…, allocated_count) values (…, 1)
on conflict (…) do update
  set allocated_count = listfill_counts.allocated_count + 1
  where listfill_counts.allocated_count < p_max
returning allocated_count
```

The `where` runs *after* the row lock is taken, so it sees the count as of
that instant rather than as of the caller's earlier read. Two respondents
reaching the last slot of A therefore cannot both get it: one gets the row
back, the other gets nothing and falls through to B.

`scripts/listfill-allocation-test.mjs` proves this with 300 simultaneous
transactions on separate connections against caps of 150 / 75 / 50 and an
uncapped fallback, and separately with 50 respondents racing for a single
remaining slot. In every run the caps land exactly on their numbers.

A failed claim never falls back to the engine's optimistic answer — the route
returns 503 and the list simply has not run yet. Inventing an item locally is
precisely how two respondents end up sharing the last slot.

---

## The lifecycle

```
source → candidates → eligibility → priority → target / min / max
       → quota → remaining capacity → strategy → randomisation / fallback
       → final list → variables → destinations
```

**Source.** A question (its selected, displayed, or all options), a static
list, a calculation, an embedded field, another List Fill's result, or a
script. A source question's **visibility is irrelevant**: a hidden question
populated by a URL parameter, a calculation or a script feeds List Fill
exactly like one the respondent answered. Visibility and execution are
separate concerns, and the browser suite asserts it.

**Eligibility.** An option can be switched off (`eligible: false`) or gated on
a condition (`eligibleWhen`), and the whole list can be gated on `runWhen`.
Those conditions are ordinary `Condition` trees evaluated by
`evaluateCondition` — the same engine as display logic, skip logic, quotas and
quality rules. There is no second logic language.

**Priority is not a quota.** Priority is the *order options are tried in*: a
lower number is preferred. Target and maximum are *how much of it is wanted*.
An option at its target is still usable; an option at its maximum is not.
That distinction is what makes the requirement's canonical sequence fall out
of configuration rather than code:

| Sample state | Allocated |
| --- | --- |
| everything open | A |
| A at 149 / 150 | A |
| A at 150 | B |
| A 150, B 75 | C |
| A 150, B 75, C 50 | D or E, per the fallback rule |

Nobody edits the running survey to make that happen.

**Minimums** work the other way round: an option below its minimum is treated
as *urgent* and outranks its equal-priority peers until it catches up.

**Quotas.** With `tracking.respectQuotas`, each candidate is provisionally
bound as the list-fill result and the survey's own quota code is asked whether
that would land the respondent in a full cell. Multi-dimensional quotas come
free: a cell saying "Apple AND male AND 25–34 AND North" is one ordinary
condition, evaluated with the candidate sitting beside the answers already in
the state. No quota structure is hardcoded.

**Strategy.** Eleven selection methods (`highest_priority`, `lowest_priority`,
`priority_random`, `priority_quota`, `first_selected`, `selection_order`,
`random`, `weighted_random`, `balanced_random`, `quota_aware_random`,
`custom`) and five equal-priority rules (`random`, `balanced`, `sequential`,
`weighted`, `quota_aware_random`). `afterTarget` decides what a satisfied
option does — keep going, drop behind, join a random pool, or stop — and
`fallback` decides what happens when the whole preference order runs dry.

**Determinism.** Every random choice comes from `mulberry32(subSeed(seed,
"listfill:<id>"))`. The same respondent with the same answers and the same
counters gets the same answer in the builder's simulator, in preview, in a
test link and in production. There is no `Math.random` and no clock anywhere
in the engine.

---

## Variables

Each list contributes, for a list named `Q1`:

| Variable | Meaning |
| --- | --- |
| `LISTFILL_Q1_COUNT` | how many items were allocated |
| `LISTFILL_Q1_1` | the first item's label (for piping) |
| `LISTFILL_Q1_1_CODE` | the first item's code |
| `LISTFILL_Q1_1_POSITION` | its position |
| `LISTFILL_Q1_CODES` | all codes, comma-separated |
| `LISTFILL_Q1_LABELS` | all labels |

They are written into `state.calculated`, which is why they work in display
logic, skip logic, branches, validation, piping, calculations, quotas,
scripts, filters and exports without any of those learning about List Fill.
`buildVariableDictionary` declares them **from the configuration**, so the
dictionary and the CSV / XLSX / SPSS exports carry a column for every possible
position before a single respondent has run — an export cannot silently
change shape between waves.

The condition builder lists them under "List Fill results", so a researcher
can filter responses or write logic on "which brand was this respondent
allocated" with the ordinary builder.

---

## Destinations

A destination writes the allocated code into a question's answer, or leaves it
to piping. Positions map in order unless a destination pins one.

When there is no item for a destination, `whenUnused` decides: `hide`, `skip`,
`disable`, `blank`, `do_not_instantiate` or `terminate_block`. The removing
rules are honoured by `visibleQuestions`, so a destination with nothing to
show disappears rather than sitting on the page as an empty question.

A `listFill` loop source runs a repeat block once per allocated item. The flow
compiler **reads** the stored allocation rather than deciding one — it
recompiles after every answer, and re-deciding would both hand out different
items and consume sample capacity again.

---

## Counting, releasing, repairing

`listfill_counts` keeps two numbers per option:

- **`allocated_count`** — slots claimed, including sessions still in progress.
  This is what a cap holds against.
- **`completed_count`** — slots whose response finished.

A list configured with `countOnCompleteOnly` is capped on the second number.
That is the honest reading of "150 completed interviews for Apple", and it
means slightly more than 150 respondents may hold Apple while they are still
answering. The panel says so.

Claims are given back automatically:

- a completed response **confirms** them (`rescript_complete_listfill`)
- a screen-out, quota-full or termination **releases** them — such a
  respondent did not consume an interview
- a soft-deleted or purged response releases them via a trigger on
  `responses`, and a restore takes them back
- `rescript_recount_listfill` rebuilds one environment's counters from the
  allocations that stand — the repair path after an import or a bulk delete,
  and the Studio's "Recount from allocations" button

Test and live never share a counter. `listfill_counts` is keyed by
`is_test`, and the same is now true of the runtime's quota counters — a bug
fixed alongside this work, where `loadQuotaCounts` ignored its environment
argument and summed both, so a busy test link could close a live quota.

Every allocation is recorded in `listfill_allocations` with the session, the
position, the option and the survey version it was decided under. That table
is the audit trail and the source of truth the counters are a cache of.

---

## Idempotency

`rescript_allocate_listfill` returns a session's existing allocations
unchanged if it already has them, marked `reused`. Going back, reloading,
resuming tomorrow, or double-submitting a page all yield the same items. An
advisory lock on session + list serialises a session's own concurrent
requests, so even a genuine double-submit from two connections cannot
allocate twice — asserted in the concurrency suite.

---

## The simulator

The Studio panel's simulator runs `decideListFill` and `simulateListFill` —
the very functions the runtime calls — in the browser, against the real
counters for the selected environment. Nothing is written and no slot is
claimed.

"Simulate one respondent" shows the decision trace: every option, its
priority, its current count, its remaining capacity, and either the position
it won or the reason it was rejected, followed by every decision in the order
it was made. "Simulate N respondents" projects the allocation forward against
its own evolving counters, which is how you check a design before fieldwork:
starting from A at 149/150, B full and C at 20/50, one hundred respondents
finish A, leave B alone, fill C to 50, and the rest are reported as
unallocatable rather than quietly given something.

Because it is the same engine, what the simulator shows is what fieldwork
does.

---

## What is intentionally not here

- **No parallel logic engine.** Every condition is a `Condition` evaluated by
  `evaluateCondition`.
- **No hardcoded example.** The 150 / 75 / 50 numbers appear only in tests.
  Options, priorities, limits, counts and strategies are all configuration,
  and the unit tests run the same sequence with different numbers and
  different band counts.
- **No decision in SQL.** Only the cap travels to the database. Eligibility,
  conditions, priority, targets, quotas and strategy are decided once, in the
  engine, so a second divergent copy of the rules cannot grow in plpgsql.
- **No client-side authority.** In live and test the browser is told the
  result; it never computes one. Preview has no sample and runs the engine
  locally, which is the simulator path.
