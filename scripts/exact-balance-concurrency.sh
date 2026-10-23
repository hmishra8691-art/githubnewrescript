#!/usr/bin/env bash
# EXACT BALANCE under concurrency (0073, engine item #15), with pgbench:
#
#   run 1  48 clients × 125 FIRST claims each (6,000 sessions, all at once, show 1 of 4,
#          four different tie-break orders) → the four arms end within ONE of each other
#          (exactly 1,500 each), every session holds exactly one claim, 0 errors / deadlocks.
#          This is the "burst" that made snapshot least fill herd (spread 17 in bursts of 25):
#          the decision is inside the locked claim, so it cannot.
#   run 2  32 clients × 100 mixed operations on 600 sessions — claim (the same session again
#          = idempotent), release (screened out) and complete, in random order — then a final
#          claim from every released session's replacement: the COUNTED claims (active +
#          completed) stay within one, no session holds two claims of the slot.
#   run 3  show 2 of 5, 24 clients × 50 → exposures within one, never the same arm twice.
#
#   PGHOST=/tmp PGPORT=55573 PGUSER=postgres PGDATABASE=rs bash scripts/exact-balance-concurrency.sh
set -euo pipefail
SURVEY=50000073-0000-0000-0000-0000000000cc
CUST=c0000073-0000-0000-0000-0000000000cc
psql -q -v ON_ERROR_STOP=1 <<SQL
delete from public.surveys where id = '$SURVEY';
insert into public.customers (id, slug, name) values ('$CUST', 'eb-conc', 'EB conc') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('$SURVEY', '$CUST', 'EBC', 'Exact balance concurrency');
SQL
BENCH=$(mktemp)

echo "run 1: 48 clients x 125 first claims, show 1 of 4"
cat > "$BENCH" <<SQL
\set order random(0, 3)
select public.rescript_claim_balance('$SURVEY'::uuid, false, 'burst-' || :client_id || '-' || :scale || '-' || nextval('public.eb_conc_seq'), 'randomizer:r1',
  case :order when 0 then array['A','B','C','D'] when 1 then array['D','C','B','A'] when 2 then array['B','D','A','C'] else array['C','A','D','B'] end, 1, 'completed', 7200);
SQL
# a sequence for unique session ids across clients
psql -q -v ON_ERROR_STOP=1 -c "drop sequence if exists public.eb_conc_seq; create sequence public.eb_conc_seq;"
pgbench -n -c 48 -j 8 -t 125 -f "$BENCH" 2>&1 | grep -E "transactions actually processed|failed|aborted|deadlock" || true
psql -At -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare mx integer; mn integer; total integer; dup integer;
begin
  select max(n), min(n), sum(n) into mx, mn, total from (
    select a.arm, count(*) n from public.balance_claims c, unnest(c.arms) a(arm)
    where c.survey_id = '$SURVEY' and c.balance_key = 'randomizer:r1' and c.status in ('active','completed') group by a.arm) t;
  if total <> 6000 then raise exception 'FAIL run 1: % claims recorded, expected 6000', total; end if;
  if mx - mn > 1 then raise exception 'FAIL run 1: spread % (max % min %)', mx - mn, mx, mn; end if;
  raise notice 'ok   run 1: 6000 concurrent first claims, arms % .. % (spread %), no herding', mn, mx, mx - mn;
  select count(*) into dup from (select session_id from public.balance_claims where survey_id = '$SURVEY' and balance_key = 'randomizer:r1' group by session_id having count(*) > 1) t;
  if dup > 0 then raise exception 'FAIL run 1: % sessions hold two claims', dup; end if;
  raise notice 'ok   run 1: every session holds exactly one claim';
end \$\$;
SQL

echo "run 2: 32 clients x 100 mixed claim / release / complete on 600 sessions"
cat > "$BENCH" <<SQL
\set sess random(1, 600)
\set op random(0, 9)
\set order random(0, 3)
select case when :op < 6 then (public.rescript_claim_balance('$SURVEY'::uuid, false, 'mixed-session-' || :sess, 'randomizer:r2',
    case :order when 0 then array['A','B','C','D'] when 1 then array['D','C','B','A'] when 2 then array['B','D','A','C'] else array['C','A','D','B'] end, 1, 'completed', 7200))[1]
  when :op < 8 then public.rescript_release_balance('$SURVEY'::uuid, 'mixed-session-' || :sess, 'screened')::text
  else public.rescript_complete_balance('$SURVEY'::uuid, 'mixed-session-' || :sess)::text end;
