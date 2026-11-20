-- RESPONDENT PORTAL SQL TEST (migration 0103, phase 1 2026-11-20) — against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/portal-sql-test.sql
--
-- Proves, on real Postgres 16:
--   1. account rules: the respondent id format, one persistent account per email (an assessment-only account never
--      claims the address), a password column that only accepts a scrypt hash, token hashes of 64 characters
--   2. an enrolment: one per (survey, account, environment); the new respondents columns default to "as before"
--   3. rescript_portal_edit_response: writes the answers and ONE response_edits row naming the respondent, keeps
--      `source`, bumps the revision; refuses a stale revision, a missing revision and an unfinished interview
--   4. deleting an account removes its credentials, sessions and events
--   5. row-level security: anon and authenticated read nothing from the four tables
-- One transaction, rolled back — safe to run twice.

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000103', 'portal103', 'Portal 0103');
insert into public.surveys (id, customer_id, code, title) values ('c0000000-0000-0000-0000-000000010301', 'c0000000-0000-0000-0000-000000000103', 'P103', 'Wellbeing');
insert into public.survey_versions (id, survey_id, version, definition) values ('c0000000-0000-0000-0000-000000010302', 'c0000000-0000-0000-0000-000000010301', '1.0', '{}'::jsonb);

-- 1 ---------------------------------------------------------------------------------------------------------------
insert into public.portal_accounts (id, respondent_id, email, scope, status) values
  ('c0000000-0000-0000-0000-0000000103a1', 'RSP-ANA00001', 'ana@p103.test', 'persistent', 'active'),
  ('c0000000-0000-0000-0000-0000000103a2', 'RSP-ANA00002', 'ana@p103.test', 'assessment', 'invited');
do $$ begin
  begin insert into public.portal_accounts (respondent_id, email) values ('RSP-ANA00003', 'ana@p103.test'); raise exception 'FAIL: a second persistent account took the same email';
  exception when unique_violation then null; end;
  begin insert into public.portal_accounts (respondent_id) values ('rsp-lower01'); raise exception 'FAIL: a malformed respondent id was accepted';
  exception when check_violation then null; end;
  begin insert into public.portal_accounts (respondent_id, email) values ('RSP-ANA00004', 'Ana@P103.test'); raise exception 'FAIL: an email that is not lower-case was accepted';
  exception when check_violation then null; end;
  begin insert into public.portal_credentials (account_id, password_hash) values ('c0000000-0000-0000-0000-0000000103a1', 'hunter2-in-plain-text'); raise exception 'FAIL: a readable password was stored';
  exception when check_violation then null; end;
  begin insert into public.portal_credentials (account_id, invite_token_hash) values ('c0000000-0000-0000-0000-0000000103a1', 'short'); raise exception 'FAIL: a token that is not a SHA-256 was stored';
  exception when check_violation then null; end;
end $$;
insert into public.portal_credentials (account_id, password_hash) values ('c0000000-0000-0000-0000-0000000103a1', 'scrypt$16384$c2FsdA$a2V5');
insert into public.portal_sessions (account_id, token_hash) values ('c0000000-0000-0000-0000-0000000103a1', repeat('a', 64));
insert into public.portal_events (account_id, event) values ('c0000000-0000-0000-0000-0000000103a1', 'sign_in');

-- 2 ---------------------------------------------------------------------------------------------------------------
insert into public.respondents (id, survey_id, email) values ('c0000000-0000-0000-0000-0000000103e0', 'c0000000-0000-0000-0000-000000010301', 'old@p103.test');
do $$ declare r record; begin
  select * into r from public.respondents where id = 'c0000000-0000-0000-0000-0000000103e0';
  if r.account_id is not null or r.access_from is not null or r.access_until is not null or r.max_attempts is not null or r.portal_suspended or r.portal_locked_at is not null or r.portal_reopened_until is not null then
    raise exception 'FAIL: a link-only respondent does not default to "as before"';
  end if;
end $$;
insert into public.respondents (id, survey_id, account_id) values ('c0000000-0000-0000-0000-0000000103e1', 'c0000000-0000-0000-0000-000000010301', 'c0000000-0000-0000-0000-0000000103a1');
do $$ begin
  begin insert into public.respondents (survey_id, account_id) values ('c0000000-0000-0000-0000-000000010301', 'c0000000-0000-0000-0000-0000000103a1'); raise exception 'FAIL: the same account was enrolled twice in one survey';
  exception when unique_violation then null; end;
  begin insert into public.respondents (survey_id, max_attempts) values ('c0000000-0000-0000-0000-000000010301', 0); raise exception 'FAIL: zero attempts was accepted';
  exception when check_violation then null; end;
end $$;
-- the TEST list is a different environment: the same account may be on it
insert into public.respondents (survey_id, account_id, is_test) values ('c0000000-0000-0000-0000-000000010301', 'c0000000-0000-0000-0000-0000000103a1', true);

