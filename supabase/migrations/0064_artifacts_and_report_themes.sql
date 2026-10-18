-- 0064 — Persistent document artifacts & named report themes (2026-10-18,
-- docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md)
--
-- WHAT THIS ADDS — all additive; no existing row or column is touched:
--
--   1. public.artifacts — one row per GENERATED DOCUMENT VERSION (research plan,
--      proposal, SAP, findings report, findings deck): who made it, for which
--      project, what it was made from (the `fingerprint` of its inputs: the
--      definition's hash and revision, the edition, the data stamp, the theme
--      id/version/hash, the narrative mode), where the bytes are (provider,
--      bucket, key — NEVER a signed URL), size, MIME type and SHA-256. A
--      download mints a short-lived signed URL after an access check; nothing
--      is regenerated to download it. The same inputs never make a second row
--      (unique on the fingerprint); new inputs make the next version, and the
--      earlier versions stay as history.
--   2. public.report_themes (+ report_theme_versions) — named report themes
--      saved by an ORGANISATION (scope 'org', customer_id) or a PERSON (scope
--      'user', owner_id). Never global: the five built-ins live in code
--      (`@rescript/analytics` REPORT_THEMES). Saving a theme under a name that
--      exists makes its next version; every version is kept.
--   3. public.report_theme_selections — the theme (and, only when asked for in
--      words, the section order) applied to a project's documents. The theme is
--      kept as applied (a frozen copy plus its ref and version), so a later edit
--      of the saved theme is a new version the project is offered, not imposed.
--   4. the private Storage bucket `rescript-reports` (where the story reports'
--      renders already go) is declared, so it exists before the first document
--      is stored. When Cloudflare R2 is the primary store the bucket is a key
--      prefix there and this row is simply unused.
--
-- ACCESS. Every Studio read and write goes through the guarded service-role
-- routes (0026), where project membership and the module permissions of
-- packages/access are enforced (design documents: project.read; findings
-- documents: analytics.read to list, analytics.export to download). RLS here is
-- the backstop for a direct authenticated connection: members read a project's
-- artifacts, a PRIVATE artifact only by its owner; a theme only by its
-- organisation (org scope) or its owner (user scope). Writes: service role only.
--
-- DEPLOY ORDER: this file first, then the code. Old code never touches these
-- tables. New code before this file: persistence fails soft — the document is
-- still produced and downloaded as before (no link survives a reload), saving a
-- named theme answers "not available yet", built-in themes still apply.
--
-- Re-runnable: `if not exists`, policies dropped and re-created, the bucket
-- insert `on conflict do nothing`. Undo: drop the three tables (and the bucket
-- row only if nothing else uses it).

begin;

-- ======================================================== 1. ARTIFACTS

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  /* the person it belongs to (its creator); a private artifact is theirs alone */
  owner_id uuid,
  created_by uuid,
  type text not null,
  /* the audience edition (executive / client / researcher) or 'standard' */
  edition text not null default 'standard',
  version integer not null,
  fingerprint text not null,
  inputs jsonb not null default '{}'::jsonb,
  storage_provider text not null,
  bucket text not null,
  storage_key text not null,
  file_name text not null,
  mime text not null,
  size_bytes integer not null,
  checksum text not null,
  status text not null default 'ready',
  visibility text not null default 'project',
  source text not null default 'copilot',
  summary text,
  narrative text,
  theme_ref text,
  theme_version integer,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.artifacts drop constraint if exists artifacts_type_check;
alter table public.artifacts add constraint artifacts_type_check
  check (type in ('research_plan_docx', 'proposal_docx', 'sap_docx', 'findings_docx', 'findings_pptx'));
alter table public.artifacts drop constraint if exists artifacts_status_check;
alter table public.artifacts add constraint artifacts_status_check
  check (status in ('ready', 'superseded', 'deleted'));
alter table public.artifacts drop constraint if exists artifacts_visibility_check;
alter table public.artifacts add constraint artifacts_visibility_check
  check (visibility in ('project', 'private'));
alter table public.artifacts drop constraint if exists artifacts_source_check;
alter table public.artifacts add constraint artifacts_source_check
  check (source in ('copilot', 'research_tab', 'workflow', 'api'));
alter table public.artifacts drop constraint if exists artifacts_shape_check;
alter table public.artifacts add constraint artifacts_shape_check
  check (version >= 1 and size_bytes > 0 and checksum ~ '^[0-9a-f]{64}$' and length(fingerprint) between 8 and 128
         and (visibility = 'project' or owner_id is not null) and jsonb_typeof(inputs) = 'object');

