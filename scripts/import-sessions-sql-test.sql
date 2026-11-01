-- IMPORT SESSIONS SQL TEST (migration 0080) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/import-sessions-sql-test.sql
--
-- Proves, on real Postgres:
--   1. shape: status / mode / scope are closed sets; a storage key never without its bucket;
--      the source expires 90 days after creation by default
--   2. the expiry function returns only sessions whose object is due, oldest first, bounded;
--      it is not callable by signed-in users
--   3. RLS: an organisation's members read its sessions, another organisation's member reads none,
--      an anonymous connection reads none; nobody but the service role writes
--   4. deleting the project keeps the session (survey_id set null) — the history outlives the project
--   5. the private bucket exists and is not public
--
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name) values
  ('b0000000-0000-0000-0000-000000000080', 'imp80', 'Imports 0080'),
  ('b0000000-0000-0000-0000-000000000081', 'imp81', 'Other org 0080')
on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('b0000080-0000-0000-0000-000000000001', 'own@i80.test', '{}'::jsonb),
  ('b0000080-0000-0000-0000-000000000002', 'out@i81.test', '{}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role) values
  ('b0000080-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000080', 'own@i80.test', 'Own', 'programmer'),
  ('b0000080-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000081', 'out@i81.test', 'Out', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id;
insert into public.surveys (id, customer_id, code, title, owner_id) values
  ('b0000000-0000-0000-0000-000000000180', 'b0000000-0000-0000-0000-000000000080', 'I80', 'Imported project', 'b0000080-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

-- ============================================== 1. SHAPE
do $$
declare ok boolean; exp timestamptz;
begin
  insert into public.import_sessions (id, customer_id, user_id, survey_id, into_mode, file_name, format, platform, fingerprint, size_bytes, storage_provider, bucket, storage_key, status)
  values ('b0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-000000000080', 'b0000080-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000180', 'merge', 'tracker.qsf', 'qsf', 'qualtrics', 'fp1', 1234, 'supabase', 'rescript-imports', 'b80/a1/tracker.qsf', 'applied');
  select source_expires_at into exp from public.import_sessions where id = 'b0000000-0000-0000-0000-0000000000a1';
  assert exp between now() + interval '89 days 23 hours' and now() + interval '90 days 1 hour', 'the source expires after 90 days by default';

  begin insert into public.import_sessions (customer_id, file_name, format, fingerprint, status) values ('b0000000-0000-0000-0000-000000000080', 'x', 'qsf', 'f', 'done'); ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'an unknown status is refused';
  begin insert into public.import_sessions (customer_id, file_name, format, fingerprint, into_mode) values ('b0000000-0000-0000-0000-000000000080', 'x', 'qsf', 'f', 'replace'); ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'an unknown mode is refused';
  begin insert into public.import_sessions (customer_id, file_name, format, fingerprint, storage_key) values ('b0000000-0000-0000-0000-000000000080', 'x', 'qsf', 'f', 'k'); ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'a key without a bucket is refused';
end $$;

-- ============================================== 2. EXPIRY
do $$
declare n int; first uuid;
begin
  insert into public.import_sessions (id, customer_id, file_name, format, fingerprint, bucket, storage_key, source_expires_at) values
    ('b0000000-0000-0000-0000-0000000000a2', 'b0000000-0000-0000-0000-000000000080', 'old.docx', 'docx', 'f2', 'rescript-imports', 'k2', now() - interval '2 days'),
    ('b0000000-0000-0000-0000-0000000000a3', 'b0000000-0000-0000-0000-000000000080', 'older.docx', 'docx', 'f3', 'rescript-imports', 'k3', now() - interval '5 days'),
    ('b0000000-0000-0000-0000-0000000000a4', 'b0000000-0000-0000-0000-000000000080', 'gone.docx', 'docx', 'f4', null, null, now() - interval '9 days');
  select count(*) into n from public.rescript_import_sessions_expired(10);
  assert n = 2, 'two objects are due (the fresh one and the already-cleared one are not), got ' || n;
  select id into first from public.rescript_import_sessions_expired(1);
  assert first = 'b0000000-0000-0000-0000-0000000000a3', 'oldest first, and the limit holds';
  assert not has_function_privilege('authenticated', 'public.rescript_import_sessions_expired(integer)', 'execute'), 'signed-in users cannot list objects';
  assert has_function_privilege('service_role', 'public.rescript_import_sessions_expired(integer)', 'execute');
end $$;

-- ============================================== 3. RLS
set local role authenticated;
set local request.jwt.claim.sub = 'b0000080-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*) from public.import_sessions) = 4, 'a member reads the organisation''s sessions, got ' || (select count(*) from public.import_sessions);
end $$;
do $$ declare ok boolean; begin
  begin update public.import_sessions set status = 'discarded'; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'a member cannot write';
end $$;
set local request.jwt.claim.sub = 'b0000080-0000-0000-0000-000000000002';
do $$ begin assert (select count(*) from public.import_sessions) = 0, 'another organisation reads nothing'; end $$;
reset role;
set local role anon;
do $$ declare ok boolean; begin
  begin perform 1 from public.import_sessions; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anonymous has no access';
end $$;
reset role;

-- ============================================== 4. THE HISTORY OUTLIVES THE PROJECT
delete from public.surveys where id = 'b0000000-0000-0000-0000-000000000180';
do $$ begin
  assert exists (select 1 from public.import_sessions where id = 'b0000000-0000-0000-0000-0000000000a1' and survey_id is null), 'survey_id is cleared, the session stays';
end $$;

-- ============================================== 5. BUCKET
do $$ begin
  if to_regclass('storage.buckets') is not null then
    assert exists (select 1 from storage.buckets where id = 'rescript-imports' and public = false), 'the bucket exists and is private';
  end if;
end $$;

rollback;
\echo 'import-sessions-sql-test: all 5 sections passed'
