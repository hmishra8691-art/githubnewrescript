-- THE COMMERCIAL MARGIN ENGINE (migration 0087).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f scripts/margins-sql-test.sql
--
-- One transaction, rolled back. Most of what is tested here is the database REFUSING something: a margin that
-- has no finite price, an override nobody can explain, a second live rule for the same target, and a recorded
-- calculation whose own arithmetic does not hold.

begin;

\set cust '''f0000000-0000-0000-0000-0000000000f1'''
\set usr  '''f00000f1-0000-0000-0000-000000000001'''
\set srv  '''f0000000-0000-0000-0000-0000000001f1'''
\set proj '''f0000000-0000-0000-0000-0000000004f1'''

insert into auth.users (id, email) values (:usr, 'margins@example.test');
insert into public.customers (id, slug, name) values (:cust, 'margins', 'Margins');
insert into public.profiles (id, customer_id, email, full_name, role)
  values (:usr, :cust, 'margins@example.test', 'Admin', 'platform_admin')
  on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values (:srv, :cust, 'MARGN', 'Margins', :usr);
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_currency, status)
  values (:proj, :cust, :srv, 1000, 10000, 'GBP', 'draft');

/* ============================================================ 1. a 100% margin is refused by the column */

do $$
begin
  begin
    insert into public.commercial_margins (customer_id, scope, margin_bps)
    values ('f0000000-0000-0000-0000-0000000000f1', 'default', 10000);
    raise exception 'a 100%% margin was accepted — it has no finite selling price';
  exception when check_violation then null;
  end;
  raise notice 'PASS 1  a 100%% margin is refused by the database, not only by the engine';
end $$;

/* ============================================================ 2. an override must say why */

do $$
begin
  begin
    insert into public.commercial_margins (customer_id, scope, recruitment_project_id, margin_bps)
    values ('f0000000-0000-0000-0000-0000000000f1', 'override', 'f0000000-0000-0000-0000-0000000004f1', 1500);
    raise exception 'an override with no note was accepted — nobody could audit it later';
  exception when check_violation then null;
  end;

  insert into public.commercial_margins (customer_id, scope, recruitment_project_id, margin_bps, note)
  values ('f0000000-0000-0000-0000-0000000000f1', 'override', 'f0000000-0000-0000-0000-0000000004f1', 1500,
          'volume agreement signed 2026-10');
  raise notice 'PASS 2  an override without a stated reason is refused; with one it is accepted';
end $$;

/* ============================================================ 3. a scope must carry what it is scoped by */

do $$
begin
  begin
    insert into public.commercial_margins (customer_id, scope, margin_bps)
    values ('f0000000-0000-0000-0000-0000000000f1', 'market', 2500);
    raise exception 'a market rule with no market was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.commercial_margins (customer_id, scope, market, margin_bps)
    values ('f0000000-0000-0000-0000-0000000000f1', 'default', 'GB', 2500);
    raise exception 'a default rule carrying a market was accepted — which market would it mean?';
  exception when check_violation then null;
  end;
  raise notice 'PASS 3  each scope must carry its own target, and nothing it is not scoped by';
end $$;

/* ============================================================ 4. one live rule per target */

do $$
begin
  insert into public.commercial_margins (customer_id, scope, market, margin_bps)
  values ('f0000000-0000-0000-0000-0000000000f1', 'market', 'GB', 2500);
  begin
    insert into public.commercial_margins (customer_id, scope, market, margin_bps)
    values ('f0000000-0000-0000-0000-0000000000f1', 'market', 'GB', 2800);
    raise exception 'two live rules for GB were accepted — the rate would depend on sort order';
  exception when unique_violation then null;
  end;

  -- an EXPIRED rule for the same market is fine: that is history, not ambiguity
  insert into public.commercial_margins (customer_id, scope, market, margin_bps, effective_from, effective_to)
  values ('f0000000-0000-0000-0000-0000000000f1', 'market', 'GB', 2000,
          now() - interval '60 days', now() - interval '30 days');
  raise notice 'PASS 4  one live rule per target; superseded rules are kept';
end $$;

/* ============================================================ 5. the rules this table hands the resolver

   0090 removed `rescript_margin_resolve`: the precedence (override → project → recruitment_type → market →
   default) is decided ONCE, in packages/recruitment/src/margin.ts, on the path that actually quotes work.
   Tests 5 and 6 used to assert that a second implementation here agreed with it, which is the kind of test
   that passes right up until the two drift. What this table still owes the resolver is the correct SET of
   live rules, and that is what these two now check.                                                        */

