/*
 * DURABLE TASK AND STEP STATE — the server's own record of a long generation.
 *
 * Until now the only record of what a plan-first generation had already built
 * lived in the browser: a checkpoint in `localStorage`, sent back as `done[]`
 * with every continuation (apps/studio/lib/copilot/resume.ts). A new tab,
 * another device, cleared storage or a closed laptop lost it, and the next
 * execution started the hundred-question survey over from question one — and
 * billed for it again.
 *
 * These two tables are the same thing, kept where it survives the page:
 *
 *     Survey → Task (the request, the deliverable spec, the plan version)
 *                └─ Step (one per approved plan item: its claim, its output,
 *                         its validation, its failure, what it cost)
 *
 * ## Why the claim is a SQL function and not an UPDATE in the route
 *
 * A slice of execution runs inside one serverless request with a 165-second
 * budget. When that request is killed mid-flight — the ordinary failure mode
 * this whole table exists for — the step it was running is left in `running`
 * with nobody holding it. The next slice must be able to take it back, and
 * two slices arriving together must NOT both take it, because each one costs
 * a model call the customer pays for. `rescript_claim_intelligent_step` is
 * that claim, done in SQL with `for update skip locked`, exactly as
 * `rescript_claim_transcription` (migration 0027) is.
 *
 * ## Why (task_id, idempotency_key) is unique
 *
 * The server-side duplicate-delivery guard. A runner that commits a step,
 * loses the connection before it reads the acknowledgement and retries writes
 * the SAME idempotency key — the index refuses the second row, so one output
 * is stored and one call is billed. The key is stable across retries and
 * across slices by construction (apps/studio/lib/copilot/taskStore.ts).
 *
 * ## What is NOT here
 *
 * No prompt text, no provider key, no provider response verbatim. `request`
 * is what the researcher typed, which is already in `intelligent_operations`
 * (0047); `failure_message` is one sentence written by our own code. Nothing
 * in either table is credential-shaped, and nothing in either table is
 * readable by anon or authenticated — service role only, as 0027 does it.
 */

/* ------------------------------------------------------------ the task */

