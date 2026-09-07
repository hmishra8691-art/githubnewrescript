-- =====================================================================
-- TEST CASES AND REGRESSION HISTORY — proved in the database (0018)
--
-- The runner itself is unit-tested in `packages/templates` (30 assertions on
-- the four verdicts). What can only be proved here is the shape of the
-- history: that a suite listing shows a case which has NEVER run, that the
-- latest run is the one reported however the rows were inserted, that a batch
-- is retrievable as one regression run, and that deleting a case or a survey
-- does not leave orphaned results behind.
--
--   psql -d <database> -f scripts/test-cases-sql-test.sql
--
-- Needs migrations 0001–0018 on a throwaway database. Creates its own
-- fixtures and rolls nothing back — never run it against a live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('22222222-0000-0000-0000-0000000000c1', 'tc-test', 'Test Cases') on conflict do nothing;

alter table auth.users disable trigger on_auth_user_created;
insert into auth.users (id, email) values ('22222222-0000-0000-0000-0000000000a1', 'ada@example.com')
  on conflict do nothing;
alter table auth.users enable trigger on_auth_user_created;

insert into public.profiles (id, email, full_name, customer_id, role)
  values ('22222222-0000-0000-0000-0000000000a1', 'ada@example.com', 'Ada',
          '22222222-0000-0000-0000-0000000000c1', 'programmer')
  on conflict (id) do nothing;

insert into public.surveys (id, customer_id, code, title, status, created_by)
  values ('22222222-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-0000000000c1',
          'TC1', 'Suite study', 'draft', '22222222-0000-0000-0000-0000000000a1')
  on conflict do nothing;
commit;

\echo '--- 1. a case is stored with its input, and needs nothing else'
insert into public.survey_test_cases (id, survey_id, name, input, created_by)
values ('22222222-0000-0000-0000-00000000e001', '22222222-0000-0000-0000-0000000000d1',
        'A 17-year-old is screened out',
        '{"answers":{"q_age":17},"seed":7}'::jsonb, '22222222-0000-0000-0000-0000000000a1');
select case when enabled and baseline is null and expectations = '{}'::jsonb
            then 'PASS a new case is enabled, unblessed and unasserted — all three are honest defaults'
            else 'FAIL' end
from public.survey_test_cases where id = '22222222-0000-0000-0000-00000000e001';

\echo '--- 2. two cases in one survey cannot share a name'
do $$
begin
  insert into public.survey_test_cases (survey_id, name, input)
  values ('22222222-0000-0000-0000-0000000000d1', 'a 17-YEAR-OLD is screened out', '{"answers":{}}'::jsonb);
  raise exception 'FAIL: two cases shared one name';
exception when unique_violation then
  raise notice 'PASS one name, one case — and the check is case-insensitive';
end $$;

\echo '--- 3. A CASE THAT HAS NEVER RUN IS STILL LISTED'
-- the state that most needs showing: a suite that lists only the cases it has
-- results for is how a case gets written, forgotten and never run again
select case when count(*) = 1 and bool_and(last_verdict is null) and bool_and(run_count = 0)
            then 'PASS never-run cases appear, with no verdict rather than a green one'
            else 'FAIL' end
from public.rescript_test_suite('22222222-0000-0000-0000-0000000000d1');

\echo '--- 4. an unknown verdict cannot be recorded'
do $$
begin
  insert into public.survey_test_runs (survey_id, test_case_id, batch_id, verdict)
  values ('22222222-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-00000000e001',
          gen_random_uuid(), 'probably_fine');
  raise exception 'FAIL: an unvetted verdict was accepted';
exception when check_violation then
  raise notice 'PASS the vocabulary is closed — pass / changed / fail / stale / error';
end $$;

\echo '--- 5. THE LATEST RUN IS THE ONE REPORTED, whatever order the rows arrived in'
-- inserted newest-first on purpose: a listing that trusted insertion order
-- would report the stale verdict, and a programmer would fix a bug twice
insert into public.survey_test_runs (survey_id, test_case_id, batch_id, verdict, run_at, version_label)
values
  ('22222222-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-00000000e001',
   '22222222-0000-0000-0000-00000000b002', 'pass', now(), 'draft r12'),
  ('22222222-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-00000000e001',
   '22222222-0000-0000-0000-00000000b001', 'fail', now() - interval '2 hours', 'draft r11');
select case when last_verdict = 'pass' and last_version_label = 'draft r12' and run_count = 2
            then 'PASS the newest run decides, and the history is kept'
            else 'FAIL — ' || coalesce(last_verdict, 'null') || ' / ' || coalesce(last_version_label, 'null') end
