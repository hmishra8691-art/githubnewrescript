-- 0082 — The recruitment exchange, Phase 2: markets, capacity and budget thresholds (2026-11-03).
--
-- 0081 priced a recruitment project against ONE market: `primaryMarket` took the first country in the audience
-- and the whole project was priced as if it were that country. For a United States study that is right. For
-- "US, UK and Germany, 5,000 completes" it is wrong in the expensive direction — German incidence and German
-- CPI are not American ones, and a blended figure built from a single rate card is a number nobody should
-- authorise spend against.
--
-- So a recruitment project now has a target PER MARKET, and the optimiser solves each market separately against
-- that market's rate cards and that vendor's capacity there. The project's budget stays a single ceiling across
-- all of them, because that is how a budget is actually approved.
--
--   recruitment_markets   the completes a project needs in one country, with that country's own incidence and
--                         length when they differ (a 15-minute US survey is frequently 18 in German). The sum of
--                         the markets' targets is checked against the project's required completes.
--   vendor_capacity       what a vendor says it can supply in a market — recorded by an operator, with the date
--                         and the provenance, because an availability figure is perishable and a stale one that
--                         looks fresh is worse than none. NULL available_sample means "they did not say", which
--                         the optimiser treats as unknown rather than unlimited.
--   sample_allocations    gains `market`: an allocation row is now a vendor's share of ONE market, and the
--                         unique index widens to match. Existing rows are backfilled to the project's first
--                         market, or '--' when a project has none.
--   recruitment_projects  gains the budget alert threshold and the spend already committed, so a crossing can
--                         be detected without re-reading every order.
--
-- `rescript_recruitment_allocate` is replaced with a market-aware version. It keeps both of 0081's ceilings —
-- the approved budget across the whole project, and the required completes PER MARKET — and still refuses rather
-- than clamping.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   alter table public.sample_allocations drop column if exists market;
--   drop table if exists public.vendor_capacity, public.recruitment_markets cascade;
--   alter table public.recruitment_projects drop column if exists budget_alert_bps, drop column if exists committed_amount;

/* ------------------------------------------------------------ a project's markets */

create table if not exists public.recruitment_markets (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  market text not null check (market ~ '^[A-Z]{2}$'),
  required_completes integer not null check (required_completes > 0 and required_completes <= 10000000),
  -- this market's own incidence and length, when they differ from the project's
  expected_ir numeric(5,2) check (expected_ir is null or (expected_ir > 0 and expected_ir <= 100)),
  loi_minutes integer check (loi_minutes is null or (loi_minutes > 0 and loi_minutes <= 240)),
  -- a per-market ceiling, when the budget is split rather than pooled. NULL = draws on the project's budget
  budget_cap numeric(14,2) check (budget_cap is null or budget_cap >= 0),
  notes text,
  created_at timestamptz not null default now()
);
create unique index if not exists recruitment_markets_uniq on public.recruitment_markets (recruitment_project_id, market);

/* ------------------------------------------------------------ what a vendor says it has */

create table if not exists public.vendor_capacity (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  market text not null check (market ~ '^[A-Z]{2}$'),
  -- NULL means the vendor did not say. It is NOT zero and it is NOT unlimited: the optimiser treats it as
  -- unknown and will not allocate past the project's own requirement on the strength of it.
  available_sample integer check (available_sample is null or available_sample >= 0),
  expected_ir numeric(5,2) check (expected_ir is null or (expected_ir > 0 and expected_ir <= 100)),
  -- how fast they say they can deliver it
  delivery_days numeric(6,2) check (delivery_days is null or delivery_days >= 0),
  source text not null check (source in ('live', 'vendor_reported', 'historical', 'administrator')),
  source_note text,
  -- an availability figure goes stale: the optimiser discounts one older than the project's own deadline window
  recorded_at timestamptz not null default now(),
  expires_at timestamptz,
  recorded_by uuid references public.profiles(id) on delete set null,
  constraint vendor_capacity_window check (expires_at is null or expires_at > recorded_at)
);
create index if not exists vendor_capacity_lookup_idx on public.vendor_capacity (integration_id, market, recorded_at desc);

/* ------------------------------------------------------------ allocations become per-market */

alter table public.sample_allocations
  add column if not exists market text;

