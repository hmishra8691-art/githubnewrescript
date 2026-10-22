-- QUALITATIVE SYNTHESIS AND GROUP SESSIONS SQL TEST (migration 0070) — against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/qual-synthesis-sql-test.sql
--
-- Proves, on real Postgres:
--   1. the ten tables exist with RLS on; the eight readable ones have exactly one SELECT policy; the blind codings and
--      the participants (token hashes) have none; nothing may be written by a member
--   2. shapes: synthesis kinds and versions, job statuses, two different coders, handles, answer length, vote values,
--      token hash length, the transcript revision column (default 0, never negative)
--   3. idempotency: one job per key, one synthesis per version, one answer per participant per prompt, one vote per
--      participant per answer, one revision number per transcript
--   4. links: deleting a transcript removes its revisions and unlinks a group session; deleting a group session removes
--      its participants, answers and votes; deleting the survey removes everything
--   5. the RLS backstop: owner and viewer read the readable tables; vendor, interviewer, custom and stranger read nothing;
--      NOBODY reads the blind codings or the participants' token hashes directly
--
-- One transaction, rolled back. The test grants SELECT to `authenticated` inside the transaction (a bare Postgres shim
-- does not, Supabase does) to exercise the policies themselves.

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000070', 'qual70', 'Qualitative 0070') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000070-0000-0000-0000-000000000001', 'owner@q70.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000070-0000-0000-0000-000000000002', 'viewer@q70.test', '{"full_name":"Viewer"}'::jsonb),
  ('c0000070-0000-0000-0000-000000000003', 'vendor@q70.test', '{"full_name":"Vendor"}'::jsonb),
  ('c0000070-0000-0000-0000-000000000004', 'custom@q70.test', '{"full_name":"Custom"}'::jsonb),
  ('c0000070-0000-0000-0000-000000000005', 'stranger@q70.test', '{"full_name":"Stranger"}'::jsonb),
  ('c0000070-0000-0000-0000-000000000006', 'interviewer@q70.test', '{"full_name":"Interviewer"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, case when u.email like 'stranger%' then null else 'c0000000-0000-0000-0000-000000000070'::uuid end, u.email, u.email, 'programmer'
  from auth.users u where u.email like '%@q70.test'
on conflict (id) do update set customer_id = excluded.customer_id;
update public.profiles set customer_id = null where id in ('c0000070-0000-0000-0000-000000000003', 'c0000070-0000-0000-0000-000000000004', 'c0000070-0000-0000-0000-000000000006');
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000170', 'c0000000-0000-0000-0000-000000000070', 'Q70', 'Synthesis project', 'c0000070-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000170', 'c0000070-0000-0000-0000-000000000002', 'viewer', 'c0000070-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000170', 'c0000070-0000-0000-0000-000000000003', 'vendor', 'c0000070-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000170', 'c0000070-0000-0000-0000-000000000004', 'custom', 'c0000070-0000-0000-0000-000000000001', '{"v":1,"modules":{"data":"manage"}}'::jsonb),
  ('c0000000-0000-0000-0000-000000000170', 'c0000070-0000-0000-0000-000000000006', 'interviewer', 'c0000070-0000-0000-0000-000000000001', null)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;

-- ============================================== 1. tables, RLS, policies
do $$
declare t text; n int;
begin
  foreach t in array array['qual_syntheses', 'qual_jobs', 'qual_coding_assignments', 'qual_highlights', 'qual_transcript_revisions', 'qual_group_sessions', 'qual_group_answers', 'qual_group_votes'] loop
    assert to_regclass('public.' || t) is not null, t || ' exists';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 1, t || ' has exactly one policy, got ' || n;
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass and polcmd <> 'r';
    assert n = 0, t || ': no write policy';
  end loop;
  foreach t in array array['qual_assignment_codings', 'qual_group_participants'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 0, t || ' has no member policy (service role only), got ' || n;
  end loop;
  assert exists (select 1 from information_schema.columns where table_name = 'qual_transcripts' and column_name = 'revision' and column_default = '0'), 'qual_transcripts.revision defaults to 0';
  raise notice 'PASS 1 tables, RLS, read-only policies; blind codings and token hashes unreadable';
end $$;

-- ============================================== 2–3. shapes and idempotency
do $$
declare ok boolean; tid uuid; gid uuid; p1 uuid; p2 uuid; a1 uuid; aid uuid; sid uuid := 'c0000000-0000-0000-0000-000000000170';
begin
  insert into public.qual_transcripts (survey_id, title, source, format) values (sid, 'IDI 1', 'import', 'speaker') returning id into tid;
  assert (select revision from public.qual_transcripts where id = tid) = 0, 'a new transcript is revision 0';
  ok := false; begin update public.qual_transcripts set revision = -1 where id = tid; exception when check_violation then ok := true; end; assert ok, 'a negative revision is refused';

  insert into public.qual_syntheses (survey_id, kind, target, version, content, fingerprint) values (sid, 'theme', 'th1', 1, '{"summary":[]}', 'abcd1234');
  insert into public.qual_syntheses (survey_id, kind, target, version, status, content, fingerprint) values (sid, 'theme', 'th1', 2, 'edited', '{"summary":[]}', 'abcd1234');
  ok := false; begin insert into public.qual_syntheses (survey_id, kind, target, version, content, fingerprint) values (sid, 'theme', 'th1', 2, '{}', 'x'); exception when unique_violation then ok := true; end; assert ok, 'one synthesis per version';
  ok := false; begin insert into public.qual_syntheses (survey_id, kind, target, version, content, fingerprint) values (sid, 'poem', 'x', 1, '{}', 'x'); exception when check_violation then ok := true; end; assert ok, 'unknown synthesis kind refused';
  ok := false; begin insert into public.qual_syntheses (survey_id, kind, target, version, content, fingerprint) values (sid, 'theme', 'x', 1, '[]', 'x'); exception when check_violation then ok := true; end; assert ok, 'content is an object';

  insert into public.qual_jobs (survey_id, kind, key, source_ids) values (sid, 'autocode', 'autocode:' || tid || ':r0', jsonb_build_array(tid));
  ok := false; begin insert into public.qual_jobs (survey_id, kind, key) values (sid, 'autocode', 'autocode:' || tid || ':r0'); exception when unique_violation then ok := true; end; assert ok, 'one job per key (the same source is never coded twice)';
  insert into public.qual_jobs (survey_id, kind, key) values (sid, 'autocode', 'autocode:' || tid || ':r1');
  ok := false; begin insert into public.qual_jobs (survey_id, kind, key, status) values (sid, 'autocode', 'k2', 'sleeping'); exception when check_violation then ok := true; end; assert ok, 'unknown job status refused';

  ok := false; begin insert into public.qual_coding_assignments (survey_id, name, coder_a, coder_b, units, overlap_pct, seed, code_ids) values (sid, 'x', 'u1', 'u1', '[]', 20, 1, '[]'); exception when check_violation then ok := true; end; assert ok, 'two different coders';
  ok := false; begin insert into public.qual_coding_assignments (survey_id, name, coder_a, coder_b, units, overlap_pct, seed, code_ids) values (sid, 'x', 'u1', 'ai', '[]', 0, 1, '[]'); exception when check_violation then ok := true; end; assert ok, 'overlap between 1 and 100';
  insert into public.qual_coding_assignments (survey_id, name, coder_a, coder_b, units, overlap_pct, seed, code_ids) values (sid, 'Pilot', 'u1', 'ai', '["a|t1"]', 20, 7, '["c1"]') returning id into aid;
  insert into public.qual_assignment_codings (assignment_id, survey_id, coder) values (aid, sid, 'u1'), (aid, sid, 'ai');
  ok := false; begin insert into public.qual_assignment_codings (assignment_id, survey_id, coder) values (aid, sid, 'u1'); exception when unique_violation then ok := true; end; assert ok, 'one private set per coder';

  insert into public.qual_highlights (survey_id, name, items) values (sid, 'Pricing complaints', '[{"excerptId":"x1"}]');
  ok := false; begin insert into public.qual_highlights (survey_id, name) values (sid, ''); exception when check_violation then ok := true; end; assert ok, 'a reel needs a name';

  insert into public.qual_transcript_revisions (survey_id, transcript_id, revision, segment_id, before_text, after_text) values (sid, tid, 1, 't2', 'the prize', 'the price');
  ok := false; begin insert into public.qual_transcript_revisions (survey_id, transcript_id, revision, segment_id, before_text, after_text) values (sid, tid, 1, 't3', 'a', 'b'); exception when unique_violation then ok := true; end; assert ok, 'one revision number per transcript';

  insert into public.qual_group_sessions (survey_id, title, join_code, state, transcript_id) values (sid, 'Group 1', 'abcdefghijklmnopqrstuvwx', '{"prompts":[]}', tid) returning id into gid;
  ok := false; begin insert into public.qual_group_sessions (survey_id, title, join_code, state) values (sid, 'Group 2', 'short', '{}'); exception when check_violation then ok := true; end; assert ok, 'a join code is long';
  ok := false; begin insert into public.qual_group_sessions (survey_id, title, join_code, state) values (sid, 'Group 3', 'abcdefghijklmnopqrstuvwx', '{}'); exception when unique_violation then ok := true; end; assert ok, 'join codes are unique';
  insert into public.qual_group_participants (group_session_id, survey_id, handle, token_hash, consent_at) values (gid, sid, 'P1', repeat('a', 64), now()) returning id into p1;
  insert into public.qual_group_participants (group_session_id, survey_id, handle, token_hash, consent_at, segment) values (gid, sid, 'P2', repeat('b', 64), now(), 'Mumbai') returning id into p2;
  ok := false; begin insert into public.qual_group_participants (group_session_id, survey_id, handle, token_hash, consent_at) values (gid, sid, 'Anna', repeat('c', 64), now()); exception when check_violation then ok := true; end; assert ok, 'a handle is P<n>, never a name';
  ok := false; begin insert into public.qual_group_participants (group_session_id, survey_id, handle, token_hash, consent_at) values (gid, sid, 'P3', 'plain-token', now()); exception when check_violation then ok := true; end; assert ok, 'only a 64-character hash is stored';
  ok := false; begin insert into public.qual_group_participants (group_session_id, survey_id, handle, token_hash, consent_at) values (gid, sid, 'P1', repeat('d', 64), now()); exception when unique_violation then ok := true; end; assert ok, 'handles are unique in a session';
  insert into public.qual_group_answers (group_session_id, survey_id, prompt_id, participant_id, text) values (gid, sid, 'g1', p1, 'The price is too high.') returning id into a1;
  ok := false; begin insert into public.qual_group_answers (group_session_id, survey_id, prompt_id, participant_id, text) values (gid, sid, 'g1', p1, 'again'); exception when unique_violation then ok := true; end; assert ok, 'one answer per participant per prompt';
  ok := false; begin insert into public.qual_group_answers (group_session_id, survey_id, prompt_id, participant_id, text) values (gid, sid, 'g2', p1, repeat('x', 1501)); exception when check_violation then ok := true; end; assert ok, 'answers are at most 1,500 characters';
  insert into public.qual_group_votes (answer_id, voter_id, group_session_id, survey_id, vote) values (a1, p2, gid, sid, 1);
  ok := false; begin insert into public.qual_group_votes (answer_id, voter_id, group_session_id, survey_id, vote) values (a1, p2, gid, sid, -1); exception when unique_violation then ok := true; end; assert ok, 'one vote per participant per answer';
  ok := false; begin insert into public.qual_group_votes (answer_id, voter_id, group_session_id, survey_id, vote) values (a1, p1, gid, sid, 2); exception when check_violation then ok := true; end; assert ok, 'a vote is -1, 0 or 1';
  raise notice 'PASS 2-3 shapes and idempotency';
end $$;

-- ============================================== 5. the RLS backstop (before the deletes below)
grant select on public.qual_syntheses, public.qual_jobs, public.qual_coding_assignments, public.qual_assignment_codings, public.qual_highlights,
  public.qual_transcript_revisions, public.qual_group_sessions, public.qual_group_participants, public.qual_group_answers, public.qual_group_votes to authenticated;
create temp table q70_seen (who text, readable int, secret int) on commit drop;
grant insert, select on q70_seen to authenticated;
do $$
declare u text; who text; sid uuid := 'c0000000-0000-0000-0000-000000000170';
begin
  foreach u in array array['1:owner', '2:viewer', '3:vendor', '4:custom', '5:stranger', '6:interviewer'] loop
    who := split_part(u, ':', 2);
    perform set_config('request.jwt.claim.sub', 'c0000070-0000-0000-0000-00000000000' || split_part(u, ':', 1), true);
    execute 'set local role authenticated';
    insert into q70_seen values (who,
      (select count(*) from public.qual_syntheses where survey_id = sid) + (select count(*) from public.qual_jobs where survey_id = sid)
      + (select count(*) from public.qual_coding_assignments where survey_id = sid) + (select count(*) from public.qual_highlights where survey_id = sid)
      + (select count(*) from public.qual_transcript_revisions where survey_id = sid) + (select count(*) from public.qual_group_sessions where survey_id = sid)
      + (select count(*) from public.qual_group_answers where survey_id = sid) + (select count(*) from public.qual_group_votes where survey_id = sid),
      (select count(*) from public.qual_assignment_codings where survey_id = sid) + (select count(*) from public.qual_group_participants where survey_id = sid));
    execute 'reset role';
  end loop;
end $$;
do $$
declare r record;
begin
  for r in select * from q70_seen loop raise notice '  % reads % rows, % secret rows', r.who, r.readable, r.secret; end loop;
  assert (select readable from q70_seen where who = 'owner') >= 10, 'the owner reads the readable rows';
  assert (select readable from q70_seen where who = 'viewer') = (select readable from q70_seen where who = 'owner'), 'a viewer (Data view) reads the same';
  assert (select sum(secret) from q70_seen) = 0, 'NOBODY reads blind codings or participants directly — not even the owner';
  assert (select readable from q70_seen where who in ('vendor')) = 0, 'a vendor reads nothing';
  assert (select readable from q70_seen where who in ('interviewer')) = 0, 'an interviewer reads nothing';
  assert (select readable from q70_seen where who in ('custom')) = 0, 'a custom member reads nothing directly';
  assert (select readable from q70_seen where who in ('stranger')) = 0, 'a stranger reads nothing';
  raise notice 'PASS 5 the backstop';
end $$;

-- ============================================== 4. links and cascades
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000170'; tid uuid; gid uuid;
begin
  select id into tid from public.qual_transcripts where survey_id = sid limit 1;
  select id into gid from public.qual_group_sessions where survey_id = sid limit 1;
  delete from public.qual_transcripts where id = tid;
  assert not exists (select 1 from public.qual_transcript_revisions where transcript_id = tid), 'a deleted transcript takes its revisions';
  assert (select transcript_id from public.qual_group_sessions where id = gid) is null, 'a deleted transcript unlinks its group session';
  delete from public.qual_group_sessions where id = gid;
  assert not exists (select 1 from public.qual_group_participants where group_session_id = gid), 'participants go with the session';
  assert not exists (select 1 from public.qual_group_answers where group_session_id = gid), 'answers go with the session';
  assert not exists (select 1 from public.qual_group_votes where group_session_id = gid), 'votes go with the session';
  delete from public.surveys where id = sid;
  assert not exists (select 1 from public.qual_syntheses where survey_id = sid) and not exists (select 1 from public.qual_jobs where survey_id = sid)
     and not exists (select 1 from public.qual_coding_assignments where survey_id = sid) and not exists (select 1 from public.qual_assignment_codings where survey_id = sid)
     and not exists (select 1 from public.qual_highlights where survey_id = sid), 'the survey takes everything';
  raise notice 'PASS 4 links and cascades';
end $$;

rollback;
\echo 'qual-synthesis-sql-test: all groups passed (rolled back)'
