-- RESPONDENT PORTAL, CONSENT AND REQUESTS (migration 0105, phase 5 2026-11-20) — against a database with every migration:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/portal-privacy-sql-test.sql
--
-- Proves, on real Postgres 16:
--   1. one consent row per (account, version); withdrawing keeps the row
--   2. a request: only the three kinds and three states; open ⇔ not resolved; lengths enforced
--   3. deleting the account removes its consents and requests
--   4. row-level security: on, no policy, nothing readable by anon or authenticated
-- One transaction, rolled back — safe to run twice.

begin;

insert into public.portal_accounts (id, respondent_id, status) values ('c0000000-0000-0000-0000-0000000105a1', 'RSP-PR1V0001', 'active');

-- 1 ---------------------------------------------------------------------------------------------------------------
insert into public.portal_consents (account_id, version) values ('c0000000-0000-0000-0000-0000000105a1', '2026-11-20');
do $$ begin
  begin insert into public.portal_consents (account_id, version) values ('c0000000-0000-0000-0000-0000000105a1', '2026-11-20'); raise exception 'FAIL: the same version was agreed to twice';
  exception when unique_violation then null; end;
  begin insert into public.portal_consents (account_id, version) values ('c0000000-0000-0000-0000-0000000105a1', ''); raise exception 'FAIL: an empty version was stored';
  exception when check_violation then null; end;
end $$;
insert into public.portal_consents (account_id, version) values ('c0000000-0000-0000-0000-0000000105a1', '2027-01-01');
update public.portal_consents set withdrawn_at = now() where account_id = 'c0000000-0000-0000-0000-0000000105a1' and version = '2026-11-20';
do $$ begin
  if (select count(*) from public.portal_consents where account_id = 'c0000000-0000-0000-0000-0000000105a1') <> 2 then raise exception 'FAIL: withdrawing did not keep the record'; end if;
end $$;

-- 2 ---------------------------------------------------------------------------------------------------------------
insert into public.portal_requests (id, account_id, survey_id, enrolment_id, kind, message) values
  ('c0000000-0000-0000-0000-0000000105b1', 'c0000000-0000-0000-0000-0000000105a1', gen_random_uuid(), gen_random_uuid(), 'correction', 'My year of birth is wrong.');
do $$ begin
  if (select status from public.portal_requests where id = 'c0000000-0000-0000-0000-0000000105b1') <> 'open' then raise exception 'FAIL: a new request is not open'; end if;
  begin insert into public.portal_requests (account_id, survey_id, enrolment_id, kind) values ('c0000000-0000-0000-0000-0000000105a1', gen_random_uuid(), gen_random_uuid(), 'export_everything'); raise exception 'FAIL: an unknown kind was stored';
  exception when check_violation then null; end;
  begin update public.portal_requests set status = 'done' where id = 'c0000000-0000-0000-0000-0000000105b1'; raise exception 'FAIL: a request was closed with no time of closing';
  exception when check_violation then null; end;
  begin update public.portal_requests set resolved_at = now() where id = 'c0000000-0000-0000-0000-0000000105b1'; raise exception 'FAIL: an open request has a time of closing';
  exception when check_violation then null; end;
  begin update public.portal_requests set status = 'ignored', resolved_at = now() where id = 'c0000000-0000-0000-0000-0000000105b1'; raise exception 'FAIL: an unknown state was stored';
  exception when check_violation then null; end;
  begin update public.portal_requests set message = repeat('x', 2001) where id = 'c0000000-0000-0000-0000-0000000105b1'; raise exception 'FAIL: an over-long message was stored';
  exception when check_violation then null; end;
end $$;
update public.portal_requests set status = 'done', resolved_at = now(), response_note = 'Corrected.' where id = 'c0000000-0000-0000-0000-0000000105b1';

-- 3 ---------------------------------------------------------------------------------------------------------------
delete from public.portal_accounts where id = 'c0000000-0000-0000-0000-0000000105a1';
do $$ begin
  if exists (select 1 from public.portal_consents where account_id = 'c0000000-0000-0000-0000-0000000105a1') or exists (select 1 from public.portal_requests where account_id = 'c0000000-0000-0000-0000-0000000105a1') then
    raise exception 'FAIL: deleting an account left its consents or requests';
  end if;
end $$;

-- 4 ---------------------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['portal_consents', 'portal_requests'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAIL: % has no row-level security', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then raise exception 'FAIL: % has a policy — it is service-role only', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then raise exception 'FAIL: % is readable by anon or authenticated', t; end if;
  end loop;
  if not exists (select 1 from public.schema_marks where migration = '0105') then raise exception 'FAIL: 0105 is not recorded'; end if;
end $$;

select 'portal privacy sql test: all checks passed' as result;
rollback;
