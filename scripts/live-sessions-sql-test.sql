-- LIVE SESSIONS SQL TEST (migration 0071) — against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/live-sessions-sql-test.sql
--
-- Proves, on real Postgres:
--   1. the six tables exist with RLS on; rooms, members, notes and tracks have exactly one SELECT policy; invites and
--      signals have none; no write policy anywhere; the five functions cannot be called by anon or authenticated
--   2. shapes: handles (P<n> / Moderator / Observer n, never a name), 64-character token hashes (unique), statuses,
--      a signal is never to oneself, one chunk per (room, member, kind, seq), e-mail shape, notes' length
--   3. the functions: compare-and-set of the room state (a stale version writes nothing) bumps the rev; touch bumps
--      the rev; poll returns only this member's unexpired signals after the cursor, in order; sweep deletes the
--      expired ones; one transcriber holds a chunk's lease at a time
--   4. the RLS backstop: owner and viewer read rooms, members, notes and tracks; vendor, interviewer, custom and a
--      stranger read nothing; NOBODY reads invites or signals; the members' token hash column cannot be selected
--   5. links and cascades: a deleted member takes its signals and chunks; a deleted room takes everything; a deleted
--      media object unlinks its chunk; deleting the survey removes the rooms
--
-- One transaction, rolled back. The test grants SELECT to `authenticated` on the tables a plain Postgres shim leaves
-- ungranted (Supabase grants them), to exercise the policies themselves — never on the members' token hash.

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000071', 'live71', 'Live 0071') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000071-0000-0000-0000-000000000001', 'owner@l71.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000071-0000-0000-0000-000000000002', 'viewer@l71.test', '{"full_name":"Viewer"}'::jsonb),
  ('c0000071-0000-0000-0000-000000000003', 'vendor@l71.test', '{"full_name":"Vendor"}'::jsonb),
  ('c0000071-0000-0000-0000-000000000004', 'custom@l71.test', '{"full_name":"Custom"}'::jsonb),
  ('c0000071-0000-0000-0000-000000000005', 'stranger@l71.test', '{"full_name":"Stranger"}'::jsonb),
  ('c0000071-0000-0000-0000-000000000006', 'interviewer@l71.test', '{"full_name":"Interviewer"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, case when u.email like 'stranger%' then null else 'c0000000-0000-0000-0000-000000000071'::uuid end, u.email, u.email, 'programmer'
  from auth.users u where u.email like '%@l71.test'
on conflict (id) do update set customer_id = excluded.customer_id;
update public.profiles set customer_id = null where id in ('c0000071-0000-0000-0000-000000000003', 'c0000071-0000-0000-0000-000000000004', 'c0000071-0000-0000-0000-000000000006');
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000171', 'c0000000-0000-0000-0000-000000000071', 'L71', 'Live project', 'c0000071-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000171', 'c0000071-0000-0000-0000-000000000002', 'viewer', 'c0000071-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000171', 'c0000071-0000-0000-0000-000000000003', 'vendor', 'c0000071-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000171', 'c0000071-0000-0000-0000-000000000004', 'custom', 'c0000071-0000-0000-0000-000000000001', '{"v":1,"modules":{"data":"manage"}}'::jsonb),
  ('c0000000-0000-0000-0000-000000000171', 'c0000071-0000-0000-0000-000000000006', 'interviewer', 'c0000071-0000-0000-0000-000000000001', null)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;

-- ============================================== 1. tables, RLS, policies, function privileges
do $$
declare t text; n int; f text;
begin
  foreach t in array array['live_rooms', 'live_room_members', 'live_room_notes', 'live_room_tracks'] loop
    assert to_regclass('public.' || t) is not null, t || ' exists';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 1, t || ' has exactly one policy, got ' || n;
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass and polcmd <> 'r';
    assert n = 0, t || ': no write policy';
  end loop;
  foreach t in array array['live_room_invites', 'live_room_signals'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 0, t || ' has no member policy (service role only), got ' || n;
  end loop;
  foreach f in array array['public.rescript_live_touch(uuid)', 'public.rescript_live_save(uuid, jsonb, integer)', 'public.rescript_live_poll(uuid, uuid, bigint)', 'public.rescript_live_sweep(timestamptz)', 'public.rescript_live_claim_track(uuid, timestamptz, timestamptz)'] loop
    assert not has_function_privilege('anon', f, 'execute'), f || ': anon cannot call it';
    assert not has_function_privilege('authenticated', f, 'execute'), f || ': authenticated cannot call it';
  end loop;
  assert not has_column_privilege('authenticated', 'public.live_room_members', 'token_hash', 'select'), 'members cannot select token hashes';
  assert has_column_privilege('authenticated', 'public.live_room_members', 'handle', 'select'), 'members can select handles';
  raise notice 'PASS 1 tables, RLS, read-only policies; invites, signals and token hashes unreadable; functions service-role only';
end $$;

-- ============================================== 2–3. shapes, idempotency and the functions
do $$
declare ok boolean; sid uuid := 'c0000000-0000-0000-0000-000000000171'; rid uuid; rid2 uuid; inv uuid; m uuid; p1 uuid; p2 uuid; o1 uuid; tr uuid; mid uuid; r0 bigint; r1 bigint; j jsonb;
begin
  insert into public.live_rooms (survey_id, customer_id, title, kind, scheduled_at, time_zone, state) values (sid, 'c0000000-0000-0000-0000-000000000071', 'FG 1 — Mumbai', 'focus_group', now() + interval '5 days', 'Asia/Kolkata', '{"status":"scheduled"}') returning id into rid;
  ok := false; begin insert into public.live_rooms (survey_id, title, state) values (sid, 'x', '[]'); exception when check_violation then ok := true; end; assert ok, 'the state is an object';
  ok := false; begin insert into public.live_rooms (survey_id, title, state, status) values (sid, 'x', '{}', 'paused'); exception when check_violation then ok := true; end; assert ok, 'unknown room status refused';
  ok := false; begin insert into public.live_rooms (survey_id, title, state, kind) values (sid, 'x', '{}', 'webinar'); exception when check_violation then ok := true; end; assert ok, 'unknown kind refused';

  insert into public.live_room_invites (room_id, survey_id, role, label, email, segment, token_hash) values (rid, sid, 'participant', 'Anna', 'anna@example.org', 'Mumbai', repeat('1', 64)) returning id into inv;
  ok := false; begin insert into public.live_room_invites (room_id, survey_id, token_hash) values (rid, sid, 'plain-link-token'); exception when check_violation then ok := true; end; assert ok, 'only a 64-character hash of a link is stored';
  ok := false; begin insert into public.live_room_invites (room_id, survey_id, token_hash) values (rid, sid, repeat('1', 64)); exception when unique_violation then ok := true; end; assert ok, 'link hashes are unique';
  ok := false; begin insert into public.live_room_invites (room_id, survey_id, token_hash, email) values (rid, sid, repeat('2', 64), 'not an address'); exception when check_violation then ok := true; end; assert ok, 'an e-mail has an @';
  ok := false; begin insert into public.live_room_invites (room_id, survey_id, token_hash, role) values (rid, sid, repeat('3', 64), 'moderator'); exception when check_violation then ok := true; end; assert ok, 'an invite is for a participant or an observer';

  insert into public.live_room_members (room_id, survey_id, role, handle, label, state, user_id, token_hash, recording_consent) values (rid, sid, 'moderator', 'Moderator', 'Asha', 'admitted', 'c0000071-0000-0000-0000-000000000001', repeat('a', 64), true) returning id into m;
  insert into public.live_room_members (room_id, survey_id, role, handle, segment, state, invite_id, token_hash, recording_consent, consent_at) values (rid, sid, 'participant', 'P1', 'Mumbai', 'admitted', inv, repeat('b', 64), true, now()) returning id into p1;
  insert into public.live_room_members (room_id, survey_id, role, handle, state, token_hash) values (rid, sid, 'participant', 'P2', 'waiting', repeat('c', 64)) returning id into p2;
  insert into public.live_room_members (room_id, survey_id, role, handle, label, state, token_hash) values (rid, sid, 'observer', 'Observer 1', 'Client', 'admitted', repeat('d', 64)) returning id into o1;
  update public.live_room_invites set member_id = p1, status = 'joined' where id = inv;
  ok := false; begin insert into public.live_room_members (room_id, survey_id, role, handle, token_hash) values (rid, sid, 'participant', 'Anna Smith', repeat('e', 64)); exception when check_violation then ok := true; end; assert ok, 'a handle is P<n>, Moderator or Observer n — never a name';
  ok := false; begin insert into public.live_room_members (room_id, survey_id, role, handle, token_hash) values (rid, sid, 'participant', 'P1', repeat('f', 64)); exception when unique_violation then ok := true; end; assert ok, 'handles are unique in a room';
  ok := false; begin insert into public.live_room_members (room_id, survey_id, role, handle, token_hash) values (rid, sid, 'participant', 'P3', repeat('a', 64)); exception when unique_violation then ok := true; end; assert ok, 'member token hashes are unique';
  ok := false; begin insert into public.live_room_members (room_id, survey_id, role, handle, token_hash, state) values (rid, sid, 'participant', 'P4', repeat('9', 64), 'kicked'); exception when check_violation then ok := true; end; assert ok, 'unknown member state refused';

  -- the room's state, compare-and-set; touch
  select rev into r0 from public.live_rooms where id = rid;
  assert public.rescript_live_save(rid, '{"status":"open"}', 0), 'the expected version writes';
  assert not public.rescript_live_save(rid, '{"status":"live"}', 0), 'a stale version writes nothing';
  assert (select status from public.live_rooms where id = rid) = 'open', 'the status column follows the state';
  assert (select version from public.live_rooms where id = rid) = 1, 'version 1';
  r1 := public.rescript_live_touch(rid);
  assert r1 = r0 + 2, 'save and touch each bump the rev (' || r0 || ' → ' || r1 || ')';

  -- signals: to one member, after a cursor, unexpired; never to oneself
  insert into public.live_room_signals (room_id, from_member, to_member, type, payload, expires_at) values
    (rid, p1, m, 'offer', '{"sdp":"o1"}', now() + interval '2 minutes'),
    (rid, p1, m, 'candidate', '{"c":1}', now() + interval '2 minutes'),
    (rid, m, p1, 'answer', '{"sdp":"a1"}', now() + interval '2 minutes'),
    (rid, p1, m, 'candidate', '{"c":"old"}', now() - interval '1 second');
  ok := false; begin insert into public.live_room_signals (room_id, from_member, to_member, type, expires_at) values (rid, m, m, 'offer', now()); exception when check_violation then ok := true; end; assert ok, 'never to oneself';
  ok := false; begin insert into public.live_room_signals (room_id, from_member, to_member, type, expires_at) values (rid, m, p1, 'exec', now()); exception when check_violation then ok := true; end; assert ok, 'unknown signal type refused';
  j := public.rescript_live_poll(rid, m, 0);
  assert jsonb_array_length(j->'signals') = 2, 'the moderator gets its two unexpired signals, got ' || (j->'signals');
  assert (j->'signals'->0->>'type') = 'offer' and (j->'signals'->1->>'type') = 'candidate', 'in order';
  assert (j->>'rev')::bigint = r1, 'with the room rev';
  assert jsonb_array_length(public.rescript_live_poll(rid, m, ((j->'signals'->0->>'id')::bigint))->'signals') = 1, 'after the cursor';
  assert jsonb_array_length(public.rescript_live_poll(rid, o1, 0)->'signals') = 0, 'nothing for the observer';
  assert public.rescript_live_sweep(now()) = 1, 'the expired signal is swept';

  -- chunks
  insert into public.media_objects (customer_id, survey_id, kind, bucket, path, status, storage_provider, session_id) values ('c0000000-0000-0000-0000-000000000071', sid, 'qual_recording', 'rescript-qual', sid || '/qual/x/1-p1-0.webm', 'stored', 'supabase', 'x') returning id into mid;
  insert into public.live_room_tracks (room_id, survey_id, member_id, kind, seq, start_ms, duration_ms, media_id, status) values (rid, sid, p1, 'audio', 0, 1793000000000, 30000, mid, 'stored') returning id into tr;
  ok := false; begin insert into public.live_room_tracks (room_id, survey_id, member_id, kind, seq, start_ms) values (rid, sid, p1, 'audio', 0, 1793000000000); exception when unique_violation then ok := true; end; assert ok, 'one chunk per (room, member, kind, seq)';
  insert into public.live_room_tracks (room_id, survey_id, member_id, kind, seq, start_ms) values (rid, sid, p1, 'video', 0, 1793000000000);
  ok := false; begin insert into public.live_room_tracks (room_id, survey_id, member_id, kind, seq, start_ms) values (rid, sid, p1, 'screen', 1, 1793000000000); exception when check_violation then ok := true; end; assert ok, 'audio or video';
  ok := false; begin insert into public.live_room_tracks (room_id, survey_id, member_id, kind, seq, start_ms, status) values (rid, sid, p1, 'audio', 1, 1793000000000, 'lost'); exception when check_violation then ok := true; end; assert ok, 'unknown chunk status refused';
  assert public.rescript_live_claim_track(tr, now(), now() + interval '2 minutes'), 'the first transcriber holds the chunk';
  assert not public.rescript_live_claim_track(tr, now(), now() + interval '2 minutes'), 'a second one does not';
  assert public.rescript_live_claim_track(tr, now() + interval '3 minutes', now() + interval '5 minutes'), 'after the lease lapses it can be taken again';

  insert into public.live_room_notes (room_id, survey_id, member_id, kind, author, text, offset_seconds) values (rid, sid, o1, 'note', 'Client', 'P1 hesitates on price', 90), (rid, sid, m, 'chat', 'Moderator', 'Noted', null);
  ok := false; begin insert into public.live_room_notes (room_id, survey_id, kind, author, text) values (rid, sid, 'note', 'x', ''); exception when check_violation then ok := true; end; assert ok, 'a note says something';
  ok := false; begin insert into public.live_room_notes (room_id, survey_id, kind, author, text) values (rid, sid, 'whisper', 'x', 'y'); exception when check_violation then ok := true; end; assert ok, 'chat or note';
  ok := false; begin insert into public.live_room_notes (room_id, survey_id, kind, author, text, offset_seconds) values (rid, sid, 'note', 'x', 'y', -5); exception when check_violation then ok := true; end; assert ok, 'an offset is never negative';
  raise notice 'PASS 2-3 shapes, idempotency, compare-and-set, poll, sweep, lease';
end $$;

-- ============================================== 4. the RLS backstop (before the deletes below)
grant select on public.live_rooms, public.live_room_notes, public.live_room_tracks, public.live_room_invites, public.live_room_signals to authenticated;
create temp table l71_seen (who text, readable int, secret int, hash_denied boolean) on commit drop;
grant insert, select on l71_seen to authenticated;
do $$
declare u text; who text; sid uuid := 'c0000000-0000-0000-0000-000000000171'; denied boolean;
begin
  foreach u in array array['1:owner', '2:viewer', '3:vendor', '4:custom', '5:stranger', '6:interviewer'] loop
    who := split_part(u, ':', 2);
    perform set_config('request.jwt.claim.sub', 'c0000071-0000-0000-0000-00000000000' || split_part(u, ':', 1), true);
    execute 'set local role authenticated';
    denied := false;
    begin perform token_hash from public.live_room_members limit 1; exception when insufficient_privilege then denied := true; end;
    insert into l71_seen values (who,
      (select count(*) from public.live_rooms where survey_id = sid) + (select count(*) from public.live_room_members where survey_id = sid)
      + (select count(*) from public.live_room_notes where survey_id = sid) + (select count(*) from public.live_room_tracks where survey_id = sid),
      (select count(*) from public.live_room_invites where survey_id = sid) + (select count(*) from public.live_room_signals),
      denied);
    execute 'reset role';
  end loop;
end $$;
do $$
declare r record;
begin
  for r in select * from l71_seen loop raise notice '  % reads % rows, % secret rows, token hash denied: %', r.who, r.readable, r.secret, r.hash_denied; end loop;
  assert (select readable from l71_seen where who = 'owner') >= 8, 'the owner reads rooms, members, notes, chunks';
  assert (select readable from l71_seen where who = 'viewer') = (select readable from l71_seen where who = 'owner'), 'a viewer (Data view) reads the same';
  assert (select sum(secret) from l71_seen) = 0, 'NOBODY reads invites (e-mails, link hashes) or signals directly — not even the owner';
  assert (select bool_and(hash_denied) from l71_seen), 'nobody can select a member token hash';
  assert (select readable from l71_seen where who = 'vendor') = 0, 'a vendor reads nothing';
  assert (select readable from l71_seen where who = 'interviewer') = 0, 'an interviewer reads nothing';
  assert (select readable from l71_seen where who = 'custom') = 0, 'a custom member reads nothing directly';
  assert (select readable from l71_seen where who = 'stranger') = 0, 'a stranger reads nothing';
  raise notice 'PASS 4 the backstop';
end $$;

-- ============================================== 5. links and cascades
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000171'; rid uuid; p1 uuid; mid uuid; inv uuid;
begin
  select id into rid from public.live_rooms where survey_id = sid limit 1;
  select id, invite_id into p1, inv from public.live_room_members where room_id = rid and handle = 'P1';
  select media_id into mid from public.live_room_tracks where member_id = p1 and kind = 'audio';
  delete from public.media_objects where id = mid;
  assert (select media_id from public.live_room_tracks where member_id = p1 and kind = 'audio') is null, 'a deleted media object unlinks its chunk';
  insert into public.live_room_signals (room_id, from_member, to_member, type, expires_at) select rid, p1, id, 'bye', now() + interval '1 minute' from public.live_room_members where room_id = rid and role = 'moderator';
  delete from public.live_room_members where id = p1;
  assert not exists (select 1 from public.live_room_signals where from_member = p1 or to_member = p1), 'a deleted member takes its signals';
  assert not exists (select 1 from public.live_room_tracks where member_id = p1), 'and its chunks';
  assert (select member_id from public.live_room_invites where id = inv) is null, 'and unlinks its invitation';
  delete from public.live_rooms where id = rid;
  assert not exists (select 1 from public.live_room_members where room_id = rid) and not exists (select 1 from public.live_room_invites where room_id = rid)
     and not exists (select 1 from public.live_room_notes where room_id = rid), 'a deleted room takes everything';
  insert into public.live_rooms (survey_id, title, state) values (sid, 'Another', '{}');
  delete from public.surveys where id = sid;
  assert not exists (select 1 from public.live_rooms where survey_id = sid), 'the survey takes its rooms';
  raise notice 'PASS 5 links and cascades';
end $$;

rollback;
\echo 'live-sessions-sql-test: all groups passed (rolled back)'
