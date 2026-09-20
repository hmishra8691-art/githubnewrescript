-- BILLING PERIODS SQL TEST (migration 0044) — run against a database with the
-- migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/billing-periods-sql-test.sql
--
-- A period is the window an invoice covers, and events are stamped with theirs
-- when they are WRITTEN rather than matched to one by date at reporting time.
-- That is what makes an issued invoice reproducible: the same rows for ever,
-- whatever anyone later decides about boundaries or timezones.
--
-- Three invariants, each of which splits an invoice if it does not hold.
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name)
  values ('c0000044-0000-0000-0000-000000000001', 'periods', 'Periods')
on conflict do nothing;

do $$
declare a uuid; b uuid; n integer;
begin
  /*
   * 1. ASKING TWICE GIVES THE SAME PERIOD.
   *
   * Two concurrent first-events for one customer must not open two periods.
   * If they did, one afternoon's usage would land on two invoices depending
   * on which row the planner returned.
   */
  a := public.rescript_billing_open_period('c0000044-0000-0000-0000-000000000001');
  if a is null then raise exception 'no period was opened'; end if;
  b := public.rescript_billing_open_period('c0000044-0000-0000-0000-000000000001');
  if a <> b then raise exception 'a second period was opened: % vs %', a, b; end if;

  select count(*) into n from public.billing_periods
   where customer_id = 'c0000044-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'expected exactly one period, got %', n; end if;
  raise notice 'PASS — asking twice returns the same open period';

  /*
   * 2. THE DATABASE REFUSES A SECOND OPEN PERIOD, not just the function.
   *
   * The function is careful; an index cannot be bypassed. Anything that
   * writes a period by hand — a migration, an admin screen, a repair script —
   * is held to the same rule.
   */
  begin
    insert into public.billing_periods (customer_id, starts_at, ends_at)
    values ('c0000044-0000-0000-0000-000000000001', now(), now() + interval '1 month');
    raise exception 'a second OPEN period was accepted — events would split across invoices arbitrarily';
  exception when unique_violation then
    raise notice 'PASS — one open period per customer, enforced by the index';
  end;

  /* 3. …and closing one frees the slot, or a customer could be invoiced once only */
  update public.billing_periods set status = 'closed', closed_at = now() where id = a;
  b := public.rescript_billing_open_period('c0000044-0000-0000-0000-000000000001');
  if b = a then raise exception 'a closed period was reused'; end if;
  raise notice 'PASS — a closed period frees the slot for the next';

  /* and an inverted window is refused: [starts, ends) has to be a window */
  begin
    insert into public.billing_periods (customer_id, starts_at, ends_at)
    values ('c0000044-0000-0000-0000-000000000001', now(), now() - interval '1 day');
    raise exception 'an inverted window was accepted';
  exception when check_violation then
    raise notice 'PASS — ends_at must be after starts_at';
  end;
end $$;

/*
 * The three columns an invoice line needs. Asserted as a schema fact rather
 * than by inspection, because a column quietly dropped in a later migration
 * would be discovered at the first period close.
 */
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing from (
    select c from unnest(array['respondent_id','unit_price','billing_period_id']) c
    where not exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name='usage_events' and column_name = c)
  ) x;
  if missing is not null then
    raise exception 'usage_events is missing the invoice columns: %', missing;
  end if;
  raise notice 'PASS — usage_events carries respondent_id, unit_price and billing_period_id';
end $$;

rollback;
