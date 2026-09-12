-- CENTRAL WALLET SQL TEST (migration 0025) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/billing-central-wallet-sql-test.sql
--
-- Proves the model the brief describes, in the database where it is enforced: one wallet per
-- person funding every project they own; a per-project cap that freezes THAT project and leaves
-- the rest of the wallet alone; a priority project that keeps spending; raising a limit moving no
-- money; wallet exhaustion stopping everything; and the sweep that moved project balances to
-- their owners.
begin;

insert into public.customers (id, slug, name)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'cw', 'Central Wallet Test') on conflict do nothing;
insert into auth.users (id, email) values ('bbbbbbbb-0000-0000-0000-000000000001', 'owner@example.test') on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner@example.test', 'Ana Owner', 'researcher')
  on conflict (id) do nothing;

insert into public.surveys (id, customer_id, code, title, owner_id) values
  ('cccccccc-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'PRJ_A', 'Project A', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001', 'PRJ_B', 'Project B', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-000000000001', 'PRJ_C', 'Project C', 'bbbbbbbb-0000-0000-0000-000000000001')
  on conflict do nothing;

/* a charge, as the application sends it */
create or replace function pg_temp.ev(p_survey uuid, p_wallet uuid, p_charge numeric) returns jsonb language sql as $$
  select jsonb_build_object(
    'customerId', 'aaaaaaaa-0000-0000-0000-000000000001', 'surveyId', p_survey, 'walletId', p_wallet,
    'eventType', 'AI_REQUEST', 'category', 'ai', 'environment', 'LIVE',
    'provider', 'openai-compatible', 'service', 'chat', 'model', 'test', 'quantity', 1, 'unit', 'request',
    'providerCost', p_charge / 2, 'infraCost', 0, 'paymentFee', 0, 'taxReserve', 0,
    'customerCharge', p_charge, 'grossProfit', p_charge / 2, 'netProfit', p_charge / 2, 'marginPct', 50,
    'metadata', '{"billable":true}'::jsonb)
$$;

do $$
declare
  cust uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  own  uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  pa   uuid := 'cccccccc-0000-0000-0000-00000000000a';
  pb   uuid := 'cccccccc-0000-0000-0000-00000000000b';
  pc   uuid := 'cccccccc-0000-0000-0000-00000000000c';
  w public.project_wallets; w2 public.project_wallets; central_id uuid;
  r jsonb; s jsonb; sp public.project_spending;
begin
  /* ---------------------------------------------- one wallet, three projects */
  w  := public.rescript_billing_wallet_for(cust, pa, true, 0);
  w2 := public.rescript_billing_wallet_for(cust, pb, true, 0);
  assert w.id = w2.id, 'two projects with one owner resolve to ONE wallet';
  assert w.user_id = own, 'and it is the owner''s wallet, not the project''s';
  assert w.survey_id is null, 'a central wallet belongs to nobody''s project';
  w2 := public.rescript_billing_wallet_for(cust, pc, true, 0);
  assert w2.id = w.id, 'and so does the third';
  central_id := w.id;

  perform public.rescript_billing_credit(central_id, 500, 'credit', 'deposit', 'Wallet top-up', own, null, null, null, 0);
  assert (select balance from public.project_wallets where id = central_id) = 500, 'the wallet holds $500';

  /* ------------------------------------- the brief's arrangement: A priority, B and C capped */
  perform public.rescript_billing_set_spending(pa, cust, 'priority', null);
  perform public.rescript_billing_set_spending(pb, cust, 'budget', 1);
  perform public.rescript_billing_set_spending(pc, cust, 'budget', 1);
  assert (select budget_limit from public.project_spending where survey_id = pb) = 1, 'B is capped at $1';
  assert (select budget_limit from public.project_spending where survey_id = pa) is null, 'a priority project has no cap of its own';

  /* B spends 60c, then is refused the next 60c — its own limit, not the wallet's */
  r := public.rescript_billing_reserve(central_id, cust, pb, own, 'AI_REQUEST', 'LIVE', 0.3, 0.6, 0, 30);
  assert (r->>'ok')::boolean, 'B may spend within its budget';
  perform public.rescript_billing_settle((r->'reservation'->>'id')::uuid, pg_temp.ev(pb, central_id, 0.6), 0);

  r := public.rescript_billing_reserve(central_id, cust, pb, own, 'AI_REQUEST', 'LIVE', 0.3, 0.6, 0, 30);
  assert not (r->>'ok')::boolean, 'B is refused once the budget would be exceeded';
  assert (r->>'reason') = 'project_limit', 'and the reason names the PROJECT, not the wallet: ' || (r->>'reason');
  assert (select balance from public.project_wallets where id = central_id) = 499.4, 'the wallet lost only what B actually spent';

  /* the remaining 40c of B's budget is still spendable */
  r := public.rescript_billing_reserve(central_id, cust, pb, own, 'AI_REQUEST', 'LIVE', 0.2, 0.4, 0, 30);
  assert (r->>'ok')::boolean, 'the last 40c of the budget is B''s to spend';
  perform public.rescript_billing_settle((r->'reservation'->>'id')::uuid, pg_temp.ev(pb, central_id, 0.4), 0);
  select * into sp from public.project_spending where survey_id = pb;
  assert sp.spent = 1, 'B has spent its whole dollar';
  assert sp.state = 'frozen', 'so B freezes itself';
  assert sp.frozen_at is not null, 'and records when';

  /* ------------------------------------- the wallet is untouched for everybody else */
  assert (select balance from public.project_wallets where id = central_id) = 499, '$499 of the wallet remains';
  r := public.rescript_billing_reserve(central_id, cust, pa, own, 'AI_REQUEST', 'LIVE', 60, 120, 0, 30);
  assert (r->>'ok')::boolean, 'the priority project spends on';
  perform public.rescript_billing_settle((r->'reservation'->>'id')::uuid, pg_temp.ev(pa, central_id, 120), 0);
  assert (select balance from public.project_wallets where id = central_id) = 379, 'A took $120 from the same wallet';
  assert (select spent from public.project_spending where survey_id = pa) = 120, 'and A''s own meter says so';
  assert (select state from public.project_spending where survey_id = pb) = 'frozen', 'B is still frozen through all of it';

  /* a frozen project is refused before anything else is considered */
  assert (public.rescript_billing_reserve(central_id, cust, pb, own, 'AI_REQUEST', 'LIVE', 0.01, 0.01, 0, 30)->>'reason') = 'project_limit',
    'a frozen project cannot spend a cent, however full the wallet';

  /* ------------------------------------- raising a limit moves no money and unfreezes */
  sp := public.rescript_billing_set_spending(pb, cust, 'budget', 100);
  assert sp.state = 'active', 'raising the limit starts the project again';
  assert sp.spent = 1, 'what it spent is unchanged';
  assert (select balance from public.project_wallets where id = central_id) = 379, 'and NOTHING moved — a budget is permission, not money';
  r := public.rescript_billing_reserve(central_id, cust, pb, own, 'AI_REQUEST', 'LIVE', 1, 2, 0, 30);
  assert (r->>'ok')::boolean, 'B spends again under its new limit';
  perform public.rescript_billing_release((r->'reservation'->>'id')::uuid, 'released');
  assert (select reserved from public.project_spending where survey_id = pb) = 0, 'releasing a hold gives the headroom back to the project';
  assert (select reserved from public.project_wallets where id = central_id) = 0, 'and to the wallet';

  /* ------------------------------------- a hold counts against the cap while it is held */
  r := public.rescript_billing_reserve(central_id, cust, pc, own, 'AI_REQUEST', 'LIVE', 0.5, 0.9, 0, 30);
  assert (r->>'ok')::boolean;
  assert not (public.rescript_billing_reserve(central_id, cust, pc, own, 'AI_REQUEST', 'LIVE', 0.5, 0.9, 0, 30)->>'ok')::boolean,
    'two concurrent operations cannot both be told there is room for the last dollar';
  perform public.rescript_billing_release((r->'reservation'->>'id')::uuid, 'released');

  /* ------------------------------------- wallet exhaustion stops everything */
  r := public.rescript_billing_reserve(central_id, cust, pa, own, 'AI_REQUEST', 'LIVE', 180, 379, 0, 30);
  assert (r->>'ok')::boolean;
  perform public.rescript_billing_settle((r->'reservation'->>'id')::uuid, pg_temp.ev(pa, central_id, 379), 0);
  assert (select balance from public.project_wallets where id = central_id) = 0;
  assert (select state from public.project_wallets where id = central_id) = 'read_only', 'an empty wallet is read-only';
  r := public.rescript_billing_reserve(central_id, cust, pc, own, 'AI_REQUEST', 'LIVE', 0.01, 0.05, 0, 30);
  assert not (r->>'ok')::boolean, 'and no project can spend, whatever its own policy';
  assert (r->>'reason') = 'insufficient_balance', 'this time the reason is the wallet: ' || (r->>'reason');

  /* a deposit brings everything back without anyone flipping a switch */
  perform public.rescript_billing_credit(central_id, 100, 'credit', 'deposit', 'Top-up', own, null, null, null, 0);
  assert (select state from public.project_wallets where id = central_id) = 'active', 'the wallet is active again';
  assert (public.rescript_billing_reserve(central_id, cust, pc, own, 'AI_REQUEST', 'LIVE', 0.01, 0.05, 0, 30)->>'ok')::boolean,
    'and a project under its own limit may spend again';

  /* ------------------------------------- the ledger still knows which project spent */
  assert (select count(*) from public.wallet_ledger where wallet_id = central_id and survey_id = pa and kind = 'debit') >= 2,
    'a debit on the central wallet is attributed to the project that caused it';
  assert (select count(*) from public.wallet_ledger where wallet_id = central_id and survey_id = pb and kind = 'debit') >= 2;
end $$;

/* ------------------------------------------------------------- the sweep */

insert into auth.users (id, email) values ('bbbbbbbb-0000-0000-0000-000000000002', 'legacy@example.test') on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'legacy@example.test', 'Leo Legacy', 'researcher')
  on conflict (id) do nothing;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('cccccccc-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-000000000001', 'PRJ_D', 'Legacy project', 'bbbbbbbb-0000-0000-0000-000000000002')
  on conflict do nothing;

