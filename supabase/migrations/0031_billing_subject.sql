/* ============================================================================
 * 0031 — A BILLING SUBJECT THAT IS NOT ALWAYS A SURVEY
 *
 * The wallet, the ledger, the rate card, the reserve/settle pair and every
 * price in `packages/billing` are product-neutral already. Three things were
 * not, and all three named the survey directly:
 *
 *   1. `project_spending.survey_id` was a primary key REFERENCING surveys, so
 *      an interview project could not have a spending policy at all;
 *   2. `rescript_billing_wallet_for` read `public.surveys` to find the owner
 *      whose personal wallet funds the work;
 *   3. `usage_reservations` / `usage_events` recorded `survey_id` with no way
 *      to say what kind of thing it was.
 *
 * After this, the subject is a PAIR — `(subject_kind, subject_id)` — and
 * `survey` is one of its values. Nothing about survey billing changes: every
 * existing function keeps its name and its signature, every existing call
 * site keeps working untouched, and the regression suite in
 * `packages/billing` proves it rather than asserting it.
 *
 * ## Why the column is renamed rather than reused
 *
 * Leaving it called `survey_id` and quietly letting it hold an interview id
 * is the exact failure this codebase keeps finding and removing: one value
 * meaning several things, with only convention to say which. `updated_at` as
 * both "last touched" and "backoff start"; one `__other` key for three boxes;
 * `d.total` from an endpoint that answers `{live, test}`. The rename is two
 * lines of migration and removes the whole class.
 *
 * ## Why the foreign key goes away, and what replaces it
 *
 * A column that can point at two tables cannot have a foreign key to either.
 * The referential guarantee that actually mattered was the CASCADE — deleting
 * a survey took its spending row with it — so that is restored explicitly, as
 * an after-delete trigger on each subject table. A policy row outliving its
 * project would otherwise be a budget nobody can see and nobody can clear.
 * ==========================================================================*/

/* ------------------------------------------------- the subject on the policy */

alter table public.project_spending
  add column if not exists subject_kind text not null default 'survey';

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'project_spending' and column_name = 'survey_id'
  ) then
    alter table public.project_spending rename column survey_id to subject_id;
  end if;
end $$;

alter table public.project_spending drop constraint if exists project_spending_survey_id_fkey;
alter table public.project_spending drop constraint if exists project_spending_pkey;
alter table public.project_spending drop constraint if exists project_spending_subject_kind_check;
alter table public.project_spending
  add constraint project_spending_subject_kind_check
  check (subject_kind in ('survey', 'interview'));

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'project_spending_pkey'
  ) then
    alter table public.project_spending add constraint project_spending_pkey
      primary key (subject_kind, subject_id);
  end if;
end $$;

create index if not exists project_spending_customer_idx
  on public.project_spending (customer_id, subject_kind);

/* ---------------------------------------- the cascade the FK used to give us */

create or replace function public.rescript_billing_forget_subject()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.project_spending
   where subject_kind = tg_argv[0] and subject_id = old.id;
  return old;
end $$;

revoke all on function public.rescript_billing_forget_subject() from public, anon, authenticated;

drop trigger if exists surveys_forget_spending on public.surveys;
create trigger surveys_forget_spending after delete on public.surveys
  for each row execute function public.rescript_billing_forget_subject('survey');

drop trigger if exists interview_projects_forget_spending on public.interview_projects;
create trigger interview_projects_forget_spending after delete on public.interview_projects
  for each row execute function public.rescript_billing_forget_subject('interview');

/* ------------------------------------------- the subject on the money rows */

/*
 * `usage_reservations` needs it because `release` and `settle` have to find
 * the spending row a hold belongs to, and the id alone no longer says which
 * table to look in. `usage_events` needs it so a usage dashboard can filter
 * one product's spend without joining to two tables to find out which it is.
 *
 * Both default to 'survey', so every row that already exists is correct and
 * every caller that has not been updated yet is correct too.
 */
alter table public.usage_reservations
  add column if not exists subject_kind text not null default 'survey';
alter table public.usage_events
  add column if not exists subject_kind text not null default 'survey';

create index if not exists usage_events_subject_idx
  on public.usage_events (subject_kind, survey_id, created_at desc);

/* ================================================================ wallets */

