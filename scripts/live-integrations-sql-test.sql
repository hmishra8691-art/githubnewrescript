-- LIVE INTEGRATIONS (migration 0086).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f scripts/live-integrations-sql-test.sql
--
-- One transaction, rolled back. What is tested is mostly a set of REFUSALS: the places where receiving an
-- event, or judging a vendor's health, declines to assume something it has not been told.

begin;

\set cust  '''e0000000-0000-0000-0000-0000000000e1'''
\set usr   '''e00000e1-0000-0000-0000-000000000001'''
\set srv   '''e0000000-0000-0000-0000-0000000001e1'''
\set vend  '''e0000000-0000-0000-0000-0000000002e1'''
\set integ '''e0000000-0000-0000-0000-0000000003e1'''

insert into auth.users (id, email) values (:usr, 'live-int@example.test');
insert into public.customers (id, slug, name) values (:cust, 'live-int', 'Live integrations');
insert into public.profiles (id, customer_id, email, full_name, role)
  values (:usr, :cust, 'live-int@example.test', 'Ops', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values (:srv, :cust, 'LIVEI', 'Live integrations', :usr);
insert into public.panel_vendors (id, name, slug, customer_id, status)
  values (:vend, 'Prolific test', 'prolific-test-li', :cust, 'catalogue');
insert into public.vendor_integrations (id, customer_id, vendor_id, mode, enabled)
  values (:integ, :cust, :vend, 'manual', true);

/* ============================================================ 1. the same event twice is counted once */

do $$
declare a record; b record;
begin
  select * into a from public.rescript_webhook_receive(
    'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
    'prolific', 'evt_same', 'verified', null, '{"n":1}'::jsonb, 'stu_1', 'p1', now());
  select * into b from public.rescript_webhook_receive(
    'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
    'prolific', 'evt_same', 'verified', null, '{"n":1}'::jsonb, 'stu_1', 'p1', now());

  if not a.is_new then raise exception 'the first delivery was not treated as new'; end if;
  if b.is_new then raise exception 'a RETRIED event was treated as new — this is how a complete gets paid twice'; end if;
  if a.receipt_id <> b.receipt_id then raise exception 'the retry got its own receipt instead of the original'; end if;
  if (select count(*) from public.vendor_webhook_receipts where event_id = 'evt_same') <> 1 then
    raise exception 'two receipts exist for one event';
  end if;
  raise notice 'PASS 1  a retried event returns the ORIGINAL receipt and is not new';
end $$;

/* ============================================================ 2. an unverified delivery is kept, not dropped */

do $$
declare v record;
begin
  select * into v from public.rescript_webhook_receive(
    'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
    'prolific', 'evt_forged', 'bad_signature', 'signature does not match', '{"amount":999999}'::jsonb, null, null, null);

  if v.processing <> 'quarantined' then
    raise exception 'an unverified event was queued for processing as %', v.processing;
  end if;
  if (select count(*) from public.vendor_webhook_receipts where event_id = 'evt_forged') <> 1 then
    raise exception 'the forged delivery was discarded — a rising count of these is somebody probing the endpoint';
  end if;
  if (select raw_body->>'amount' from public.vendor_webhook_receipts where event_id = 'evt_forged') <> '999999' then
    raise exception 'the raw body was not kept, so a dispute about what arrived cannot be settled';
  end if;
  raise notice 'PASS 2  a forged delivery is stored, quarantined, and kept whole';
end $$;

/* ============================================================ 3. the first verdict wins on a retry */

do $$
declare v record;
begin
  -- the same event id arriving later with a DIFFERENT verdict must not overwrite the original judgement
  select * into v from public.rescript_webhook_receive(
    'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
    'prolific', 'evt_same', 'bad_signature', 'tampered replay', '{"n":999}'::jsonb, null, null, null);

  if v.is_new then raise exception 'a replay with a new verdict was accepted as a new event'; end if;
  if (select verdict from public.vendor_webhook_receipts where event_id = 'evt_same') <> 'verified' then
    raise exception 'a later delivery overwrote the original verdict';
  end if;
  if (select raw_body->>'n' from public.vendor_webhook_receipts where event_id = 'evt_same') <> '1' then
    raise exception 'a replay overwrote the body of the event that was actually acted on';
  end if;
  raise notice 'PASS 3  a replay cannot overwrite the verdict or body of the event already received';
end $$;

/* ============================================================ 4. deliveries with no event id do not collide */

do $$
declare a record; b record;
begin
  select * into a from public.rescript_webhook_receive(
    'e0000000-0000-0000-0000-0000000000e1', null, 'prolific', null, 'malformed', 'no event id', '{"x":1}'::jsonb, null, null, null);
  select * into b from public.rescript_webhook_receive(
    'e0000000-0000-0000-0000-0000000000e1', null, 'prolific', null, 'malformed', 'no event id', '{"x":2}'::jsonb, null, null, null);

  if a.receipt_id = b.receipt_id then raise exception 'two unidentifiable deliveries collapsed into one row'; end if;
  if a.is_new or b.is_new then raise exception 'an event with no id cannot be new work — there is nothing to de-duplicate on'; end if;
  if (select count(*) from public.vendor_webhook_receipts where event_id is null) <> 2 then
    raise exception 'an unidentifiable delivery was lost — exactly the case that most needs a record';
  end if;
  raise notice 'PASS 4  deliveries with no event id are each kept, and none is treated as actionable';
end $$;

/* ============================================================ 5. health is observed, not declared */

do $$
declare v_rows integer; v_health text;
begin
  insert into public.vendor_api_calls (customer_id, integration_id, operation, method, path, status, ok, elapsed_ms)
  select 'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
         'feasibility', 'POST', '/eligibility-count/', 200, true, 120
    from generate_series(1, 19);
  insert into public.vendor_api_calls (customer_id, integration_id, operation, method, path, status, ok, elapsed_ms)
  values ('e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
          'feasibility', 'POST', '/eligibility-count/', 500, false, 20000);

  select public.rescript_vendor_health_recompute('e0000000-0000-0000-0000-0000000000e1', 60) into v_rows;
  if v_rows <> 1 then raise exception 'expected 1 integration scored, got %', v_rows; end if;

  select health into v_health from public.vendor_integrations where id = 'e0000000-0000-0000-0000-0000000003e1';
  if v_health <> 'ok' then raise exception '19 of 20 succeeding should be ok, got %', v_health; end if;
  raise notice 'PASS 5  95%% success reads as ok, computed from the call log';
end $$;

/* ============================================================ 6. a failing vendor is called failing */

do $$
declare v_health text;
begin
  insert into public.vendor_api_calls (customer_id, integration_id, operation, method, path, status, ok, elapsed_ms)
  select 'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000003e1',
         'feasibility', 'POST', '/eligibility-count/', 503, false, 20000
    from generate_series(1, 60);

  perform public.rescript_vendor_health_recompute('e0000000-0000-0000-0000-0000000000e1', 60);
  select health into v_health from public.vendor_integrations where id = 'e0000000-0000-0000-0000-0000000003e1';
  if v_health <> 'failing' then raise exception 'a mostly-failing vendor reads as %', v_health; end if;
  raise notice 'PASS 6  a vendor failing most calls is reported failing, not degraded';
end $$;

/* ============================================================ 7. a vendor nobody called is not healthy */

do $$
declare v_integ uuid := 'e0000000-0000-0000-0000-0000000004e1'; v_health text;
begin
  insert into public.panel_vendors (id, name, slug, customer_id, status)
    values ('e0000000-0000-0000-0000-0000000005e1', 'Untouched', 'untouched-li', 'e0000000-0000-0000-0000-0000000000e1', 'catalogue');
  insert into public.vendor_integrations (id, customer_id, vendor_id, mode, enabled)
    values (v_integ, 'e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000005e1', 'manual', true);

  perform public.rescript_vendor_health_recompute('e0000000-0000-0000-0000-0000000000e1', 60);
  select health into v_health from public.vendor_integrations where id = v_integ;
  if v_health <> 'unknown' then
    raise exception 'a vendor nobody has called was marked % — unknown is not the same as healthy', v_health;
  end if;
  raise notice 'PASS 7  an uncalled vendor stays unknown, never healthy by default';
end $$;

/* ============================================================ 8. the path carries no query string */

do $$
begin
  if exists (select 1 from public.vendor_api_calls where path like '%?%') then
    raise exception 'a stored path carries a query string, which can carry a participant id';
  end if;
  raise notice 'PASS 8  no stored call path carries a query string';
end $$;

rollback;
