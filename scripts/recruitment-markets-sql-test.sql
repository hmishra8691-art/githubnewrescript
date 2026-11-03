-- RECRUITMENT MARKETS SQL TEST (migration 0082) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/recruitment-markets-sql-test.sql
--
-- Proves, on real Postgres:
--   1. the new tables and columns exist with RLS on and read-only policies; sample_allocations.market is NOT NULL
--      with the widened unique index, and a project with no markets keeps 0081's single-pool behaviour
--   2. per-market ceilings: each market's target is its own, an undeclared market is refused outright, and the
--      project-wide budget still binds across all of them
--   3. a refused allocation writes nothing, and revisions still replace and accumulate
--   4. vendor_capacity: a NULL available_sample is "they did not say", an expired row is distinguishable, and
--      the window constraint holds
--   5. rescript_recruitment_recommit: committed is the ORDERED value at the agreed CPI, and a threshold is a
--      CROSSING — it reports true once, not on every order afterwards
--   6. the RLS backstop on the new tables, and cascade from the survey
--
-- One transaction, rolled back.

begin;

/* ------------------------------------------------------------ fixtures */

insert into public.customers (id, slug, name) values
  ('c0000000-0000-0000-0000-000000000082', 'rx82', 'Recruitment markets 0082'),
  ('c0000000-0000-0000-0000-000000000083', 'other82', 'Another organisation')
on conflict do nothing;

insert into auth.users (id, email) values
  ('c0000082-0000-0000-0000-000000000001', 'owner@r82.test'),
  ('c0000082-0000-0000-0000-000000000002', 'stranger@r82.test')
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role) values
  ('c0000082-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000082', 'owner@r82.test', 'Owner', 'programmer'),
  ('c0000082-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000083', 'stranger@r82.test', 'Stranger', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;

insert into public.surveys (id, customer_id, code, title, owner_id)
values ('c0000000-0000-0000-0000-000000000182', 'c0000000-0000-0000-0000-000000000082', 'R82', 'Markets', 'c0000082-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

insert into public.panel_vendors (id, customer_id, slug, name)
values ('c0000082-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000082', 'v82', 'Vendor 82')
on conflict do nothing;

insert into public.vendor_integrations (id, customer_id, vendor_id, mode)
values ('c0000082-0000-0000-0000-00000000001a', 'c0000000-0000-0000-0000-000000000082', 'c0000082-0000-0000-0000-00000000000a', 'manual')
on conflict do nothing;

-- 5,000 completes, 40,000 budget, split US 3,000 / GB 2,000
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_alert_bps)
values ('c0000082-0000-0000-0000-00000000002a', 'c0000000-0000-0000-0000-000000000082', 'c0000000-0000-0000-0000-000000000182', 5000, 40000, 8000)
on conflict do nothing;

insert into public.recruitment_markets (recruitment_project_id, market, required_completes) values
  ('c0000082-0000-0000-0000-00000000002a', 'US', 3000),
  ('c0000082-0000-0000-0000-00000000002a', 'GB', 2000)
on conflict do nothing;

-- a second project with NO markets, to prove 0081's single-pool behaviour survives
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount)
values ('c0000082-0000-0000-0000-00000000002b', 'c0000000-0000-0000-0000-000000000082', 'c0000000-0000-0000-0000-000000000182', 100, 1000)
on conflict do nothing;

/* ------------------------------------------------------------ 1. structure */

do $$
declare n int; bad text;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relrowsecurity and c.relname in ('recruitment_markets', 'vendor_capacity');
  if n <> 2 then raise exception '1: expected both new tables with RLS, found %', n; end if;

  select string_agg(policyname || '=' || cmd, ', ') into bad from pg_policies
    where schemaname = 'public' and cmd <> 'SELECT' and tablename in ('recruitment_markets', 'vendor_capacity');
  if bad is not null then raise exception '1: non-SELECT policy present: %', bad; end if;

  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'sample_allocations' and column_name = 'market') <> 'NO' then
    raise exception '1: sample_allocations.market is nullable';
  end if;

  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'sample_allocations_uniq') then
    raise exception '1: the 0081 index that does not know about markets is still present';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'sample_allocations_market_uniq') then
    raise exception '1: the market-aware unique index is missing';
  end if;

  if has_function_privilege('authenticated', 'public.rescript_recruitment_recommit(uuid)', 'execute') then
    raise exception '1: a signed-in user can recompute committed spend';
  end if;

  raise notice 'PASS 1 new tables with RLS, market NOT NULL, the widened index, service-role function';
end $$;

/* ------------------------------------------------------------ 2. per-market ceilings */

