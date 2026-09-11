-- =====================================================================
-- 0024 — CREDIT TRANSFERS and PERSONAL WALLETS
--
-- An administrator can move UNUSED credits from one wallet to another:
-- project → project, project → person, person → project, person → person.
-- "Unused" is `balance − reserved`: what an open reservation holds for an
-- operation in flight is not available, and overdraft room is never
-- transferable.
--
-- ONE TRANSACTION, TWO LEDGER LINES. `rescript_billing_transfer` locks both
-- wallet rows (in id order, so two administrators crossing transfers cannot
-- deadlock), checks the source's available balance, writes ONE row in
-- `credit_transfers` and TWO lines in `wallet_ledger` — `transfer_out` on the
-- source, `transfer_in` on the destination — both carrying the transfer id.
-- Either everything commits or nothing does. Balances are never assigned;
-- they move by exactly the ledger amounts.
--
-- REVERSAL IS A NEW TRANSFER. `p_reversal_of` writes a second transfer row in
-- the opposite direction whose ledger lines are `transfer_reversal`; the
-- original is marked reversed and points at it. Nothing is edited or
-- deleted; the ledger's immutability trigger still stands.
--
-- PERSONAL WALLETS. `project_wallets` gains `user_id`: a wallet owned by a
-- person rather than a project — the pool a transfer "to User B" lands in,
-- and a source to draw from. A project can be pointed at it through the
-- existing `shared_wallet_id`.
-- =====================================================================

alter table public.project_wallets add column if not exists user_id uuid references public.profiles(id) on delete cascade;
create unique index if not exists project_wallets_user_idx on public.project_wallets (user_id) where user_id is not null;
-- the workspace wallet is the one with neither a project nor a person
drop index if exists public.project_wallets_workspace_idx;
create unique index if not exists project_wallets_workspace_idx on public.project_wallets (customer_id) where survey_id is null and user_id is null;

alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in ('credit','debit','adjustment','reversal','expiry','transfer_out','transfer_in','transfer_reversal'));
alter table public.wallet_ledger add column if not exists transfer_id uuid;
create index if not exists wallet_ledger_transfer_idx on public.wallet_ledger (transfer_id) where transfer_id is not null;

create sequence if not exists public.credit_transfer_code_seq start 10001;

create table if not exists public.credit_transfers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('TRX-' || nextval('public.credit_transfer_code_seq')::text),
  customer_id uuid not null,
  source_wallet_id uuid not null references public.project_wallets(id),
  destination_wallet_id uuid not null references public.project_wallets(id),
  source_kind text not null check (source_kind in ('project','user','workspace')),
  destination_kind text not null check (destination_kind in ('project','user','workspace')),
  source_ref uuid,
  destination_ref uuid,
  amount numeric(18,6) not null check (amount > 0),
  currency text not null default 'USD',
  reason text,
  note text,
  transferred_by uuid,
  status text not null default 'completed' check (status in ('completed','reversed')),
  reversal_of uuid references public.credit_transfers(id),
  reversed_by uuid references public.credit_transfers(id),
  created_at timestamptz not null default now()
);
create index if not exists credit_transfers_customer_idx on public.credit_transfers (customer_id, created_at desc);
create index if not exists credit_transfers_source_idx on public.credit_transfers (source_wallet_id, created_at desc);
create index if not exists credit_transfers_destination_idx on public.credit_transfers (destination_wallet_id, created_at desc);
create index if not exists credit_transfers_refs_idx on public.credit_transfers (source_ref, destination_ref);

/* only the reversal linkage may ever change on a transfer row */
create or replace function public.rescript_billing_transfer_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'credit transfers are never deleted — write a reversal'; end if;
  if new.id <> old.id or new.code <> old.code or new.source_wallet_id <> old.source_wallet_id or new.destination_wallet_id <> old.destination_wallet_id
     or new.amount <> old.amount or new.created_at <> old.created_at or new.transferred_by is distinct from old.transferred_by
     or new.reason is distinct from old.reason or new.note is distinct from old.note or new.reversal_of is distinct from old.reversal_of then
    raise exception 'credit transfers are immutable — only the reversal status may change';
  end if;
  return new;
end $$;
drop trigger if exists credit_transfers_guard on public.credit_transfers;
create trigger credit_transfers_guard before update or delete on public.credit_transfers
  for each row execute function public.rescript_billing_transfer_guard();

/* a person's own wallet */
create or replace function public.rescript_billing_user_wallet_for(p_customer uuid, p_user uuid, p_create boolean)
returns public.project_wallets
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets;
begin
  select * into w from public.project_wallets where user_id = p_user;
  if w.id is null and p_create then
    insert into public.project_wallets (customer_id, survey_id, user_id) values (p_customer, null, p_user)
      on conflict do nothing returning * into w;
    if w.id is null then select * into w from public.project_wallets where user_id = p_user; end if;
  end if;
  return w;
end $$;

