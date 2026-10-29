# One execution engine — D-1 close-out (2026-10-29)

Branch `feat/persistent-execution-engine`, commits `f0c8c70..443832e` on top of the Mac base `1f9cbdf`. The decision
this implements: ONE engine. The base's tables (`intelligent_tasks` / `intelligent_steps`, migration 0074), store
(`lib/copilot/taskStore.ts`), slice runner (`lib/copilot/runner.ts`) and cron stay; the unfinished K1–K4 attempt
(`k-work-2026-10-25`) is not merged — its contract, size estimate, generation planner and browser suites were PORTED
onto the base. There is no second engine, store, cron or panel.

## What changed

**Milestone 1 — the handler contract and registry on the base (`f0c8c70`).** K's shared contract
(`apps/studio/lib/tasks/types.ts`, `registry.ts`, `fakeResponders.ts`, `failures.ts`) ported onto the base engine:
statuses are the base's (`TaskStatus`, `StepStatus`, `TaskSummary` re-exported from `@rescript/engine`), `ctx.ai` and
`ctx.draft` are built on the base's metering and store. `packages/engine` gains `taskEstimate.ts` (the deterministic
output-size estimate the production prompts were missing — a 650-character Hindi brief that asks for 100 questions is
a task; "what does Q1 measure?" is not), `generationPlan.ts` (outline → skeleton with pre-assigned codes → adaptive
batches of ~20 simple / ~6 complex questions → logic/quota → validate → repair) and `deliverableValidation.ts`
(structured errors for targeted repair), plus the `before` placement and the `lite` replay in `applySurveyActions`
they need. `ExecStep` carries `kind` / `input` / `parallelGroup` / `modelTier`, `ExecTask` carries `summary` /
`completion` / `planner` / `base`; migration 0074 gains the same columns additively; the store maps them and
`redactForClient` keeps the input off the wire.

**Milestone 2 — the runner builds registered handlers; the task routes (`a818927`).** `runner.ts` gains the
contract's answers — `split` (the step tombstoned, children inserted, dependants rewired), `repair` (output kept, a
repair step inserted after it), `blocked` (task paused, step released without an attempt), `retry` (the runner's
bounded backoff), `failed` (permanent: the task fails with everything built preserved) — and a handler's own failure
sentence; the store gains `release` / `listFor` / `retry`. `lib/tasks/engine.ts` is the glue (`createPlannedTask`,
`handlerBuildStep`, `taskCheck`, `taskResult`), `draft.ts` the deterministic replay for `ctx.draft` (task base +
completed steps' actions through the engine's own gate, seeded ids), `aiServer.ts` is `ctx.ai` on `meteredAi` +
`completeJson` with an idempotency key per step attempt (a step is billed once), `service.ts` the server wiring
(request-driven and background slices), `access.ts` the project gate. Routes: `/api/copilot/tasks` (list, create),
`/api/copilot/tasks/[id]` (view; result and steps on the fake provider), `/api/copilot/tasks/[id]/{advance, pause,
resume, retry, cancel}`; the cron dispatches handler tasks under `backgroundContextFor` (platform key only, authority
re-checked per slice, wallet + per-task ceiling). The turn route plans a non-trivial request first (`turnTask.ts`,
after the translation hook, before any model call); `coerceChangePlan` splits a plan item that promises more than
12 simple / 5 complex questions; the execute loop bounds every item after the first by one stage cap plus one
minimum item from its own start and answers a `progress` checkpoint (nothing built, everything pending) when the
provider pauses or times out before the first item. Generation, the generic planner and the fake responders ported;
K's engine and generation tests re-expressed on the base runner.

**Milestone 3 — the page drives a planned task; one panel; the flags on `/platform` (`3c8e6f3`).** `useCopilot`
handles `stage: "task"`: the card shows the task, the drive loop advances it (one slice per request under the
researcher's own meter, resumable after a reload, stopped when the page goes so the cron can carry on). Pause /
Resume / Stop / Continue now / Review the result on the one `ExecutionPanel`; a completed task's actions open as one
proposal through the ordinary review → Apply. The capability registry documents the engine and every flag;
`/api/platform` reports them (presence and value, never a key).

**Milestone 4 — the browser suites, and the sandbox surviving a restart (`0076fe7`, `f8eac04`, `cfd924b`, `b246a2e`,
`443832e`).** `scripts/copilot-tasks-test.mjs` (scenarios A, B, D, F, H, P, R), `scripts/methods-task-test.mjs` and
`scripts/large-survey-task-test.mjs` ported to the base's routes and panel; a `maxSteps` seam on advance (fake
provider only); the Playwright resolver skips a package without its browser; the drive loop lets a Resume replace a
driver that Pause told to stop; completion criteria in the client view. Outside production the sandbox's in-memory
tasks are dumped to a small JSON file after each mutation and read back once, so a dev server recompiled or
OOM-killed mid-task loses no row (never in production, never for a real project).

