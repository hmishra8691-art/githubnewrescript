-- ============================================================================
-- ACCESS AND LOCK RULES — proved against a real Postgres, not a mock.
-- ============================================================================
--
--   sudo -u postgres psql -d authtest -v ON_ERROR_STOP=1 -f scripts/access-sql-test.sql
--
-- These are the rules that decide whether a user can see a project and whether
-- a save is accepted. They live half in TypeScript (@rescript/access) and half
-- in SQL, and the SQL half is the half that actually refuses a manipulated
-- request — so it is the half that has to be proved against the real planner,
-- with real rows, real transactions and the real unique indexes.
--
-- Every check is an assertion with a name. A failure raises, so ON_ERROR_STOP
-- turns the whole file into one pass/fail.

\set ON_ERROR_STOP on
set client_min_messages = warning;

create temporary table checks (n serial, name text, ok boolean, got text, want text);

create or replace function pg_temp.check_eq(p_name text, p_got text, p_want text) returns void
language plpgsql as $$
begin
  insert into checks (name, ok, got, want)
  values (p_name, p_got is not distinct from p_want, coalesce(p_got,'<null>'), coalesce(p_want,'<null>'));
end $$;

-- ---------------------------------------------------------------- fixture

/*
 * Two workspaces, so every cross-organization assertion has something real to
 * be refused by. Fixed UUIDs: a failing check should name a row a human can go
 * and look at, not a value that changed on the last run.
 */
do $$
begin
  delete from public.project_edit_locks where survey_id in
    ('aaaa0000-0000-0000-0000-00000000000a','aaaa0000-0000-0000-0000-00000000000b');
  delete from public.project_members where survey_id in
    ('aaaa0000-0000-0000-0000-00000000000a','aaaa0000-0000-0000-0000-00000000000b');
  delete from public.surveys where id in
    ('aaaa0000-0000-0000-0000-00000000000a','aaaa0000-0000-0000-0000-00000000000b');
  delete from public.user_sessions where user_id in
    ('1111aaaa-0000-0000-0000-000000000001','1111aaaa-0000-0000-0000-000000000002',
     '1111aaaa-0000-0000-0000-000000000003','1111aaaa-0000-0000-0000-000000000004');
  delete from public.audit_logs where user_id in
    ('1111aaaa-0000-0000-0000-000000000001','1111aaaa-0000-0000-0000-000000000002',
     '1111aaaa-0000-0000-0000-000000000003','1111aaaa-0000-0000-0000-000000000004');
  delete from public.profiles where id in
    ('1111aaaa-0000-0000-0000-000000000001','1111aaaa-0000-0000-0000-000000000002',
     '1111aaaa-0000-0000-0000-000000000003','1111aaaa-0000-0000-0000-000000000004');
  delete from auth.users where id in
    ('1111aaaa-0000-0000-0000-000000000001','1111aaaa-0000-0000-0000-000000000002',
     '1111aaaa-0000-0000-0000-000000000003','1111aaaa-0000-0000-0000-000000000004');
  delete from public.access_settings where customer_id in
    ('cccc0000-0000-0000-0000-00000000000a','cccc0000-0000-0000-0000-00000000000b');
  delete from public.customers where id in
    ('cccc0000-0000-0000-0000-00000000000a','cccc0000-0000-0000-0000-00000000000b');
end $$;

insert into public.customers (id, slug, name) values
  ('cccc0000-0000-0000-0000-00000000000a', 'acme-test', 'Acme Research'),
  ('cccc0000-0000-0000-0000-00000000000b', 'other-test', 'Other Agency');

/*
 * `profiles.id` references `auth.users`, and an insert there fires the signup
 * trigger — which would build its own workspaces and roles and quietly
 * decide half of what this file is trying to assert. The trigger has its own
 * coverage; here the fixture is stated explicitly, so the auth rows go in
 * with it switched off.
 */
alter table auth.users disable trigger on_auth_user_created;
insert into auth.users (id, email) values
  ('1111aaaa-0000-0000-0000-000000000001','owner@acme.test'),
  ('1111aaaa-0000-0000-0000-000000000002','colleague@acme.test'),
  ('1111aaaa-0000-0000-0000-000000000003','shared@acme.test'),
  ('1111aaaa-0000-0000-0000-000000000004','outsider@other.test')
on conflict (id) do nothing;
alter table auth.users enable trigger on_auth_user_created;

