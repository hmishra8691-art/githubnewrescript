-- ============================================================================
-- Version immutability must not block deleting the survey it protects
--
-- Migration 0012's `rescript_versions_are_immutable()` trigger stops a
-- STANDALONE `delete from survey_versions` from removing a version that is
-- current, deployed, or answered — protecting a survey that keeps existing
-- from losing a version out from under it. It did not anticipate the other
-- legitimate reason a version row is ever deleted: `rescript_delete_project`
-- (0020) deleting the whole `surveys` row, which cascades (every dependent
-- table's `survey_id` FK is `on delete cascade`) into deleting every one of
-- that survey's `survey_versions` rows too. The trigger fired for that
-- cascade exactly as it does for a standalone delete, so any survey with a
-- current, deployed, or answered version — i.e. any survey anyone would
-- actually reach for the Delete button on — could never be deleted at all:
-- the whole transaction aborted with "version 1.1 cannot be deleted: it is
-- the version respondents answered," and nothing was removed.
--
-- The fix distinguishes the two cases the way the database already can: by
-- the time this trigger fires during a cascade from the parent survey's own
-- deletion, `surveys` no longer has a row for `old.survey_id` — proved
-- against a scratch database built from this exact schema (0001 + 0012 +
-- 0020): a query run from inside the cascading child trigger already cannot
-- see the row the outer `delete from surveys` is in the middle of removing.
-- A standalone delete of just the version, with the survey still very much
-- there, still sees `v_survey_exists = true` and is refused exactly as
-- before — proved in the same scratch database.
--
-- Nothing about the UPDATE branch (freezing definition/version/created_at/
-- created_by) changes — only the DELETE branch gains this one check, ahead
-- of the existing v_pointed/v_deployed/v_answered checks it already made.
-- Safe to run more than once.
-- ============================================================================

create or replace function public.rescript_versions_are_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_survey_exists boolean;
  v_pointed boolean;
  v_deployed boolean;
  v_answered boolean;
begin
  if tg_op = 'UPDATE' then
    if new.survey_id is distinct from old.survey_id
       or new.version is distinct from old.version
       or new.definition::text is distinct from old.definition::text
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception
        'version % of this survey is published and cannot be changed. Cut a new version instead — a deployed link is pinned to this snapshot, and respondents may already have answered it.',
        old.version
        using errcode = 'restrict_violation',
              hint = 'Only the label and notes of a published version may be edited.';
    end if;
    return new;
  end if;

  -- DELETE. A cascade from the parent survey's own deletion has already
  -- removed that survey's row by the time this fires (proved above) —
  -- deleting every version underneath it is the correct, already-authorized
  -- outcome of deleting the survey, not a standalone attempt to delete just
  -- this version out from under a survey that keeps existing.
  select exists (select 1 from public.surveys s where s.id = old.survey_id) into v_survey_exists;
  if not v_survey_exists then
    return old;
  end if;

  select exists (select 1 from public.surveys s where s.current_version_id = old.id) into v_pointed;
  select exists (select 1 from public.deployments d where d.version_id = old.id) into v_deployed;
  select exists (select 1 from public.responses r where r.version_id = old.id) into v_answered;

  if v_pointed or v_deployed or v_answered then
    raise exception
      'version % cannot be deleted: it is %.',
      old.version,
      case
        when v_answered then 'the version respondents answered'
        when v_deployed then 'served by a deployed link'
        else 'the survey''s current version'
      end
      using errcode = 'restrict_violation',
            hint = 'Only a snapshot that was never adopted can be removed.';
  end if;
  return old;
end;
$$;

comment on function public.rescript_versions_are_immutable() is
  'Freezes the content of a published version (survey_id, version, definition, created_at, created_by) while leaving label and notes editable. Deleting a version whose survey still exists is permitted only when it was never adopted (no current pointer, no deployment, no response) -- but a delete that cascades from the parent survey itself being removed (rescript_delete_project) is always permitted, since the survey is what authorized it.';
