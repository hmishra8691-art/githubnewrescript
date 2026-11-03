-- RECRUITMENT EXCHANGE SQL TEST (migration 0081) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/recruitment-sql-test.sql
--
-- Proves, on real Postgres:
--   1. ten tables with RLS on, SELECT-only policies, the sealed credentials ungranted, both functions service-role only
--   2. shapes: an `api` integration cannot exist without credentials; markup, pricing bands, slugs, accepted-vs-delivered
--      and one-integration-per-vendor are checked; the event idempotency key is unique
--   3. rescript_recruitment_allocate: the approved budget and the required completes are ceilings the DATABASE
--      enforces, a revision is replaced rather than duplicated, and a refused allocation writes nothing
--   4. rescript_recruitment_order_apply: the same idempotency key applies once, counts are absolute rather than
--      cumulative, spend follows accepted × agreed CPI unless the vendor stated an amount
--   5. the RLS backstop: an organisation's members read their own vendors and orders and never the credentials;
--      a client, a profile-less user and another organisation read nothing; members cannot write
--   6. deleting the survey removes its recruitment project, allocations, orders and events
--
-- One transaction, rolled back. (Supabase grants table privileges to `authenticated` by default; a bare Postgres
-- shim does not, so the test grants the same lists inside the transaction.)

begin;

/* ------------------------------------------------------------ fixtures */

insert into public.customers (id, slug, name) values
  ('c0000000-0000-0000-0000-000000000081', 'rx81', 'Recruitment exchange 0081'),
  ('c0000000-0000-0000-0000-000000000082', 'other81', 'Another organisation')
