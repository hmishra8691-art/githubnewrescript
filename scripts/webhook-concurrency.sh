#!/usr/bin/env bash
# WEBHOOK DE-DUPLICATION UNDER CONCURRENCY (migration 0086).
#
#   scripts/webhook-concurrency.sh <database-url-or-name> [deliveries]
#
# Vendors deliver at least once and retry on timeout, so the same event id arrives more than once — and nothing
# stops two retries landing in the same instant. A single-transaction SQL test cannot show this: the
# transaction never races itself. So this fires N genuinely parallel psql sessions at `rescript_webhook_receive`
# with ONE event id and asserts that exactly one is told it is new.
#
# The guarantee comes from the unique index on (vendor_slug, event_id), contended in the database rather than in
# application code — the only place the race can actually be won. A "select then insert" in the route would lose
# it, and losing it means paying for the same complete twice.
#
# Follows scripts/rtid-concurrency.sh. Exits non-zero on any failure.
set -uo pipefail

DB="${1:-}"
N="${2:-24}"
if [ -z "$DB" ]; then echo "usage: $0 <database-url-or-name> [deliveries]" >&2; exit 2; fi

PSQL=(psql "$DB" -v ON_ERROR_STOP=1 -tA -q)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CUST=e0000000-0000-0000-0000-0000000000e9
USER_ID=e00000e9-0000-0000-0000-000000000001
VEND=e0000000-0000-0000-0000-0000000002e9
INTEG=e0000000-0000-0000-0000-0000000003e9
EVENT="evt_concurrent_$$"

cleanup() {
  psql "$DB" -tA -q <<SQL >/dev/null 2>&1
delete from public.vendor_webhook_receipts where event_id = '$EVENT';
delete from public.vendor_api_calls where integration_id = '$INTEG';
delete from public.vendor_integrations where id = '$INTEG';
delete from public.panel_vendors where id = '$VEND';
delete from public.profiles where id = '$USER_ID';
delete from public.customers where id = '$CUST';
delete from auth.users where id = '$USER_ID';
SQL
}

cleanup
if ! "${PSQL[@]}" <<SQL
insert into auth.users (id, email) values ('$USER_ID', 'wh-concurrency@example.test') on conflict (id) do nothing;
insert into public.customers (id, slug, name) values ('$CUST', 'wh-concurrency', 'Webhook concurrency') on conflict (id) do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('$USER_ID', '$CUST', 'wh-concurrency@example.test', 'Ops', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id;
insert into public.panel_vendors (id, name, slug, customer_id, status)
  values ('$VEND', 'Concurrency vendor', 'wh-conc-vendor', '$CUST', 'catalogue') on conflict (id) do nothing;
insert into public.vendor_integrations (id, customer_id, vendor_id, mode, enabled)
  values ('$INTEG', '$CUST', '$VEND', 'manual', true) on conflict (id) do nothing;
SQL
then echo "FAIL: could not create fixtures" >&2; cleanup; exit 1; fi

echo "firing $N simultaneous deliveries of ONE event id…"
for _ in $(seq 1 "$N"); do
  "${PSQL[@]}" -c \
    "select is_new from public.rescript_webhook_receive('$CUST', '$INTEG', 'prolific', '$EVENT', 'verified', null, '{\"n\":1}'::jsonb, 'stu_1', 'p1', now());" \
    >> "$TMP/out" 2>&1 &
done
wait

NEW=$(grep -c '^t$' "$TMP/out" || true)
DUP=$(grep -c '^f$' "$TMP/out" || true)
ERRORS=$(grep -ci error "$TMP/out" || true)
ROWS=$("${PSQL[@]}" -c "select count(*) from public.vendor_webhook_receipts where event_id = '$EVENT';")

echo "new=$NEW duplicate=$DUP errors=$ERRORS receipts=$ROWS"

FAIL=0
[ "$NEW" = "1" ] || { echo "FAIL: $NEW deliveries were treated as new, expected exactly 1" >&2; FAIL=1; }
[ "$DUP" = "$((N - 1))" ] || { echo "FAIL: $DUP reported duplicate, expected $((N - 1))" >&2; FAIL=1; }
[ "$ERRORS" = "0" ] || { echo "FAIL: $ERRORS sessions errored — a race must de-duplicate cleanly, not blow up" >&2; FAIL=1; }
[ "$ROWS" = "1" ] || { echo "FAIL: $ROWS receipts for one event id" >&2; FAIL=1; }

cleanup
if [ "$FAIL" = "0" ]; then
  echo "PASS: exactly one of $N simultaneous deliveries was new; the rest were recognised as retries"
fi
exit "$FAIL"
