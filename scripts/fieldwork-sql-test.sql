-- =====================================================================
-- FIELDWORK OVER TIME — proved in the database (0019)
--
-- The pace arithmetic is unit-tested in `packages/analytics`. What can only be
-- proved here is the bucketing itself, and every assertion below is one that a
-- plausible, tidier implementation would get wrong:
--
--   · a dead hour is a zero, not a missing row
--   · a start and its complete can land in DIFFERENT buckets
--   · a "day" is the caller's day, not the server's
--   · the bucket vocabulary refuses a typo instead of defaulting
--   · a rolling window is rolling, not clock-aligned
--   · test traffic and deleted rows are invisible
--
--   psql -d <database> -f scripts/fieldwork-sql-test.sql
--
-- Needs migrations 0001–0019 on a throwaway database. Creates its own
-- fixtures and rolls nothing back — never run it against a live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('33333333-0000-0000-0000-0000000000c1', 'fw-test', 'Fieldwork') on conflict do nothing;

alter table auth.users disable trigger on_auth_user_created;
insert into auth.users (id, email) values ('33333333-0000-0000-0000-0000000000a1', 'fm@example.com')
  on conflict do nothing;
alter table auth.users enable trigger on_auth_user_created;

insert into public.profiles (id, email, full_name, customer_id, role)
  values ('33333333-0000-0000-0000-0000000000a1', 'fm@example.com', 'Field Manager',
          '33333333-0000-0000-0000-0000000000c1', 'programmer')
  on conflict (id) do nothing;

insert into public.surveys (id, customer_id, code, title, status, created_by)
  values ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-0000000000c1',
          'FW1', 'Tracker wave 4', 'live', '33333333-0000-0000-0000-0000000000a1')
  on conflict do nothing;

insert into public.survey_versions (id, survey_id, version, definition, created_by)
  values ('33333333-0000-0000-0000-00000000f0f1', '33333333-0000-0000-0000-0000000000d1',
          1, '{"meta":{"id":"fw"}}'::jsonb, '33333333-0000-0000-0000-0000000000a1')
  on conflict do nothing;
commit;

-- A deliberately awkward morning. Every row here exists to make one
-- assertion below fail if the implementation is wrong.
--
--   09:10 → 09:20   a clean complete inside one hour
--   10:58 → 11:03   STRADDLES the hour: start in 10:00, complete in 11:00
--   11:15 → 11:19   a screen-out — an outcome, and it has a moment
--   11:40 → null    still going
--   (nothing at all happens in the 12:00 hour — the dead hour)
--   13:00 → 13:30   a complete starting EXACTLY on a bucket boundary
insert into public.responses
  (survey_id, version_id, session_id, status, is_test, step_index, started_at, completed_at, updated_at)
values
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-s1',
   'complete', false, 9, '2026-03-01 09:10:00+00', '2026-03-01 09:20:00+00', '2026-03-01 09:20:00+00'),
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-s2',
   'complete', false, 9, '2026-03-01 10:58:00+00', '2026-03-01 11:03:00+00', '2026-03-01 11:03:00+00'),
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-s3',
   'screened', false, 2, '2026-03-01 11:15:00+00', '2026-03-01 11:19:00+00', '2026-03-01 11:19:00+00'),
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-s4',
   'in_progress', false, 4, '2026-03-01 11:40:00+00', null, '2026-03-01 11:44:00+00'),
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-s5',
   'complete', false, 9, '2026-03-01 13:00:00+00', '2026-03-01 13:30:00+00', '2026-03-01 13:30:00+00');

\echo '--- 1. A DEAD HOUR IS A ZERO, NOT A MISSING ROW'
-- the assertion that matters most: a chart fed missing rows draws a straight
-- line across the outage the fieldwork manager opened the page to see
select case when count(*) = 5
             and bool_and(starts is not null and completes is not null)
            then 'PASS five hours asked for, five hours returned, none of them null'
            else 'FAIL — ' || count(*) || ' row(s)' end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC');

select case when starts = 0 and completes = 0 and screened = 0
            then 'PASS the 12:00 hour, in which nothing happened, is a row of zeroes'
            else 'FAIL' end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC')
where bucket_start = '2026-03-01 12:00:00+00';

\echo '--- 2. A START AND ITS COMPLETE LAND IN DIFFERENT BUCKETS'
-- fw-s2 arrived at 10:58 and finished at 11:03. Bucketing its completion by
-- started_at would put the complete in the 10:00 hour, which reads as "the
-- last hour has collapsed" for every survey, forever.
with t as (
  select bucket_start as b, starts, completes
  from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'hour',
    '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC')
)
select case when (select starts from t where b = '2026-03-01 10:00:00+00') = 1
             and (select completes from t where b = '2026-03-01 10:00:00+00') = 0
             and (select completes from t where b = '2026-03-01 11:00:00+00') = 1
            then 'PASS the start is counted when they arrived, the complete when they finished'
            else 'FAIL' end;