-- backfill: an existing allocation belongs to the project's first market, or to the placeholder when it has none
update public.sample_allocations a
   set market = coalesce(
     (select m.market from public.recruitment_markets m
       where m.recruitment_project_id = a.recruitment_project_id order by m.market limit 1),
     '--')
 where a.market is null;

alter table public.sample_allocations
  alter column market set default '--';
alter table public.sample_allocations
  alter column market set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sample_allocations_market_shape') then
    alter table public.sample_allocations
      add constraint sample_allocations_market_shape check (market ~ '^([A-Z]{2}|--)$');
  end if;
end $$;

-- one row per vendor per market per revision; the 0081 index did not know about markets
drop index if exists public.sample_allocations_uniq;
create unique index if not exists sample_allocations_market_uniq
  on public.sample_allocations (recruitment_project_id, revision, market, integration_id);

/* ------------------------------------------------------------ budget thresholds */

alter table public.recruitment_projects
  -- raise BudgetThresholdReached when committed or spent crosses this share of the budget; 8000 = 80%
  add column if not exists budget_alert_bps integer not null default 8000,
  -- what the placed orders add up to, kept here so a crossing is detectable without summing every order
  add column if not exists committed_amount numeric(14,2) not null default 0;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recruitment_projects_alert_bps') then
    alter table public.recruitment_projects
      add constraint recruitment_projects_alert_bps check (budget_alert_bps between 0 and 10000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recruitment_projects_committed') then
    alter table public.recruitment_projects
      add constraint recruitment_projects_committed check (committed_amount >= 0);
  end if;
end $$;

/* ------------------------------------------------------------ RLS and grants for the new tables */

alter table public.recruitment_markets enable row level security;
alter table public.vendor_capacity     enable row level security;

drop policy if exists recruitment_markets_read on public.recruitment_markets;
create policy recruitment_markets_read on public.recruitment_markets for select to authenticated
  using (
    (public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_capacity_read on public.vendor_capacity;
create policy vendor_capacity_read on public.vendor_capacity for select to authenticated
  using (
    (public.rescript_vendor_integration_customer(integration_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

revoke all on public.recruitment_markets, public.vendor_capacity from anon;
grant select on public.recruitment_markets, public.vendor_capacity to authenticated;

/* ------------------------------------------------------------ the market-aware allocation

   Replaces 0081's function. The signature gains nothing: `p_rows` simply carries a `market` on each row now, and
   a row without one lands in '--' so a single-market project written against 0081 keeps working unchanged.

   Two ceilings, both refusing rather than clamping, as in 0081:
     - the approved budget, across ALL markets (a budget is approved once, for the project);
     - the required completes, PER MARKET (over-delivering Germany does not excuse under-delivering the US).
   A market named in the allocation that the project does not have is refused outright: it is nearly always a
   typo, and silently inventing a market is how a project quietly buys sample it did not ask for.             */

create or replace function public.rescript_recruitment_allocate(
  p_project uuid, p_revision integer, p_rows jsonb, p_actor uuid default null)
returns table (revision integer, vendors integer, total_completes integer, total_cost numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_budget    numeric;
  v_required  integer;
  v_currency  text;
  v_cost      numeric := 0;
  v_completes integer := 0;
  v_rows      integer := 0;
  v_markets   integer;
  r           record;
begin
  select budget_amount, required_completes, budget_currency
    into v_budget, v_required, v_currency
    from public.recruitment_projects where id = p_project for update;
  if not found then
    raise exception 'recruitment project % does not exist', p_project using errcode = 'no_data_found';
  end if;

  select count(*) into v_markets from public.recruitment_markets where recruitment_project_id = p_project;

  select coalesce(sum((x->>'allocated_completes')::integer), 0),
         coalesce(sum((x->>'allocated_completes')::integer * (x->>'cpi')::numeric), 0),
         count(*)
    into v_completes, v_cost, v_rows
    from jsonb_array_elements(p_rows) x;

  if v_cost > v_budget then
    raise exception 'allocation costs % %, over the approved budget of % %',
      round(v_cost, 2), v_currency, round(v_budget, 2), v_currency using errcode = 'check_violation';
  end if;

  if v_markets = 0 then
    -- a project with no declared markets keeps 0081's behaviour: one pool, checked against the total
    if v_completes > v_required then
      raise exception 'allocation of % completes exceeds the % required', v_completes, v_required
        using errcode = 'check_violation';
    end if;
  else
    -- every market in the allocation must be one the project declared
    for r in
      select distinct coalesce(nullif(x->>'market', ''), '--') as market
        from jsonb_array_elements(p_rows) x
    loop
      if not exists (select 1 from public.recruitment_markets m
                      where m.recruitment_project_id = p_project and m.market = r.market) then
        raise exception 'the allocation names the market %, which this project does not have', r.market
          using errcode = 'check_violation';
      end if;
    end loop;

    -- and no market may be over-allocated, however much room another market has left
    for r in
      select coalesce(nullif(x->>'market', ''), '--') as market,
             sum((x->>'allocated_completes')::integer) as completes
        from jsonb_array_elements(p_rows) x
       group by 1
    loop
      if r.completes > (select m.required_completes from public.recruitment_markets m
                         where m.recruitment_project_id = p_project and m.market = r.market) then
        raise exception 'allocation of % completes in % exceeds what that market requires', r.completes, r.market
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  delete from public.sample_allocations
   where recruitment_project_id = p_project and sample_allocations.revision = p_revision;

  insert into public.sample_allocations (recruitment_project_id, revision, market, integration_id,
    allocated_completes, cpi, currency, expected_valid_completes, cost_per_valid_complete,
    expected_delivery_days, rationale, created_by)
  select p_project, p_revision, coalesce(nullif(x->>'market', ''), '--'), (x->>'integration_id')::uuid,
    (x->>'allocated_completes')::integer, (x->>'cpi')::numeric, coalesce(x->>'currency', v_currency),
    nullif(x->>'expected_valid_completes', '')::integer, nullif(x->>'cost_per_valid_complete', '')::numeric,
    nullif(x->>'expected_delivery_days', '')::numeric, coalesce(x->'rationale', '{}'::jsonb), p_actor
  from jsonb_array_elements(p_rows) x;

  return query select p_revision, v_rows, v_completes, v_cost;
end;
$$;

revoke all on function public.rescript_recruitment_allocate(uuid, integer, jsonb, uuid) from public, anon, authenticated;

/**
 * Recompute what a project has COMMITTED — the orders placed, at their agreed CPI — and say whether that crosses
 * the budget alert threshold. Called after an order is placed or cancelled.
 *
 * Committed is not spent: an order for 1,500 at $8.00 commits $12,000 the moment it is placed, and a budget that
 * only counts delivered completes tells a researcher they have room they have already promised away.
 */
create or replace function public.rescript_recruitment_recommit(p_project uuid)
returns table (committed numeric, budget numeric, crossed boolean, share_bps integer)
language plpgsql security definer set search_path = public as $$
declare
  v_committed numeric;
  v_budget    numeric;
  v_alert     integer;
  v_prev      numeric;
  v_bps       integer;
begin
  select budget_amount, budget_alert_bps, committed_amount
    into v_budget, v_alert, v_prev
    from public.recruitment_projects where id = p_project for update;
  if not found then
    raise exception 'recruitment project % does not exist', p_project using errcode = 'no_data_found';
  end if;

  select coalesce(sum(ordered_completes * agreed_cpi), 0) into v_committed
    from public.recruitment_orders
   where recruitment_project_id = p_project and status in ('placed', 'live', 'paused', 'complete');

  update public.recruitment_projects
     set committed_amount = round(v_committed, 2), updated_at = now()
   where id = p_project;

  v_bps := case when v_budget > 0 then least(round(v_committed / v_budget * 10000)::integer, 2147483647) else 0 end;
  -- crossed only on the TRANSITION, so a threshold raises its event once rather than on every order after it
  return query select round(v_committed, 2), v_budget,
    (v_budget > 0 and v_bps >= v_alert and round(case when v_budget > 0 then v_prev / v_budget * 10000 else 0 end)::integer < v_alert),
    v_bps;
end;
$$;

revoke all on function public.rescript_recruitment_recommit(uuid) from public, anon, authenticated;

comment on table public.recruitment_markets is 'A recruitment project''s completes target per country (0082). The optimiser solves each market against its own rate cards.';
comment on table public.vendor_capacity is 'What a vendor says it can supply in a market (0082), with provenance and a recorded date. NULL available_sample means they did not say — not zero, not unlimited.';
comment on column public.sample_allocations.market is 'The country this row allocates for (0082). ''--'' for a project with no declared markets, which keeps 0081''s single-pool behaviour.';
