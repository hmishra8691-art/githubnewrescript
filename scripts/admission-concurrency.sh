#!/usr/bin/env bash
# ADMISSION ACCESS TOKENS — CONCURRENCY (migration 0084).
#
#   scripts/admission-concurrency.sh <database-url-or-name> [attempts]
#
# The brief's §22 asks for replay protection on the token standing between the gateway's decision and the
# survey session. "Single use" is a claim about CONCURRENCY — a script firing the same token at the runtime
# twenty times in the same instant is precisely the attack — and a single-transaction SQL test cannot make it,
# because the transaction never races itself.
#
# The guarantee is the conditional update inside `rescript_admission_redeem`: `where redeemed_at is null`
# means simultaneous redemptions contend in the database and exactly one of them updates a row. Everything
# else is told `already_used`.
#
# Follows scripts/rtid-concurrency.sh. Exits non-zero on any failure.
set -uo pipefail

DB="${1:-}"
N="${2:-20}"
if [ -z "$DB" ]; then echo "usage: $0 <database-url-or-name> [attempts]" >&2; exit 2; fi

PSQL=(psql "$DB" -v ON_ERROR_STOP=1 -tA -q)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CUST=c0000000-0000-0000-0000-0000000000d1
USER_ID=c00000d1-0000-0000-0000-000000000001
SURVEY=c0000000-0000-0000-0000-0000000001d1
TRUST=c00000d1-0000-0000-0000-00000000000a
HASH=$(printf 'admission-concurrency' | sha256sum | cut -c1-64)

cleanup() {
  psql "$DB" -tA -q <<SQL >/dev/null 2>&1
delete from public.survey_access_tokens where survey_id = '$SURVEY';
delete from public.admission_decisions where survey_id = '$SURVEY';
delete from public.fraud_cases where survey_id = '$SURVEY';
delete from public.respondent_trust_ids where id = '$TRUST';
delete from public.surveys where id = '$SURVEY';
delete from public.profiles where id = '$USER_ID';
delete from public.customers where id = '$CUST';
delete from auth.users where id = '$USER_ID';
SQL
}

cleanup
if ! "${PSQL[@]}" <<SQL
insert into auth.users (id, email) values ('$USER_ID', 'admission-concurrency@example.test') on conflict (id) do nothing;
insert into public.customers (id, slug, name) values ('$CUST', 'admission-concurrency', 'Admission concurrency') on conflict (id) do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('$USER_ID', '$CUST', 'admission-concurrency@example.test', 'Concurrency', 'programmer') on conflict (id) do nothing;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('$SURVEY', '$CUST', 'ADMC', 'Admission concurrency', '$USER_ID') on conflict (id) do nothing;
insert into public.respondent_trust_ids (id, customer_id, trust_id)
  values ('$TRUST', '$CUST', 'rtid_admissionconc0001') on conflict (id) do nothing;
insert into public.survey_access_tokens (customer_id, survey_id, trust_id, token_hash, expires_at)
  values ('$CUST', '$SURVEY', '$TRUST', '$HASH', now() + interval '15 minutes');
SQL
then echo "FAIL: could not create fixtures" >&2; cleanup; exit 1; fi

echo "firing $N simultaneous redemptions of one access token…"
for i in $(seq 1 "$N"); do
  # `case` rather than `ok || ':' || reason`: boolean||text casts to "true"/"false", not psql's displayed t/f
  "${PSQL[@]}" -c "select case when ok then 'OK' else 'NO' end || ':' || reason from public.rescript_admission_redeem('$HASH', '$SURVEY', 'sess-$i', null);" \
    >> "$TMP/out" 2>&1 &
done
wait

OK=$(grep -c '^OK:redeemed$' "$TMP/out" || true)
USED=$(grep -c '^NO:already_used$' "$TMP/out" || true)
ERRORS=$(grep -ci error "$TMP/out" || true)
ROWS=$("${PSQL[@]}" -c "select count(*) from public.survey_access_tokens
         where survey_id = '$SURVEY' and redeemed_at is not null;")
SESSIONS=$("${PSQL[@]}" -c "select count(distinct redeemed_session) from public.survey_access_tokens
         where survey_id = '$SURVEY' and redeemed_session is not null;")

echo "redeemed=$OK already_used=$USED errors=$ERRORS redeemed_rows=$ROWS distinct_sessions=$SESSIONS"

FAIL=0
[ "$OK" = "1" ] || { echo "FAIL: the token was redeemed $OK times, expected exactly 1" >&2; FAIL=1; }
[ "$USED" = "$((N - 1))" ] || { echo "FAIL: $USED replays refused, expected $((N - 1))" >&2; FAIL=1; }
[ "$ERRORS" = "0" ] || { echo "FAIL: $ERRORS sessions errored — a replay must be refused cleanly, not blow up" >&2; FAIL=1; }
[ "$ROWS" = "1" ] || { echo "FAIL: $ROWS token rows marked redeemed" >&2; FAIL=1; }
[ "$SESSIONS" = "1" ] || { echo "FAIL: $SESSIONS sessions claimed the token" >&2; FAIL=1; }

cleanup
[ "$FAIL" = "0" ] && echo "PASS: exactly one of $N simultaneous redemptions succeeded; the rest were told already_used"
exit "$FAIL"