comment on table public.artifacts is
  'Generated research documents, one row per content version. storage_key is the reference (never a signed URL); a download signs a short-lived URL after an access check. See docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md.';
comment on column public.artifacts.fingerprint is
  'Hash of everything the document is made from (definition hash + revision, edition, data stamp, theme ref/version/hash, narrative mode, generator version). Same fingerprint = same document = no regeneration.';

/* one row per version of a document line; one live row per fingerprint (per owner, for a private one) */
create unique index if not exists artifacts_version_key on public.artifacts (survey_id, type, edition, version);
create unique index if not exists artifacts_fingerprint_key on public.artifacts
  (survey_id, type, edition, fingerprint, (case when visibility = 'private' then owner_id else '00000000-0000-0000-0000-000000000000'::uuid end))
  where deleted_at is null;
create index if not exists artifacts_survey_idx on public.artifacts (survey_id, type, created_at desc) where deleted_at is null;

alter table public.artifacts enable row level security;
drop policy if exists artifacts_member_read on public.artifacts;
create policy artifacts_member_read on public.artifacts for select to authenticated
  using (
    deleted_at is null
    and public.rescript_project_role(auth.uid(), survey_id) is not null
    and (visibility = 'project' or owner_id = auth.uid())
    or public.rescript_is_platform_admin(auth.uid())
  );

-- ======================================================== 2. NAMED REPORT THEMES

create table if not exists public.report_themes (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  customer_id uuid references public.customers(id) on delete cascade,
  owner_id uuid,
  name text not null,
  /* lower-cased, punctuation-free: "Healthcare Analytics" and "healthcare-analytics" are one name */
  name_key text not null,
  version integer not null default 1,
  theme jsonb not null,
  description text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.report_themes drop constraint if exists report_themes_scope_check;
alter table public.report_themes add constraint report_themes_scope_check
  check ((scope = 'org' and customer_id is not null) or (scope = 'user' and owner_id is not null));
alter table public.report_themes drop constraint if exists report_themes_shape_check;
alter table public.report_themes add constraint report_themes_shape_check
  check (jsonb_typeof(theme) = 'object' and version >= 1 and length(name) between 1 and 80 and length(name_key) between 1 and 80);

create unique index if not exists report_themes_org_name on public.report_themes (customer_id, name_key) where scope = 'org' and deleted_at is null;
create unique index if not exists report_themes_user_name on public.report_themes (owner_id, name_key) where scope = 'user' and deleted_at is null;

drop trigger if exists report_themes_touch on public.report_themes;
create trigger report_themes_touch before update on public.report_themes for each row execute function public.touch_updated_at();

create table if not exists public.report_theme_versions (
  theme_id uuid not null references public.report_themes(id) on delete cascade,
  version integer not null,
  theme jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (theme_id, version)
);

alter table public.report_themes enable row level security;
drop policy if exists report_themes_read on public.report_themes;
create policy report_themes_read on public.report_themes for select to authenticated
  using (
    deleted_at is null and (
      /* current_customer_id() is security definer: a subquery on profiles here would run profiles' own (self-referencing) policy */
      (scope = 'org' and customer_id = public.current_customer_id())
      or (scope = 'user' and owner_id = auth.uid())
    )
    or public.rescript_is_platform_admin(auth.uid())
  );
alter table public.report_theme_versions enable row level security;
drop policy if exists report_theme_versions_read on public.report_theme_versions;
create policy report_theme_versions_read on public.report_theme_versions for select to authenticated
  using (exists (select 1 from public.report_themes t where t.id = theme_id));

-- ======================================================== 3. THE THEME APPLIED TO A PROJECT

create table if not exists public.report_theme_selections (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  theme_ref text,
  theme_version integer,
  theme jsonb,
  structure jsonb,
  applied_by uuid,
  applied_at timestamptz not null default now()
);
alter table public.report_theme_selections drop constraint if exists report_theme_selections_shape_check;
alter table public.report_theme_selections add constraint report_theme_selections_shape_check
  check ((theme is null or jsonb_typeof(theme) = 'object') and (structure is null or jsonb_typeof(structure) = 'object'));

alter table public.report_theme_selections enable row level security;
drop policy if exists report_theme_selections_member_read on public.report_theme_selections;
create policy report_theme_selections_member_read on public.report_theme_selections for select to authenticated
  using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()));

/* the backstop read for a direct authenticated connection (RLS above decides which rows); writes stay with the service role */
grant select on public.artifacts, public.report_themes, public.report_theme_versions, public.report_theme_selections to authenticated;

-- ======================================================== 4. THE PRIVATE BUCKET

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('rescript-reports', 'rescript-reports', false)
    on conflict (id) do nothing;
  end if;
end $$;

commit;