do $$
declare v_scopes text[];
begin
  insert into public.commercial_margins (customer_id, scope, margin_bps)
  values ('f0000000-0000-0000-0000-0000000000f1', 'default', 3000);

  select array_agg(scope order by scope) into v_scopes
    from public.commercial_margins
   where customer_id = 'f0000000-0000-0000-0000-0000000000f1'
     and effective_from <= now()
     and (effective_to is null or effective_to > now());

  if not ('default' = any (v_scopes)) then raise exception 'the default rule is not live'; end if;
  if not ('market' = any (v_scopes)) then raise exception 'the GB market rule is not live'; end if;
  if not ('override' = any (v_scopes)) then raise exception 'the override is not live'; end if;
  raise notice 'PASS 5  every live rule is readable, with its scope — the resolver chooses, this table supplies';
end $$;

/* ============================================================ 6. an expired rule stops being supplied */

do $$
declare v_live integer;
begin
  /*
   * Expire it realistically: a rule that ran for nine days and ended yesterday. Setting only `effective_to`
   * into the past would violate the window constraint, because the rule was created a moment ago — which is
   * the constraint doing its job, not an obstacle to work around.
   */
  update public.commercial_margins
     set effective_from = now() - interval '10 days', effective_to = now() - interval '1 day'
   where customer_id = 'f0000000-0000-0000-0000-0000000000f1' and scope = 'override';

  select count(*) into v_live
    from public.commercial_margins
   where customer_id = 'f0000000-0000-0000-0000-0000000000f1' and scope = 'override'
     and effective_from <= now() and (effective_to is null or effective_to > now());

  if v_live <> 0 then raise exception 'an expired override is still being handed to the resolver'; end if;

  if (select count(*) from public.commercial_margins
       where customer_id = 'f0000000-0000-0000-0000-0000000000f1' and scope = 'override') <> 1 then
    raise exception 'the expired rule was deleted rather than ended — the price it set must stay readable';
  end if;
  raise notice 'PASS 6  an expired rule stops being live but is kept, so an old quote stays explainable';
end $$;

/* ============================================================ 7. a recorded calculation must add up */

do $$
begin
  begin
    insert into public.margin_applications
      (customer_id, recruitment_project_id, completes, cost_amount, margin_bps, margin_scope,
       price_amount, profit_amount, currency)
    values ('f0000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000004f1', 1000,
            7000, 3000, 'default', 10000, 2500, 'GBP');
    raise exception 'a calculation whose profit does not equal price minus cost was accepted';
  exception when check_violation then null;
  end;

  insert into public.margin_applications
    (customer_id, recruitment_project_id, completes, cost_amount, margin_bps, margin_scope,
     price_amount, profit_amount, currency, because)
  values ('f0000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000004f1', 1000,
          7000, 3000, 'default', 10000, 3000, 'GBP', '30.0% from the organisation''s default rate.');
  raise notice 'PASS 7  the arithmetic must hold in the row: 7,000 cost + 3,000 profit = 10,000 price';
end $$;

/* ============================================================ 8. the brief's example, end to end */

do $$
declare v_price numeric; v_cost numeric := 7000; v_bps integer := 3000;
begin
  v_price := round(v_cost / (1 - v_bps::numeric / 10000), 2);
  if v_price <> 10000 then raise exception 'margin arithmetic gives % for the brief''s example', v_price; end if;
  -- and the markup it replaces, for the record
  if round(v_cost * (1 + v_bps::numeric / 10000), 2) <> 9100 then
    raise exception 'the markup comparison is wrong';
  end if;
  raise notice 'PASS 8  £7,000 at 30%%: margin gives £10,000, the old markup gave £9,100';
end $$;

/* ============================================================ 9. a price below cost cannot be recorded */

do $$
begin
  begin
    insert into public.margin_applications
      (customer_id, completes, cost_amount, margin_bps, margin_scope, price_amount, profit_amount, currency)
    values ('f0000000-0000-0000-0000-0000000000f1', 100, 5000, 0, 'default', 4000, -1000, 'GBP');
    raise exception 'a price below cost was recorded as a margin application';
  exception when check_violation then null;
  end;
  raise notice 'PASS 9  selling below cost is not a margin calculation and is refused here';
end $$;

rollback;