/**
 * The wallet a SUBJECT's charges come out of.
 *
 * The resolution order is unchanged — an explicit override, then the owner's
 * personal wallet, then the subject's own wallet while it is un-retired, then
 * the workspace wallet. The only new thing is that "who owns this" is a
 * question asked of the right table.
 *
 * An interview project has no wallet row of its own and never will:
 * `project_wallets.survey_id` still references `surveys`, and giving
 * interviews their own per-project wallets would recreate the pooling problem
 * that 0025 swept away. They fund from their owner, or from the workspace.
 */
create or replace function public.rescript_billing_subject_wallet_for(
  p_customer uuid, p_subject_kind text, p_subject uuid, p_create boolean, p_seed numeric
)
returns public.project_wallets
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w public.project_wallets;
  own public.project_wallets;
  s record;
  kind text := coalesce(p_subject_kind, 'survey');
begin
  /* no subject: the workspace wallet, exactly as before */
  if p_subject is null then
    select * into w from public.project_wallets
     where customer_id = p_customer and survey_id is null and user_id is null;
    if w.id is null and p_create then
      insert into public.project_wallets (customer_id, survey_id) values (p_customer, null)
        on conflict do nothing returning * into w;
      if w.id is null then
        select * into w from public.project_wallets
         where customer_id = p_customer and survey_id is null and user_id is null;
      elsif coalesce(p_seed, 0) > 0 then
        perform public.rescript_billing_credit(w.id, p_seed, 'credit', 'starting_credits',
          'Starting balance', null, null, null, null, 0);
        select * into w from public.project_wallets where id = w.id;
      end if;
    end if;
    return w;
  end if;

  if kind = 'interview' then
    /*
     * An interview project funds from its owner's personal wallet, or from
     * the workspace when it has none. There is no per-project wallet to fall
     * back to, and no override column — both would be new concepts for a
     * product that has not asked for them.
     */
    select owner_id, customer_id into s from public.interview_projects where id = p_subject;
    if s.owner_id is not null then
      w := public.rescript_billing_user_wallet_for(
        coalesce(s.customer_id, p_customer), s.owner_id, coalesce(p_create, true));
      if w.id is not null then return w; end if;
    end if;
    return public.rescript_billing_subject_wallet_for(
      coalesce(s.customer_id, p_customer), 'survey'::text, null::uuid, p_create, 0);
  end if;

  /* ---- surveys: unchanged, line for line, from 0025 ---- */

  select * into own from public.project_wallets where survey_id = p_subject;
  if own.shared_wallet_id is not null then
    select * into w from public.project_wallets where id = own.shared_wallet_id;
    if w.id is not null then return w; end if;
  end if;

  select owner_id, customer_id into s from public.surveys where id = p_subject;
  if s.owner_id is not null then
    w := public.rescript_billing_user_wallet_for(
      coalesce(s.customer_id, p_customer), s.owner_id, coalesce(p_create, true));
    if w.id is not null then return w; end if;
  end if;

  if own.id is null and p_create then
    insert into public.project_wallets (customer_id, survey_id)
      values (coalesce(s.customer_id, p_customer), p_subject)
      on conflict do nothing returning * into own;
    if own.id is null then
      select * into own from public.project_wallets where survey_id = p_subject;
    elsif coalesce(p_seed, 0) > 0 then
      perform public.rescript_billing_credit(own.id, p_seed, 'credit', 'starting_credits',
        'Starting balance', null, null, null, null, 0);
      select * into own from public.project_wallets where id = own.id;
    end if;
  end if;
  if own.id is not null and own.retired_at is null then return own; end if;
  return public.rescript_billing_subject_wallet_for(
    coalesce(s.customer_id, p_customer), 'survey'::text, null::uuid, p_create, 0);
end $$;

/**
 * The old name, kept exactly as it was, now one line thick.
 *
 * Every existing caller — `MeterStore.walletFor`, the admin routes, the
 * sweep — goes on calling this with the same four arguments and getting the
 * same answer. Delegating rather than duplicating is the point: there is one
 * resolution order in this database, not two that drift.
 */
create or replace function public.rescript_billing_wallet_for(
  p_customer uuid, p_survey uuid, p_create boolean, p_seed numeric default 0
)
returns public.project_wallets
language sql security definer set search_path = public, pg_temp as $$
  select public.rescript_billing_subject_wallet_for(p_customer, 'survey'::text, p_survey, p_create, p_seed)
$$;

/* =============================================================== spending */

