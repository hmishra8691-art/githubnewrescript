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
-- Run it against a scratch database with migrations 0001–0012 applied. It
-- creates its own fixtures under fixed ids and rolls nothing back, so use a
-- throwaway database — never a live project.
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
