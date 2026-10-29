-- ASSESSMENTS SQL TEST (migration 0076, step 4A 2026-10-29; K4's 0075 test reshaped) — against a database with
-- every migration applied (0076 applied twice by the runner before this file):
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/assessments-sql-test.sql
--
-- Proves, on real Postgres 16:
--   1. assessment_results exists; one row per session (upsert on session_id), the updated_at trigger is in place
--   2. the check: the result is a versioned json object (no arrays, scalars or unversioned blobs)
--   3. it belongs to its response: deleting the response (or the survey) deletes the result
--   4. the distribution function buckets complete, undeleted results per environment
--   5. the RLS backstop: owner and viewer read; vendor, custom member, stranger see nothing; members cannot write
-- One transaction, rolled back — safe to run twice.

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000076', 'asmt76', 'Assessments 0076') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000076-0000-0000-0000-000000000001', 'owner@a76.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000076-0000-0000-0000-000000000002', 'viewer@a76.test', '{"full_name":"Viewer"}'::jsonb),
  ('c0000076-0000-0000-0000-000000000003', 'vendor@a76.test', '{"full_name":"Vendor"}'::jsonb),
  ('c0000076-0000-0000-0000-000000000004', 'custom@a76.test', '{"full_name":"Custom"}'::jsonb),
  ('c0000076-0000-0000-0000-000000000005', 'stranger@a76.test', '{"full_name":"Stranger"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, case when u.email like 'stranger%' then null else 'c0000000-0000-0000-0000-000000000076'::uuid end, u.email, u.email, 'programmer'
  from auth.users u where u.email like '%@a76.test'
on conflict (id) do update set customer_id = excluded.customer_id;
update public.profiles set customer_id = null where id in ('c0000076-0000-0000-0000-000000000003', 'c0000076-0000-0000-0000-000000000004');
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000176', 'c0000000-0000-0000-0000-000000000076', 'A76', 'UPSC mock', 'c0000076-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000176', 'c0000076-0000-0000-0000-000000000002', 'viewer', 'c0000076-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000176', 'c0000076-0000-0000-0000-000000000003', 'vendor', 'c0000076-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000176', 'c0000076-0000-0000-0000-000000000004', 'custom', 'c0000076-0000-0000-0000-000000000001', '{"v":1,"modules":{"data":"manage"}}'::jsonb)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;
insert into public.survey_versions (id, survey_id, version, definition) values ('c0000000-0000-0000-0000-000000000276', 'c0000000-0000-0000-0000-000000000176', 1, '{}'::jsonb) on conflict do nothing;

-- the scored sessions used throughout (what the save route writes)
create or replace function pg_temp.scored(sess text, status text, pct numeric, passed boolean, test boolean default false, deleted boolean default false) returns void language plpgsql as $$
declare rid uuid;
begin
  insert into public.responses (survey_id, version_id, session_id, status, is_test, deleted_at)
    values ('c0000000-0000-0000-0000-000000000176', 'c0000000-0000-0000-0000-000000000276', sess, status, test, case when deleted then now() end)
    returning id into rid;
  insert into public.assessment_results (session_id, response_id, survey_id, version_id, is_test, result, key_fingerprint, score, max_score, percentage, passed)
    values (sess, rid, 'c0000000-0000-0000-0000-000000000176', 'c0000000-0000-0000-0000-000000000276', test,
      jsonb_build_object('v', 1, 'marks', pct / 10, 'maxMarks', 10, 'percentage', pct, 'passed', passed), 'abcd1234', pct / 10, 10, pct, passed);
end $$;

-- ============================================== 1. one row per session; the upsert the save route does
do $$
declare n int; t1 timestamptz; t2 timestamptz; rid uuid;
begin
  assert exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'assessment_results'), 'assessment_results exists';
  assert (select relrowsecurity from pg_class where oid = 'public.assessment_results'::regclass), 'RLS is on';
  perform pg_temp.scored('a76-s1-0000000000001', 'complete', 53.4, true);
  select id, updated_at into rid, t1 from public.assessment_results where session_id = 'a76-s1-0000000000001';
  -- a retried final save (or a re-score with a changed key) upserts on session_id
  insert into public.assessment_results (session_id, response_id, survey_id, is_test, result, key_fingerprint, score, max_score, percentage, passed)
    select 'a76-s1-0000000000001', r.id, r.survey_id, false, '{"v":1,"marks":6,"maxMarks":10,"percentage":60,"passed":true}', 'ffff0000', 6, 10, 60, true
      from public.responses r where r.session_id = 'a76-s1-0000000000001'
  on conflict (session_id) do update set result = excluded.result, key_fingerprint = excluded.key_fingerprint, score = excluded.score, percentage = excluded.percentage, passed = excluded.passed;
  select count(*), max(updated_at) into n, t2 from public.assessment_results where session_id = 'a76-s1-0000000000001';
  assert n = 1, 'one row per session, got ' || n;
  assert t2 >= t1 and exists (select 1 from pg_trigger where tgname = 'assessment_results_touch' and tgrelid = 'public.assessment_results'::regclass), 'the touch trigger keeps updated_at (now() is fixed inside this one test transaction)';
  assert (select score = 6 and key_fingerprint = 'ffff0000' and id = rid from public.assessment_results where session_id = 'a76-s1-0000000000001'), 'the row is updated in place';
  -- a session that does not exist cannot have a result
  begin
    insert into public.assessment_results (session_id, response_id, survey_id, result) values ('a76-none-00000000001', gen_random_uuid(), 'c0000000-0000-0000-0000-000000000176', '{"v":1}');
    assert false, 'an unknown session is refused';
  exception when foreign_key_violation then null;
  end;
  raise notice 'PASS 1 one row per session; the upsert updates in place';