on conflict do nothing;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000081-0000-0000-0000-000000000001', 'owner@r81.test',    '{"full_name":"Owner"}'::jsonb),
  ('c0000081-0000-0000-0000-000000000002', 'client@r81.test',   '{"full_name":"Client"}'::jsonb),
  ('c0000081-0000-0000-0000-000000000003', 'nobody@r81.test',   '{"full_name":"No profile"}'::jsonb),
  ('c0000081-0000-0000-0000-000000000004', 'stranger@r81.test', '{"full_name":"Stranger"}'::jsonb)
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role)
values
  ('c0000081-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000081', 'owner@r81.test', 'Owner', 'programmer'),
  ('c0000081-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000081', 'client@r81.test', 'Client', 'client'),
  ('c0000081-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000082', 'stranger@r81.test', 'Stranger', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;

insert into public.surveys (id, customer_id, code, title, owner_id)
values ('c0000000-0000-0000-0000-000000000181', 'c0000000-0000-0000-0000-000000000081', 'R81', 'Recruitment project', 'c0000081-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

-- the organisation's own vendor, plus an integration with a catalogue vendor
insert into public.panel_vendors (id, customer_id, slug, name)
values ('c0000081-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000081', 'regional-x', 'Regional X')
on conflict do nothing;

insert into public.vendor_integrations (id, customer_id, vendor_id, mode, markup_bps, currency)
select 'c0000081-0000-0000-0000-00000000001a', 'c0000000-0000-0000-0000-000000000081', v.id, 'manual', 1000, 'USD'
  from public.panel_vendors v where v.customer_id is null and v.slug = 'cint'
on conflict do nothing;

insert into public.vendor_integrations (id, customer_id, vendor_id, mode, currency)
values ('c0000081-0000-0000-0000-00000000001b', 'c0000000-0000-0000-0000-000000000081', 'c0000081-0000-0000-0000-00000000000a', 'manual', 'USD')
on conflict do nothing;

insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_currency, loi_minutes, expected_ir, strategy)
values ('c0000081-0000-0000-0000-00000000002a', 'c0000000-0000-0000-0000-000000000081', 'c0000000-0000-0000-0000-000000000181',
        5000, 40000.00, 'USD', 15, 30.00, 'balanced')
on conflict do nothing;

/* ------------------------------------------------------------ 1. structure */

do $$
declare n int; bad text;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relrowsecurity and c.relname in
      ('panel_vendors','vendor_integrations','vendor_capabilities','vendor_pricing','vendor_quotations',
       'audience_specifications','recruitment_projects','sample_allocations','recruitment_orders','recruitment_events');
  if n <> 10 then raise exception '1: expected 10 tables with RLS, found %', n; end if;

  -- every policy on these tables is read-only: writing is the service role's, behind routes that check access
  select string_agg(policyname || '=' || cmd, ', ') into bad from pg_policies
    where schemaname = 'public' and cmd <> 'SELECT' and tablename in
      ('panel_vendors','vendor_integrations','vendor_capabilities','vendor_pricing','vendor_quotations',
       'audience_specifications','recruitment_projects','sample_allocations','recruitment_orders','recruitment_events');
  if bad is not null then raise exception '1: non-SELECT policy present: %', bad; end if;

  -- the sealed credentials are not in the column grant, so a member cannot read them even through a policy
  if exists (select 1 from information_schema.column_privileges
             where table_schema = 'public' and table_name = 'vendor_integrations'
               and grantee = 'authenticated' and column_name in ('credentials_sealed','credentials_key_id')) then
    raise exception '1: credentials are granted to authenticated';
  end if;
  if not exists (select 1 from information_schema.column_privileges
             where table_schema = 'public' and table_name = 'vendor_integrations'
               and grantee = 'authenticated' and column_name = 'mode') then
    raise exception '1: members cannot read an integration at all';
  end if;

  if has_function_privilege('authenticated', 'public.rescript_recruitment_allocate(uuid, integer, jsonb, uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.rescript_recruitment_order_apply(uuid, text, integer, integer, integer, integer, numeric, text, text)', 'execute') then
    raise exception '1: a signed-in user can call a service-role function';
  end if;

  raise notice 'PASS 1 ten tables, RLS, read-only policies, credentials ungranted, service-role functions';
end $$;

/* ------------------------------------------------------------ 2. shapes */

do $$
declare ok boolean;
begin
  -- an `api` integration with no credentials is a lie the marketplace would tell
  begin
    insert into public.vendor_integrations (customer_id, vendor_id, mode)
      values ('c0000000-0000-0000-0000-000000000081', 'c0000081-0000-0000-0000-00000000000a', 'api');
    raise exception '2: an api integration was accepted without credentials';
  exception when check_violation then null; end;

  begin
    update public.vendor_integrations set markup_bps = 20000 where id = 'c0000081-0000-0000-0000-00000000001a';
    raise exception '2: a 200%% markup was accepted';
  exception when check_violation then null; end;

  -- an inverted band would make the half-open lookup match nothing, silently
  begin
    insert into public.vendor_pricing (integration_id, market, ir_min, ir_max, loi_min, loi_max, cpi, source)
      values ('c0000081-0000-0000-0000-00000000001a', 'US', 40, 20, 0, 60, 8, 'vendor_reported');
    raise exception '2: an inverted incidence band was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.panel_vendors (customer_id, slug, name)
      values ('c0000000-0000-0000-0000-000000000081', 'Not A Slug', 'x');
    raise exception '2: a malformed slug was accepted';
  exception when check_violation then null; end;

  -- one relationship per organisation and vendor: two rows would give two rate cards and no way to choose
  begin
    insert into public.vendor_integrations (customer_id, vendor_id, mode)
      values ('c0000000-0000-0000-0000-000000000081', 'c0000081-0000-0000-0000-00000000000a', 'manual');
    raise exception '2: a second integration with the same vendor was accepted';
  exception when unique_violation then null; end;

  insert into public.recruitment_orders (id, recruitment_project_id, integration_id, ordered_completes, agreed_cpi)
    values ('c0000081-0000-0000-0000-00000000003a', 'c0000081-0000-0000-0000-00000000002a', 'c0000081-0000-0000-0000-00000000001a', 1500, 8.00);
  begin
    update public.recruitment_orders set delivered_completes = 10, accepted_completes = 11
      where id = 'c0000081-0000-0000-0000-00000000003a';
    raise exception '2: more completes were accepted than were delivered';
  exception when check_violation then null; end;

  insert into public.recruitment_events (recruitment_project_id, type, idempotency_key)
    values ('c0000081-0000-0000-0000-00000000002a', 'RecruitmentRequested', 'r81:requested');
  begin
    insert into public.recruitment_events (recruitment_project_id, type, idempotency_key)
      values ('c0000081-0000-0000-0000-00000000002a', 'RecruitmentRequested', 'r81:requested');
    raise exception '2: an event was recorded twice under one idempotency key';
  exception when unique_violation then null; end;

  raise notice 'PASS 2 shapes: api needs credentials, markup / bands / slugs checked, one integration per vendor, events idempotent';
end $$;

/* ------------------------------------------------------------ 3. allocation */

do $$
declare r record; n int;
begin
  -- 1,500 at $8.00 + 3,500 at $6.50 = $34,750 against a $40,000 budget, for exactly the 5,000 required
  select * into r from public.rescript_recruitment_allocate(
    'c0000081-0000-0000-0000-00000000002a', 0,
    '[{"integration_id":"c0000081-0000-0000-0000-00000000001a","allocated_completes":1500,"cpi":8.00},
      {"integration_id":"c0000081-0000-0000-0000-00000000001b","allocated_completes":3500,"cpi":6.50}]'::jsonb,
    'c0000081-0000-0000-0000-000000000001');
  if r.vendors <> 2 or r.total_completes <> 5000 or r.total_cost <> 34750 then
    raise exception '3: allocation returned % vendors, % completes, % cost', r.vendors, r.total_completes, r.total_cost;
  end if;

  -- the approved budget is a ceiling the database enforces, not a warning the UI shows
  begin
    perform public.rescript_recruitment_allocate('c0000081-0000-0000-0000-00000000002a', 1,
      '[{"integration_id":"c0000081-0000-0000-0000-00000000001a","allocated_completes":5000,"cpi":9.00}]'::jsonb, null);
    raise exception '3: a $45,000 allocation was accepted against a $40,000 budget';
  exception when check_violation then null; end;

  begin
    perform public.rescript_recruitment_allocate('c0000081-0000-0000-0000-00000000002a', 1,
      '[{"integration_id":"c0000081-0000-0000-0000-00000000001a","allocated_completes":6000,"cpi":1.00}]'::jsonb, null);
    raise exception '3: 6,000 completes were allocated against a requirement of 5,000';
  exception when check_violation then null; end;

  -- a refused allocation writes nothing: revision 1 must not exist
  select count(*) into n from public.sample_allocations
    where recruitment_project_id = 'c0000081-0000-0000-0000-00000000002a' and revision = 1;
  if n <> 0 then raise exception '3: a refused allocation left % rows behind', n; end if;

  -- re-running a revision replaces it rather than doubling it
  select * into r from public.rescript_recruitment_allocate(
    'c0000081-0000-0000-0000-00000000002a', 0,
    '[{"integration_id":"c0000081-0000-0000-0000-00000000001a","allocated_completes":2000,"cpi":8.00}]'::jsonb, null);
  select count(*) into n from public.sample_allocations
    where recruitment_project_id = 'c0000081-0000-0000-0000-00000000002a' and revision = 0;
  if n <> 1 then raise exception '3: re-running revision 0 left % rows', n; end if;

  -- and a new revision sits beside the old one, so what was authorised stays readable
  perform public.rescript_recruitment_allocate('c0000081-0000-0000-0000-00000000002a', 1,
    '[{"integration_id":"c0000081-0000-0000-0000-00000000001b","allocated_completes":3000,"cpi":6.50}]'::jsonb, null);
  select count(distinct revision) into n from public.sample_allocations
    where recruitment_project_id = 'c0000081-0000-0000-0000-00000000002a';
  if n <> 2 then raise exception '3: expected two revisions, found %', n; end if;

  raise notice 'PASS 3 allocation: budget and required completes are database ceilings, revisions replace and accumulate';
end $$;

/* ------------------------------------------------------------ 4. order progress */

do $$
declare r record; o record;
begin
  -- 400 delivered, 380 accepted at the agreed $8.00 → $3,040
  select * into r from public.rescript_recruitment_order_apply(
    'c0000081-0000-0000-0000-00000000003a', 'cint:sync:1', 400, 380, 20, 5, null, 'live', 'CINT-77');
  if not r.applied or r.accepted <> 380 or r.spend <> 3040 then
    raise exception '4: first apply gave applied=%, accepted=%, spend=%', r.applied, r.accepted, r.spend;
  end if;

  -- the same callback again — a webhook retry — changes nothing
  select * into r from public.rescript_recruitment_order_apply(
    'c0000081-0000-0000-0000-00000000003a', 'cint:sync:1', 9999, 9999, 0, 0, null, 'complete', null);
  if r.applied then raise exception '4: a replayed idempotency key was applied'; end if;
  select * into o from public.recruitment_orders where id = 'c0000081-0000-0000-0000-00000000003a';
  if o.accepted_completes <> 380 or o.spend_amount <> 3040 or o.status <> 'live' then
    raise exception '4: a replay changed the order: accepted=%, spend=%, status=%', o.accepted_completes, o.spend_amount, o.status;
  end if;

  -- counts are ABSOLUTE: 500/475 replaces 400/380 rather than adding to it
  select * into r from public.rescript_recruitment_order_apply(
    'c0000081-0000-0000-0000-00000000003a', 'cint:sync:2', 500, 475, 25, 7, null, 'complete', null);
  select * into o from public.recruitment_orders where id = 'c0000081-0000-0000-0000-00000000003a';
  if o.delivered_completes <> 500 or o.accepted_completes <> 475 then
    raise exception '4: counts accumulated instead of replacing: %/%', o.delivered_completes, o.accepted_completes;
  end if;
  if o.spend_amount <> 3800 then raise exception '4: spend was % not 3800', o.spend_amount; end if;
  if o.vendor_order_ref <> 'CINT-77' then raise exception '4: the vendor reference was lost'; end if;

  -- a vendor that states the amount owed overrides the computed one
  select * into r from public.rescript_recruitment_order_apply(
    'c0000081-0000-0000-0000-00000000003a', 'cint:sync:3', 500, 475, 25, 7, 3612.50, 'complete', null);
  if r.spend <> 3612.50 then raise exception '4: the vendor''s stated amount was ignored (%)', r.spend; end if;

  -- every applied sync left exactly one event, and the replay left none
  if (select count(*) from public.recruitment_events
      where order_id = 'c0000081-0000-0000-0000-00000000003a' and type = 'RecruitmentProgressApplied') <> 3 then
    raise exception '4: the progress events do not match the applied syncs';
  end if;

  raise notice 'PASS 4 order progress: applied once per key, counts absolute, spend computed or stated';
end $$;

/* ------------------------------------------------------------ 5. the RLS backstop */

-- Supabase grants these to `authenticated` by default; a bare shim does not, so grant the same lists here
grant select on public.panel_vendors, public.vendor_capabilities, public.vendor_pricing, public.vendor_quotations,
  public.audience_specifications, public.recruitment_projects, public.sample_allocations,
  public.recruitment_orders, public.recruitment_events to authenticated;
grant select (id, customer_id, vendor_id, mode, hint, health, last_contact_at, last_error, markup_bps, currency,
  notes, enabled, created_by, created_at, updated_at) on public.vendor_integrations to authenticated;

do $$
declare n int;
begin
  -- the organisation's own programmer
  perform set_config('request.jwt.claim.sub', 'c0000081-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', json_build_object('sub', 'c0000081-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.vendor_integrations;
  if n < 2 then raise exception '5: a member reads % of its own integrations', n; end if;
  select count(*) into n from public.recruitment_orders;
  if n <> 1 then raise exception '5: a member reads % orders', n; end if;
  -- the catalogue is readable by everyone signed in; the organisation's own vendor as well
  select count(*) into n from public.panel_vendors;
  if n < 11 then raise exception '5: a member reads % vendors (10 catalogue + its own)', n; end if;

  begin
    perform credentials_sealed from public.vendor_integrations limit 1;
    raise exception '5: a member read the sealed credentials';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.recruitment_orders (recruitment_project_id, integration_id, ordered_completes, agreed_cpi)
      values ('c0000081-0000-0000-0000-00000000002a', 'c0000081-0000-0000-0000-00000000001a', 10, 1);
    raise exception '5: a member wrote an order';
  exception when insufficient_privilege then null; end;

  reset role;

  -- a client of the same organisation: commercial terms are not theirs to see
  perform set_config('request.jwt.claim.sub', 'c0000081-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select count(*) into n from public.vendor_integrations;
  if n <> 0 then raise exception '5: a client read % integrations', n; end if;
  select count(*) into n from public.recruitment_orders;
  if n <> 0 then raise exception '5: a client read % orders', n; end if;
  reset role;

  -- another organisation
  perform set_config('request.jwt.claim.sub', 'c0000081-0000-0000-0000-000000000004', true);
  set local role authenticated;
  select count(*) into n from public.recruitment_projects;
  if n <> 0 then raise exception '5: another organisation read % projects', n; end if;
  select count(*) into n from public.vendor_pricing;
  if n <> 0 then raise exception '5: another organisation read % pricing rows', n; end if;
  -- but the platform catalogue is shared
  select count(*) into n from public.panel_vendors where customer_id is null;
  if n <> 10 then raise exception '5: the catalogue is not shared (% rows)', n; end if;
  reset role;

  -- a signed-in user with no profile at all
  perform set_config('request.jwt.claim.sub', 'c0000081-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select count(*) into n from public.recruitment_orders;
  if n <> 0 then raise exception '5: a profile-less user read % orders', n; end if;
  reset role;

  raise notice 'PASS 5 RLS: members read their own and never the credentials; clients, strangers and the profile-less read nothing; no writes';
end $$;

/* ------------------------------------------------------------ 6. cascade */

do $$
declare n int;
begin
  delete from public.surveys where id = 'c0000000-0000-0000-0000-000000000181';

  select count(*) into n from public.recruitment_projects where id = 'c0000081-0000-0000-0000-00000000002a';
  if n <> 0 then raise exception '6: the recruitment project outlived its survey'; end if;
  select count(*) into n from public.sample_allocations where recruitment_project_id = 'c0000081-0000-0000-0000-00000000002a';
  if n <> 0 then raise exception '6: % allocations outlived the survey', n; end if;
  select count(*) into n from public.recruitment_orders where id = 'c0000081-0000-0000-0000-00000000003a';
  if n <> 0 then raise exception '6: the order outlived the survey'; end if;
  select count(*) into n from public.recruitment_events where recruitment_project_id = 'c0000081-0000-0000-0000-00000000002a';
  if n <> 0 then raise exception '6: % events outlived the survey', n; end if;

  -- the vendor relationship is the ORGANISATION's and survives the study, which is the whole point of 0081
  select count(*) into n from public.vendor_integrations where customer_id = 'c0000000-0000-0000-0000-000000000081';
  if n < 2 then raise exception '6: the vendor relationships were destroyed with the study'; end if;

  raise notice 'PASS 6 deleting the survey removes its project, allocations, orders and events; the vendor relationships remain';
end $$;

rollback;
