-- ============================================================================
-- 0043 · THE PROJECT LIST COUNTED TEST RESPONSES AS REAL
-- ============================================================================
--
-- `rescript_my_projects.response_count` was
--
--     select count(*) from public.responses r
--      where r.survey_id = s.id and r.deleted_at is null
--
-- with no `is_test` predicate. So a project the team had spent a week testing
-- reported "347 responses" on its card while fieldwork had not started, and a
-- project that had just gone live reported its pilot data as delivery. The
-- number a project list exists to show — how much real data is in — was the
-- one number it could not be trusted for.
--
-- Every other count in the product already draws this line.
-- `survey_dashboard_stats` returns `live_response_count` and
-- `test_response_count` separately, the data screens filter by environment,
-- and billing meters live responses only. This function was the exception.
--
-- WHAT CHANGES. `response_count` becomes the LIVE count, and
-- `test_response_count` is added beside it. Two columns rather than a silent
-- redefinition of one: a caller that wants "everything in the table" can add
-- them, and a caller that wants what the card means gets it by default.
-- Nothing is hidden — a project with test data still says so, in the column
-- that says test.
--
-- Dropped and recreated rather than replaced: `create or replace` cannot
-- change the OUT columns of a set-returning function.
--
-- NOTE FOR `scripts/0034-check.sql`: that script fingerprints function bodies
-- to answer "did 0034 land". After this migration `rescript_my_projects` no
-- longer matches its recorded AFTER hash, by design. A database with 0043
-- applied will report that one function as UNRECOGNISED there; the other six
-- still answer the question.

drop function if exists public.rescript_my_projects(uuid, integer);

create function public.rescript_my_projects(p_user uuid, p_lock_stale_seconds integer default 180)
returns table (
  survey_id uuid, code text, title text, status text, updated_at timestamptz,
  owner_id uuid, owner_name text, owner_code text,
  my_role text, role_source text,
  collaborators integer,
  editing_user_id uuid, editing_name text, editing_since timestamptz,
  current_version text, response_count integer, test_response_count integer
)
language sql stable security definer set search_path = public as $$
  select
    s.id, s.code, s.title, s.status, s.updated_at,
    s.owner_id, op.full_name, op.user_code,
    a.project_role, a.role_source,
    (select count(*)::int from public.project_members m
      where m.survey_id = s.id and m.revoked_at is null) as collaborators,
    l.locked_by_user_id, lp.full_name, l.created_at,
    v.version,
    /* real data */
    (select count(*)::int from public.responses r
      where r.survey_id = s.id and r.deleted_at is null and r.is_test = false),
    /* …and what the team put through in preview, counted where it belongs */
    (select count(*)::int from public.responses r
      where r.survey_id = s.id and r.deleted_at is null and r.is_test = true)
  from public.surveys s
  cross join lateral public.rescript_project_access(p_user, s.id) a
  left join public.profiles op on op.id = s.owner_id
  left join public.survey_versions v on v.id = s.current_version_id
  left join public.project_edit_locks l
    on l.survey_id = s.id and l.status = 'held'
   and l.last_heartbeat_at > now() - make_interval(secs => p_lock_stale_seconds)
   and exists (
     select 1 from public.user_sessions us
      where us.id = l.locked_by_session_id and us.status = 'active'
   )
  left join public.profiles lp on lp.id = l.locked_by_user_id
  where a.project_role is not null
  order by s.updated_at desc;
$$;

/*
 * The grants go back on the new function: 0026 revoked the blanket ones and
 * granted execute to the service role only, and a dropped function takes its
 * grants with it. Without this the whole project list 403s.
 */
revoke all on function public.rescript_my_projects(uuid, integer) from public, anon, authenticated;
grant execute on function public.rescript_my_projects(uuid, integer) to service_role;
