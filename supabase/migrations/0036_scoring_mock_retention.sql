-- 0036_scoring_mock_retention.sql
--
-- EVALUATION THAT CAN BE READ BACK, PRACTICE INTERVIEWS, AND RETENTION THAT
-- ACTUALLY DELETES A PERSON.
--
-- ## Scoring, evidence-gated
--
-- `interview_requirements.category` groups requirements for category-level
-- scores (technical, communication, …). `interview_analysis.score` holds the
-- scorecard the analysis computed, as a snapshot: every number in it names the
-- `interview_evidence` rows it was composed from, so a score can always be
-- expanded to the quotes that produced it. The scorecard is derived from
-- verified evidence only — never from telemetry, video, or the model's
-- impression — and that rule lives in `packages/interviews/src/scoring.ts`,
-- not here. This column is where the result lands so a table view can show it
-- without recomputing.
--
-- ## Mock interviews
--
-- A mock interview is a project with `mode = 'mock'`. It is the same tables,
-- the same recorder, the same transcription and the same analysis — what
-- changes is who the output is for. In a hiring project the candidate never
-- sees analysis; in a mock project the candidate IS the audience, and the
-- recruiter-facing surfaces are not the point. `category` on the project is
-- for the library (software engineering, product, sales, …), and `template_key`
-- records which library template a project was started from so the feedback
-- can suggest practice from the same shelf.
--
-- ## Retention in hours, and retention of the PERSON
--
-- `retention_days` has a floor of one day and the sweep counted in days. The
-- brief's 24-hour rule for practice recordings was unrepresentable, so
-- `retention_hours` is added beside it; when set, it wins. And retention had
-- only ever deleted MEDIA. The candidate's name, email, hashed IP, user agent,
-- typed answers, telemetry and roster row stayed for ever. `retention_scope`
-- gains `responses`, `telemetry` and `identity` keys, and the sweep honours
-- them. New projects default to all of it after seven days, which is the
-- brief's rule for respondent data; existing projects keep their scope and
-- their ninety days — a migration must not decide to destroy things.
--
-- ## An audit trail for deletion
--
-- `interview_deletions` records every object the sweep removed: what, why,
-- when, and whether a HEAD afterwards confirmed it was gone. Until now the only
-- trace of a deletion was the mutated media row, which carried no actor, no
-- reason and no verification, and the R2 batch delete was sent `Quiet`, so
-- nothing anywhere could say a deletion had actually happened.
--
-- ## Retention reaches interviews that never finished
--
-- `rescript_interview_retention_due` required `completed_at`, so a candidate
-- who recorded three answers and closed the tab kept those recordings for
-- ever. The window now runs from the LAST activity — completion, or the last
-- time the interview was touched — whichever is later.

begin;

/* ------------------------------------------------------------ requirements */

alter table public.interview_requirements
  add column if not exists category text not null default 'general';

comment on column public.interview_requirements.category is
  'Groups requirements for category-level scores: technical, communication, problem_solving, domain, behavioural, role, general.';

/* ----------------------------------------------------------------- analysis */

alter table public.interview_analysis
  add column if not exists score jsonb;

comment on column public.interview_analysis.score is
  'The scorecard as computed from verified evidence — every number names the evidence ids it came from. Recomputed on each analysis run.';

/* ----------------------------------------------------------------- projects */

alter table public.interview_projects
  add column if not exists mode text not null default 'hiring',
  add column if not exists category text,
  add column if not exists template_key text,
  add column if not exists retention_hours integer;

alter table public.interview_projects drop constraint if exists interview_projects_mode_check;
alter table public.interview_projects
  add constraint interview_projects_mode_check check (mode in ('hiring', 'mock'));

alter table public.interview_projects drop constraint if exists interview_projects_retention_hours_check;
alter table public.interview_projects
  add constraint interview_projects_retention_hours_check
  check (retention_hours is null or (retention_hours between 1 and 87600));

comment on column public.interview_projects.mode is
  'hiring: the recruiter reads the analysis. mock: the candidate reads it — practice, with feedback shown to the person who sat it.';
comment on column public.interview_projects.retention_hours is
  'When set, overrides retention_days. Exists so a practice recording can be kept for 24 hours; days cannot express that.';

/* ---------------------------------------------------------------- deletions */

create table if not exists public.interview_deletions (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  project_id uuid references public.interview_projects(id) on delete set null,
  interview_id uuid,
  media_id uuid,
  storage_key text,
  /* media | transcripts | analysis | responses | telemetry | identity | orphan */
  what text not null,
  /* retention | replaced | retake | orphan | removed | project_deleted */
  reason text not null,
  bytes bigint,
  deleted_at timestamptz not null default now(),
  /* null: not checked. true: a HEAD afterwards found nothing. false: it was still there. */
  verified boolean,
  verified_at timestamptz,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists interview_deletions_customer_idx on public.interview_deletions (customer_id, deleted_at desc);
create index if not exists interview_deletions_interview_idx on public.interview_deletions (interview_id) where interview_id is not null;
alter table public.interview_deletions enable row level security;

comment on table public.interview_deletions is
  'Every object and row the retention machinery removed, and whether the removal was verified. The audit trail the brief''s section 18 asks for.';

/* ---------------------------------------------------- retention due, in hours */

drop function if exists public.rescript_interview_retention_due(integer);
create or replace function public.rescript_interview_retention_due(p_limit integer default 50)
returns table (
  interview_id uuid, project_id uuid, customer_id uuid,
  retention_days integer, retention_hours integer, retention_scope jsonb,
  completed_at timestamptz, last_activity_at timestamptz, mode text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.project_id, i.customer_id, p.retention_days, p.retention_hours, p.retention_scope,
         i.completed_at,
         greatest(coalesce(i.completed_at, i.started_at, i.created_at), coalesce(i.last_seen_at, i.created_at)) as last_activity_at,
         p.mode
    from public.interviews i
    join public.interview_projects p on p.id = i.project_id
   where i.deleted_at is null
     and i.media_purged_at is null
     and (p.retention_days is not null or p.retention_hours is not null)
     /*
      * The window runs from the LAST ACTIVITY, not from completion. An
      * interview never finished — a candidate who recorded two answers and
      * left — used to be exempt for ever, which is the opposite of what a
      * retention policy is for.
      */
     and greatest(coalesce(i.completed_at, i.started_at, i.created_at), coalesce(i.last_seen_at, i.created_at))
         < now() - coalesce(
             make_interval(hours => p.retention_hours),
             make_interval(days => p.retention_days)
           )
   order by 8
   limit greatest(1, p_limit)
$$;
revoke all on function public.rescript_interview_retention_due(integer) from public, anon, authenticated;

/* ------------------------------------------------ customers with interviews */

/* the orphan sweep runs per organization; this is how the cron finds them */
create or replace function public.rescript_interview_customers()
returns table (customer_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct p.customer_id from public.interview_projects p where p.deleted_at is null
$$;
revoke all on function public.rescript_interview_customers() from public, anon, authenticated;

commit;
