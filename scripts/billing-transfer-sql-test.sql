-- CREDIT TRANSFER SQL TEST (migration 0024): atomic move, available-only, reserved excluded, reversal, immutability, user wallets.
begin;
insert into public.customers (id, slug, name) values ('11111111-1111-1111-1111-111111111111', 'bt', 'Billing Test') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'BT1', 'Project A') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'BT2', 'Project B') on conflict do nothing;
insert into auth.users (id) values ('44444444-4444-4444-4444-444444444444') on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role) values ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'b@test', 'User B', 'researcher') on conflict do nothing;
do $$
declare a public.project_wallets; b public.project_wallets; u public.project_wallets; r jsonb; t uuid; rev jsonb; a0 numeric; b0 numeric; avail numeric;
begin
  a := public.rescript_billing_wallet_for('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', true, 0);
  b := public.rescript_billing_wallet_for('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', true, 0);
  u := public.rescript_billing_user_wallet_for('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', true);
  assert u.user_id = '44444444-4444-4444-4444-444444444444' and u.survey_id is null, 'a personal wallet';
  assert (public.rescript_billing_user_wallet_for('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', true)).id = u.id, 'same personal wallet second time';
  perform public.rescript_billing_credit(a.id, 100, 'credit', 'trial', null, null, null, null, null, 0);
  -- spend 50, reserve 10: available = 40
  perform public.rescript_billing_record(jsonb_build_object('customerId', a.customer_id, 'surveyId', a.survey_id, 'walletId', a.id, 'eventType', 'AI_REQUEST', 'category', 'ai', 'environment', 'LIVE', 'quantity', 1, 'unit', 'request', 'customerCharge', 50), 0);
  perform public.rescript_billing_reserve(a.id, a.customer_id, a.survey_id, null, 'AI_REQUEST', 'LIVE', 5, 10, 0, 30);
  select balance, balance - reserved into a0, avail from public.project_wallets where id = a.id;
  select balance into b0 from public.project_wallets where id = b.id;
  r := public.rescript_billing_transfer(a.id, b.id, avail + 5, 'unused', null, null, null, 0);
  assert not (r->>'ok')::boolean and r->>'reason' = 'insufficient_available' and (r->>'available')::numeric = avail, 'reserved balance is not transferable: ' || r::text;
  r := public.rescript_billing_transfer(a.id, a.id, 5, null, null, null, null, 0);
  assert r->>'reason' = 'same_wallet';
  r := public.rescript_billing_transfer(a.id, b.id, 25, 'Unused project credits', 'moving to B', null, null, 0);
  assert (r->>'ok')::boolean, 'transfer ok';
  assert (r->'source'->>'balance')::numeric = a0 - 25, 'A: −25';
  assert (r->'destination'->>'balance')::numeric = b0 + 25, 'B: +25';
  assert (r->'transfer'->>'code') like 'TRX-%', 'TRX code';
  t := (r->'transfer'->>'id')::uuid;
  assert (select count(*) from public.wallet_ledger where transfer_id = t) = 2, 'two ledger lines';
  assert (select kind from public.wallet_ledger where transfer_id = t and wallet_id = a.id) = 'transfer_out';
  assert (select kind from public.wallet_ledger where transfer_id = t and wallet_id = b.id) = 'transfer_in';
  assert (select amount from public.wallet_ledger where transfer_id = t and wallet_id = a.id) = -25;
  -- to a person
  r := public.rescript_billing_transfer(b.id, u.id, 20, null, null, null, null, 0);
  assert (r->>'ok')::boolean and (r->'transfer'->>'destination_kind') = 'user', 'project → user';
  -- reversal of the first transfer: B has b0 + 5 left → cannot return 25 when b0 < 20
  if b0 < 20 then
    rev := public.rescript_billing_transfer(b.id, a.id, 25, 'transfer_reversal', 'undo', null, t, 0);
    assert not (rev->>'ok')::boolean and rev->>'reason' = 'insufficient_available', 'a reversal needs the credits still to be there';
  end if;
  perform public.rescript_billing_credit(b.id, 25, 'credit', 'top up', null, null, null, null, null, 0);
  rev := public.rescript_billing_transfer(b.id, a.id, 25, 'transfer_reversal', 'undo', null, t, 0);
  assert (rev->>'ok')::boolean, 'reversal ok';
  assert (select status from public.credit_transfers where id = t) = 'reversed', 'original marked reversed';
  assert (select reversed_by from public.credit_transfers where id = t) = (rev->'transfer'->>'id')::uuid;
  assert (select count(*) from public.wallet_ledger where transfer_id = (rev->'transfer'->>'id')::uuid and kind = 'transfer_reversal') = 2;
  assert (rev->'destination'->>'balance')::numeric = a0, 'A back to where it was before the transfer';
  rev := public.rescript_billing_transfer(b.id, a.id, 25, 'transfer_reversal', 'again', null, t, 0);
  assert rev->>'reason' = 'already_reversed', 'cannot reverse twice';
  begin
    delete from public.credit_transfers where id = t;
    raise exception 'transfer deleted';
  exception when others then if sqlerrm like '%transfer deleted%' then raise; end if; end;
  begin
    update public.credit_transfers set amount = 1 where id = t;
    raise exception 'transfer amount edited';
  exception when others then if sqlerrm like '%amount edited%' then raise; end if; end;
  raise notice 'TRANSFER SQL: all assertions passed';
end $$;
rollback;
