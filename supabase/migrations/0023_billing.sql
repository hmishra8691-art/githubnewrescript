-- =====================================================================
-- 0023 — METERED USAGE, WALLETS & COST ALLOCATION
--
-- A project (a row of `surveys`) has a wallet. An administrator credits it;
-- every billable operation the project performs — an AI call, a translation
-- batch, a completed interview, a file upload — is metered by the
-- application (`@rescript/billing`), priced from the cost registry, and
-- settled against the wallet here, atomically.
--
-- SIMULATION MODE. No money moves. A "deposit" is a ledger line an
-- administrator writes. When real payments arrive they will write the same
-- line with a payment reference; nothing about metering changes.
--
-- WHY THE BALANCE LOGIC IS IN SQL. Two requests racing for the last dollar
-- must not both get it. `rescript_billing_reserve` takes the wallet row with
-- `for update`, compares `balance − reserved − amount` against the floor,
-- and writes the hold in the same transaction; `_settle` debits the ACTUAL
-- charge and releases the hold likewise. Vercel functions cannot hold a
-- process-wide lock; the row lock is the only lock there is.
--
-- WHY TWO IMMUTABLE TABLES. `usage_events` is the metering record (what was
-- done, what it cost, what was charged, the split); `wallet_ledger` is the
-- money record (every credit, debit, adjustment, reversal, with the balance
-- after). Neither accepts UPDATE or DELETE — a correction is a reversal row
-- pointing at the row it corrects. Financial auditing later depends on this.
--
-- THRESHOLDS come from the application's configuration (`billing_config`)
-- and are passed into each function, so the SQL never hard-codes a number.
-- =====================================================================

