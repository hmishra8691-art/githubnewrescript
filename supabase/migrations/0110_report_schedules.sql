-- 0110 — REPORT REFRESH, SCHEDULED DELIVERY AND METRIC ALERTS (Level 5 roadmap R5 + R6, 2026-11-22).
--
--   report_schedules   one row per schedule on a report or dashboard:
--                        kind 'report'  re-compute on a schedule (or on demand), render it (PowerPoint, PDF, Word or
--                                       Excel), keep what changed since the last run, and email the recipients a
--                                       summary with a link (a sign-in link to the Studio file; the share link when
--                                       one is named) — no file is attached and no bearer link to a file is mailed
--                        kind 'alert'   re-compute, and email when a metric crosses its threshold (once per crossing)
--                      cadence daily / weekly / monthly at an hour in UTC; `last_digest` is the handful of numbers the
--                      next run compares with (packages/analytics/src/reportSchedule.ts), never response rows
--   report_runs        each run: when, why (schedule / manual), the change summary, the stored file, how many emails
--                      went, whether the alert fired, or the error
--
-- Additive. Service role only: row-level security on, no policy (the Studio and the hourly job read and write through
-- the service client after their own checks). Also widens mail_deliveries.kind with report_delivery and metric_alert.
--
-- Rollback:
--   drop table if exists public.report_runs, public.report_schedules;

create table if not exists public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  report_id uuid not null references public.analytics_reports(id) on delete cascade,
  share_id uuid references public.analytics_shares(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null check (kind in ('report', 'alert')),
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  hour_utc smallint not null default 7 check (hour_utc between 0 and 23),
  weekday smallint check (weekday is null or weekday between 0 and 6),
  day_of_month smallint check (day_of_month is null or day_of_month between 1 and 31),
  format text check (format is null or format in ('pptx', 'pdf', 'docx', 'xlsx')),
  recipients text[] not null default '{}' check (cardinality(recipients) <= 50),
  alert jsonb,
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_digest jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'alert' or alert is not null),
  check (kind <> 'report' or format is not null)
);
create index if not exists report_schedules_due_idx on public.report_schedules (next_run_at) where enabled;
create index if not exists report_schedules_report_idx on public.report_schedules (report_id);
alter table public.report_schedules enable row level security;

create table if not exists public.report_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.report_schedules(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null check (status in ('ok', 'failed', 'skipped')),
  headline text check (headline is null or char_length(headline) <= 1000),
  changes jsonb,
  alert jsonb,
  storage_provider text,
  bucket text,
  path text,
  bytes integer,
  delivered integer not null default 0,
  error text check (error is null or char_length(error) <= 1000),
  ran_at timestamptz not null default now()
);
create index if not exists report_runs_schedule_idx on public.report_runs (schedule_id, ran_at desc);
alter table public.report_runs enable row level security;

revoke all on public.report_schedules, public.report_runs from anon, authenticated;

-- ------------------------------------------------------------------ the mail kinds for deliveries and alerts
do $$
declare
  def text;
  kinds text[];
begin
  if to_regclass('public.mail_deliveries') is null then return; end if;
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c where c.conrelid = 'public.mail_deliveries'::regclass and c.conname = 'mail_deliveries_kind_check';
  select array_agg(distinct k order by k) into kinds from (
    select (regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g'))[1] as k
    union select trim(x) from unnest(string_to_array(coalesce(substring(def from '\{([^}]*)\}'), ''), ',')) as x
    union select distinct kind from public.mail_deliveries
    union select 'report_delivery'
    union select 'metric_alert'
  ) x where k is not null and k <> '';
  execute 'alter table public.mail_deliveries drop constraint if exists mail_deliveries_kind_check';
  execute format('alter table public.mail_deliveries add constraint mail_deliveries_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

insert into public.schema_marks (migration, note) values ('0110', 'report schedules, runs; mail kinds report_delivery, metric_alert')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
