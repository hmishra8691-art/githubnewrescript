-- ALERTS AND PANELS SQL TEST (migration 0072) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/alerts-panels-sql-test.sql
--
-- Proves, on real Postgres:
--   1. six tables with RLS on; only SELECT policies; panel_secrets has none; the two functions are service-role only;
--      notifications (0008) has notify_event_id; mail_deliveries.kind gains alert / live-session kinds and keeps every old one
--   2. shapes: channel kinds, a non-e-mail channel needs a sealed secret, one channel name per kind per organisation,
--      event types, delivery statuses, outcomes, panel keys are checked; outbox and delivery idempotency keys are unique
--   3. rescript_notify_claim: leases pending events oldest first, never the same event to two claimers, a lapsed lease
--      is claimable again, one event by id
--   4. rescript_panel_enter: the first arrival is admitted, the same panel id again is a duplicate (with the first
--      entry's outcome), a test entry is separate, a non-deduping panel admits repeats, an empty id never dedupes
--   5. the RLS backstop: an organisation's members see its channels (never the sealed secret), clients / strangers do
--      not (a client's project rows follow the workspace baseline role, as 0069); the project's owner and viewer read deliveries and panel entries, a vendor / stranger read nothing;
--      nobody reads panel_secrets; members cannot write
--   6. deleting the survey removes its entries, secrets, events and deliveries
--
-- One transaction, rolled back. (Supabase grants table privileges to `authenticated` by default; a bare Postgres
-- shim does not, so the test grants the same lists inside the transaction.)

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000072', 'ap72', 'Alerts and panels 0072') on conflict do nothing;
insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000073', 'other72', 'Another organisation') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000072-0000-0000-0000-000000000001', 'owner@a72.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000072-0000-0000-0000-000000000002', 'viewer@a72.test', '{"full_name":"Viewer"}'::jsonb),
  ('c0000072-0000-0000-0000-000000000003', 'vendor@a72.test', '{"full_name":"Vendor"}'::jsonb),
  ('c0000072-0000-0000-0000-000000000004', 'client@a72.test', '{"full_name":"Client"}'::jsonb),
  ('c0000072-0000-0000-0000-000000000005', 'stranger@a72.test', '{"full_name":"Stranger"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, case when u.email like 'stranger%' then 'c0000000-0000-0000-0000-000000000073'::uuid else 'c0000000-0000-0000-0000-000000000072'::uuid end, u.email, u.email,
       case when u.email like 'client%' then 'client' else 'programmer' end
  from auth.users u where u.email like '%@a72.test'
on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
update public.profiles set customer_id = null where id = 'c0000072-0000-0000-0000-000000000003';
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000172', 'c0000000-0000-0000-0000-000000000072', 'A72', 'Alerts project', 'c0000072-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000172', 'c0000072-0000-0000-0000-000000000002', 'viewer', 'c0000072-0000-0000-0000-000000000001', null),
  ('c0000000-0000-0000-0000-000000000172', 'c0000072-0000-0000-0000-000000000003', 'vendor', 'c0000072-0000-0000-0000-000000000001', null)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;

-- ============================================== 1. tables, RLS, policies, functions
do $$
declare t text; n int;
begin
  foreach t in array array['notify_channels', 'notify_rules', 'notify_events', 'notify_deliveries', 'panel_secrets', 'panel_entries'] loop
    assert to_regclass('public.' || t) is not null, t || ' exists';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass and polcmd <> 'r';
    assert n = 0, t || ': no write policy (service role only)';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = case when t = 'panel_secrets' then 0 else 1 end, t || ' policies: ' || n;
  end loop;
  assert not has_function_privilege('authenticated', 'public.rescript_notify_claim(integer, integer, uuid)', 'execute'), 'claim is service-role only';
  assert not has_function_privilege('anon', 'public.rescript_panel_enter(uuid, text, text, text, text, boolean, boolean, jsonb)', 'execute'), 'panel_enter is service-role only';
  assert exists (select 1 from information_schema.columns where table_name = 'notifications' and column_name = 'notify_event_id'), 'notifications.notify_event_id';
  assert (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.mail_deliveries'::regclass and conname = 'mail_deliveries_kind_check') ~ 'alert.*live_session_invite.*media_delivery.*respondent_invitation', 'mail kinds widened by union (the old ones kept)';
  raise notice 'PASS 1 tables, RLS, read-only policies (none on panel_secrets), service-role functions';
end $$;

-- ============================================== 2. shapes
do $$
declare ok boolean; e uuid;
begin
  insert into public.notify_channels (customer_id, kind, name, secret_sealed, secret_key_id, hint) values ('c0000000-0000-0000-0000-000000000072', 'slack', '#research-ops', '{"v":1}', 'k1', 'hooks.slack.com/…/••••abcd');
  insert into public.notify_channels (customer_id, kind, name, config) values ('c0000000-0000-0000-0000-000000000072', 'email', 'Ops list', '{"to":["ops@a72.test"]}');
  ok := false; begin insert into public.notify_channels (customer_id, kind, name) values ('c0000000-0000-0000-0000-000000000072', 'webhook', 'no secret'); exception when check_violation then ok := true; end;
  assert ok, 'a webhook channel needs its sealed URL';
  ok := false; begin insert into public.notify_channels (customer_id, kind, name, secret_sealed) values ('c0000000-0000-0000-0000-000000000072', 'slack', '#RESEARCH-OPS', 'x'); exception when unique_violation then ok := true; end;
  assert ok, 'one channel per name and kind (case-insensitive)';
  ok := false; begin insert into public.notify_channels (customer_id, kind, name, secret_sealed) values ('c0000000-0000-0000-0000-000000000072', 'sms', 'x', 'x'); exception when check_violation then ok := true; end;
  assert ok, 'no unknown channel kind';
  insert into public.notify_events (idempotency_key, customer_id, survey_id, type, ref, payload, source) values ('ev-1', 'c0000000-0000-0000-0000-000000000072', 'c0000000-0000-0000-0000-000000000172', 'ai_interview.distress', 'int-1', '{"excerpt":"I feel [name]…"}', 'runtime') returning id into e;
  ok := false; begin insert into public.notify_events (idempotency_key, type) values ('ev-1', 'ai_interview.distress'); exception when unique_violation then ok := true; end;
  assert ok, 'a replayed event is one event';
  ok := false; begin insert into public.notify_events (idempotency_key, type) values ('ev-x', 'Distress!'); exception when check_violation then ok := true; end;
  assert ok, 'event types are category.name';
  insert into public.notify_deliveries (event_id, customer_id, survey_id, event_type, channel_kind, destination, idempotency_key, status) values (e, 'c0000000-0000-0000-0000-000000000072', 'c0000000-0000-0000-0000-000000000172', 'ai_interview.distress', 'slack', '#research-ops', 'ev-1|slack:#research-ops', 'sent');
  ok := false; begin insert into public.notify_deliveries (event_id, event_type, channel_kind, destination, idempotency_key, status) values (e, 'ai_interview.distress', 'slack', '#research-ops', 'ev-1|slack:#research-ops', 'queued'); exception when unique_violation then ok := true; end;
  assert ok, 'one delivery per event and destination';
  ok := false; begin insert into public.notify_deliveries (event_type, channel_kind, destination, idempotency_key, status) values ('x.y', 'slack', 'a', 'k2', 'delivered-maybe'); exception when check_violation then ok := true; end;
  assert ok, 'delivery status is checked';
  ok := false; begin insert into public.panel_entries (survey_id, panel_key, pid, target, outcome) values ('c0000000-0000-0000-0000-000000000172', 'prolific', 'p', 'ai_interview', 'completed'); exception when check_violation then ok := true; end;
  assert ok, 'outcomes are the panel vocabulary';
  ok := false; begin insert into public.panel_entries (survey_id, panel_key, pid, target) values ('c0000000-0000-0000-0000-000000000172', 'Bad Key!', 'p', 'ai_interview'); exception when check_violation then ok := true; end;
  assert ok, 'panel keys are slugs';
  insert into public.panel_secrets (survey_id, panel_key, secret_sealed, secret_key_id, hint) values ('c0000000-0000-0000-0000-000000000172', 'cint', '{"v":1}', 'k1', '••••9x');
  raise notice 'PASS 2 shapes: kinds, sealed secrets, unique names, idempotency keys, statuses, outcomes';
end $$;

-- ============================================== 3. the outbox claim
do $$
declare a uuid[]; b uuid[]; e2 uuid; n int;
begin
  insert into public.notify_events (idempotency_key, survey_id, type) values ('ev-2', 'c0000000-0000-0000-0000-000000000172', 'study.cost_cap') returning id into e2;
  select array_agg(id order by created_at) into a from public.rescript_notify_claim(10, 60, null);
  assert array_length(a, 1) = 2, 'both pending events claimed';
  select coalesce(array_agg(id), '{}') into b from public.rescript_notify_claim(10, 60, null);
  assert coalesce(array_length(b, 1), 0) = 0, 'a leased event is not claimed twice';
  update public.notify_events set lease_until = now() - interval '1 second' where id = e2;
  select array_agg(id) into b from public.rescript_notify_claim(10, 60, null);
  assert b = array[e2], 'a lapsed lease is claimable again';
  assert (select attempts from public.notify_events where id = e2) = 2, 'attempts counted';
  update public.notify_events set status = 'pending', lease_until = null where idempotency_key = 'ev-1';
  select count(*) into n from public.rescript_notify_claim(10, 60, e2);
  assert n = 0, 'by id: only when claimable';
  select count(*) into n from public.rescript_notify_claim(10, 60, (select id from public.notify_events where idempotency_key = 'ev-1'));
  assert n = 1, 'by id';
  raise notice 'PASS 3 outbox: leased, never twice, lapsed leases reclaimed, by id';
end $$;

-- ============================================== 4. panel entries: duplicates refused atomically
do $$
declare r record; first uuid;
begin
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'prolific', '5f1e2d', 'ai_interview', 'study-1', false, true, '{"STUDY_ID":"s1"}');
  assert not r.duplicate, 'first arrival admitted';
  first := r.entry_id;
  update public.panel_entries set outcome = 'complete', session_ref = 'sess-1', ended_at = now() where id = first;
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'prolific', '5f1e2d', 'group_session', 'g-1', false, true, '{}');
  assert r.duplicate and r.entry_id = first and r.outcome = 'complete' and r.session_ref = 'sess-1', 'the same panel id again is a duplicate, across links';
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'prolific', '5f1e2d', 'ai_interview', 'study-1', true, true, '{}');
  assert not r.duplicate, 'a test entry is separate';
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'cint', '5f1e2d', 'ai_interview', 'study-1', false, true, '{}');
  assert not r.duplicate, 'another panel is another id space';
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'mturk', 'W1', 'survey', null, false, false, '{}');
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'mturk', 'W1', 'survey', null, false, false, '{}');
  assert not r.duplicate, 'a panel that does not dedupe admits repeats';
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'custom', '', 'survey', null, false, true, '{}');
  select * into r from public.rescript_panel_enter('c0000000-0000-0000-0000-000000000172', 'custom', '', 'survey', null, false, true, '{}');
  assert not r.duplicate, 'an empty id never dedupes';
  assert (select count(*) from public.panel_entries where survey_id = 'c0000000-0000-0000-0000-000000000172') = 7, 'seven entries';
  raise notice 'PASS 4 panel entries: first admitted, repeats refused with the first outcome, test / other panels separate';
