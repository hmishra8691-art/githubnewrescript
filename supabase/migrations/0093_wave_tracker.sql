-- 0093 — MULTI-WAVE TRACKER (2026-11-09, Rapid Studio phase 3).
--
-- A tracker's waves are datasets the platform did not necessarily collect: wave 1 fielded elsewhere and uploaded,
-- wave 4 this survey's own LIVE completes. Each wave is kept as it arrived (its columns, labels and rows) so a new wave
-- is connected to the tracker without rebuilding anything: the mapping to the baseline, the harmonised dataset, the
-- KPIs and every significance test are recomputed from these rows by packages/analytics/src/waveTracker.ts.
--
-- Nothing here touches `responses`: an uploaded wave never becomes a respondent of this survey, never counts toward a
-- quota and never appears in the Data tab or a client export of this survey's data.
--
-- Reached only through the Studio routes (service role, after requireProject): no grants to anon or authenticated.

begin;

create table if not exists public.tracker_waves (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  label text not null,
  wave_order integer not null,
  source text not null default 'upload',
  file_name text,
  -- [{ name, label?, values?: [{ code, label }] }]
  columns jsonb not null default '[]'::jsonb,
  -- [{ <column name>: value }]
  rows jsonb not null default '[]'::jsonb,
  row_count integer not null default 0,
  notes jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tracker_waves_shape check (
    length(label) between 1 and 80
    and source in ('upload', 'survey')
    and jsonb_typeof(columns) = 'array' and jsonb_typeof(rows) = 'array' and jsonb_typeof(notes) = 'array'
    and row_count between 0 and 20000
    and wave_order between 0 and 1000
  )
);
create index if not exists tracker_waves_survey_idx on public.tracker_waves (survey_id, wave_order) where deleted_at is null;

create table if not exists public.wave_trackers (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  -- { kpis: [...], composition: [...], segment, alpha, manual: { <waveId>: { <base variable>: <wave variable> | null } } }
  config jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint wave_trackers_config check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 262144)
);

alter table public.tracker_waves enable row level security;
alter table public.wave_trackers enable row level security;
revoke all on public.tracker_waves from anon, authenticated;
revoke all on public.wave_trackers from anon, authenticated;

comment on table public.tracker_waves is 'Datasets of a multi-wave tracker, one row per wave, kept as uploaded. Never responses of the survey. See packages/analytics/src/waveTracker.ts.';
comment on table public.wave_trackers is 'The tracker configuration of a survey: KPIs, composition checks, segment, manual variable mappings.';

commit;
