-- WEIGHTED EXACT BALANCE SQL TEST (0079, S4c RA-05) — run against a database with the migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/weighted-balance-sql-test.sql
--
--   W1  weights 2:1:1, 400 claims of one arm → exactly 200 / 100 / 100, and after EVERY claim each arm is within
--       one claim of its target share (weight / total × claims so far)
--   W2  the first claims follow (n + ½) / weight with ties in the caller's order: A, B, C, A (weights 2:1:1)
--   W3  show 2 of 4 with weights 3:1:1:1: two distinct arms per claim; after 300 claims exposures 300/100/100/100
--   W4  no p_weights (an 0073-style call, named arguments) = the unweighted least-filled claim
--   W5  one weight per arm, or the claim refuses
--   W6  privileges: anon / authenticated cannot call the 9-argument claim
--
-- One transaction, rolled back.

begin;

insert into public.customers (id, slug, name) values ('c0000079-0000-0000-0000-000000000001', 'wb-test', 'WB test') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('50000079-0000-0000-0000-000000000001', 'c0000079-0000-0000-0000-000000000001', 'WBT', 'Weighted balance');

create temp table t_ok (n serial, name text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin
  if not p_ok then raise exception 'FAIL %: %', p_name, p_detail; end if;
  insert into t_ok (name) values (p_name);
  raise notice 'ok   %', p_name;
end $$;
create or replace function pg_temp.counted(p_key text) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(arm, n order by arm), '{}'::jsonb) from (
    select a.arm, count(*) as n from public.balance_claims c, unnest(c.arms) a(arm)
    where c.survey_id = '50000079-0000-0000-0000-000000000001' and c.balance_key = p_key and c.status in ('active', 'completed')
    group by a.arm) t
$$;

/* W1 + W2 */
do $$
declare s uuid := '50000079-0000-0000-0000-000000000001'; i int; got text[]; c jsonb; first4 text := ''; worst numeric := 0; d numeric;
begin
  for i in 1..400 loop
    got := public.rescript_claim_balance(s, false, 'sess-w1-' || lpad(i::text, 6, '0'), 'w1', array['A','B','C'], 1, 'completed', 7200, array[2,1,1]::numeric[]);
    if i <= 4 then first4 := first4 || got[1]; end if;
    c := pg_temp.counted('w1');
    d := greatest(abs(coalesce((c->>'A')::numeric, 0) - i * 0.5), abs(coalesce((c->>'B')::numeric, 0) - i * 0.25), abs(coalesce((c->>'C')::numeric, 0) - i * 0.25));
    worst := greatest(worst, d);
  end loop;
  perform pg_temp.check('W1 2:1:1 over 400 → 200/100/100', c = '{"A":200,"B":100,"C":100}'::jsonb, c::text);
  perform pg_temp.check('W1 every prefix within one claim of its target', worst <= 1, worst::text);
  perform pg_temp.check('W2 first claims follow (n + 1/2) / weight: ABCA', first4 = 'ABCA', first4);
end $$;

/* W3 */
do $$
declare s uuid := '50000079-0000-0000-0000-000000000001'; i int; got text[]; c jsonb; bad int := 0;
begin
  for i in 1..300 loop
    got := public.rescript_claim_balance(s, false, 'sess-w3-' || lpad(i::text, 6, '0'), 'w3', array['A','B','C','D'], 2, 'completed', 7200, array[3,1,1,1]::numeric[]);
    if cardinality(got) <> 2 or got[1] = got[2] then bad := bad + 1; end if;
  end loop;
  c := pg_temp.counted('w3');
  perform pg_temp.check('W3 two distinct arms per claim', bad = 0, bad::text);
  perform pg_temp.check('W3 3:1:1:1 show 2 → 300/100/100/100', c = '{"A":300,"B":100,"C":100,"D":100}'::jsonb, c::text);
end $$;

/* W4 */
do $$
declare s uuid := '50000079-0000-0000-0000-000000000001'; i int; got text[]; c jsonb;
begin
  for i in 1..12 loop
    got := public.rescript_claim_balance(p_survey => s, p_test => false, p_session => 'sess-w4-' || lpad(i::text, 6, '0'), p_key => 'w4', p_arms => array['A','B','C'], p_count => 1, p_basis => 'completed', p_hold_seconds => 7200);
  end loop;
  c := pg_temp.counted('w4');
  perform pg_temp.check('W4 no weights = least filled (4/4/4)', c = '{"A":4,"B":4,"C":4}'::jsonb, c::text);
end $$;

/* W5 */
do $$
declare s uuid := '50000079-0000-0000-0000-000000000001'; refused boolean := false;
begin
  begin
    perform public.rescript_claim_balance(s, false, 'sess-w5-000001', 'w5', array['A','B'], 1, 'completed', 7200, array[1]::numeric[]);
  exception when others then refused := sqlerrm like '%one weight per arm%';
  end;
  perform pg_temp.check('W5 a weight per arm or nothing', refused);
end $$;

/* W6 */
do $$
begin
  perform pg_temp.check('W6 only the service role claims (9-argument signature)',
    not has_function_privilege('anon', 'public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer, numeric[])', 'execute')
    and not has_function_privilege('authenticated', 'public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer, numeric[])', 'execute')
    and (select count(*) from pg_proc where proname = 'rescript_claim_balance') = 1);
end $$;

select 'weighted balance SQL: ' || count(*) || ' checks passed' from t_ok;
rollback;