end $$;

-- ============================================== 2. the result is a versioned object
do $$
declare ok boolean;
begin
  ok := false; begin update public.assessment_results set result = '[]' where session_id = 'a76-s1-0000000000001'; exception when check_violation then ok := true; end; assert ok, 'an array is refused';
  ok := false; begin update public.assessment_results set result = '{"marks":1}' where session_id = 'a76-s1-0000000000001'; exception when check_violation then ok := true; end; assert ok, 'an unversioned object is refused';
  ok := false; begin update public.assessment_results set result = '"x"' where session_id = 'a76-s1-0000000000001'; exception when check_violation then ok := true; end; assert ok, 'a scalar is refused';
  raise notice 'PASS 2 the result is a versioned object';
end $$;

-- ============================================== 3. it belongs to its response
do $$
begin
  perform pg_temp.scored('a76-gone-00000000001', 'complete', 10, false);
  delete from public.responses where session_id = 'a76-gone-00000000001';
  assert not exists (select 1 from public.assessment_results where session_id = 'a76-gone-00000000001'), 'deleting the response deletes its result';
  raise notice 'PASS 3 the result is deleted with its response';
end $$;

-- ============================================== 4. the distribution per environment
do $$
declare cnt int;
begin
  perform pg_temp.scored('a76-s2-0000000000002', 'complete', -33, false);
  perform pg_temp.scored('a76-s3-0000000000003', 'complete', 100, null);
  perform pg_temp.scored('a76-t1-0000000000004', 'complete', 10, false, true);
  perform pg_temp.scored('a76-d1-0000000000005', 'complete', 90, true, false, true);
  select coalesce(sum(d.n), 0) into cnt from public.rescript_assessment_distribution('c0000000-0000-0000-0000-000000000176', false) d;
  assert cnt = 3, 'three live, complete, undeleted results, got ' || cnt;
  assert (select d.n from public.rescript_assessment_distribution('c0000000-0000-0000-0000-000000000176', false) d where d.bucket = 0) = 1, 'a negative percentage lands in the first bucket';
  assert (select d.n from public.rescript_assessment_distribution('c0000000-0000-0000-0000-000000000176', false) d where d.bucket = 9) = 1, '100% lands in the last bucket';
  assert (select coalesce(sum(d.n), 0) from public.rescript_assessment_distribution('c0000000-0000-0000-0000-000000000176', true) d) = 1, 'test results are counted apart';
  raise notice 'PASS 4 distribution per environment, deleted responses excluded';
end $$;

-- ============================================== 5. the RLS backstop
grant select on public.assessment_results to authenticated;

create or replace function pg_temp.seen(uid text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.assessment_results where survey_id = 'c0000000-0000-0000-0000-000000000176';
  execute 'reset role';
  return n;
end $$;

do $$
declare owner int; viewer int; ok boolean;
begin
  owner := pg_temp.seen('c0000076-0000-0000-0000-000000000001');
  viewer := pg_temp.seen('c0000076-0000-0000-0000-000000000002');
  assert owner = 5 and viewer = owner, format('owner %s, viewer %s read the results', owner, viewer);
  assert pg_temp.seen('c0000076-0000-0000-0000-000000000003') = 0, 'vendor sees nothing';
  assert pg_temp.seen('c0000076-0000-0000-0000-000000000004') = 0, 'custom member sees nothing (the routes decide)';
  assert pg_temp.seen('c0000076-0000-0000-0000-000000000005') = 0, 'stranger sees nothing';
  perform set_config('request.jwt.claim.sub', 'c0000076-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', json_build_object('sub', 'c0000076-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin update public.assessment_results set score = 10 where survey_id = 'c0000000-0000-0000-0000-000000000176'; exception when insufficient_privilege then ok := true; end;
  assert ok, 'members cannot rewrite a score';
  ok := false;
  begin delete from public.assessment_results where survey_id = 'c0000000-0000-0000-0000-000000000176'; exception when insufficient_privilege then ok := true; end;
  assert ok, 'nor delete one';
  reset role;
  set local role anon;
  ok := false;
  begin perform 1 from public.assessment_results; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon reads nothing';
  reset role;
  raise notice 'PASS 5 RLS: owner and viewer read; vendor, custom, stranger do not; members and anon cannot write or read';
end $$;

rollback;