## Where to find it

- **Intelligent Mode task card** — Studio, Intelligent Mode. Type a non-trivial request ("Create a 100-question
  survey about …", "add explanations to every question" on a long survey, "design a CBC study"): the turn answers
  at once with a task card (`[data-testid="cp-task"]`), its steps and their status; a trivial request answers as
  before. A completed task's result opens through the ordinary proposal review → Apply.
- **ExecutionPanel buttons** (`components/intelligent/ExecutionPanel.tsx`): **Pause** (`ex-pause`: stop after the
  step in flight; Resume carries on from the next), **Resume**, **Continue now** (run one slice now under your own
  meter), **Review the result**, **Stop** (`ex-cancel`: everything built is kept, nothing applied), and "What this
  has cost so far" (per step and per task). The panel says the task continues in the background when the page is
  closed.
- **Routes** (auth first statement on every one; sandbox on the memory store):
  `POST /api/copilot/turn` → `stage: "task"` when `turnTask.ts` decides so;
  `GET|POST /api/copilot/tasks?surveyId=` (list / create); `GET /api/copilot/tasks/[id]?surveyId=` (view; `&result=1`
  and `&steps=1` on the fake provider); `POST /api/copilot/tasks/[id]/{advance|pause|resume|retry|cancel}`;
  `GET /api/copilot/task` (the base's single-task view, unchanged); cron `GET /api/cron/intelligent-tasks`
  (`vercel.json`: every 5 minutes, `CRON_SECRET`).
- **Flags** (reported on `/platform` → `copilot.tasks`): `COPILOT_TASKS` (default on; `off` = single-turn routing
  as before), `COPILOT_TASK_ADVANCE_MS` (one page-driven slice, default 60 000, clamped 5 000–90 000),
  `COPILOT_TASK_DUAL_WRITE` (default on: the plan-item mirror of the existing staged build; `off` stops it),
  `COPILOT_TASK_RESUME` (default OFF: the plan reconciliation reads the persisted task; `COPILOT_PLAN_RESUME` is the
  older name and is honoured when the new one is unset), `TASK_BATCH_SIMPLE` / `TASK_BATCH_COMPLEX` /
  `TASK_BATCH_EDIT` / `TASK_BATCH_LOGIC` (batch sizes, clamped), `CRON_SECRET`. `ROUTE_BUDGET_MS` (165 s) and
  `maxDuration` (180) are NOT raised.
- **Migration** `supabase/migrations/0074_intelligent_tasks.sql` — re-runnable, RLS service-role only, applied
  nowhere in production yet. Amended additively on this branch: `intelligent_tasks.summary / completion / planner /
  base` (jsonb/text), `intelligent_steps.kind / input / parallel_group / model_tier`. Until it is applied a real
  project falls back to the single-turn path (logged once per process); the sandbox runs tasks in memory.
- **Docs that stay in force:** `docs/PERSISTENT-EXECUTION-ENGINE-DEPLOY-2026-10-24.md` (deploy order, rollback).

## The registry API (what E2 translation and E3 assessments register against)

Files, and nothing else: `apps/studio/lib/tasks/types.ts` (the contract: `TaskStepSpec`, `StepValidation`,
`StepOutput`, `StepResult` = `completed | split | repair | retry | failed | blocked`, `StepContext`, `FailureKind`,
`AiCall` / `AiAnswer` / `AiFn` / `AiCallUsage`, `StepHandler`, `TaskPlanner`); `registry.ts` (`registerStepHandler`,
`registerTaskPlanner`, `getStepHandler(kind)`, `getTaskPlanner(id)`, `pickTaskPlanner({message, survey})` — best
deterministic score > 0, ≥ 0.9 forces a task — `listStepHandlers`, `listTaskPlanners`,
`registerCompletionValidator(id, fn)`, `__resetTaskRegistry`); `fakeResponders.ts` (`registerFakeResponder(prefix,
fn)`, consulted by `ctx.ai` only under `AI_API_URL=fake:`, longest prefix wins); `failures.ts` (`classifyAiError`,
`classifyRefusal`, `resultForFailure`, `backoffMs`, `callKey`, `stepFailureKindOf`); `handlers/index.ts`
(`registerAllTaskHandlers()` — one import + call line per family, called once per process by the turn route, the task
routes and the cron).

A planner is `{ id, matches({message, survey}) → score, plan({message, survey, summary, ai}) → { summary, steps:
TaskStepSpec[], completion: string[] } }`; a `TaskStepSpec` becomes an `ExecStep` row (`stepId = id`, `kind`,
`title`, `dependsOn`, `input` jsonb, `parallelGroup`, `modelTier`, `batchSize = input.units`, `idempotencyKey =
<surveyId>:<id>:<hash of input>`); put `units` and `range` in `input` for the panel. A handler is `{ kind, run(ctx:
StepContext) → StepResult }` with `ctx.step`, `ctx.deps`, `ctx.summary`, `ctx.attempt`, `ctx.deadlineMs` /
`ctx.signal`, `ctx.draft` (task base + completed steps replayed through the gate; validate `output.actions` against
it before returning `completed`), and `ctx.ai(call)` — the ONE door to a model, metered, idempotent per step attempt,
failures returned classified. Never call a provider directly, never write to the store. Completion: the planner's
criteria (`questions>=100`, `codes:Q1..Q100`, `unique_codes`, `logic_refs`, `runtime_compatible`, …) judged by
`validateSurveyDeliverable` plus every registered completion validator plus `checkDeliverable`. Tests:
`lib/tasks/testing.ts` `runTaskInProcess({ message, definition, planner? })` drives a whole task in memory.

## Verification (2026-10-29, sandbox, fake provider)

Unit: engine `cd packages/engine && pnpm -s build && node --test dist/*.test.js` → 2,369 pass / 0 fail; studio lib
`cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` → 1,013 / 0; runtime lib
31 / 0; the packages (analytics 773, designs 124, ai 150, exporters 138, templates 110, access 123, quality 61,
billing 57) all green. `npx tsc --noEmit -p .` clean in studio and runtime. `node scripts/gen-public-docs.mjs --check`
current; `node scripts/dependency-boundaries.mjs` 0 violations; `node scripts/auth-guard-audit.mjs` 254 handlers,
0 problems.

Browser/API (`/tmp/p0/fresh.sh <suite>`, servers restarted before each): `copilot-tasks-test.mjs` 13/13 (A, B, D, F,
H, P, R); `methods-task-test.mjs` 5/5; `large-survey-task-test.mjs` B1/B2 pass (300 questions in 18 bounded slices
of ≤ 3 steps, 53 steps, repair, plan v11, nothing billed twice) — B3 (reload midway) was interrupted by a cut-off
session and is being re-run as part of this step; the result is recorded in the step-2 progress line and the final
report, not assumed here.

Step 2 of this close-out adds: the H proof on the execute loop's seams (`scripts/stage-cap-api-test.mjs`), the SQL
test (`scripts/intelligent-tasks-sql-test.sql`, 0074 applied twice on scratch Postgres 16) and the regression set
(`production-intents`, `intelligent-engine`, `copilot`, `copilot-streaming`, `engine-11-14`, `engine-15-19`,
`methods-intelligent`, `analysis-plan`) — each result is appended to this doc's "Step 2 results" section below as it
is obtained.

## Honest limits

- **Migration 0074 is applied nowhere but scratch.** Until it is, a real project never gets a task: the request runs
  on the single-turn path as before (the fallback is logged once per process). The sandbox runs tasks in memory
  (dumped to a file outside production).
- **The first plan item of an execute request still keeps the whole 150 s item deadline** (audit C2: a per-item cap
  made a 91–150 s item impossible instead of slow). The protection is upstream — `coerceChangePlan` splits an item
  that promises > 12 simple / > 5 complex questions, and a non-trivial request is a task of small steps before it
  ever reaches that loop — plus the `progress` checkpoint when a first item times out. One item that itself needs
  more than 150 s is still lost to the clock on the old plan→items path; that path is kept for what still uses it.
- **The fake provider does not wait.** `completeJson` answers at once under `AI_API_URL=fake:`, so a slow item is
  scripted as a delay followed by the same `timeout` ProviderError the real provider throws at the deadline; the
  91–150 s window itself is proved by the deadline arithmetic (`stageCap.test.ts`), not by waiting it out.
- **`COPILOT_TASK_RESUME` stays OFF by default**: the plan→items path's checkpoint is still the browser's `done[]`;
  switching the read to the rows is step 5 of the deploy doc.
- **Translation (E2) and assessments (E3)** are not on this branch: the translation hook in the turn route is
  untouched; their planners register through `handlers/index.ts` when merged.
- **Memory**: the dev server under a browser suite can be OOM-killed; a suite result below says "OOM at step N"
  where that happened, never "pass".

## Step 2 results

(appended as each item finishes; see `/tmp/p0/E1-STEP2.md` for the raw lines)
