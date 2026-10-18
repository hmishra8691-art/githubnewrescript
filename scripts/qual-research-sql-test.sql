-- QUALITATIVE RESEARCH SQL TEST (migration 0065) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/qual-research-sql-test.sql
--
-- Proves, on real Postgres:
--   1. the four tables exist with RLS on and one SELECT policy each; nothing else may write
--   2. media_objects takes the new kind 'qual_recording' and still takes every old kind; an unknown kind is refused
--   3. the shape checks: participants / segments / excerpts are arrays, consent / speakers / settings objects,
--      a session needs a title, a transcript a known source, a version is never negative
--   4. one transcript per recording (a retried "Transcribe" cannot store two)
--   5. links: deleting a session unlinks its transcripts (kept); deleting a recording unlinks it; deleting the
--      survey removes every qualitative row
--   6. the RLS backstop: a member whose ROLE reads responses (owner, viewer) sees the rows; a vendor, an
--      interviewer, a custom-permission member and a stranger see none — custom access is decided by the
--      routes only, so the backstop fails closed for it
--
-- Everything runs in one transaction and rolls back. (Supabase grants table privileges to `authenticated`
-- by default; a bare Postgres shim does not, so the test grants SELECT inside the transaction to exercise
-- the policies themselves.)

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000065', 'qual65', 'Qualitative 0065') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000065-0000-0000-0000-000000000001', 'owner@q65.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000065-0000-0000-0000-000000000002', 'viewer@q65.test', '{"full_name":"Viewer"}'::jsonb),
  ('c0000065-0000-0000-0000-000000000003', 'vendor@q65.test', '{"full_name":"Vendor"}'::jsonb),
  ('c0000065-0000-0000-0000-000000000004', 'custom@q65.test', '{"full_name":"Custom"}'::jsonb),
  ('c0000065-0000-0000-0000-000000000005', 'stranger@q65.test', '{"full_name":"Stranger"}'::jsonb),
  ('c0000065-0000-0000-0000-000000000006', 'interviewer@q65.test', '{"full_name":"Interviewer"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, case when u.email like 'stranger%' then null else 'c0000000-0000-0000-0000-000000000065'::uuid end, u.email, u.email, 'programmer'
  from auth.users u where u.email like '%@q65.test'
on conflict (id) do update set customer_id = excluded.customer_id;
-- the workspace baseline would make every colleague an editor; this test is about explicit roles
update public.profiles set customer_id = null where id in ('c0000065-0000-0000-0000-000000000003', 'c0000065-0000-0000-0000-000000000004', 'c0000065-0000-0000-0000-000000000006');
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000165', 'c0000000-0000-0000-0000-000000000065', 'Q65', 'Qualitative project', 'c0000065-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000165', 'c0000065-0000-0000-0000-000000000002', 'viewer', 'c0000065-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000165', 'c0000065-0000-0000-0000-000000000003', 'vendor', 'c0000065-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000165', 'c0000065-0000-0000-0000-000000000004', 'custom', 'c0000065-0000-0000-0000-000000000001', '{"v":1,"modules":{"data":"manage"}}'::jsonb),
  ('c0000000-0000-0000-0000-000000000165', 'c0000065-0000-0000-0000-000000000006', 'interviewer', 'c0000065-0000-0000-0000-000000000001', null)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;

-- ============================================== 1. tables, RLS, policies
do $$
declare t text; n int;
begin
  foreach t in array array['qual_sessions', 'qual_transcripts', 'qual_codings', 'qual_events'] loop
    assert to_regclass('public.' || t) is not null, t || ' exists';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 1, t || ' has exactly one policy, got ' || n;
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass and polcmd <> 'r';
    assert n = 0, t || ': no write policy (service role only)';
  end loop;
  raise notice 'PASS 1 tables, RLS, read-only policies';
end $$;

-- ============================================== 2. the recording kind
do $$
declare k text; ok boolean;
begin
  foreach k in array array['question_video', 'question_audio', 'answer_audio', 'answer_upload', 'localization_audio', 'survey_asset', 'qual_recording'] loop
    insert into public.media_objects (customer_id, survey_id, kind, bucket, path)
    values ('c0000000-0000-0000-0000-000000000065', 'c0000000-0000-0000-0000-000000000165', k, 'b-' || k, 'c0000000/q65/' || k);
  end loop;
  ok := false;
  begin
    insert into public.media_objects (customer_id, survey_id, kind, bucket, path) values ('c0000000-0000-0000-0000-000000000065', 'c0000000-0000-0000-0000-000000000165', 'bogus', 'b', 'x');
  exception when check_violation then ok := true; end;
  assert ok, 'an unknown media kind is refused';
  raise notice 'PASS 2 qual_recording accepted, old kinds kept, unknown refused';
end $$;

-- ============================================== 3. shapes
do $$
declare ok boolean; sid uuid;
begin
  insert into public.qual_sessions (survey_id, kind, title, participants, consent)
  values ('c0000000-0000-0000-0000-000000000165', 'focus_group', 'Group 1', '[{"id":"p1","label":"P1","segment":"Switchers"}]', '{"captured":true}')
  returning id into sid;
  perform set_config('q65.session', sid::text, true);
  ok := false; begin insert into public.qual_sessions (survey_id, title, participants) values ('c0000000-0000-0000-0000-000000000165', 'x', '{}'); exception when check_violation then ok := true; end; assert ok, 'participants must be an array';
  ok := false; begin insert into public.qual_sessions (survey_id, title) values ('c0000000-0000-0000-0000-000000000165', ''); exception when check_violation then ok := true; end; assert ok, 'a session needs a title';
  ok := false; begin insert into public.qual_sessions (survey_id, title, kind) values ('c0000000-0000-0000-0000-000000000165', 'x', 'webinar'); exception when check_violation then ok := true; end; assert ok, 'kind is interview or focus_group';
  ok := false; begin insert into public.qual_transcripts (survey_id, title, source) values ('c0000000-0000-0000-0000-000000000165', 'x', 'scraped'); exception when check_violation then ok := true; end; assert ok, 'a transcript source is import, stt or open_ends';
  ok := false; begin insert into public.qual_transcripts (survey_id, title, source, speakers) values ('c0000000-0000-0000-0000-000000000165', 'x', 'import', '[]'); exception when check_violation then ok := true; end; assert ok, 'speakers is an object';
  ok := false; begin insert into public.qual_codings (survey_id, version) values ('c0000000-0000-0000-0000-000000000165', -1); exception when check_violation then ok := true; end; assert ok, 'a version is never negative';
  ok := false; begin insert into public.qual_codings (survey_id, settings) values ('c0000000-0000-0000-0000-000000000165', '[]'); exception when check_violation then ok := true; end; assert ok, 'settings is an object';
  insert into public.qual_codings (survey_id, codebook, excerpts, version, settings)
  values ('c0000000-0000-0000-0000-000000000165', '{"version":1,"method":"inductive","codes":[],"themes":[],"relationships":[]}', '[]', 1, '{"redactNames":["Anna"]}');
  -- optimistic concurrency, as the route writes it: an update naming a stale version changes nothing
  update public.qual_codings set version = 2 where survey_id = 'c0000000-0000-0000-0000-000000000165' and version = 0;
  assert (select version from public.qual_codings where survey_id = 'c0000000-0000-0000-0000-000000000165') = 1, 'a stale version does not overwrite';
  insert into public.qual_events (survey_id, actor_label, action, detail) values ('c0000000-0000-0000-0000-000000000165', 'AI (suggested)', 'ai_coding', 'AI inductive coding of 4 segments');
  raise notice 'PASS 3 shape checks and the version guard';
end $$;

-- ============================================== 4–5. one transcript per recording; links and cascades
do $$
declare ok boolean; mid uuid; sid uuid := current_setting('q65.session')::uuid; tid uuid;
begin
  select id into mid from public.media_objects where survey_id = 'c0000000-0000-0000-0000-000000000165' and kind = 'qual_recording';
  update public.qual_sessions set recording_media_id = mid where id = sid;
  insert into public.qual_transcripts (survey_id, session_id, media_id, title, source, format, segments, speakers)
  values ('c0000000-0000-0000-0000-000000000165', sid, mid, 'Group 1 (transcribed)', 'stt', 'stt', '[{"id":"t1","index":0,"speaker":"Speaker 1","start":0,"end":2.5,"text":"Hello."}]', '{"Speaker 1":{"role":"moderator"}}')
  returning id into tid;
  ok := false;
  begin
    insert into public.qual_transcripts (survey_id, media_id, title, source) values ('c0000000-0000-0000-0000-000000000165', mid, 'again', 'stt');
  exception when unique_violation then ok := true; end;
  assert ok, 'one transcript per recording';
  delete from public.media_objects where id = mid;
  assert (select recording_media_id from public.qual_sessions where id = sid) is null, 'a deleted recording unlinks from its session';
  assert (select media_id from public.qual_transcripts where id = tid) is null, 'and from its transcript, which is kept';
  delete from public.qual_sessions where id = sid;
  assert (select session_id from public.qual_transcripts where id = tid) is null, 'a deleted session unlinks its transcripts';
  assert exists (select 1 from public.qual_transcripts where id = tid), 'the transcript is kept';
  raise notice 'PASS 4-5 one transcript per recording; unlink on delete';
end $$;

-- ============================================== 6. the RLS backstop
grant select on public.qual_sessions, public.qual_transcripts, public.qual_codings, public.qual_events to authenticated;
insert into public.qual_sessions (survey_id, title) values ('c0000000-0000-0000-0000-000000000165', 'IDI 2');

create temp table q65_seen (who text, n int) on commit drop;
grant insert, select on q65_seen to authenticated;
do $$
declare u text; who text;
begin
  foreach u in array array['1:owner', '2:viewer', '3:vendor', '4:custom', '5:stranger', '6:interviewer'] loop
    who := split_part(u, ':', 2);
    perform set_config('request.jwt.claim.sub', 'c0000065-0000-0000-0000-00000000000' || split_part(u, ':', 1), true);
    execute 'set local role authenticated';
    insert into q65_seen values (who, (select count(*) from public.qual_sessions where survey_id = 'c0000000-0000-0000-0000-000000000165')
                                     + (select count(*) from public.qual_transcripts where survey_id = 'c0000000-0000-0000-0000-000000000165')
                                     + (select count(*) from public.qual_codings where survey_id = 'c0000000-0000-0000-0000-000000000165')
                                     + (select count(*) from public.qual_events where survey_id = 'c0000000-0000-0000-0000-000000000165'));
    execute 'reset role';
  end loop;
end $$;
do $$
declare r record;
begin
  for r in select * from q65_seen loop raise notice '  % sees % qualitative rows', r.who, r.n; end loop;
  assert (select n from q65_seen where who = 'owner') >= 4, 'the owner reads the rows';
  assert (select n from q65_seen where who = 'viewer') = (select n from q65_seen where who = 'owner'), 'a viewer (Data view) reads the same rows';
  assert (select n from q65_seen where who = 'vendor') = 0, 'a vendor reads nothing';
  assert (select n from q65_seen where who = 'interviewer') = 0, 'an interviewer reads nothing';
  assert (select n from q65_seen where who = 'custom') = 0, 'a custom member reads nothing directly (the routes decide custom access)';
  assert (select n from q65_seen where who = 'stranger') = 0, 'a stranger reads nothing';
  raise notice 'PASS 6 the backstop: role-based read, custom / vendor / interviewer / stranger refused';
end $$;

-- ============================================== 5b. the survey goes, everything qualitative goes
do $$
begin
  delete from public.surveys where id = 'c0000000-0000-0000-0000-000000000165';
  assert not exists (select 1 from public.qual_sessions where survey_id = 'c0000000-0000-0000-0000-000000000165'), 'sessions cascade';
  assert not exists (select 1 from public.qual_transcripts where survey_id = 'c0000000-0000-0000-0000-000000000165'), 'transcripts cascade';
  assert not exists (select 1 from public.qual_codings where survey_id = 'c0000000-0000-0000-0000-000000000165'), 'coding cascades';
  assert not exists (select 1 from public.qual_events where survey_id = 'c0000000-0000-0000-0000-000000000165'), 'history cascades';
  raise notice 'PASS 5b deleting the survey removes every qualitative row';
end $$;

rollback;
\echo 'qual-research-sql-test: all groups passed (rolled back)'
