-- 0091 — The security posture, back in the migration chain (2026-11-05, platform audit).
--
-- Three findings from the 2026-11-05 audit, all of the same shape: production is safe and the repository
-- cannot reproduce it.
--
-- ## 1. Two SECURITY DEFINER functions executable by anon
--
-- 0081 added four functions and revoked EXECUTE from PUBLIC on exactly two of them. The other two —
-- `rescript_recruitment_project_customer` and `rescript_vendor_integration_customer` — are `security definer`
-- helpers that RLS policies call, and their ACL in the live database reads `=X/postgres … anon=X/postgres`: the
-- leading `=X` is the grant to PUBLIC that every function gets at creation, which 0026 taught this repository to
-- revoke and which every migration from 0083 onward does. Supabase's security advisor reports the same two.
--
-- They leak one uuid each (which customer owns a project / an integration) to anyone holding the published
-- anon key and a guessed id. Not an authentication bypass — but it is the exact gap 0026 closed, reopened.
--
-- `authenticated` KEEPS execute, on 0026's own rule for the four policy helpers: a policy's USING clause is
-- evaluated as the querying role, so a function it calls must be executable by that role. The 0088 and 0089
-- read policies (`quota_progress_read`, `quota_holds_read`) call these two, and proving it on a scratch
-- database — `set role authenticated; select from quota_progress` — fails with "permission denied for function"
-- the moment `authenticated` is revoked. `public` and `anon` lose it; nothing a browser holds can call them.
--
-- ## 2. The 27 tables whose row-level security exists only in production
--
-- Thirteen `analytics_*` tables (0051, 0064 and friends) and fourteen `interview_*` tables (0030 onward) have RLS
-- enabled and a policy in the live database, and no migration that says so. Somebody enabled it by hand in the
-- dashboard. A fresh deployment from this repository would create all 27 with RLS OFF — analytics reports,
-- shares and share-access rows, interview projects, responses, transcripts and media, all readable to any
-- authenticated row-level client. The policies below are the live ones, copied from `pg_policies` on
-- 2026-11-05 (names included, so `create policy` here is a no-op where the dashboard already created them):
--
--   analytics_*   : one `<table>_member_read` SELECT policy for `authenticated`, keyed on
--                   `rescript_project_role(auth.uid(), survey_id)` or platform admin. The three tables with no
--                   `survey_id` (story_versions → via story_reports; story_themes, report_templates → customer) use
--                   the live shape for those too.
--   interview_*   : one `<table>_service_role_only` policy — `for all using (false) with check (false)` — the
--                   explicit deny-all of a table only the service role reads (the service role bypasses RLS).
--
-- Both are what production has. Nothing a user can see today changes; what changes is that a database built
-- from `supabase/migrations/` alone now has the same locks.
--
-- ## 3. A trigger function with a mutable search_path
--
-- `rescript_touch_export_preset` (0042) is the one function in the repository without `set search_path`. It is
-- a plain trigger, not `security definer`, so the usual escalation path does not apply — but the advisor flags
-- it, every other function carries the line, and a trigger that resolves `now()` through a caller-controlled
-- path is a line of defence missing for no reason.
--
-- ## And a mark, so the next audit does not find the probe list sixteen behind again
--
-- `/api/platform` answers "is this database up to date" from a hand-maintained list of probes, one per
-- migration that created something. The list stopped at 0015 once (the route's own header records it) and
-- had stopped at 0074 when this audit ran — a database at 0074 reported as current while missing the quota
-- chain and the whole recruitment exchange. The probe list is extended in the same commit, and from here on
-- each migration also records ITSELF in `schema_marks` on apply. The route reads both: the probes say which
-- features' tables exist, the marks say which migrations ran, and the two disagreeing is itself a finding.
-- Service role only; the Studio's platform page is the one reader.
--
-- Re-runnable: every statement is `if not exists` / `drop … if exists` / idempotent `revoke`. Undo:
--   drop table if exists public.schema_marks;
--   -- the revokes and RLS are a posture, not a feature: leave them.

/* ------------------------------------------------------------------ 1. the two 0081 functions */

revoke all on function public.rescript_recruitment_project_customer(uuid) from public, anon;
revoke all on function public.rescript_vendor_integration_customer(uuid) from public, anon;
grant execute on function public.rescript_recruitment_project_customer(uuid) to authenticated;
grant execute on function public.rescript_vendor_integration_customer(uuid) to authenticated;

/* ------------------------------------------------------------------ 3. the trigger's search_path */

create or replace function public.rescript_touch_export_preset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

/* ------------------------------------------------------------------ 2. analytics_* : member read */

do $$
declare
  t text;
begin
  foreach t in array array[
    'analytics_analyses', 'analytics_analysis_versions', 'analytics_charts', 'analytics_exports',
    'analytics_plan_applies', 'analytics_report_versions', 'analytics_reports', 'analytics_runs',
    'analytics_segments', 'analytics_share_access', 'analytics_shares',
    'analytics_story_renders', 'analytics_story_reports', 'analytics_story_segments'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_member_read') then
      execute format(
        'create policy %I on public.%I for select to authenticated using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()))',
        t || '_member_read', t);
    end if;
  end loop;
end $$;

/* the three analytics tables without a survey_id column — the live policies, verbatim in shape */

alter table if exists public.analytics_story_versions enable row level security;
do $$ begin
  if to_regclass('public.analytics_story_versions') is not null
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analytics_story_versions' and policyname = 'analytics_story_versions_member_read') then
    create policy analytics_story_versions_member_read on public.analytics_story_versions for select to authenticated
      using (exists (
        select 1 from public.analytics_story_reports r
        where r.id = analytics_story_versions.story_id
          and (public.rescript_project_role(auth.uid(), r.survey_id) is not null or public.rescript_is_platform_admin(auth.uid()))));
  end if;
end $$;

alter table if exists public.analytics_story_themes enable row level security;
do $$ begin
  if to_regclass('public.analytics_story_themes') is not null
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analytics_story_themes' and policyname = 'analytics_story_themes_member_read') then
    create policy analytics_story_themes_member_read on public.analytics_story_themes for select to authenticated
      using (
        (survey_id is not null and public.rescript_project_role(auth.uid(), survey_id) is not null)
        or (survey_id is null and exists (select 1 from public.profiles p where p.id = auth.uid() and p.customer_id = analytics_story_themes.customer_id))
        or public.rescript_is_platform_admin(auth.uid()));
  end if;
end $$;

alter table if exists public.analytics_report_templates enable row level security;
do $$ begin
  if to_regclass('public.analytics_report_templates') is not null
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analytics_report_templates' and policyname = 'analytics_report_templates_member_read') then
    create policy analytics_report_templates_member_read on public.analytics_report_templates for select to authenticated
      using (
        exists (select 1 from public.surveys s where s.customer_id = analytics_report_templates.customer_id and public.rescript_project_role(auth.uid(), s.id) is not null)
        or public.rescript_is_platform_admin(auth.uid()));
  end if;
end $$;

/* the two service-role-only analytics tables: RLS on, no policy — deny-all is the intent */
alter table if exists public.analytics_model_jobs enable row level security;
alter table if exists public.analytics_result_cache enable row level security;

/* ------------------------------------------------------------------ 2. interview_* : service role only */

do $$
declare
  t text;
begin
  foreach t in array array[
    'interview_analysis', 'interview_evidence', 'interview_exports', 'interview_jobs', 'interview_media',
    'interview_media_participants', 'interview_people', 'interview_pools', 'interview_project_members',
    'interview_projects', 'interview_questions', 'interview_requirements', 'interview_responses',
    'interview_reviews', 'interview_telemetry', 'interview_transcripts', 'interview_deletions'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    if t <> 'interview_deletions'
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_service_role_only') then
      execute format('create policy %I on public.%I for all using (false) with check (false)', t || '_service_role_only', t);
    end if;
  end loop;
end $$;

/* ------------------------------------------------------------------ 4. the mark */

create table if not exists public.schema_marks (
  migration  text primary key,
  applied_at timestamptz not null default now(),
  note       text
);
comment on table public.schema_marks is
  'One row per migration that ran, written by the migration itself from 0091 on (the platform audit found the /api/platform probe list sixteen migrations behind). Service role only; /api/platform reads it beside its probes.';
alter table public.schema_marks enable row level security;
revoke all on table public.schema_marks from public, anon, authenticated;

insert into public.schema_marks (migration, note) values
  ('0091', 'security posture in the chain: 0081 revokes, 27 tables'' RLS, touch_export_preset search_path, schema_marks')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