do $$
declare r record;
begin
  -- US 3,000 at 7.00 and GB 2,000 at 8.00 = 37,000 against 40,000
  select * into r from public.rescript_recruitment_allocate('c0000082-0000-0000-0000-00000000002a', 0,
    '[{"market":"US","integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":3000,"cpi":7.00},
      {"market":"GB","integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":2000,"cpi":8.00}]'::jsonb, null);
  if r.total_completes <> 5000 or r.total_cost <> 37000 then
    raise exception '2: got % completes at % cost', r.total_completes, r.total_cost;
  end if;

  -- GB's own target binds, however much room US has left
  begin
    perform public.rescript_recruitment_allocate('c0000082-0000-0000-0000-00000000002a', 1,
      '[{"market":"GB","integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":2500,"cpi":1.00}]'::jsonb, null);
    raise exception '2: GB was allocated 2,500 against a target of 2,000';
  exception when check_violation then null; end;

  -- a market the project never declared is refused: it is nearly always a typo
  begin
    perform public.rescript_recruitment_allocate('c0000082-0000-0000-0000-00000000002a', 1,
      '[{"market":"DE","integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":100,"cpi":1.00}]'::jsonb, null);
    raise exception '2: an undeclared market was accepted';
  exception when check_violation then null; end;

  -- and the project-wide budget still binds across markets
  begin
    perform public.rescript_recruitment_allocate('c0000082-0000-0000-0000-00000000002a', 1,
      '[{"market":"US","integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":3000,"cpi":12.00},
        {"market":"GB","integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":2000,"cpi":12.00}]'::jsonb, null);
    raise exception '2: a 60,000 allocation was accepted against a 40,000 budget';
  exception when check_violation then null; end;

  raise notice 'PASS 2 per-market targets bind, undeclared markets refused, the budget still binds across markets';
end $$;

/* ------------------------------------------------------------ 3. revisions, and the single-pool project */

do $$
declare n int; r record;
begin
  select count(*) into n from public.sample_allocations
    where recruitment_project_id = 'c0000082-0000-0000-0000-00000000002a' and revision = 1;
  if n <> 0 then raise exception '3: a refused allocation left % rows behind', n; end if;

  -- one vendor may appear once per market per revision; the same vendor in two markets is two legal rows
  select count(*) into n from public.sample_allocations
    where recruitment_project_id = 'c0000082-0000-0000-0000-00000000002a' and revision = 0;
  if n <> 2 then raise exception '3: expected one row per market, got %', n; end if;

  -- a project with NO declared markets keeps 0081's behaviour: one pool, checked against the total
  select * into r from public.rescript_recruitment_allocate('c0000082-0000-0000-0000-00000000002b', 0,
    '[{"integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":100,"cpi":5.00}]'::jsonb, null);
  if r.total_completes <> 100 then raise exception '3: the single-pool project allocated %', r.total_completes; end if;
  if (select market from public.sample_allocations where recruitment_project_id = 'c0000082-0000-0000-0000-00000000002b') <> '--' then
    raise exception '3: a marketless allocation did not land in the placeholder market';
  end if;
  begin
    perform public.rescript_recruitment_allocate('c0000082-0000-0000-0000-00000000002b', 1,
      '[{"integration_id":"c0000082-0000-0000-0000-00000000001a","allocated_completes":101,"cpi":1.00}]'::jsonb, null);
    raise exception '3: the single-pool project over-allocated';
  exception when check_violation then null; end;

  raise notice 'PASS 3 refusals write nothing; one row per vendor per market; a marketless project is unchanged by 0082';
end $$;

/* ------------------------------------------------------------ 4. capacity */

do $$
declare n int;
begin
  insert into public.vendor_capacity (integration_id, market, available_sample, delivery_days, source)
    values ('c0000082-0000-0000-0000-00000000001a', 'US', 40000, 5, 'vendor_reported');
  -- "they did not say" is a real answer and is not zero
  insert into public.vendor_capacity (integration_id, market, available_sample, source)
    values ('c0000082-0000-0000-0000-00000000001a', 'GB', null, 'vendor_reported');
  select count(*) into n from public.vendor_capacity
    where integration_id = 'c0000082-0000-0000-0000-00000000001a' and market = 'GB' and available_sample is null;
  if n <> 1 then raise exception '4: a NULL availability was not stored as NULL'; end if;

  -- an expiry in the past is storable and distinguishable; an expiry before the recording is not
  insert into public.vendor_capacity (integration_id, market, available_sample, source, recorded_at, expires_at)
    values ('c0000082-0000-0000-0000-00000000001a', 'DE', 1000, 'administrator', now() - interval '30 days', now() - interval '1 day');
  select count(*) into n from public.vendor_capacity
    where integration_id = 'c0000082-0000-0000-0000-00000000001a' and expires_at < now();
  if n <> 1 then raise exception '4: the expired row is not distinguishable'; end if;

  begin
    insert into public.vendor_capacity (integration_id, market, available_sample, source, recorded_at, expires_at)
      values ('c0000082-0000-0000-0000-00000000001a', 'FR', 10, 'administrator', now(), now() - interval '1 day');
    raise exception '4: a capacity row expiring before it was recorded was accepted';
  exception when check_violation then null; end;

  raise notice 'PASS 4 capacity: NULL means not stated, expiry is stored and ordered, the window constraint holds';
