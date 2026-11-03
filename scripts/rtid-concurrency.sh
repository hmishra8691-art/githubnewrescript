#!/usr/bin/env bash
# RESPONDENT TRUST ID — CONCURRENCY (migration 0083).
#
#   scripts/rtid-concurrency.sh <database-url-or-name> [arrivals]
#
# The brief's §14 asks that "a participant should never receive two accepted completes for the same project,
# even when two vendors send recruitment requests simultaneously". That is a claim about CONCURRENCY, and a
# single-transaction SQL test cannot make it: the transaction never races itself. So this fires N genuinely
# parallel psql sessions at `rescript_rtid_reserve` for one person in one project and asserts that exactly one
# of them is admitted.
#
# The guarantee comes from `participation_ledger_live_uniq`, a partial unique index over
# (survey_id, trust_id) where the state is live and the row is not a shadow observation. Concurrent inserts
# contend on it in the database, not in application code, which is the only place the race can actually be won.
#
# Follows scripts/exact-balance-concurrency.sh. Exits non-zero on any failure.
set -uo pipefail

DB="${1:-}"
N="${2:-24}"
if [ -z "$DB" ]; then echo "usage: $0 <database-url-or-name> [arrivals]" >&2; exit 2; fi

PSQL=(psql "$DB" -v ON_ERROR_STOP=1 -tA -q)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CUST=c0000000-0000-0000-0000-0000000000c1
USER_ID=c00000c1-0000-0000-0000-000000000001
SURVEY=c0000000-0000-0000-0000-0000000001c1
TRUST=c00000c1-0000-0000-0000-00000000000a

# Cleanup must survive a half-created fixture set from an interrupted run, so it runs WITHOUT ON_ERROR_STOP:
# one delete failing (a foreign key that something else still holds) must not stop the rest.
cleanup_fixtures() {
  psql "$DB" -tA -q <<SQL >/dev/null 2>&1
delete from public.identity_match_events where survey_id = '$SURVEY';
delete from public.participation_ledger where survey_id = '$SURVEY';
delete from public.respondent_trust_ids where id = '$TRUST';
delete from public.surveys where id = '$SURVEY';
delete from public.profiles where id = '$USER_ID';
delete from public.customers where id = '$CUST';
delete from auth.users where id = '$USER_ID';
SQL
}

cleanup_fixtures
if ! "${PSQL[@]}" <<SQL
insert into auth.users (id, email) values ('$USER_ID', 'rtid-concurrency@example.test') on conflict (id) do nothing;
insert into public.customers (id, slug, name) values ('$CUST', 'rtid-concurrency', 'RTID concurrency') on conflict (id) do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('$USER_ID', '$CUST', 'rtid-concurrency@example.test', 'Concurrency', 'programmer') on conflict (id) do nothing;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('$SURVEY', '$CUST', 'RTIDC', 'RTID concurrency', '$USER_ID') on conflict (id) do nothing;
insert into public.respondent_trust_ids (id, customer_id, trust_id)
  values ('$TRUST', '$CUST', 'rtid_concurrency000001') on conflict (id) do nothing;
SQL
then echo "FAIL: could not create fixtures" >&2; cleanup_fixtures; exit 1; fi

echo "firing $N concurrent arrivals for one person at one project (enforce mode)…"
for _ in $(seq 1 "$N"); do
  "${PSQL[@]}" -c \
    "select reserved from public.rescript_rtid_reserve('$CUST', '$SURVEY', '$TRUST', null, 'enforce', 3600);" \
    >> "$TMP/out" 2>&1 &
done
wait

ADMITTED=$(grep -c '^t$' "$TMP/out" || true)
REFUSED=$(grep -c '^f$' "$TMP/out" || true)
ERRORS=$(grep -ci error "$TMP/out" || true)
LIVE=$("${PSQL[@]}" -c "select count(*) from public.participation_ledger
         where survey_id = '$SURVEY' and trust_id = '$TRUST' and not shadow
           and state in ('invited','verification_pending','eligible','reserved','in_survey','completed');")
DUPES=$("${PSQL[@]}" -c "select count(*) from public.identity_match_events
         where survey_id = '$SURVEY' and kind = 'duplicate';")

echo "admitted=$ADMITTED refused=$REFUSED errors=$ERRORS live_ledger_rows=$LIVE duplicate_events=$DUPES"

FAIL=0
[ "$ADMITTED" = "1" ] || { echo "FAIL: $ADMITTED arrivals were admitted, expected exactly 1" >&2; FAIL=1; }
[ "$REFUSED" = "$((N - 1))" ] || { echo "FAIL: $REFUSED refused, expected $((N - 1))" >&2; FAIL=1; }
[ "$ERRORS" = "0" ] || { echo "FAIL: $ERRORS sessions errored — a race must refuse cleanly, not blow up" >&2; FAIL=1; }
[ "$LIVE" = "1" ] || { echo "FAIL: $LIVE live participations for one person in one project" >&2; FAIL=1; }
[ "$DUPES" = "$((N - 1))" ] || { echo "FAIL: $DUPES duplicate events, expected $((N - 1))" >&2; FAIL=1; }

cleanup_fixtures
if [ "$FAIL" = "0" ]; then
  echo "PASS: exactly one of $N simultaneous arrivals took the place; the rest were refused and recorded"
fi
exit "$FAIL"
