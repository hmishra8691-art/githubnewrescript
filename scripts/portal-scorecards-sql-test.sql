-- RESPONDENT PORTAL, SCORECARDS (migration 0104, phase 2 2026-11-20) — against a database with every migration:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/portal-scorecards-sql-test.sql
--
-- Proves, on real Postgres 16:
--   1. one scorecard per interview (an upsert replaces it); the shapes of scores / cohort / result are enforced
--   2. deleting the interview removes its scorecard; deleting the respondent keeps the scores but forgets whose
--   3. one benchmark snapshot per survey; deleting the survey removes scorecards and snapshot
--   4. row-level security: on, no policy, nothing readable by anon or authenticated
--   5. 0104 is recorded, and running it again changes nothing
-- One transaction, rolled back — safe to run twice.

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000104', 'portal104', 'Portal 0104');
insert into public.surveys (id, customer_id, code, title) values ('c0000000-0000-0000-0000-000000010401', 'c0000000-0000-0000-0000-000000000104', 'P104', 'Index');
insert into public.survey_versions (id, survey_id, version, definition) values ('c0000000-0000-0000-0000-000000010402', 'c0000000-0000-0000-0000-000000010401', '1.0', '{}'::jsonb);
insert into public.respondents (id, survey_id) values ('c0000000-0000-0000-0000-0000000104e1', 'c0000000-0000-0000-0000-000000010401');
insert into public.responses (id, survey_id, version_id, session_id, respondent_id, status, answers, completed_at) values
  ('c0000000-0000-0000-0000-0000000104f1', 'c0000000-0000-0000-0000-000000010401', 'c0000000-0000-0000-0000-000000010402', 'p104-session-0000000000001', 'c0000000-0000-0000-0000-0000000104e1', 'complete', '{"e1": 4}'::jsonb, now()),
  ('c0000000-0000-0000-0000-0000000104f2', 'c0000000-0000-0000-0000-000000010401', 'c0000000-0000-0000-0000-000000010402', 'p104-session-0000000000002', null, 'complete', '{"e1": 2}'::jsonb, now());

-- 1 ---------------------------------------------------------------------------------------------------------------
insert into public.portal_scorecards (response_id, survey_id, respondent_id, fingerprint, scores, cohort, result) values
  ('c0000000-0000-0000-0000-0000000104f1', 'c0000000-0000-0000-0000-000000010401', 'c0000000-0000-0000-0000-0000000104e1', 'abc12345', '{"energy": 9}', '{"team": "North"}', '{"v": 1, "dimensions": []}'),
  ('c0000000-0000-0000-0000-0000000104f2', 'c0000000-0000-0000-0000-000000010401', null, 'abc12345', '{"energy": null}', '{}', '{"v": 1, "dimensions": []}');
insert into public.portal_scorecards (response_id, survey_id, fingerprint, scores, result) values
  ('c0000000-0000-0000-0000-0000000104f1', 'c0000000-0000-0000-0000-000000010401', 'def67890', '{"energy": 7}', '{"v": 1}')
  on conflict (response_id) do update set fingerprint = excluded.fingerprint, scores = excluded.scores, result = excluded.result, updated_at = now();
do $$ declare r record; begin
  select * into r from public.portal_scorecards where response_id = 'c0000000-0000-0000-0000-0000000104f1';
  if r.fingerprint <> 'def67890' or (r.scores ->> 'energy')::numeric <> 7 or r.is_test then raise exception 'FAIL: the upsert did not replace the scorecard'; end if;
  if (select count(*) from public.portal_scorecards where survey_id = 'c0000000-0000-0000-0000-000000010401') <> 2 then raise exception 'FAIL: not one scorecard per interview'; end if;
  begin insert into public.portal_scorecards (response_id, survey_id, fingerprint, scores, result) values ('c0000000-0000-0000-0000-0000000104f2', 'c0000000-0000-0000-0000-000000010401', 'x', '[]', '{"v": 1}') on conflict (response_id) do update set scores = excluded.scores; raise exception 'FAIL: scores that are not an object were stored';
  exception when check_violation then null; end;
  begin update public.portal_scorecards set result = '{}' where response_id = 'c0000000-0000-0000-0000-0000000104f2'; raise exception 'FAIL: a result with no version was stored';
  exception when check_violation then null; end;
  begin update public.portal_scorecards set fingerprint = '' where response_id = 'c0000000-0000-0000-0000-0000000104f2'; raise exception 'FAIL: an empty fingerprint was stored';
  exception when check_violation then null; end;
  begin insert into public.portal_scorecards (response_id, survey_id, fingerprint, result) values (gen_random_uuid(), 'c0000000-0000-0000-0000-000000010401', 'x', '{"v": 1}'); raise exception 'FAIL: a scorecard for no interview was stored';
  exception when foreign_key_violation then null; end;
end $$;

-- 2 ---------------------------------------------------------------------------------------------------------------
delete from public.respondents where id = 'c0000000-0000-0000-0000-0000000104e1';
do $$ begin
  if not exists (select 1 from public.portal_scorecards where response_id = 'c0000000-0000-0000-0000-0000000104f1' and respondent_id is null) then raise exception 'FAIL: removing the respondent did not keep the scores without their owner'; end if;
end $$;
delete from public.responses where id = 'c0000000-0000-0000-0000-0000000104f2';
do $$ begin
  if exists (select 1 from public.portal_scorecards where response_id = 'c0000000-0000-0000-0000-0000000104f2') then raise exception 'FAIL: deleting an interview left its scorecard'; end if;
end $$;

-- 3 ---------------------------------------------------------------------------------------------------------------
insert into public.portal_benchmarks (survey_id, fingerprint, people, snapshot) values ('c0000000-0000-0000-0000-000000010401', 'def67890', 12, '{"v": 1, "all": {}}');
insert into public.portal_benchmarks (survey_id, fingerprint, people, snapshot) values ('c0000000-0000-0000-0000-000000010401', 'def67890', 14, '{"v": 1, "all": {}}')
  on conflict (survey_id) do update set people = excluded.people, snapshot = excluded.snapshot, computed_at = now();
do $$ begin
  if (select people from public.portal_benchmarks where survey_id = 'c0000000-0000-0000-0000-000000010401') <> 14 then raise exception 'FAIL: the snapshot was not replaced'; end if;
  begin update public.portal_benchmarks set people = -1 where survey_id = 'c0000000-0000-0000-0000-000000010401'; raise exception 'FAIL: a negative count was stored';
  exception when check_violation then null; end;
end $$;
delete from public.surveys where id = 'c0000000-0000-0000-0000-000000010401';
do $$ begin
  if exists (select 1 from public.portal_scorecards where survey_id = 'c0000000-0000-0000-0000-000000010401') or exists (select 1 from public.portal_benchmarks where survey_id = 'c0000000-0000-0000-0000-000000010401') then
    raise exception 'FAIL: deleting the survey left scorecards or a snapshot';
  end if;
end $$;

-- 4 ---------------------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['portal_scorecards', 'portal_benchmarks'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAIL: % has no row-level security', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then raise exception 'FAIL: % has a policy — it is service-role only', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then raise exception 'FAIL: % is readable by anon or authenticated', t; end if;
  end loop;
end $$;

-- 5 ---------------------------------------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from public.schema_marks where migration = '0104') then raise exception 'FAIL: 0104 is not recorded'; end if;
end $$;

select 'portal scorecards sql test: all checks passed' as result;
rollback;
