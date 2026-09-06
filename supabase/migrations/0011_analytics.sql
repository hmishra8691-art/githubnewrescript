-- 0011 — Data Analytics, Visualization, Reporting, Sharing & Export.
--
-- Everything here is DERIVED from the response data the platform already
-- stores. No table below holds a copy of a response, a user, a project or a
-- variable definition: an analysis remembers WHICH survey, dataset, variables,
-- filters, segments, weighting, method and settings to use (§39) and is
-- recomputed from `responses` on demand. The one place numbers are stored is a
-- PUBLISHED REPORT VERSION (§34) — an immutable snapshot of the results a
-- researcher chose to publish, which is the only thing a public share link can
-- ever reach (§28). Raw response rows are never reachable through a share.
--
-- Access follows the project: every table hangs off `survey_id` and inherits
-- the project's membership test for reads; writes go through the studio's
-- service-role routes, which check capabilities (`analytics.read / edit /
-- publish / export`) with `requireProject`. Share tokens are resolved by a
-- security-definer function that returns the snapshot and nothing else.

-- ------------------------------------------------------------ analyses
create table if not exists public.analytics_analyses (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  name text not null,
  kind text not null,
  -- the full AnalysisDefinition (dataset, variables, filters, segments, weighting, options, surveyVersion)
  definition jsonb not null,
  version integer not null default 1,
  folder text,
  tags text[] not null default '{}',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists analytics_analyses_survey_idx on public.analytics_analyses (survey_id, deleted_at);

-- every saved change to a definition is a version (§25): styling never lands here
create table if not exists public.analytics_analysis_versions (
  id bigint generated always as identity primary key,
  analysis_id uuid not null references public.analytics_analyses(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  summary text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (analysis_id, version)
);

-- ------------------------------------------------------------ charts
create table if not exists public.analytics_charts (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  analysis_id uuid not null references public.analytics_analyses(id) on delete cascade,
  name text not null,
  -- ChartSpec: type + options; styling changes bump `style_version`, never the analysis version
  spec jsonb not null,
  theme_id uuid,
  style_version integer not null default 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists analytics_charts_survey_idx on public.analytics_charts (survey_id, deleted_at);
create index if not exists analytics_charts_analysis_idx on public.analytics_charts (analysis_id);

-- ------------------------------------------------------------ segments & filters
create table if not exists public.analytics_segments (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  kind text not null default 'segment' check (kind in ('segment', 'filter')),
  name text not null,
  description text,
  color text,
  -- an ordinary survey Condition, evaluated by the survey engine
  condition jsonb not null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists analytics_segments_survey_idx on public.analytics_segments (survey_id, kind, deleted_at);

-- ------------------------------------------------------------ report themes (company branding, reusable across surveys)
create table if not exists public.analytics_themes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  name text not null,
  theme jsonb not null,
  is_default boolean not null default false,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists analytics_themes_customer_idx on public.analytics_themes (customer_id, deleted_at);

-- ------------------------------------------------------------ reports & dashboards
create table if not exists public.analytics_reports (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  kind text not null default 'report' check (kind in ('report', 'dashboard')),
  name text not null,
  -- ReportDefinition / DashboardDefinition (blocks or widgets, theme, mode, viewer segments)
  definition jsonb not null,
  theme_id uuid references public.analytics_themes(id) on delete set null,
  mode text not null default 'live' check (mode in ('live', 'snapshot')),
  published_version integer,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists analytics_reports_survey_idx on public.analytics_reports (survey_id, kind, deleted_at);

-- a published version is immutable (§34): definition, theme AND the computed results at publish time
create table if not exists public.analytics_report_versions (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.analytics_reports(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  theme jsonb,
  -- { [analysisId]: AnalysisResult } — tables, chart data, tests, insights, bases. Never raw rows.
  snapshot jsonb not null,
  dataset jsonb,               -- DatasetSpec + response count + survey version the snapshot came from
  note text,
  published_by uuid,
  published_at timestamptz not null default now(),
  unique (report_id, version)
);

-- ------------------------------------------------------------ sharing
create table if not exists public.analytics_shares (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  report_id uuid not null references public.analytics_reports(id) on delete cascade,
  -- an opaque, unguessable URL token (32 bytes base64url)
  token text not null unique,
  access text not null default 'link' check (access in ('private', 'users', 'link')),
  permission text not null default 'viewer' check (permission in ('viewer', 'download')),
  -- pinned to a published version; null = the report's current published version at view time
  report_version integer,
  password_hash text,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  -- specific users (by user id) for access = 'users'; emails kept for invitations that have not signed in yet
  allowed_user_ids uuid[] not null default '{}',
  allowed_emails text[] not null default '{}',
  label text,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists analytics_shares_report_idx on public.analytics_shares (report_id, revoked_at);

create table if not exists public.analytics_share_access (
  id bigint generated always as identity primary key,
  share_id uuid not null references public.analytics_shares(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  viewer_user_id uuid,
  viewer_email text,
  event text not null check (event in ('view', 'download_pptx', 'download_xlsx', 'denied')),
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists analytics_share_access_share_idx on public.analytics_share_access (share_id, created_at desc);

-- ------------------------------------------------------------ exports (audit of generated files)
create table if not exists public.analytics_exports (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  report_id uuid references public.analytics_reports(id) on delete set null,
  analysis_id uuid references public.analytics_analyses(id) on delete set null,
  format text not null check (format in ('pptx', 'xlsx')),
  settings jsonb not null default '{}'::jsonb,
  report_version integer,
  bytes integer,
  created_by uuid,
  share_id uuid references public.analytics_shares(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['analytics_analyses', 'analytics_charts', 'analytics_segments', 'analytics_themes', 'analytics_reports'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ------------------------------------------------------------ RLS: members read, service role writes
do $$
declare t text;
begin
  foreach t in array array[
    'analytics_analyses', 'analytics_analysis_versions', 'analytics_charts', 'analytics_segments',
    'analytics_reports', 'analytics_report_versions', 'analytics_shares', 'analytics_share_access', 'analytics_exports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_member_read on public.%I', t, t);
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (
          public.rescript_project_role(auth.uid(), survey_id) is not null
          or public.rescript_is_platform_admin(auth.uid())
        )
    $f$, t, t);
  end loop;
end $$;

alter table public.analytics_themes enable row level security;
drop policy if exists analytics_themes_read on public.analytics_themes;
create policy analytics_themes_read on public.analytics_themes for select to authenticated
  using (
    (survey_id is not null and public.rescript_project_role(auth.uid(), survey_id) is not null)
    or (customer_id is not null and customer_id = (select p.customer_id from public.profiles p where p.id = auth.uid()))
    or public.rescript_is_platform_admin(auth.uid())
  );

-- ------------------------------------------------------------ share resolution
-- THE ONLY DOOR A PUBLIC LINK HAS. Given a token, return the published snapshot
-- the share points at — never the report's draft, never the analyses' live
-- definitions, never a response. Checks revocation and expiry here so a caller
-- cannot forget to. Password and user checks stay in the route (they need the
-- session / a hash comparison), but the route can only receive what this
-- function hands back.
create or replace function public.rescript_resolve_share(p_token text)
returns table (
  share_id uuid, survey_id uuid, report_id uuid, report_name text, permission text, access text,
  requires_password boolean, allowed_user_ids uuid[], allowed_emails text[],
  version integer, definition jsonb, theme jsonb, snapshot jsonb, dataset jsonb, published_at timestamptz, status text
)
language plpgsql stable security definer set search_path = public as $$
declare s public.analytics_shares%rowtype; v public.analytics_report_versions%rowtype; r public.analytics_reports%rowtype;
begin
  select * into s from public.analytics_shares sh where sh.token = p_token;
  if not found then return; end if;
  select * into r from public.analytics_reports rp where rp.id = s.report_id and rp.deleted_at is null;
  if not found then
    return query select s.id, s.survey_id, s.report_id, null::text, s.permission, s.access, false, s.allowed_user_ids, s.allowed_emails, null::integer, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::timestamptz, 'missing'::text; return;
  end if;
  if s.revoked_at is not null then
    return query select s.id, s.survey_id, s.report_id, r.name, s.permission, s.access, false, s.allowed_user_ids, s.allowed_emails, null::integer, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::timestamptz, 'revoked'::text; return;
  end if;
  if s.expires_at is not null and s.expires_at < now() then
    return query select s.id, s.survey_id, s.report_id, r.name, s.permission, s.access, false, s.allowed_user_ids, s.allowed_emails, null::integer, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::timestamptz, 'expired'::text; return;
  end if;
  select * into v from public.analytics_report_versions rv
    where rv.report_id = s.report_id and rv.version = coalesce(s.report_version, r.published_version)
    order by rv.version desc limit 1;
  if not found then
    return query select s.id, s.survey_id, s.report_id, r.name, s.permission, s.access, s.password_hash is not null, s.allowed_user_ids, s.allowed_emails, null::integer, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::timestamptz, 'unpublished'::text; return;
  end if;
  return query select s.id, s.survey_id, s.report_id, r.name, s.permission, s.access, s.password_hash is not null, s.allowed_user_ids, s.allowed_emails,
    v.version, v.definition, v.theme, v.snapshot, v.dataset, v.published_at, 'ok'::text;
end $$;

-- record a view / download on a share and bump its counters (called by the public route)
create or replace function public.rescript_record_share_access(p_share uuid, p_event text, p_user uuid, p_email text, p_ip_hash text, p_agent text)
returns void language plpgsql security definer set search_path = public as $$
declare sv uuid;
begin
  select survey_id into sv from public.analytics_shares where id = p_share;
  if sv is null then return; end if;
  insert into public.analytics_share_access (share_id, survey_id, viewer_user_id, viewer_email, event, ip_hash, user_agent)
    values (p_share, sv, p_user, p_email, p_event, p_ip_hash, left(coalesce(p_agent, ''), 300));
  if p_event = 'view' then
    update public.analytics_shares set view_count = view_count + 1, last_viewed_at = now() where id = p_share;
  end if;
end $$;

comment on table public.analytics_report_versions is
  'Immutable published report versions: definition + theme + computed results snapshot. The only content a share link can reach.';
comment on function public.rescript_resolve_share(text) is
  'Resolve a share token to its published snapshot; enforces revocation and expiry. Never returns response rows.';