create or replace function public.rescript_billing_subject_spending_for(
  p_subject_kind text, p_subject uuid, p_customer uuid, p_create boolean
)
returns public.project_spending
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.project_spending; c uuid; kind text := coalesce(p_subject_kind, 'survey');
begin
  if p_subject is null then return r; end if;
  select * into r from public.project_spending
   where subject_kind = kind and subject_id = p_subject;
  if r.subject_id is null and p_create then
    if kind = 'interview' then
      select customer_id into c from public.interview_projects where id = p_subject;
    else
      select customer_id into c from public.surveys where id = p_subject;
    end if;
    insert into public.project_spending (subject_kind, subject_id, customer_id)
      values (kind, p_subject, coalesce(c, p_customer))
      on conflict (subject_kind, subject_id) do nothing
      returning * into r;
    if r.subject_id is null then
      select * into r from public.project_spending
       where subject_kind = kind and subject_id = p_subject;
    end if;
  end if;
  return r;
end $$;

create or replace function public.rescript_billing_spending_for(
  p_survey uuid, p_customer uuid, p_create boolean default true
)
returns public.project_spending
language sql security definer set search_path = public, pg_temp as $$
  select public.rescript_billing_subject_spending_for('survey'::text, p_survey, p_customer, p_create)
$$;

/*
 * These two read the renamed column, so they are recreated rather than left
 * to break at their next call. Nothing about what they compute has changed.
 */
create or replace function public.rescript_billing_project_headroom(r public.project_spending)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  select case
    when r.subject_id is null then null
    when r.state = 'frozen' then 0
    when r.mode = 'budget' and r.budget_limit is not null
      then greatest(0, r.budget_limit - r.spent - r.reserved)
    else null
  end
$$;

create or replace function public.rescript_billing_project_state(r public.project_spending)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when r.mode = 'budget' and r.budget_limit is not null
      and (r.spent + r.reserved) >= r.budget_limit then 'frozen'
    else 'active' end
$$;

create or replace function public.rescript_billing_set_subject_spending(
  p_subject_kind text, p_subject uuid, p_customer uuid, p_mode text, p_limit numeric
)
returns public.project_spending
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.project_spending;
begin
  r := public.rescript_billing_subject_spending_for(
    coalesce(p_subject_kind, 'survey'), p_subject, p_customer, true);
  if r.subject_id is null then return r; end if;
  update public.project_spending
     set mode = p_mode,
         budget_limit = p_limit,
         /* raising a limit unfreezes in the same statement; a frozen project
            that has just been given room is not still frozen a moment later */
         state = 'active',
         frozen_at = null,
         updated_at = now()
   where subject_kind = r.subject_kind and subject_id = r.subject_id
   returning * into r;
  update public.project_spending
     set state = public.rescript_billing_project_state(r),
         frozen_at = case when public.rescript_billing_project_state(r) = 'frozen'
                          then now() else null end
   where subject_kind = r.subject_kind and subject_id = r.subject_id
   returning * into r;
  return r;
end $$;

create or replace function public.rescript_billing_set_spending(
  p_survey uuid, p_customer uuid, p_mode text, p_limit numeric
)
returns public.project_spending
language sql security definer set search_path = public, pg_temp as $$
  select public.rescript_billing_set_subject_spending('survey'::text, p_survey, p_customer, p_mode, p_limit)
$$;

/* ============================================================ the charges */

/*
 * Reserve, release and settle all learn the subject kind. The parameter is
 * added with a default of 'survey' and the old function is DROPPED first —
 * `create or replace` with an extra parameter would leave two overloads and
 * make every existing ten-argument call ambiguous, which is a runtime error
 * in the one code path that must never have one.
 */
drop function if exists public.rescript_billing_reserve(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, integer);

