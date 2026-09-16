# The survey that never started

A P0: the runtime showed a loading screen and never rendered the survey.

**Embedded Data was the trigger, not the cause.** The cause was that resuming a
session restored a saved step *number* without checking it named anything the
runtime could draw. Embedded Data is implicated only because an
`embedded_data` node is the natural first thing in a flow, and a flow whose
first node is not a page is what makes the restored number wrong.

## The reproduction

Survey `SURVEY_SM8SMQ0P`, "Beverage Habits 2026", 45 questions. Its flow:

```
 0  embedded_data   ed_capture      ← step 0 is not a page
 1  block           blk_consent
 2  branch          br_consent
 …
11  end             end_complete
```

Its one response row:

```
status       in_progress
is_test      true
step_index   0            ← saved when the session started, never advanced
answers      {}
started_at   2026-09-14
```

Opening Test resumed that row every time.

## The failure, line by line

`apps/runtime/components/Runner.tsx`, the resume branch:

```ts
const steps2 = compileFlow(def, state, counts);
state.stepIndex = Math.max(0, Math.min(saved.stepIndex ?? 0, steps2.length - 1));
```

An index is not a position. The flow is recompiled against the restored
answers, and step 0 of *this* flow is `ed_capture` — an `embedded_data` node.

Then, further down the same component:

```ts
const step = steps[state.stepIndex];
const pageStep = step?.kind === "page" ? step : null;
…
) : !pageStep ? (
  <div className="rs-card rs-end"><h2>Loading…</h2></div>
```

And it could never leave, because the only things that call `advance()` are
the Next and Back handlers, and both open with:

```ts
if (!pageStep) return;
```

So: no page, no buttons, no navigation, no way out. Nothing threw. No request
failed. No promise was pending. The survey had finished loading and was parked
on a step it could not draw.

`start()` never had this problem — it walks from `-1` through `moveForward`,
which *executes* the non-page steps and stops at the first page with something
to show. Resume skipped that walk entirely.

## Why it looked like a loading screen

Two defects, one symptom:

1. **Resume restored an index without settling it onto a renderable step.**
   That is what produced this particular hang.
2. **A non-renderable step was rendered as "Loading…".** That is what turned a
   deterministic dead end into an infinite spinner with no diagnostics — and
   what would have hidden the next such bug just as well.

The second is the more important one. "No page yet" and "no page, ever" were
the same state on screen, so a permanent condition wore the costume of a
transient one.

## The fix

**`resumeAt(def, state, quotaCounts, savedIndex)`** in `packages/engine/src/flow.ts`.

It recompiles, and then:

- if the saved step is a page with at least one visible question, that is where
  the respondent was and that is where they stay;
- otherwise it settles forward through the **same `moveForward` walker**
  `start()` uses — executing the embedded-data and quota steps on the way
  rather than jumping over them, so `WAVE` and `PANEL` are captured and piping
  does not silently render empty;
- a missing, negative or corrupt index is a fresh start, not index 0. The old
  `Math.max(0, …)` turned `-1` and `NaN` into "the first step", which on this
  flow was the deadlock arrived at from a second direction;
- an index past the end of a shortened survey completes the response.

It never resumes *backwards*. Walking back could re-ask a submitted page and
re-run a quota check already passed.

**The `!pageStep` branch** now renders a card that says what happened: in Test
and Preview, how many steps the flow compiled to and what kind of step the
current position is; in Live, a plain sentence and a "Start again" button. It
should now be unreachable — which is exactly why it must be loud if it is ever
reached again.

## What was ruled out

Traced and eliminated before the fix: promises that never resolve (none
pending), API calls hanging (`/api/session/start` returned normally), schema
parse failures (the definition compiled — the title and footer on screen come
from it), logic loops (`moveForward` has a 10 000-iteration guard that never
fired), React remounting, and Embedded Data evaluation itself (the values
resolve correctly; a leading embedded-data node with *no* fields deadlocks
identically). A `quota_check` first in the flow produces the same hang, which
is the clearest evidence the cause is not Embedded Data.

## Tests

```bash
node --test packages/engine/dist/resumeStep.test.js   # 10, the root cause
node scripts/loading-deadlock-test.mjs                # 15, in a real browser
```

Both were checked against the broken code before being trusted. Restoring the
original resume arithmetic fails 7 of the 10 unit tests. Restoring it in the
Runner makes the browser suite stop at check 1 with the page reading exactly
what the bug report's screenshot shows:

```
Error: the preview never rendered … after 2 handoff(s) in 20000ms.
The page reads:
  …
  Loading…
```

## The rule this leaves behind

A loading state is a claim that something is still happening. If nothing is
still happening, it is a lie, and it costs a respondent their whole session.
Any state the runtime cannot leave must name itself.