insert into public.profiles (id, customer_id, email, full_name, role, user_code, status) values
  ('1111aaaa-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-00000000000a','owner@acme.test','Ann Owner','programmer','USR-90001','active'),
  ('1111aaaa-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-00000000000a','colleague@acme.test','Ben Colleague','programmer','USR-90002','active'),
  ('1111aaaa-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-00000000000a','shared@acme.test','Cara Shared','programmer','USR-90003','active'),
  ('1111aaaa-0000-0000-0000-000000000004','cccc0000-0000-0000-0000-00000000000b','outsider@other.test','Dan Outsider','programmer','USR-90004','active');

insert into public.surveys (id, code, title, status, owner_id, customer_id) values
  ('aaaa0000-0000-0000-0000-00000000000a','TST-A','Acme Study','draft',
   '1111aaaa-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-00000000000a'),
  -- an owner-less project, the shape the signup trigger used to hand away
  ('aaaa0000-0000-0000-0000-00000000000b','TST-B','Orphan Study','draft',
   null,'cccc0000-0000-0000-0000-00000000000a');

-- Cara was explicitly shared the project as a VIEWER, which must beat the
-- workspace baseline of editor. This is the check that keeps the share dialog
-- honest.
insert into public.project_members (survey_id, user_id, role, added_by) values
  ('aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000003','viewer',
   '1111aaaa-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- 1. role resolution

do $$
declare r record;
begin
  -- default policy: no access_settings row for this workspace, so the
  -- platform default (editor) applies
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('owner gets owner', r.project_role, 'owner');
  perform pg_temp.check_eq('owner source is owner', r.role_source, 'owner');

  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('P0-1: workspace colleague can see the project', r.project_role, 'editor');
  perform pg_temp.check_eq('P0-1: and knows why', r.role_source, 'workspace');

  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('explicit share beats the baseline', r.project_role, 'viewer');
  perform pg_temp.check_eq('...and reports itself as a share', r.role_source, 'member');

  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('another organization still sees nothing', r.project_role, null);
  perform pg_temp.check_eq('...and is not a member', r.role_source, 'none');

  -- the owner-less project: visible to its workspace, owned by nobody
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000000b');
  perform pg_temp.check_eq('owner-less project is not lost to its workspace', r.project_role, 'editor');
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-00000000000b');
  perform pg_temp.check_eq('owner-less project is still not public', r.project_role, null);

  -- a project that does not exist must answer, not raise
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-0000000000ff');
  perform pg_temp.check_eq('unknown project answers null', r.project_role, null);

  -- null arguments
  select * into r from public.rescript_project_access(null, 'aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('null user answers null', r.project_role, null);
end $$;

-- ---------------------------------------------------------------- 2. the setting

insert into public.access_settings (customer_id, policy) values
  ('cccc0000-0000-0000-0000-00000000000a', '{"workspace":{"defaultRole":"reviewer"}}'::jsonb);

do $$
declare r record;
begin
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('a workspace can lower its baseline', r.project_role, 'reviewer');
  perform pg_temp.check_eq('reviewer cannot edit (capability table decides, not this)',
    (select case when r.project_role = 'reviewer' then 'reviewer' end), 'reviewer');
end $$;

update public.access_settings set policy = '{"workspace":{"defaultRole":null}}'::jsonb
 where customer_id = 'cccc0000-0000-0000-0000-00000000000a';

do $$
declare r record;
begin
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('an explicit null switches the baseline off', r.project_role, null);
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('...without touching explicit shares', r.project_role, 'viewer');
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('...or ownership', r.project_role, 'owner');
end $$;

update public.access_settings set policy = '{"workspace":{"defaultRole":"superuser"}}'::jsonb
 where customer_id = 'cccc0000-0000-0000-0000-00000000000a';

do $$
declare r record;
begin
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('an unrecognised setting closes the door', r.project_role, null);
end $$;

update public.access_settings set policy = '{"workspace":{"defaultRole":"owner"}}'::jsonb
 where customer_id = 'cccc0000-0000-0000-0000-00000000000a';

do $$
declare r record;
begin
  select * into r from public.rescript_project_access(
    '1111aaaa-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('a workspace cannot grant itself ownership', r.project_role, null);
end $$;

-- back to the default for the lock tests
delete from public.access_settings where customer_id = 'cccc0000-0000-0000-0000-00000000000a';

-- ---------------------------------------------------------------- 3. lock liveness

insert into public.user_sessions (id, user_id, status, expires_at) values
  ('5555aaaa-0000-0000-0000-000000000001','1111aaaa-0000-0000-0000-000000000001','active', now() + interval '2 hours'),
  ('5555aaaa-0000-0000-0000-000000000002','1111aaaa-0000-0000-0000-000000000002','active', now() + interval '2 hours');

do $$
declare r record; n integer;
begin
  -- Ann takes the lock
  select * into r from public.rescript_acquire_lock(
    'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000001',
    '5555aaaa-0000-0000-0000-000000000001', 180, 28800, null);
  perform pg_temp.check_eq('first editor gets the lock', r.acquired::text, 'true');

  -- Ben cannot, while Ann is live and heartbeating
  select * into r from public.rescript_acquire_lock(
    'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000002',
    '5555aaaa-0000-0000-0000-000000000002', 180, 28800, null);
  perform pg_temp.check_eq('P0-6: a second editor is refused', r.acquired::text, 'false');
  perform pg_temp.check_eq('...and is told who holds it', r.locked_by_name, 'Ann Owner');

  -- the lock reports the holder's session as live
  select * into r from public.rescript_lock_for('aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('holder session reported live', r.holder_session_live::text, 'true');

  -- Ann signs out. Her heartbeat is seconds old, so the OLD rule would keep
  -- this lock alive for another three minutes.
  update public.user_sessions set status = 'logged_out', ended_at = now(), ended_reason = 'logout'
   where id = '5555aaaa-0000-0000-0000-000000000001';

  select * into r from public.rescript_lock_for('aaaa0000-0000-0000-0000-00000000000a');
  perform pg_temp.check_eq('P0-8: a signed-out holder is not live', r.holder_session_live::text, 'false');

  select * into r from public.rescript_acquire_lock(
    'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000002',
    '5555aaaa-0000-0000-0000-000000000002', 180, 28800, null);
  perform pg_temp.check_eq('P0-8: the lock is takeable immediately', r.acquired::text, 'true');
  perform pg_temp.check_eq('P0-8: and the takeover is reported as orphaned, not stale',
    r.was_orphaned::text, 'true');
  perform pg_temp.check_eq('...and not misreported as stale', r.was_stale::text, 'false');
end $$;

do $$
declare r record; n integer;
begin
  -- Ben's own session ends. The sweep that runs on every collaboration poll
  -- must clear it without anyone asking.
  update public.user_sessions set status = 'revoked', ended_at = now(), ended_reason = 'admin'
   where id = '5555aaaa-0000-0000-0000-000000000002';

  select public.rescript_expire_locks(180) into n;
  perform pg_temp.check_eq('P0-8: the sweep releases a dead session''s lock', (n > 0)::text, 'true');

  select l.status, l.released_reason into r
    from public.project_edit_locks l where l.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('...marking it released', r.status, 'released');
  perform pg_temp.check_eq('...for the right reason', r.released_reason, 'session_ended');
end $$;

do $$
declare r record; n integer;
begin
  -- a live session's lock is NOT swept: §29 is explicit that the lock must not
  -- be released aggressively while someone is working
  update public.user_sessions set status = 'active', ended_at = null, ended_reason = null,
         last_seen_at = now()
   where id = '5555aaaa-0000-0000-0000-000000000001';
  select * into r from public.rescript_acquire_lock(
    'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000001',
    '5555aaaa-0000-0000-0000-000000000001', 180, 28800, 'questions');
  perform pg_temp.check_eq('lock re-acquired by a live session', r.acquired::text, 'true');

  select public.rescript_expire_locks(180) into n;
  perform pg_temp.check_eq('the sweep leaves a live editor alone', n::text, '0');

  select l.status into r from public.project_edit_locks l
   where l.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('...still held', r.status, 'held');

  /*
   * And signing out releases it at once rather than waiting for a sweep —
   * through `rescript_end_session`, the function the logout route actually
   * calls, so this exercises the real path rather than the helper underneath
   * it.
   */
  select public.rescript_end_session('5555aaaa-0000-0000-0000-000000000001','logout',null) into n;
  perform pg_temp.check_eq('sign-out ends the session', n::text, '1');
  select l.status, l.released_reason into r from public.project_edit_locks l
   where l.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('...and releases the lock in the same call', r.status, 'released');
  perform pg_temp.check_eq('...recording why', r.released_reason, 'logout');
  perform pg_temp.check_eq('...and the presence row is gone too',
    (select count(*)::text from public.project_presence where session_id = '5555aaaa-0000-0000-0000-000000000001'), '0');
end $$;

-- ---------------------------------------------------------------- 4. the dashboard

do $$
declare n integer; src text;
begin
  select count(*) into n from public.rescript_my_projects('1111aaaa-0000-0000-0000-000000000002', 180)
   where survey_id in ('aaaa0000-0000-0000-0000-00000000000a','aaaa0000-0000-0000-0000-00000000000b');
  perform pg_temp.check_eq('P0-1: the colleague''s dashboard shows both projects', n::text, '2');

  select p.role_source into src from public.rescript_my_projects('1111aaaa-0000-0000-0000-000000000002', 180) p
   where p.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('...bucketed as workspace access', src, 'workspace');

  select p.role_source into src from public.rescript_my_projects('1111aaaa-0000-0000-0000-000000000001', 180) p
   where p.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('...and the owner''s as ownership', src, 'owner');

  select count(*) into n from public.rescript_my_projects('1111aaaa-0000-0000-0000-000000000004', 180)
   where survey_id in ('aaaa0000-0000-0000-0000-00000000000a','aaaa0000-0000-0000-0000-00000000000b');
  perform pg_temp.check_eq('the outsider''s dashboard shows neither', n::text, '0');
end $$;

do $$
declare who uuid;
begin
  -- "Editing: Ann" must disappear from the card the moment Ann's session does
  update public.user_sessions set status = 'active', last_seen_at = now()
   where id = '5555aaaa-0000-0000-0000-000000000001';
  perform public.rescript_acquire_lock(
    'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000001',
    '5555aaaa-0000-0000-0000-000000000001', 180, 28800, null);

  select p.editing_user_id into who from public.rescript_my_projects('1111aaaa-0000-0000-0000-000000000002', 180) p
   where p.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('the card names the live editor', who::text, '1111aaaa-0000-0000-0000-000000000001');

  update public.user_sessions set status = 'logged_out' where id = '5555aaaa-0000-0000-0000-000000000001';
  select p.editing_user_id into who from public.rescript_my_projects('1111aaaa-0000-0000-0000-000000000002', 180) p
   where p.survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  perform pg_temp.check_eq('and stops naming them once they sign out', who::text, null);
end $$;

-- ---------------------------------------------------------------- 5. one winner

/*
 * Two sessions go for a free lock inside ONE statement. This proves the
 * conflict path grants exactly one of them — the `where` on the `do update`
 * runs inside the row lock Postgres already took, so the second call sees the
 * first one's row and is refused.
 *
 * It is not, and should not be mistaken for, a concurrency test: both calls
 * run in the same backend, in sequence. Genuine simultaneity — two connections
 * in two transactions hitting the same row at the same instant — is proved in
 * scripts/lock-concurrency-test.mjs, the same way the List Fill slot claim is.
 */
do $$
declare wins integer;
begin
  update public.project_edit_locks set status = 'released', released_at = now()
   where survey_id = 'aaaa0000-0000-0000-0000-00000000000a';
  update public.user_sessions set status = 'active', last_seen_at = now(), ended_at = null
   where id in ('5555aaaa-0000-0000-0000-000000000001','5555aaaa-0000-0000-0000-000000000002');

  select count(*) into wins from (
    select (public.rescript_acquire_lock(
      'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000001',
      '5555aaaa-0000-0000-0000-000000000001', 180, 28800, null)).acquired as a
    union all
    select (public.rescript_acquire_lock(
      'aaaa0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-000000000002',
      '5555aaaa-0000-0000-0000-000000000002', 180, 28800, null)).acquired as a
  ) t where t.a;
  perform pg_temp.check_eq('P0-6: exactly one of two racing editors wins', wins::text, '1');
end $$;

-- ---------------------------------------------------------------- report

\pset format unaligned
select format('  %s  %s%s',
              case when ok then ' ok ' else 'FAIL' end,
              name,
              case when ok then '' else format('   got %s, want %s', got, want) end)
from checks order by n;

select format('%s checks, %s failed', count(*), count(*) filter (where not ok)) from checks;

do $$
declare bad integer;
begin
  select count(*) into bad from checks where not ok;
  if bad > 0 then
    raise exception '% assertion(s) failed', bad;
  end if;
end $$;
