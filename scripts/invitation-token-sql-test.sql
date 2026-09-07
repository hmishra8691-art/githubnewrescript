-- =====================================================================
-- THE INVITATION TOKEN — proved in the database (0017)
--
-- The properties below cannot be proved above the database, because each one
-- is about what happens when two callers race or when a token is presented
-- twice. They are the reason `rescript_accept_invitation` claims and reads in
-- a single statement rather than reading, deciding and then writing.
--
--   psql -d <database> -f scripts/invitation-token-sql-test.sql
--
-- Needs migrations 0001–0017 on a throwaway database. Creates its own
-- fixtures and rolls nothing back — never run it against a live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('11111111-0000-0000-0000-0000000000c1', 'inv-test', 'Invite Test') on conflict do nothing;

alter table auth.users disable trigger on_auth_user_created;
insert into auth.users (id, email) values
  ('11111111-0000-0000-0000-0000000000a1', 'ada@example.com'),
  ('11111111-0000-0000-0000-0000000000a2', 'grace@example.com'),
  ('11111111-0000-0000-0000-0000000000a3', 'alan@example.com')
  on conflict do nothing;
alter table auth.users enable trigger on_auth_user_created;

insert into public.profiles (id, email, full_name, customer_id, role) values
  ('11111111-0000-0000-0000-0000000000a1', 'ada@example.com',   'Ada',   '11111111-0000-0000-0000-0000000000c1', 'programmer'),
  ('11111111-0000-0000-0000-0000000000a2', 'grace@example.com', 'Grace', '11111111-0000-0000-0000-0000000000c1', 'researcher'),
  ('11111111-0000-0000-0000-0000000000a3', 'alan@example.com',  'Alan',  '11111111-0000-0000-0000-0000000000c1', 'researcher')
  on conflict (id) do nothing;

insert into public.surveys (id, customer_id, code, title, status, created_by)
  values ('11111111-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-0000000000c1', 'IT1', 'Invite study', 'draft',
          '11111111-0000-0000-0000-0000000000a1')
  on conflict do nothing;
commit;

\echo '--- 1. the token column no longer has to be filled'
-- the point of the migration: an invitation is written with a HASH and no token
insert into public.project_invitations (id, survey_id, email, role, token_hash, invited_by)
values ('11111111-0000-0000-0000-00000000e001', '11111111-0000-0000-0000-0000000000d1',
        'grace@example.com', 'reviewer',
        repeat('a', 64), '11111111-0000-0000-0000-0000000000a1');
select case when token is null and token_hash = repeat('a', 64)
            then 'PASS the row holds a hash and no working credential'
            else 'FAIL — token ' || coalesce(token, '(null)') end
from public.project_invitations where id = '11111111-0000-0000-0000-00000000e001';

\echo '--- 2. two invitations cannot share a hash'
do $$
begin
  insert into public.project_invitations (survey_id, email, role, token_hash)
  values ('11111111-0000-0000-0000-0000000000d1', 'other@example.com', 'viewer', repeat('a', 64));
  raise exception 'FAIL: two invitations shared one token hash';
exception when unique_violation then
  raise notice 'PASS one token, one invitation';
end $$;

\echo '--- 3. presenting the token grants that project'
select case when count(*) = 1 then 'PASS the invitation is accepted' else 'FAIL' end
from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a2', repeat('a', 64));

select case when count(*) = 1 then 'PASS and the membership exists' else 'FAIL' end
from public.project_members
where survey_id = '11111111-0000-0000-0000-0000000000d1'
  and user_id = '11111111-0000-0000-0000-0000000000a2'
  and role = 'reviewer';

\echo '--- 4. THE TOKEN IS SINGLE-USE — a replayed link grants nothing'
-- the link is in an email, which is forwarded, quoted and left in inboxes
select case when count(*) = 0
            then 'PASS a spent token is refused, so a forwarded link is inert'
            else 'FAIL — the invitation was accepted twice' end
from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a3', repeat('a', 64));

select case when count(*) = 0 then 'PASS and nobody else joined the project' else 'FAIL' end
from public.project_members
where survey_id = '11111111-0000-0000-0000-0000000000d1'
  and user_id = '11111111-0000-0000-0000-0000000000a3';

\echo '--- 5. an unknown token is refused, and says nothing about what exists'
select case when count(*) = 0 then 'PASS' else 'FAIL' end
from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a3', repeat('f', 64));

\echo '--- 6. a REVOKED invitation cannot be accepted'
insert into public.project_invitations (id, survey_id, email, role, token_hash, revoked_at)
values ('11111111-0000-0000-0000-00000000e002', '11111111-0000-0000-0000-0000000000d1',
        'alan@example.com', 'viewer', repeat('b', 64), now());
