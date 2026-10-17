#!/usr/bin/env bash
# LIST FILL — concurrent allocate / re-allocate against caps (0061), with pgbench:
# 32 clients x 250 transactions on separate connections, 400 sessions that keep
# changing their minds (keep nothing / keep what they hold / claim afresh) while
# A and B are capped at 40 each and C is uncapped. Afterwards:
#   * no cap is exceeded
#   * every counter equals the number of ACTIVE allocations of its option
#   * no session holds more than one active claim of the list
# and a second run: 16 clients x 50 FIRST allocations of 2 items each, half
# preferring [A,B,C], half [B,A,C] (what random / least-filled orders do) —
# before 0061 this deadlocked (126 deadlocks, run never finished); now all 800
# complete, A and B land exactly on their caps of 300.
#
#   PGHOST=/tmp PGPORT=5432 PGUSER=postgres PGDATABASE=rs bash scripts/listfill-reallocate-concurrency.sh
set -euo pipefail
SURVEY=50000061-0000-0000-0000-0000000000cc
CUST=c0000061-0000-0000-0000-0000000000cc
psql -q -v ON_ERROR_STOP=1 <<SQL
delete from public.surveys where id = '$SURVEY';
insert into public.customers (id, slug, name) values ('$CUST', 'lf-conc', 'LF conc') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('$SURVEY', '$CUST', 'LFC', 'LF concurrency');
SQL
BENCH=$(mktemp)
cat > "$BENCH" <<SQL
\set sess random(1, 400)
\set mode random(0, 2)
\set first random(0, 1)
select * from public.rescript_reallocate_listfill(
  '$SURVEY'::uuid, false, 'cc', 'cc-session-' || :sess,
  case :mode when 0 then '[]'::jsonb
             when 1 then coalesce((select jsonb_agg(option_code) from public.listfill_allocations where session_id = 'cc-session-' || :sess and list_fill_id = 'cc' and released_at is null), '[]'::jsonb)
             else '["A"]'::jsonb end,
  case :first when 0 then '[{"code":"A","maximum":40},{"code":"B","maximum":40},{"code":"C"}]'::jsonb
              else '[{"code":"B","maximum":40},{"code":"A","maximum":40},{"code":"C"}]'::jsonb end,
  1, false, 'v1');
SQL
pgbench -n -c 32 -j 8 -t 250 -f "$BENCH" 2>&1 | grep -E "transactions actually processed|failed|aborted" || true
rm -f "$BENCH"
psql -At -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare bad integer; a integer; b integer;
begin
  select coalesce(max(allocated_count) filter (where option_code = 'A'), 0), coalesce(max(allocated_count) filter (where option_code = 'B'), 0)
    into a, b from public.listfill_counts where survey_id = '$SURVEY' and list_fill_id = 'cc';
  if a > 40 or b > 40 then raise exception 'FAIL cap exceeded: A=% B=%', a, b; end if;
  raise notice 'ok   caps hold (A=% / 40, B=% / 40)', a, b;
  select count(*) into bad from (
    select c.option_code, c.allocated_count, (select count(*) from public.listfill_allocations x where x.survey_id = c.survey_id and x.list_fill_id = 'cc' and x.option_code = c.option_code and x.released_at is null) as active
    from public.listfill_counts c where c.survey_id = '$SURVEY' and c.list_fill_id = 'cc') t
  where t.allocated_count <> t.active;
  if bad > 0 then raise exception 'FAIL % counters disagree with the active allocations', bad; end if;
  raise notice 'ok   every counter equals its active allocations';
  select count(*) into bad from (select session_id from public.listfill_allocations where survey_id = '$SURVEY' and released_at is null group by session_id having count(*) > 1) t;
  if bad > 0 then raise exception 'FAIL % sessions hold two claims', bad; end if;
  raise notice 'ok   no session holds two claims';
end \$\$;
select 'sessions: ' || count(distinct session_id) || ', rows: ' || count(*) || ', released as changed: ' || count(*) filter (where release_reason = 'changed') from public.listfill_allocations where survey_id = '$SURVEY';
delete from public.surveys where id = '$SURVEY';
SQL
psql -q -v ON_ERROR_STOP=1 -c "insert into public.surveys (id, customer_id, code, title) values ('$SURVEY', '$CUST', 'LFC', 'LF crossing orders')"
BENCH=$(mktemp)
cat > "$BENCH" <<SQL
\set sess random(1, 1000000000)
\set first random(0, 1)
select * from public.rescript_allocate_listfill('$SURVEY'::uuid, false, 'dd', 'dd-' || :sess,
  case :first when 0 then '[{"code":"A","maximum":300},{"code":"B","maximum":300},{"code":"C"}]'::jsonb
              else '[{"code":"B","maximum":300},{"code":"A","maximum":300},{"code":"C"}]'::jsonb end, 2, false, 'v1');
SQL
OUT=$(pgbench -n -c 16 -j 4 -t 50 -f "$BENCH" 2>&1 || true)
rm -f "$BENCH"
echo "$OUT" | grep -E "transactions actually processed|failed" || true
echo "$OUT" | grep -q "processed: 800/800" || { echo "FAIL crossing-order allocations did not all complete"; exit 1; }
psql -At -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare a integer; b integer;
begin
  select max(allocated_count) filter (where option_code = 'A'), max(allocated_count) filter (where option_code = 'B') into a, b
    from public.listfill_counts where survey_id = '$SURVEY' and list_fill_id = 'dd';
  if a <> 300 or b <> 300 then raise exception 'FAIL crossing orders: A=% B=% (want 300 each)', a, b; end if;
  raise notice 'ok   crossing preference orders: 800/800 allocations, A=300 B=300, no deadlock';
end \$\$;
delete from public.surveys where id = '$SURVEY';
SQL
