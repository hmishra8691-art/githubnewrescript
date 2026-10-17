-- COLLABORATORS & ADVANCED ACCESS SQL TEST (migration 0062) — run against a
-- database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/collaborators-access-sql-test.sql
--
-- Proves, on real Postgres:
--   1. every existing role is still accepted and still answers as itself
--   2. the five new roles are accepted; an unknown role and a non-object
--      `permissions` are refused by the table
--   3. an EXPIRED membership answers no role (source 'expired'), outranks the
--      workspace baseline (which is `editor`), and drops out of the project
--      list and rescript_project_role (what every RLS policy asks)
--   4. a future expiry still grants, and becomes a refusal by the clock alone
--   5. accepting an invitation by token copies role + permissions + access
--      expiry, and re-grants a revoked row (it used to `do nothing`)
--   6. claiming by email at sign-in does the same, and re-grants an expired row
--   7. a live member is NOT downgraded by accepting a stale invitation
--
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name)
  values ('c0000000-0000-0000-0000-000000000062', 'collab62', 'Collaborators 0062')
on conflict do nothing;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000062-0000-0000-0000-000000000001', 'owner@c62.test', '{"full_name":"Owner"}'::jsonb),
  ('c0000062-0000-0000-0000-000000000002', 'ana@c62.test', '{"full_name":"Ana"}'::jsonb),
  ('c0000062-0000-0000-0000-000000000003', 'ben@c62.test', '{"full_name":"Ben"}'::jsonb),
  ('c0000062-0000-0000-0000-000000000004', 'cy@c62.test', '{"full_name":"Cy"}'::jsonb)
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role) values
  ('c0000062-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000062', 'owner@c62.test', 'Owner', 'programmer'),
  ('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000062', 'ana@c62.test', 'Ana', 'programmer'),
  ('c0000062-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000062', 'ben@c62.test', 'Ben', 'programmer'),
  ('c0000062-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000062', 'cy@c62.test', 'Cy', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id, email = excluded.email;

insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000162', 'c0000000-0000-0000-0000-000000000062', 'C62', 'Access project', 'c0000062-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

-- ============================================== 1–2. ROLES

do $$
declare a record; r text; ok boolean;
begin
  assert public.rescript_workspace_default_role('c0000000-0000-0000-0000-000000000062') = 'editor',
    'the baseline this test turns on: unset means editor';

  foreach r in array array['editor','programmer','reviewer','viewer','test_user','deployment_manager',
                           'project_admin','viewer_data','vendor','interviewer','custom'] loop
    insert into public.project_members (survey_id, user_id, role, added_by)
    values ('c0000000-0000-0000-0000-000000000162', 'c0000062-0000-0000-0000-000000000002', r, 'c0000062-0000-0000-0000-000000000001')
    on conflict (survey_id, user_id) do update set role = excluded.role, revoked_at = null, expires_at = null;
    select * into a from public.rescript_project_access('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000162');
    assert a.project_role = r and a.role_source = 'member', 'role ' || r || ' answers as itself, got ' || coalesce(a.project_role, 'null');
    assert public.rescript_project_role('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000162') = r;
  end loop;

  ok := false;
  begin
    update public.project_members set role = 'superuser'
     where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000002';
  exception when check_violation then ok := true;
  end;
  assert ok, 'an unknown role is refused by the table';

  ok := false;
  begin
    update public.project_members set permissions = '["data"]'::jsonb
     where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000002';
  exception when check_violation then ok := true;
  end;
  assert ok, 'permissions must be a json object';

  update public.project_members
     set role = 'custom', permissions = '{"v":1,"modules":{"data":"none","programming":"view"}}'::jsonb
   where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000002';
  select * into a from public.rescript_project_access('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000162');
  assert a.project_role = 'custom' and a.role_source = 'member', 'custom is a role like any other to SQL; its permissions are the guard''s';
  raise notice 'ok 1-2: eleven roles accepted, unknown role and non-object permissions refused';
end $$;

-- ============================================== 3–4. EXPIRY

do $$
declare a record; n integer;
begin
  update public.project_members set role = 'viewer', permissions = null, expires_at = now() - interval '1 minute'
   where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000002';
  select * into a from public.rescript_project_access('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000162');
  assert a.project_role is null and a.role_source = 'expired',
    'an expired membership answers no role and says why — and is NOT the workspace editor baseline: got '
      || coalesce(a.project_role, 'null') || '/' || a.role_source;
  assert public.rescript_project_role('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000162') is null,
    'every RLS policy asks rescript_project_role — it answers null too';
  select count(*) into n from public.rescript_my_projects('c0000062-0000-0000-0000-000000000002', 180)
   where survey_id = 'c0000000-0000-0000-0000-000000000162';
  assert n = 0, 'an expired project leaves the person''s project list';

  update public.project_members set expires_at = now() + interval '1 day'
   where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000002';
  select * into a from public.rescript_project_access('c0000062-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000162');
  assert a.project_role = 'viewer' and a.role_source = 'member', 'a future expiry still grants';

  select count(*) into n from public.rescript_project_members('c0000000-0000-0000-0000-000000000162', 60)
   where user_id = 'c0000062-0000-0000-0000-000000000002';
  assert n = 1, 'an expiring member is listed on the panel';

  /* the owner is a column, never a membership: no expiry can touch it */
  select * into a from public.rescript_project_access('c0000062-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000162');
  assert a.project_role = 'owner';
  raise notice 'ok 3-4: expired = no role (source expired, not baseline), future expiry grants, owner unaffected';
end $$;

-- ============================================== 5. TOKEN ACCEPTANCE

do $$
declare a record; m record; inv uuid; got record;
begin
  /* Ben was removed earlier… */
  insert into public.project_members (survey_id, user_id, role, added_by, revoked_at, revoked_by)
  values ('c0000000-0000-0000-0000-000000000162', 'c0000062-0000-0000-0000-000000000003', 'editor',
          'c0000062-0000-0000-0000-000000000001', now(), 'c0000062-0000-0000-0000-000000000001')
  on conflict (survey_id, user_id) do update set revoked_at = now();

  /* …and is invited back by link as custom, for 7 days */
  insert into public.project_invitations (survey_id, email, role, token, token_hash, invited_by, permissions, access_expires_at)
  values ('c0000000-0000-0000-0000-000000000162', 'ben@c62.test', 'custom', null,
          repeat('b', 64), 'c0000062-0000-0000-0000-000000000001',
          '{"v":1,"modules":{"data":"view"},"add":["responses.export"]}'::jsonb, now() + interval '7 days')
  returning id into inv;

  select * into got from public.rescript_accept_invitation('c0000062-0000-0000-0000-000000000003', repeat('b', 64));
  assert got.invitation_id = inv and got.role = 'custom', 'the token is accepted';

  select * into m from public.project_members
   where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000003';
  assert m.revoked_at is null, 'a revoked row is granted again by an accepted invitation (it used to stay revoked)';
  assert m.role = 'custom' and m.permissions -> 'modules' ->> 'data' = 'view' and m.permissions -> 'add' ? 'responses.export',
    'the invitation''s permissions become the membership''s';
  assert m.expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute',
    'and so does its access expiry';
  select * into a from public.rescript_project_access('c0000062-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000162');
  assert a.project_role = 'custom' and a.role_source = 'member';

  assert not exists (select 1 from public.rescript_accept_invitation('c0000062-0000-0000-0000-000000000003', repeat('b', 64))),
    'single use, as before';
  assert exists (select 1 from public.audit_logs where action = 'project.invitation_accepted'
                  and survey_id = 'c0000000-0000-0000-0000-000000000162' and detail ->> 'invitationId' = inv::text),
    'acceptance is audited';
  raise notice 'ok 5: token acceptance carries permissions + expiry and re-grants a revoked member';
end $$;

-- ============================================== 6–7. EMAIL CLAIM

do $$
declare m record; n integer;
begin
  /* Cy's access EXPIRED yesterday, and Cy is invited again by email as vendor, no expiry */
  insert into public.project_members (survey_id, user_id, role, added_by, expires_at)
  values ('c0000000-0000-0000-0000-000000000162', 'c0000062-0000-0000-0000-000000000004', 'reviewer',
          'c0000062-0000-0000-0000-000000000001', now() - interval '1 day');
  insert into public.project_invitations (survey_id, email, role, token, token_hash, invited_by)
  values ('c0000000-0000-0000-0000-000000000162', 'cy@c62.test', 'vendor', null, repeat('c', 64), 'c0000062-0000-0000-0000-000000000001');

  n := public.rescript_claim_invitations('c0000062-0000-0000-0000-000000000004');
  assert n = 1, 'one invitation claimed';
  select * into m from public.project_members
   where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000004';
  assert m.role = 'vendor' and m.expires_at is null, 'an expired row is granted again, without the old expiry';

  /* Ana is a LIVE viewer (expiring tomorrow); a stale invitation as editor must not change her */
  insert into public.project_invitations (survey_id, email, role, token, token_hash, invited_by, access_expires_at)
  values ('c0000000-0000-0000-0000-000000000162', 'ana@c62.test', 'editor', null, repeat('a', 64), 'c0000062-0000-0000-0000-000000000001', null);
  perform public.rescript_claim_invitations('c0000062-0000-0000-0000-000000000002');
  select * into m from public.project_members
   where survey_id = 'c0000000-0000-0000-0000-000000000162' and user_id = 'c0000062-0000-0000-0000-000000000002';
  assert m.role = 'viewer' and m.expires_at > now(), 'a live membership is not rewritten by accepting an invitation (as before 0062)';
  raise notice 'ok 6-7: email claim re-grants an expired row; a live member is left alone';
end $$;

rollback;
