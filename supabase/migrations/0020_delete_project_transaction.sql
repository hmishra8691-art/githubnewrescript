-- ============================================================================
-- Atomic project delete — the two-statement delete could not fail atomically
--
-- The DELETE route used to null out `surveys.current_version_id` (defensively,
-- for the one FK that isn't ON DELETE CASCADE) and then delete the row as two
-- independent Supabase calls, with the first call's error discarded. Neither
-- statement could roll the other back, and nothing verified that a row was
-- actually removed before the route answered `{ok:true}`.
--
-- One function body is one statement from the caller's side, so both steps
-- commit or fail together — the same shape as rescript_save_draft and
-- rescript_finalize_version. Every dependent table's own `survey_id` FK is
-- already `on delete cascade` (0001, 0005, 0006, 0007, 0008, 0011, 0016,
-- 0018); this function does not duplicate that cleanup, it only makes the
-- one manual step (the self-referencing current_version_id) atomic with the
-- delete it exists to unblock.
--
-- Safe to run more than once.
-- ============================================================================

create or replace function public.rescript_delete_project(p_survey_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row_count integer;
begin
  update public.surveys set current_version_id = null where id = p_survey_id;

  delete from public.surveys where id = p_survey_id;
  get diagnostics v_row_count = row_count;

  return v_row_count > 0;
end;
$$;

comment on function public.rescript_delete_project(uuid) is
  'Atomically clears the self-referencing current_version_id and deletes the survey row. Returns false when the row was already gone (nothing to delete), true when it deleted it; every other dependent table cleans itself up via ON DELETE CASCADE.';

revoke all on function public.rescript_delete_project(uuid) from anon;
