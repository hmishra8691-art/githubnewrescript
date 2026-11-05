#!/usr/bin/env bash
# QUOTA COUNTING UNDER CONCURRENCY (migration 0088).
#
#   scripts/quota-concurrency.sh <database-url-or-name> [arrivals]
#
# Two respondents finishing into the last slot of a quota cell is the same race `participation_ledger` faced
# in 0083, and application-level counting loses it the same way: both read 499 of 500, both write 500, and the
# project has bought 501 completes for a cell that needed 500.
#
# A single-transaction SQL test cannot show this — the transaction never races itself. So this fires N
# genuinely parallel psql sessions at `rescript_quota_record` for one cell and asserts that the final count is
# exactly N: every complete counted once, none lost to a lost update.
#
# It also asserts the OVERSHOOT is reported, because over-recruitment is recorded rather than refused and a
# count that silently stopped at the target would hide completes somebody has already paid for.
set -uo pipefail

DB="${1:-}"
N="${2:-24}"
if [ -z "$DB" ]; then echo "usage: $0 <database-url-or-name> [arrivals]" >&2; exit 2; fi

PSQL=(psql "$DB" -v ON_ERROR_STOP=1 -tA -q)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CUST=a0000000-0000-0000-0000-0000000000a9
USER_ID=a00000a9-0000-0000-0000-000000000001
SRV=a0000000-0000-0000-0000-0000000001a9
PROJ=a0000000-0000-0000-0000-0000000004a9

cleanup() {
  psql "$DB" -tA -q <<SQL >/dev/null 2>&1
delete from public.quota_progress where recruitment_project_id = '$PROJ';
delete from public.recruitment_projects where id = '$PROJ';
delete from public.surveys where id = '$SRV';
delete from public.profiles where id = '$USER_ID';
delete from public.customers where id = '$CUST';
delete from auth.users where id = '$USER_ID';
SQL
}

cleanup
if ! "${PSQL[@]}" <<SQL
insert into auth.users (id, email) values ('$USER_ID', 'quota-conc@example.test') on conflict (id) do nothing;
insert into public.customers (id, slug, name) values ('$CUST', 'quota-conc', 'Quota concurrency') on conflict (id) do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('$USER_ID', '$CUST', 'quota-conc@example.test', 'Researcher', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('$SRV', '$CUST', 'QCONC', 'Quota concurrency', '$USER_ID') on conflict (id) do nothing;
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_currency, status)
  values ('$PROJ', '$CUST', '$SRV', 1000, 10000, 'GBP', 'fielding') on conflict (id) do nothing;
select public.rescript_quota_sync('$PROJ', '[{"id":"c1","label":"Male","dimension":"gender","criteria":{"gender":"male"},"targetCompletes":5}]'::jsonb);
SQL
then echo "FAIL: could not create fixtures" >&2; cleanup; exit 1; fi

echo "firing $N simultaneous completes into one cell with a target of 5…"
for _ in $(seq 1 "$N"); do
  "${PSQL[@]}" -c \
    "select counted from public.rescript_quota_record('$PROJ', '{\"gender\":\"male\"}'::jsonb);" \
    >> "$TMP/out" 2>&1 &
done
wait

COUNTED=$(grep -c '^1$' "$TMP/out" || true)
ERRORS=$(grep -ci error "$TMP/out" || true)
FINAL=$("${PSQL[@]}" -c "select accepted from public.quota_progress where recruitment_project_id = '$PROJ' and cell_id = 'c1';")

echo "recorded=$COUNTED errors=$ERRORS final_count=$FINAL target=5"

FAIL=0
[ "$ERRORS" = "0" ] || { echo "FAIL: $ERRORS sessions errored" >&2; FAIL=1; }
[ "$COUNTED" = "$N" ] || { echo "FAIL: $COUNTED of $N completes were recorded" >&2; FAIL=1; }
[ "$FINAL" = "$N" ] || { echo "FAIL: the cell counted $FINAL of $N — a lost update dropped $((N - FINAL))" >&2; FAIL=1; }

cleanup
if [ "$FAIL" = "0" ]; then
  echo "PASS: all $N simultaneous completes counted exactly once; the overshoot past 5 is visible, not hidden"
fi
exit "$FAIL"
