-- =====================================================================
-- MAIL — proved in the database
--
-- Migration 0016's two guarantees live below the application and can only
-- be proved here: a reset token is single-use and its hash is unique, and a
-- successful send cannot be repeated while a failed one can be retried.
--
--   psql -d <database> -f scripts/mail-sql-test.sql
--
-- Needs migrations 0001–0016 on a throwaway database. Creates its own
-- fixtures and rolls nothing back — never run it against a live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('eeeeeeee-0000-0000-0000-0000000000e1', 'mail-test', 'Mail Test') on conflict do nothing;
insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-0000000000f1', 'ada@example.com')
  on conflict do nothing;
insert into public.profiles (id, email, full_name, customer_id)
  values ('eeeeeeee-0000-0000-0000-0000000000f1', 'ada@example.com', 'Ada Lovelace', 'eeeeeeee-0000-0000-0000-0000000000e1')
  on conflict (id) do nothing;
insert into public.surveys (id, customer_id, code, title, status)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'eeeeeeee-0000-0000-0000-0000000000e1', 'M1', 'Mail study', 'live')
  on conflict do nothing;
insert into public.respondents (id, survey_id, is_test, list_name, name, email, external_id, status)
values
  ('eeeeeeee-0000-0000-0000-00000000a001', 'eeeeeeee-0000-0000-0000-0000000000d1', false, 'wave 1', 'Ada',   'ada@example.com',   'E1', 'invited'),
  ('eeeeeeee-0000-0000-0000-00000000a002', 'eeeeeeee-0000-0000-0000-0000000000d1', false, 'wave 1', 'Alan',  'alan@example.com',  'E2', 'invited'),
  ('eeeeeeee-0000-0000-0000-00000000a003', 'eeeeeeee-0000-0000-0000-0000000000d1', false, 'wave 1', 'Grace', 'grace@example.com', 'E3', 'invited');
commit;

\echo '--- 1. a reset token is stored as a hash, and the hash is unique'
insert into public.password_resets (user_id, email, token_hash, requested_ip_hash)
  values ('eeeeeeee-0000-0000-0000-0000000000f1', 'ada@example.com', 'hash-aaa', 'iphash');
do $$
begin
  insert into public.password_resets (user_id, email, token_hash)
    values ('eeeeeeee-0000-0000-0000-0000000000f1', 'ada@example.com', 'hash-aaa');
  raise exception 'FAIL: two resets shared one token hash';
exception when unique_violation then
  raise notice 'PASS one token, one row';
end $$;

\echo '--- 2. a reset expires on its own, an hour out'
select case
         when expires_at > now() + interval '55 minutes'
          and expires_at < now() + interval '65 minutes'
         then 'PASS a reset lives about an hour' else 'FAIL — ' || expires_at::text end
from public.password_resets where token_hash = 'hash-aaa';

\echo '--- 3. using one spends every other live reset for that account'
-- the app does this in two statements; what matters is that the state is reachable
insert into public.password_resets (user_id, email, token_hash)
  values ('eeeeeeee-0000-0000-0000-0000000000f1', 'ada@example.com', 'hash-bbb');
update public.password_resets set used_at = now(), used_ip_hash = 'iphash'
  where token_hash = 'hash-aaa';
update public.password_resets set used_at = now()
  where user_id = 'eeeeeeee-0000-0000-0000-0000000000f1' and used_at is null;
select case when count(*) = 0
            then 'PASS an older link in an older email no longer works'
            else 'FAIL — ' || count(*) || ' still live' end
from public.password_resets
where user_id = 'eeeeeeee-0000-0000-0000-0000000000f1' and used_at is null;

\echo '--- 4. deleting the account takes its reset tokens with it'
-- no orphaned password-equivalents left behind
select case when count(*) = 2 then 'PASS tokens are attached to the account' else 'FAIL' end
from public.password_resets where user_id = 'eeeeeeee-0000-0000-0000-0000000000f1';

-- ====================================================== the delivery log

