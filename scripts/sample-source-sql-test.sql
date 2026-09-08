-- =====================================================================
-- §23 SAMPLE SOURCES / §42 VERSION IMMUTABILITY — proved in the database
--
-- Migration 0012 makes two promises that no amount of application testing
-- can establish, because both are enforced below the application: a
-- published version cannot be rewritten, and fieldwork can be reported by
-- supplier. This file asserts them with the same SQL the runtime and the
-- Studio actually issue.
--
--   psql -d <database> -f scripts/sample-source-sql-test.sql
--
-- Run it against a scratch database with migrations 0001–0012 applied (0021
-- too, for the final test below) — 0002–0011/0013+ are not required for
-- anything this file asserts. It creates its own fixtures under fixed ids
-- and rolls nothing back, so use a throwaway database — never a live
-- project.
--
-- Companion to scripts/access-sql-test.sql, which does the same for RLS.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('11111111-1111-1111-1111-111111111111', 'acme-fieldwork-test', 'Acme') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title, status)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'S1', 'Study', 'live')
  on conflict do nothing;
insert into public.survey_versions (id, survey_id, version, definition, label)
  values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', '1.0', '{"meta":{"code":"S1"}}'::jsonb, 'first cut');
insert into public.survey_versions (id, survey_id, version, definition)
  values ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '1.1', '{"meta":{"code":"S1"}}'::jsonb);
update public.surveys set current_version_id = '33333333-3333-3333-3333-333333333333'
  where id = '22222222-2222-2222-2222-222222222222';
commit;

-- ===================================================== §42 immutability

\echo '--- 1. a version label may be corrected'
update public.survey_versions set label = 'first cut (sent to legal)', notes = 'checked'
  where id = '33333333-3333-3333-3333-333333333333';
select case when label = 'first cut (sent to legal)' then 'PASS label editable' else 'FAIL' end
  from public.survey_versions where id = '33333333-3333-3333-3333-333333333333';

\echo '--- 2. the definition may NOT be rewritten'
do $$
begin
  update public.survey_versions set definition = '{"meta":{"code":"HACKED"}}'::jsonb
    where id = '33333333-3333-3333-3333-333333333333';
  raise exception 'FAIL: the definition was rewritten';
exception
  when restrict_violation then raise notice 'PASS definition frozen';
end $$;

\echo '--- 3. nor the version number'
do $$
begin
  update public.survey_versions set version = '9.9' where id = '33333333-3333-3333-3333-333333333333';
  raise exception 'FAIL: the version number was changed';
exception when restrict_violation then raise notice 'PASS version number frozen';
end $$;

\echo '--- 4. the survey''s current version cannot be deleted'
do $$
begin
  delete from public.survey_versions where id = '33333333-3333-3333-3333-333333333333';
  raise exception 'FAIL: the current version was deleted';
exception when restrict_violation then raise notice 'PASS current version protected';
end $$;

\echo '--- 5. a version with responses cannot be deleted'
insert into public.responses (survey_id, version_id, session_id, status, is_test, seed, sample_source)
  values ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'sess-answered', 'complete', false, 1, 'cint');
do $$
begin
  delete from public.survey_versions where id = '44444444-4444-4444-4444-444444444444';
  raise exception 'FAIL: a version someone answered was deleted';
exception when restrict_violation then raise notice 'PASS answered version protected';
end $$;

\echo '--- 6. an orphan snapshot nothing adopted CAN be cleaned up'
-- this is the case `versions/route.ts` relies on when a revision guard
-- refuses a cut and the inserted row has to be withdrawn
insert into public.survey_versions (id, survey_id, version, definition)
  values ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', '1.2', '{}'::jsonb);
delete from public.survey_versions where id = '55555555-5555-5555-5555-555555555555';
select case when count(*) = 0 then 'PASS orphan removable' else 'FAIL' end
  from public.survey_versions where id = '55555555-5555-5555-5555-555555555555';

-- ==================================================== §23 sample sources

\echo '--- 7. one declaration per code, case-insensitively'
insert into public.sample_sources (survey_id, code, label, target_completes, cost_per_complete)
  values ('22222222-2222-2222-2222-222222222222', 'cint', 'Cint', 400, 3.20);
do $$
begin
  insert into public.sample_sources (survey_id, code, label)
    values ('22222222-2222-2222-2222-222222222222', 'CINT', 'Cint again');
  raise exception 'FAIL: a duplicate supplier was accepted';
exception when unique_violation then raise notice 'PASS "CINT" and "cint" are one supplier';
end $$;

