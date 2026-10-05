-- 0046 — analysis runs (research-intelligence Phase 5).
--
-- A run is the analysis plan executed once on one dataset: the findings read
-- from the results, the hypothesis verdicts, and which chart each planned
-- analysis is best shown as. Runs are made at fieldwork milestones (first
-- readable base, halfway, target, end of field) by the cron, or on request;
-- results themselves are recomputed from the responses when opened, so only
-- the compact run is stored. Read by the Intelligent copilot's Findings tab
-- and sent with the copilot's analysis turns.

create table if not exists public.analytics_runs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  trigger text not null,
  environment text not null default 'LIVE' check (environment in ('TEST', 'LIVE', 'ALL')),
  n integer not null default 0,
  dataset jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  findings jsonb not null default '[]'::jsonb,
  verdicts jsonb not null default '[]'::jsonb,
  items jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  survey_version text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists analytics_runs_survey_idx on public.analytics_runs (survey_id, computed_at desc);

alter table public.analytics_runs enable row level security;
drop policy if exists analytics_runs_member_read on public.analytics_runs;
create policy analytics_runs_member_read on public.analytics_runs for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );
