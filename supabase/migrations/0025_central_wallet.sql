/*
 * ONE WALLET PER PERSON, MANY PROJECTS SPENDING FROM IT.
 *
 * Until now a wallet belonged to a project: money was moved into a study
 * before that study could run, and a researcher with five studies kept five
 * balances topped up by hand. This migration inverts that. A person has ONE
 * wallet; every project they own draws from it; and what a project may take
 * is decided by a POLICY on the project rather than by a pot of money sitting
 * inside it.
 *
 * ## The three moving parts
 *
 * 1. `rescript_billing_wallet_for` now resolves a project to its OWNER'S
 *    wallet. It is done HERE, in SQL, rather than in the application, because
 *    everything that asks "which wallet does this project spend from" must
 *    get the same answer: the Studio charging an AI call, the respondent
 *    runtime that has no signed-in user at all, the dashboard, the admin
 *    table, the transfer screen. The previous shared-wallet feature
 *    (`shared_wallet_id`) was followed by exactly one code path and ignored
 *    by every other, so two screens could show two balances for one project.
 *    An explicit `shared_wallet_id` still wins where one is set — it is an
 *    administrator's deliberate override — but nothing needs to set it now.
 *
 * 2. `project_spending` holds the per-project policy and what the project has
 *    actually spent. It is NOT a wallet: it holds no money, and moving a
 *    budget from $1 to $100 moves nothing — it changes how much of the
 *    person's wallet that project is permitted to consume.
 *
 * 3. The cap is enforced in `rescript_billing_reserve`, the one gate every
 *    charge already passes through, in the same transaction and under the
 *    same row locks as the balance check. A cap enforced anywhere else is a
 *    cap that two concurrent operations can walk straight past.
 *
 * ## What happens to the money already in project wallets
 *
 * It moves to the owner, as a recorded transfer through the existing
 * `rescript_billing_transfer` — so the ledger explains where every cent went,
 * both wallets have matching lines under one transfer id, and the totals
 * before and after are identical. The emptied project wallet is marked
 * `retired_at`: kept, because `wallet_ledger` rows point at it and that
 * history is immutable, but never resolved as a funding wallet again.
 *
 * Idempotent: safe to run twice.
 */

/* ------------------------------------------------------------ the policy */