end $$;

-- ============================================== 5. the RLS backstop
grant select (id, customer_id, kind, name, config, hint, enabled, last_test_at, last_status, created_by, created_at, updated_at) on public.notify_channels to authenticated;
grant select on public.notify_rules, public.notify_events, public.notify_deliveries, public.panel_entries to authenticated;

create or replace function pg_temp.seen(uid text) returns int[] language plpgsql as $$
declare c int; d int; p int;
begin
  perform set_config('request.jwt.claim.sub', uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into c from public.notify_channels where customer_id = 'c0000000-0000-0000-0000-000000000072';
  select count(*) into d from public.notify_deliveries where survey_id = 'c0000000-0000-0000-0000-000000000172';
  select count(*) into p from public.panel_entries where survey_id = 'c0000000-0000-0000-0000-000000000172';
  execute 'reset role';
  return array[c, d, p];
end $$;

do $$
declare ok boolean;
begin
  assert pg_temp.seen('c0000072-0000-0000-0000-000000000001') = array[2, 1, 7], 'owner: channels, deliveries, entries ' || pg_temp.seen('c0000072-0000-0000-0000-000000000001')::text;
  assert pg_temp.seen('c0000072-0000-0000-0000-000000000002') = array[2, 1, 7], 'viewer (same organisation, programmer): all three';
  assert pg_temp.seen('c0000072-0000-0000-0000-000000000003') = array[0, 0, 0], 'vendor (no organisation): nothing';
  assert pg_temp.seen('c0000072-0000-0000-0000-000000000004') = array[0, 1, 7], 'a client of the organisation: no channels; project rows by the workspace baseline role, exactly as 0069 decides them';
  assert pg_temp.seen('c0000072-0000-0000-0000-000000000005') = array[0, 0, 0], 'another organisation: nothing';
  perform set_config('request.jwt.claim.sub', 'c0000072-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', json_build_object('sub', 'c0000072-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false; begin perform secret_sealed from public.notify_channels; exception when insufficient_privilege then ok := true; end;
  assert ok, 'the sealed webhook URL is never readable by a member';
  ok := false; begin perform 1 from public.panel_secrets; exception when insufficient_privilege then ok := true; end;
  assert ok, 'panel secrets are never readable by a member';
  ok := false; begin insert into public.panel_entries (survey_id, panel_key, pid, target) values ('c0000000-0000-0000-0000-000000000172', 'x', 'y', 'survey'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'members cannot write entries';
  ok := false; begin update public.notify_deliveries set status = 'sent'; exception when insufficient_privilege then ok := true; end;
  assert ok, 'members cannot rewrite the delivery log';
  reset role;
  raise notice 'PASS 5 RLS: organisation members see channels (no secret), project readers see deliveries and entries; others nothing; no writes';
end $$;

-- ============================================== 6. the survey takes its rows with it
do $$
begin
  delete from public.surveys where id = 'c0000000-0000-0000-0000-000000000172';
  assert (select count(*) from public.panel_entries where survey_id = 'c0000000-0000-0000-0000-000000000172') = 0, 'entries';
  assert (select count(*) from public.panel_secrets where survey_id = 'c0000000-0000-0000-0000-000000000172') = 0, 'secrets';
  assert (select count(*) from public.notify_events where survey_id = 'c0000000-0000-0000-0000-000000000172') = 0, 'events';
  assert (select count(*) from public.notify_deliveries where survey_id = 'c0000000-0000-0000-0000-000000000172') = 0, 'deliveries';
  assert (select count(*) from public.notify_channels where customer_id = 'c0000000-0000-0000-0000-000000000072') = 2, 'the organisation keeps its channels';
  raise notice 'PASS 6 deleting the survey removes its entries, secrets, events and deliveries';
end $$;

rollback;
