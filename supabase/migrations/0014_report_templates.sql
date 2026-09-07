-- =====================================================================
-- 0014 — REPORT TEMPLATES AND VIEWER FILTERS (§36)
--
-- Two additions to the analytics layer, for the two things the reporting
-- audit found missing that the schema could not express.
--
-- §36.1  REPORT TEMPLATES. A team reports the same way every time — cover,
--        executive summary, a section per topic, methodology at the back —
--        and rebuilding that block by block for every wave of every tracker
--        is the most repeated piece of work in reporting. Three templates
--        ship in code (`BUILT_IN_REPORT_TEMPLATES`); this table is where a
--        team's own house shapes live.
--
--        Keyed on the CUSTOMER, like `analytics_themes` and unlike every
--        other analytics table: a house report shape belongs to the
--        workspace, not to whichever study it was first drawn in. That is
--        the whole reason to have templates rather than copying a report.
--
-- §36.2  VIEWER FILTERS, precomputed. A shared report is a frozen snapshot
--        and its public page has no dataset access — deliberately, and that
--        does not change here. What changes is that publishing can freeze
--        MORE than one set of results: the base, plus one per filter the
--        author allows a viewer to apply. Switching filter in a shared
--        report then reads a pre-computed answer, exactly as switching
--        segment already does, and the public page still cannot compose a
--        condition or reach a response row.
--
-- Both are additive. `analytics_report_versions.snapshot` keeps its exact
-- shape, so every version already published still reads correctly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §36.1  A team's own report shapes
-- ---------------------------------------------------------------------
create table if not exists public.analytics_report_templates (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null,
  description text,
  /* the shape: blocks with no analysis ids, plus optional export defaults */
  template jsonb not null default '{}'::jsonb,
  /*
   * The survey it was saved FROM, kept for provenance only — a template is
   * workspace-wide and is never scoped to this survey. Nullable, and set null
   * rather than cascading, because deleting the study a template was drawn
   * from must not delete the template.
   */
  source_survey_id uuid references public.surveys(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint analytics_report_templates_name_not_blank check (length(trim(name)) > 0)
);

-- one template per name per workspace: a name is the handle a team picks it
-- by, and two "Tracker wave" templates in a picker is a coin toss
create unique index if not exists analytics_report_templates_name_key
  on public.analytics_report_templates (customer_id, lower(name))
  where deleted_at is null;

create index if not exists analytics_report_templates_customer_idx
  on public.analytics_report_templates (customer_id)
  where deleted_at is null;

comment on table public.analytics_report_templates is
  'Reusable report structures for one workspace: the shape of a deliverable without the study in it. Workspace-scoped like analytics_themes, because a house report shape is not owned by whichever survey it was first drawn in.';

alter table public.analytics_report_templates enable row level security;

/*
 * The same policy shape `analytics_themes` uses (0011): a member of ANY
 * project in the workspace may read the workspace's templates. Writes go
 * through the API on the service role, gated on `analytics.edit`.
 */
drop policy if exists analytics_report_templates_member_read on public.analytics_report_templates;
create policy analytics_report_templates_member_read on public.analytics_report_templates
  for select to authenticated
  using (
    exists (
      select 1 from public.surveys s
      where s.customer_id = analytics_report_templates.customer_id
        and (public.rescript_project_role(auth.uid(), s.id) is not null)
    )
    or public.rescript_is_platform_admin(auth.uid())
  );

grant select on public.analytics_report_templates to authenticated;

create or replace function public.rescript_touch_report_template()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists analytics_report_templates_touch on public.analytics_report_templates;
create trigger analytics_report_templates_touch
  before update on public.analytics_report_templates
  for each row execute function public.rescript_touch_report_template();

-- ---------------------------------------------------------------------
-- §36.2  More than one frozen answer per published version
--
-- `snapshot` is `{[analysisId]: AnalysisResult}` and stays exactly that —
-- it is what every already-published version contains and what the share
-- route reads today. `variants` is a sibling:
--
--   { filters: [{ id, name }], results: { [filterId]: { [analysisId]: … } } }
--
-- The filter NAMES are frozen with it on purpose. A filter renamed or
-- redefined in the workspace next month must not change the labels on a
-- report that was published today — a published version is a record of what
-- was said, and that includes what the buttons said.
--
-- Nullable, so a version published before this migration (or one whose
-- report allows no viewer filters) simply has none — and a reader that has
-- never heard of variants keeps working.
-- ---------------------------------------------------------------------
alter table public.analytics_report_versions
  add column if not exists variants jsonb;

comment on column public.analytics_report_versions.variants is
  'Pre-computed results per allowed viewer filter: {filters:[{id,name}], results:{filterId:{analysisId:AnalysisResult}}}. Frozen at publish time — including the filter names — so a shared report can switch filter without dataset access. Null when the report allows no viewer filters.';

-- ---------------------------------------------------------------------
-- What a PUBLIC viewer may see of them
--
-- `rescript_resolve_share` is the one door the public share route reads
-- through, and its own comment explains why: the route can only ever
-- receive what that function hands back. Its return type is not widened
-- here — replacing it would mean dropping a function every live share link
-- depends on — so the variants get their own door, with the same
-- properties: security definer, keyed on the SHARE rather than on a report
-- or a version, and returning nothing at all for a share that is revoked,
-- expired, or pinned to a version that no longer exists.
--
-- A viewer therefore cannot ask for another report's variants, or for a
-- version their link was not issued against, even knowing the ids.
-- ---------------------------------------------------------------------
create or replace function public.rescript_resolve_share_variants(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.analytics_shares%rowtype;
  r public.analytics_reports%rowtype;
  v public.analytics_report_versions%rowtype;
begin
  select * into s from public.analytics_shares sh where sh.token = p_token;
  if not found then return null; end if;
  if s.revoked_at is not null then return null; end if;
  if s.expires_at is not null and s.expires_at < now() then return null; end if;

  select * into r from public.analytics_reports rp
    where rp.id = s.report_id and rp.deleted_at is null;
  if not found then return null; end if;

  select * into v from public.analytics_report_versions rv
    where rv.report_id = s.report_id
      and rv.version = coalesce(s.report_version, r.published_version)
    order by rv.version desc limit 1;
  if not found then return null; end if;

  return v.variants;
end $$;

comment on function public.rescript_resolve_share_variants(text) is
  'The frozen viewer-filter results for the version a share token resolves to, or null. A second door beside rescript_resolve_share, so that function''s return type need not be replaced.';

grant execute on function public.rescript_resolve_share_variants(text) to anon, authenticated, service_role;
