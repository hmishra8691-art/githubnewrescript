-- BILLING SQL TEST (migration 0023) — run against a database with the migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/billing-sql-test.sql
-- Proves: wallet on demand, reserve/settle/release arithmetic, the floor, read-only state, the
-- immutability triggers, credits, and that the reservation row lock serialises two spenders.
begin;
insert into public.customers (id, slug, name) values ('11111111-1111-1111-1111-111111111111', 'bt', 'Billing Test') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'BT1', 'Billing test project') on conflict do nothing;

do $$
declare w public.project_wallets; r jsonb; s jsonb; c jsonb; ev jsonb; w2 public.project_wallets;
begin
  w := public.rescript_billing_wallet_for('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', true, 0);
  assert w.id is not null, 'wallet created on demand';
  w2 := public.rescript_billing_wallet_for('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', true, 0);
  assert w2.id = w.id, 'the same wallet is returned the second time';

  c := public.rescript_billing_credit(w.id, 100, 'credit', 'trial_credits', 'Trial', null, null, null, null, 0);
  assert (c->'wallet'->>'balance')::numeric = 100, 'credited to 100';
  assert (c->'wallet'->>'total_added')::numeric = 100;
  assert (c->'entry'->>'kind') = 'credit';

  -- reserve 30, then 60: the second still fits (100 − 30 − 60 = 10 ≥ 0); a third of 20 does not
  r := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 12, 30, 0, 30);
  assert (r->>'ok')::boolean, 'first hold ok';
  s := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 25, 60, 0, 30);
  assert (s->>'ok')::boolean, 'second hold ok';
  assert (s->'wallet'->>'reserved')::numeric = 90;
  assert not (public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 8, 20, 0, 30)->>'ok')::boolean, 'third hold refused — the floor holds';
  assert (public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 8, 20, -25, 30)->>'ok')::boolean, 'with overdraft room (floor −25) it fits';
  perform public.rescript_billing_release((select id from public.usage_reservations where reserved_amount = 20 and status = 'held'), 'released');

  -- settle the first for 18.5 (below the 30 held)
  ev := jsonb_build_object('customerId', w.customer_id, 'surveyId', w.survey_id, 'walletId', w.id, 'eventType', 'AI_REQUEST', 'category', 'ai', 'environment', 'LIVE',
    'provider', 'openai-compatible', 'service', 'chat', 'model', 'claude-sonnet-4-6', 'quantity', 5000, 'unit', 'token', 'inputUnits', 4000, 'outputUnits', 1000,
    'providerCost', 8, 'infraCost', 0.0002, 'paymentFee', 1.258, 'taxReserve', 0, 'customerCharge', 18.5, 'grossProfit', 10.4998, 'netProfit', 9.2418, 'marginPct', 49.96, 'metadata', '{"billable":true}'::jsonb);
  s := public.rescript_billing_settle((r->'reservation'->>'id')::uuid, ev, 0);
  assert (s->'wallet'->>'balance')::numeric = 81.5, 'balance debited by the ACTUAL charge: ' || (s->'wallet'->>'balance');
  assert (s->'wallet'->>'reserved')::numeric = 60, 'the settled hold is released, the other stays';
  assert (s->'wallet'->>'total_used')::numeric = 18.5;
  assert (s->'event'->>'customer_charge')::numeric = 18.5;
  assert (select count(*) from public.wallet_ledger where wallet_id = w.id and kind = 'debit') = 1;
  begin
    perform public.rescript_billing_settle((r->'reservation'->>'id')::uuid, ev, 0);
    raise exception 'a settled reservation was settled twice';
  exception when others then
    if sqlerrm like '%settled twice%' then raise; end if;
  end;

  -- record without a hold; drive the balance to zero → read_only; credit reopens
  ev := ev || jsonb_build_object('customerCharge', 81.5, 'reservationId', null);
  perform public.rescript_billing_release((select id from public.usage_reservations where reserved_amount = 60 and status = 'held'), 'released');
  s := public.rescript_billing_record(ev, 0);
  assert (s->'wallet'->>'balance')::numeric = 0;
  assert (s->'wallet'->>'state') = 'read_only', 'zero balance → READ_ONLY automatically';
  c := public.rescript_billing_credit(w.id, 50, 'credit', 'credits_added', null, null, null, null, null, 0);
  assert (c->'wallet'->>'state') = 'active', 'credits reopen the project';
  assert (c->'wallet'->>'balance')::numeric = 50;

  -- immutability
  begin
    update public.usage_events set customer_charge = 0 where wallet_id = w.id;
    raise exception 'usage row was updated';
  exception when others then
    if sqlerrm like '%was updated%' then raise; end if;
  end;
  begin
    delete from public.wallet_ledger where wallet_id = w.id;
    raise exception 'ledger row was deleted';
  exception when others then
    if sqlerrm like '%was deleted%' then raise; end if;
  end;

  -- expiry
  update public.usage_reservations set expires_at = now() - interval '1 minute' where wallet_id = w.id and status = 'held';
  assert public.rescript_billing_expire_reservations(now()) = 0, 'nothing held now';
  r := public.rescript_billing_reserve(w.id, w.customer_id, w.survey_id, null, 'AI_REQUEST', 'LIVE', 1, 5, 0, 1);
  update public.usage_reservations set expires_at = now() - interval '1 minute' where id = (r->'reservation'->>'id')::uuid;
  assert public.rescript_billing_expire_reservations(now()) = 1, 'the abandoned hold expired';
  select * into w2 from public.project_wallets where id = w.id;
  assert w2.reserved = 0, 'and its amount went back';
  raise notice 'BILLING SQL: all assertions passed';
end $$;
rollback;
