-- AUDIT FIXES SQL TEST (migration 0034) — run against a database with the
-- migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/audit-fixes-sql-test.sql
--
-- Proves the three findings from docs/STUDIO-BUG-AUDIT.md that could only be
-- closed in the database:
--
--   2. removing a collaborator removes them, instead of returning them to the
--      workspace baseline (which is `editor`)
--   4. a retried settle debits the wallet once, not twice
--   5. an expired reservation is released, and its hold comes off the wallet
--
-- …and the ONE that is proven by its failure: the `ON CONFLICT (survey_id,
-- email)` the invitation route used cannot be satisfied by the partial
-- expression index that exists, which is why that route now selects first.
--
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name)
  values ('a0000000-0000-0000-0000-000000000001', 'audit', 'Audit Fixes')
on conflict do nothing;

/* the signup trigger makes the profile (and, left alone, a workspace of its
   own); both people are then moved into the one workspace this test is about */
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaa1-0000-0000-0000-000000000001', 'owner@audit.test', '{"full_name":"Owner"}'::jsonb),
  ('aaaaaaa1-0000-0000-0000-000000000002', 'colleague@audit.test', '{"full_name":"Colleague"}'::jsonb)
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role)
  values
    ('aaaaaaa1-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'owner@audit.test', 'Owner', 'programmer'),
    ('aaaaaaa1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'colleague@audit.test', 'Colleague', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id, email = excluded.email;

insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'AUD1', 'Audit project', 'aaaaaaa1-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

-- ============================================== 2. REMOVAL REMOVES

do $$
declare a record; n integer;
begin
  -- the baseline this whole finding turns on: nothing configured means editor
  assert public.rescript_workspace_default_role('a0000000-0000-0000-0000-000000000001') = 'editor',
    'the workspace default is editor when unset — if this changes, finding 2 changes with it';

  -- shared explicitly as viewer
  insert into public.project_members (survey_id, user_id, role, added_by)
  values ('a0000000-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000002', 'viewer', 'aaaaaaa1-0000-0000-0000-000000000001')
  on conflict (survey_id, user_id) do update set role = 'viewer', revoked_at = null;

  select * into a from public.rescript_project_access('aaaaaaa1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002');
  assert a.project_role = 'viewer' and a.role_source = 'member', 'an explicit share wins over the baseline';

  -- THE OLD BEHAVIOUR: deleting the row hands them the workspace default
  delete from public.project_members
   where survey_id = 'a0000000-0000-0000-0000-000000000002' and user_id = 'aaaaaaa1-0000-0000-0000-000000000002';
  select * into a from public.rescript_project_access('aaaaaaa1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002');
  assert a.project_role = 'editor' and a.role_source = 'workspace',
    'DELETE promotes a removed viewer to editor — this is the bug the route no longer commits';

  -- THE NEW BEHAVIOUR: the removal is written down, and it is obeyed
  insert into public.project_members (survey_id, user_id, role, added_by, revoked_at, revoked_by)
  values ('a0000000-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000002', 'viewer',
          'aaaaaaa1-0000-0000-0000-000000000001', now(), 'aaaaaaa1-0000-0000-0000-000000000001');
  select * into a from public.rescript_project_access('aaaaaaa1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002');
  assert a.project_role is null and a.role_source = 'revoked',
    'a revoked row outranks the workspace baseline: got ' || coalesce(a.project_role, 'null') || '/' || a.role_source;

  -- and they are not a collaborator any more, on the panel or the dashboard
  select count(*) into n from public.rescript_project_members('a0000000-0000-0000-0000-000000000002', 60)
   where user_id = 'aaaaaaa1-0000-0000-0000-000000000002';
  assert n = 0, 'a revoked member is off the collaborator panel';
  select collaborators into n from public.rescript_my_projects('aaaaaaa1-0000-0000-0000-000000000001', 180)
   where survey_id = 'a0000000-0000-0000-0000-000000000002';
  assert n = 0, 'and out of the dashboard count';

  -- re-sharing them is a grant again
  update public.project_members set role = 'editor', revoked_at = null, revoked_by = null
   where survey_id = 'a0000000-0000-0000-0000-000000000002' and user_id = 'aaaaaaa1-0000-0000-0000-000000000002';
  select * into a from public.rescript_project_access('aaaaaaa1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002');
  assert a.project_role = 'editor' and a.role_source = 'member', 'clearing the mark lets them back in';

  -- and an invitation accepted after a removal re-grants rather than doing nothing
  update public.project_members set revoked_at = now()
   where survey_id = 'a0000000-0000-0000-0000-000000000002' and user_id = 'aaaaaaa1-0000-0000-0000-000000000002';
  insert into public.project_invitations (survey_id, email, role, token, invited_by)
  values ('a0000000-0000-0000-0000-000000000002', 'colleague@audit.test', 'reviewer', gen_random_uuid()::text, 'aaaaaaa1-0000-0000-0000-000000000001');
  perform public.rescript_claim_invitations('aaaaaaa1-0000-0000-0000-000000000002');
  select * into a from public.rescript_project_access('aaaaaaa1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002');
  assert a.project_role = 'reviewer' and a.role_source = 'member',
    'claiming an invitation clears the revocation: got ' || coalesce(a.project_role, 'null') || '/' || a.role_source;
  raise notice 'finding 2: removal removes, and re-granting works — OK';
end $$;

-- ================================ 1. WHY THE INVITATION UPSERT COULD NOT WORK

do $$
declare msg text;
begin
  begin
    insert into public.project_invitations (survey_id, email, role, token, invited_by)
    values ('a0000000-0000-0000-0000-000000000002', 'someone@audit.test', 'viewer', gen_random_uuid()::text, 'aaaaaaa1-0000-0000-0000-000000000001')
    on conflict (survey_id, email) do nothing;
    assert false, 'ON CONFLICT (survey_id, email) unexpectedly resolved — has a plain unique constraint been added?';
  exception when others then
    msg := sqlerrm;
  end;
  assert msg like '%no unique or exclusion constraint%',
    'the expected schema error, got: ' || msg;
  -- …and it contains the word the route used to match on, which is how a hard
  -- schema failure became "That address has already been invited".
  assert msg like '%unique%', 'and it contains "unique" — see share/route.ts';
  raise notice 'finding 1: the partial expression index cannot serve ON CONFLICT — OK';
end $$;

-- ================================= 4. A RETRIED SETTLE DEBITS ONCE

do $$
declare
  w public.project_wallets; r jsonb; r2 jsonb; s jsonb; s2 jsonb; ev jsonb;
  debits integer; events integer;
begin
  w := public.rescript_billing_wallet_for('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', true, 0);
  perform public.rescript_billing_credit(w.id, 100, 'credit', 'trial_credits', 'Trial', null, null, null, null, 0);

  ev := jsonb_build_object(
    'customerId', w.customer_id, 'surveyId', w.survey_id, 'walletId', w.id,
    'eventType', 'AI_REQUEST', 'category', 'ai', 'environment', 'LIVE',
    'quantity', 1, 'unit', 'request',
    'providerCost', 4, 'infraCost', 0, 'paymentFee', 0, 'taxReserve', 0,
    'customerCharge', 10, 'grossProfit', 6, 'netProfit', 6, 'marginPct', 60,
    'metadata', '{"billable":true}'::jsonb,
    'idempotencyKey', 'interview-stt:m1');

  r := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 4, 10, 0, 30);
  s := public.rescript_billing_settle((r->'reservation'->>'id')::uuid, ev, 0);
  assert not (s->>'replayed')::boolean, 'the first settle writes';
  assert (s->'wallet'->>'balance')::numeric = 90, 'debited once: ' || (s->'wallet'->>'balance');

  -- the job failed and ran again: a fresh hold, the same event
  r2 := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 4, 10, 0, 30);
  s2 := public.rescript_billing_settle((r2->'reservation'->>'id')::uuid, ev, 0);
  assert (s2->>'replayed')::boolean, 'the retry is reported as a replay';
  assert (s2->'event'->>'id') = (s->'event'->>'id'), 'and it is the same usage event';
  assert (s2->'wallet'->>'balance')::numeric = 90,
    'the balance does NOT move again: ' || (s2->'wallet'->>'balance');
  assert (s2->'wallet'->>'reserved')::numeric = 0, 'and the retry''s hold still came off';

  select count(*) into debits from public.wallet_ledger where wallet_id = w.id and kind = 'debit';
  assert debits = 1, 'one ledger debit, not two — got ' || debits;
  select count(*) into events from public.usage_events where idempotency_key = 'interview-stt:m1';
  assert events = 1, 'one usage event — got ' || events;
  /* the project's own meter, when it has one — the row is created lazily by
     the app (`Meter.spendingFor`), so a database-only run may have none */
  assert coalesce((select spent from public.project_spending
                    where subject_kind = 'survey' and subject_id = w.survey_id), 10) = 10,
    'and the project is charged once, not twice';
  raise notice 'finding 4: a retried settle debits once — OK';