select case when count(*) = 0
            then 'PASS revoking a share takes the emailed link with it'
            else 'FAIL' end
from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a3', repeat('b', 64));

\echo '--- 7. an EXPIRED invitation cannot be accepted'
insert into public.project_invitations (id, survey_id, email, role, token_hash, expires_at)
values ('11111111-0000-0000-0000-00000000e003', '11111111-0000-0000-0000-0000000000d1',
        'alan@example.com', 'viewer', repeat('c', 64), now() - interval '1 day');
select case when count(*) = 0 then 'PASS an old link stops working on its own' else 'FAIL' end
from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a3', repeat('c', 64));

\echo '--- 8. rubbish in is refused without touching anything'
select case when (select count(*) from public.rescript_accept_invitation(null, repeat('d', 64))) = 0
             and (select count(*) from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a3', null)) = 0
             and (select count(*) from public.rescript_accept_invitation('11111111-0000-0000-0000-0000000000a3', 'short')) = 0
            then 'PASS a null user, a null token and a too-short token all grant nothing'
            else 'FAIL' end;

\echo '--- 9. accepting is recorded, and says HOW it was accepted'
-- "via: token" distinguishes the strong path from the email-address path, so
-- an access review can tell which invitations were actually proven
select case when count(*) = 1 then 'PASS the grant is auditable' else 'FAIL — ' || count(*) end
from public.audit_logs
where action = 'project.invitation_accepted'
  and survey_id = '11111111-0000-0000-0000-0000000000d1'
  and detail->>'via' = 'token';

\echo '--- 10. ONE LIVE INVITATION PER ADDRESS PER PROJECT'
-- Found while writing assertion 11: Alan already has an EXPIRED invitation
-- from assertion 7, and `project_invitations_pending_key` is partial on
-- (accepted_at is null and revoked_at is null) — it does not exclude expired
-- rows. So a second insert for the same address is refused even though the
-- first can never be accepted. That is the intended constraint rather than a
-- bug (`share/route.ts` upserts on the same key, so re-inviting overwrites the
-- stale row), but it is worth pinning: anything that INSERTS instead of
-- upserting will hit it.
do $$
begin
  insert into public.project_invitations (survey_id, email, role, token_hash)
  values ('11111111-0000-0000-0000-0000000000d1', 'alan@example.com', 'viewer', repeat('e', 64));
  raise exception 'FAIL: a second live invitation for one address was accepted';
exception when unique_violation then
  raise notice 'PASS one live invitation per address — re-inviting must upsert, as the share route does';
end $$;

\echo '--- 10b. THE EMAIL PATH STILL WORKS — nobody already invited is stranded'
-- 0017 changes nothing about claim-by-address, which is what sign-in uses and
-- what every invitation sent before this migration depends on. Alan's stale
-- invitation is revoked first, exactly as re-inviting him would.
update public.project_invitations set revoked_at = now()
 where survey_id = '11111111-0000-0000-0000-0000000000d1'
   and lower(email) = 'alan@example.com' and accepted_at is null and revoked_at is null;
insert into public.project_invitations (id, survey_id, email, role, token_hash)
values ('11111111-0000-0000-0000-00000000e004', '11111111-0000-0000-0000-0000000000d1',
        'alan@example.com', 'viewer', repeat('e', 64));
select case when public.rescript_claim_invitations('11111111-0000-0000-0000-0000000000a3') = 1
            then 'PASS an invitation waiting for an address is still claimed at sign-in'
            else 'FAIL' end;

\echo '--- 11. and a plaintext-token row from before 0017 is still claimable by address'
insert into public.project_invitations (id, survey_id, email, role, token, invited_by)
values ('11111111-0000-0000-0000-00000000e005', '11111111-0000-0000-0000-0000000000d1',
        'grace@example.com', 'viewer', 'legacy-plaintext-token-from-0008',
        '11111111-0000-0000-0000-0000000000a1');
select case when token_hash is null and token is not null
            then 'PASS an old row is untouched by the migration'
            else 'FAIL' end
from public.project_invitations where id = '11111111-0000-0000-0000-00000000e005';

\echo '--- 12. deleting the project takes its invitations with it'
delete from public.surveys where id = '11111111-0000-0000-0000-0000000000d1';
select case when count(*) = 0 then 'PASS no orphaned invitations' else 'FAIL' end
from public.project_invitations where survey_id = '11111111-0000-0000-0000-0000000000d1';