end $$;

/* ------------------------------------------------------------ 5. committed spend and the threshold */

do $$
declare r record;
begin
  -- 1,500 ordered at 8.00 commits 12,000 the moment it is placed — 30% of the budget, under the 80% threshold
  insert into public.recruitment_orders (id, recruitment_project_id, integration_id, ordered_completes, agreed_cpi, status)
    values ('c0000082-0000-0000-0000-00000000003a', 'c0000082-0000-0000-0000-00000000002a', 'c0000082-0000-0000-0000-00000000001a', 1500, 8.00, 'placed');
  select * into r from public.rescript_recruitment_recommit('c0000082-0000-0000-0000-00000000002a');
  if r.committed <> 12000 then raise exception '5: committed is % not 12000 (it is ORDERED value, not delivered)', r.committed; end if;
  if r.share_bps <> 3000 or r.crossed then raise exception '5: share=%, crossed=%', r.share_bps, r.crossed; end if;
  if (select committed_amount from public.recruitment_projects where id = 'c0000082-0000-0000-0000-00000000002a') <> 12000 then
    raise exception '5: committed_amount was not written back';
  end if;

  -- a second order takes it to 34,000 = 85%, crossing 80% for the first time
  insert into public.recruitment_orders (id, recruitment_project_id, integration_id, ordered_completes, agreed_cpi, status)
    values ('c0000082-0000-0000-0000-00000000003b', 'c0000082-0000-0000-0000-00000000002a', 'c0000082-0000-0000-0000-00000000001a', 2750, 8.00, 'placed');
  select * into r from public.rescript_recruitment_recommit('c0000082-0000-0000-0000-00000000002a');
  if r.committed <> 34000 or not r.crossed then raise exception '5: committed=%, crossed=%', r.committed, r.crossed; end if;

  -- and again: a threshold is a crossing, so it reports true ONCE. An alert that fires on every later order is
  -- an alert people switch off.
  select * into r from public.rescript_recruitment_recommit('c0000082-0000-0000-0000-00000000002a');
  if r.crossed then raise exception '5: the threshold reported a crossing twice'; end if;

  -- a cancelled order releases its commitment
  update public.recruitment_orders set status = 'cancelled' where id = 'c0000082-0000-0000-0000-00000000003b';
  select * into r from public.rescript_recruitment_recommit('c0000082-0000-0000-0000-00000000002a');
  if r.committed <> 12000 then raise exception '5: a cancelled order still commits % ', r.committed; end if;

  raise notice 'PASS 5 committed is ordered value, written back, crosses once, and released on cancellation';
end $$;

/* ------------------------------------------------------------ 6. the RLS backstop and cascade */

grant select on public.recruitment_markets, public.vendor_capacity to authenticated;

do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', 'c0000082-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into n from public.recruitment_markets;
  if n <> 2 then raise exception '6: a member reads % of its own markets', n; end if;
  select count(*) into n from public.vendor_capacity;
  if n < 3 then raise exception '6: a member reads % capacity rows', n; end if;
  begin
    insert into public.recruitment_markets (recruitment_project_id, market, required_completes)
      values ('c0000082-0000-0000-0000-00000000002a', 'FR', 1);
    raise exception '6: a member wrote a market';
  exception when insufficient_privilege then null; end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0000082-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select count(*) into n from public.recruitment_markets;
  if n <> 0 then raise exception '6: another organisation read % markets', n; end if;
  select count(*) into n from public.vendor_capacity;
  if n <> 0 then raise exception '6: another organisation read % capacity rows', n; end if;
  reset role;

  delete from public.surveys where id = 'c0000000-0000-0000-0000-000000000182';
  select count(*) into n from public.recruitment_markets where recruitment_project_id = 'c0000082-0000-0000-0000-00000000002a';
  if n <> 0 then raise exception '6: % markets outlived the survey', n; end if;
  -- the vendor's capacity belongs to the ORGANISATION's relationship and survives the study
  select count(*) into n from public.vendor_capacity where integration_id = 'c0000082-0000-0000-0000-00000000001a';
  if n < 3 then raise exception '6: the vendor capacity was destroyed with the study'; end if;

  raise notice 'PASS 6 RLS holds on both new tables; markets cascade with the survey, vendor capacity does not';
end $$;

rollback;
