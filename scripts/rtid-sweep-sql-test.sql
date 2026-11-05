-- THE RESERVATION SWEEP (migration 0083's `rescript_rtid_sweep`, called from the hourly job since 2026-11-05).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f scripts/rtid-sweep-sql-test.sql
--
-- One transaction, rolled back. The subject is the LOCKOUT: `participation_ledger_live_uniq` counts a
-- `reserved` row as live and `expired` as not, so a reservation that lapsed and was never swept keeps holding
-- the index — and the same person coming back is refused as a duplicate of themselves.
--
-- The function was written in 0083 with exactly that in its comment. Nothing called it for two months.

begin;

\set cust '''d0000000-0000-0000-0000-0000000000d1'''
\set usr  '''d00000d1-0000-0000-0000-000000000001'''
\set srv  '''d0000000-0000-0000-0000-0000000001d1'''

insert into auth.users (id, email) values (:usr, 'sweep@example.test');
insert into public.customers (id, slug, name) values (:cust, 'sweep', 'Sweep');
insert into public.profiles (id, customer_id, email, full_name, role)
  values (:usr, :cust, 'sweep@example.test', 'Researcher', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values (:srv, :cust, 'SWEEP', 'Sweep', :usr);

/* three distinct people in this organisation */
insert into public.respondent_trust_ids (id, customer_id, trust_id, resolution)
  values ('d0000000-0000-0000-0000-00000000aaa1', :cust, 'rtid_aaaaaaaaaaaaaaaa', 'probabilistic'),
         ('d0000000-0000-0000-0000-00000000bbb2', :cust, 'rtid_bbbbbbbbbbbbbbbb', 'probabilistic'),
         ('d0000000-0000-0000-0000-00000000ccc3', :cust, 'rtid_cccccccccccccccc', 'probabilistic');

/* ============================================================ 1. the lockout, reproduced */

do $$
declare v record;
begin
  -- the respondent arrives and their place is held for an hour
  select * into v from public.rescript_rtid_reserve(
    'd0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
    'd0000000-0000-0000-0000-00000000aaa1', null, 'enforce', 3600);
  if not v.reserved then raise exception 'the first arrival was not reserved'; end if;

  -- their browser dies on the consent page; the hour passes
  update public.participation_ledger
     set expires_at = now() - interval '5 minutes'
   where trust_id = 'd0000000-0000-0000-0000-00000000aaa1';

  -- they come back
  select * into v from public.rescript_rtid_reserve(
    'd0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
    'd0000000-0000-0000-0000-00000000aaa1', null, 'enforce', 3600);

  if v.reserved then
    raise exception 'expected the lapsed reservation to still block — the test fixture is wrong, not the code';
  end if;
  if v.held_state <> 'reserved' then
    raise exception 'blocked by state %, expected reserved', v.held_state;
  end if;
  raise notice 'PASS 1  a lapsed reservation still holds the index: the person is refused as a duplicate of themselves';
end $$;

/* ============================================================ 2. the sweep frees them */

do $$
declare v_freed integer; v record;
begin
  select public.rescript_rtid_sweep(1000) into v_freed;
  if v_freed < 1 then raise exception 'the sweep freed nothing'; end if;

  if (select state from public.participation_ledger
       where trust_id = 'd0000000-0000-0000-0000-00000000aaa1' and not shadow) <> 'expired' then
    raise exception 'the lapsed row is not expired';
  end if;

  -- and now the same person can take part
  select * into v from public.rescript_rtid_reserve(
    'd0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
    'd0000000-0000-0000-0000-00000000aaa1', null, 'enforce', 3600);
  if not v.reserved then
    raise exception 'still refused after the sweep — the lockout is not fixed';
  end if;
  raise notice 'PASS 2  the sweep moves it to expired, outside the index, and the person is admitted';
end $$;

/* ============================================================ 3. a LIVE reservation is not touched */

do $$
begin
  perform public.rescript_rtid_reserve(
    'd0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
    'd0000000-0000-0000-0000-00000000bbb2', null, 'enforce', 3600);

  perform public.rescript_rtid_sweep(1000);

  if (select state from public.participation_ledger
       where trust_id = 'd0000000-0000-0000-0000-00000000bbb2' and not shadow) <> 'reserved' then
    raise exception 'the sweep expired somebody who is still answering';
  end if;
  raise notice 'PASS 3  a reservation inside its window survives the sweep — it is a timer, not a cull';
end $$;

/* ============================================================ 4. a COMPLETED participation is not touched */

do $$
begin
  update public.participation_ledger
     set state = 'completed', expires_at = now() - interval '1 day'
   where trust_id = 'd0000000-0000-0000-0000-00000000ccc3';

  insert into public.participation_ledger (customer_id, survey_id, trust_id, state, expires_at, shadow)
    values ('d0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
            'd0000000-0000-0000-0000-00000000ccc3', 'completed', now() - interval '1 day', false)
    on conflict do nothing;

  perform public.rescript_rtid_sweep(1000);

  if (select count(*) from public.participation_ledger
       where trust_id = 'd0000000-0000-0000-0000-00000000ccc3' and state = 'expired') > 0 then
    raise exception 'a finished participation was expired — somebody who took part could take part again';
  end if;
  raise notice 'PASS 4  a completed participation is never expired, however old: it is the record that they took part';
end $$;

/* ============================================================ 5. the sweep is idempotent and bounded */

do $$
declare v_second integer; v_batch integer;
begin
  select public.rescript_rtid_sweep(1000) into v_second;
  if v_second <> 0 then raise exception 'a second sweep expired % more rows with nothing left to expire', v_second; end if;

  -- twenty lapsed reservations, swept five at a time
  for i in 1..20 loop
    insert into public.respondent_trust_ids (id, customer_id, trust_id, resolution)
      values (('d0000000-0000-0000-0000-0000000e' || lpad(i::text, 4, '0'))::uuid,
              'd0000000-0000-0000-0000-0000000000d1',
              'rtid_bulk' || lpad(i::text, 12, '0'), 'probabilistic');
    insert into public.participation_ledger (customer_id, survey_id, trust_id, state, expires_at, shadow)
      values ('d0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
              ('d0000000-0000-0000-0000-0000000e' || lpad(i::text, 4, '0'))::uuid,
              'reserved', now() - interval '1 hour', false);
  end loop;

  select public.rescript_rtid_sweep(5) into v_batch;
  if v_batch <> 5 then raise exception 'p_limit was not honoured: freed % with a limit of 5', v_batch; end if;

  if (select count(*) from public.participation_ledger
       where state = 'reserved' and expires_at < now()) <> 15 then
    raise exception 'the batch took the wrong rows';
  end if;
  raise notice 'PASS 5  idempotent when drained, and p_limit bounds each batch so the hourly job can loop';
end $$;

/* ============================================================ 6. the oldest lapse is freed first */

do $$
declare v_state text; v_left integer;
begin
  /* fifteen lapsed an hour ago; make ONE of them nine days old and sweep a single row */
  update public.participation_ledger
     set expires_at = now() - interval '9 days'
   where trust_id = 'd0000000-0000-0000-0000-0000000e0019';

  perform public.rescript_rtid_sweep(1);

  select state into v_state from public.participation_ledger
   where trust_id = 'd0000000-0000-0000-0000-0000000e0019';
  if v_state <> 'expired' then
    raise exception 'the single sweep took some other row; the respondent waiting nine days is still locked out (state %)', v_state;
  end if;

  select count(*) into v_left from public.participation_ledger
   where state = 'reserved' and expires_at < now();
  if v_left <> 14 then
    raise exception 'expected 14 lapsed rows left after taking one, found %', v_left;
  end if;
  raise notice 'PASS 6  oldest expiry first — the person locked out longest is freed first';
end $$;

rollback;
