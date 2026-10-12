-- 0051 — animated research reports: one versioned definition, two outputs.
--
-- Results → Reports → Create report makes a STORY REPORT: a scene-by-scene
-- definition (StoryReport, @rescript/analytics/story) proposed from the
-- applied analysis plan and its latest run, edited in the storyboard, and
-- exported as an editable PowerPoint and/or a rendered MP4. Both outputs are
-- made from the same saved version, and every artifact records the version
-- it was made from.
--
--   analytics_story_reports   the report: its current definition and version, status
--   analytics_story_versions  every saved version (immutable): compare, revert
--   analytics_story_renders   every export job: kind, version, plan, progress, QA, providers, artifact
--   analytics_story_segments  rendered scene segments by content hash (re-used across renders)
--   analytics_story_themes    saved designs at workspace (customer) or project level
--
-- One active render per report and output: a unique partial index refuses a
-- second "Render" while one is queued or running, so a double click never
-- pays twice. Writes go through the Studio's service role; members read.

create table if not exists public.analytics_story_reports (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  title text not null,
  definition jsonb not null,
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'ready_for_review', 'validation_required', 'ready_to_render', 'rendering', 'completed', 'failed')),
  outputs jsonb not null default '{"pptx": true, "video": true}'::jsonb,
  -- what the report was proposed with (audience, findings cap, sections left out, dataset), for regenerating it the same way
  options jsonb not null default '{}'::jsonb,
  run_id uuid references public.analytics_runs(id) on delete set null,
  environment text not null default 'LIVE' check (environment in ('TEST', 'LIVE', 'ALL')),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists analytics_story_reports_survey_idx on public.analytics_story_reports (survey_id, deleted_at, updated_at desc);

create table if not exists public.analytics_story_versions (
  id bigint generated always as identity primary key,
  story_id uuid not null references public.analytics_story_reports(id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  note text,
  changes jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (story_id, version)
);

create table if not exists public.analytics_story_renders (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.analytics_story_reports(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  version integer not null,
  kind text not null check (kind in ('video', 'pptx')),
  status text not null default 'queued' check (status in ('queued', 'rendering', 'verifying', 'completed', 'failed', 'cancelled')),
  plan_hash text,
  plan jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  qa jsonb,
  providers jsonb not null default '[]'::jsonb,
  estimate jsonb,
  storage_provider text,
  bucket text,
  path text,
  bytes bigint,
  error text,
  attempts integer not null default 0,
  lease_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz
);
create index if not exists analytics_story_renders_story_idx on public.analytics_story_renders (story_id, created_at desc);
create index if not exists analytics_story_renders_pending_idx on public.analytics_story_renders (status, lease_until) where status in ('queued', 'rendering', 'verifying');
create unique index if not exists analytics_story_renders_one_active on public.analytics_story_renders (story_id, kind) where status in ('queued', 'rendering', 'verifying');

create table if not exists public.analytics_story_segments (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  hash text not null,
  storage_provider text not null,
  bucket text not null,
  path text not null,
  bytes bigint not null,
  seconds numeric not null,
  created_at timestamptz not null default now(),
  primary key (survey_id, hash)
);

create table if not exists public.analytics_story_themes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  name text not null,
  design jsonb not null,
  brand jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (customer_id is not null or survey_id is not null)
);
create index if not exists analytics_story_themes_scope_idx on public.analytics_story_themes (customer_id, survey_id, deleted_at);

do $$
declare t text;
begin
  foreach t in array array['analytics_story_reports', 'analytics_story_versions', 'analytics_story_renders', 'analytics_story_segments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_read', t);
  end loop;
end $$;

create policy analytics_story_reports_member_read on public.analytics_story_reports for select to authenticated
  using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()));
create policy analytics_story_versions_member_read on public.analytics_story_versions for select to authenticated
  using (exists (select 1 from public.analytics_story_reports r where r.id = story_id and (public.rescript_project_role(auth.uid(), r.survey_id) is not null or public.rescript_is_platform_admin(auth.uid()))));
create policy analytics_story_renders_member_read on public.analytics_story_renders for select to authenticated
  using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()));
create policy analytics_story_segments_member_read on public.analytics_story_segments for select to authenticated
  using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()));

alter table public.analytics_story_themes enable row level security;
drop policy if exists analytics_story_themes_member_read on public.analytics_story_themes;
create policy analytics_story_themes_member_read on public.analytics_story_themes for select to authenticated
  using (
    (survey_id is not null and public.rescript_project_role(auth.uid(), survey_id) is not null)
    or (survey_id is null and exists (select 1 from public.profiles p where p.id = auth.uid() and p.customer_id = analytics_story_themes.customer_id))
    or public.rescript_is_platform_admin(auth.uid())
  );

comment on table public.analytics_story_reports is
  'Animated research reports: a versioned scene-by-scene definition (StoryReport) that both the editable PowerPoint and the rendered video are made from. Writes through the Studio service role; members read.';
comment on table public.analytics_story_renders is
  'Every PowerPoint or video export of a story report: the version it was made from, its plan hash, progress, quality checks, the providers used, and the stored artifact. One queued/running render per report and output.';