\echo '--- 8. the runtime records an UNDECLARED source rather than losing the interview'
-- exactly the insert `createSession` issues, including a code nobody declared
insert into public.responses (survey_id, version_id, session_id, status, is_test, seed, sample_source, sample_source_respondent)
values
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'sess-1', 'complete',    false, 1, 'cint',        'panel-abc'),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'sess-2', 'complete',    false, 2, 'cint',        'panel-def'),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'sess-3', 'screened',    false, 3, 'cint',        null),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'sess-4', 'in_progress', false, 4, 'nosuchpanel', null),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'sess-5', 'complete',    false, 5, null,          null),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'sess-6', 'complete',    true,  6, 'cint',        null);
update public.responses set completed_at = started_at + interval '7 minutes'  where session_id in ('sess-1','sess-2');
update public.responses set completed_at = started_at + interval '11 minutes' where session_id = 'sess-5';
select case when count(*) = 1 then 'PASS undeclared source recorded' else 'FAIL' end
  from public.responses where session_id = 'sess-4' and sample_source = 'nosuchpanel';

\echo '--- 9. a source arriving on RESUME fills an empty one…'
-- the update `session/start` issues when a respondent''s first link carried
-- no source and a later one does
update public.responses set sample_source = 'lucid'
  where session_id = 'sess-5' and sample_source is null;
select case when sample_source = 'lucid' then 'PASS empty source filled on resume' else 'FAIL' end
  from public.responses where session_id = 'sess-5';

\echo '--- 10. …and never overwrites the supplier who actually sent them'
update public.responses set sample_source = 'someone-else'
  where session_id = 'sess-1' and sample_source is null;
select case when sample_source = 'cint' then 'PASS first attribution wins' else 'FAIL — credit moved' end
  from public.responses where session_id = 'sess-1';

\echo '--- 11. supplier performance in one query (LIVE)'
select sample_source, declared, label, target_completes, starts, completes, partials, screened,
       incidence, completion_rate, median_seconds
from public.rescript_source_stats('22222222-2222-2222-2222-222222222222', false)
order by sample_source;

\echo '--- 12. the TEST environment is a different set of numbers'
select case when (select count(*) from public.rescript_source_stats('22222222-2222-2222-2222-222222222222', true)) = 1
            then 'PASS test traffic reported separately' else 'FAIL' end;

\echo '--- 13. a deleted response leaves every fieldwork figure'
update public.responses set deleted_at = now() where session_id = 'sess-2';
select case when completes = 2 then 'PASS deleted excluded' else 'FAIL — got ' || completes end
from public.rescript_source_stats('22222222-2222-2222-2222-222222222222', false)
where sample_source = 'cint';

\echo '--- 14. undeclaring a source keeps the interviews and their provenance'
delete from public.sample_sources
  where survey_id = '22222222-2222-2222-2222-222222222222' and lower(code) = 'cint';
-- one row per source, so the assertion is on the counts inside it: the three
-- surviving cint interviews are still reported, now marked undeclared and
-- with no target to report against
select case when starts = 3 and not declared and target_completes is null
            then 'PASS responses keep their source, now undeclared'
            else 'FAIL — starts ' || starts || ', declared ' || declared end
from public.rescript_source_stats('22222222-2222-2222-2222-222222222222', false)
where sample_source = 'cint';

-- ===================================================== §42 / 0021 addendum

\echo '--- 15. the version-immutability guard must not block deleting the SURVEY it protects'
-- This is the P0 this addendum exists for: 0012's trigger correctly refused
-- to let anyone delete JUST version 1.1 (test 5, above — it is still
-- answered and still protected) or JUST version 1.0 (test 4 — it is still
-- the survey's current version). But `rescript_delete_project` (0020)
-- deletes the whole `surveys` row, which cascades into deleting every
-- `survey_versions` row underneath it — and before 0021, that cascade fired
-- the SAME trigger, which raised the SAME exception, so the entire delete
-- transaction aborted and the survey could never be removed at all. Every
-- fixture used above (survey 22222222…, its current version 33333333… and
-- its answered version 44444444… with responses) is still exactly as the
-- earlier tests left it, so this is the real end-to-end path: the actual RPC
-- the DELETE route calls, on a survey no different from a real one.
select case when public.rescript_delete_project('22222222-2222-2222-2222-222222222222')
            then 'PASS survey with a current + answered version was deleted'
            else 'FAIL — rescript_delete_project returned false' end;
select case when count(*) = 0 then 'PASS no survey row left'
            else 'FAIL — survey still exists' end
  from public.surveys where id = '22222222-2222-2222-2222-222222222222';
select case when count(*) = 0 then 'PASS both versions gone, including the ones the trigger was protecting'
            else 'FAIL — a version survived' end
  from public.survey_versions where survey_id = '22222222-2222-2222-2222-222222222222';
select case when count(*) = 0 then 'PASS its responses are gone too'
            else 'FAIL — a response survived' end
  from public.responses where survey_id = '22222222-2222-2222-2222-222222222222';

\echo '--- 16. calling it again on the now-gone survey is a safe no-op, not an error'
select case when public.rescript_delete_project('22222222-2222-2222-2222-222222222222') = false
            then 'PASS idempotent retry returns false, does not raise'
            else 'FAIL' end;
