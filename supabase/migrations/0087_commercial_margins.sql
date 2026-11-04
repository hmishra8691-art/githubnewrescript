-- 0087 — The commercial margin engine (2026-11-04).
--
-- `vendor_integrations.markup_bps` computes a MARKUP ON COST: cost × (1 + bps/10000). The commercial
-- requirement is a MARGIN ON THE SELLING PRICE: cost ÷ (1 − bps/10000). They are different arithmetic and
-- they give different answers — on a £7,000 cost at "30%", £9,100 against £10,000. Nine hundred pounds a
-- project, in the direction that loses money, and silently, because both are plausible numbers.
--
--   commercial_margins     the rates, by scope, with validity windows. An override is a scope of its own and
--                          REQUIRES a note: an exception nobody can explain later is not an exception, it is
--                          a mistake that has been made permanent.
--   margin_applications    every price actually computed — the cost, the rate, the rule, the result. §12 asks
--                          for audit logs of commercial calculations, and a margin that cannot be traced back
--                          to the rule that produced it cannot be defended to a client or to a finance team.
--
-- ## markup_bps is RETIRED, not reinterpreted
--
-- Reading the existing values as margins would silently reprice every configured vendor. Production holds one
-- integration at 3 bps — a test value — so the column is left in place, defaulted to 0, and marked deprecated
-- in its comment rather than migrated. Nothing reads it for researcher pricing after this migration.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.margin_applications, public.commercial_margins cascade;

/* ------------------------------------------------------------ the rates */

create table if not exists public.commercial_margins (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  /*
   * Most specific wins: override → project → recruitment_type → market → default. An override sits ABOVE a
   * project rate deliberately — it is the escape hatch for a deal that does not fit the policy, and an escape
   * hatch below the thing it must escape is no use.
   */
  scope text not null check (scope in ('default', 'market', 'recruitment_type', 'project', 'override')),
  market text check (market is null or market ~ '^[A-Z]{2}$'),
  recruitment_type text check (recruitment_type is null or char_length(recruitment_type) between 1 and 40),
  recruitment_project_id uuid references public.recruitment_projects(id) on delete cascade,
  /*
   * Basis points OF THE SELLING PRICE. Capped below 10000 in the database as well as in the engine: at 100%
   * there is no finite price, and a column that accepts it is a column that will eventually hold it.
   */
  margin_bps integer not null check (margin_bps >= 0 and margin_bps <= 9500),
  note text check (note is null or char_length(note) <= 300),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint commercial_margins_window check (effective_to is null or effective_to > effective_from),
  -- each scope must carry the thing it is scoped BY, and nothing it is not
  constraint commercial_margins_scope_fields check (
    (scope = 'default'          and market is null and recruitment_type is null and recruitment_project_id is null)
    or (scope = 'market'            and market is not null and recruitment_project_id is null)
    or (scope = 'recruitment_type'  and recruitment_type is not null and recruitment_project_id is null)
    or (scope in ('project', 'override') and recruitment_project_id is not null)
  ),
  -- an override with no stated reason cannot be audited, so the database refuses one
  constraint commercial_margins_override_needs_note check (scope <> 'override' or (note is not null and char_length(note) >= 3))
);

/* One live rule per scope target. A second would make the applicable rate a matter of sort order. */
create unique index if not exists commercial_margins_default_uniq
  on public.commercial_margins (customer_id) where scope = 'default' and effective_to is null;
create unique index if not exists commercial_margins_market_uniq
  on public.commercial_margins (customer_id, market) where scope = 'market' and effective_to is null;
create unique index if not exists commercial_margins_type_uniq
  on public.commercial_margins (customer_id, recruitment_type) where scope = 'recruitment_type' and effective_to is null;
create unique index if not exists commercial_margins_project_uniq
  on public.commercial_margins (customer_id, recruitment_project_id, scope)
  where scope in ('project', 'override') and effective_to is null;
create index if not exists commercial_margins_lookup_idx
  on public.commercial_margins (customer_id, scope, effective_from desc);

/* ------------------------------------------------------------ what was actually charged */

