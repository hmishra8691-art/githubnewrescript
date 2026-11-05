#!/bin/bash
# QUOTA HOLDS UNDER CONCURRENCY (migration 0089).
#
# Genuinely parallel psql processes, not a loop pretending. Three races:
#
#   1. one session, 24 simultaneous starts  — a respondent double-clicking, two tabs, a retried request.
#      Exactly one hold may be taken, or in_progress inflates and the cell closes early.
#   2. 24 sessions, each holding then completing — accepted must land on exactly 24 and in_progress on 0.
#      A lost update either way is a cell that reports the wrong number for the rest of the field period.
#   3. one session, a release and a completion at the same instant — the terminal save racing the sweep.
#      The slot may be given back once. Twice and in_progress goes under, closing nothing and hiding a real hold.
set -u
export PGHOST=/tmp PGPORT=5433 PGUSER=postgres
DB=${DB:-rescript}
P=c0000000-0000-0000-0000-0000000009c1
C=c0000000-0000-0000-0000-0000000000c1
U=c00000c1-0000-0000-0000-000000000001
S=c0000000-0000-0000-0000-0000000001c1
q() { psql -q -t -A -d "$DB" -c "$1"; }

q "delete from public.quota_holds where recruitment_project_id = '$P'" >/dev/null 2>&1
q "delete from public.recruitment_projects where id = '$P'" >/dev/null 2>&1
q "delete from public.surveys where id = '$S'" >/dev/null 2>&1
q "delete from public.profiles where id = '$U'" >/dev/null 2>&1
q "delete from public.customers where id = '$C'" >/dev/null 2>&1
q "delete from auth.users where id = '$U'" >/dev/null 2>&1

q "insert into auth.users (id, email) values ('$U','conc@example.test')" >/dev/null
q "insert into public.customers (id, slug, name) values ('$C','conc','Conc')" >/dev/null
q "insert into public.profiles (id, customer_id, email, full_name, role) values ('$U','$C','conc@example.test','R','researcher')" >/dev/null
q "insert into public.surveys (id, customer_id, code, title, owner_id) values ('$S','$C','CONC','Conc','$U')" >/dev/null
q "insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, status)
   values ('$P','$C','$S',1000,10000,'fielding')" >/dev/null
q "select public.rescript_quota_sync('$P', '[{\"id\":\"g1\",\"label\":\"Male\",\"dimension\":\"gender\",\"criteria\":{\"gender\":\"male\"},\"targetCompletes\":1000}]'::jsonb)" >/dev/null

fail=0

# ---------------------------------------------------------------- 1. one session, 24 starts
for i in $(seq 1 24); do
  psql -q -t -A -d "$DB" -c \
    "select held from public.rescript_quota_hold_session('$P','race-one','{\"gender\":\"male\"}'::jsonb)" \
    > "/tmp/h1-$i.out" 2>/dev/null &
done
wait
held=$(cat /tmp/h1-*.out | grep -c '^t$')
inprog=$(q "select in_progress from public.quota_progress where recruitment_project_id='$P' and cell_id='g1'")
rm -f /tmp/h1-*.out
if [ "$held" = "1" ] && [ "$inprog" = "1" ]; then
  echo "PASS 1  24 simultaneous starts, one session: 1 hold taken, in_progress = 1"
else
  echo "FAIL 1  holds reported=$held  in_progress=$inprog (both should be 1)"; fail=1
fi

# ---------------------------------------------------------------- 2. 24 sessions hold then complete
q "update public.quota_progress set in_progress = 0, accepted = 0 where recruitment_project_id='$P'" >/dev/null
q "delete from public.quota_holds where recruitment_project_id='$P'" >/dev/null
for i in $(seq 1 24); do
  psql -q -t -A -d "$DB" -c \
    "select public.rescript_quota_hold_session('$P','race-two-$i','{\"gender\":\"male\"}'::jsonb);
     select public.rescript_quota_complete_session('$P','race-two-$i','{\"gender\":\"male\"}'::jsonb)" \
    >/dev/null 2>&1 &
done
wait
acc=$(q "select accepted from public.quota_progress where recruitment_project_id='$P' and cell_id='g1'")
inprog=$(q "select in_progress from public.quota_progress where recruitment_project_id='$P' and cell_id='g1'")
if [ "$acc" = "24" ] && [ "$inprog" = "0" ]; then
  echo "PASS 2  24 parallel hold-then-complete: accepted = 24, in_progress = 0"
else
  echo "FAIL 2  accepted=$acc (want 24)  in_progress=$inprog (want 0)"; fail=1
fi

# ---------------------------------------------------------------- 3. release racing completion
q "update public.quota_progress set in_progress = 0, accepted = 0 where recruitment_project_id='$P'" >/dev/null
q "delete from public.quota_holds where recruitment_project_id='$P'" >/dev/null
q "select public.rescript_quota_hold_session('$P','race-three','{\"gender\":\"male\"}'::jsonb)" >/dev/null
for i in $(seq 1 12); do
  psql -q -t -A -d "$DB" -c \
    "select public.rescript_quota_release_session('race-three','abandoned')" >/dev/null 2>&1 &
  psql -q -t -A -d "$DB" -c \
    "select public.rescript_quota_complete_session('$P','race-three','{\"gender\":\"male\"}'::jsonb)" >/dev/null 2>&1 &
done
wait
inprog=$(q "select in_progress from public.quota_progress where recruitment_project_id='$P' and cell_id='g1'")
rel=$(q "select count(*) from public.quota_holds where session_id='race-three' and released_at is not null")
if [ "$inprog" = "0" ] && [ "$rel" = "1" ]; then
  echo "PASS 3  a sweep racing a terminal save releases the slot exactly once"
else
  echo "FAIL 3  in_progress=$inprog (want 0)  released rows=$rel (want 1)"; fail=1
fi

q "delete from public.quota_holds where recruitment_project_id = '$P'" >/dev/null 2>&1
q "delete from public.recruitment_projects where id = '$P'" >/dev/null 2>&1
q "delete from public.surveys where id = '$S'" >/dev/null 2>&1
q "delete from public.profiles where id = '$U'" >/dev/null 2>&1
q "delete from public.customers where id = '$C'" >/dev/null 2>&1
q "delete from auth.users where id = '$U'" >/dev/null 2>&1
exit $fail