from public.rescript_test_suite('22222222-0000-0000-0000-0000000000d1');

\echo '--- 6. a batch is one regression run, retrievable as one'
insert into public.survey_test_cases (id, survey_id, name, input)
values ('22222222-0000-0000-0000-00000000e002', '22222222-0000-0000-0000-0000000000d1',
        'A non-user skips the usage block', '{"answers":{"q_use":2},"seed":7}'::jsonb);
insert into public.survey_test_runs (survey_id, test_case_id, batch_id, verdict, changes)
values ('22222222-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-00000000e002',
        '22222222-0000-0000-0000-00000000b002', 'changed',
        '[{"kind":"path","detail":"After 1 page(s) the path diverges: p_often instead of p_why."}]'::jsonb);
select case when count(*) = 2 then 'PASS both cases in the batch come back together' else 'FAIL — ' || count(*) end
from public.survey_test_runs where batch_id = '22222222-0000-0000-0000-00000000b002';

\echo '--- 7. the changes a run recorded survive the round trip'
select case when last_changes->0->>'kind' = 'path'
             and last_changes->0->>'detail' like 'After 1 page%'
            then 'PASS a programmer sees the sentence, not a diff fragment'
            else 'FAIL' end
from public.rescript_test_suite('22222222-0000-0000-0000-0000000000d1')
where test_case_id = '22222222-0000-0000-0000-00000000e002';

\echo '--- 8. blessing a baseline records WHICH definition it came from'
-- a baseline with no version behind it cannot be argued with later
insert into public.survey_versions (id, survey_id, version, definition, created_by)
values ('22222222-0000-0000-0000-00000000f001', '22222222-0000-0000-0000-0000000000d1',
        1, '{"meta":{"id":"x"}}'::jsonb, '22222222-0000-0000-0000-0000000000a1');
update public.survey_test_cases
   set baseline = '{"path":["p_screen"],"endStatus":"screened","fingerprint":"abc"}'::jsonb,
       baseline_version_id = '22222222-0000-0000-0000-00000000f001',
       baseline_at = now(),
       baseline_by = '22222222-0000-0000-0000-0000000000a1'
 where id = '22222222-0000-0000-0000-00000000e001';
select case when has_baseline and baseline_at is not null
            then 'PASS the suite can say which cases have been blessed'
            else 'FAIL' end
from public.rescript_test_suite('22222222-0000-0000-0000-0000000000d1')
where test_case_id = '22222222-0000-0000-0000-00000000e001';

\echo '--- 9. updating a case touches updated_at'
select case when (
  select updated_at from public.survey_test_cases where id = '22222222-0000-0000-0000-00000000e001'
) > (
  select created_at from public.survey_test_cases where id = '22222222-0000-0000-0000-00000000e001'
) then 'PASS an edited case shows when' else 'FAIL' end;

\echo '--- 10. a disabled case is listed LAST, not hidden'
update public.survey_test_cases set enabled = false
 where id = '22222222-0000-0000-0000-00000000e002';
select case when (array_agg(test_case_id order by ord))[2] = '22222222-0000-0000-0000-00000000e002'
            then 'PASS disabled cases sink to the bottom and stay visible'
            else 'FAIL' end
from (
  select test_case_id, row_number() over () as ord
  from public.rescript_test_suite('22222222-0000-0000-0000-0000000000d1')
) t;

\echo '--- 11. deleting a case takes its run history with it'
delete from public.survey_test_cases where id = '22222222-0000-0000-0000-00000000e002';
select case when count(*) = 0 then 'PASS no orphaned runs' else 'FAIL — ' || count(*) end
from public.survey_test_runs where test_case_id = '22222222-0000-0000-0000-00000000e002';

\echo '--- 12. a deleted VERSION does not delete the baseline that came from it'
-- the outcome is still the right thing to compare against; only the pointer goes
delete from public.survey_versions where id = '22222222-0000-0000-0000-00000000f001';
select case when baseline is not null and baseline_version_id is null
            then 'PASS the blessed outcome survives; the pointer nulls out'
            else 'FAIL' end
from public.survey_test_cases where id = '22222222-0000-0000-0000-00000000e001';

\echo '--- 13. deleting the survey takes the whole suite with it'
delete from public.surveys where id = '22222222-0000-0000-0000-0000000000d1';
select case when (select count(*) from public.survey_test_cases
                   where survey_id = '22222222-0000-0000-0000-0000000000d1') = 0
             and (select count(*) from public.survey_test_runs
                   where survey_id = '22222222-0000-0000-0000-0000000000d1') = 0
            then 'PASS nothing is left behind'
            else 'FAIL' end;