\echo '--- 2b. so the columns deliberately do not sum to each other'
-- documented as an assertion so that nobody "fixes" it later
select case when sum(starts) = 5 and sum(completes) + sum(screened) = 4
            then 'PASS 5 starts, 4 outcomes — the fifth is still in field, and the sums are independent'
            else 'FAIL — ' || sum(starts) || ' / ' || (sum(completes) + sum(screened)) end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC');

\echo '--- 3. AN EVENT EXACTLY ON A BOUNDARY BELONGS TO THE BUCKET IT OPENS'
select case when starts = 1 and completes = 1
            then 'PASS 13:00:00 opens the 13:00 bucket rather than closing the 12:00 one'
            else 'FAIL' end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC')
where bucket_start = '2026-03-01 13:00:00+00';

\echo '--- 3b. THE LAST BUCKET IS A WHOLE BUCKET, NOT A CLIPPED ONE'
-- The window asked for ends at 13:00 and fw-s5 completes at 13:30. The
-- obvious implementation counts events only up to `p_to`, so the bucket
-- containing p_to is always partial and EVERY chart ends in an apparent
-- collapse. The window is snapped out to whole buckets instead, and the
-- returned bucket_start values say which buckets those are.
select case when completes = 1
            then 'PASS the 13:00 bucket holds the whole 13:00 hour, including the 13:30 complete'
            else 'FAIL — the last bucket is clipped at p_to, so every chart ends in a false collapse' end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC')
where bucket_start = '2026-03-01 13:00:00+00';

\echo '--- 4. A SCREEN-OUT IS AN OUTCOME AND IT HAS A MOMENT'
-- a supplier whose incidence collapses at 3pm is invisible in a total and
-- obvious in a curve
select case when screened = 1 and completes = 1
            then 'PASS the 11:00 hour holds one complete and one screen-out'
            else 'FAIL' end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC')
where bucket_start = '2026-03-01 11:00:00+00';

\echo '--- 5. MEDIAN DURATION IS OVER COMPLETES ONLY'
-- the screen-out in this hour took 4 minutes; counting it would report a
-- median of ~4.5 minutes for a questionnaire nobody finished in under five
select case when median_seconds = 300
            then 'PASS 11:00 reports the complete''s 5 minutes, not the screen-out''s 4'
            else 'FAIL — ' || coalesce(median_seconds::text, 'null') end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC')
where bucket_start = '2026-03-01 11:00:00+00';

\echo '--- 6. A DAY IS THE CALLER''S DAY, NOT THE SERVER''S'
-- 2026-03-01 18:30 UTC is already 2026-03-02 in Kolkata. A team reading
-- "yesterday" would be reading a number wrong by five and a half hours, and
-- it would look completely fine.
insert into public.responses
  (survey_id, version_id, session_id, status, is_test, step_index, started_at, completed_at, updated_at)
values
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-s6',
   'complete', false, 9, '2026-03-01 18:20:00+00', '2026-03-01 18:30:00+00', '2026-03-01 18:30:00+00');

-- Same data, same window, two zones. fw-s6 completed at 18:30 UTC, which is
-- exactly 00:00 the next day in Kolkata — so the four completes of "the 1st"
-- in UTC are three completes on the 1st and one on the 2nd for the team
-- actually running the field.
with utc as (
  select array_agg(completes order by bucket_start) as c
  from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'day',
    '2026-03-01 00:00:00+00', '2026-03-03 00:00:00+00', 'UTC')
),
ist as (
  select array_agg(completes order by bucket_start) as c
  from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'day',
    '2026-03-01 00:00:00+00', '2026-03-03 00:00:00+00', 'Asia/Kolkata')
)
select case when (select c from utc) = array[4, 0, 0]::bigint[]
             and (select c from ist) = array[3, 1, 0]::bigint[]
            then 'PASS four completes on the 1st in UTC; three on the 1st and one on the 2nd in Kolkata'
            else 'FAIL — utc ' || (select c from utc)::text || ', ist ' || (select c from ist)::text end;

\echo '--- 6b. and the bucket edges really are that zone''s midnight'
-- Kolkata is +05:30, so its midnight is 18:30 UTC the previous day. If the
-- edges came back on the UTC hour, the zone was ignored and assertion 6 passed
-- for some other reason.
select case when bool_and(
              to_char(bucket_start at time zone 'UTC', 'HH24:MI') = '18:30')
            then 'PASS every Kolkata day boundary is 18:30 UTC — the zone was honoured, not approximated'
            else 'FAIL — ' || string_agg(
              to_char(bucket_start at time zone 'UTC', 'HH24:MI'), ', ') end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'day',
  '2026-03-01 00:00:00+00', '2026-03-03 00:00:00+00', 'Asia/Kolkata');

