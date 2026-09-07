-- =====================================================================
-- 0015 — PROJECT CONFIGURATION (§60)
--
-- A survey definition describes the QUESTIONNAIRE. A project is the piece of
-- work around it, and the platform had almost nothing for that: a row in
-- `public.surveys` with a code, a title, a status and an owner. Everything a
-- research team actually files a project under — which client it is for, who
-- is running it, when fieldwork is, when it is due, which cost centre it
-- bills to — lived in somebody's spreadsheet, or in the project's title.
--
-- Two consequences, both of which this migration and the panel above it fix:
--
--   * the dashboard could not answer "what is due this week" or "everything
--     for this client", because the facts were not stored;
--   * "Survey Settings" edits the DEFINITION, and there was no screen at all
--     for the project — so the two got confused, and project-level facts got
--     typed into `def.meta.description` where nothing could read them.
--
-- Deliberately COLUMNS and not one settings blob. A due date that cannot be
-- sorted by, and a client that cannot be filtered on, are notes rather than
-- data; the whole reason to store these is to ask questions of them. Every
-- column is nullable and additive: an existing project is a project with
-- none of them filled in, which is exactly what it is today.
--
-- `settings jsonb` is beside them for what a particular team wants to keep
-- and the platform has no opinion about.
-- =====================================================================

alter table public.surveys
  -- who it is FOR. Distinct from `customers.name`, which is the agency, and
  -- from `deployment.clientSlug`, which is a URL fragment.
  add column if not exists client_name text,
  -- who is RUNNING it. Free text rather than a profile reference on purpose:
  -- the person a client calls about a study is often not a platform user, and
  -- a field that can only hold a login is a field that stays empty.
  add column if not exists project_manager text,
  -- when it is IN FIELD. The pair that makes "what is live this week" and
  -- "what closes on Friday" answerable at all.
  add column if not exists fieldwork_from date,
  add column if not exists fieldwork_to date,
  -- when the DELIVERABLE is due, which is not when fieldwork closes
  add column if not exists due_date date,
  add column if not exists cost_centre text,
  -- the project's own notes, separate from `def.meta.description` (which is
  -- versioned with the questionnaire and shown to nobody internal)
  add column if not exists notes text,
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column public.surveys.client_name is
  'The end client this project is for. Distinct from customers.name (the workspace/agency) and from deployment.clientSlug (a URL fragment).';
comment on column public.surveys.project_manager is
  'Who is running this project. Free text: the person a client calls is often not a platform user, and a field that can only hold a login stays empty.';
comment on column public.surveys.fieldwork_from is
  'Planned or actual fieldwork start. Project-level, unlike the analytics methodology block, which records what one report says about it.';
comment on column public.surveys.due_date is
  'When the deliverable is due — which is not when fieldwork closes.';
comment on column public.surveys.settings is
  'Project configuration the platform has no opinion about. Structured facts belong in columns, so they can be sorted and filtered.';

/*
 * A date range that runs backwards is not a project, it is a typo — and one
 * that would quietly produce a negative field period in every report that
 * reads it. Both null, or either null, is fine: a project is planned before
 * its dates are known.
 */
alter table public.surveys drop constraint if exists surveys_fieldwork_order;
alter table public.surveys add constraint surveys_fieldwork_order
  check (fieldwork_from is null or fieldwork_to is null or fieldwork_to >= fieldwork_from);

-- the dashboard's two new questions: what is due, and what is in field
create index if not exists surveys_due_idx
  on public.surveys (customer_id, due_date)
  where due_date is not null;

create index if not exists surveys_fieldwork_idx
  on public.surveys (customer_id, fieldwork_to)
  where fieldwork_to is not null;

-- and "everything for this client", case-insensitively
create index if not exists surveys_client_idx
  on public.surveys (customer_id, lower(client_name))
  where client_name is not null;

-- ---------------------------------------------------------------------
-- The owner's freeze, which the platform has always ENFORCED and never
-- been able to switch on
--
-- `surveys.locked` arrived in 0008 and `lib/guard.ts` has honoured it ever
-- since: a locked project refuses every write capability with 423
-- `project_locked`, for everyone except the owner. Nothing in the platform
-- ever set it. The capability that governs it, `project.lock_settings`, is
-- declared in `packages/access/src/roles.ts`, granted to the owner, and
-- referenced by no route.
--
-- So the guarantee existed, the permission existed, and the switch did not.
-- The switch is in the project configuration panel now; nothing changes
-- here except saying what the column is for, because the column and its
-- enforcement were already right.
--
-- `collaboration` is the same story one step earlier: declared in 0008,
-- read and written by nothing. It now holds this project's own
-- collaboration overrides, which is what its name always promised.
-- ---------------------------------------------------------------------
comment on column public.surveys.locked is
  'The owner''s freeze. Enforced by lib/guard.ts since 0008 (423 project_locked for every write capability, owner excepted); settable from the project configuration panel since 0015. Governed by the project.lock_settings capability.';

comment on column public.surveys.collaboration is
  'This project''s collaboration overrides — {requireLockToEdit?, allowConcurrentViewers?, lockMinutes?}. Absent keys fall back to the workspace policy in access_settings.';

-- ---------------------------------------------------------------------
-- One row per project, for a dashboard that wants the facts and not the
-- statistics
--
-- `rescript_my_projects` (0009) already answers "which projects may I see",
-- and its return type is not widened here: replacing it would mean dropping
-- a function the dashboard depends on, for columns the dashboard can fetch
-- alongside. This is that fetch — cheap, keyed on ids the caller has
-- already been authorised for, and returning nothing else.
-- ---------------------------------------------------------------------
create or replace function public.rescript_project_config(p_surveys uuid[])
returns table (
  survey_id uuid,
  client_name text,
  project_manager text,
  fieldwork_from date,
  fieldwork_to date,
  due_date date,
  cost_centre text,
  notes text,
  locked boolean,
  collaboration jsonb,
  settings jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.client_name, s.project_manager, s.fieldwork_from, s.fieldwork_to,
         s.due_date, s.cost_centre, s.notes, s.locked, s.collaboration, s.settings
  from public.surveys s
  where s.id = any(p_surveys)
    and (
      public.rescript_project_role(auth.uid(), s.id) is not null
      or public.rescript_is_platform_admin(auth.uid())
    );
$$;

comment on function public.rescript_project_config(uuid[]) is
  'Project configuration for surveys the caller may see. Filtered by rescript_project_role, so passing another workspace''s ids returns nothing rather than leaking a client name.';

grant execute on function public.rescript_project_config(uuid[]) to authenticated, service_role;