end $$;

-- =============================== 3. A REVERSAL CANNOT BE REPLAYED FOR CREDIT

do $$
declare
  w public.project_wallets; orig public.usage_events; rev jsonb; rev2 jsonb; reversals integer;
begin
  w := public.rescript_billing_wallet_for('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', true, 0);
  select * into orig from public.usage_events where idempotency_key = 'interview-stt:m1';

  -- what `Meter.reverse` now writes: the reversal keyed on the event it adjusts
  rev := public.rescript_billing_record(jsonb_build_object(
    'customerId', w.customer_id, 'surveyId', w.survey_id, 'walletId', w.id,
    'eventType', 'AI_REQUEST', 'category', 'ai', 'environment', 'LIVE',
    'quantity', -1, 'unit', 'request',
    'providerCost', -4, 'infraCost', 0, 'paymentFee', 0, 'taxReserve', 0,
    'customerCharge', -10, 'grossProfit', -6, 'netProfit', -6, 'marginPct', 60,
    'adjustsEventId', orig.id, 'idempotencyKey', 'reversal:' || orig.id,
    'metadata', '{"reversal":true}'::jsonb), 0);
  assert not (rev->>'replayed')::boolean, 'the first reversal is written';

  rev2 := public.rescript_billing_record(jsonb_build_object(
    'customerId', w.customer_id, 'surveyId', w.survey_id, 'walletId', w.id,
    'eventType', 'AI_REQUEST', 'category', 'ai', 'environment', 'LIVE',
    'quantity', -1, 'unit', 'request',
    'providerCost', -4, 'infraCost', 0, 'paymentFee', 0, 'taxReserve', 0,
    'customerCharge', -10, 'grossProfit', -6, 'netProfit', -6, 'marginPct', 60,
    'adjustsEventId', orig.id, 'idempotencyKey', 'reversal:' || orig.id,
    'metadata', '{"reversal":true}'::jsonb), 0);
  assert (rev2->>'replayed')::boolean,
    'the second press is reported as a replay, so the caller credits nothing';
  assert (rev2->'event'->>'id') = (rev->'event'->>'id');

  select count(*) into reversals from public.usage_events where adjusts_event_id = orig.id;
  assert reversals = 1, 'one reversal row — got ' || reversals;
  raise notice 'finding 3: a reversal is written once and reported as such — OK';