create table if not exists public.billing_config (
  id integer primary key check (id = 1),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.billing_config (id, config) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- the cost & pricing registry: what each provider/service/model costs, per unit
create table if not exists public.billing_rates (
  id text primary key,
  provider text not null,
  service text not null,
  model text,
  side text check (side in ('input','output')),
  unit text not null,
  provider_cost numeric(18,8) not null default 0,
  unit_size numeric(18,2) not null default 1,
  markup_pct numeric(8,3) not null default 0,
  customer_rate numeric(18,8),
  currency text not null default 'USD',
  effective_from date,
  effective_until date,
  active boolean not null default true,
  estimated boolean not null default false,
  note text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists billing_rates_lookup_idx on public.billing_rates (provider, service, model, side);

-- the billable event registry: what can be charged for, in what unit, whether it is billable
create table if not exists public.billing_events (
  type text primary key,
  label text not null,
  category text not null,
  unit text not null,
  billable boolean not null default true,
  rate jsonb,
  description text not null default '',
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.project_wallets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  /* null = the workspace (customer) wallet a project may share explicitly */
  survey_id uuid references public.surveys(id) on delete cascade,
  shared_wallet_id uuid references public.project_wallets(id) on delete set null,
  currency text not null default 'USD',
  balance numeric(18,6) not null default 0,
  reserved numeric(18,6) not null default 0,
  total_added numeric(18,6) not null default 0,
  total_used numeric(18,6) not null default 0,
  state text not null default 'active' check (state in ('active','read_only','suspended')),
  overdraft_enabled boolean,
  overdraft_limit numeric(18,6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists project_wallets_survey_idx on public.project_wallets (survey_id) where survey_id is not null;
create unique index if not exists project_wallets_workspace_idx on public.project_wallets (customer_id) where survey_id is null;
create index if not exists project_wallets_customer_idx on public.project_wallets (customer_id);

create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.project_wallets(id) on delete cascade,
  customer_id uuid not null,
  survey_id uuid,
  user_id uuid,
  event_type text not null,
  environment text not null check (environment in ('TEST','LIVE')),
  estimated_cost numeric(18,6) not null default 0,
  reserved_amount numeric(18,6) not null,
  status text not null default 'held' check (status in ('held','settled','released','expired')),
  actual_charge numeric(18,6),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz
);
create index if not exists usage_reservations_open_idx on public.usage_reservations (wallet_id) where status = 'held';
create index if not exists usage_reservations_expiry_idx on public.usage_reservations (expires_at) where status = 'held';

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  survey_id uuid,
  user_id uuid,
  wallet_id uuid references public.project_wallets(id) on delete set null,
  event_type text not null,
  category text not null,
  environment text not null check (environment in ('TEST','LIVE')),
  provider text,
  service text,
  model text,
  quantity numeric(18,4) not null default 0,
  unit text not null,
  input_units numeric(18,2),
  output_units numeric(18,2),
  provider_cost numeric(18,6) not null default 0,
  infra_cost numeric(18,6) not null default 0,
  payment_fee numeric(18,6) not null default 0,
  tax_reserve numeric(18,6) not null default 0,
  customer_charge numeric(18,6) not null default 0,
  gross_profit numeric(18,6) not null default 0,
  net_profit numeric(18,6) not null default 0,
  margin_pct numeric(8,2) not null default 0,
  reservation_id uuid references public.usage_reservations(id) on delete set null,
  adjusts_event_id uuid references public.usage_events(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_survey_idx on public.usage_events (survey_id, created_at desc);
create index if not exists usage_events_customer_idx on public.usage_events (customer_id, created_at desc);
create index if not exists usage_events_wallet_idx on public.usage_events (wallet_id, created_at desc);
create index if not exists usage_events_user_idx on public.usage_events (user_id, created_at desc);

create table if not exists public.wallet_ledger (
  id bigint generated always as identity primary key,
  wallet_id uuid not null references public.project_wallets(id) on delete cascade,
  customer_id uuid not null,
  survey_id uuid,
  kind text not null check (kind in ('credit','debit','adjustment','reversal','expiry')),
  amount numeric(18,6) not null,
  balance_after numeric(18,6) not null,
  reason text not null,
  note text,
  usage_event_id uuid references public.usage_events(id) on delete set null,
  reference_id bigint,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists wallet_ledger_wallet_idx on public.wallet_ledger (wallet_id, created_at desc);

create table if not exists public.credit_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  wallet_id uuid references public.project_wallets(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  requested_amount numeric(18,2) not null check (requested_amount > 0),
  reason text not null,
  message text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decided_amount numeric(18,2),
  admin_note text,
  created_at timestamptz not null default now()
);
create index if not exists credit_requests_pending_idx on public.credit_requests (customer_id, created_at desc) where status = 'pending';

-- --------------------------------------------------------------- immutability
create or replace function public.rescript_billing_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'billing records are immutable — write a reversal or adjustment instead (% on %)', tg_op, tg_table_name;
end $$;

drop trigger if exists usage_events_immutable on public.usage_events;
create trigger usage_events_immutable before update or delete on public.usage_events
  for each row execute function public.rescript_billing_immutable();
drop trigger if exists wallet_ledger_immutable on public.wallet_ledger;
create trigger wallet_ledger_immutable before update or delete on public.wallet_ledger
  for each row execute function public.rescript_billing_immutable();

-- --------------------------------------------------------------- functions

/* the wallet a project draws from; created on first use when asked to */
create or replace function public.rescript_billing_wallet_for(p_customer uuid, p_survey uuid, p_create boolean, p_seed numeric default 0)
returns public.project_wallets
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets;
begin
  if p_survey is null then
    select * into w from public.project_wallets where customer_id = p_customer and survey_id is null;
  else
    select * into w from public.project_wallets where survey_id = p_survey;
  end if;
  if w.id is null and p_create then
    insert into public.project_wallets (customer_id, survey_id) values (p_customer, p_survey)
      on conflict do nothing
      returning * into w;
    if w.id is null then
      if p_survey is null then select * into w from public.project_wallets where customer_id = p_customer and survey_id is null;
      else select * into w from public.project_wallets where survey_id = p_survey; end if;
    elsif coalesce(p_seed, 0) > 0 then
      perform public.rescript_billing_credit(w.id, p_seed, 'credit', 'starting_credits', 'Starting balance', null, null, null, null, 0);
      select * into w from public.project_wallets where id = w.id;
    end if;
  end if;
  return w;
end $$;

/* state from balance; suspended is manual and is never changed here */
create or replace function public.rescript_billing_state(p_balance numeric, p_current text, p_read_only_threshold numeric)
returns text language sql immutable as $$
  select case when p_current = 'suspended' then 'suspended'
              when p_balance <= p_read_only_threshold then 'read_only'
              else 'active' end
$$;

/* HOLD an amount if balance − reserved − amount ≥ floor (floor = minimum remaining − overdraft room) */
create or replace function public.rescript_billing_reserve(
  p_wallet uuid, p_customer uuid, p_survey uuid, p_user uuid, p_event_type text, p_environment text,
  p_estimated numeric, p_amount numeric, p_floor numeric, p_ttl_minutes integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets; r public.usage_reservations;
begin
  select * into w from public.project_wallets where id = p_wallet for update;
  if w.id is null then raise exception 'unknown wallet %', p_wallet; end if;
  if (w.balance - w.reserved - p_amount) < p_floor then
    return jsonb_build_object('ok', false, 'wallet', to_jsonb(w));
  end if;
  insert into public.usage_reservations (wallet_id, customer_id, survey_id, user_id, event_type, environment, estimated_cost, reserved_amount, expires_at)
    values (p_wallet, p_customer, p_survey, p_user, p_event_type, p_environment, coalesce(p_estimated, 0), p_amount, now() + make_interval(mins => greatest(1, coalesce(p_ttl_minutes, 30))))
    returning * into r;
  update public.project_wallets set reserved = reserved + p_amount, updated_at = now() where id = p_wallet returning * into w;
  return jsonb_build_object('ok', true, 'reservation', to_jsonb(r), 'wallet', to_jsonb(w));
end $$;

/* the usage row from the application's camelCase event document */
create or replace function public.rescript_billing_insert_usage(p_event jsonb, p_reservation uuid)
returns public.usage_events
language plpgsql security definer set search_path = public as $$
declare e public.usage_events;
begin
  insert into public.usage_events (
    customer_id, survey_id, user_id, wallet_id, event_type, category, environment, provider, service, model,
    quantity, unit, input_units, output_units, provider_cost, infra_cost, payment_fee, tax_reserve, customer_charge,
    gross_profit, net_profit, margin_pct, reservation_id, adjusts_event_id, metadata)
  values (
    (p_event->>'customerId')::uuid, nullif(p_event->>'surveyId','')::uuid, nullif(p_event->>'userId','')::uuid, nullif(p_event->>'walletId','')::uuid,
    p_event->>'eventType', p_event->>'category', p_event->>'environment', p_event->>'provider', p_event->>'service', p_event->>'model',
    coalesce((p_event->>'quantity')::numeric, 0), coalesce(p_event->>'unit', 'unit'),
    (p_event->>'inputUnits')::numeric, (p_event->>'outputUnits')::numeric,
    coalesce((p_event->>'providerCost')::numeric, 0), coalesce((p_event->>'infraCost')::numeric, 0),
    coalesce((p_event->>'paymentFee')::numeric, 0), coalesce((p_event->>'taxReserve')::numeric, 0),
    coalesce((p_event->>'customerCharge')::numeric, 0), coalesce((p_event->>'grossProfit')::numeric, 0),
    coalesce((p_event->>'netProfit')::numeric, 0), coalesce((p_event->>'marginPct')::numeric, 0),
    p_reservation, nullif(p_event->>'adjustsEventId','')::uuid, coalesce(p_event->'metadata', '{}'::jsonb))
  returning * into e;
  return e;
end $$;

/* SETTLE: release the hold, debit the ACTUAL charge, write the usage event and the ledger line, recompute the state */
create or replace function public.rescript_billing_settle(p_reservation uuid, p_event jsonb, p_read_only_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.usage_reservations; w public.project_wallets; e public.usage_events; charge numeric;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null then raise exception 'unknown reservation %', p_reservation; end if;
  if r.status <> 'held' then raise exception 'reservation already %', r.status; end if;
  select * into w from public.project_wallets where id = r.wallet_id for update;
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  e := public.rescript_billing_insert_usage(p_event, r.id);
  update public.usage_reservations set status = 'settled', actual_charge = charge, settled_at = now() where id = r.id;
  update public.project_wallets
     set reserved = greatest(0, reserved - r.reserved_amount),
         balance = balance - charge,
         total_used = total_used + charge,
         updated_at = now()
   where id = w.id returning * into w;
  if charge <> 0 then
    insert into public.wallet_ledger (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, w.survey_id, 'debit', -charge, w.balance, e.event_type, e.id, e.user_id);
  end if;
  update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = w.id returning * into w;
  return jsonb_build_object('event', to_jsonb(e), 'wallet', to_jsonb(w));
end $$;

create or replace function public.rescript_billing_release(p_reservation uuid, p_status text default 'released')
returns void
language plpgsql security definer set search_path = public as $$
declare r public.usage_reservations;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null or r.status <> 'held' then return; end if;
  update public.usage_reservations set status = case when p_status = 'expired' then 'expired' else 'released' end where id = r.id;
  update public.project_wallets set reserved = greatest(0, reserved - r.reserved_amount), updated_at = now() where id = r.wallet_id;
end $$;

/* RECORD without a hold: free events, non-billable events, reversals — or a debit the caller already verified */
create or replace function public.rescript_billing_record(p_event jsonb, p_read_only_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets; e public.usage_events; charge numeric; wid uuid;
begin
  wid := nullif(p_event->>'walletId','')::uuid;
  if wid is not null then select * into w from public.project_wallets where id = wid for update; end if;
  e := public.rescript_billing_insert_usage(p_event, null);
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  if w.id is not null and charge <> 0 and e.adjusts_event_id is null then
    update public.project_wallets set balance = balance - charge, total_used = total_used + charge, updated_at = now() where id = w.id returning * into w;
    insert into public.wallet_ledger (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, w.survey_id, 'debit', -charge, w.balance, e.event_type, e.id, e.user_id);
    update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = w.id returning * into w;
  end if;
  return jsonb_build_object('event', to_jsonb(e), 'wallet', case when w.id is null then null else to_jsonb(w) end);
end $$;

/* CREDIT / ADJUST / REVERSE — the only way a balance ever goes up, always with a ledger line */
create or replace function public.rescript_billing_credit(
  p_wallet uuid, p_amount numeric, p_kind text, p_reason text, p_note text, p_by uuid, p_expires timestamptz,
  p_reference bigint, p_usage_event uuid, p_read_only_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets; l public.wallet_ledger;
begin
  select * into w from public.project_wallets where id = p_wallet for update;
  if w.id is null then raise exception 'unknown wallet %', p_wallet; end if;
  update public.project_wallets
     set balance = balance + p_amount,
         total_added = total_added + case when p_amount > 0 and p_kind <> 'reversal' then p_amount else 0 end,
         total_used = total_used - case when p_kind = 'reversal' then p_amount else 0 end,
         updated_at = now()
   where id = w.id returning * into w;
  insert into public.wallet_ledger (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, note, usage_event_id, reference_id, created_by, expires_at)
    values (w.id, w.customer_id, w.survey_id, p_kind, p_amount, w.balance, p_reason, p_note, p_usage_event, p_reference, p_by, p_expires)
    returning * into l;
  update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = w.id returning * into w;
  return jsonb_build_object('entry', to_jsonb(l), 'wallet', to_jsonb(w));
end $$;

/* a hold nobody settled (the request died) goes back to the wallet */
create or replace function public.rescript_billing_expire_reservations(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in select id from public.usage_reservations where status = 'held' and expires_at <= p_now loop
    perform public.rescript_billing_release(r.id, 'expired'); n := n + 1;
  end loop;
  return n;
end $$;

-- --------------------------------------------------------------- RLS (second line; the apps use the service role behind their own guards)
alter table public.billing_config enable row level security;
alter table public.billing_rates enable row level security;
alter table public.billing_events enable row level security;
alter table public.project_wallets enable row level security;
alter table public.usage_reservations enable row level security;
alter table public.usage_events enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.credit_requests enable row level security;

drop policy if exists billing_config_admin_read on public.billing_config;
create policy billing_config_admin_read on public.billing_config for select to authenticated using (public.current_role() = 'platform_admin');
drop policy if exists billing_rates_read on public.billing_rates;
create policy billing_rates_read on public.billing_rates for select to authenticated using (true);
drop policy if exists billing_events_read on public.billing_events;
create policy billing_events_read on public.billing_events for select to authenticated using (true);
drop policy if exists project_wallets_tenant_read on public.project_wallets;
create policy project_wallets_tenant_read on public.project_wallets for select to authenticated
  using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');
drop policy if exists usage_events_tenant_read on public.usage_events;
create policy usage_events_tenant_read on public.usage_events for select to authenticated
  using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');
drop policy if exists wallet_ledger_tenant_read on public.wallet_ledger;
create policy wallet_ledger_tenant_read on public.wallet_ledger for select to authenticated
  using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');
drop policy if exists usage_reservations_tenant_read on public.usage_reservations;
create policy usage_reservations_tenant_read on public.usage_reservations for select to authenticated
  using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');
drop policy if exists credit_requests_tenant_read on public.credit_requests;
create policy credit_requests_tenant_read on public.credit_requests for select to authenticated
  using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');

revoke all on function public.rescript_billing_reserve(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, integer) from public, anon, authenticated;
revoke all on function public.rescript_billing_settle(uuid, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_release(uuid, text) from public, anon, authenticated;
revoke all on function public.rescript_billing_record(jsonb, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_credit(uuid, numeric, text, text, text, uuid, timestamptz, bigint, uuid, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_wallet_for(uuid, uuid, boolean, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_expire_reservations(timestamptz) from public, anon, authenticated;
revoke all on function public.rescript_billing_insert_usage(jsonb, uuid) from public, anon, authenticated;
