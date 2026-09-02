-- ============================================================================
-- Draft definitions — the Studio's single source of truth
--
-- Until now the only place a survey definition could live was an immutable
-- `survey_versions` row, written solely by the "Save version" button. That
-- made every setting change a publishing event, and any edit not followed by
-- an explicit save was lost on refresh with no warning.
--
-- A draft separates the two concerns:
--
--   surveys.draft_definition   what the programmer is editing, autosaved
--   survey_versions.definition immutable snapshots, cut deliberately, and the
--                              only thing a deployment can ever point at
--
-- Versions stay immutable — a respondent mid-survey can never have the
-- questionnaire change underneath them — while the editor stops losing work.
-- ============================================================================

alter table public.surveys
  add column if not exists draft_definition jsonb,
  add column if not exists draft_updated_at timestamptz,
  add column if not exists draft_base_version_id uuid references public.survey_versions(id);

comment on column public.surveys.draft_definition is
  'Work in progress from the Studio, autosaved. NULL means the draft equals current_version_id''s definition. Never served to respondents.';
comment on column public.surveys.draft_base_version_id is
  'The version this draft was started from — lets the Studio say "live is running v1.2, you are editing on top of v1.7".';

-- The dashboard and the editor both ask "is there unsaved work?" — answering
-- it from a timestamp comparison beats deserialising the whole draft.
create index if not exists surveys_draft_updated_idx
  on public.surveys (id, draft_updated_at desc);

-- ---------------------------------------------------------------- publishing
-- Which version each deployment mode is currently serving, per survey. The
-- Studio uses this to say "Live is running v1.2 — you have saved v1.7" instead
-- of leaving the programmer to guess, and to offer a one-click publish.
create or replace function public.survey_publish_state(p_survey_id uuid)
returns table (
  mode text,
  version_id uuid,
  version text,
  deployed_at timestamptz,
  client_slug text,
  study_slug text,
  active boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select d.mode, d.version_id, v.version, d.created_at, d.client_slug, d.study_slug, d.active
  from public.deployments d
  join public.survey_versions v on v.id = d.version_id
  where d.survey_id = p_survey_id
  order by d.mode;
$$;

comment on function public.survey_publish_state(uuid) is
  'What each deployment mode is actually serving, so the Studio can show the gap between the live link and the newest saved version.';

revoke all on function public.survey_publish_state(uuid) from anon;
