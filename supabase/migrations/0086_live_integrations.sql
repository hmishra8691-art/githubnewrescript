-- 0086 — The recruitment exchange, Phase 6: live integrations (2026-11-03).
--
-- Phases 1–5 built an exchange over vendors an operator configures by hand. This adds what a vendor the
-- platform actually TALKS TO needs: a record of every call made to it, the events it sends back, the state of
-- the circuit breaker that protects everything else when it fails, and the reconciliation of what it believes
-- it is owed against what the platform agrees.
--
--   vendor_api_calls          one row per outbound call. Health is COMPUTED from this rather than declared, so
--                             `vendor_integrations.health` can stop being an operator's opinion. No query
--                             string is stored: a query can carry a participant id.
--   vendor_circuit_state      the breaker, durable. packages/recruitment/src/http.ts keeps an in-process copy
--                             as a fast path, but on serverless hosting each invocation may be a cold process,
--                             so a breaker that lives only in memory is one that silently does nothing.
--   vendor_webhook_receipts   every delivery, VERIFIED OR NOT, with the verdict and the raw body. An endpoint
--                             that drops what it cannot verify is indistinguishable from a broken one.
--   settlement_reconciliations / settlement_differences
--                             the three accounts of one order — claimed, agreed, payable — and a row per
--                             disagreement with its cause. Nothing here resolves a dispute; it states one.
--
-- ## Nothing in this migration moves money
--
-- A settlement row is a statement of what the two sides believe, for a human to act on. The billing hold from
-- 0084 still governs what is payable, and an unresolved difference stays unresolved until somebody decides it.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.settlement_differences, public.settlement_reconciliations,
--     public.vendor_webhook_receipts, public.vendor_circuit_state, public.vendor_api_calls cascade;

/* ------------------------------------------------------------ what we called, and what happened */

create table if not exists public.vendor_api_calls (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  operation text not null check (char_length(operation) between 1 and 60),
  method text not null check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  /*
   * The PATH only. A query string on a recruitment API routinely carries a participant identifier, and this
   * table is kept long enough for health trends — long enough that storing one would be a quiet re-identification
   * surface sitting beside the identity registry that 0083 went to such lengths to keep hashed.
   */
  path text not null check (char_length(path) <= 300),
  status integer check (status is null or (status >= 100 and status <= 599)),
  ok boolean not null default false,
  attempts integer not null default 1 check (attempts >= 0),
  elapsed_ms integer not null default 0 check (elapsed_ms >= 0),
  error text check (error is null or char_length(error) <= 500),
  called_at timestamptz not null default now()
);
create index if not exists vendor_api_calls_health_idx
  on public.vendor_api_calls (integration_id, called_at desc);
create index if not exists vendor_api_calls_failures_idx
  on public.vendor_api_calls (integration_id, called_at desc) where not ok;

/* ------------------------------------------------------------ the breaker, where a cold process can find it */

create table if not exists public.vendor_circuit_state (
  integration_id uuid primary key references public.vendor_integrations(id) on delete cascade,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  /* NULL = closed. Set = the moment it opened; the cooldown runs from here. */
  opened_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  updated_at timestamptz not null default now()
);

/* ------------------------------------------------------------ what the vendor told us */

create table if not exists public.vendor_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  integration_id uuid references public.vendor_integrations(id) on delete set null,
  vendor_slug text not null check (char_length(vendor_slug) between 1 and 48),
  /* the vendor's own id for the event. Reused across retries, which is what makes it a de-duplication key. */
  event_id text,
  /*
   * verified     signature, freshness and identity all checked
   * bad_signature / stale / no_signature / no_secret / malformed
   *              stored anyway. A rising count of `bad_signature` is somebody probing the endpoint; a rising
   *              count of `no_secret` is an integration nobody finished configuring. Both are invisible if
   *              unverifiable deliveries are discarded.
   */
  verdict text not null check (verdict in
    ('verified', 'bad_signature', 'stale', 'no_signature', 'no_secret', 'malformed')),
  reason text check (reason is null or char_length(reason) <= 300),
  signed_at timestamptz,
  /* the body exactly as received, for a dispute about what a vendor actually sent */
  raw_body jsonb not null default '{}'::jsonb,
  vendor_order_ref text,
  participant_ref text,
  /*
   * pending    verified and waiting to be applied
   * applied    turned into a recruitment_events row
   * duplicate  this event id has already been applied
   * quarantined  not actionable; a human decides
   */
  processing text not null default 'pending'
    check (processing in ('pending', 'applied', 'duplicate', 'quarantined')),
  processed_at timestamptz,
  received_at timestamptz not null default now()
);
/*
 * One receipt per vendor event. The partial index lets an unidentifiable delivery (no event id) still be
 * stored — exactly the case that most needs a record — without colliding with every other such delivery.
 */