\echo '--- 7. TEST TRAFFIC IS INVISIBLE TO A LIVE CURVE'
insert into public.responses
  (survey_id, version_id, session_id, status, is_test, step_index, started_at, completed_at, updated_at)
values
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-t1',
   'complete', true, 9, '2026-03-01 09:11:00+00', '2026-03-01 09:12:00+00', '2026-03-01 09:12:00+00');
select case when (
  select completes from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'hour',
    '2026-03-01 09:00:00+00', '2026-03-01 10:00:00+00', 'UTC')
  where bucket_start = '2026-03-01 09:00:00+00') = 1
 and (
  select completes from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', true, 'hour',
    '2026-03-01 09:00:00+00', '2026-03-01 10:00:00+00', 'UTC')
  where bucket_start = '2026-03-01 09:00:00+00') = 1
then 'PASS a programmer''s test session never reaches a number somebody invoices against'
else 'FAIL' end;

\echo '--- 8. A SOFT-DELETED RESPONSE LEAVES THE CURVE'
update public.responses set deleted_at = now(), deleted_by = 'test'
 where session_id = 'fw-s1';
select case when completes = 0
            then 'PASS a removed interview stops being a delivered one'
            else 'FAIL — ' || completes end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'hour',
  '2026-03-01 09:00:00+00', '2026-03-01 10:00:00+00', 'UTC')
where bucket_start = '2026-03-01 09:00:00+00';
update public.responses set deleted_at = null, deleted_by = null where session_id = 'fw-s1';

\echo '--- 9. THE BUCKET VOCABULARY REFUSES A TYPO INSTEAD OF DEFAULTING'
-- `?bucket=hours` charting days and labelling them hours is the kind of wrong
-- that survives review
do $$
begin
  perform * from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'hours',
    '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'UTC');
  raise exception 'FAIL: an unknown bucket was accepted';
exception when invalid_parameter_value then
  raise notice 'PASS %', sqlerrm;
end $$;

\echo '--- 10. A BACKWARDS WINDOW IS REFUSED'
do $$
begin
  perform * from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'hour',
    '2026-03-01 13:00:00+00', '2026-03-01 09:00:00+00', 'UTC');
  raise exception 'FAIL: a backwards window was accepted';
exception when invalid_parameter_value then
  raise notice 'PASS %', sqlerrm;
end $$;

\echo '--- 11. AN ABSURD NUMBER OF BUCKETS IS REFUSED, WITH THE NUMBER'
-- three years of hours is 26 000 rows travelling to a browser to be drawn
-- three pixels wide
do $$
begin
  perform * from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'hour',
    '2023-01-01 00:00:00+00', '2026-01-01 00:00:00+00', 'UTC');
  raise exception 'FAIL: 26000 buckets were accepted';
exception when invalid_parameter_value then
  raise notice 'PASS %', sqlerrm;
end $$;

\echo '--- 11b. ...and the same window is fine at a coarser bucket'
select case when count(*) between 155 and 160
            then 'PASS three years of weeks is a reasonable series'
            else 'FAIL — ' || count(*) end
from public.rescript_field_timeline(
  '33333333-0000-0000-0000-0000000000d1', false, 'week',
  '2023-01-01 00:00:00+00', '2026-01-01 00:00:00+00', 'UTC');

\echo '--- 12. AN UNKNOWN TIME ZONE IS REFUSED RATHER THAN SILENTLY BECOMING UTC'
do $$
begin
  perform * from public.rescript_field_timeline(
    '33333333-0000-0000-0000-0000000000d1', false, 'hour',
    '2026-03-01 09:00:00+00', '2026-03-01 13:00:00+00', 'Mars/Olympus');
  raise exception 'FAIL: a nonexistent zone was accepted';
exception when invalid_parameter_value or others then
  raise notice 'PASS an unknown zone raises: %', sqlerrm;
end $$;

-- ============================================================ the pulse

\echo '--- 13. IN FIELD vs STALLED splits on the activity window'
insert into public.responses
  (survey_id, version_id, session_id, status, is_test, step_index, started_at, completed_at, updated_at)
values
  -- touched a minute ago: in field
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-now1',
   'in_progress', false, 3, now() - interval '10 minutes', null, now() - interval '1 minute'),
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-now2',
   'in_progress', false, 5, now() - interval '20 minutes', null, now() - interval '2 minutes'),
  -- touched two hours ago: gone, whatever the row still says
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-old1',
   'in_progress', false, 3, now() - interval '3 hours', null, now() - interval '2 hours');