do $$
declare
  cust uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  leo  uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  pd   uuid := 'cccccccc-0000-0000-0000-00000000000d';
  old public.project_wallets; central public.project_wallets; before_total numeric; after_total numeric;
begin
  /* an installation as it was before this migration: money sitting in the project's own wallet */
  insert into public.project_wallets (customer_id, survey_id, balance, total_added, total_used)
    values (cust, pd, 56.75, 100, 43.25) returning * into old;
  before_total := (select sum(balance) from public.project_wallets);

  perform public.rescript_billing_sweep_to_owners();

  select * into old from public.project_wallets where id = old.id;
  central := public.rescript_billing_user_wallet_for(cust, leo, false);
  assert old.balance = 0, 'the project wallet is emptied';
  assert old.retired_at is not null, 'and retired, so it can never fund anything again';
  assert central.id is not null and central.balance = 56.75, 'the money is in the owner''s wallet: ' || coalesce(central.balance::text, 'none');
  after_total := (select sum(balance) from public.project_wallets);
  assert before_total = after_total, 'and the installation holds exactly what it held before';

  assert (select count(*) from public.wallet_ledger where kind = 'transfer_out' and wallet_id = old.id) = 1, 'the ledger says where it went';
  assert (select count(*) from public.wallet_ledger where kind = 'transfer_in' and wallet_id = central.id) = 1, 'and where it arrived';
  assert (select spent from public.project_spending where survey_id = pd) = 43.25, 'what the project had already spent follows it';

  /* and from now on the project funds itself from its owner */
  old := public.rescript_billing_wallet_for(cust, pd, true, 0);
  assert old.id = central.id, 'the retired wallet is not resolved again';

  /* running the sweep twice does nothing the second time */
  perform public.rescript_billing_sweep_to_owners();
  assert (select balance from public.project_wallets where id = central.id) = 56.75, 'the sweep is idempotent';
end $$;

do $$ begin raise notice 'ALL CENTRAL WALLET SQL CHECKS PASSED'; end $$;

rollback;
