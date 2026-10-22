-- AI-MODERATED INTERVIEWS SQL TEST (migration 0069) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/ai-interviews-sql-test.sql
--
-- Proves, on real Postgres:
--   1. five tables with RLS on and one SELECT policy each; no write policy; the two functions are not
--      executable by anon / authenticated (service role only)
--   2. qual_transcripts takes source / format 'ai_interview' and still every 0065 value; an unknown one is refused
--   3. shapes: link and test tokens are distinct 36-hex secrets; a resume token hash is 64 hex; statuses and
--      modes are checked; one turn per (session, seq); one open (live / paused) study per survey
--   4. rescript_ai_interview_begin: numbers participants 1, 2, …; a full quota cell refuses (completed +
--      in progress count), an interview idle for 30 minutes is swept to abandoned and frees its place; the
--      completes target and the study budget close the link; a paused study admits only test sessions; test
--      sessions never count
--   5. rescript_ai_interview_record_turn: writes the exchange and bumps the version; a stale version (a double
--      submit) writes nothing and returns null; cost is added to the session AND the study; completion
--      stamps completed_at and stops further writes; a duplicate seq rolls the whole exchange back
--   6. links: deleting a qual transcript unlinks the interview (kept); a media row unlinks its turn; deleting
--      the survey removes every AI-interview row
--   7. the RLS backstop: owner and viewer read; vendor, interviewer, custom member and stranger read nothing;
--      a member can never read the link tokens or the resume-token hash
--
-- Everything runs in one transaction and rolls back. (Supabase grants table privileges to `authenticated` by
-- default; a bare Postgres shim does not, so the test grants the same column lists inside the transaction.)

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000069', 'ai69', 'AI interviews 0069') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000069-0000-0000-0000-000000000001', 'owner@a69.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000069-0000-0000-0000-000000000002', 'viewer@a69.test', '{"full_name":"Viewer"}'::jsonb),
  ('c0000069-0000-0000-0000-000000000003', 'vendor@a69.test', '{"full_name":"Vendor"}'::jsonb),
  ('c0000069-0000-0000-0000-000000000004', 'custom@a69.test', '{"full_name":"Custom"}'::jsonb),
  ('c0000069-0000-0000-0000-000000000005', 'stranger@a69.test', '{"full_name":"Stranger"}'::jsonb),
  ('c0000069-0000-0000-0000-000000000006', 'interviewer@a69.test', '{"full_name":"Interviewer"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, case when u.email like 'stranger%' then null else 'c0000000-0000-0000-0000-000000000069'::uuid end, u.email, u.email, 'programmer'
  from auth.users u where u.email like '%@a69.test'
on conflict (id) do update set customer_id = excluded.customer_id;
update public.profiles set customer_id = null where id in ('c0000069-0000-0000-0000-000000000003', 'c0000069-0000-0000-0000-000000000004', 'c0000069-0000-0000-0000-000000000006');
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000169', 'c0000000-0000-0000-0000-000000000069', 'A69', 'AI interviews project', 'c0000069-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000169', 'c0000069-0000-0000-0000-000000000002', 'viewer', 'c0000069-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000169', 'c0000069-0000-0000-0000-000000000003', 'vendor', 'c0000069-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000169', 'c0000069-0000-0000-0000-000000000004', 'custom', 'c0000069-0000-0000-0000-000000000001', '{"v":1,"modules":{"data":"manage"}}'::jsonb),
  ('c0000000-0000-0000-0000-000000000169', 'c0000069-0000-0000-0000-000000000006', 'interviewer', 'c0000069-0000-0000-0000-000000000001', null)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;

-- the study used throughout: 2 completes wanted, a quota of 1 for "Payers", a $1 budget
insert into public.ai_interview_studies (id, survey_id, title, guide)
values ('a6900000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000169', 'Switching IDIs',
  '{"kind":"interview","consent":{"statement":"Voluntary."},"sections":[],"aiModeration":{"targetCompletes":2,"studyBudgetUsd":1}}'::jsonb);
insert into public.ai_interview_quotas (study_id, segment, target) values ('a6900000-0000-0000-0000-000000000001', 'Payers', 1);

create or replace function pg_temp.h(n int) returns text language sql as $$ select encode(sha256(convert_to('tok' || n, 'UTF8')), 'hex') $$;

-- ============================================== 1. tables, RLS, policies, functions
do $$
declare t text; n int;
begin
  foreach t in array array['ai_interview_studies', 'ai_interview_quotas', 'ai_interview_participants', 'ai_interview_sessions', 'ai_interview_turns'] loop
    assert to_regclass('public.' || t) is not null, t || ' exists';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 1, t || ' has exactly one policy, got ' || n;
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass and polcmd <> 'r';
    assert n = 0, t || ': no write policy (service role only)';
  end loop;
  assert not has_function_privilege('authenticated', 'public.rescript_ai_interview_begin(uuid, text, boolean, jsonb, jsonb, text, text, text, text, jsonb, jsonb, boolean)', 'execute'), 'begin is not callable by members';
  assert not has_function_privilege('anon', 'public.rescript_ai_interview_record_turn(uuid, integer, jsonb, jsonb, text, jsonb, integer, numeric, boolean)', 'execute'), 'record_turn is not callable anonymously';
  raise notice 'PASS 1 tables, RLS, read-only policies, service-role functions';
end $$;

-- ============================================== 2. the qualitative source
do $$
declare s text; ok boolean;
begin
  foreach s in array array['import', 'stt', 'open_ends', 'ai_interview'] loop
    insert into public.qual_transcripts (survey_id, title, source, format) values ('c0000000-0000-0000-0000-000000000169', 'src ' || s, s, case when s = 'ai_interview' then 'ai_interview' when s = 'stt' then 'stt' else 'text' end);
  end loop;
  ok := false;
  begin insert into public.qual_transcripts (survey_id, title, source) values ('c0000000-0000-0000-0000-000000000169', 'bad', 'zoom'); exception when check_violation then ok := true; end;
  assert ok, 'an unknown source is refused';
  ok := false;
  begin insert into public.qual_transcripts (survey_id, title, source, format) values ('c0000000-0000-0000-0000-000000000169', 'bad', 'import', 'mp3'); exception when check_violation then ok := true; end;
  assert ok, 'an unknown format is refused';
  raise notice 'PASS 2 ai_interview is a qualitative source; old sources kept; unknown refused';
end $$;

-- ============================================== 3. shapes
do $$
declare st record; ok boolean;
begin
  select * into st from public.ai_interview_studies where id = 'a6900000-0000-0000-0000-000000000001';
  assert st.link_token ~ '^[0-9a-f]{36}$' and st.test_token ~ '^[0-9a-f]{36}$' and st.link_token <> st.test_token, 'two distinct 36-hex tokens';
  assert st.status = 'live', 'launched live';
  ok := false;
  begin insert into public.ai_interview_studies (survey_id, title, guide) values ('c0000000-0000-0000-0000-000000000169', 'second', '{}'::jsonb); exception when unique_violation then ok := true; end;
  assert ok, 'one open study per survey';
  ok := false;
  begin update public.ai_interview_studies set status = 'draft' where id = st.id; exception when check_violation then ok := true; end;
  assert ok, 'status is live / paused / closed';
  ok := false;
  begin insert into public.ai_interview_studies (survey_id, title, guide, status) values ('c0000000-0000-0000-0000-000000000169', 'array guide', '[]'::jsonb, 'closed'); exception when check_violation then ok := true; end;
  assert ok, 'the guide is an object';
  raise notice 'PASS 3 tokens, statuses, one open study, guide shape';
end $$;

-- ============================================== 4. admitting participants
do $$
declare r record; r2 record; sid uuid; ok boolean;
begin
  select * into r from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Payers', false, '{"scr1":"I do"}', '{"statement":true,"recording":false}', 'en', 'panel-1', 'text', pg_temp.h(1), '{"v":1}', '[]');
  assert r.admitted and r.participant_number = 1 and r.session_id is not null, 'first participant admitted as P1';
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Payers', false, '{}', '{}', 'en', null, 'text', pg_temp.h(2), '{}', '[]');
  assert not r2.admitted and r2.reason = 'quota full', 'the Payers cell (1) is held by the interview in progress: ' || coalesce(r2.reason, 'admitted');
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Payers', true, '{}', '{}', 'en', null, 'voice', pg_temp.h(3), '{}', '[]');
  assert r2.admitted and r2.participant_number = 2, 'a test session ignores quotas (and is numbered)';
  -- idle for 31 minutes: abandoned at the next admission, which then takes its place
  update public.ai_interview_sessions set last_activity_at = now() - interval '31 minutes' where id = r.session_id;
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Payers', false, '{}', '{}', 'hi', null, 'video', pg_temp.h(4), '{}', '[]');
  assert r2.admitted and r2.participant_number = 3, 'the abandoned interview freed the cell';
  assert (select status from public.ai_interview_sessions where id = r.session_id) = 'abandoned', 'swept to abandoned';
  ok := false;
  begin perform public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', null, false, '{}', '{}', 'en', null, 'text', pg_temp.h(4), '{}', '[]'); exception when unique_violation then ok := true; end;
  assert ok, 'a resume token hash is unique';
  ok := false;
  begin perform public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', null, false, '{}', '{}', 'en', null, 'hologram', pg_temp.h(5), '{}', '[]'); exception when check_violation then ok := true; end;
  assert ok, 'mode is text / voice / video';
  ok := false;
  begin perform public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', null, false, '{}', '{}', 'en', null, 'text', 'not-a-hash', '{}', '[]'); exception when check_violation then ok := true; end;
  assert ok, 'the token hash is 64 hex';
  -- a segment without a quota is open
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Others', false, '{}', '{}', 'en', null, 'text', pg_temp.h(6), '{}', '[]');
  assert r2.admitted, 'no quota on Others';
  -- two completes: the target closes the link
  update public.ai_interview_sessions set status = 'completed' where study_id = 'a6900000-0000-0000-0000-000000000001' and not is_test and status = 'in_progress';
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Others', false, '{}', '{}', 'en', null, 'text', pg_temp.h(7), '{}', '[]');
  assert not r2.admitted and r2.reason = 'target reached', 'two completes of two: ' || coalesce(r2.reason, 'admitted');
  -- an excluded complete does not count
  update public.ai_interview_sessions set excluded = true where id = (select id from public.ai_interview_sessions where study_id = 'a6900000-0000-0000-0000-000000000001' and status = 'completed' and not is_test order by started_at desc limit 1);
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Others', false, '{}', '{}', 'en', null, 'text', pg_temp.h(8), '{}', '[]');
  assert r2.admitted, 'an excluded interview frees a complete';
  -- the budget closes it too
  update public.ai_interview_studies set spent_usd = 1.5 where id = 'a6900000-0000-0000-0000-000000000001';
  update public.ai_interview_sessions set status = 'flagged' where id = r2.session_id;
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Others', false, '{}', '{}', 'en', null, 'text', pg_temp.h(9), '{}', '[]');
  assert not r2.admitted and r2.reason = 'budget reached', 'the study budget: ' || coalesce(r2.reason, 'admitted');
  update public.ai_interview_studies set spent_usd = 0, status = 'paused' where id = 'a6900000-0000-0000-0000-000000000001';
  update public.ai_interview_sessions set excluded = false;
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', null, false, '{}', '{}', 'en', null, 'text', pg_temp.h(10), '{}', '[]');
  assert not r2.admitted and r2.reason = 'closed', 'paused refuses participants';
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', null, true, '{}', '{}', 'en', null, 'text', pg_temp.h(11), '{}', '[]');
  assert r2.admitted, 'paused still admits the researcher''s test';
  -- a screened-out participant is recorded even when the study is full or paused: numbered, finished, holding no place
  update public.ai_interview_studies set status = 'paused' where id = 'a6900000-0000-0000-0000-000000000001';
  select * into r2 from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', 'Payers', false, '{"scr1":"Someone else","_reason":"scr1"}', '{"statement":true}', 'en', null, 'text', pg_temp.h(12), '{}', '[]', true);
  assert r2.admitted and (select status = 'screened_out' and completed_at is not null from public.ai_interview_sessions where id = r2.session_id), 'screened out is recorded as such';
  update public.ai_interview_studies set status = 'live' where id = 'a6900000-0000-0000-0000-000000000001';
  raise notice 'PASS 4 admission: numbering, quota held by in-progress, abandoned sweep, target, exclusion, budget, pause, tests';
end $$;

-- ============================================== 5. recording an exchange
do $$
declare sid uuid; v int; ok boolean; n int;
begin
  select session_id into sid from public.rescript_ai_interview_begin('a6900000-0000-0000-0000-000000000001', null, true, '{}', '{}', 'en', null, 'text', pg_temp.h(20), '{"v":1}', '[]');
  v := public.rescript_ai_interview_record_turn(sid, 0, '[{"seq":1,"speaker":"moderator","text":"Hi, I''m Alex.","offset_ms":0,"decision":{"intent":"open"}}]', '{"v":1,"seq":1}', 'in_progress', '[]', 1, 0, false);
  assert v = 1, 'version 1 after the opening';
  v := public.rescript_ai_interview_record_turn(sid, 1, '[{"seq":2,"speaker":"participant","text":"The price went up","original_text":"the prize went up","language":"en","offset_ms":12000,"duration_ms":4000},{"seq":3,"speaker":"moderator","text":"What would a fair price be?","offset_ms":15000,"decision":{"intent":"conditional_probe","source":"rules"}}]', '{"v":1,"seq":3}', 'in_progress', '[{"kind":"pii_shared"}]', 3, 0.0123, false);
  assert v = 2, 'version 2';
  assert public.rescript_ai_interview_record_turn(sid, 1, '[{"seq":4,"speaker":"participant","text":"dup","offset_ms":1}]', '{}', 'in_progress', '[]', 4, 1, false) is null, 'a stale version writes nothing';
  select count(*) into n from public.ai_interview_turns where session_id = sid;
  assert n = 3, 'three turns, got ' || n;
  assert (select original_text from public.ai_interview_turns where session_id = sid and seq = 2) = 'the prize went up', 'the STT output before correction is kept';
  assert (select cost_usd from public.ai_interview_sessions where id = sid) = 0.0123, 'session cost';
  assert (select spent_usd from public.ai_interview_studies where id = 'a6900000-0000-0000-0000-000000000001') = 0.0123, 'study spend';
  ok := false;
  begin perform public.rescript_ai_interview_record_turn(sid, 2, '[{"seq":4,"speaker":"participant","text":"a"},{"seq":4,"speaker":"moderator","text":"b"}]', '{"v":9}', 'in_progress', '[]', 5, 0.5, false); exception when unique_violation then ok := true; end;
  assert ok, 'a duplicate seq is refused';
  assert (select version from public.ai_interview_sessions where id = sid) = 2 and (select spent_usd from public.ai_interview_studies where id = 'a6900000-0000-0000-0000-000000000001') = 0.0123, 'and the whole exchange rolled back';
  v := public.rescript_ai_interview_record_turn(sid, 2, '[{"seq":4,"speaker":"participant","text":"25 pounds","offset_ms":20000},{"seq":5,"speaker":"moderator","text":"Thank you very much.","offset_ms":21000}]', '{"v":1,"phase":"done"}', 'completed', '[]', 5, 0, true);
  assert v = 3 and (select completed_at is not null and status = 'completed' from public.ai_interview_sessions where id = sid), 'completion stamped';
  assert public.rescript_ai_interview_record_turn(sid, 3, '[{"seq":6,"speaker":"participant","text":"late"}]', '{}', 'in_progress', '[]', 6, 0, false) is null, 'a finished interview takes no more turns';
  ok := false;
  begin insert into public.ai_interview_turns (session_id, survey_id, seq, speaker, text) values (sid, 'c0000000-0000-0000-0000-000000000169', 9, 'observer', 'x'); exception when check_violation then ok := true; end;
  assert ok, 'speaker is moderator or participant';
  raise notice 'PASS 5 record_turn: version check, turns, original text, cost to session and study, atomic rollback, completion';
end $$;

-- ============================================== 6. links
do $$
declare sid uuid; tid uuid; qsid uuid; mid uuid;
begin
  select id into sid from public.ai_interview_sessions where status = 'completed' and is_test limit 1;
  insert into public.qual_sessions (survey_id, title, status) values ('c0000000-0000-0000-0000-000000000169', 'AI interview — P9', 'completed') returning id into qsid;
  insert into public.qual_transcripts (survey_id, session_id, title, source, format, segments, speakers) values ('c0000000-0000-0000-0000-000000000169', qsid, 'AI interview — P9', 'ai_interview', 'ai_interview', '[{"id":"t1","index":0,"speaker":"Moderator","start":0,"text":"Hi"}]', '{"Moderator":{"role":"moderator"}}') returning id into tid;
  update public.ai_interview_sessions set qual_session_id = qsid, qual_transcript_id = tid where id = sid;
  delete from public.qual_transcripts where id = tid;
  assert (select qual_transcript_id is null and qual_session_id = qsid from public.ai_interview_sessions where id = sid), 'deleting the transcript unlinks the interview, which stays';
  insert into public.media_objects (customer_id, survey_id, kind, bucket, path) values ('c0000000-0000-0000-0000-000000000069', 'c0000000-0000-0000-0000-000000000169', 'answer_audio', 'rescript-uploads', 'c0000000/a69/clip') returning id into mid;
  update public.ai_interview_turns set audio_media_id = mid where session_id = sid and seq = 2;
  delete from public.media_objects where id = mid;
  assert (select audio_media_id is null from public.ai_interview_turns where session_id = sid and seq = 2), 'a deleted recording unlinks its turn';
  raise notice 'PASS 6 links: transcript and media unlink, the interview stays';
end $$;

-- ============================================== 7. the RLS backstop
grant select (id, survey_id, title, status, guide, guide_language, spent_usd, launched_by, launched_at, closed_at, created_at, updated_at) on public.ai_interview_studies to authenticated;
grant select (id, study_id, survey_id, participant_id, mode, language, status, excluded, exclusion_reason, is_test, state, flags, turns_count, cost_usd, version, started_at, last_activity_at, completed_at, ended_by, qual_session_id, qual_transcript_id) on public.ai_interview_sessions to authenticated;
grant select on public.ai_interview_turns, public.ai_interview_participants, public.ai_interview_quotas to authenticated;

create or replace function pg_temp.seen(uid text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.ai_interview_studies) + (select count(*) from public.ai_interview_sessions where survey_id = 'c0000000-0000-0000-0000-000000000169')
       + (select count(*) from public.ai_interview_turns where survey_id = 'c0000000-0000-0000-0000-000000000169') + (select count(*) from public.ai_interview_participants where survey_id = 'c0000000-0000-0000-0000-000000000169')
       + (select count(*) from public.ai_interview_quotas)
    into n;
  execute 'reset role';
  return n;
end $$;

do $$
declare owner int; viewer int; ok boolean;
begin
  owner := pg_temp.seen('c0000069-0000-0000-0000-000000000001');
  viewer := pg_temp.seen('c0000069-0000-0000-0000-000000000002');
  assert owner > 10 and viewer = owner, format('owner %s, viewer %s see the rows', owner, viewer);
  assert pg_temp.seen('c0000069-0000-0000-0000-000000000003') = 0, 'vendor sees nothing';
  assert pg_temp.seen('c0000069-0000-0000-0000-000000000004') = 0, 'custom member sees nothing (the routes decide)';
  assert pg_temp.seen('c0000069-0000-0000-0000-000000000005') = 0, 'stranger sees nothing';
  assert pg_temp.seen('c0000069-0000-0000-0000-000000000006') = 0, 'interviewer sees nothing';
  perform set_config('request.jwt.claim.sub', 'c0000069-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', json_build_object('sub', 'c0000069-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin perform link_token from public.ai_interview_studies; exception when insufficient_privilege then ok := true; end;
  assert ok, 'the link token is never readable by a member';
  ok := false;
  begin perform token_hash from public.ai_interview_sessions; exception when insufficient_privilege then ok := true; end;
  assert ok, 'nor the resume-token hash';
  ok := false;
  begin insert into public.ai_interview_quotas (study_id, segment, target) values ('a6900000-0000-0000-0000-000000000001', 'x', 1); exception when insufficient_privilege then ok := true; end;
  assert ok, 'members cannot write';
  reset role;
  raise notice 'PASS 7 RLS: owner and viewer read; vendor, custom, stranger, interviewer do not; tokens unreadable; no writes';
end $$;

-- ============================================== 8. the survey takes everything with it
do $$
begin
  delete from public.surveys where id = 'c0000000-0000-0000-0000-000000000169';
  assert (select count(*) from public.ai_interview_studies where survey_id = 'c0000000-0000-0000-0000-000000000169') = 0, 'studies';
  assert (select count(*) from public.ai_interview_sessions where survey_id = 'c0000000-0000-0000-0000-000000000169') = 0, 'sessions';
  assert (select count(*) from public.ai_interview_turns where survey_id = 'c0000000-0000-0000-0000-000000000169') = 0, 'turns';
  assert (select count(*) from public.ai_interview_quotas where study_id = 'a6900000-0000-0000-0000-000000000001') = 0, 'quotas';
  raise notice 'PASS 8 deleting the survey removes every AI-interview row';
end $$;

rollback;
