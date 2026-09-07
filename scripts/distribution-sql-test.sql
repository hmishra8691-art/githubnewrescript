-- =====================================================================
-- §24 DISTRIBUTION — proved in the database
--
-- Migration 0013 makes `public.respondents` usable from a screen. Three of
-- its four promises are enforced below the application and can only be
-- proved here: that a test list cannot answer a live link, that the same
-- person cannot be invited twice under one external id, and that the
-- distribution numbers are one query rather than six counts.
--
--   psql -d <database> -f scripts/distribution-sql-test.sql
--
-- Needs migrations 0001–0013 on a throwaway database. Creates its own
-- fixtures and rolls nothing back — never run it against a live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('aaaaaaaa-0000-0000-0000-00000000aaaa', 'dist-test', 'Dist') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title, status)
  values ('bbbbbbbb-0000-0000-0000-00000000bbbb', 'aaaaaaaa-0000-0000-0000-00000000aaaa', 'D1', 'Invited study', 'live')
  on conflict do nothing;
commit;

\echo '--- 1. an uploaded list mints a token per person, without the app choosing it'
insert into public.respondents (survey_id, is_test, list_name, name, email, external_id, status)
values
  ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'wave 1', 'Ada Lovelace',   'ada@example.com',   'EMP-001', 'invited'),
  ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'wave 1', 'Alan Turing',    'alan@example.com',  'EMP-002', 'invited'),
  ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'wave 1', 'Grace Hopper',   'grace@example.com', 'EMP-003', 'invited'),
  ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'wave 2', 'Katherine J.',   'kj@example.com',    'EMP-004', 'invited');
select case
         when count(*) = 4
          and count(distinct token) = 4
          and bool_and(token ~ '^[0-9a-f]{32}$')
         then 'PASS four unguessable tokens, minted by the database'
         else 'FAIL' end
from public.respondents where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb';

\echo '--- 2. the same person cannot be invited twice under one external id'
do $$
begin
  insert into public.respondents (survey_id, is_test, list_name, email, external_id)
    values ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'the reminder file', 'ada.l@example.com', 'emp-001');
  raise exception 'FAIL: a duplicate respondent was accepted';
exception when unique_violation then
  raise notice 'PASS "EMP-001" and "emp-001" are one person, so one link';
end $$;

\echo '--- 3. a list with no external id is still a legitimate list'
insert into public.respondents (survey_id, is_test, list_name, email)
values
  ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'client top-up', 'one@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000bbbb', false, 'client top-up', 'two@example.com');
select case when count(*) = 2 then 'PASS email-only rows accepted' else 'FAIL' end
from public.respondents
where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb' and external_id is null;

\echo '--- 4. a TEST list is a different list'
insert into public.respondents (survey_id, is_test, list_name, name, external_id)
values ('bbbbbbbb-0000-0000-0000-00000000bbbb', true, 'my test people', 'Tester', 'EMP-001');
select case when count(*) = 1 then 'PASS the same external id may exist in both environments'
            else 'FAIL' end
from public.respondents
where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb' and is_test and lower(external_id) = 'emp-001';

\echo '--- 5. the runtime lookup finds a live token only in the live list'
-- exactly the query `createSession` issues, with the environment predicate
select case
         when (select count(*) from public.respondents r
               where r.survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb'
                 and r.is_test = false
                 and r.token = (select token from public.respondents
                                where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb'
                                  and is_test and external_id = 'EMP-001')) = 0
         then 'PASS a test token cannot open a live link'
         else 'FAIL — a test respondent answered a live link' end;

\echo '--- 6. an in_progress respondent no longer violates the status check'
-- the write `session/save` performs; before 0013 this raised
update public.respondents set status = 'in_progress'
  where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb' and external_id = 'EMP-002';
select case when status = 'in_progress' then 'PASS in_progress accepted' else 'FAIL' end
from public.respondents where external_id = 'EMP-002' and not is_test;

\echo '--- 7. updated_at moves on its own'
select case when updated_at > invited_at then 'PASS updated_at maintained by the database' else 'FAIL' end
from public.respondents where external_id = 'EMP-002' and not is_test;

\echo '--- 8. sending is recorded separately from uploading'
update public.respondents set sent_at = now()
  where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb' and not is_test and list_name = 'wave 1';
select case when count(*) = 3 then 'PASS a wave can be marked sent on its own' else 'FAIL' end
from public.respondents
where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb' and not is_test and sent_at is not null;

\echo '--- 9. progress in one query, per wave'
update public.respondents set status = 'complete'
  where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb' and not is_test and external_id = 'EMP-003';
select list_name, total, sent, not_sent, waiting, started, completed
from public.rescript_respondent_stats('bbbbbbbb-0000-0000-0000-00000000bbbb', false)
order by list_name;

\echo '--- 10. "who do we chase" is answerable'
select case when waiting = 1 and sent = 3 then 'PASS one invited, sent, and still not started'
            else 'FAIL — waiting ' || waiting || ', sent ' || sent end
from public.rescript_respondent_stats('bbbbbbbb-0000-0000-0000-00000000bbbb', false)
where list_name = 'wave 1';

\echo '--- 11. the test environment reports separately'
select case when count(*) = 1 and sum(total) = 1 then 'PASS test list reported on its own' else 'FAIL' end
from public.rescript_respondent_stats('bbbbbbbb-0000-0000-0000-00000000bbbb', true);

\echo '--- 12. deleting the survey takes its list with it'
delete from public.surveys where id = 'bbbbbbbb-0000-0000-0000-00000000bbbb';
select case when count(*) = 0 then 'PASS no orphaned respondents' else 'FAIL' end
from public.respondents where survey_id = 'bbbbbbbb-0000-0000-0000-00000000bbbb';