-- 3 ---------------------------------------------------------------------------------------------------------------
insert into public.responses (id, survey_id, version_id, session_id, respondent_id, status, answers, completed_at) values
  ('c0000000-0000-0000-0000-0000000103f1', 'c0000000-0000-0000-0000-000000010301', 'c0000000-0000-0000-0000-000000010302', 'p103-session-complete-0001', 'c0000000-0000-0000-0000-0000000103e1', 'complete', '{"q1": 1, "q2": "fine"}', now()),
  ('c0000000-0000-0000-0000-0000000103f2', 'c0000000-0000-0000-0000-000000010301', 'c0000000-0000-0000-0000-000000010302', 'p103-session-running-0002', 'c0000000-0000-0000-0000-0000000103e1', 'in_progress', '{"q1": 1}', null);
do $$
declare rev integer; newrev integer; src text; n integer; e record;
begin
  select revision, source into rev, src from public.responses where id = 'c0000000-0000-0000-0000-0000000103f1';
  select new_revision into newrev from public.rescript_portal_edit_response('c0000000-0000-0000-0000-0000000103f1', rev, '{"q1": 1, "q2": "better"}', null, '{"q2": {"from": "fine", "to": "better"}}', 'respondent:RSP-ANA00001');
  if newrev <> rev + 1 then raise exception 'FAIL: the revision did not move by one (% -> %)', rev, newrev; end if;
  if (select answers->>'q2' from public.responses where id = 'c0000000-0000-0000-0000-0000000103f1') <> 'better' then raise exception 'FAIL: the answer was not written'; end if;
  if (select source from public.responses where id = 'c0000000-0000-0000-0000-0000000103f1') is distinct from src then raise exception 'FAIL: the source changed — a respondent''s own edit is not a manual edit'; end if;
  select count(*) into n from public.response_edits where response_id = 'c0000000-0000-0000-0000-0000000103f1';
  if n <> 1 then raise exception 'FAIL: expected one history row, found %', n; end if;
  select * into e from public.response_edits where response_id = 'c0000000-0000-0000-0000-0000000103f1';
  if e.edited_by <> 'respondent:RSP-ANA00001' or e.action <> 'edit' or e.revision_before <> rev or e.revision_after <> newrev or e.changes->'q2'->>'from' <> 'fine' then raise exception 'FAIL: the history row is wrong: %', row_to_json(e); end if;

  begin perform public.rescript_portal_edit_response('c0000000-0000-0000-0000-0000000103f1', rev, '{}', null, '{}', 'respondent:RSP-ANA00001'); raise exception 'FAIL: a stale revision was accepted';
  exception when others then if sqlerrm not like 'REVISION_CONFLICT%' then raise; end if; end;
  begin perform public.rescript_portal_edit_response('c0000000-0000-0000-0000-0000000103f1', null, '{}', null, '{}', 'respondent:RSP-ANA00001'); raise exception 'FAIL: an edit without a revision was accepted';
  exception when others then if sqlerrm not like 'REVISION_CONFLICT%' then raise; end if; end;
  begin perform public.rescript_portal_edit_response('c0000000-0000-0000-0000-0000000103f2', 0, '{}', null, '{}', 'respondent:RSP-ANA00001'); raise exception 'FAIL: an unfinished interview was edited';
  exception when others then if sqlerrm not like 'RESPONSE_NOT_COMPLETE%' and sqlerrm not like 'REVISION_CONFLICT%' then raise; end if; end;
  if (select answers->>'q2' from public.responses where id = 'c0000000-0000-0000-0000-0000000103f1') <> 'better' then raise exception 'FAIL: a refused edit changed the row'; end if;
end $$;

-- 4 ---------------------------------------------------------------------------------------------------------------
delete from public.portal_accounts where id = 'c0000000-0000-0000-0000-0000000103a1';
do $$ begin
  if exists (select 1 from public.portal_credentials where account_id = 'c0000000-0000-0000-0000-0000000103a1')
     or exists (select 1 from public.portal_sessions where account_id = 'c0000000-0000-0000-0000-0000000103a1')
     or exists (select 1 from public.portal_events where account_id = 'c0000000-0000-0000-0000-0000000103a1') then
    raise exception 'FAIL: deleting an account left its credentials, sessions or events';
  end if;
end $$;

-- 5 ---------------------------------------------------------------------------------------------------------------
do $$ declare t text; n integer; begin
  foreach t in array array['portal_accounts', 'portal_credentials', 'portal_sessions', 'portal_events'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAIL: % has no row-level security', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then raise exception 'FAIL: % has a policy — it is service-role only', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then raise exception 'FAIL: % is readable by anon or authenticated', t; end if;
  end loop;
end $$;

select 'portal sql test: all checks passed' as result;
rollback;
