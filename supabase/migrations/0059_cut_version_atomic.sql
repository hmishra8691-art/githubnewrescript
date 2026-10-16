-- ============================================================================
-- 0059 — cutting a version is one transaction (audit ARCH-13, 2026-10-16)
--
-- `POST /api/surveys/:id/versions` used to:
--   1. insert the `survey_versions` row,
--   2. call `rescript_finalize_version` (0004) to point the survey at it under
--      the revision guard, and
--   3. on a lost revision race, DELETE the row it had just inserted (the one
--      delete 0012's immutability trigger allows: a never-adopted snapshot).
-- Three round trips for one state transition, and a crash between 1 and 2
-- left an orphan snapshot in the version panel.
--
-- `rescript_cut_version` does all of it in one function body, so it commits
-- or fails as a unit:
--   • the survey row is locked (`for update`), so two cuts of one survey
--     serialise and the revision check cannot be overtaken;
--   • a stale base revision inserts NOTHING and returns `conflict` with the
--     server's revision;
--   • a version number another cut took returns `version_taken` (the unique
--     violation is caught in a sub-block, nothing is left behind) and the
--     route retries with the next number;
--   • otherwise the snapshot is inserted, the survey points at it, the draft
--     is cleared, the title follows the definition, the revision is bumped,
--     and `cut` is returned with the new version id and revision.
-- Pass p_base_revision = -1 to skip the revision guard (an editor that cannot
-- say which revision it holds), exactly as `rescript_finalize_version` does.
--
-- The route calls this first and falls back to insert + finalize only when
-- PostgREST reports the function missing, so the app keeps working on a
-- database where this migration has not been applied yet.
--
-- Re-runnable: create or replace, comment, revoke.
-- Applied to rescript-survey-platform on 2026-10-16.
-- ============================================================================

create or replace function public.rescript_cut_version(
  p_survey_id uuid,
  p_version text,
  p_definition jsonb,
  p_label text,
  p_notes text,
  p_created_by uuid,
  p_base_revision bigint,
  p_title text
)
returns table (outcome text, version_id uuid, cut_version text, revision bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_current bigint;
  v_id uuid;
  v_new bigint;
begin
  select s.revision into v_current
    from public.surveys s
   where s.id = p_survey_id
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::bigint;
    return;
  end if;

  if p_base_revision >= 0 and v_current is distinct from p_base_revision then
    return query select 'conflict'::text, null::uuid, null::text, v_current;
    return;
  end if;

  begin
    insert into public.survey_versions (survey_id, version, definition, label, notes, created_by)
    values (p_survey_id, p_version, p_definition, p_label, p_notes, p_created_by)
    returning id into v_id;
  exception when unique_violation then
    return query select 'version_taken'::text, null::uuid, p_version, v_current;
    return;
  end;

  update public.surveys s
     set current_version_id = v_id,
         title = coalesce(nullif(p_title, ''), s.title),
         draft_definition = null,
         draft_updated_at = null,
         draft_base_version_id = null,
         updated_at = now(),
         revision = s.revision + 1
   where s.id = p_survey_id
  returning s.revision into v_new;

  return query select 'cut'::text, v_id, p_version, v_new;
end;
$$;

comment on function public.rescript_cut_version(uuid, text, jsonb, text, text, uuid, bigint, text) is
  'Insert a survey version and point the survey at it (draft cleared, revision bumped) in one transaction, under the revision guard (-1 forces). Returns outcome cut | conflict | version_taken | not_found.';

revoke all on function public.rescript_cut_version(uuid, text, jsonb, text, text, uuid, bigint, text) from public, anon, authenticated;