create table if not exists public.intelligent_tasks (
  id            uuid primary key default gen_random_uuid(),
  survey_id     uuid not null,
  /* the workspace, for billing attribution; nullable because the sandbox has no survey row */
  customer_id   uuid,
  created_by    uuid,
  kind          text not null default 'survey_build' check (kind in (
                  'survey_build',   -- questions, blocks, logic — the ordinary generation
                  'translation',    -- one target language, inventory-driven
                  'conjoint',       -- a CBC/ACBC design: structure validators, not a count
                  'maxdiff',        -- a MaxDiff design: likewise
                  'scored_exam',    -- a question set with an answer key and a scoring rule
                  'analysis',       -- an analysis plan executed into results
                  'other'
                )),
  /* what the researcher asked, verbatim — the same text 0047 already keeps */
  request       text not null default '',
  status        text not null default 'pending' check (status in ('pending','running','completed','needs_attention','failed','cancelled')),
  /* bumped by a re-plan; steps carry the version they were planned under */
  plan_version  integer not null default 1,
  /* the DeliverableSpec: what "done" means, decided by deterministic code and never by a model */
  deliverable   jsonb not null default '{}'::jsonb,
  /* the last DeliverableReport, so the panel can show WHY a task is not done */
  report        jsonb,
  /*
   * The running totals, summed from the step rows on every commit. Kept on
   * the task so the budget check for the next slice is one read and not a
   * scan of two hundred steps.
   */
  tokens_in     bigint  not null default 0,
  tokens_out    bigint  not null default 0,
  tokens_cached bigint  not null default 0,
  charge        numeric(14,6) not null default 0,
  /*
   * WHAT THE TURN SPENT THAT NO STEP CAN CARRY (audit M7, 2026-10-25).
   *
   * `charge` is recomputed from the step rows, so it could only ever hold
   * what the per-item model calls cost. A turn also pays for the repair pass
   * and the coverage pass, which belong to the turn and not to any one plan
   * item, and those were recorded nowhere: the task's total was permanently
   * short of the truth with no row explaining the gap, which makes it
   * useless as a reconciliation target against `api_calls`.
   *
   * `charge` stays the sum of the steps plus this. Kept apart so the step
   * rows remain the explanation of everything attributable, and this is
   * visibly the remainder.
   */
  extra_charge  numeric(14,6) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists intelligent_tasks_survey_idx on public.intelligent_tasks (survey_id, created_at desc);
/* the cron continuation's query: tasks left open past their window */
create index if not exists intelligent_tasks_open_idx on public.intelligent_tasks (status, updated_at)
  where status in ('pending','running');

drop trigger if exists intelligent_tasks_touch on public.intelligent_tasks;
create trigger intelligent_tasks_touch before update on public.intelligent_tasks
  for each row execute function public.touch_updated_at();

/* the survey foreign key NOT VALID then validated, as 0047 does (an inline reference waits on surveys' lock) */
/* idempotent for a database that already has the table from an earlier apply of this file */
alter table public.intelligent_tasks add column if not exists extra_charge numeric(14,6) not null default 0;
/*
 * WHY A TASK IS WAITING FOR A PERSON (2026-10-25). A background slice may
 * not run when the author has lost the edit right, the project is frozen,
 * the turn ran on the researcher's own provider key, or the wallet cannot
 * cover another slice. None of those is a failure of the work — every step
 * built is intact — so the task pauses as `needs_attention` and records
 * which of them it was, with the sentence the panel shows.
 */
do $$
begin
  /* widen the status check for a table created before `needs_attention` existed */
  alter table public.intelligent_tasks drop constraint if exists intelligent_tasks_status_check;
  alter table public.intelligent_tasks add constraint intelligent_tasks_status_check
    check (status in ('pending','running','completed','needs_attention','failed','cancelled'));
exception when others then null;
end $$;

alter table public.intelligent_tasks add column if not exists blocked_reason text;
alter table public.intelligent_tasks add column if not exists blocked_message text;
alter table public.intelligent_tasks add column if not exists blocked_at timestamptz;

alter table public.intelligent_tasks drop constraint if exists intelligent_tasks_survey_id_fkey;
alter table public.intelligent_tasks add constraint intelligent_tasks_survey_id_fkey
  foreign key (survey_id) references public.surveys(id) on delete cascade not valid;
alter table public.intelligent_tasks validate constraint intelligent_tasks_survey_id_fkey;

/* ------------------------------------------------------------ the steps */

create table if not exists public.intelligent_steps (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references public.intelligent_tasks(id) on delete cascade,
  /*
   * The plan item's id, so a step and its item are the same thing. Text, not
   * a foreign key: plan items are jsonb and have no table.
   */
  step_id          text not null,
  /* the plan version this step was planned under; a completed step keeps the version it ran at */
  plan_version     integer not null default 1,
  /* presentation and claim order within the task */
  ordinal          integer not null default 0,
  /* step ids that must be completed (or tombstoned) before this one may run */
  depends_on       text[] not null default '{}',
  status           text not null default 'pending' check (status in (
                     'pending','running','completed','failed','retrying','blocked','tombstoned'
                   )),
  title            text,
  /*
   * HOW BIG this step is, in the task kind's own unit. The runner HALVES it
   * on a context_limit failure and splits rather than retrying whole;
   * `batch_size_used` records what actually went through, so a resumed task
   * can show why a step was cut up.
   */
  batch_size       integer,
  batch_size_used  integer,
  input_ref        text,
  /* the model's reply for this step; a large output is stored by reference instead */
  output           jsonb,
  output_ref       text,
  validation_status text not null default 'unchecked' check (validation_status in ('unchecked','valid','invalid')),
  /* stable, human-readable reasons written by our own checkers — never a provider's words */
  validation_errors text[] not null default '{}',
  failure_kind     text check (failure_kind in (
                     'transient','rate_limited','context_limit','invalid_output','auth','config','permanent'
                   )),
  /* one sentence, safe to show; never a provider's raw response */
  failure_message  text,
  retry_count      integer not null default 0,
  /* THE GUARD AGAINST DOUBLE DELIVERY AND DOUBLE BILLING — see the unique index below */
  idempotency_key  text not null,
  tokens_in        integer,
  tokens_out       integer,
  tokens_cached    integer,
  charge           numeric(14,6),
  /* which model actually answered (a fallback provider may differ from the first choice) */
  model            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  /* when the current holder took it; the reclaim window is measured from here */
  claimed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

/* one row per step id in a task: a re-plan updates the row rather than making a second one */
create unique index if not exists intelligent_steps_step_key on public.intelligent_steps (task_id, step_id);
/* the duplicate-delivery guard: committing the same key twice stores one output and bills one call */
create unique index if not exists intelligent_steps_idem_key on public.intelligent_steps (task_id, idempotency_key);
create index if not exists intelligent_steps_task_idx on public.intelligent_steps (task_id, ordinal, created_at);
create index if not exists intelligent_steps_open_idx on public.intelligent_steps (task_id, status, claimed_at)
  where status in ('pending','running','retrying');

drop trigger if exists intelligent_steps_touch on public.intelligent_steps;
create trigger intelligent_steps_touch before update on public.intelligent_steps
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ the claim */

/*
 * Move one runnable step of this task to `running` and return it, but only if
 * nobody else already has it.
 *
 * Runnable means: `pending` or `retrying`, or `running` and abandoned — its
 * holder last touched it more than `p_stale_seconds` ago, which is the
 * serverless timeout this table exists for. `p_max_attempts` stops a step the
 * model genuinely cannot answer from being retried forever at the customer's
 * expense. A step is only runnable when every id in `depends_on` has reached
 * `completed` or `tombstoned` — the same predicate as `dependenciesMet` in
 * packages/engine/src/execPlan.ts, written once more here because the
 * database, not the runner, is where the race is decided.
 *
 * `for update skip locked` rather than a plain update so two slices arriving
 * together do not both bill the provider for the same step: the second finds
 * the row locked, skips it, and takes the next runnable one or nothing.
 */
create or replace function public.rescript_claim_intelligent_step(
  p_task uuid,
  p_stale_seconds integer default 180,
  p_max_attempts integer default 3
) returns table (
  id uuid, task_id uuid, step_id text, plan_version integer, ordinal integer,
  depends_on text[], status text, title text, batch_size integer, batch_size_used integer,
  input_ref text, retry_count integer, idempotency_key text,
  started_at timestamptz, claimed_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_was text;
begin
  select s.id, s.status into v_id, v_was
  from public.intelligent_steps s
  where s.task_id = p_task
    and s.retry_count < p_max_attempts
    and (
      s.status in ('pending', 'retrying')
      or (s.status = 'running'
          and s.claimed_at is not null
          and s.claimed_at < now() - make_interval(secs => p_stale_seconds))
    )
    and not exists (
      select 1
      from unnest(s.depends_on) as d(dep)
      where not exists (
        select 1 from public.intelligent_steps x
         where x.task_id = s.task_id
           and x.step_id = d.dep
           and x.status in ('completed', 'tombstoned')
      )
    )
  order by s.ordinal, s.created_at, s.step_id
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  /*
   * A RECLAIM COSTS AN ATTEMPT (audit C4, 2026-10-25).
   *
   * The candidate test above refuses a step at `p_max_attempts`, and the
   * header promises that this is what stops a step the model cannot answer
   * from being retried forever at the customer's expense. It did not: this
   * UPDATE never touched `retry_count`, which moved only when the
   * TypeScript `fail()` was called — and the failure this table exists for,
   * a worker killed mid-flight, never calls it. An oversized prompt or a
   * model that always times out was therefore reclaimed and re-billed every
   * `p_stale_seconds`, without limit.
   *
   * Only a RECLAIM is counted, not the first claim of a `pending` step.
   * 0027 counts every claim because the transcript table has no other
   * counter; here `fail()` counts an attempt that failed and said so, so
   * counting the first claim as well would spend two of three attempts on a
   * single honest retry. Each increment now stands for exactly one attempt
   * that was lost or refused.
   */
  update public.intelligent_steps s
     set status = 'running',
         claimed_at = now(),
         started_at = coalesce(s.started_at, now()),
         retry_count = s.retry_count + (case when v_was = 'running' then 1 else 0 end),
         failure_kind = null,
         failure_message = null
   where s.id = v_id;

  return query
  select s.id, s.task_id, s.step_id, s.plan_version, s.ordinal,
         s.depends_on, s.status, s.title, s.batch_size, s.batch_size_used,
         s.input_ref, s.retry_count, s.idempotency_key,
         s.started_at, s.claimed_at
    from public.intelligent_steps s
   where s.id = v_id;
end $$;

revoke all on function public.rescript_claim_intelligent_step(uuid, integer, integer) from public, anon, authenticated;

/* ------------------------------------------------------------ RLS */

/*
 * The 0026 / 0027 posture: these are reached through the service role and
 * nothing else. Said out loud so the absence of a read policy is never read
 * as an oversight — a step's output is an unreviewed model answer that has
 * not yet been applied to anyone's survey, and the panel reads it back
 * through a route that has already checked the caller may edit the project.
 */
alter table public.intelligent_tasks enable row level security;
alter table public.intelligent_steps enable row level security;

drop policy if exists intelligent_tasks_service_role_only on public.intelligent_tasks;
create policy intelligent_tasks_service_role_only on public.intelligent_tasks
  as permissive for all to public using (false) with check (false);

drop policy if exists intelligent_steps_service_role_only on public.intelligent_steps;
create policy intelligent_steps_service_role_only on public.intelligent_steps
  as permissive for all to public using (false) with check (false);

revoke all on public.intelligent_tasks from public, anon, authenticated;
revoke all on public.intelligent_steps from public, anon, authenticated;

comment on table public.intelligent_tasks is
  'One long generation: the request, what "done" means (the deliverable spec), the plan version and the running spend. The server''s own record of what the browser checkpoint used to be the only copy of.';
comment on table public.intelligent_steps is
  'One step per approved plan item: its claim, its output, its deterministic validation, its classified failure and what it cost. Unique on (task_id, idempotency_key) — the duplicate-delivery guard.';

/* ------------------------------------------------------------ recovery note
 *
 * WHAT HAPPENS TO AN IN-FLIGHT TASK AT DEPLOY TIME.
 *
 * Nothing. At the moment this migration is applied the only consumer is
 * apps/studio/lib/copilot/taskStore.ts, which is DUAL-WRITE ONLY: rows are
 * written here as a shadow of the browser checkpoint, and no code path reads
 * them back to decide what to do next until R3's flag is turned on. A
 * generation that is mid-flight in somebody's tab when the deploy lands keeps
 * running on the old path — its `done[]` checkpoint, its resume — and
 * finishes there. It leaves behind step rows that are never claimed, which
 * cost nothing and are cascaded away with the survey.
 *
 * Before the migration is applied the store falls back to this server's
 * memory (apps/studio/lib/copilot/durable.ts), so the deploy order does not
 * matter in the other direction either: code first then migration, or
 * migration first then code, both work.
 *
 * When the flag IS turned on, the first slice of an older task finds steps in
 * `pending` with no claim and simply starts them; a step left in `running` by
 * the deploy is reclaimed after `p_stale_seconds` (180 by default), which is
 * longer than the 165-second route budget, so a slice that is still alive is
 * never stolen from.
 */