end $$;

-- ============================== 5. EXPIRED RESERVATIONS ARE RELEASED

do $$
declare w public.project_wallets; r jsonb; n integer; res public.usage_reservations;
begin
  w := public.rescript_billing_wallet_for('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', true, 0);

  r := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 4, 7, 0, 30);
  assert (r->>'ok')::boolean;
  select * into w from public.project_wallets where id = w.id;
  assert w.reserved = 7, 'the hold is on the wallet';

  -- the handler was killed between reserve and settle; the TTL has since passed
  update public.usage_reservations set expires_at = now() - interval '1 minute'
   where id = (r->'reservation'->>'id')::uuid;

  n := public.rescript_billing_expire_reservations(now());
  assert n = 1, 'one reservation expired — got ' || n;
  select * into res from public.usage_reservations where id = (r->'reservation'->>'id')::uuid;
  assert res.status = 'expired', 'the row says so';
  select * into w from public.project_wallets where id = w.id;
  assert w.reserved = 0, 'and the money is available again: reserved = ' || w.reserved;
  assert coalesce((select reserved from public.project_spending
                    where subject_kind = 'survey' and subject_id = w.survey_id), 0) = 0,
    'the project''s own hold comes off too';

  -- a live hold is left alone
  r := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 4, 7, 0, 30);
  assert public.rescript_billing_expire_reservations(now()) = 0, 'nothing that has not expired is touched';
  raise notice 'finding 5: expired reservations are released — OK';
end $$;

rollback;
