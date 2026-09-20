-- =====================================================================
-- §44.4  DATA EXPORT PRESETS
--
-- A saved set of export choices — format, codes or labels, which dataset,
-- whether the data dictionary travels with it — under a name a team
-- recognises: "SPSS Research Export", "Client Data Export", "Raw Data".
--
-- WORKSPACE-SCOPED, not survey-scoped, and that is the whole point. A house
-- delivery standard belongs to the team, not to whichever study it was first
-- set up in; a tracker's wave 6 must export exactly as wave 1 did, and a new
-- study in the same workspace should start from the same standard rather
-- than from whatever the last person happened to click.
--
-- Modelled on `analytics_report_templates` (0014) down to the policy shape,
-- because it is the same kind of object: a reusable house shape, readable by
-- any member of any project in the workspace, written through the API on the
-- service role.
--
-- SAFE TO APPLY AT ANY TIME. Nothing reads this table until it exists — the
-- presets API answers "no presets" when the relation is missing, exactly as
-- the responses export already does for columns added by later migrations.
-- So the feature ships dark and lights up when this runs.
-- =====================================================================

create table if not exists public.data_export_presets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null,
  description text,
  /*
   * The choices themselves: { format, values, headers, dataset, quality,
   * includeDictionary, ... }. Held as jsonb rather than as columns because
   * this is a UI preference object that will grow an option every time the
   * exporter does, and a migration per checkbox is not a good trade.
   *
   * It is validated by `DataExportPreset` in the schema package on the way
   * in and on the way out, so a row written by an older build cannot make a
   * newer one export something it did not mean to.
   */
  config jsonb not null default '{}'::jsonb,
  /*
   * Provenance only. A preset is workspace-wide and never scoped to this
   * survey, and deleting the study it was first saved from must not delete
   * the team's delivery standard.
   */
  source_survey_id uuid references public.surveys(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint data_export_presets_name_not_blank check (length(trim(name)) > 0)
);

-- one preset per name per workspace: the name is the handle a team picks it
-- by, and two "Client Data Export" rows in a dropdown is a coin toss
create unique index if not exists data_export_presets_name_key
  on public.data_export_presets (customer_id, lower(name))
  where deleted_at is null;

create index if not exists data_export_presets_customer_idx
  on public.data_export_presets (customer_id)
  where deleted_at is null;

comment on table public.data_export_presets is
  'Reusable data-export settings for one workspace: format, code/label mode, dataset filter and whether the data dictionary is included. Workspace-scoped like analytics_report_templates, because a delivery standard is not owned by whichever survey it was first set up in.';

alter table public.data_export_presets enable row level security;

/*
 * Read: any member of any project in the workspace, the same shape
 * `analytics_report_templates` and `analytics_themes` use. Writes are not
 * granted here at all — they go through the API on the service role, gated
 * on the caller's project permission, so a preset cannot be created by a
 * client that has merely authenticated.
 */
drop policy if exists data_export_presets_member_read on public.data_export_presets;
create policy data_export_presets_member_read on public.data_export_presets
  for select to authenticated
  using (
    exists (
      select 1 from public.surveys s
      where s.customer_id = data_export_presets.customer_id
        and (public.rescript_project_role(auth.uid(), s.id) is not null)
    )
    or public.rescript_is_platform_admin(auth.uid())
  );

grant select on public.data_export_presets to authenticated;

create or replace function public.rescript_touch_export_preset()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists data_export_presets_touch on public.data_export_presets;
create trigger data_export_presets_touch
  before update on public.data_export_presets
  for each row execute function public.rescript_touch_export_preset();
