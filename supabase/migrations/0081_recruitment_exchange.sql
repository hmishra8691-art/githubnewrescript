-- 0081 — The respondent recruitment exchange, Phase 1: foundation (2026-11-03).
--
-- 0072 gave a STUDY its panels: how participants arrive from one sample provider and where they are sent back.
-- That configuration lives on the definition and is versioned with it, and nothing here disturbs it. What 0072
-- deliberately did not do was call a vendor ("No panel API is called — feasibility, quota sync and payments stay
-- in the panel's dashboard"), and it had no notion of a vendor as something an ORGANISATION has a relationship
-- with, independent of any one study.
--
-- This migration adds that: a vendor directory, an organisation's integration with a vendor and what that
-- integration can actually DO, the prices and feasibility figures behind a quotation, and the recruitment project
-- those become — an audience, a budget, an allocation across vendors and the orders placed against it.
--
--   panel_vendors          the directory. A row with customer_id NULL is the platform catalogue (Dynata, Cint,
--                          Toluna …), visible to every organisation; a row with a customer_id is that
--                          organisation's own addition (a regional provider, a client's own panel)
--   vendor_integrations    one organisation's relationship with one vendor: the MODE it is in (api / manual /
--                          redirect_only / awaiting / inactive) and, when an API is involved, the credentials
--                          SEALED with envelope encryption (the BYOK vault's scheme, key INTEGRATIONS_SECRET_KEY,
--                          AAD = the integration row). `credentials_sealed` is never readable through the API;
--                          members see the masked `hint` only, exactly as notify_channels does
--   vendor_capabilities    what this integration can do, capability by capability, and whether that was VERIFIED
--                          against the vendor or merely declared. The marketplace renders from this table, so a
--                          vendor cannot display a capability it has not got — the brief's §5 requirement that a
--                          vendor never be shown as integrated when it is not
--   vendor_pricing         CPI by market × incidence band × length band, with the SOURCE of the figure
--                          (live / vendor_reported / historical / administrator). The source travels with the
--                          number everywhere it is shown: a quotation and an administrator's guess must never
--                          look alike on a screen somebody authorises spend from
--   vendor_quotations      a quotation obtained for one recruitment project from one integration, with its own
--                          source and validity window
--   audience_specifications  the structured audience, versioned, with the natural language it came from
--   recruitment_projects   → surveys: required completes, budget, deadline, strategy, state
--   sample_allocations     the optimiser's output, by revision. Revision 0 is the first proposal; every
--                          reallocation writes a new revision rather than mutating one, so what a researcher
--                          authorised is still readable afterwards
--   recruitment_orders     what was actually ordered from a vendor, and what came back
--   recruitment_events     the append-only log of the orchestrator's state transitions, idempotent by key
--
-- NO SECRET IS ON A DEFINITION and no money moves here: Phase 1 records what an operator configures and what an
-- operator orders. Live vendor APIs are Phase 6 and are blocked on contracts; until then every integration is
-- `manual`, `redirect_only` or `awaiting`, and `vendor_capabilities.verified_at` is null.
--
-- RLS: an organisation's members (platform_admin / programmer / researcher) read their own integrations, pricing,
-- projects, allocations and orders; the platform catalogue is readable by everyone signed in; credentials are
-- readable by nobody. Only the service role writes, behind routes that check access first.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.recruitment_events, public.recruitment_orders, public.sample_allocations,
--     public.recruitment_projects, public.audience_specifications, public.vendor_quotations,
--     public.vendor_pricing, public.vendor_capabilities, public.vendor_integrations, public.panel_vendors cascade;

/* ------------------------------------------------------------ the vendor directory */