create table if not exists public.margin_applications (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  recruitment_project_id uuid references public.recruitment_projects(id) on delete set null,
  market text check (market is null or market ~ '^[A-Z]{2}$'),
  /* what it was computed for: a quotation, an allocation the researcher authorised, a settlement */
  purpose text not null default 'quote' check (purpose in ('quote', 'allocation', 'order', 'settlement')),

  completes integer not null default 0 check (completes >= 0),
  /* the vendor acquisition cost. ADMINISTRATORS ONLY — RLS below, and never in a researcher payload. */
  cost_amount numeric(14,2) not null check (cost_amount >= 0),
  margin_bps integer not null check (margin_bps >= 0 and margin_bps <= 9500),
  margin_scope text not null,
  margin_rule_id uuid references public.commercial_margins(id) on delete set null,
  price_amount numeric(14,2) not null check (price_amount >= 0),
  profit_amount numeric(14,2) not null,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  /* the sentence the engine produced, so the reasoning survives the rule being edited later */
  because text check (because is null or char_length(because) <= 300),
  within_target_band boolean not null default true,
  computed_by uuid references public.profiles(id) on delete set null,
  computed_at timestamptz not null default now(),

  -- the arithmetic must hold in the row itself, so a bad write cannot be explained away later
  constraint margin_applications_profit check (profit_amount = price_amount - cost_amount),
  constraint margin_applications_price_ge_cost check (price_amount >= cost_amount)
);
create index if not exists margin_applications_project_idx
  on public.margin_applications (recruitment_project_id, computed_at desc);
create index if not exists margin_applications_customer_idx
  on public.margin_applications (customer_id, computed_at desc);

/* ------------------------------------------------------------ row level security

   Both tables are COMMERCIAL: they hold the acquisition cost and the margin taken on it. A researcher plans
   and authorises recruitment without either, so these are platform-administrator reads only — narrower than
   0081's "programmer, researcher and administrator", which was the line before researchers were separated
   from the supply chain.                                                                                   */

alter table public.commercial_margins   enable row level security;
alter table public.margin_applications  enable row level security;

drop policy if exists commercial_margins_read on public.commercial_margins;
create policy commercial_margins_read on public.commercial_margins for select to authenticated
  using (public.rescript_is_platform_admin(auth.uid()));

drop policy if exists margin_applications_read on public.margin_applications;
create policy margin_applications_read on public.margin_applications for select to authenticated
  using (public.rescript_is_platform_admin(auth.uid()));

revoke all on public.commercial_margins, public.margin_applications from anon, authenticated;
grant select on public.commercial_margins, public.margin_applications to authenticated;

/* ------------------------------------------------------------ resolution, in the database too

   The engine in packages/recruitment/src/margin.ts resolves the rate for a quote. This function exists so a
   report, a reconciliation or a finance query can ask the same question and get the same answer, rather than
   a second implementation drifting from the first.                                                         */

create or replace function public.rescript_margin_resolve(
  p_customer uuid, p_market text default null, p_project uuid default null,
  p_type text default null, p_at timestamptz default now(), p_fallback integer default 3000)
returns table (margin_bps integer, scope text, rule_id uuid, is_default boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(r.margin_bps, p_fallback),
         coalesce(r.scope, 'default'),
         r.id,
         r.id is null
    from (
      select m.id, m.margin_bps, m.scope
        from public.commercial_margins m
       where m.customer_id = p_customer
         and m.effective_from <= p_at
         and (m.effective_to is null or m.effective_to > p_at)
         and (
              m.scope = 'default'
           or (m.scope = 'market' and p_market is not null and m.market = p_market)
           or (m.scope = 'recruitment_type' and p_type is not null and m.recruitment_type = p_type)
           or (m.scope in ('project', 'override') and p_project is not null and m.recruitment_project_id = p_project)
         )
       order by case m.scope
                  when 'override' then 0 when 'project' then 1
                  when 'recruitment_type' then 2 when 'market' then 3 else 4 end,
                m.id
       limit 1
    ) r;
$$;

revoke all on function public.rescript_margin_resolve(uuid, text, uuid, text, timestamptz, integer) from public, anon, authenticated;

comment on table public.commercial_margins is 'Margin rates by scope (0087). Basis points OF THE SELLING PRICE: price = cost / (1 - bps/10000). An override must carry a note.';
comment on table public.margin_applications is 'Every price computed, with its cost, rate and rule (0087). Administrator reads only — cost_amount and profit_amount never reach a researcher.';
comment on column public.vendor_integrations.markup_bps is 'DEPRECATED (0087). A markup on cost, not a margin on the selling price. Researcher pricing uses commercial_margins; this column is retained only for agreements genuinely expressed as a markup.';
