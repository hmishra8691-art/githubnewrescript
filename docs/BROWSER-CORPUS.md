# Running the browser corpus

`pnpm verify` runs the unit suites, the typechecker and the static audits.
None of those touch the ~48 Playwright suites in `scripts/`, because those
need both dev servers up. For most of this project's life that meant nothing
ran them, and two suites rotted in plain sight:

- `auth-guard-audit.mjs` drifted to **15 failures** while `docs/COLLABORATION.md`
  still said "0 unguarded" — it had no `package.json` entry, so nothing ever
  invoked it.
- `canvas-test.mjs` had been red since Fieldwork, Project and Distribution were
  added to the left navigation, because its filter was never updated and nobody
  re-ran it.

Both were found by accident, months late. `scripts/verify-browser.mjs` exists so
the next one is found on purpose.

```bash
pnpm verify:browser          # the whole corpus, ~35 minutes
pnpm verify:all              # pnpm verify, then the corpus
node scripts/verify-browser.mjs --only variants    # just the matching ones
node scripts/verify-browser.mjs --list             # what it would run, and what it won't
```

## What makes it worth trusting

**The list is discovered, not written.** Every `scripts/*-test.mjs` is in the
corpus unless it is on the exclusion list *with a reason*. A hardcoded list of
suites is a list a new suite gets left off — which is the exact failure this
script is here to prevent.

**A skip is a failure unless it was declared.** A timeout, a crash, a missing
dependency: the run is red. "45 of 48 passed" with no account of the other
three is how a corpus quietly shrinks.

**It leaves the machine as it found it.** Servers the script started are
stopped; servers that were already running are left alone. Killing a
developer's dev server mid-session in order to run a check is a good way to
make somebody stop running the check.

**Readiness is a real request.** `next dev` prints "ready" long before it can
serve a compiled route, so the script waits for an actual page to come back
rather than polling the port. Polling the port lets the first suite race the
first compile and fail for a reason nobody can reproduce.

## It runs one suite at a time, on purpose

The first full run reported six failures. **Four of them were not real.**
`autopunch-media-test.mjs` and three `variants-g*` suites had each timed out
waiting for `[data-qid]` in the runtime preview under `--jobs 3`, and every one
of them passed when run on its own. Three Chromiums driving three cold
`next dev` compiles of the same routes starve each other past a 30-second
selector wait, and the suite blames the app.

A parallel runner that invents failures is worse than no runner, because a red
run nobody believes is a red run nobody reads. `--jobs` is still there for a
narrowed `--only` on a big machine; the default is 1.

## The suite budget is measured, not guessed

`SUITE_TIMEOUT_MS` is 15 minutes. The first version used 5 and reported
`variants-g3-test.mjs` as a failure — it genuinely takes **8 minutes**, driving
22 checks of real pointer drags and swipes through the runtime. A green suite
called broken teaches everybody to ignore the runner, so the budget is roughly
twice the slowest thing in the corpus. A suite that hits it is hung, not slow.

Roughly: 40 of the 48 finish in under 20 seconds; `variants-g3` (8 min),
`variants-g6` (3 min), `p0-cookie` (2½ min, including its build), `variants-g4`
and `g5` (~80s each) account for most of the wall clock.

## The one suite that builds

`p0-cookie-test.mjs` proves on the wire that whichever endpoint *discovers* a
dead session is the one that clears the cookie. `next dev` does not run
middleware and route handlers the way the deployed app does, and the assertion
is about what a real response carries in `set-cookie`, so this suite stands up
its own Studio with `next start` against a stub PostgREST.

That needs a production build, and a production build written into `.next`
overwrites a running dev server's chunks — after which the dev server serves
404s for its own assets, a failure that looks exactly like a broken application
and costs an hour to recognise. So:

- `apps/studio/next.config.mjs` honours `NEXT_DIST_DIR`. Unset — every normal
  `dev`, `build` and deployment — it is Next's own `.next`.
- The suite builds into `.next-p0` (gitignored) and starts from there.
- It rebuilds **every run**. A cached build is a build of yesterday's source,
  and a suite that proves yesterday's source has stopped being a test. Set
  `P0_COOKIE_REUSE_BUILD=1` while iterating on the assertions themselves.

## Declared exclusions

Three suites are not browser suites at all. They assert concurrency guarantees
— one active session under 60-way contention, the atomic List Fill claim, the
edit lock under real simultaneity — that only a database can settle:

| Suite | Why |
|---|---|
| `auth-collaboration-test.mjs` | session and lock behaviour under real 60-way contention |
| `listfill-allocation-test.mjs` | the atomic allocation claim |
| `lock-concurrency-test.mjs` | 8 connections, 8 transactions, one winner |

They belong beside the `scripts/*-sql-test.sql` files, in a step against a
scratch database with `0001..n` applied in order. The runner names all three at
the end of every run so their absence is a standing statement rather than a
silence.

## Current state

```
48 of 48 suite(s) passed · 32.7 minutes of suite time
```

Plus `pnpm verify`: typecheck clean, all package suites green, 94 handlers
checked with 0 problems.

## When a suite goes red

1. **Run it alone first.** `node scripts/<suite>.mjs` against dev servers you
   started yourself. If it passes alone and failed in a `--jobs N` run, that was
   contention, not a regression.
2. **Read what the selector was.** Four of the six original failures were
   `waitForSelector` timeouts on `[data-qid]` — a starved compile. One was
   `.chip.warn`, a class that had been renamed to `.chip.qd-note` when §24
   turned a warning into a note: the sentence the assertion cared about was
   still on the screen. That one is now anchored on `data-testid`, so the note
   can be restyled or re-worded around the edges without going red.
3. **Prefer a test id to a class.** A class is a styling decision; a
   `data-testid` is a promise. Assert on the promise.