create table if not exists public.panel_vendors (
  id uuid primary key default gen_random_uuid(),
  -- NULL = the platform catalogue, readable by every organisation; set = this organisation's own vendor
  customer_id uuid references public.customers(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  name text not null check (char_length(name) between 1 and 120),
  legal_name text,
  website text,
  logo_url text,
  -- ISO-3166 alpha-2 markets the vendor says it covers; empty means "not stated", never "everywhere"
  regions text[] not null default '{}',
  description text,
  -- the 0072 panel preset this vendor's redirect integration corresponds to, when one exists
  panel_preset text check (panel_preset is null or panel_preset ~ '^[a-z][a-z0-9_]{0,31}$'),
  status text not null default 'catalogue' check (status in ('catalogue', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists panel_vendors_global_slug_uniq on public.panel_vendors (slug) where customer_id is null;
create unique index if not exists panel_vendors_org_slug_uniq on public.panel_vendors (customer_id, slug) where customer_id is not null;

/* ------------------------------------------------------------ an organisation's integration with a vendor */

create table if not exists public.vendor_integrations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  vendor_id uuid not null references public.panel_vendors(id) on delete cascade,
  -- api            the adapter talks to the vendor (Phase 6; requires credentials)
  -- manual         an operator enters feasibility, prices and orders by hand, and reconciles by hand
  -- redirect_only  0072's recruitment redirect works, but nothing is ordered through the platform
  -- awaiting       intended, not configured — the marketplace says exactly this
  -- inactive       switched off; kept for its history
  mode text not null default 'awaiting' check (mode in ('api', 'manual', 'redirect_only', 'awaiting', 'inactive')),
  credentials_sealed text,
  credentials_key_id text,
  -- what a screen may show: "api.cint.com / key ••••7f2c"
  hint text,
  health text not null default 'unknown' check (health in ('unknown', 'ok', 'degraded', 'failing')),
  last_contact_at timestamptz,
  last_error text,
  -- commercial terms an administrator agreed: markup applied to vendor CPI, in basis points
  markup_bps integer not null default 0 check (markup_bps between 0 and 10000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  notes text,
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- an api integration without credentials is a lie the marketplace would tell; refuse it in the database
  constraint vendor_integrations_api_needs_credentials check (mode <> 'api' or credentials_sealed is not null)
);
create unique index if not exists vendor_integrations_uniq on public.vendor_integrations (customer_id, vendor_id);
create index if not exists vendor_integrations_customer_idx on public.vendor_integrations (customer_id, mode) where enabled;

/* ------------------------------------------------------------ what it can actually do */

create table if not exists public.vendor_capabilities (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  capability text not null check (capability in
    ('feasibility', 'quote', 'order', 'status', 'reconcile', 'cancel', 'refund', 'identity_token', 'webhook')),
  supported boolean not null default false,
  -- when the capability was last exercised against the vendor successfully. NULL means DECLARED, NOT VERIFIED,
  -- and every surface that shows a capability must show that difference.
  verified_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);
create unique index if not exists vendor_capabilities_uniq on public.vendor_capabilities (integration_id, capability);

/* ------------------------------------------------------------ pricing and feasibility */

create table if not exists public.vendor_pricing (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  market text not null check (market ~ '^[A-Z]{2}$'),
  -- the incidence and length bands this price applies to; half-open [min, max)
  ir_min numeric(5,2) not null default 0 check (ir_min >= 0 and ir_min <= 100),
  ir_max numeric(5,2) not null default 100 check (ir_max > 0 and ir_max <= 100),
  loi_min integer not null default 0 check (loi_min >= 0),
  loi_max integer not null default 120 check (loi_max > 0),
  cpi numeric(10,4) not null check (cpi >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- live             returned by the vendor's API for this request (Phase 6)
  -- vendor_reported  the vendor stated it (rate card, e-mail, portal) and an operator entered it
  -- historical       derived from this platform's own completed projects
  -- administrator    an administrator's figure, with no vendor behind it
  source text not null check (source in ('live', 'vendor_reported', 'historical', 'administrator')),
  source_note text,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint vendor_pricing_bands check (ir_max > ir_min and loi_max > loi_min),
  constraint vendor_pricing_window check (valid_to is null or valid_to > valid_from)
);
create index if not exists vendor_pricing_lookup_idx on public.vendor_pricing (integration_id, market, valid_from desc);

/* ------------------------------------------------------------ the audience and the project */

create table if not exists public.audience_specifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  version integer not null default 1 check (version >= 1),
  -- the structured specification (demographics, advanced targeting, nested AND/OR, quotas)
  spec jsonb not null default '{}'::jsonb,
  -- what the researcher typed, when it came from natural language. Kept so the structured form stays reviewable
  -- against its source — the brief's §7 "reviewable audience specification"
  natural_language text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists audience_specifications_survey_idx on public.audience_specifications (survey_id, version desc);

create table if not exists public.recruitment_projects (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  audience_spec_id uuid references public.audience_specifications(id) on delete set null,
  required_completes integer not null check (required_completes > 0 and required_completes <= 10000000),
  -- the APPROVED ceiling. §30: never exceeded without authorisation, and the allocation function enforces it
  budget_amount numeric(14,2) not null check (budget_amount >= 0),
  budget_currency text not null default 'USD' check (budget_currency ~ '^[A-Z]{3}$'),
  deadline timestamptz,
  loi_minutes integer check (loi_minutes is null or (loi_minutes > 0 and loi_minutes <= 240)),
  expected_ir numeric(5,2) check (expected_ir is null or (expected_ir > 0 and expected_ir <= 100)),
  strategy text not null default 'balanced'
    check (strategy in ('lowest_cost', 'highest_quality', 'fastest_delivery', 'balanced', 'custom')),
  -- for strategy = custom: {"cost": 0.5, "quality": 0.3, "speed": 0.2}
  weights jsonb not null default '{}'::jsonb,
  quality_floor numeric(5,2) check (quality_floor is null or (quality_floor >= 0 and quality_floor <= 100)),
  status text not null default 'draft' check (status in
    ('draft', 'feasibility', 'quoted', 'allocated', 'authorized', 'fielding', 'paused', 'complete', 'cancelled')),
  authorized_by uuid references public.profiles(id) on delete set null,
  authorized_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_projects_survey_idx on public.recruitment_projects (survey_id, created_at desc);
create index if not exists recruitment_projects_customer_idx on public.recruitment_projects (customer_id, status);

/* ------------------------------------------------------------ allocation and orders */

create table if not exists public.sample_allocations (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  -- every reallocation writes a NEW revision; revision 0 is the first proposal. What was authorised stays readable.
  revision integer not null default 0 check (revision >= 0),
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  allocated_completes integer not null check (allocated_completes >= 0),
  cpi numeric(10,4) not null check (cpi >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- what the optimiser expected, kept so the actual can be compared with it afterwards (§24, §26)
  expected_valid_completes integer check (expected_valid_completes >= 0),
  cost_per_valid_complete numeric(10,4) check (cost_per_valid_complete >= 0),
  expected_delivery_days numeric(6,2) check (expected_delivery_days >= 0),
  -- why this vendor got this many: the inputs and the arithmetic, for the researcher who authorises it
  rationale jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists sample_allocations_uniq on public.sample_allocations (recruitment_project_id, revision, integration_id);
create index if not exists sample_allocations_project_idx on public.sample_allocations (recruitment_project_id, revision desc);

create table if not exists public.vendor_quotations (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  available_sample integer check (available_sample >= 0),
  expected_ir numeric(5,2) check (expected_ir is null or (expected_ir > 0 and expected_ir <= 100)),
  cpi numeric(10,4) not null check (cpi >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  loi_minutes integer check (loi_minutes is null or loi_minutes > 0),
  expected_completes integer check (expected_completes >= 0),
  expected_rejection_rate numeric(5,2) check (expected_rejection_rate is null or (expected_rejection_rate >= 0 and expected_rejection_rate <= 100)),
  delivery_days numeric(6,2) check (delivery_days is null or delivery_days >= 0),
  source text not null check (source in ('live', 'vendor_reported', 'historical', 'administrator')),
  valid_until timestamptz,
  -- the vendor's own response, kept verbatim when there was one
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists vendor_quotations_project_idx on public.vendor_quotations (recruitment_project_id, created_at desc);

create table if not exists public.recruitment_orders (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  allocation_id uuid references public.sample_allocations(id) on delete set null,
  ordered_completes integer not null check (ordered_completes > 0),
  agreed_cpi numeric(10,4) not null check (agreed_cpi >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- the vendor's own identifier for this order, when it has one
  vendor_order_ref text,
  status text not null default 'draft' check (status in
    ('draft', 'placed', 'live', 'paused', 'cancelled', 'complete', 'failed')),
  -- what actually came back. `accepted` is the one the money is owed on: delivered minus rejected and duplicates
  delivered_completes integer not null default 0 check (delivered_completes >= 0),
  accepted_completes integer not null default 0 check (accepted_completes >= 0),
  rejected_completes integer not null default 0 check (rejected_completes >= 0),
  duplicate_attempts integer not null default 0 check (duplicate_attempts >= 0),
  spend_amount numeric(14,2) not null default 0 check (spend_amount >= 0),
  placed_at timestamptz,
  placed_by uuid references public.profiles(id) on delete set null,
  last_sync_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_orders_accepted_le_delivered check (accepted_completes <= delivered_completes)
);
create index if not exists recruitment_orders_project_idx on public.recruitment_orders (recruitment_project_id, status);
create unique index if not exists recruitment_orders_vendor_ref_uniq on public.recruitment_orders (integration_id, vendor_order_ref) where vendor_order_ref is not null;

/* ------------------------------------------------------------ the orchestrator's log */

create table if not exists public.recruitment_events (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  type text not null check (char_length(type) between 1 and 60),
  -- one event, however many times it is delivered: §32's "financial and participation records cannot be
  -- duplicated through repeated event delivery"
  idempotency_key text not null,
  integration_id uuid references public.vendor_integrations(id) on delete set null,
  order_id uuid references public.recruitment_orders(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  actor uuid references public.profiles(id) on delete set null,
  occurred_at timestamptz not null default now()
);
create unique index if not exists recruitment_events_idem_uniq on public.recruitment_events (idempotency_key);
create index if not exists recruitment_events_project_idx on public.recruitment_events (recruitment_project_id, occurred_at desc);

/* ------------------------------------------------------------ ownership helpers

   A policy on a table reached THROUGH another one must not select from that other table directly: its own policy
   would be evaluated inside this one, and on a chain like orders → projects → customers that recurses. 0072 hit
   the same thing on `profiles` and solved it with security-definer helpers; these are the two this migration needs.
   Both are read-only, both are stable, and both are callable by signed-in users because they return nothing but an
   organisation id the caller is about to be checked against anyway.                                             */

create or replace function public.rescript_vendor_integration_customer(p_integration uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select customer_id from public.vendor_integrations where id = p_integration;
$$;

create or replace function public.rescript_recruitment_project_customer(p_project uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select customer_id from public.recruitment_projects where id = p_project;
$$;

grant execute on function public.rescript_vendor_integration_customer(uuid) to authenticated;
grant execute on function public.rescript_recruitment_project_customer(uuid) to authenticated;

/* ------------------------------------------------------------ row level security */

alter table public.panel_vendors            enable row level security;
alter table public.vendor_integrations      enable row level security;
alter table public.vendor_capabilities      enable row level security;
alter table public.vendor_pricing           enable row level security;
alter table public.vendor_quotations        enable row level security;
alter table public.audience_specifications  enable row level security;
alter table public.recruitment_projects     enable row level security;
alter table public.sample_allocations       enable row level security;
alter table public.recruitment_orders       enable row level security;
alter table public.recruitment_events       enable row level security;

-- the directory: the platform catalogue is readable by anyone signed in; an organisation's own vendors by it
drop policy if exists panel_vendors_read on public.panel_vendors;
create policy panel_vendors_read on public.panel_vendors for select to authenticated
  using (
    customer_id is null
    or customer_id = public.current_customer_id()
    or public.rescript_is_platform_admin(auth.uid())
  );

-- everything else: the organisation's own members, in the roles that may see commercial terms. `client` and
-- `viewer` are deliberately absent — a CPI and a margin are not a respondent-facing or a read-only-guest concern.
drop policy if exists vendor_integrations_read on public.vendor_integrations;
create policy vendor_integrations_read on public.vendor_integrations for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_capabilities_read on public.vendor_capabilities;
create policy vendor_capabilities_read on public.vendor_capabilities for select to authenticated
  using (
    (public.rescript_vendor_integration_customer(integration_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_pricing_read on public.vendor_pricing;
create policy vendor_pricing_read on public.vendor_pricing for select to authenticated
  using (
    (public.rescript_vendor_integration_customer(integration_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists audience_specifications_read on public.audience_specifications;
create policy audience_specifications_read on public.audience_specifications for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists recruitment_projects_read on public.recruitment_projects;
create policy recruitment_projects_read on public.recruitment_projects for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_quotations_read on public.vendor_quotations;
create policy vendor_quotations_read on public.vendor_quotations for select to authenticated
  using (
    (public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists sample_allocations_read on public.sample_allocations;
create policy sample_allocations_read on public.sample_allocations for select to authenticated
  using (
    (public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists recruitment_orders_read on public.recruitment_orders;
create policy recruitment_orders_read on public.recruitment_orders for select to authenticated
  using (
    (public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists recruitment_events_read on public.recruitment_events;
create policy recruitment_events_read on public.recruitment_events for select to authenticated
  using (
    (public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

/* ------------------------------------------------------------ grants

   Nobody but the service role writes: the Studio's routes check access and then write as the service, exactly as
   0072 does. Credentials are removed from the readable column list rather than from the table, so a member reading
   an integration gets its mode, health and masked hint and never the sealed blob.                               */

revoke all on public.panel_vendors, public.vendor_integrations, public.vendor_capabilities, public.vendor_pricing,
  public.vendor_quotations, public.audience_specifications, public.recruitment_projects, public.sample_allocations,
  public.recruitment_orders, public.recruitment_events from anon;

revoke all on public.vendor_integrations from authenticated;
grant select (id, customer_id, vendor_id, mode, hint, health, last_contact_at, last_error, markup_bps, currency,
  notes, enabled, created_by, created_at, updated_at) on public.vendor_integrations to authenticated;

grant select on public.panel_vendors, public.vendor_capabilities, public.vendor_pricing, public.vendor_quotations,
  public.audience_specifications, public.recruitment_projects, public.sample_allocations,
  public.recruitment_orders, public.recruitment_events to authenticated;

/* ------------------------------------------------------------ atomic operations (service role only) */

/**
 * Write one revision of an allocation, or refuse the lot.
 *
 * `p_rows` is [{integration_id, allocated_completes, cpi, currency, expected_valid_completes,
 * cost_per_valid_complete, expected_delivery_days, rationale}]. The whole revision is one statement: a partially
 * written allocation is not a thing a researcher can be shown and asked to authorise.
 *
 * It enforces the two invariants that must not live in application code, because §30 says an approved budget is
 * never exceeded without authorisation and §9 says the allocation must meet the required completes:
 *   - the revision's total cost may not exceed the project's approved budget;
 *   - the revision may not allocate more completes than the project requires.
 * Both refuse with a named exception rather than clamping, so the caller reports the real reason.
 */
create or replace function public.rescript_recruitment_allocate(
  p_project uuid, p_revision integer, p_rows jsonb, p_actor uuid default null)
returns table (revision integer, vendors integer, total_completes integer, total_cost numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_budget   numeric;
  v_required integer;
  v_currency text;
  v_cost     numeric := 0;
  v_completes integer := 0;
  v_rows     integer := 0;
begin
  select budget_amount, required_completes, budget_currency
    into v_budget, v_required, v_currency
    from public.recruitment_projects where id = p_project for update;
  if not found then
    raise exception 'recruitment project % does not exist', p_project using errcode = 'no_data_found';
  end if;

  select coalesce(sum((r->>'allocated_completes')::integer), 0),
         coalesce(sum((r->>'allocated_completes')::integer * (r->>'cpi')::numeric), 0),
         count(*)
    into v_completes, v_cost, v_rows
    from jsonb_array_elements(p_rows) r;

  if v_cost > v_budget then
    -- RAISE's % is a substitution placeholder, not a printf spec: round for display, and %% for a literal percent
    raise exception 'allocation costs % %, over the approved budget of % %',
      round(v_cost, 2), v_currency, round(v_budget, 2), v_currency using errcode = 'check_violation';
  end if;
  if v_completes > v_required then
    raise exception 'allocation of % completes exceeds the % required', v_completes, v_required
      using errcode = 'check_violation';
  end if;

  delete from public.sample_allocations where recruitment_project_id = p_project and sample_allocations.revision = p_revision;

  insert into public.sample_allocations (recruitment_project_id, revision, integration_id, allocated_completes,
    cpi, currency, expected_valid_completes, cost_per_valid_complete, expected_delivery_days, rationale, created_by)
  select p_project, p_revision, (r->>'integration_id')::uuid, (r->>'allocated_completes')::integer,
    (r->>'cpi')::numeric, coalesce(r->>'currency', v_currency),
    nullif(r->>'expected_valid_completes', '')::integer, nullif(r->>'cost_per_valid_complete', '')::numeric,
    nullif(r->>'expected_delivery_days', '')::numeric, coalesce(r->'rationale', '{}'::jsonb), p_actor
  from jsonb_array_elements(p_rows) r;

  return query select p_revision, v_rows, v_completes, v_cost;
end;
$$;

/**
 * Apply a vendor's progress to an order, exactly once.
 *
 * A vendor callback, a webhook retry and an operator's manual sync all arrive here, and §32 requires that
 * repeated delivery cannot duplicate a financial record. The idempotency key is the gate: it is inserted into
 * `recruitment_events` first, and a key already present means this progress has been applied and the function
 * returns `applied = false` without touching the order.
 *
 * Counts are ABSOLUTE, not deltas — a vendor reporting "412 delivered so far" is the truth about the order, and
 * absolute counts are the only shape that survives an out-of-order callback.
 */
create or replace function public.rescript_recruitment_order_apply(
  p_order uuid, p_idempotency_key text, p_delivered integer, p_accepted integer,
  p_rejected integer default 0, p_duplicates integer default 0, p_spend numeric default null,
  p_status text default null, p_vendor_ref text default null)
returns table (applied boolean, order_status text, accepted integer, spend numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_integration uuid;
  v_cpi numeric;
  v_spend numeric;
  v_status text;
  v_accepted integer;
begin
  select recruitment_project_id, integration_id, agreed_cpi
    into v_project, v_integration, v_cpi
    from public.recruitment_orders where id = p_order for update;
  if not found then
    raise exception 'recruitment order % does not exist', p_order using errcode = 'no_data_found';
  end if;

  begin
    insert into public.recruitment_events (recruitment_project_id, type, idempotency_key, integration_id, order_id, payload)
    values (v_project, 'RecruitmentProgressApplied', p_idempotency_key, v_integration, p_order,
      jsonb_build_object('delivered', p_delivered, 'accepted', p_accepted, 'rejected', p_rejected,
        'duplicates', p_duplicates, 'spend', p_spend, 'status', p_status));
  exception when unique_violation then
    select o.status, o.accepted_completes, o.spend_amount into v_status, v_accepted, v_spend
      from public.recruitment_orders o where o.id = p_order;
    return query select false, v_status, v_accepted, v_spend;
    return;
  end;

  -- spend follows the accepted completes at the agreed CPI unless the vendor stated an amount
  v_spend := coalesce(p_spend, round(p_accepted * v_cpi, 2));
  v_status := coalesce(p_status, (select status from public.recruitment_orders where id = p_order));

  update public.recruitment_orders set
    delivered_completes = greatest(p_delivered, 0),
    accepted_completes  = greatest(p_accepted, 0),
    rejected_completes  = greatest(p_rejected, 0),
    duplicate_attempts  = greatest(p_duplicates, 0),
    spend_amount        = v_spend,
    status              = v_status,
    vendor_order_ref    = coalesce(p_vendor_ref, vendor_order_ref),
    last_sync_at        = now(),
    updated_at          = now()
  where id = p_order;

  return query select true, v_status, greatest(p_accepted, 0), v_spend;
end;
$$;

revoke all on function public.rescript_recruitment_allocate(uuid, integer, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.rescript_recruitment_order_apply(uuid, text, integer, integer, integer, integer, numeric, text, text) from public, anon, authenticated;

/* ------------------------------------------------------------ the platform catalogue

   The vendors the brief names, as DIRECTORY entries only. A row here is not an integration and grants no
   capability: an organisation that wants to use one creates a `vendor_integrations` row and chooses its mode, and
   until it does the marketplace shows the vendor as "Awaiting integration". `panel_preset` points at the 0072
   preset that already knows that vendor's redirect contract, so redirect-only recruitment works the moment the
   integration is created, without a line of adapter code.                                                       */

insert into public.panel_vendors (customer_id, slug, name, legal_name, website, regions, panel_preset, description)
values
  (null, 'dynata',       'Dynata',            'Dynata, LLC',                      'https://www.dynata.com',        '{}', 'dynata',        'Global first-party panel and exchange.'),
  (null, 'cint',         'Cint (Lucid)',      'Cint AB',                          'https://www.cint.com',          '{}', 'cint',          'Programmatic sample exchange; Lucid Marketplace is the same company.'),
  (null, 'toluna',       'Toluna',            'Toluna Holdings Limited',          'https://tolunacorporate.com',   '{}', 'toluna',        'Owned panel and automated insights platform.'),
  (null, 'purespectrum', 'PureSpectrum',      'PureSpectrum, Inc.',               'https://www.purespectrum.com',  '{}', 'purespectrum',  'Sample marketplace with its own quality scoring.'),
  (null, 'prodege',      'Prodege',           'Prodege, LLC',                     'https://www.prodege.com',       '{}', null,            'Consumer rewards panels (Swagbucks, InboxDollars).'),
  (null, 'prolific',     'Prolific',          'Prolific Academic Ltd',            'https://www.prolific.com',      '{}', 'prolific',      'Vetted participants, academic and applied research.'),
  (null, 'yougov',       'YouGov',            'YouGov plc',                       'https://business.yougov.com',   '{}', null,            'Proprietary panel with profiled longitudinal data.'),
  (null, 'bilendi',      'Bilendi',           'Bilendi SA',                       'https://www.bilendi.com',       '{}', null,            'European owned panels.'),
  (null, 'cloudresearch','CloudResearch Connect','CloudResearch, Inc.',           'https://www.cloudresearch.com', '{}', 'cloudresearch', 'Vetted participant pool.'),
  (null, 'qualtrics',    'Qualtrics Panels',  'Qualtrics, LLC',                   'https://www.qualtrics.com',     '{}', null,            'Sample brokered through Qualtrics contracts; configure manually.')
on conflict do nothing;

comment on table public.panel_vendors is 'The sample-provider directory (0081). customer_id NULL = the platform catalogue; a row is a directory entry, never an integration.';
comment on table public.vendor_integrations is 'One organisation''s relationship with one vendor (0081). Credentials are sealed (INTEGRATIONS_SECRET_KEY); members read the masked hint only.';
comment on table public.vendor_capabilities is 'What an integration can actually do (0081). verified_at NULL means DECLARED, not verified — every surface must show the difference.';
comment on table public.vendor_pricing is 'CPI by market, incidence and length (0081), with the provenance of the figure in `source`.';
comment on table public.sample_allocations is 'The optimiser''s output by revision (0081). A reallocation writes a new revision; what was authorised stays readable.';
comment on table public.recruitment_orders is 'What was ordered from a vendor and what came back (0081). Progress is applied through rescript_recruitment_order_apply, exactly once per idempotency key.';
