-- RESPONDENT PORTAL, NOTIFICATIONS AND MESSAGES (migration 0106, phase 6 2026-11-20):
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/portal-notify-sql-test.sql
-- Proves on real Postgres 16: a notice happens once per (account, dedupe); only the four kinds; a message has a
-- body and only a staff message names a staff member; deleting the account removes both; row-level security on,
-- no policy; the mail kind exists; 0106 is recorded. One transaction, rolled back.

begin;
insert into public.portal_accounts (id, respondent_id, status) values ('c0000000-0000-0000-0000-0000000106a1', 'RSP-N0T1F001', 'active');

insert into public.portal_notifications (account_id, kind, title, dedupe) values ('c0000000-0000-0000-0000-0000000106a1', 'due', 'Your check-in is due', 'due:e1:2026-11-20');
insert into public.portal_notifications (account_id, kind, title, dedupe) values ('c0000000-0000-0000-0000-0000000106a1', 'due', 'Your check-in is due', 'due:e1:2026-11-20') on conflict (account_id, dedupe) do nothing;
do $$ begin
  if (select count(*) from public.portal_notifications where account_id = 'c0000000-0000-0000-0000-0000000106a1') <> 1 then raise exception 'FAIL: the same notice was stored twice'; end if;
  begin insert into public.portal_notifications (account_id, kind, title, dedupe) values ('c0000000-0000-0000-0000-0000000106a1', 'advert', 'Buy now', 'x'); raise exception 'FAIL: an unknown kind was stored';
  exception when check_violation then null; end;
  begin insert into public.portal_notifications (account_id, kind, title, dedupe) values ('c0000000-0000-0000-0000-0000000106a1', 'due', '', 'y'); raise exception 'FAIL: an empty title was stored';
  exception when check_violation then null; end;
end $$;

insert into public.portal_messages (account_id, survey_id, enrolment_id, body) values ('c0000000-0000-0000-0000-0000000106a1', gen_random_uuid(), gen_random_uuid(), 'When is the next one?');
insert into public.portal_messages (account_id, survey_id, enrolment_id, from_staff, staff_user_id, body) values ('c0000000-0000-0000-0000-0000000106a1', gen_random_uuid(), gen_random_uuid(), true, gen_random_uuid(), 'On Monday.');
do $$ begin
  begin insert into public.portal_messages (account_id, survey_id, enrolment_id, body) values ('c0000000-0000-0000-0000-0000000106a1', gen_random_uuid(), gen_random_uuid(), ''); raise exception 'FAIL: an empty message was stored';
  exception when check_violation then null; end;
  begin insert into public.portal_messages (account_id, survey_id, enrolment_id, staff_user_id, body) values ('c0000000-0000-0000-0000-0000000106a1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x'); raise exception 'FAIL: a respondent''s message named a staff member';
  exception when check_violation then null; end;
  begin insert into public.portal_messages (account_id, survey_id, enrolment_id, body) values ('c0000000-0000-0000-0000-0000000106a1', gen_random_uuid(), gen_random_uuid(), repeat('x', 4001)); raise exception 'FAIL: an over-long message was stored';
  exception when check_violation then null; end;
end $$;

delete from public.portal_accounts where id = 'c0000000-0000-0000-0000-0000000106a1';
do $$ declare t text; begin
  if exists (select 1 from public.portal_notifications where account_id = 'c0000000-0000-0000-0000-0000000106a1') or exists (select 1 from public.portal_messages where account_id = 'c0000000-0000-0000-0000-0000000106a1') then raise exception 'FAIL: deleting an account left its notices or messages'; end if;
  foreach t in array array['portal_notifications', 'portal_messages'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAIL: % has no row-level security', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then raise exception 'FAIL: % has a policy', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then raise exception 'FAIL: % is readable by anon or authenticated', t; end if;
  end loop;
  if not (select pg_get_constraintdef(c.oid) like '%portal_notice%' from pg_constraint c where c.conname = 'mail_deliveries_kind_check') then raise exception 'FAIL: the mail kind portal_notice is missing'; end if;
  if not (select pg_get_constraintdef(c.oid) like '%portal_reset%' from pg_constraint c where c.conname = 'mail_deliveries_kind_check') then raise exception 'FAIL: an earlier mail kind was lost'; end if;
  if not exists (select 1 from public.schema_marks where migration = '0106') then raise exception 'FAIL: 0106 is not recorded'; end if;
end $$;
select 'portal notify sql test: all checks passed' as result;
rollback;