create unique index if not exists vendor_webhook_receipts_event_uniq
  on public.vendor_webhook_receipts (vendor_slug, event_id) where event_id is not null;
create index if not exists vendor_webhook_receipts_triage_idx
  on public.vendor_webhook_receipts (verdict, received_at desc) where verdict <> 'verified';
create index if not exists vendor_webhook_receipts_order_idx
  on public.vendor_webhook_receipts (vendor_order_ref, received_at desc) where vendor_order_ref is not null;

/* ------------------------------------------------------------ settling up */

create table if not exists public.settlement_reconciliations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id uuid not null references public.recruitment_orders(id) on delete cascade,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  /* three accounts of the same work; collapsing them into one is what this table exists to prevent */
  claimed_count integer not null default 0 check (claimed_count >= 0),
  claimed_amount numeric(14,2) not null default 0 check (claimed_amount >= 0),
  agreed_count integer not null default 0 check (agreed_count >= 0),
  agreed_amount numeric(14,2) not null default 0 check (agreed_amount >= 0),
  payable_count integer not null default 0 check (payable_count >= 0),
  payable_amount numeric(14,2) not null default 0 check (payable_amount >= 0),
  /* accepted, but a fraud case is holding payment. Not refused — payable if the case is cleared. */
  held_count integer not null default 0 check (held_count >= 0),
  held_amount numeric(14,2) not null default 0 check (held_amount >= 0),
  clean boolean not null default false,
  statement text check (statement is null or char_length(statement) <= 500),
  computed_at timestamptz not null default now(),
  /*
   * Set only when a human has worked through the differences. A reconciliation is never self-resolving: §30's
   * money depends on somebody deciding, and a system that closed its own disputes would always close them in
   * whichever direction its own records happened to favour.
   */
  settled_at timestamptz,
  settled_by uuid references public.profiles(id) on delete set null,
  settlement_note text
);
create index if not exists settlement_reconciliations_order_idx
  on public.settlement_reconciliations (order_id, computed_at desc);
create index if not exists settlement_reconciliations_open_idx
  on public.settlement_reconciliations (customer_id, computed_at desc) where settled_at is null and not clean;

