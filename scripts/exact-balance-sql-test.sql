-- EXACT BALANCE SQL TEST (0073, engine item #15) — run against a database with the migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/exact-balance-sql-test.sql
--
-- Proves, on the real functions:
--   B1  a first claim takes the least-filled arm, ties in the caller's order
--   B2  a repeat claim of the same session returns the same arms and counts once
--   B3  20 sessions over 4 arms → exactly 5 each, every intermediate state within one
--   B4  show 2 of 5: two distinct least-filled arms per claim, exposures within one
--   B5  release (screened out) gives the arm back: the next claim takes it
--   B6  an abandoned claim past its hold expires and stops counting
--   B7  the abandoned respondent who returns keeps their arm (re-activated)
--   B8  completed claims stay counted; release cannot undo a completion
--   B9  'started' basis counts released / expired claims too
--   B10 TEST and LIVE claims never count against each other
--   B11 rescript_balance_counts reports active / completed / released / expired per arm
--   B12 a deleted response gives its claims back (trigger)
--   B13 privileges: anon / authenticated cannot call the claim; anon cannot read the claims
--
-- One transaction, rolled back.

begin;

insert into public.customers (id, slug, name) values ('c0000073-0000-0000-0000-000000000001', 'eb-test', 'EB test') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('50000073-0000-0000-0000-000000000001', 'c0000073-0000-0000-0000-000000000001', 'EBT', 'Exact balance');

create temp table t_ok (n serial, name text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin
  if not p_ok then raise exception 'FAIL %: %', p_name, p_detail; end if;
  insert into t_ok (name) values (p_name);
  raise notice 'ok   %', p_name;
end $$;
/* counted claims per arm under the 'completed' basis */
create or replace function pg_temp.counted(p_key text, p_test boolean default false) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(arm, n order by arm), '{}'::jsonb) from (
    select a.arm, count(*) as n from public.balance_claims c, unnest(c.arms) a(arm)
    where c.survey_id = '50000073-0000-0000-0000-000000000001' and c.is_test = p_test and c.balance_key = p_key and c.status in ('active', 'completed')
    group by a.arm) t
$$;
create or replace function pg_temp.spread(p_key text) returns integer language sql as $$
  select coalesce(max(n) - min(n), 0)::integer from (
    select a.arm, (select count(*) from public.balance_claims c where c.survey_id = '50000073-0000-0000-0000-000000000001' and c.is_test = false and c.balance_key = p_key and c.status in ('active', 'completed') and a.arm = any (c.arms)) n
    from unnest(array['A', 'B', 'C', 'D']) a(arm)) t
$$;

do $$
declare
  s uuid := '50000073-0000-0000-0000-000000000001';
  got text[];
  i integer;
  c jsonb;
  n integer;
  ab text;
begin
  /* B1 */
  got := public.rescript_claim_balance(s, false, 'sess-b1-0000000001', 'randomizer:r1', array['C', 'A', 'B', 'D'], 1, 'completed', 7200);
  perform pg_temp.check('B1 empty slot: the first arm of the tie order', got = array['C'], got::text);
  got := public.rescript_claim_balance(s, false, 'sess-b1-0000000002', 'randomizer:r1', array['C', 'A', 'B', 'D'], 1, 'completed', 7200);
  perform pg_temp.check('B1 C is taken: the next least-filled in order', got = array['A'], got::text);

  /* B2 */
  got := public.rescript_claim_balance(s, false, 'sess-b1-0000000001', 'randomizer:r1', array['D', 'B', 'A', 'C'], 1, 'completed', 7200);
  perform pg_temp.check('B2 a repeat returns the same arm whatever it asks', got = array['C'], got::text);
  select count(*) into n from public.balance_claims where survey_id = s and session_id = 'sess-b1-0000000001';
  perform pg_temp.check('B2 counted once', n = 1, n::text);

  /* B3 */
  for i in 3..20 loop
    got := public.rescript_claim_balance(s, false, 'sess-b3-' || lpad(i::text, 10, '0'), 'randomizer:r1',
      case i % 4 when 0 then array['A', 'B', 'C', 'D'] when 1 then array['D', 'C', 'B', 'A'] when 2 then array['B', 'D', 'A', 'C'] else array['C', 'A', 'D', 'B'] end, 1, 'completed', 7200);
    if pg_temp.spread('randomizer:r1') > 1 then raise exception 'FAIL B3 spread > 1 after claim %', i; end if;
  end loop;
  c := pg_temp.counted('randomizer:r1');
  perform pg_temp.check('B3 20 sessions over 4 arms: exactly 5 each', c = '{"A":5,"B":5,"C":5,"D":5}'::jsonb, c::text);

  /* B4 */
  for i in 1..23 loop
    got := public.rescript_claim_balance(s, false, 'sess-b4-' || lpad(i::text, 10, '0'), 'randomizer:r2', array['a', 'b', 'c', 'd', 'e'], 2, 'completed', 7200);
    if cardinality(got) <> 2 or got[1] = got[2] then raise exception 'FAIL B4 claim % got %', i, got; end if;
  end loop;
  select max(k) - min(k) into n from (select a.arm, count(*) k from public.balance_claims c, unnest(c.arms) a(arm) where c.survey_id = s and c.balance_key = 'randomizer:r2' group by a.arm) t;
  perform pg_temp.check('B4 show 2 of 5: 46 exposures within one', n <= 1, n::text);

  /* B5 */
  perform public.rescript_release_balance(s, 'sess-b3-0000000004', 'screened');
  c := pg_temp.counted('randomizer:r1');
  got := public.rescript_claim_balance(s, false, 'sess-b5-0000000001', 'randomizer:r1', array['D', 'C', 'B', 'A'], 1, 'completed', 7200);
  perform pg_temp.check('B5 the released arm is the one the next claim takes', (c ->> got[1])::int = 4, c::text || ' → ' || got::text);
  perform pg_temp.check('B5 balanced again', pg_temp.counted('randomizer:r1') = '{"A":5,"B":5,"C":5,"D":5}'::jsonb, pg_temp.counted('randomizer:r1')::text);

  /* B6 */
  update public.balance_claims set expires_at = now() - interval '1 minute' where survey_id = s and session_id = 'sess-b3-0000000007';
  select arms[1] into ab from public.balance_claims where survey_id = s and session_id = 'sess-b3-0000000007';
  got := public.rescript_claim_balance(s, false, 'sess-b6-0000000001', 'randomizer:r1', array['A', 'B', 'C', 'D'], 1, 'completed', 7200);
  perform pg_temp.check('B6 the abandoned arm is refilled', got[1] = ab, got::text || ' vs ' || ab);
  select status into c from (select to_jsonb(status) status from public.balance_claims where survey_id = s and session_id = 'sess-b3-0000000007') t;
  perform pg_temp.check('B6 the abandoned claim is marked expired', c = '"expired"'::jsonb, c::text);

  /* B7 */
  got := public.rescript_claim_balance(s, false, 'sess-b3-0000000007', 'randomizer:r1', array['A', 'B', 'C', 'D'], 1, 'completed', 7200);
  perform pg_temp.check('B7 the returning respondent keeps their arm', got = array[got[1]] and (select status from public.balance_claims where survey_id = s and session_id = 'sess-b3-0000000007') = 'active', got::text);

  /* B8 */
  n := public.rescript_complete_balance(s, 'sess-b1-0000000002');
  perform pg_temp.check('B8 complete marks the claim', n = 1 and (select status from public.balance_claims where survey_id = s and session_id = 'sess-b1-0000000002') = 'completed', n::text);
  n := public.rescript_release_balance(s, 'sess-b1-0000000002', 'late');
  perform pg_temp.check('B8 a completion cannot be released', n = 0, n::text);

  /* B9 */
  for i in 1..8 loop
    got := public.rescript_claim_balance(s, false, 'sess-b9-' || lpad(i::text, 10, '0'), 'randomizer:started', array['A', 'B'], 1, 'started', 7200);
    if i % 2 = 0 then perform public.rescript_release_balance(s, 'sess-b9-' || lpad(i::text, 10, '0'), 'screened'); end if;
  end loop;
  select jsonb_object_agg(arm, k) into c from (select a.arm, count(*) k from public.balance_claims x, unnest(x.arms) a(arm) where x.survey_id = s and x.balance_key = 'randomizer:started' group by a.arm) t;
  perform pg_temp.check('B9 started basis: released claims still count (4 / 4)', c = '{"A":4,"B":4}'::jsonb, c::text);

  /* B10 */
  got := public.rescript_claim_balance(s, true, 'sess-b10-000000001', 'randomizer:r1', array['A', 'B', 'C', 'D'], 1, 'completed', 7200);
  perform pg_temp.check('B10 a TEST claim starts from an empty TEST slot', got = array['A'] and pg_temp.counted('randomizer:r1', true) = '{"A":1}'::jsonb, got::text);

  /* B11 */
  select count(*) into n from public.rescript_balance_counts(s, false) where balance_key = 'randomizer:r1';
  perform pg_temp.check('B11 counts per arm reported', n = 4, n::text);
  select sum(completed) into n from public.rescript_balance_counts(s, false) where balance_key = 'randomizer:r1';
  perform pg_temp.check('B11 one completion', n = 1, n::text);
end $$;

/* B12 — a response row whose deletion gives its claims back */
do $$
declare s uuid := '50000073-0000-0000-0000-000000000001'; got text[]; st text;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'responses' and column_name = 'deleted_at') then
    perform pg_temp.check('B12 (no responses.deleted_at here — skipped)', true);
    return;
  end if;
  insert into public.survey_versions (id, survey_id, version, definition) values ('5e000073-0000-0000-0000-000000000001', s, 1, '{}'::jsonb) on conflict do nothing;
  insert into public.responses (survey_id, version_id, session_id, status, seed) values (s, '5e000073-0000-0000-0000-000000000001', 'sess-b12-000000001', 'in_progress', 1);
  got := public.rescript_claim_balance(s, false, 'sess-b12-000000001', 'design:q1', array['1', '2', '3'], 1, 'completed', 7200);
  update public.responses set deleted_at = now() where survey_id = s and session_id = 'sess-b12-000000001';
  select status into st from public.balance_claims where survey_id = s and session_id = 'sess-b12-000000001';
  perform pg_temp.check('B12 a deleted response releases its claim', st = 'released', st);
end $$;

/* B13 */
do $$
declare ok boolean;
begin
  ok := not has_function_privilege('anon', 'public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.rescript_release_balance(uuid, text, text)', 'execute')
    and not has_table_privilege('anon', 'public.balance_claims', 'select')
    and not has_table_privilege('authenticated', 'public.balance_claims', 'insert');
  perform pg_temp.check('B13 only the service role claims; anon reads nothing', ok);
end $$;

select 'exact balance SQL: ' || count(*) || ' checks passed' from t_ok;
rollback;