SQL
pgbench -n -c 32 -j 8 -t 100 -f "$BENCH" 2>&1 | grep -E "transactions actually processed|failed|aborted|deadlock" || true
psql -At -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare mx integer; mn integer; dup integer; counted integer;
begin
  select coalesce(max(n), 0), coalesce(min(n), 0), coalesce(sum(n), 0) into mx, mn, counted from (
    select x.arm, (select count(*) from public.balance_claims c where c.survey_id = '$SURVEY' and c.balance_key = 'randomizer:r2' and c.status in ('active','completed') and x.arm = any (c.arms)) n
    from unnest(array['A','B','C','D']) x(arm)) t;
  /*
   * Releases after the last claim can leave a gap (a screened-out respondent gives an arm back and
   * nobody has claimed since). The guarantee is about the moment of each claim: re-claiming from
   * fresh sessions until every arm is level shows the claim always fills the gap first.
   */
  raise notice 'info run 2 before refill: counted % .. % (% claims counted)', mn, mx, counted;
  for i in 1..(mx - mn) * 4 loop
    perform public.rescript_claim_balance('$SURVEY'::uuid, false, 'refill-session-' || i, 'randomizer:r2', array['A','B','C','D'], 1, 'completed', 7200);
  end loop;
  select max(n), min(n) into mx, mn from (
    select x.arm, (select count(*) from public.balance_claims c where c.survey_id = '$SURVEY' and c.balance_key = 'randomizer:r2' and c.status in ('active','completed') and x.arm = any (c.arms)) n
    from unnest(array['A','B','C','D']) x(arm)) t;
  if mx - mn > 1 then raise exception 'FAIL run 2: after refilling, spread %', mx - mn; end if;
  raise notice 'ok   run 2: claims refill released arms first — counted % .. % (spread %)', mn, mx, mx - mn;
  select count(*) into dup from (select session_id from public.balance_claims where survey_id = '$SURVEY' and balance_key = 'randomizer:r2' group by session_id having count(*) > 1) t;
  if dup > 0 then raise exception 'FAIL run 2: % sessions hold two claims', dup; end if;
  raise notice 'ok   run 2: no session holds two claims (idempotent under concurrent repeats)';
end \$\$;
SQL

echo "run 3: show 2 of 5, 24 clients x 50"
cat > "$BENCH" <<SQL
select public.rescript_claim_balance('$SURVEY'::uuid, false, 'pair-' || nextval('public.eb_conc_seq'), 'randomizer:r3', array['a','b','c','d','e'], 2, 'completed', 7200);
SQL
pgbench -n -c 24 -j 8 -t 50 -f "$BENCH" 2>&1 | grep -E "transactions actually processed|failed|aborted|deadlock" || true
psql -At -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare mx integer; mn integer; bad integer;
begin
  select max(n), min(n) into mx, mn from (select a.arm, count(*) n from public.balance_claims c, unnest(c.arms) a(arm) where c.survey_id = '$SURVEY' and c.balance_key = 'randomizer:r3' group by a.arm) t;
  if mx - mn > 1 then raise exception 'FAIL run 3: spread %', mx - mn; end if;
  select count(*) into bad from public.balance_claims where survey_id = '$SURVEY' and balance_key = 'randomizer:r3' and (cardinality(arms) <> 2 or arms[1] = arms[2]);
  if bad > 0 then raise exception 'FAIL run 3: % claims without two distinct arms', bad; end if;
  raise notice 'ok   run 3: 1200 claims of 2 arms, exposures % .. % (spread %)', mn, mx, mx - mn;
end \$\$;
delete from public.surveys where id = '$SURVEY';
drop sequence if exists public.eb_conc_seq;
SQL
rm -f "$BENCH"
echo "exact balance concurrency: all runs passed"