create table if not exists public.project_spending (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  /*
   * shared   — spends from the owner's wallet with no limit of its own
   * budget   — may consume at most `budget_limit` from that wallet, ever
   * priority — shared, and flagged as the study the wallet is mainly for
   */
  mode text not null default 'shared' check (mode in ('shared','budget','priority')),
  budget_limit numeric(18,6),
  /* customer charges attributed to this project, cumulative and never reset */
  spent numeric(18,6) not null default 0,
  /* held by this project's operations in flight */
  reserved numeric(18,6) not null default 0,
  state text not null default 'active' check (state in ('active','frozen')),
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists project_spending_customer_idx on public.project_spending (customer_id);
create index if not exists project_spending_state_idx on public.project_spending (state) where state = 'frozen';

alter table public.project_spending enable row level security;
drop policy if exists project_spending_tenant_read on public.project_spending;
create policy project_spending_tenant_read on public.project_spending for select to authenticated
  using (customer_id = public.current_customer_id() or public.current_role() = 'platform_admin');

/* a project wallet that has been emptied into its owner's wallet */
alter table public.project_wallets add column if not exists retired_at timestamptz;

/* --------------------------------------------------------- the resolvers */

/**
 * The wallet a project's charges come out of.
 *
 * Order: an explicit `shared_wallet_id` override on the project's own row,
 * then the project owner's personal wallet (created on demand), then the
 * workspace wallet for a project with no owner. A project wallet is only
 * used as a last resort, and only while it has not been retired — which is
 * what keeps an installation that has not run the sweep yet working.
 */
create or replace function public.rescript_billing_wallet_for(p_customer uuid, p_survey uuid, p_create boolean, p_seed numeric default 0)
returns public.project_wallets
language plpgsql security definer set search_path = public as $$
declare
  w public.project_wallets;
  own public.project_wallets;
  s record;
begin
  if p_survey is null then
    select * into w from public.project_wallets where customer_id = p_customer and survey_id is null and user_id is null;
    if w.id is null and p_create then
      insert into public.project_wallets (customer_id, survey_id) values (p_customer, null)
        on conflict do nothing returning * into w;
      if w.id is null then
        select * into w from public.project_wallets where customer_id = p_customer and survey_id is null and user_id is null;
      elsif coalesce(p_seed, 0) > 0 then
        perform public.rescript_billing_credit(w.id, p_seed, 'credit', 'starting_credits', 'Starting balance', null, null, null, null, 0);
        select * into w from public.project_wallets where id = w.id;
      end if;
    end if;
    return w;
  end if;

  /* an administrator's explicit override on the project's own wallet row */
  select * into own from public.project_wallets where survey_id = p_survey;
  if own.shared_wallet_id is not null then
    select * into w from public.project_wallets where id = own.shared_wallet_id;
    if w.id is not null then return w; end if;
  end if;

  select owner_id, customer_id into s from public.surveys where id = p_survey;
  if s.owner_id is not null then
    w := public.rescript_billing_user_wallet_for(coalesce(s.customer_id, p_customer), s.owner_id, coalesce(p_create, true));
    if w.id is not null then return w; end if;
  end if;

  /*
   * A PROJECT WITH NO OWNER KEEPS EXACTLY WHAT IT HAD.
   *
   * Ownership only became a column in 0008, and a project that predates it —
   * or whose owner's account was deleted — has nobody to bill. Sending those
   * to the workspace wallet would silently pool several projects' money the
   * first time this function ran, so instead they go on funding themselves
   * from their own wallet exactly as before. The workspace wallet is reached
   * only by a project whose own wallet has been retired by the sweep.
   */
  if own.id is null and p_create then
    insert into public.project_wallets (customer_id, survey_id) values (coalesce(s.customer_id, p_customer), p_survey)
      on conflict do nothing returning * into own;
    if own.id is null then
      select * into own from public.project_wallets where survey_id = p_survey;
    elsif coalesce(p_seed, 0) > 0 then
      perform public.rescript_billing_credit(own.id, p_seed, 'credit', 'starting_credits', 'Starting balance', null, null, null, null, 0);
      select * into own from public.project_wallets where id = own.id;
    end if;
  end if;
  if own.id is not null and own.retired_at is null then return own; end if;
  return public.rescript_billing_wallet_for(coalesce(s.customer_id, p_customer), null, p_create, 0);
end $$;

/** This project's spending row, created on demand. */
create or replace function public.rescript_billing_spending_for(p_survey uuid, p_customer uuid, p_create boolean default true)
returns public.project_spending
language plpgsql security definer set search_path = public as $$
declare r public.project_spending; c uuid;
begin
  if p_survey is null then return r; end if;
  select * into r from public.project_spending where survey_id = p_survey;
  if r.survey_id is null and p_create then
    select customer_id into c from public.surveys where id = p_survey;
    insert into public.project_spending (survey_id, customer_id) values (p_survey, coalesce(c, p_customer))
      on conflict (survey_id) do nothing returning * into r;
    if r.survey_id is null then select * into r from public.project_spending where survey_id = p_survey; end if;
  end if;
  return r;
end $$;

/**
 * What a project has left under its own policy.
 *
 * `null` means "no limit of its own" — a shared or priority project is bounded
 * only by the wallet. A budgeted project's headroom counts money already held
 * by its own operations in flight, so two concurrent calls cannot both be told
 * there is room for the last dollar.
 */
create or replace function public.rescript_billing_project_headroom(r public.project_spending)
returns numeric language sql immutable as $$
  select case
    when r.survey_id is null then null
    when r.state = 'frozen' then 0
    when r.mode = 'budget' and r.budget_limit is not null then greatest(0, r.budget_limit - r.spent - r.reserved)
    else null
  end
$$;

/** The state a project's spending should be in for what it has spent. */
create or replace function public.rescript_billing_project_state(r public.project_spending)
returns text language sql immutable as $$
  select case
    when r.mode = 'budget' and r.budget_limit is not null and (r.spent + r.reserved) >= r.budget_limit then 'frozen'
    else 'active' end
$$;

/* ------------------------------------------------------- the charge gate */

/**
 * Reserve, with the project's cap checked beside the wallet's floor.
 *
 * Both rows are locked, in a fixed order (wallet, then project) so that a
 * charge and a budget change cannot deadlock against each other, and both
 * tests are made under those locks. `reason` says which test refused, because
 * "this project has reached its limit" and "your wallet is empty" ask the
 * person to do two completely different things.
 */
create or replace function public.rescript_billing_reserve(
  p_wallet uuid, p_customer uuid, p_survey uuid, p_user uuid, p_event_type text, p_environment text,
  p_estimated numeric, p_amount numeric, p_floor numeric, p_ttl_minutes integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets; r public.usage_reservations; ps public.project_spending; room numeric;
begin
  select * into w from public.project_wallets where id = p_wallet for update;
  if w.id is null then raise exception 'unknown wallet %', p_wallet; end if;

  if p_survey is not null then
    ps := public.rescript_billing_spending_for(p_survey, p_customer, true);
    if ps.survey_id is not null then
      select * into ps from public.project_spending where survey_id = ps.survey_id for update;
      room := public.rescript_billing_project_headroom(ps);
      if room is not null and p_amount > room then
        return jsonb_build_object('ok', false, 'reason', 'project_limit', 'wallet', to_jsonb(w), 'spending', to_jsonb(ps), 'headroom', room);
      end if;
    end if;
  end if;

  if (w.balance - w.reserved - p_amount) < p_floor then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'wallet', to_jsonb(w), 'spending', to_jsonb(ps));
  end if;

  insert into public.usage_reservations (wallet_id, customer_id, survey_id, user_id, event_type, environment, estimated_cost, reserved_amount, expires_at)
    values (p_wallet, p_customer, p_survey, p_user, p_event_type, p_environment, coalesce(p_estimated, 0), p_amount, now() + make_interval(mins => greatest(1, coalesce(p_ttl_minutes, 30))))
    returning * into r;
  update public.project_wallets set reserved = reserved + p_amount, updated_at = now() where id = p_wallet returning * into w;
  if ps.survey_id is not null then
    update public.project_spending set reserved = reserved + p_amount, updated_at = now() where survey_id = ps.survey_id returning * into ps;
  end if;
  return jsonb_build_object('ok', true, 'reservation', to_jsonb(r), 'wallet', to_jsonb(w), 'spending', to_jsonb(ps));
end $$;

/** Give a hold back — to the wallet and to the project that was holding it. */
create or replace function public.rescript_billing_release(p_reservation uuid, p_status text default 'released')
returns void
language plpgsql security definer set search_path = public as $$
declare r public.usage_reservations;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null or r.status <> 'held' then return; end if;
  update public.usage_reservations set status = p_status, settled_at = now() where id = r.id;
  update public.project_wallets set reserved = greatest(0, reserved - r.reserved_amount), updated_at = now() where id = r.wallet_id;
  if r.survey_id is not null then
    update public.project_spending set reserved = greatest(0, reserved - r.reserved_amount), updated_at = now() where survey_id = r.survey_id;
  end if;
end $$;

/**
 * Settle: the wallet pays, and the PROJECT's meter records what it spent.
 *
 * `wallet_ledger.survey_id` now comes from the usage event rather than from
 * the wallet. Under a central wallet the wallet has no project, so taking it
 * from there would attribute every line to nothing and the per-project
 * history would empty itself.
 */
create or replace function public.rescript_billing_settle(p_reservation uuid, p_event jsonb, p_read_only_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.usage_reservations; w public.project_wallets; e public.usage_events; charge numeric; ps public.project_spending;
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
      values (w.id, w.customer_id, coalesce(e.survey_id, w.survey_id), 'debit', -charge, w.balance, e.event_type, e.id, e.user_id);
  end if;
  update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = w.id returning * into w;

  if r.survey_id is not null then
    update public.project_spending
       set reserved = greatest(0, reserved - r.reserved_amount),
           spent = spent + charge,
           updated_at = now()
     where survey_id = r.survey_id returning * into ps;
    if ps.survey_id is not null then
      update public.project_spending
         set state = public.rescript_billing_project_state(ps),
             frozen_at = case when public.rescript_billing_project_state(ps) = 'frozen' and ps.frozen_at is null then now()
                              when public.rescript_billing_project_state(ps) = 'active' then null else ps.frozen_at end
       where survey_id = ps.survey_id returning * into ps;
    end if;
  end if;
  return jsonb_build_object('event', to_jsonb(e), 'wallet', to_jsonb(w), 'spending', case when ps.survey_id is null then null else to_jsonb(ps) end);
end $$;

/** The same, for a charge that was never held. */
create or replace function public.rescript_billing_record(p_event jsonb, p_read_only_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.project_wallets; e public.usage_events; charge numeric; wid uuid; ps public.project_spending;
begin
  wid := nullif(p_event->>'walletId','')::uuid;
  if wid is not null then select * into w from public.project_wallets where id = wid for update; end if;
  e := public.rescript_billing_insert_usage(p_event, null);
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  if w.id is not null and charge <> 0 and e.adjusts_event_id is null then
    update public.project_wallets set balance = balance - charge, total_used = total_used + charge, updated_at = now() where id = w.id returning * into w;
    insert into public.wallet_ledger (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, coalesce(e.survey_id, w.survey_id), 'debit', -charge, w.balance, e.event_type, e.id, e.user_id);
    update public.project_wallets set state = public.rescript_billing_state(balance, state, p_read_only_threshold) where id = w.id returning * into w;
    if e.survey_id is not null then
      ps := public.rescript_billing_spending_for(e.survey_id, w.customer_id, true);
      update public.project_spending set spent = spent + charge, updated_at = now() where survey_id = e.survey_id returning * into ps;
      update public.project_spending
         set state = public.rescript_billing_project_state(ps),
             frozen_at = case when public.rescript_billing_project_state(ps) = 'frozen' and ps.frozen_at is null then now()
                              when public.rescript_billing_project_state(ps) = 'active' then null else ps.frozen_at end
       where survey_id = ps.survey_id returning * into ps;
    end if;
  end if;
  return jsonb_build_object('event', to_jsonb(e), 'wallet', case when w.id is null then null else to_jsonb(w) end,
                            'spending', case when ps.survey_id is null then null else to_jsonb(ps) end);
end $$;

/**
 * Set a project's spending policy.
 *
 * Moves no money — that is the whole point of the model. Raising a limit
 * unfreezes the project in the same statement, because a person who has just
 * said "this study may spend $100" should not also have to find a switch that
 * says "and start it again".
 */
create or replace function public.rescript_billing_set_spending(p_survey uuid, p_customer uuid, p_mode text, p_limit numeric)
returns public.project_spending
language plpgsql security definer set search_path = public as $$
declare r public.project_spending;
begin
  r := public.rescript_billing_spending_for(p_survey, p_customer, true);
  if r.survey_id is null then raise exception 'unknown project %', p_survey; end if;
  update public.project_spending
     set mode = coalesce(p_mode, mode),
         budget_limit = case when coalesce(p_mode, mode) = 'budget' then p_limit else null end,
         updated_at = now()
   where survey_id = p_survey returning * into r;
  update public.project_spending
     set state = public.rescript_billing_project_state(r),
         frozen_at = case when public.rescript_billing_project_state(r) = 'frozen' then coalesce(r.frozen_at, now()) else null end
   where survey_id = p_survey returning * into r;
  return r;
end $$;

/* -------------------------------------------------- the one-time sweep */

/**
 * Move every project wallet's balance to its owner, once.
 *
 * Through `rescript_billing_transfer`, so both sides get ledger lines under
 * one transfer id and the money is traceable rather than teleported. A
 * project whose balance is already zero is retired without a transfer. A
 * project with no owner is left alone: there is nobody to give it to, and it
 * goes on funding itself until somebody takes ownership.
 */
create or replace function public.rescript_billing_sweep_to_owners()
returns table (survey_id uuid, moved numeric, destination uuid)
language plpgsql security definer set search_path = public as $$
declare pw record; dest public.project_wallets; res jsonb; sp public.project_spending;
begin
  for pw in
    select w.*, s.owner_id, s.customer_id as survey_customer
      from public.project_wallets w
      join public.surveys s on s.id = w.survey_id
     where w.survey_id is not null and w.retired_at is null
  loop
    /* the project's history follows it: what it has spent is what it has spent */
    sp := public.rescript_billing_spending_for(pw.survey_id, coalesce(pw.survey_customer, pw.customer_id), true);
    if sp.survey_id is not null and sp.spent = 0 and pw.total_used > 0 then
      update public.project_spending set spent = pw.total_used, updated_at = now() where public.project_spending.survey_id = pw.survey_id;
    end if;

    if pw.owner_id is null then
      continue;
    end if;

    dest := public.rescript_billing_user_wallet_for(coalesce(pw.survey_customer, pw.customer_id), pw.owner_id, true);
    if dest.id is null or dest.id = pw.id then
      continue;
    end if;

    if pw.balance > 0 then
      res := public.rescript_billing_transfer(pw.id, dest.id, pw.balance, 'central_wallet_migration',
        'Project wallets were replaced by one wallet per person; this balance moved to the project owner.', null, null, 0);
      if coalesce((res->>'ok')::boolean, false) then
        survey_id := pw.survey_id; moved := pw.balance; destination := dest.id;
        return next;
      end if;
    end if;
    update public.project_wallets set retired_at = now(), updated_at = now() where id = pw.id;
  end loop;
  return;
end $$;

select public.rescript_billing_sweep_to_owners();

/* every existing project gets a policy row, defaulting to the shared wallet */
insert into public.project_spending (survey_id, customer_id)
select s.id, s.customer_id from public.surveys s
  where not exists (select 1 from public.project_spending p where p.survey_id = s.id)
on conflict (survey_id) do nothing;

revoke all on function public.rescript_billing_spending_for(uuid, uuid, boolean) from authenticated, anon;
revoke all on function public.rescript_billing_set_spending(uuid, uuid, text, numeric) from authenticated, anon;
revoke all on function public.rescript_billing_sweep_to_owners() from authenticated, anon;
