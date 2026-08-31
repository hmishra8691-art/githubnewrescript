-- Rescript Survey Platform — core schema
-- Multi-tenant: every business row hangs off a customer; RLS isolates tenants.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- customers
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ profiles
-- One row per auth user; carries tenant + role.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  email text,
  full_name text,
  role text not null default 'viewer'
    check (role in ('platform_admin','programmer','researcher','client','viewer')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- surveys
create table public.surveys (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  code text not null,
  title text not null,
  status text not null default 'draft' check (status in ('draft','testing','live','closed')),
  current_version_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, code)
);

-- ----------------------------------------------------------- survey_versions
-- Immutable snapshots: the full JSON definition per version (req. §12).
create table public.survey_versions (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  version text not null,
  definition jsonb not null,
  label text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (survey_id, version)
);

alter table public.surveys
  add constraint surveys_current_version_fk
  foreign key (current_version_id) references public.survey_versions(id)
  deferrable initially deferred;

-- --------------------------------------------------------------- deployments
-- A live URL is pinned to ONE version; later edits never change it (req. §12/21).
create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  version_id uuid not null references public.survey_versions(id),
  client_slug text not null,
  study_slug text not null,
  mode text not null default 'live' check (mode in ('test','live')),
  active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (client_slug, study_slug, mode)
);

-- -------------------------------------------------------- themes & templates
create table public.themes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  name text not null,
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade, -- null = global
  name text not null,
  description text,
  definition jsonb not null,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------- design_files
create table public.design_files (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  kind text not null,               -- conjoint | maxdiff | custom | plugin kinds
  name text not null,
  version int not null default 1,
  seed bigint,
  config jsonb not null default '{}'::jsonb,
  columns jsonb not null default '[]'::jsonb,
  rows jsonb not null default '[]'::jsonb,
  summary jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (survey_id, kind, name, version)
);

-- --------------------------------------------------------------- respondents
create table public.respondents (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  email text,
  external_id text,
  status text not null default 'invited'
    check (status in ('invited','started','complete','screened','quota_full','terminated')),
  embedded jsonb not null default '{}'::jsonb,
  invited_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);

-- ----------------------------------------------------------------- responses
create table public.responses (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  version_id uuid not null references public.survey_versions(id),
  session_id text not null unique,
  respondent_id uuid references public.respondents(id) on delete set null,
  status text not null default 'in_progress'
    check (status in ('in_progress','complete','screened','quota_full','terminated')),
  is_test boolean not null default false,
  seed bigint not null default 0,
  step_index int not null default 0,
  answers jsonb not null default '{}'::jsonb,
  calculated jsonb not null default '{}'::jsonb,
  embedded jsonb not null default '{}'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  user_agent text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index responses_survey_idx on public.responses (survey_id, status);

-- -------------------------------------------------------------- quota_counts
create table public.quota_counts (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  quota_id text not null,
  cell_id text not null,
  count int not null default 0,
  primary key (survey_id, quota_id, cell_id)
);

-- --------------------------------------------------------------- audit_logs
create table public.audit_logs (
  id bigint generated always as identity primary key,
  customer_id uuid references public.customers(id) on delete set null,
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------------- RPCs
-- Atomic quota increment used on completion.
create or replace function public.increment_quota_counts(
  p_survey_id uuid,
  p_cells jsonb  -- [{"quotaId": "...", "cellId": "..."}]
) returns void
language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  for c in select * from jsonb_array_elements(p_cells) loop
    insert into public.quota_counts (survey_id, quota_id, cell_id, count)
    values (p_survey_id, c->>'quotaId', c->>'cellId', 1)
    on conflict (survey_id, quota_id, cell_id)
    do update set count = public.quota_counts.count + 1;
  end loop;
end $$;

-- ---------------------------------------------------------------------- RLS
alter table public.customers enable row level security;
alter table public.profiles enable row level security;
alter table public.surveys enable row level security;
alter table public.survey_versions enable row level security;
alter table public.deployments enable row level security;
alter table public.themes enable row level security;
alter table public.templates enable row level security;
alter table public.design_files enable row level security;
alter table public.respondents enable row level security;
alter table public.responses enable row level security;
alter table public.quota_counts enable row level security;
alter table public.audit_logs enable row level security;

-- helper: current user's customer + role
create or replace function public.current_customer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select customer_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- profiles: user sees own row; platform_admin sees all
create policy profiles_self on public.profiles
  for select using (id = auth.uid() or public.current_role() = 'platform_admin');
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid());

-- customers: members read their customer; platform_admin all
create policy customers_read on public.customers
  for select using (id = public.current_customer_id() or public.current_role() = 'platform_admin');

-- tenant-scoped read for survey data
create policy surveys_tenant on public.surveys
  for select using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');
create policy surveys_write on public.surveys
  for all using (
    (customer_id = public.current_customer_id() and public.current_role() in ('platform_admin','programmer'))
    or public.current_role() = 'platform_admin'
  );

create policy versions_tenant on public.survey_versions
  for select using (
    exists (select 1 from public.surveys s where s.id = survey_id
            and (s.customer_id = public.current_customer_id() or public.current_role() = 'platform_admin'))
  );
create policy versions_write on public.survey_versions
  for all using (
    exists (select 1 from public.surveys s where s.id = survey_id
            and s.customer_id = public.current_customer_id()
            and public.current_role() in ('platform_admin','programmer'))
  );

create policy deployments_tenant on public.deployments
  for select using (
    exists (select 1 from public.surveys s where s.id = survey_id
            and (s.customer_id = public.current_customer_id() or public.current_role() = 'platform_admin'))
  );

create policy themes_tenant on public.themes
  for all using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');

create policy templates_read on public.templates
  for select using (customer_id is null or customer_id = public.current_customer_id()
                    or public.current_role() = 'platform_admin');

create policy design_files_tenant on public.design_files
  for all using (
    exists (select 1 from public.surveys s where s.id = survey_id
            and (s.customer_id = public.current_customer_id() or public.current_role() = 'platform_admin'))
  );

-- respondents / responses / quota_counts: NO anon or authenticated policies —
-- only the service role (server-side API) touches them. Researchers/clients
-- read responses through server endpoints that enforce tenancy.
create policy responses_tenant_read on public.responses
  for select using (
    exists (select 1 from public.surveys s where s.id = survey_id
            and (s.customer_id = public.current_customer_id() or public.current_role() = 'platform_admin'))
  );
create policy quota_counts_read on public.quota_counts
  for select using (
    exists (select 1 from public.surveys s where s.id = survey_id
            and (s.customer_id = public.current_customer_id() or public.current_role() = 'platform_admin'))
  );

create policy audit_read on public.audit_logs
  for select using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger surveys_touch before update on public.surveys
  for each row execute function public.touch_updated_at();
create trigger responses_touch before update on public.responses
  for each row execute function public.touch_updated_at();