/* `wallet_for` must not hand back a personal wallet when asked for the workspace one */
create or replace function public.rescript_billing_wallet_for(p_customer uuid, p_survey uuid, p_create boolean, p_seed numeric default 0)
returns public.project_wallets
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets;
begin
  if p_survey is null then
    select * into w from public.project_wallets where customer_id = p_customer and survey_id is null and user_id is null;
  else
    select * into w from public.project_wallets where survey_id = p_survey;
  end if;
  if w.id is null and p_create then
    insert into public.project_wallets (customer_id, survey_id) values (p_customer, p_survey)
      on conflict do nothing
      returning * into w;
    if w.id is null then
      if p_survey is null then select * into w from public.project_wallets where customer_id = p_customer and survey_id is null and user_id is null;
      else select * into w from public.project_wallets where survey_id = p_survey; end if;
    elsif coalesce(p_seed, 0) > 0 then
      perform public.rescript_billing_credit(w.id, p_seed, 'credit', 'starting_credits', 'Starting balance', null, null, null, null, 0);
      select * into w from public.project_wallets where id = w.id;
    end if;
  end if;
  return w;
end $$;

/* THE TRANSFER */
create or replace function public.rescript_billing_transfer(
  p_source uuid, p_destination uuid, p_amount numeric, p_reason text, p_note text, p_by uuid, p_reversal_of uuid, p_read_only_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.project_wallets; d public.project_wallets; t public.credit_transfers; o public.credit_transfers;
        avail numeric; kind_out text; kind_in text; reason_text text;
        skind text; dkind text;
begin
  if p_source = p_destination then return jsonb_build_object('ok', false, 'reason', 'same_wallet'); end if;
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;

  -- lock both rows in a fixed order so crossing transfers cannot deadlock
  if p_source < p_destination then
    select * into s from public.project_wallets where id = p_source for update;
    select * into d from public.project_wallets where id = p_destination for update;
  else
    select * into d from public.project_wallets where id = p_destination for update;
    select * into s from public.project_wallets where id = p_source for update;
  end if;
  if s.id is null or d.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_wallet'); end if;

  if p_reversal_of is not null then
    select * into o from public.credit_transfers where id = p_reversal_of for update;
    if o.id is null or o.status = 'reversed' or o.reversal_of is not null then return jsonb_build_object('ok', false, 'reason', 'already_reversed'); end if;
    kind_out := 'transfer_reversal'; kind_in := 'transfer_reversal'; reason_text := coalesce(p_reason, 'transfer_reversal');
  else
    kind_out := 'transfer_out'; kind_in := 'transfer_in'; reason_text := coalesce(p_reason, 'credit_transfer');
  end if;

  avail := greatest(0, s.balance - s.reserved);
  if p_amount > avail then return jsonb_build_object('ok', false, 'reason', 'insufficient_available', 'available', avail); end if;

  skind := case when s.survey_id is not null then 'project' when s.user_id is not null then 'user' else 'workspace' end;
  dkind := case when d.survey_id is not null then 'project' when d.user_id is not null then 'user' else 'workspace' end;

  insert into public.credit_transfers (customer_id, source_wallet_id, destination_wallet_id, source_kind, destination_kind, source_ref, destination_ref, amount, currency, reason, note, transferred_by, reversal_of)
    values (s.customer_id, s.id, d.id, skind, dkind, coalesce(s.survey_id, s.user_id), coalesce(d.survey_id, d.user_id), p_amount, s.currency, p_reason, p_note, p_by, p_reversal_of)
    returning * into t;

  update public.project_wallets set balance = balance - p_amount, updated_at = now() where id = s.id returning * into s;
  update public.project_wallets set balance = balance + p_amount, total_added = total_added + p_amount, updated_at = now() where id = d.id returning * into d;

  insert into public.wallet_ledger (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, note, transfer_id, created_by)
    values (s.id, s.customer_id, s.survey_id, kind_out, -p_amount, s.balance, reason_text, p_note, t.id, p_by);
  insert into public.wallet_ledger (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, note, transfer_id, created_by)
    values (d.id, d.customer_id, d.survey_id, kind_in, p_amount, d.balance, reason_text, p_note, t.id, p_by);

  if o.id is not null then
    update public.credit_transfers set status = 'reversed', reversed_by = t.id where id = o.id;
  end if;

  update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = s.id returning * into s;
  update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = d.id returning * into d;

  return jsonb_build_object('ok', true, 'transfer', to_jsonb(t), 'source', to_jsonb(s), 'destination', to_jsonb(d));
end $$;

alter table public.credit_transfers enable row level security;
drop policy if exists credit_transfers_admin_read on public.credit_transfers;
create policy credit_transfers_admin_read on public.credit_transfers for select to authenticated
  using (public.current_role() = 'platform_admin');

revoke all on function public.rescript_billing_transfer(uuid, uuid, numeric, text, text, uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_user_wallet_for(uuid, uuid, boolean) from public, anon, authenticated;