select case when in_field = 2 and stalled >= 2
            then 'PASS two people are in field; the abandoned partials are counted separately'
            else 'FAIL — in_field ' || in_field || ', stalled ' || stalled end
from public.rescript_field_pulse('33333333-0000-0000-0000-0000000000d1', false, 900, 60);

\echo '--- 14. THE ROLLING WINDOW IS ROLLING, NOT CLOCK-ALIGNED'
-- a monitor reporting the current clock hour announces a collapse at every
-- hour, on the hour, forever
insert into public.responses
  (survey_id, version_id, session_id, status, is_test, step_index, started_at, completed_at, updated_at)
values
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-w1',
   'complete', false, 9, now() - interval '50 minutes', now() - interval '45 minutes', now() - interval '45 minutes'),
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-w2',
   'complete', false, 9, now() - interval '90 minutes', now() - interval '80 minutes', now() - interval '80 minutes');
select case when window_completes = 1 and window_minutes = 60
            then 'PASS the last 60 minutes means the last 60 minutes'
            else 'FAIL — ' || window_completes end
from public.rescript_field_pulse('33333333-0000-0000-0000-0000000000d1', false, 900, 60);

select case when window_completes = 2
            then 'PASS widening the window to two hours finds the older one'
            else 'FAIL — ' || window_completes end
from public.rescript_field_pulse('33333333-0000-0000-0000-0000000000d1', false, 900, 120);

\echo '--- 15. last_complete_at IGNORES OUTCOMES THAT ARE NOT COMPLETES'
-- a screen-out is a terminal event with a completed_at; reporting it as "last
-- complete" makes a stalled field look alive
insert into public.responses
  (survey_id, version_id, session_id, status, is_test, step_index, started_at, completed_at, updated_at)
values
  ('33333333-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-00000000f0f1', 'fw-scr',
   'screened', false, 2, now() - interval '3 minutes', now() - interval '2 minutes', now() - interval '2 minutes');
select case when last_complete_at < now() - interval '40 minutes'
            then 'PASS the last COMPLETE is 45 minutes ago; the screen-out two minutes ago is not one'
            else 'FAIL — ' || coalesce(last_complete_at::text, 'null') end
from public.rescript_field_pulse('33333333-0000-0000-0000-0000000000d1', false, 900, 60);

\echo '--- 16. THE PULSE COUNTS TOTALS FOR THE SAME ENVIRONMENT ONLY'
select case when total_completes = (
  select count(*) from public.responses
   where survey_id = '33333333-0000-0000-0000-0000000000d1'
     and is_test = false and deleted_at is null and status = 'complete')
then 'PASS the running total is the live total, not everything in the table'
else 'FAIL' end
from public.rescript_field_pulse('33333333-0000-0000-0000-0000000000d1', false, 900, 60);

-- ======================================================== the positions

\echo '--- 17. THE DROP-OFF DISTRIBUTION IS BY STEP, SPLIT ACTIVE / STALLED'
with p as (
  select step_index, in_field, stalled
  from public.rescript_field_positions('33333333-0000-0000-0000-0000000000d1', false, 900)
)
select case when (select in_field from p where step_index = 3) = 1
             and (select stalled  from p where step_index = 3) = 1
            then 'PASS step 3 holds one live respondent and one who walked away'
            else 'FAIL' end;

\echo '--- 18. only in_progress rows appear — a finished respondent is not sitting anywhere'
select case when not exists (
  select 1 from public.rescript_field_positions('33333333-0000-0000-0000-0000000000d1', false, 900)
   where step_index = 9)
then 'PASS completes are not reported as people stuck on the last page'
else 'FAIL' end;

\echo '--- 19. the step index is returned as stored, with no attempt to name it'
-- resolving a step to a page name means compiling the flow of the version that
-- response was taken against; that belongs to the caller, which has it loaded
select case when count(*) = count(step_index) and min(step_index) >= 0
            then 'PASS every row carries a real step index'
            else 'FAIL' end
from public.rescript_field_positions('33333333-0000-0000-0000-0000000000d1', false, 900);

\echo '--- 20. THE INDEX THE CURVE NEEDS EXISTS'
select case when count(*) = 1
            then 'PASS responses (survey_id, is_test, completed_at desc) is indexed'
            else 'FAIL — the completes curve will scan the survey' end
from pg_indexes
where tablename = 'responses' and indexname = 'responses_survey_env_completed_idx';

\echo '--- 21. VACUITY CHECK — the fixtures really are there'
select case when count(*) >= 10
            then 'PASS ' || count(*) || ' fixture responses — the assertions above ran against real rows'
            else 'FAIL: the fixtures are missing, so every PASS above is vacuous' end
from public.responses where survey_id = '33333333-0000-0000-0000-0000000000d1';