create or replace function public.rescript_billing_reserve(
  p_wallet uuid, p_customer uuid, p_survey uuid, p_user uuid, p_event_type text, p_environment text,
  p_estimated numeric, p_amount numeric, p_floor numeric, p_ttl_minutes integer,
  p_subject_kind text default 'survey'
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w public.project_wallets; r public.usage_reservations; ps public.project_spending;
  room numeric; kind text := coalesce(p_subject_kind, 'survey');
begin
  select * into w from public.project_wallets where id = p_wallet for update;
  if w.id is null then raise exception 'unknown wallet %', p_wallet; end if;

  if p_survey is not null then
    ps := public.rescript_billing_subject_spending_for(kind, p_survey, p_customer, true);
    if ps.subject_id is not null then
      select * into ps from public.project_spending
       where subject_kind = ps.subject_kind and subject_id = ps.subject_id for update;
      room := public.rescript_billing_project_headroom(ps);
      if room is not null and p_amount > room then
        return jsonb_build_object('ok', false, 'reason', 'project_limit',
          'wallet', to_jsonb(w), 'spending', to_jsonb(ps), 'headroom', room);
      end if;
    end if;
  end if;

  if (w.balance - w.reserved - p_amount) < p_floor then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_balance',
      'wallet', to_jsonb(w), 'spending', to_jsonb(ps));
  end if;

  insert into public.usage_reservations
    (wallet_id, customer_id, survey_id, subject_kind, user_id, event_type, environment,
     estimated_cost, reserved_amount, expires_at)
    values (p_wallet, p_customer, p_survey, kind, p_user, p_event_type, p_environment,
      coalesce(p_estimated, 0), p_amount,
      now() + make_interval(mins => greatest(1, coalesce(p_ttl_minutes, 30))))
    returning * into r;
  update public.project_wallets set reserved = reserved + p_amount, updated_at = now()
   where id = p_wallet returning * into w;
  if ps.subject_id is not null then
    update public.project_spending set reserved = reserved + p_amount, updated_at = now()
     where subject_kind = ps.subject_kind and subject_id = ps.subject_id returning * into ps;
  end if;
  return jsonb_build_object('ok', true, 'reservation', to_jsonb(r),
    'wallet', to_jsonb(w), 'spending', to_jsonb(ps));
end $$;

create or replace function public.rescript_billing_release(
  p_reservation uuid, p_status text default 'released'
)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.usage_reservations;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null or r.status <> 'held' then return; end if;
  update public.usage_reservations set status = p_status, settled_at = now() where id = r.id;
  update public.project_wallets
     set reserved = greatest(0, reserved - r.reserved_amount), updated_at = now()
   where id = r.wallet_id;
  if r.survey_id is not null then
    update public.project_spending
       set reserved = greatest(0, reserved - r.reserved_amount), updated_at = now()
     where subject_kind = coalesce(r.subject_kind, 'survey') and subject_id = r.survey_id;
  end if;
end $$;