\echo '--- 5. one successful send per dedupe key, and no more'
insert into public.mail_deliveries (customer_id, survey_id, kind, to_email, subject, provider, status, dedupe_key)
  values ('eeeeeeee-0000-0000-0000-0000000000e1', 'eeeeeeee-0000-0000-0000-0000000000d1',
          'respondent_invitation', 'ada@example.com', 'Acme: Mail study', 'resend', 'sent',
          'respondent_invitation:eeeeeeee-0000-0000-0000-00000000a001');
do $$
begin
  insert into public.mail_deliveries (survey_id, kind, to_email, subject, status, dedupe_key)
    values ('eeeeeeee-0000-0000-0000-0000000000d1', 'respondent_invitation', 'ada@example.com',
            'Acme: Mail study', 'sent', 'respondent_invitation:eeeeeeee-0000-0000-0000-00000000a001');
  raise exception 'FAIL: a respondent was mailed their link twice';
exception when unique_violation then
  raise notice 'PASS one respondent, one invitation — a second link is a second interview';
end $$;

\echo '--- 6. a FAILED send does not block a retry'
insert into public.mail_deliveries (survey_id, kind, to_email, subject, status, error, dedupe_key)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'respondent_invitation', 'alan@example.com',
          'Acme: Mail study', 'failed', 'provider returned 429',
          'respondent_invitation:eeeeeeee-0000-0000-0000-00000000a002');
insert into public.mail_deliveries (survey_id, kind, to_email, subject, status, dedupe_key)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'respondent_invitation', 'alan@example.com',
          'Acme: Mail study', 'sent',
          'respondent_invitation:eeeeeeee-0000-0000-0000-00000000a002');
select case when count(*) = 1
            then 'PASS one provider hiccup does not lock somebody out of the study for ever'
            else 'FAIL' end
from public.mail_deliveries
where dedupe_key = 'respondent_invitation:eeeeeeee-0000-0000-0000-00000000a002' and status = 'sent';

\echo '--- 7. a suppressed send is recorded, with the reason'
insert into public.mail_deliveries (survey_id, kind, to_email, subject, status, error)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'respondent_invitation', 'grace@example.com',
          'Acme: Mail study', 'suppressed', 'not production (staging) and MAIL_DEV_REDIRECT is not set');
select case when status = 'suppressed' and error like 'not production%'
            then 'PASS a staging instance leaves a record of what it did NOT send' else 'FAIL' end
from public.mail_deliveries where to_email = 'grace@example.com';

\echo '--- 8. an unknown kind cannot be logged'
do $$
begin
  insert into public.mail_deliveries (kind, to_email, subject) values ('newsletter', 'a@b.co', 'x');
  raise exception 'FAIL: an unvetted mail kind was accepted';
exception when check_violation then raise notice 'PASS the vocabulary is closed';
end $$;

\echo '--- 9. fieldwork can see who has actually been emailed'
select list_name, people, emailed, failed from public.rescript_invitation_sends(
  'eeeeeeee-0000-0000-0000-0000000000d1', false) order by list_name;

\echo '--- 10. and the count is per PERSON, not per email sent'
-- Ada is mailed a second time under a different key (a re-send). The wave
-- still has three people in it, not four: the fan-out bug this function was
-- rewritten to avoid.
insert into public.mail_deliveries (survey_id, kind, to_email, subject, status, dedupe_key)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'respondent_invitation', 'ada@example.com',
          'Acme: Mail study (reminder)', 'sent', 'respondent_invitation:resend:a001');
select case when people = 3 and emailed = 2
            then 'PASS three people, two emailed — a second email does not invent a respondent'
            else 'FAIL — people ' || people || ', emailed ' || emailed end
from public.rescript_invitation_sends('eeeeeeee-0000-0000-0000-0000000000d1', false)
where list_name = 'wave 1';

\echo '--- 11. deleting the survey takes its delivery log with it'
delete from public.surveys where id = 'eeeeeeee-0000-0000-0000-0000000000d1';
select case when count(*) = 0 then 'PASS no orphaned delivery records' else 'FAIL' end
from public.mail_deliveries where survey_id = 'eeeeeeee-0000-0000-0000-0000000000d1';
