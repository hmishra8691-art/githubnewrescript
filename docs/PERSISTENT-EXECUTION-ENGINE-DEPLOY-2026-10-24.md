# Deploying the persistent plan-first execution engine

Branch `feat/persistent-execution-engine` (two commits on `c8bcfd99`), also saved as
`0022-persistent-execution-engine.mbox`. The work is written up in
`claude/persistent-execution-engine-2026-10-24.md`; this file is only the order to do things
in and what proves each step worked.

The change is **reversible at every stage**. The task rows are written from the moment the
code is deployed and read by nobody until an operator says so, so a deploy and a migration
can go out days apart, in either order, without a broken window.

---

## 0. Before anything — find out what is actually deployed

Still unanswered from the Step 0 diagnostic, and it changes how urgent this is.

```
GET /api/platform
```

Readable by a platform admin in production (`requireUser`; readable to anyone outside
production). It returns `release` — `RESCRIPT_RELEASE`, else `VERCEL_GIT_COMMIT_SHA`, first 12
characters — and a probed migration level with the first gap named. No key, no token, no user
data: it is safe to screenshot.

- **If `release` is at or after `2600148b` (2026-10-18)** the 90 s stage cap is live, and the
  ~160 s stop users are seeing is the first-item hole this branch fixes.
- **If it is older**, production has no stage cap at all. That is a second, independent cause
  of the same symptom, and deploying this branch fixes both at once.

---

## 1. Merge

```bash
git push -u origin feat/persistent-execution-engine
gh pr create --fill --base main
```

The patch applies cleanly to `c8bcfd99` (verified by replay: `git am` onto a fresh clone of
`main` produces a byte-identical tree).

**Before merging, run what this environment could not.** Every unit suite is green —
studio 927 (926 pass, `lib/storyEngine.test.ts` the known pre-existing failure), engine
2330/2330, `pnpm -r typecheck` clean, auth-guard 0 problems, dependency boundaries 0
violations — but the **browser corpus was not run**. It needs the Studio dev server and longer
than a 180-second shell allows:

```bash
pnpm verify:browser
```

Re-run any failure **alone** before believing it: the dev server sits at 3–4 GB and is
OOM-killed under load, which looks like `ERR_CONNECTION_REFUSED` or a download that never
arrives (`docs/BROWSER-CORPUS.md`).

---

## 2. Deploy the code — nothing is switched on yet

Deploy `main` to the Studio as usual. On this deploy:

| Flag | Set it to | Effect |
|---|---|---|
| `COPILOT_TASK_DUAL_WRITE` | leave unset (defaults **on**) | the task and step rows are written |
| `COPILOT_TASK_RESUME` | leave unset (defaults **off**) | the browser's `done[]` is still the source of truth for what is built |

So after this deploy the behaviour a researcher sees is **unchanged**, except that the ~160 s
first-item stop is gone. Two things are now true that were not before: the rows are
accumulating, and `/api/platform` will report migration 0074 as missing — which is expected
until step 3.

`taskMirror` swallows every failure from the task layer and logs once per process, so a turn
that worked before this deploy still works with the table absent, with Supabase down, or if
anything in the new code throws. **Verify that** before going further: run one ordinary
generation and confirm it behaves exactly as it did yesterday.

### Add the cron secret if it is not already there

`CRON_SECRET` already gates seven jobs; the new `/api/cron/intelligent-tasks` route
(`*/5 * * * *` in `apps/studio/vercel.json`) uses the same one. **Every scheduled job refuses
to run when it is unset** — `/api/platform` warns about this explicitly. Nothing breaks if it
stays unset; the continuation job simply never runs.

---

## 3. Apply migration 0074

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0074_intelligent_tasks.sql
```

Additive, and idempotent — it was re-applied four times in a row against a PostgreSQL 16
database carrying all 74 migrations, and `scripts/intelligent-tasks-sql-test.sql` (27 checks
plus a real two-session claim race) passed twice, leaving no rows behind.

Confirm with `GET /api/platform`: the migration level should now name 0074 and the first gap
should move past it. Until it is applied, `taskStore` runs on its memory variant and reports
`durable: false`, which the execution panel shows the researcher honestly.

---

## 4. Let the rows accumulate, then look at them

Give it at least one release — the whole point of the dual write is that **a read you turn on
later is only safe if the rows were being written all along**. While you wait:

```sql
-- do the rows look like the generations people actually ran?
select kind, status, count(*), max(updated_at)
from intelligent_tasks group by 1, 2 order by 3 desc;

-- did any step get built twice? this must return nothing.
select task_id, idempotency_key, count(*)
from intelligent_steps group by 1, 2 having count(*) > 1;

-- is the spend attribution sane against the same period in api_calls?
select sum(charge), sum(tokens_in), sum(tokens_out) from intelligent_steps;
```

The duplicate query is the one that matters. A unique index on `(task_id, idempotency_key)`
should make it impossible; run it anyway, because it is the cheap check that the guard is
really doing its job before anything depends on it.

---

## 5. Switch the read over — the only risky step

```
COPILOT_TASK_RESUME=on
```

One variable, one restart. No deploy, no migration, no code change. `COPILOT_PLAN_RESUME` is
honoured as the older name and moves the same switch, so there is no way to turn on the plan
read while leaving the step read off.

**Do this on one environment first**, and watch for the two failure shapes that matter:

- an item **built twice** (the rows disagreed with the browser) — check the duplicate query
  above and the charge;
- an item **never built** (the rows thought it was done) — a task stuck in `running` with no
  outstanding step.

**To roll back, unset it and restart.** The browser's checkpoint is still being written and is
still complete, so a rollback loses nothing.

---

## 6. The one thing that is not wired

The cron route can claim and advance a task, but the **item build is not registered** with
`setStepBuilder`, so it currently counts a stale task as `skipped` rather than inventing a
build. Until that is done, a task still only advances while a page is driving it — the durable
rows mean nothing is *lost* when the page goes away, but nothing *continues* either.

Registering it means extracting the turn route's item-build closure (it closes over ~15
locals: `consent`, `ib`, `basePrompt`, `itemPassages`, `sel`/`core`, `stableExtra`,
`measured`/`fitting`/`shared`/`model`, `live`, `fakes`) into a `BuildStep` and calling
`setStepBuilder` from the module that owns it. It is the highest-risk edit in this whole piece
of work and it belongs in its own change, with the browser corpus run against it.

---

## Rollback, by how far you have gone

| Where you are | How to undo it |
|---|---|
| read switched on | unset `COPILOT_TASK_RESUME`, restart |
| migration applied | leave it — the tables are additive and nothing reads them with the flag off |
| code deployed | redeploy the previous commit; the rows stay and are simply ignored |

There is no state in the new tables that the old path needs, so none of these lose work.
