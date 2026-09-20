-- ============================================================================
-- 0044 · BILLING PERIODS, AND THE THREE COLUMNS AN INVOICE NEEDS
-- ============================================================================
--
-- An invoice is an aggregation of `usage_events` over a window. Three things
-- were missing before one could be built honestly.
--
-- `billing_period_id` — WHICH window an event belongs to, decided when the
-- event is written rather than by a date range at reporting time. A date
-- range re-derived later silently moves events between invoices whenever a
-- period boundary is adjusted, a timezone is reconsidered, or a row lands a
-- second either side of midnight. Stamping it at insert makes an issued
-- invoice reproducible: the same rows, for ever, whatever anyone later
-- decides about boundaries.
--
-- `unit_price` — the price per unit AT THE TIME. `customer_charge` records
-- what was charged, but not the rate it came from, so re-deriving an invoice
-- line after a price change produced a different number from the one the
-- customer was sent. A price is a fact about the moment, and it belongs on
-- the row.
--
-- `respondent_id` — which respondent the usage belongs to, where there is
-- one. Cost per complete is the number this platform is judged on
-- commercially, and it cannot be computed from a survey-level total when one
-- interview used the AI probe nine times and the next used it none.
--
-- NOTHING IS BACK-FILLED. `usage_events` is immutable by trigger, and that is
-- the point of it: the rows that exist were written under the rules that
-- existed. They belong to no period and carry no unit price, and an invoice
-- that begins at the first period is a truthful invoice. Inventing a period
-- for historical rows would be the first act of a billing system that edits
-- its own history.

alter table public.usage_events
  add column if not exists respondent_id     uuid references public.respondents(id) on delete set null,
  add column if not exists unit_price        numeric(18,8),
  add column if not exists billing_period_id uuid;

comment on column public.usage_events.unit_price is
  'Customer price per unit at the moment this event was written. customer_charge records what was charged; this records the rate it came from, so an invoice line can be re-derived after a price change and still match what the customer was sent.';
comment on column public.usage_events.respondent_id is
  'The respondent this usage belongs to, where there is one. Cost per complete cannot be derived from a survey-level total.';

-- ---------------------------------------------------------------- periods

create table if not exists public.billing_periods (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  starts_at timestamptz not null,
  /*
   * Exclusive. A period is [starts_at, ends_at), so two consecutive periods
   * share a boundary instant and no event can fall into both or neither —
   * the off-by-one that puts one interview on two invoices.
   */
  ends_at timestamptz not null,
  /*
   * open    — events may still be stamped into it
   * closing — no new events; the invoice is being built
   * closed  — invoiced, and immutable from here
   */
  status text not null default 'open' check (status in ('open','closing','closed')),
  closed_at timestamptz,
  closed_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint billing_periods_window check (ends_at > starts_at)
);

/*
 * ONE OPEN PERIOD PER CUSTOMER, enforced rather than assumed.
 *
 * Two open periods is not a tidiness problem: the insert path asks "which
 * period is open for this customer" and gets an arbitrary answer, so events
 * from one afternoon split across two invoices depending on which row the
 * planner happened to return. A partial unique index says it once, in the
 * only place that cannot be bypassed.
 */
create unique index if not exists billing_periods_one_open
  on public.billing_periods (customer_id)
  where status = 'open';

create index if not exists billing_periods_customer_idx
  on public.billing_periods (customer_id, starts_at desc);

create index if not exists usage_events_period_idx
  on public.usage_events (billing_period_id)
  where billing_period_id is not null;

alter table public.usage_events
  add constraint usage_events_period_fk
  foreign key (billing_period_id) references public.billing_periods(id) on delete set null;

comment on table public.billing_periods is
  'The window an invoice covers. Events are stamped with their period when written, not matched to one by date at reporting time, so an issued invoice covers the same rows for ever.';

-- ------------------------------------------------------------------- RLS

alter table public.billing_periods enable row level security;

/*
 * Read for the tenant, writes through the service role only — the same shape
 * the rest of the billing tables use. A customer may see their own periods;
 * opening and closing one is an administrative act behind the apps' guards.
 */
drop policy if exists billing_periods_tenant_read on public.billing_periods;
create policy billing_periods_tenant_read on public.billing_periods
  for select to authenticated
  using (customer_id = public.current_customer_id() or public.rescript_is_platform_admin(auth.uid()));

grant select on public.billing_periods to authenticated;

-- ------------------------------------------------- the open period, atomically

/*
 * The period an event written NOW belongs to, creating one if the customer
 * has none.
 *
 * `security definer` and one statement, because two concurrent first-events
 * for the same customer would otherwise both find nothing and both insert —
 * and the partial unique index above would turn the loser into a failed
 * usage write. `on conflict do nothing` plus a re-select makes the loser take
 * the winner's period instead, which is the answer it wanted anyway.
 */
create or replace function public.rescript_billing_open_period(
  p_customer uuid,
  p_starts timestamptz default date_trunc('month', now()),
  p_ends timestamptz default (date_trunc('month', now()) + interval '1 month')
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.billing_periods
   where customer_id = p_customer and status = 'open' limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.billing_periods (customer_id, starts_at, ends_at)
  values (p_customer, p_starts, p_ends)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.billing_periods
     where customer_id = p_customer and status = 'open' limit 1;
  end if;
  return v_id;
end $$;

revoke all on function public.rescript_billing_open_period(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.rescript_billing_open_period(uuid, timestamptz, timestamptz) to service_role;
