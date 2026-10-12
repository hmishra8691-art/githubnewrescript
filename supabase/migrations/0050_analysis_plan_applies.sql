-- 0050 — the analysis plan, applied (Data Analytics → Analysis plan).
--
-- "Apply analysis plan" takes the plan written in the survey definition
-- (research.analysisPlan) and makes the Results outputs from it: the saved
-- analyses (analytics_analyses, one per planned id), their charts
-- (analytics_charts), the one findings report and the one dashboard it
-- maintains (analytics_reports), and a run (analytics_runs) when responses
-- exist. This table is the record of each apply: when, by whom, on which
-- plan (its hash and updatedAt) and survey revision, what it did to every
-- planned item, and what it produced — so the workspace can say whether the
-- plan is saved, applied, or applied on a plan that has since changed,
-- rather than guessing from the outputs.
--
-- A `running` row younger than two minutes is also the lock: a second apply
-- of the same survey while one is in progress is refused, so two clicks
-- never create the planned analyses twice.

create table if not exists public.analytics_plan_applies (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'applied', 'partial', 'no_data', 'failed')),
  environment text not null default 'LIVE' check (environment in ('TEST', 'LIVE', 'ALL')),
  dataset jsonb not null default '{}'::jsonb,
  plan_hash text,
  plan_updated_at text,
  survey_revision bigint,
  survey_version text,
  run_id uuid references public.analytics_runs(id) on delete set null,
  report_id uuid references public.analytics_reports(id) on delete set null,
  dashboard_id uuid references public.analytics_reports(id) on delete set null,
  summary jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_by uuid
);
create index if not exists analytics_plan_applies_survey_idx on public.analytics_plan_applies (survey_id, started_at desc);

alter table public.analytics_plan_applies enable row level security;
drop policy if exists analytics_plan_applies_member_read on public.analytics_plan_applies;
create policy analytics_plan_applies_member_read on public.analytics_plan_applies for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );

comment on table public.analytics_plan_applies is
  'Every "Apply analysis plan" on a survey: the plan it applied (hash, updatedAt), what it did to each planned item, and the run, report and dashboard it produced or refreshed. Writes go through the Studio''s service role; members read.';