create table if not exists public.settlement_differences (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.settlement_reconciliations(id) on delete cascade,
  participant_ref text not null,
  cause text not null check (cause in
    ('not_seen', 'unclaimed', 'rejected_on_quality', 'held_for_review', 'amount_mismatch', 'outcome_mismatch')),
  vendor_amount numeric(12,2),
  platform_amount numeric(12,2),
  /* positive = the vendor claims more than the platform agrees */
  delta numeric(12,2) not null default 0,
  detail text check (detail is null or char_length(detail) <= 400),
  /* a per-line decision, because a reconciliation is rarely settled wholesale */
  resolution text check (resolution is null or resolution in ('pay', 'decline', 'credit', 'waived')),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists settlement_differences_recon_idx
  on public.settlement_differences (reconciliation_id, cause);
create index if not exists settlement_differences_open_idx
  on public.settlement_differences (reconciliation_id) where resolution is null;

/* ------------------------------------------------------------ row level security */

alter table public.vendor_api_calls            enable row level security;
alter table public.vendor_circuit_state        enable row level security;
alter table public.vendor_webhook_receipts     enable row level security;
alter table public.settlement_reconciliations  enable row level security;
alter table public.settlement_differences      enable row level security;

drop policy if exists vendor_api_calls_read on public.vendor_api_calls;
create policy vendor_api_calls_read on public.vendor_api_calls for select to authenticated
  using (
    (customer_id = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_circuit_state_read on public.vendor_circuit_state;
create policy vendor_circuit_state_read on public.vendor_circuit_state for select to authenticated
  using (
    (public.rescript_vendor_integration_customer(integration_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

/*
 * The RAW BODY of a webhook may carry a vendor's participant identifier, so the receipts table is read by the
 * roles that already see commercial detail and by nobody else — the same line 0081 drew around CPI.
 */
drop policy if exists vendor_webhook_receipts_read on public.vendor_webhook_receipts;
create policy vendor_webhook_receipts_read on public.vendor_webhook_receipts for select to authenticated
  using (
    (customer_id = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists settlement_reconciliations_read on public.settlement_reconciliations;
create policy settlement_reconciliations_read on public.settlement_reconciliations for select to authenticated
  using (
    (customer_id = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists settlement_differences_read on public.settlement_differences;
create policy settlement_differences_read on public.settlement_differences for select to authenticated
  using (
    exists (
      select 1 from public.settlement_reconciliations r
       where r.id = settlement_differences.reconciliation_id
         and r.customer_id = public.current_customer_id()
         and public."current_role"() in ('platform_admin', 'programmer', 'researcher')
    )
    or public.rescript_is_platform_admin(auth.uid())
  );

revoke all on public.vendor_api_calls, public.vendor_circuit_state, public.vendor_webhook_receipts,
  public.settlement_reconciliations, public.settlement_differences from anon;
grant select on public.vendor_api_calls, public.vendor_circuit_state, public.vendor_webhook_receipts,
  public.settlement_reconciliations, public.settlement_differences to authenticated;

/* ------------------------------------------------------------ atomic operations (service role only) */

/**
 * Record one webhook delivery and say whether it is new.
 *
 * The unique index on (vendor_slug, event_id) is what makes this safe under concurrency: two simultaneous
 * deliveries of the same retried event contend in the DATABASE, and exactly one is told it is new. An
 * application-level "select then insert" loses that race, and losing it means counting a complete twice.
 */
create or replace function public.rescript_webhook_receive(
  p_customer uuid, p_integration uuid, p_vendor text, p_event_id text, p_verdict text,
  p_reason text default null, p_body jsonb default '{}'::jsonb,
  p_order_ref text default null, p_participant text default null, p_signed_at timestamptz default null)
returns table (receipt_id uuid, is_new boolean, processing text)
language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid;
  v_new  boolean := true;
  v_proc text;
begin
  -- an unverifiable delivery is stored and quarantined; only a verified one is ever queued for application
  v_proc := case when p_verdict = 'verified' then 'pending' else 'quarantined' end;

  if p_event_id is null then
    -- nothing to de-duplicate on: store it, quarantine it, and do not pretend it is new work
    insert into public.vendor_webhook_receipts
      (customer_id, integration_id, vendor_slug, event_id, verdict, reason, raw_body,
       vendor_order_ref, participant_ref, signed_at, processing)
    values (p_customer, p_integration, p_vendor, null, p_verdict, p_reason, coalesce(p_body, '{}'::jsonb),
            p_order_ref, p_participant, p_signed_at, 'quarantined')
    returning id into v_id;
    return query select v_id, false, 'quarantined'::text;
    return;
  end if;

  insert into public.vendor_webhook_receipts
    (customer_id, integration_id, vendor_slug, event_id, verdict, reason, raw_body,
     vendor_order_ref, participant_ref, signed_at, processing)
  values (p_customer, p_integration, p_vendor, p_event_id, p_verdict, p_reason, coalesce(p_body, '{}'::jsonb),
          p_order_ref, p_participant, p_signed_at, v_proc)
  on conflict (vendor_slug, event_id) where event_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    -- already received. Return the ORIGINAL receipt, so the caller acts on the first verdict, not this one.
    select r.id, r.processing into v_id, v_proc
      from public.vendor_webhook_receipts r
     where r.vendor_slug = p_vendor and r.event_id = p_event_id;
    v_new := false;
  end if;

  return query select v_id, v_new, v_proc;
end;
$$;

/**
 * Health from observed behaviour over a window, not from an operator's opinion.
 *
 * Returns NULL rates when there were no calls at all. A vendor nobody has called is `unknown`, which is not the
 * same as healthy and not the same as failing — the same refusal 0085 makes about vendor quality.
 */
create or replace function public.rescript_vendor_health_recompute(
  p_customer uuid, p_window_minutes integer default 60)
returns integer language plpgsql security definer set search_path = public as $$
declare v_rows integer := 0; r record; v_health text;
begin
  for r in
    select c.integration_id,
           count(*)                              as calls,
           count(*) filter (where c.ok)          as ok_calls,
           percentile_disc(0.95) within group (order by c.elapsed_ms) as p95
      from public.vendor_api_calls c
     where c.customer_id = p_customer
       and c.called_at > now() - make_interval(mins => greatest(coalesce(p_window_minutes, 60), 1))
     group by c.integration_id
  loop
    v_health := case
      when r.calls = 0 then 'unknown'
      when r.ok_calls::numeric / r.calls >= 0.95 then 'ok'
      when r.ok_calls::numeric / r.calls >= 0.5  then 'degraded'
      else 'failing'
    end;
    update public.vendor_integrations
       set health = v_health,
           last_contact_at = greatest(coalesce(last_contact_at, 'epoch'::timestamptz),
                                      (select max(called_at) from public.vendor_api_calls
                                        where integration_id = r.integration_id)),
           updated_at = now()
     where id = r.integration_id;
    v_rows := v_rows + 1;
  end loop;
  return v_rows;
end;
$$;

revoke all on function public.rescript_webhook_receive(uuid, uuid, text, text, text, text, jsonb, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.rescript_vendor_health_recompute(uuid, integer) from public, anon, authenticated;

comment on table public.vendor_api_calls is 'One row per outbound vendor call (0086). Health is computed from this. The path only — a query string can carry a participant id.';
comment on table public.vendor_webhook_receipts is 'Every webhook delivery, verified or not (0086). An endpoint that discards what it cannot verify looks exactly like a broken one.';
comment on table public.settlement_reconciliations is 'Three accounts of one order — claimed, agreed, payable (0086). It states a dispute; it never resolves one.';