create or replace function public.rescript_billing_settle(
  p_reservation uuid, p_event jsonb, p_read_only_threshold numeric
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.usage_reservations; w public.project_wallets; e public.usage_events;
  charge numeric; ps public.project_spending; kind text;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null then raise exception 'unknown reservation %', p_reservation; end if;
  if r.status <> 'held' then raise exception 'reservation already %', r.status; end if;
  kind := coalesce(r.subject_kind, 'survey');
  select * into w from public.project_wallets where id = r.wallet_id for update;
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  e := public.rescript_billing_insert_usage(p_event, r.id);
  update public.usage_reservations
     set status = 'settled', actual_charge = charge, settled_at = now() where id = r.id;
  update public.project_wallets
     set reserved = greatest(0, reserved - r.reserved_amount),
         balance = balance - charge,
         total_used = total_used + charge,
         updated_at = now()
   where id = w.id returning * into w;
  if charge <> 0 then
    insert into public.wallet_ledger
      (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, coalesce(e.survey_id, w.survey_id), 'debit', -charge,
              w.balance, e.event_type, e.id, e.user_id);
  end if;
  update public.project_wallets
     set state = public.rescript_billing_state(balance, state, p_read_only_threshold)
   where id = w.id returning * into w;

  if r.survey_id is not null then
    update public.project_spending
       set reserved = greatest(0, reserved - r.reserved_amount),
           spent = spent + charge,
           updated_at = now()
     where subject_kind = kind and subject_id = r.survey_id returning * into ps;
    if ps.subject_id is not null then
      update public.project_spending
         set state = public.rescript_billing_project_state(ps),
             frozen_at = case
               when public.rescript_billing_project_state(ps) = 'frozen' and ps.frozen_at is null then now()
               when public.rescript_billing_project_state(ps) = 'active' then null
               else ps.frozen_at end
       where subject_kind = ps.subject_kind and subject_id = ps.subject_id returning * into ps;
    end if;
  end if;
  return jsonb_build_object('event', to_jsonb(e), 'wallet', to_jsonb(w),
    'spending', case when ps.subject_id is null then null else to_jsonb(ps) end);
end $$;

/**
 * The same, for a charge that was never held.
 *
 * Recreated because it reads the renamed column — and because it is the only
 * path `Meter.record` takes, which is what a job queue's one-shot charges use.
 * The subject kind comes off the EVENT here rather than off a reservation,
 * since there is no reservation to carry it.
 */
create or replace function public.rescript_billing_record(
  p_event jsonb, p_read_only_threshold numeric
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w public.project_wallets; e public.usage_events; charge numeric; wid uuid;
  ps public.project_spending; kind text;
begin
  wid := nullif(p_event->>'walletId','')::uuid;
  kind := coalesce(nullif(p_event->>'subjectKind', ''), 'survey');
  if wid is not null then select * into w from public.project_wallets where id = wid for update; end if;
  e := public.rescript_billing_insert_usage(p_event, null);
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  /*
   * An idempotent replay returns the event that already exists, and its
   * reservation/adjustment columns are whatever they were — so the debit
   * below must not run again. `e.created_at < now()` is not a test we can
   * make; instead `insert_usage` is the only thing that knows, and it tells
   * us by returning a row whose id we did not just create. The cheap, exact
   * version of that check: a replayed event already has a ledger line.
   */
  if w.id is not null and charge <> 0 and e.adjusts_event_id is null
     and not exists (select 1 from public.wallet_ledger l where l.usage_event_id = e.id) then
    update public.project_wallets
       set balance = balance - charge, total_used = total_used + charge, updated_at = now()
     where id = w.id returning * into w;
    insert into public.wallet_ledger
      (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, coalesce(e.survey_id, w.survey_id), 'debit', -charge,
              w.balance, e.event_type, e.id, e.user_id);
    update public.project_wallets
       set state = public.rescript_billing_state(balance, state, p_read_only_threshold)
     where id = w.id returning * into w;
    if e.survey_id is not null then
      ps := public.rescript_billing_subject_spending_for(kind, e.survey_id, w.customer_id, true);
      update public.project_spending set spent = spent + charge, updated_at = now()
       where subject_kind = kind and subject_id = e.survey_id returning * into ps;
      update public.project_spending
         set state = public.rescript_billing_project_state(ps),
             frozen_at = case
               when public.rescript_billing_project_state(ps) = 'frozen' and ps.frozen_at is null then now()
               when public.rescript_billing_project_state(ps) = 'active' then null
               else ps.frozen_at end
       where subject_kind = ps.subject_kind and subject_id = ps.subject_id returning * into ps;
    end if;
  end if;
  return jsonb_build_object('event', to_jsonb(e),
    'wallet', case when w.id is null then null else to_jsonb(w) end,
    'spending', case when ps.subject_id is null then null else to_jsonb(ps) end);
end $$;

/* --------------------------------------------------------- idempotency */

/*
 * AT MOST ONCE, FOR THE CALLERS THAT NEED IT.
 *
 * There was no protection against double-charging on retry anywhere in
 * billing: a retried HTTP request took a fresh hold and wrote a fresh event,
 * and `Meter.record` — reserve and settle in one — double-charged by
 * construction. That was survivable when every meter was driven by a person
 * waiting for a page. It is not survivable for a job queue, where retrying is
 * the normal case and a transcription that costs money can be attempted three
 * times by design.
 *
 * The key is nullable, so nothing that does not pass one is affected, and
 * unique, so the second insert of the same key loses rather than duplicating.
 * `rescript_billing_insert_usage` returns the EXISTING row in that case, which
 * makes a retried settle a no-op instead of an error the caller has to
 * distinguish from a real failure.
 */
alter table public.usage_events
  add column if not exists idempotency_key text;

create unique index if not exists usage_events_idempotency_idx
  on public.usage_events (idempotency_key) where idempotency_key is not null;

create or replace function public.rescript_billing_insert_usage(
  p_event jsonb, p_reservation uuid
)
returns public.usage_events
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.usage_events; k text := nullif(p_event->>'idempotencyKey', '');
begin
  if k is not null then
    select * into e from public.usage_events where idempotency_key = k;
    if e.id is not null then return e; end if;
  end if;

  insert into public.usage_events (
    customer_id, survey_id, subject_kind, user_id, wallet_id, event_type, category, environment,
    provider, service, model, quantity, unit, input_units, output_units,
    provider_cost, infra_cost, payment_fee, tax_reserve, customer_charge,
    gross_profit, net_profit, margin_pct, reservation_id, adjusts_event_id, metadata,
    idempotency_key
  ) values (
    nullif(p_event->>'customerId','')::uuid,
    nullif(p_event->>'surveyId','')::uuid,
    coalesce(nullif(p_event->>'subjectKind',''), 'survey'),
    nullif(p_event->>'userId','')::uuid,
    nullif(p_event->>'walletId','')::uuid,
    p_event->>'eventType',
    p_event->>'category',
    p_event->>'environment',
    nullif(p_event->>'provider',''),
    nullif(p_event->>'service',''),
    nullif(p_event->>'model',''),
    coalesce((p_event->>'quantity')::numeric, 0),
    p_event->>'unit',
    coalesce((p_event->>'inputUnits')::numeric, 0),
    coalesce((p_event->>'outputUnits')::numeric, 0),
    coalesce((p_event->>'providerCost')::numeric, 0),
    coalesce((p_event->>'infraCost')::numeric, 0),
    coalesce((p_event->>'paymentFee')::numeric, 0),
    coalesce((p_event->>'taxReserve')::numeric, 0),
    coalesce((p_event->>'customerCharge')::numeric, 0),
    coalesce((p_event->>'grossProfit')::numeric, 0),
    coalesce((p_event->>'netProfit')::numeric, 0),
    coalesce((p_event->>'marginPct')::numeric, 0),
    p_reservation,
    nullif(p_event->>'adjustsEventId','')::uuid,
    coalesce(p_event->'metadata', '{}'::jsonb),
    k
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into e;

  /* somebody else won the race with the same key: theirs is the event */
  if e.id is null and k is not null then
    select * into e from public.usage_events where idempotency_key = k;
  end if;
  return e;
end $$;

/**
 * The 0025 sweep, recreated because it reads the renamed column.
 *
 * It is idempotent and has already run on every installation that has 0025;
 * it is kept working rather than dropped because it is what an installation
 * restored from an old backup would still need, and because a function left
 * referring to a column that no longer exists is a landmine for whoever runs
 * it next.
 */
create or replace function public.rescript_billing_sweep_to_owners()
returns table (survey_id uuid, moved numeric, destination uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare pw record; dest public.project_wallets; res jsonb; sp public.project_spending;
begin
  for pw in
    select w.*, s.owner_id, s.customer_id as survey_customer
      from public.project_wallets w
      join public.surveys s on s.id = w.survey_id
     where w.survey_id is not null and w.retired_at is null
  loop
    sp := public.rescript_billing_subject_spending_for(
      'survey'::text, pw.survey_id, coalesce(pw.survey_customer, pw.customer_id), true);
    if sp.subject_id is not null and sp.spent = 0 and pw.total_used > 0 then
      update public.project_spending set spent = pw.total_used, updated_at = now()
       where public.project_spending.subject_kind = 'survey'
         and public.project_spending.subject_id = pw.survey_id;
    end if;

    if pw.owner_id is null then continue; end if;

    dest := public.rescript_billing_user_wallet_for(
      coalesce(pw.survey_customer, pw.customer_id), pw.owner_id, true);
    if dest.id is null or dest.id = pw.id then continue; end if;

    if pw.balance > 0 then
      res := public.rescript_billing_transfer(pw.id, dest.id, pw.balance, 'central_wallet_migration',
        'Project wallets were replaced by one wallet per person; this balance moved to the project owner.',
        null, null, 0);
      if coalesce((res->>'ok')::boolean, false) then
        survey_id := pw.survey_id; moved := pw.balance; destination := dest.id;
        return next;
      end if;
    end if;
    update public.project_wallets set retired_at = now(), updated_at = now() where id = pw.id;
  end loop;
  return;
end $$;

/* ------------------------------------------------------------ permissions */

revoke all on function public.rescript_billing_subject_wallet_for(uuid, text, uuid, boolean, numeric)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_wallet_for(uuid, uuid, boolean, numeric)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_subject_spending_for(text, uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_spending_for(uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_set_subject_spending(text, uuid, uuid, text, numeric)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_set_spending(uuid, uuid, text, numeric)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_reserve(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, integer, text)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_release(uuid, text) from public, anon, authenticated;
revoke all on function public.rescript_billing_settle(uuid, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_insert_usage(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.rescript_billing_record(jsonb, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_sweep_to_owners() from public, anon, authenticated;
revoke all on function public.rescript_billing_project_headroom(public.project_spending)
  from public, anon, authenticated;
revoke all on function public.rescript_billing_project_state(public.project_spending)
  from public, anon, authenticated;
